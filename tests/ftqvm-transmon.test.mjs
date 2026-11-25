// A FormalRV listing on a transmon chip: placement, the generated chip, time-triggered
// execution in the Lean model, and a system specification derived from the trace.
// FormalRV is used unchanged; the tests skip without a built checkout (riscq/ftqvm/formalrv.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as formalrv from "../riscq/ftqvm/formalrv.mjs";
import { deriveTransmon } from "../riscq/ftqvm/derive.mjs";
import { conformance } from "../riscq/ftqvm/sc-run.mjs";
import { check } from "../riscq/design.mjs";

const skip = !formalrv.available() && "no built FormalRV checkout";

let derived;
const derive = async () => {
  const ex = join(formalrv.formalrvRoot(), "FormalRV", "Examples", "QParamPPM");
  return (derived ??= deriveTransmon({ qppm: join(ex, "ZZmerge.qppm"), specialize: { a: 0, b: 1 }, baseMachine: join(ex, "ZZmerge.machine"),
    gadgets: ["surfaceRound", "surfaceRoundLogicalAncilla"], maxIterations: 5 }));
};

test("placement puts every round check on its rotated-surface-code site", { skip, timeout: 300_000 }, async () => {
  const { iterations } = await derive();
  const { placement, listing } = iterations.at(-1);
  // Every check ancilla of a round sits next (0.71 lattice units) to each data qubit it gates.
  for (const call of listing.calls) {
    for (const op of listing.ops.filter((o) => call.ops.includes(o.uid) && (o.kind === "CNOT" || o.kind === "CZ"))) {
      const [a, b] = op.qubits.map((q) => placement.sites[placement.siteOf(q)].rc);
      assert.ok(Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1]) - Math.SQRT1_2) < 1e-9, "round gate on line " + op.line + " is not nearest-neighbour");
    }
  }
  // 18 data qubits; identities that never live at once share a site.
  assert.equal(placement.sites.filter((s) => s.kind === "data").length, 18);
  assert.ok(placement.sites.length < 18 + placement.live.size);
});

test("FormalRV's test-profile durations do not hold on the chip; the derived ones do", { skip, timeout: 300_000 }, async () => {
  const { iterations } = await derive();
  const [first] = iterations, last = iterations.at(-1);
  assert.equal(first.verdict, "RESOURCE_VALIDATED");
  assert.equal(first.report.conforms, false);
  assert.equal(first.report.byKind.CZ.maxOverrunNs, 350); // a 400 ns CZ in a 50 ns window
  assert.equal(first.report.byKind.CZ.ok, 0);
  // The derived spec: measured on the trace, rounded to the 2 ns batch grid. A measurement ends when
  // its bit is stored; the result's path to the core is the one measured on RISC-Q's RTL.
  const m = last.spec.machine;
  assert.deepEqual([m.gate1q_ns.value, m.gate2q_ns.value, m.measure_ns.value, m.reset_ns.value, m.route_latency_ns.value], [36, 472, 1440, 160, 2]);
  for (const f of ["gate1q_ns", "gate2q_ns", "measure_ns", "reset_ns"]) assert.equal(m[f].source, "measured");
  // The decoder is the compiled Helios union-find, measured; the frame update is measured on the frame core.
  assert.equal(m.decoder_latency_ns.source, "measured");
  assert.equal(m.pauli_frame_update_ns.source, "measured");
  assert.equal(last.verdict, "RESOURCE_VALIDATED");
  assert.equal(last.report.conforms, true);
  assert.equal(last.report.status, "quiescent");
  assert.deepEqual(last.report.faults, []);
  // Every system call of the listing is realized: nothing is left unrealized.
  assert.deepEqual(last.report.unrealized, []);
  assert.ok(last.report.byKind.decode_syndrome.ok === 2 && last.report.byKind.pauli_frame_update.ok === 1);
  assert.deepEqual(check(last.design).errors, []);
});

test("the round contract is measured, and FormalRV admits the program against it", { skip, timeout: 300_000 }, async () => {
  const { iterations } = await derive();
  const last = iterations.at(-1);
  const round = last.contracts.surfaceRound;
  assert.equal(round.qubits, 17); // 9 data + 8 checks
  assert.ok(round.hardware.runtime <= round.runtime);
  assert.equal(last.spec.contracts.surfaceRound.qubits.source, "measured");
  assert.equal(last.verdict, "RESOURCE_VALIDATED");
  assert.equal(last.report.conforms, true);
});

test("the checker refuses a trace that overruns its listing", { skip, timeout: 300_000 }, async () => {
  const { iterations } = await derive();
  const it = iterations.at(-1);
  // The same trace against a listing that promises one CNOT 100 ns sooner.
  const target = it.listing.ops.find((o) => o.kind === "CNOT");
  const tampered = { ...it.listing, ops: it.listing.ops.map((o) => (o === target ? { ...o, end: o.end - 100 } : o)) };
  const rows = new Map(it.report.rows.map((r) => [r.uid, r]));
  assert.equal(rows.get(target.uid).ok, true);
  // Run the conforming listing again to get the trace and the lowering it came from.
  const { runListing } = await import("../riscq/ftqvm/sc-run.mjs");
  const run = await runListing(it.listing, it.placement, it.design);
  const report = conformance(tampered, { hardware: run.hardware, lowered: run.lowered, origin: run.origin, unrealized: run.unrealized, quantization: run.quantization }, run.result, run.built, run.m);
  const row = report.rows.find((r) => r.uid === target.uid);
  assert.equal(row.ok, false);
  assert.equal(row.overrunNs, 100);
  assert.equal(report.conforms, false);
});
