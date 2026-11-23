import test from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import { defineInterconnect, validateInterconnect, transportTiming, serialSymbols,
  conductorPinout, payloadPermutation, payloadSkewPs } from "../machine/interconnect.mjs";
import { createWireSection } from "../studio/wire-section.js";

test("reference cross-sections round-trip through JSON with explicit terminals, return paths and optical modes", () => {
  for (const kind of ["logic", "parallel", "differential", "coax", "dc", "fiber", "beam", "planar", "contact"]) {
    const link = defineInterconnect("link/" + kind, kind, { fromPort: "driver.tx", toPort: "receiver.rx" });
    assert.deepEqual(validateInterconnect(JSON.parse(JSON.stringify(link))), link);
    assert.equal(link.fromPort, "driver.tx");
    assert.equal(link.toPort, "receiver.rx");
    if (kind === "fiber" || kind === "beam") {
      assert.deepEqual(link.conductors, []);
      assert.equal(link.opticalMode.role, kind === "fiber" ? "guided" : "free-space");
    } else {
      assert.equal(link.opticalMode, null);
      assert.ok(link.conductors.some(c => c.role === "return" || c.role === "shield"));
    }
  }
  const coax = defineInterconnect("rf", "coax");
  assert.deepEqual(coax.conductors.map(c => [c.role, c.offsetMm]), [["signal", 0], ["shield", 0]]);
  assert.ok(coax.conductors[1].innerDiameterMm > coax.conductors[0].diameterMm);
  const pair = defineInterconnect("d", "differential");
  assert.deepEqual(pair.conductors.map(c => c.role), ["positive", "negative", "return"]);
});

test("planar gaps are explicit, and a shared return references one external net without allocating extra pins", () => {
  const planar = defineInterconnect("die", "planar");
  const [left, trace, right] = planar.conductors;
  assert.equal(trace.widthMm, 0.01);
  for (const ground of [left, right]) {
    assert.ok(Math.abs(Math.abs(ground.offsetMm) - (ground.widthMm + trace.widthMm) / 2 - 0.006) < 1e-12);
  }
  for (const kind of ["dc", "contact"]) {
    const link = defineInterconnect("pin-7", kind, { sharedReturn: "ground-plane" });
    assert.equal(link.sharedReturn, "ground-plane");
    assert.deepEqual(link.conductors.map(c => c.role), ["signal"]);
    assert.throws(() => validateInterconnect({ ...link, sharedReturn: null }), /conductor roles/);
  }
});

test("a parallel transfer waits for the last physical data beat and cable flight", () => {
  const bus = defineInterconnect("adc", "parallel", { transferWidthBits: 8, beatNs: 3.5, speedMmPerNs: 200 });
  assert.deepEqual(bus.conductors.filter(c => c.role === "data").map(c => c.bitIndex), [0,1,2,3,4,5,6,7]);
  assert.equal(bus.conductors.filter(c => c.role === "clock").length, 1);
  assert.deepEqual(transportTiming(bus, 120, 19),
    { flightPs: 600, serializationPs: 10500, totalPs: 11100, beats: 3, wireBits: 24, payloadBits: 19 });
});

test("connector pins preserve bus permutations across full beats and zero-pad a partial last beat", () => {
  const bus = defineInterconnect("swap", "parallel", {transferWidthBits: 8, fromPort: "J1", toPort: "J2"});
  const lanes = bus.conductors.map(c => {
    const lane = {...c};
    delete lane.toPin;
    if (lane.bitIndex === 0) lane.destinationBitIndex = 7;
    if (lane.bitIndex === 7) lane.destinationBitIndex = 0;
    return lane;
  });
  const crossed = defineInterconnect("swap", "parallel", { transferWidthBits: 8,
    fromPort: "J1", toPort: "J2", conductors: lanes });
  const d0 = crossed.conductors.find(c => c.id === "D0");
  assert.deepEqual([d0.fromPin, d0.toPin, d0.destinationBitIndex], ["J1.D0", "J2.D7", 7]);
  assert.deepEqual(payloadPermutation(crossed, 16), [7,1,2,3,4,5,6,0,15,9,10,11,12,13,14,8]);
  assert.deepEqual(payloadPermutation(crossed, 10), [7,1,2,3,4,5,6,0,10,9]);
  assert.equal(payloadPermutation(bus, 10), null);
  assert.equal(payloadPermutation(defineInterconnect("d","dc"), 0), null);
  const flipLow = defineInterconnect("low", "parallel", { transferWidthBits: 2 });
  for (const c of flipLow.conductors.filter(c => c.role === "data")) {
    c.destinationBitIndex = 1 - c.bitIndex;
    c.toPin = ["U1.A6","U1.B8"][c.destinationBitIndex];
  }
  const incoming = 1, sources = payloadPermutation(flipLow, 2);
  const received = sources.reduce((word, source, dest) => word | ((incoming >> source) & 1) << dest, 0);
  assert.equal(received, 2);
});

test("skew uses the latest data or sample-clock pin, and legacy descriptors retain direct routing", () => {
  const bus = defineInterconnect("slow-clock", "parallel", {transferWidthBits: 4});
  const by = role => bus.conductors.find(c => c.role === role);
  by("data").skewPs = 30;
  by("clock").skewPs = 41;
  by("return").skewPs = 500;
  assert.equal(payloadSkewPs(bus), 41);
  bus.conductors.find(c=>c.id==="D3").skewPs=4050;
  assert.equal(payloadSkewPs(bus,1),41);
  assert.equal(payloadSkewPs(bus,5),50);
  assert.equal(payloadSkewPs(bus,0),0);
  for (const c of bus.conductors) {
    delete c.fromPin; delete c.toPin; delete c.skewPs; delete c.destinationBitIndex;
  }
  assert.equal(payloadSkewPs(bus), 0);
  assert.equal(payloadPermutation(bus, 8), null);
  assert.deepEqual(conductorPinout(bus).slice(0,2).map(c=>[c.fromPin,c.toPin]),
    [["out.D0","in.D0"],["out.G0","in.G0"]]);
  const dc = defineInterconnect("pin42", "dc", { sharedReturn:"package ground", fromPort:"J24", toPort:"A3" });
  assert.deepEqual(conductorPinout(dc).map(c => [c.id,c.fromPin,c.toPin]), [["signal","J24.signal","A3.signal"]]);
  assert.equal(payloadSkewPs(dc), 0);
  const invalid = edit => {
    const clone = structuredClone(bus);
    edit(clone.conductors);
    assert.throws(() => validateInterconnect(clone), /Invalid interconnect/);
  };
  invalid(c => { c[0].fromPin = c[1].fromPin = "J1.12"; });
  invalid(c => { c[0].toPin = c[1].toPin = "J2.27"; });
  invalid(c => { c[0].destinationBitIndex = 1; });
  invalid(c => { c[1].destinationBitIndex = 0; });
  invalid(c => { c[0].skewPs = -1; });
  invalid(c => { c[0].skewPs = 0.25; });
});

test("crossed cable conductors reach their assigned receiver contacts on separate levels; an IC remap preserves straight lanes", () => {
  const base = defineInterconnect("J1-J2", "parallel", { transferWidthBits: 8 });
  const settings = base.conductors.map(c => {
    const lane = {...c};
    delete lane.toPin;
    if (lane.bitIndex === 0 || lane.bitIndex === 7) lane.destinationBitIndex = 7 - lane.bitIndex;
    return lane;
  });
  function section(pinRouting) {
    const spec = defineInterconnect("J1-J2", "parallel", { transferWidthBits:8, conductors:settings, pinRouting });
    const link = {id:spec.id, kind:spec.kind, interconnect:spec, pointsMm:[[0,0,0],[10,0,0],[30,0,0]]};
    const root = new T.Group(), view = createWireSection(root);
    view.open(link, "D0");
    const group = root.children[0];
    const centerline = id => {
      const attr = group.children.find(m => m.userData.conductor === id).geometry.getAttribute("position");
      const centers = [];
      for (let k = 0; k < attr.count; k += 24) {
        const center = new T.Vector3();
        for (let j = k; j < k+24; j++)
          center.add(new T.Vector3().fromBufferAttribute(attr,j));
        centers.push(center.divideScalar(24).add(group.position));
      }
      return centers;
    };
    const result = { spec, d0:centerline("D0"), d7:centerline("D7") };
    view.dispose();
    return result;
  }
  const physical = section("connector"), internal = section("inside-receiver");
  assert.equal(physical.spec.conductors[0].toPin,"in.D7");
  assert.equal(internal.spec.conductors[0].toPin,"in.D0");
  assert.deepEqual(payloadPermutation(physical.spec,8), payloadPermutation(internal.spec,8));
  assert.ok(Math.abs(physical.d0.at(-1).z - internal.d7.at(-1).z) < 1e-6);
  assert.ok(Math.abs(physical.d7.at(-1).z - internal.d0.at(-1).z) < 1e-6);
  const peak = line => Math.max(...line.map(p=>p.y));
  assert.ok(Math.abs(peak(physical.d0)-peak(physical.d7)) > settings[0].diameterMm);
  assert.ok(Math.max(peak(internal.d0),peak(internal.d7)) < 1e-6);
});

test("the serial line and guided optical mode use the same explicit framing and block padding", () => {
  for (const kind of ["differential", "fiber", "beam"]) {
    const link = defineInterconnect("serialize", kind, {
      encoding: "serial-nrz", frameOverheadBits: 3, lineCodeDataBits: 8, lineCodeWireBits: 10,
      bitRateGbps: 2.5, speedMmPerNs: 200, lengthMm: 100,
    });
    // 15 payload + 3 framing bits fill three padded 8→10 blocks. 30 bits at 2.5 Gbit/s take 12 ns.
    assert.deepEqual(transportTiming(link, 85, 15),
      { flightPs: 500, serializationPs: 12000, totalPs: 12500, beats: 30, wireBits: 30, payloadBits: 15 });
    assert.equal(transportTiming(link, undefined, 0).serializationPs, 0);
  }
});

test("reference differential frames expose signed data, start and stop symbols, and nominal pin polarities", () => {
  const link = defineInterconnect("host", "differential", { bitRateGbps: 2.5, frameOverheadBits: 2 });
  const symbols = serialSymbols(link, -2, 4);
  assert.deepEqual(symbols, {
    bits: "001111", positive: "001111", negative: "110000", bitOrder: "lsb-first",
    prefixBits: "0", suffixBits: "1", paddingBits: 0, symbolPeriodPs: 400,
  });
  assert.equal(symbols.bits.length * symbols.symbolPeriodPs, transportTiming(link, 10, 4).serializationPs);
  assert.equal(serialSymbols(link, -2, 0).bits, "");
  const recovered = JSON.parse(JSON.stringify(link));
  delete recovered.serialFormat;
  assert.deepEqual(serialSymbols(recovered, -2, 4), symbols);
});

test("optical NRZ supports explicit bit order, headers and block padding; unmodeled codebooks expose timing only", () => {
  const fiber = defineInterconnect("fiber", "fiber", { encoding:"serial-nrz", frameOverheadBits: 3,
    lineCodeDataBits: 4, lineCodeWireBits: 4,
    serialFormat: {bitOrder:"msb-first", prefixBits:"10", suffixBits:"0", paddingBit:1} });
  const frame = serialSymbols(fiber, 3n, 4);
  assert.equal(frame.bits, "10001101"); // prefix 10, unsigned 0011, stop 0, pad 1
  assert.deepEqual([frame.positive, frame.negative, frame.paddingBits], [null, null, 1]);
  const rateOnly = defineInterconnect("ratio", "differential", { lineCodeDataBits: 8, lineCodeWireBits: 10 });
  assert.equal(serialSymbols(rateOnly, 17, 8), null);
  assert.equal(transportTiming(rateOnly, 1, 8).wireBits, 10);
  const clock = defineInterconnect("clock", "differential", {encoding:"logic-level"});
  assert.equal(serialSymbols(clock, 1, 1), null);
  assert.throws(() => defineInterconnect("bad", "differential", { frameOverheadBits: 2,
    serialFormat: { prefixBits: "?", suffixBits: "1" } }), /prefix/);
  assert.throws(() => defineInterconnect("bad", "differential", { lineCodeDataBits: 8, lineCodeWireBits: 10,
    serialFormat: { blockEncoding:"identity" } }), /equal input\/output/);
});

test("control transitions and sampled envelopes use propagation only", () => {
  for (const kind of ["dc", "coax", "fiber", "beam", "planar", "contact"]) {
    const link = defineInterconnect("signal", kind, { speedMmPerNs: 200 });
    assert.deepEqual(transportTiming(link, 10.1, 0),
      { flightPs: 51, serializationPs: 0, totalPs: 51, beats: 0, wireBits: 0, payloadBits: 0 });
    assert.throws(() => transportTiming(link, 10, 16), /no framed payload/);
  }
  const logic = defineInterconnect("flag", "logic");
  assert.equal(transportTiming(logic, 0, 1).totalPs, 0);
  assert.throws(() => transportTiming(logic, 1, 2), /at most one bit/);
  const clock = defineInterconnect("sample-clock", "differential", { encoding: "logic-level", speedMmPerNs: 200 });
  assert.deepEqual(transportTiming(clock, 200, 1),
    { flightPs: 1000, serializationPs: 0, totalPs: 1000, beats: 0, wireBits: 1, payloadBits: 1 });
});

test("incoherent cross-sections, rates, ports and unsafe timing counts fail before execution", () => {
  const bad = (kind, patch) => assert.throws(() => defineInterconnect("test", kind, patch), /Invalid interconnect/);
  bad("parallel", { transferWidthBits: 256 });
  bad("parallel", { beatNs: "4" });
  bad("logic", { speedMmPerNs: 300 });
  bad("coax", { sharedReturn: "board" });
  bad("logic", { toPort: 3 });
  bad("fiber", { conductors: [{id: "wire"}] });
  bad("fiber", { opticalMode: { claddingDiameterMm: 0.002 } });
  bad("beam", { opticalMode: { jacketDiameterMm: 1 } });
  bad("coax", { encoding: "serial-nrz" });
  bad("differential", { lineCodeDataBits: 10, lineCodeWireBits: 8 });
  const bus = defineInterconnect("bus", "parallel", { transferWidthBits: 2 });
  const modify = (kind, fn) => {
    const link = defineInterconnect("geometry", kind);
    fn(link);
    assert.throws(() => validateInterconnect(link), /Invalid interconnect/);
  };
  modify("coax", l => { l.conductors[1].offsetMm = 0.1; });
  modify("coax", l => { l.conductors[1].innerDiameterMm = 0.01; });
  modify("logic", l => { l.conductors[1].id = l.conductors[0].id; });
  modify("differential", l => { l.conductors[0].offsetMm = l.conductors[1].offsetMm; });
  modify("parallel", l => { l.conductors.filter(c => c.role === "data")[1].bitIndex = 0; });
  modify("parallel", l => { l.transferWidthBits = 4; });
  assert.throws(() => transportTiming(bus, -1, 2), /invalid routed length/);
  assert.throws(() => transportTiming(bus, undefined, 2), /supply an installed or routed length/);
  assert.throws(() => transportTiming(bus, 100, -1), /nonnegative integer/);
  assert.throws(() => transportTiming(bus, Number.MAX_VALUE, 1), /exact arithmetic/);
});
