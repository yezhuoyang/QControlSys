import test from "node:test";
import assert from "node:assert/strict";
import { defineInterconnect } from "../machine/interconnect.mjs";
import { lanePayload, wireSample } from "../studio/wire-inspector.js";

function link(kind, options, width = 16) {
  return { id: "line", from: "sender", to: "receiver", payloadBits: width,
    interconnect: defineInterconnect("line", kind, {fromPort: "tx", toPort: "rx", ...options}) };
}

test("wire inspector projects the signed word onto the correct lane in each parallel beat", () => {
  const l = link("parallel", {transferWidthBits: 8});
  const reservation = {issuedPs: 200, startPs: 250, releasePs: 500, priorEvent: 0};
  const f = {id: 4, atPs: 720, part: "receiver", wire: "line", received: ["rx", -256], transport: reservation};
  const result = wireSample(l, f);
  assert.equal(result.bits, "1111111100000000");
  assert.equal(result.transport, reservation);
  const [data, ground] = l.interconnect.conductors;
  assert.equal(lanePayload(data, l.interconnect, result), "0 → 1");
  assert.equal(lanePayload(ground, l.interconnect, result), null);
  assert.equal(lanePayload(l.interconnect.conductors.find(c=>c.role==="clock"), l.interconnect, result), null);
  assert.equal(wireSample(l, {...f, wire:"other"}), null);
  const permuted = wireSample(l, {...f,transmittedValue:-2,received:["rx",-3]});
  assert.equal(permuted.bits,"1111111111111110");
  assert.equal(permuted.receivedBits,"1111111111111101");
  assert.equal(lanePayload(data,l.interconnect,permuted),"0 → 1");
  const issue = wireSample(l, {...f, received:null, part:"sender", emitted:["tx",0]});
  assert.equal(issue.bits, "0000000000000000");
  assert.equal(issue.transport, null);
});

test("framed data preserves its word without assigning physical serial, return or carrier levels", () => {
  const f = {id: 9, atPs: 123, part:"sender", emitted:["tx",-1]};
  for (const kind of ["differential","fiber"]) {
    const l = link(kind,{encoding:"serial-nrz",frameOverheadBits:12,lineCodeDataBits:8,lineCodeWireBits:10});
    const sample = wireSample(l,f);
    assert.equal(sample.bits,"1".repeat(16));
    for (const c of l.interconnect.opticalMode?[l.interconnect.opticalMode]:l.interconnect.conductors)
      assert.equal(lanePayload(c,l.interconnect,sample),null);
  }
  const analog = link("coax",{},0);
  assert.equal(wireSample(analog,f).bits,null);
  assert.equal(wireSample(analog,{...f, emitted:["other-port",-1]}),null);
  assert.equal(wireSample(analog,null),null);
  const clock = link("differential",{encoding:"logic-level"},1);
  const high = wireSample(clock,{...f,emitted:["tx",1]});
  assert.deepEqual(clock.interconnect.conductors.map(c => lanePayload(c,clock.interconnect,high)),["1","0",null]);
});

test("a nested waveform board exposes the sampled FIFO word only for an actual conversion", () => {
  const l = {...link("parallel",{}),id:"@pcb/board/word",board:"board"};
  const f = {id:1,atPs:1000,part:"board",native:{op:"convert",state:{lastAddress:0,pcm:-1}}};
  assert.equal(wireSample(l,f).bits,"1".repeat(16));
  assert.equal(wireSample(l,{...f, native:{op:"underrun",state:{lastAddress:null,pcm:0}}}),null);
  assert.equal(wireSample(l,{...f,part:"other-board"}),null);
});
