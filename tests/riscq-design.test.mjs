// A machine as a document: parts with positions, channels of control cores and routed wires.
// The simulator derives the build, the pulse tables and every wire delay from the document.
import test from "node:test";
import assert from "node:assert/strict";
import { run, examples } from "../riscq/examples.mjs";
import * as design from "../riscq/design.mjs";

const bell = examples.find((e) => e.id === "superconducting-feedforward").source.text;
const windows = (bundle) => bundle.summary.pulses.map((p) => [p.part, p.kind, p.opens - bundle.summary.pulses[0].opens, p.dur, p.freq, p.amp, p.phase, p.env, p.onTime]);
const effects = (bundle) => bundle.frames.filter((f) => f.op === "effect");

test("the ring written as a hardware design plays the same pulses as the built-in ring", async () => {
  const builtIn = await run({ example: "superconducting-feedforward", outcomes: { c: 1 } });
  const designed = await run({ platform: "superconducting", qasm: bell, design: design.ringDesign(), outcomes: { c: 1 } });
  assert.deepEqual(designed.summary.faults, []);
  assert.deepEqual(designed.derived.bits, builtIn.derived.bits);
  assert.deepEqual(designed.hardware, { ...builtIn.hardware, machine: designed.hardware.machine });
  // Same windows on the same channels with the same codes, relative to the first one.
  assert.deepEqual(windows(designed), windows(builtIn));
  // The run carries the design and its layout: every wire with its routed length and delay.
  assert.equal(designed.machine.design.kind, "riscq-design");
  const wire = designed.machine.layout.wires.find((w) => w.id === "drive1");
  assert.equal(wire.delayPs, Math.ceil((wire.lengthMm / 200) * 1000));
  assert.deepEqual(designed.machine.provenance.warnings, undefined);
});

test("a wire's routed length sets when its signal arrives: moving the board 2 m away delays every drive by 10 ns", async () => {
  const near = await run({ platform: "superconducting", qasm: bell, design: design.ringDesign(), outcomes: { c: 1 } });
  const far = await run({ platform: "superconducting", qasm: bell, design: design.ringDesign({ chipMm: [2700, 0, -350] }), outcomes: { c: 1 } });
  // The controller plays the same schedule in both.
  assert.deepEqual(windows(far), windows(near));
  // Each signal reaches its qubit or resonator later by the extra 2,000 mm of coax at 200 mm/ns.
  const arrivals = (bundle) => effects(bundle).filter((f) => f.state.detail.kind !== "acquire").map((f) => [f.part, f.state.arrivesPs - f.atPs]);
  const nearArrivals = arrivals(near), farArrivals = arrivals(far);
  assert.ok(nearArrivals.length > 0 && nearArrivals.length === farArrivals.length);
  nearArrivals.forEach(([part, delay], k) => assert.deepEqual(farArrivals[k], [part, delay + 10000]));
  // Lines of different routed length arrive at different times in one design.
  assert.ok(new Set(nearArrivals.map(([, delay]) => delay)).size > 1);
});

test("one core may drive three qubits, but reads out only one: RISC-Q builds one demod channel per core", async () => {
  const d = design.ringDesign();
  // Move the drive and coupler channels of qubits 1 and 2 onto the core of qubit 0. Their readout tones
  // and demodulation stay on their own cores: a RISC-Q core has exactly one demod channel.
  for (const channel of d.channels)
    if (["q1", "q2"].includes(channel.core) && channel.kind === "pulse" && channel.name !== "ro")
      Object.assign(channel, { name: channel.core + "_" + channel.name, core: "q0" });
  assert.deepEqual(design.check(d).errors, []);
  const merged = await run({ platform: "superconducting", qasm: bell, design: d, outcomes: { c: 1 } });
  assert.equal(merged.summary.status, "quiescent");
  assert.deepEqual(merged.summary.faults, []);
  assert.deepEqual(merged.derived.bits, { c: 1 });
  assert.ok(merged.summary.pulses.every((p) => p.onTime && p.aligned !== false));
  // Moving their demodulation too would give q0 three demod channels: RISC-Q cannot build that core.
  const three = design.ringDesign();
  for (const channel of three.channels)
    if (["q1", "q2"].includes(channel.core)) Object.assign(channel, { name: channel.core + "_" + channel.name, core: "q0" });
  three.parts = three.parts.filter((part) => !["q1", "q2"].includes(part.id));
  assert.ok(design.check(three).errors.some((e) => /Core q0 has 3 demod channels/.test(e)));
});

test("a design that breaks a rule is rejected with the rule", () => {
  const broken = (edit) => {
    const d = design.ringDesign();
    edit(d);
    return design.check(d);
  };
  assert.deepEqual(design.check(design.ringDesign()), { errors: [], warnings: [] });
  assert.match(broken((d) => d.wires[0].routeMm[0][0] += 5).errors[0], /must start at dac\d+ and end at qubit0/);
  assert.match(broken((d) => (d.wires[0].medium = "string")).errors[0], /unknown medium string/);
  assert.match(broken((d) => d.wires.splice(0, 1)).errors[0], /no wire leads from dac\d+ to qubit0/);
  assert.match(broken((d) => (d.channels[0].converter = "adc0")).errors[0], /needs a dac as its converter/);
  assert.match(broken((d) => d.parts.push({ id: "x", type: "laser", centerMm: [0, 0, 0] })).errors[0], /unknown type laser/);
  assert.match(broken((d) => {
    for (let k = 0; k < 14; k++) d.channels.push({ id: "q0.extra" + k, core: "q0", name: "extra" + k, kind: "dio" });
  }).errors[0], /Core q0 has 19 channels/);
  assert.throws(() => design.machine({ kind: "riscq-design", version: 1, parts: [] }), /breaks \d+ rules?/);
  // A return line so long that the tone comes back after the acquisition window opens is a warning.
  const late = broken((d) => {
    const wire = d.wires.find((w) => w.id === "return0");
    const [a, b] = [wire.routeMm[0], wire.routeMm[1]];
    // Insert a detour of 2 × 40 m.
    wire.routeMm.splice(1, 0, [a[0], a[1] + 40000, a[2]], [a[0], a[1], a[2]]);
    void b;
  });
  assert.deepEqual(late.errors, []);
  assert.match(late.warnings[0], /Qubit 0: the acquisition window opens .* hold no signal/);
});

test("two carrier frequencies on one channel are a rule the check reports, not a crash", () => {
  const d = design.ringDesign();
  // Play qubit 1's drive on qubit 0's drive channel: the two qubits have different frequencies.
  d.qubits[1].gate = d.qubits[0].gate;
  const verdict = design.check(d);
  assert.match(verdict.errors.join(" "), /Channel q0\.gate is given two carrier frequencies: \d+ Hz for qubit 0 drive and \d+ Hz for qubit 1 drive/);
  assert.throws(() => design.machine(d), /breaks \d+ rules?/);
});
