import test from "node:test";
import assert from "node:assert/strict";
import { neutralInstallation, neutralSteeringLanes, neutralSteeringProgram, neutralSteeringResult } from "../machine/neutral-installation.mjs";
import { transportTiming } from "../machine/interconnect.mjs";
import { apparatus } from "../machine/apparatus.mjs";
import { examples } from "../machine/examples.mjs";
import { simulate } from "../server.mjs";
import { referenceDevice } from "../machine/reference-devices.mjs";
import { drawNeutralHardware, drawNeutralZones } from "../studio/neutral-hardware.js";

function installation() {
  const device = referenceDevice("Neutral atom");
  const inputs = device.drives.map((d) => d.probe);
  const parts = new Map(), links = [];
  const main = neutralInstallation({
    device, inputs, chip: "register", electronics: [{ id: "host", model: { fpga: {} } }],
    add(id, label, form, centerMm, sizeMm, basis) {
      assert.ok(!parts.has(id), id);
      parts.set(id, { id, label, form, centerMm, sizeMm, basis });
      return id;
    },
    route(from, to, kind, probes, fromOffsetMm, toOffsetMm, options) {
      links.push({ from, to, kind, probes, fromOffsetMm, toOffsetMm, ...options });
    },
  });
  return { device, parts, links, main };
}

test("Raman and Rydberg envelopes each form one ordered route to their bound atoms", () => {
  const {device, links, main} = installation();
  assert.equal(main, "chamber");
  const registerGuides = links.filter(l => l.from === "register" || l.to === "register");
  for (const link of registerGuides) {
    assert.equal(link.registerEnd, link.from === "register" ? "from" : "to");
    assert.ok(link.registerTipDiameterMm > 0 && link.registerTipDiameterMm < link.diameterMm);
  }
  for (const drive of device.drives) {
    const active = links.filter((l) => l.probes.includes(drive.probe));
    let prev = drive.probe;
    for (const l of active) {
      assert.equal(l.from, prev);
      assert.equal(l.carrier, false);
      prev = l.to;
    }
    assert.equal(prev, "register");
    const first = active[0], last = active.at(-1);
    const single = drive.targets.length === 1;
    assert.equal(first.to, single ? "local-rf" : "blue-rf");
    assert.equal(active[1].to,single ? "raman-aom" : "blue-aom");
    assert.equal(last.from, single ? "trap-objective" : "blue-profile");
    assert.equal(last.wavelengthNm, single ? 795 : 420);
    const sources = links.filter((l) => l.carrier && l.forProbes.includes(drive.probe));
    assert.ok(sources.some((l) => l.wavelengthNm === (single ? 795 : 1013)));
    assert.ok(!sources.some((l) => [850, 852].includes(l.wavelengthNm)));
    if (!single) {
      const infrared = sources.find((l) => l.to === "register" && l.wavelengthNm === 1013);
      const directionX = l => l.pointsMm[1][0] - l.pointsMm[0][0];
      assert.ok(directionX(infrared) * directionX(last) < 0);
      assert.deepEqual(infrared.pointsMm[1], last.pointsMm[1]);
    }
  }
});

test("both crossed-AOD assemblies have independent RF legs and trapping light stays on its own optical train", () => {
  const {links} = installation();
  const has = (a,b,signal) => links.some((l) => l.from === a && l.to === b && l.signal === signal);
  for (const [a,b] of [["host","command"],["command","raman-aod-awg"],["raman-x-amp","raman-x"],
    ["raman-y-amp","raman-y"],["moving-x-amp","moving-x"],["moving-y-amp","moving-y"],
    ["slm-control","trap-slm"],["camera","command"]]) assert.ok(has(a,b,"electrical"),a+" → "+b);
  for (const wavelength of [850,852]) {
    const light = links.filter((l) => l.wavelengthNm === wavelength);
    assert.equal(light.at(-1).to, "register");
    assert.ok(light.every((l) => l.carrier && l.probes.length === 0 && l.forProbes.length === 0));
    for (let i=1; i<light.length; i++) assert.equal(light[i].from,light[i-1].to);
    assert.ok(light.some((l) => l.from === (wavelength === 850 ? "moving-y" : "trap-slm")));
  }
});

const neutralMachine=examples.find(e => e.id === "Neutral atom").design;
function installed() { return apparatus(neutralMachine.device,neutralMachine.parts,neutralMachine.wires); }
const steer=(equipment,lane,frequencies)=>neutralSteeringProgram(neutralMachine.device,lane,frequencies,neutralMachine.parts,equipment);

test("all six RF DACs have declared data conductors, reference clocks and identifiable RF paths", () => {
  const eq=installed();
  for (const l of eq.links) {
    assert.ok(l.interconnect.fromPort.length && l.interconnect.toPort.length,l.kind);
    assert.ok(l.interconnect.conductors.length || l.interconnect.opticalMode,l.kind);
  }
  for (const lane of neutralSteeringLanes) {
    const path=eq.links.filter(l => l.lane===lane);
    const data=path.find(l => l.role==="pcm"), clock=path.find(l=>l.role==="clock"), rf=path.find(l=>l.role==="dac-rf");
    assert.equal(data.to,rf.from); assert.equal(clock.clockOwner,data.from); assert.equal(clock.clockSink,data.to);
    assert.equal(data.interconnect.beatNs,1.6); assert.equal(data.interconnect.transferWidthBits,16);
    assert.deepEqual(data.interconnect.conductors.filter(c=>c.role==="data").map(c=>c.bitIndex),Array.from({length:16},(_,i)=>i));
    assert.equal(clock.interconnect.kind,"differential"); assert.equal(clock.payloadBits,1);
    assert.equal(transportTiming(clock.interconnect,1,1).serializationPs,0);
    for (const l of [rf,...eq.links.filter(l=>l.axis===lane.at(-1) && ["switch-rf","transducer-rf"].includes(l.role))])
      assert.deepEqual(l.interconnect.conductors.map(c=>c.role),["signal","shield"]);
    assert.ok(path.every(l=>l.held),"The gate example holds the steering configuration");
    const p=steer(eq,lane,[80e6]);
    assert.ok(p.parts.find(x=>x.model.dac).id.endsWith("/"+lane+"-dac"));
    assert.ok(p.wires.every(w=>eq.links.some(l=>l.id===w.id)));
    assert.equal(p.wires.find(w=>w.id===data.id).servicePs,1600);
    assert.equal(p.wires.find(w=>w.id===clock.id).servicePs,undefined);
    assert.ok(p.wires.find(w=>w.id===eq.links.find(l=>l.role==="host-command").id).servicePs>0);
  }
});

test("RF at the selected transducer drives a delayed Lean trap coordinate; Raman only changes the address",async()=>{
  const eq=installed();
  for (const lane of ["moving-x","rearrange-y","raman-y"]) {
    const p=steer(eq,lane,[80e6,81e6]), trace=await simulate(JSON.stringify(p));
    const result=neutralSteeringResult(p,trace);
    for (const o of result.observations) {
      assert.ok(Math.abs(o.frequencyHz-o.commandedHz)<100);
      assert.ok(o.resolvedAtNs*1000<trace.frames[o.lastEvent].atPs);
      assert.equal(trace.frames[o.measurementEvent].part,result.receiver);
    }
    assert.deepEqual(result.observations.map(o=>o.positionNm),[0,10000]);
    if (lane.startsWith("raman")) { assert.equal(result.neutralProgram,null); continue; }
    const movement=await simulate(JSON.stringify(result.neutralProgram));
    const delivered=movement.frames.filter(f=>f.op==="deliver");
    assert.deepEqual(delivered.map(f=>f.atNs),result.observations.map(o=>o.resolvedAtNs));
    assert.deepEqual(delivered.map(f=>f.state.atoms[0][result.axis+"Nm"]),[0,10000]);
    assert.ok(result.rfOffAtPs>delivered.at(-1).atNs*1000);
  }
});

test("steering detects a rejected command, a missing clock edge and malformed frequencies",async()=>{
  const eq=installed(), p=steer(eq,"moving-y",[79500000]);
  assert.throws(()=>steer(eq,"moving-z",[80e6]),/lanes/);
  assert.throws(()=>steer(eq,"moving-y",[80000001]),/1 kHz/);
  const trace=await simulate(JSON.stringify(p));
  const clk=p.parts.find(x=>x.model.probe?.signal==="bit").id;
  const rising=trace.frames.find(f=>f.part===clk && f.received?.[1]===1);
  assert.throws(()=>neutralSteeringResult(p,{...trace,frames:trace.frames.filter(f=>f!==rising)}),/clock edge/);
  p.images[0].code[0].op.write.value++;
  const rejected=await simulate(JSON.stringify(p));
  assert.ok(rejected.frames.some(f=>f.source.endsWith("/reject-table")));
  assert.throws(()=>neutralSteeringResult(p,rejected),/complete RF capture/);
});

test("the crossed DAC data pins change the AOD sample the converter receives",async()=>{
  const eq=installed();
  const pcm=eq.links.find(l=>l.lane==="moving-x" && l.role==="pcm");
  const original=steer(eq,"moving-x",[80e6]).wires.find(w=>w.id===pcm.id);
  const [low,high]=["D0","D7"].map(id=>pcm.interconnect.conductors.find(c=>c.id===id));
  [low.toPin,high.toPin]=[high.toPin,low.toPin];
  [low.destinationBitIndex,high.destinationBitIndex]=[7,0];
  high.skewPs=80;
  const program=steer(eq,"moving-x",[80e6]), changed=program.wires.find(w=>w.id===pcm.id);
  assert.equal(changed.delayPs-original.delayPs,80);
  const replay=await simulate(JSON.stringify(program));
  const sample=replay.frames.find(f=>f.wire===pcm.id && f.transmittedValue>0 &&
    f.transmittedValue!==f.received[1]);
  assert.ok(sample);
  assert.equal(sample.received[1],sample.transmittedValue^129);
});

test("physical assets and native SLM region outlines have drawable geometry", () => {
  const {parts, device} = installation();
  const markers = [];
  const shape = (...args) => {
    markers.push(args);
    return {rotation: {set() {}}};
  };
  const shapes = {box:shape,disc:shape,line:shape,ring:shape};
  for (const part of parts.values()) {
    const previous = markers.length;
    assert.ok(drawNeutralHardware(shapes, part), part.form);
    assert.ok(markers.length > previous, part.label);
    assert.ok(part.sizeMm.every((x) => Number.isFinite(x) && x > 0));
  }
  assert.ok(!drawNeutralHardware(shapes,{form:"register",sizeMm:[1,1,1]}));
  const previous = markers.length;
  drawNeutralZones(shapes, device);
  assert.equal(markers.length - previous, 4 * device.layout.slms.length);
});
