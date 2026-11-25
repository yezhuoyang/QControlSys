// FormalRV, unchanged, compiles a program against a system specification QuantumOS writes; its
// VM admits the listing and its expander gives the timed operations QuantumOS will execute.
// Skipped when no built FormalRV checkout is next to this one (or at FORMALRV_ROOT).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as formalrv from "../riscq/ftqvm/formalrv.mjs";
import * as spec from "../riscq/ftqvm/spec.mjs";

const skip = !formalrv.available() && "no built FormalRV checkout";

test("spec text round-trips through FormalRV's machine syntax", () => {
  const text = "machine { qubits: 8 total, factories: 2 total, max_parallel_gates: 2 total, decoders: 2 total, classical_data_bandwidth: 32 bits/us, qubit_routing_bandwidth: 4 qubits/us, ancilla_bandwidth: 10 qubits/us, gate1q_ns: 100 ns, gate2q_ns: 200 ns, measure_ns: 300 ns, reset_ns: 1000 ns, route_latency_ns: 1000 ns, decoder_latency_ns: 2000 ns, magic_state_latency_ns: 5000 ns, pauli_frame_update_ns: 50 ns }";
  const s = spec.provisional(text, "FormalRV factory.sysprog", { gadgets: ["surfaceRound"] });
  assert.deepEqual(spec.parseMachine(spec.machineText(s)), spec.parseMachine(text));
  assert.match(spec.sysspecText(s), /^spec program:\n {2}resource \{ qubits_min: 0 total, qubits: 8 total/);
  assert.match(spec.sysspecText(s), /spec surfaceRound:\n {2}resource \{ qubits: 8 total, runtime: 1000000000 ns, gates: 2 total/);
  assert.throws(() => spec.machineText({ machine: { ...s.machine, gate1q_ns: 0 } }), /positive/);
  assert.throws(() => spec.machineText({ machine: { ...s.machine, cycle_ns: 5 } }), /unknown field cycle_ns/);
});

test("the Z⊗Z merge compiles, is admitted and expands to FormalRV's 411 operations", { skip, timeout: 300_000 }, async () => {
  const root = formalrv.formalrvRoot();
  const examples = join(root, "FormalRV", "Examples", "QParamPPM");
  const s = spec.provisional(readFileSync(join(examples, "ZZmerge.machine"), "utf8"), "FormalRV ZZmerge.machine (test profile)", {
    gadgets: ["surfaceRound", "surfaceRoundLogicalAncilla"],
  });
  const built = await formalrv.build({
    qppm: join(examples, "ZZmerge.qppm"), spec: spec.files(s), name: "ZZmerge",
    dir: join(tmpdir(), "quantumos-ftqvm-" + process.pid), code: "surface", distance: 3, specialize: { a: 0, b: 1 },
  });
  assert.equal(built.verdict.status, "RESOURCE_VALIDATED");
  const { ops, calls } = built.listing;
  assert.equal(ops.length, 411);
  assert.equal(calls.length, 6);
  const count = (kind) => ops.filter((o) => o.kind === kind).length;
  assert.deepEqual([count("CNOT"), count("measure"), count("route"), count("CZ"), count("decode_syndrome"), count("pauli_frame_update")], [150, 55, 54, 18, 2, 1]);
  // The merge's check qubit is routed with three qubits of each block before its CZ ladder.
  const route = ops.find((o) => o.kind === "route" && o.qubits.length === 8);
  assert.deepEqual(route.qubits.filter((q) => q.register === "data").map((q) => q.index), [0, 1, 2, 9, 10, 11]);
  const ladder = ops.filter((o) => o.kind === "CZ" && o.start >= route.end).slice(0, 6);
  assert.ok(ladder.every((o) => o.qubits[0].register === "ancilla" && o.qubits[0].index === route.qubits[0].index));
  // Times are the VM's: every op lies inside the listing's span, and its duration is the machine's.
  const m = s.machine;
  for (const o of ops) {
    if (o.kind === "CZ" || o.kind === "CNOT") assert.equal(o.duration, m.gate2q_ns.value);
    if (o.kind === "measure") assert.equal(o.duration, m.measure_ns.value);
    if (o.kind === "route") assert.equal(o.duration, m.route_latency_ns.value);
  }
  assert.equal(Math.max(...ops.map((o) => o.end)), 73300);
});
