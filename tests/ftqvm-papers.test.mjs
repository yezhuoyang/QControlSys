// Published experiments as FormalRV programs on digital twins of their machines.
// Skipped without a built FormalRV checkout (riscq/ftqvm/formalrv.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as formalrv from "../riscq/ftqvm/formalrv.mjs";
import { willow, onDevice } from "../riscq/ftqvm/twins.mjs";
import { googleExperiment } from "../riscq/ftqvm/papers.mjs";

const skip = !formalrv.available() && "no built FormalRV checkout";

test("the Willow twin: a distance-7 patch on the square grid, the paper's durations", () => {
  const w = willow();
  assert.equal(w.sites.length, 97);
  assert.equal(w.sites.filter((s) => s.kind === "data").length, 49);
  // Every measure qubit couples to the 2 or 4 data qubits of its check, and nothing else.
  assert.equal(w.couplers.length, 4 * 36 + 2 * 12);
  assert.deepEqual([w.durations.x90Ns.value, w.durations.czNs.value], [25, 42]);
  assert.match(w.durations.czNs.source, /2408\.13687/);
  // A placement that needs a qubit the device does not have is refused.
  const placement = { sites: [{ rc: [0, 0] }, { rc: [9, 9] }], siteOf: (a) => a };
  assert.throws(() => onDevice(placement, w, []), /does not fit google-willow/);
});

test("Google's d = 3 memory compiles onto the Willow twin and conforms", { skip, timeout: 600_000 }, async () => {
  const { rows } = await googleExperiment({ distances: [3], rounds: 10, dir: join(tmpdir(), "quantumos-test-google-" + process.pid), baseMachine: "validation/ftqvm/base.machine" });
  const [r] = rows;
  assert.equal(r.verdict, "RESOURCE_VALIDATED");
  assert.equal(r.conforms, true);
  assert.equal(r.qubits, 97);
  assert.equal(r.ops, 601);
  // The twin's durations on its 2 ns grid: XY 25 → 26 ns, CNOT = H·CZ·H = 26 + 42 + 26 ns.
  assert.deepEqual([r.gate1qNs, r.gate2qNs, r.resetNs], [26, 94, 160]);
  // FormalRV's round is longer than the paper's 1.1 µs cycle: its schedule runs few checks at once.
  assert.ok(r.roundNs > r.paper.cycleNs && r.roundGates <= 8, JSON.stringify(r));
});

test("Bluvstein's Bell pair: a transversal CNOT, compiled onto the twin of their array, conforms", { skip, timeout: 900_000 }, async () => {
  const { bluvsteinExperiment } = await import("../riscq/ftqvm/papers.mjs");
  const { rows } = await bluvsteinExperiment({ distances: [3], bases: ["Z"], dir: join(tmpdir(), "quantumos-test-bluvstein-" + process.pid), baseMachine: "validation/ftqvm/base.machine" });
  const [r] = rows;
  assert.equal(r.verdict, "RESOURCE_VALIDATED");
  assert.equal(r.conforms, true, JSON.stringify(r.failing));
  assert.equal(r.transversalCnots, 9); // one per pair of the two d = 3 blocks
  // The twin's numbers: a 200 µs AOD job per route; a CNOT is at least global Raman 1 µs + CZ
  // 270 ns + 1 µs, and more where its layer waits for a shared global pulse; readout = 200 µs
  // move to the readout zone + 500 µs imaging.
  assert.ok(r.routeNs >= 200_000 && r.routeNs < 201_000, String(r.routeNs));
  assert.ok(r.gate2qNs >= 2_270, String(r.gate2qNs));
  assert.ok(r.measureNs >= 700_000 && r.measureNs < 702_000, String(r.measureNs));
  // FormalRV runs the transversal gate's per-pair routes a few at a time on the twin's 2 AODs.
  assert.ok(r.transversalSpreadNs > 400_000, String(r.transversalSpreadNs));
});

test("Quantinuum's Steane-code teleportation: refused on the 32-qubit H2, conforms on the 56-qubit H2", { skip, timeout: 900_000 }, async () => {
  const { quantinuumExperiment } = await import("../riscq/ftqvm/papers.mjs");
  const { rows } = await quantinuumExperiment({ dir: join(tmpdir(), "quantumos-test-quantinuum-" + process.pid), baseMachine: "validation/ftqvm/base.machine" });
  const [small, large] = rows;
  // Background maintenance reserves measure qubits for every live block: 32 qubits are too few.
  assert.match(small.error, /exceeds the live-qubit budget/);
  assert.equal(large.verdict, "RESOURCE_VALIDATED");
  assert.equal(large.conforms, true, JSON.stringify(large.failing));
  assert.ok(large.qubits <= 56);
  // Each two-qubit gate carries its own transport: the spec covers the worst trip round the track.
  assert.equal(large.routeNs, 10);
  assert.ok(large.gate2qNs >= 25_000 + 80_000 * 2 + 20 * 5_000, String(large.gate2qNs));
  assert.ok(large.slack.CNOT.medianNs < large.slack.CNOT.maxNs);
});

test("the reproduction pages list every reproduction and serve its run", async () => {
  const { REPRODUCTIONS } = await import("../riscq/ftqvm/reproductions.mjs");
  for (const r of REPRODUCTIONS) {
    for (const k of ["id", "status", "platform", "title", "summary", "program", "twin"]) assert.ok(r[k], r.id + " has no " + k);
    assert.ok(r.paper.url.startsWith("https://"), r.id);
    assert.ok(Array.isArray(r.findings) && Array.isArray(r.limits), r.id);
  }
});
