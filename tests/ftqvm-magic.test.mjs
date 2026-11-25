// The two magic-state reproductions (riscq/ftqvm/magic.mjs): the papers' circuits as transcribed,
// their twins, their runs on RISC-Q, the factory as a FormalRV system call, and the noise.
// FormalRV parts are skipped without a built FormalRV checkout; noise parts without Python's stim.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as mc from "../riscq/ftqvm/magic-circuits.mjs";
import * as mg from "../riscq/ftqvm/magic.mjs";
import * as formalrv from "../riscq/ftqvm/formalrv.mjs";

const hasStim = (() => {
  try { execFileSync(process.env.QCONTROL_PYTHON || "python", ["-I", "-c", "import stim"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const noStim = !hasStim && "Python's stim is not installed";
const noFormalrv = !formalrv.available() && "no built FormalRV checkout";

let seed = 11;
const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test("Google's published circuits have the counts the paper states", () => {
  const kt = mc.counts(mc.googleCircuit("fig3-kickback"));
  // Sec. II: "the 216 physical two-qubit gates in the circuit, as well as its 54 measurements".
  assert.equal(kt.twoQubit, 216);
  assert.equal(kt.measurements, 54);
  assert.equal(kt.qubits, 14);
  // Sec. III: the distance-5 grafting experiment on 54 qubits.
  assert.equal(mc.counts(mc.googleCircuit("fig4-graft-N2")).qubits, 54);
  // Cultivation applies T and T† to the seven data qubits of each check.
  assert.equal(kt.tagged["I[T_gate]"], 21);
  assert.equal(kt.tagged["I[T_dagger_gate]"], 21);
});

test("every CZ of Google's circuits is on a coupler of the square grid", () => {
  for (const name of ["fig2-cultivation", "fig3-kickback", "fig4-graft-N2"]) {
    const c = mc.googleCircuit(name);
    assert.deepEqual(mg.uncoupled(c, mg.willowTwin(c)), [], name);
  }
});

test("the kickback circuit, run with its real T gates, keeps |T⟩ and rejects the orthogonal state", () => {
  const c = mc.googleCircuit("fig3-kickback");
  for (let k = 0; k < 5; k++) {
    const t = mc.runTransmonCircuit(c, { theta: Math.PI / 4, rng });
    assert.ok(t.detectors.every((x) => x === 0), "a detector fired for |T⟩");
    assert.equal(t.observables[0], 0);
    const o = mc.runTransmonCircuit(c, { theta: (5 * Math.PI) / 4, rng });
    assert.ok(o.detectors.some((x) => x === 1), "the orthogonal state passed every check");
  }
});

test("QuEra's encoders produce the stated color codes", () => {
  const d3 = mc.checkEncoder(3), d5 = mc.checkEncoder(5);
  assert.deepEqual([d3.n, d3.selfDual, d3.k, d3.distance], [7, true, 1, 3]);
  assert.deepEqual([d5.n, d5.selfDual, d5.k, d5.distance], [17, true, 1, 5]);
  // Methods: "9-gate, 3-layer" for d = 3 and "five layers and 24 CNOT/CZ gates" for d = 5.
  assert.equal(mc.QUERA_CODES[3].rops.length, 9);
  assert.equal(mc.QUERA_CODES[5].rops.length, 24);
  const cz = (d) => mc.queraFactory(d, { stage: "injection" }).moments.filter((m) => m.ops.some((o) => o.gate === "CZ")).length;
  assert.equal(cz(3), 3);
  assert.equal(cz(5), 5);
});

test("Fig. 3a accepts 1/6 of perfect inputs and returns the magic state; worse inputs are improved quadratically", () => {
  const out = mc.distill();
  assert.ok(Math.abs(out["1011"].p - 1 / 6) < 1e-9);
  assert.ok(Math.abs(mc.fidelity(out["1011"].bloch, mc.MAGIC) - 1) < 1e-9);
  // Depolarized inputs of infidelity ε: the output infidelity is O(ε²).
  for (const eps of [0.01, 0.02]) {
    const r = 1 - 2 * eps; // Bloch length for fidelity 1 - ε along the magic axis
    const o = mc.distill(Array(5).fill(mc.MAGIC.map((x) => x * r)))["1011"];
    const outEps = 1 - mc.fidelity(o.bloch, mc.MAGIC);
    assert.ok(outEps < 2 * eps * eps * 10 && outEps < eps / 4, `ε = ${eps}: output infidelity ${outEps}`);
  }
});

test("the twins time the circuits from their sources", () => {
  const atoms = mg.atomSchedule(mc.queraFactory(3));
  const layers = atoms.moments.filter((m) => m.kind === "CZ layer");
  assert.equal(layers.length, 6); // three encoding layers, three distillation rounds
  assert.ok(layers.every((m) => m.czNs === 270 && m.echoNs === 770));
  assert.equal(atoms.moments.at(-1).dur, 500_000);
});

test("Google's kickback circuit runs on the Willow twin with every operation in its window", { timeout: 300_000 }, async () => {
  const c = mc.googleCircuit("fig3-kickback");
  const run = await mg.runWillow(c, { outcomes: mc.runTransmonCircuit(c, { rng }).record });
  assert.equal(run.report.conforms, true, JSON.stringify(run.report.byKind));
  assert.equal(run.readBack, true);
  assert.equal(run.schedule.durations.pulseNs, 36); // 35 ns on the 2 ns grid
  assert.equal(run.report.byKind["T pulse"].count, 42);
  // Two transmons per core cannot keep up with back-to-back 36 ns layers on the busiest qubits: the
  // firmware generator refuses the schedule (a channel would need more writes ahead than its queue).
  await assert.rejects(mg.runWillow(c, { qubitsPerCore: 2 }), /cannot take this write on time/);
});

test("QuEra's d = 3 factory runs on the Gemini twin with every operation in its window", { skip: noStim, timeout: 300_000 }, async () => {
  const f = mc.queraFactory(3);
  const bits = (await mg.stim({ mode: "sample", stim: mc.stimText(f, { drives: true }), seed: 5 })).bits;
  const run = await mg.runGemini(f, { outcomes: bits });
  assert.equal(run.report.conforms, true, JSON.stringify(run.report.byKind));
  assert.equal(run.readBack, true);
  assert.equal(run.report.byKind.measure.count, 35);
});

test("the factory serves FormalRV's request_magic: the VM admits a T gate on a Steane block", { skip: noFormalrv || noStim, timeout: 900_000 }, async () => {
  const r = await mg.queraDistillation({ shots: 4000, distances: [3], dir: join(tmpdir(), "quantumos-test-magic-" + process.pid) });
  assert.equal(r.call.verdict, "RESOURCE_VALIDATED");
  const [w] = r.call.requestMagic;
  assert.equal(w.output, 7);
  assert.equal(w.workspace, 28); // 35 atoms: the paper's d = 3 factory
  assert.equal(w.end - w.start, r.factory.latencyNs);
  // The learned noise puts the twin near the paper: injected ≈ 95%, distilled above it.
  const [row] = r.rows;
  assert.ok(row.injected.corrected > 0.9 && row.injected.corrected < 0.99, String(row.injected.corrected));
  assert.ok(row.distilled.fidelity > row.injected.corrected, JSON.stringify(row.distilled));
  assert.ok(row.distilled.acceptance.value < 1 / 6);
});

test("the design pages rerun the twins with edited parameters", { skip: noStim, timeout: 300_000 }, async () => {
  for (const [id, design] of Object.entries(mg.MAGIC_DESIGNS)) {
    const params = Object.fromEntries(design.params().map((p) => [p.key, p.value]));
    assert.ok(design.params().every((p) => p.label && p.group && (p.options || p.source)), id);
    const base = (await design.run(params)).rows[0];
    assert.equal(base.conforms, true, id);
    assert.ok(base.track.controller.cores.length > 0 && base.steps.length > 0, id);
    // A slower two-qubit gate makes the same circuit longer on the twin.
    const slower = (await design.run({ ...params, czNs: 2 * params.czNs })).rows[0];
    assert.ok(slower.circuitNs > base.circuitNs, id + ": " + slower.circuitNs + " vs " + base.circuitNs);
  }
  // A Willow run hands back its chip as a hardware design the editor opens.
  const { design } = await mg.MAGIC_DESIGNS["google-cultivation-2025"].run({ circuit: "fig2-cultivation" });
  assert.equal(design.kind, "riscq-design");
  assert.equal(design.qubits.length, 12);
});

test("the debugger's logical steps follow Fig. 3a from the magic inputs", () => {
  const steps = mc.distillationSteps();
  assert.equal(steps.length, 7);
  // Before the circuit every input is the magic state, up to the pre-applied √X on LQ1, LQ2, LQ5.
  assert.ok(Math.abs(mc.fidelity(steps[0].bloch[2], mc.MAGIC) - 1) < 1e-3);
});
