// OpenQASM → native hardware instructions → RISC-Q firmware → Lean execution on the
// eight-transmon ring of the RISC-Q example calibration.
import test from "node:test";
import assert from "node:assert/strict";
import { execute } from "../riscq/soc.mjs";
import { assemble } from "../riscq/compile.mjs";
import * as sc from "../riscq/platforms/superconducting.mjs";

const m = sc.machine();
const head = "OPENQASM 3.0;\ninclude \"stdgates.inc\";\n";
const program = head + "qubit[3] q;\nbit c;\nh q[0];\ncx q[0], q[1];\nc = measure q[0];\nif (c) x q[2];\n";

async function run(qasm, outcomes = {}, options = {}) {
  const hardware = sc.schedule(qasm, m);
  const lowered = sc.lower(hardware, m);
  const built = assemble(m.spec, lowered,
    { bindings: m.bindings, readouts: sc.readoutOracle(lowered, m, outcomes), ...options });
  return { hardware, lowered, built, result: await execute(built.document) };
}

// 2×2 complex matrices as rows of [re, im], for checking decompositions.
const mul = (a, b) => [0, 1].map((i) => [0, 1].map((j) => [0, 1].reduce(([re, im], k) =>
  [re + a[i][k][0] * b[k][j][0] - a[i][k][1] * b[k][j][1], im + a[i][k][0] * b[k][j][1] + a[i][k][1] * b[k][j][0]], [0, 0])));
const rz = (t) => [[[Math.cos(t / 2), -Math.sin(t / 2)], [0, 0]], [[0, 0], [Math.cos(t / 2), Math.sin(t / 2)]]];
const sx = [[[0.5, 0.5], [0.5, -0.5]], [[0.5, -0.5], [0.5, 0.5]]];
const x = [[[0, 0], [1, 0]], [[1, 0], [0, 0]]];
const rx = (t) => [[[Math.cos(t / 2), 0], [0, -Math.sin(t / 2)]], [[0, -Math.sin(t / 2)], [Math.cos(t / 2), 0]]];
const ry = (t) => [[[Math.cos(t / 2), 0], [-Math.sin(t / 2), 0]], [[Math.sin(t / 2), 0], [Math.cos(t / 2), 0]]];
const h = [[[Math.SQRT1_2, 0], [Math.SQRT1_2, 0]], [[Math.SQRT1_2, 0], [-Math.SQRT1_2, 0]]];
const y = [[[0, 0], [0, -1]], [[0, 1], [0, 0]]];
/** Product of a native sequence in circuit order. */
function unitary(native) {
  let u = [[[1, 0], [0, 0]], [[0, 0], [1, 0]]];
  for (const op of native) u = mul(op.op === "frame" ? rz(op.angle) : op.op === "x" ? x : sx, u);
  return u;
}
/** Equal up to a global phase. */
function samePhase(a, b) {
  const flatA = a.flat(), flatB = b.flat();
  const k = flatB.findIndex(([re, im]) => Math.hypot(re, im) > 0.3);
  const [br, bi] = flatB[k], [ar, ai] = flatA[k];
  const norm = br * br + bi * bi;
  const phase = [(ar * br + ai * bi) / norm, (ai * br - ar * bi) / norm];
  return flatA.every(([re, im], i) =>
    Math.abs(re - (flatB[i][0] * phase[0] - flatB[i][1] * phase[1])) < 1e-9 &&
    Math.abs(im - (flatB[i][0] * phase[1] + flatB[i][1] * phase[0])) < 1e-9);
}

test("standard one-qubit gates decompose to x90, x and frame updates up to a global phase", () => {
  const fail = (message) => assert.fail(message);
  const native = (name, params = []) => sc.decompose({ name, targets: [0], params }, fail);
  assert.ok(samePhase(unitary(native("h")), h));
  assert.ok(samePhase(unitary(native("y")), y));
  assert.ok(samePhase(unitary(native("sx")), sx));
  for (const angle of [0.3, -1.1, Math.PI / 2, 2.9]) {
    assert.ok(samePhase(unitary(native("rx", [angle])), rx(angle)), "rx " + angle);
    assert.ok(samePhase(unitary(native("ry", [angle])), ry(angle)), "ry " + angle);
    assert.ok(samePhase(unitary(native("rz", [angle])), rz(angle)), "rz " + angle);
    assert.ok(samePhase(unitary(native("U", [angle, 0.4, -0.7])), mul(rz(0.4), mul(ry(angle), rz(-0.7)))), "U " + angle);
  }
});

test("a Bell circuit with feed-forward runs on time on three cores", async () => {
  const { hardware, result } = await run(program, { c: 1 });
  assert.equal(result.summary.status, "quiescent");
  assert.deepEqual(result.summary.faults, []);
  // Calibrated durations: 36 ns x90 on the 2 ns grid, 400 ns CZ.
  const ops = hardware.segments[0].ops;
  const cz = ops.find((op) => op.op === "cz");
  assert.deepEqual([cz.t, cz.dur], [36000, 400000]);
  assert.equal(ops.find((op) => op.op === "measure").t, 436000);
  assert.equal(hardware.segments.length, 2);
  const pulses = result.summary.pulses;
  assert.ok(pulses.every((p) => p.aligned && p.onTime && !p.overlap));
  // Both CZ tones open on the same batch, on the DACs of the two qubits, for 200 batches.
  const tones = pulses.filter((p) => p.source === cz.id);
  assert.deepEqual(tones.map((p) => p.converter).sort(), ["dac0", "dac1"]);
  assert.equal(tones[0].opens, tones[1].opens);
  assert.ok(tones.every((p) => p.dur === 200));
  // Hardware times map to batches from one barrier time base on every core.
  const first = pulses.find((p) => p.part === "q0.gate");
  assert.equal(tones[0].opens, first.opens + cz.t / 2000);
  // The demodulation window follows the readout tone by the calibrated delay.
  const tone = pulses.find((p) => p.part === "q0.ro"), window = pulses.find((p) => p.part === "q0.demod");
  assert.equal(window.opens - tone.opens, Math.ceil(398.57 / 2));
  assert.equal(window.converter, "adc12");
  // The conditioned X runs on core q2 after the bit crossed the hub.
  const conditioned = pulses.find((p) => p.part === "q2.gate");
  assert.equal(conditioned.slot, 1);
  const settled = result.frames.find((f) => f.op === "result");
  assert.ok(conditioned.opens > settled.atBatch);
  const publish = result.frames.find((f) => f.op === "publish");
  assert.deepEqual([publish.state.from, publish.state.bit], ["q0", 1]);
  // Each drive reaches its qubit after 1050 mm of coax at 0.7 c.
  const effect = result.frames.find((f) => f.op === "effect" && f.part === "qubit2");
  assert.equal(effect.state.arrivesPs - effect.atBatch * 2000, 5003);
  assert.deepEqual(effect.state.detail, { kind: "drive", gate: "x", qubit: 2 });
  // Every pulse names the hardware instruction that caused it, which names its OpenQASM line.
  const byId = new Map(hardware.segments.flatMap((s) => s.ops).map((op) => [op.id, op]));
  assert.ok(pulses.every((p) => byId.has(p.source)));
  assert.equal(byId.get(conditioned.source).source, "OpenQASM line 8");
  // Unused qubits park without joining a barrier.
  assert.deepEqual(result.summary.cores.slice(3).map((c) => c.stopped), Array(5).fill("done"));
  assert.equal(result.frames.find((f) => f.op === "release").state.expected, 3);
});

test("a zero measurement result leaves the conditioned gate unplayed", async () => {
  const { result } = await run(program, { c: 0 });
  assert.deepEqual(result.summary.faults, []);
  assert.equal(result.summary.pulses.filter((p) => p.part === "q2.gate").length, 0);
  assert.ok(result.summary.cores.every((c) => c.done));
});

test("a gate between uncoupled qubits and an unknown operand are rejected with their source line", () => {
  const wide = head + "qubit[8] q;\n";
  assert.throws(() => sc.schedule(wide + "cz q[0], q[3];\n", m), /OpenQASM line 4 — no calibrated CZ between qubits 0 and 3/);
  // The calibration needs a second-level pulse for this pair, which the machine does not offer.
  assert.throws(() => sc.schedule(wide + "cz q[5], q[6];\n", m), /no calibrated CZ between qubits 5 and 6/);
  assert.throws(() => sc.schedule(head + "qubit[9] q;\nx q[8];\n", m), /has no physical qubit/);
});

test("virtual Z gates cost no pulse and rotate the phase of later drives", async () => {
  const plain = await run(head + "qubit q;\nsx q;\nsx q;\n");
  const rotated = await run(head + "qubit q;\nsx q;\nrz(pi/2) q;\nsx q;\n");
  assert.equal(plain.result.summary.pulses.length, 2);
  assert.equal(rotated.result.summary.pulses.length, 2);
  const phases = (r) => r.result.summary.pulses.map((p) => p.phase);
  assert.equal(phases(plain)[0], phases(rotated)[0]);
  // A quarter turn is 2^14 of the 2^16 phase codes, subtracted from later drives.
  assert.equal((phases(plain)[1] - phases(rotated)[1] + 65536) % 65536, 16384);
  // Back-to-back pulses are contiguous: the second opens when the first closes.
  const [a, b] = plain.result.summary.pulses;
  assert.equal(b.opens, a.closes);
});
