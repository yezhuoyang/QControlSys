// QSysASM is flat (riscq/ftqvm/qsysasm.mjs): one statement per operation on concrete qubits. The
// parser refuses what a compiler's listing may contain and a program may not: gadgets, contracts,
// calls, loops, guards and parameters. The writer and the parser agree on every stored listing.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as qsysasm from "../riscq/ftqvm/qsysasm.mjs";
import { schedule, dependencies } from "../riscq/os/schedule.mjs";
import { simulate, machineModel } from "../riscq/os/des.mjs";

test("the parser refuses gadgets, contracts, calls, loops, guards and parameters", () => {
  for (const text of ["gadget surfaceRound[data: dbase + 9](dbase) spans 2478 ns:", "spec surfaceRound:", "call surfaceRound(0, 0, 0)",
    "for 0 <= i < n:", "when c[1]:", "H data[i]", "@0 ns  CNOT ancilla[abase], data[dbase + 1]", "maintenance surfaceRound data[0:8]", "params  n"])
    assert.throws(() => qsysasm.parse(text), SyntaxError, text);
});

test("statements read back: records, bases, counts, Pauli tags and a factory's workspace", () => {
  const p = qsysasm.parse([
    "machine { qubits: 20 total, gate1q_ns: 40 ns, measure_ns: 1000 ns }",
    "@0 ns    request_ancilla  count=2  ancilla[0:1]",
    "@40 ns   CZ  ancilla[1], Z data[0]",
    "@80 ns   measure  basis=X  ancilla[0] -> s[0]",
    "@90 ns   s[0:1] -> decode_syndrome  rounds=3",
    "@95 ns   c[4:5] -> pauli_frame_update  X data[0], X data[3]",
    "@100 ns  request_magic  state=|T>  ancilla[2:10]  with  ancilla[11:18]",
  ].join("\n"));
  assert.equal(p.machine.measure_ns, 1000);
  const [req, cz, meas, dec, frame, magic] = p.ops;
  assert.equal(req.arg, 2);
  assert.deepEqual(cz.paulis, ["", "Z"]);
  assert.equal(meas.arg, "X");
  assert.deepEqual(meas.writes, [{ register: "s", index: 0 }]);
  assert.equal(dec.reads.length, 2);
  assert.deepEqual(frame.paulis, ["X", "X"]);
  assert.equal(magic.qubits.length, 9);
  assert.equal(magic.work.length, 8);
  assert.equal(magic.arg, "|T>");
  // Written back, the statements are the same.
  const again = qsysasm.parse(qsysasm.format({ ops: p.ops.map((o, i) => ({ ...o, order: i })) }).text).ops;
  assert.deepEqual(again.map((o) => [o.kind, o.start, o.qubits, o.work, o.reads, o.writes, o.arg]), p.ops.map((o) => [o.kind, o.start, o.qubits, o.work, o.reads, o.writes, o.arg]));
});

test("every stored twin listing is flat QSysASM and reads back operation for operation", () => {
  const dir = new URL("../validation/ftqvm/twins/", import.meta.url);
  for (const id of readdirSync(dir))
    for (const f of readdirSync(new URL(id + "/", dir))) {
      const { listing } = JSON.parse(readFileSync(new URL(id + "/" + f, dir), "utf8"));
      for (const op of listing.ops.slice(0, 50)) assert.doesNotThrow(() => qsysasm.parse(op.text), op.text);
      const back = qsysasm.parse(qsysasm.format(listing).text).ops;
      const sorted = [...listing.ops].sort((a, b) => a.start - b.start || a.order - b.order);
      assert.equal(back.length, sorted.length);
      back.forEach((o, i) => assert.equal(o.kind + o.start, sorted[i].kind + sorted[i].start, id + "/" + f + " statement " + (i + 1)));
    }
});

test("the OS orders a frame update after the decode of the syndrome it reads", () => {
  const p = qsysasm.parse(["machine { qubits: 5 total, decoders: 1 total, factories: 0 total, classical_data_bandwidth: 500 bits/us, qubit_routing_bandwidth: 5000 qubits/us,",
    " ancilla_bandwidth: 50 qubits/us, max_parallel_gates: 5 total, gate1q_ns: 40 ns, gate2q_ns: 200 ns, measure_ns: 1000 ns, reset_ns: 160 ns, route_latency_ns: 2 ns,",
    " decoder_latency_ns: 300 ns, magic_state_latency_ns: 1 ns, pauli_frame_update_ns: 30 ns }"].join("") + "\n" + [
    "measure basis=Z ancilla[0] -> s[0]", "s[0] -> decode_syndrome rounds=1", "s[0] -> pauli_frame_update X data[0]"].join("\n"));
  const edges = dependencies(p.ops);
  assert.ok(edges.some((e) => e.from === 1 && e.to === 2 && e.why === "decoded s[0]"));
  const s = schedule(p);
  assert.equal(s.ops[1].start, 1000);
  assert.equal(s.ops[2].start, 1300); // after the decode, not at the measurement's end
  assert.match(s.text, /@1300 ns\s+s\[0\] -> pauli_frame_update {2}X data\[0\]/);
});

test("hold and wait deadlocks two tenants; granting ancillas in program order does not", () => {
  const text = ["@0 ns request_ancilla count=1 ancilla[0]", "@200 ns request_ancilla count=1 ancilla[1]", "@400 ns release_ancilla count=2 ancilla[0:1]",
    "@0 ns request_ancilla count=1 ancilla[2]", "@200 ns request_ancilla count=1 ancilla[3]", "@400 ns release_ancilla count=2 ancilla[2:3]"].join("\n");
  const machine = { qubits: 2, decoders: 1, factories: 0, classical_data_bandwidth: 500, qubit_routing_bandwidth: 500, ancilla_bandwidth: 64, max_parallel_gates: 2,
    gate1q_ns: 40, gate2q_ns: 200, measure_ns: 1000, reset_ns: 160, route_latency_ns: 2, decoder_latency_ns: 300, magic_state_latency_ns: 1, pauli_frame_update_ns: 30 };
  const p = qsysasm.withDurations({ ...qsysasm.parse(text), machine });
  const ops = p.ops.map((o, i) => ({ ...o, uid: i, order: i, end: o.start + o.duration }));
  const model = machineModel(machine);
  assert.ok(simulate({ ops }, { model, mode: "triggered" }).deadlock);
  const ordered = simulate({ ops }, { model, mode: "triggered", orderedPools: ["qubits"] });
  assert.equal(ordered.deadlock, null);
  assert.equal(ordered.completed, ops.length);
});

test("a statement's own guard: parsed, printed back, evaluated, and waited for", () => {
  const text = [
    "machine { qubits: 8 total, decoders: 1 total, factories: 1 total, classical_data_bandwidth: 500 bits/us, qubit_routing_bandwidth: 5000 qubits/us, ancilla_bandwidth: 1000 qubits/us, max_parallel_gates: 8 total, gate1q_ns: 40 ns, gate2q_ns: 200 ns, measure_ns: 1000 ns, reset_ns: 160 ns, route_latency_ns: 2 ns, decoder_latency_ns: 400 ns, magic_state_latency_ns: 5000 ns, pauli_frame_update_ns: 30 ns }",
    "measure basis=Z data[0] -> c[3]",
    "measure basis=Z data[1] -> c[5]",
    "measure basis=Z data[2] -> c[6]",
    "X data[3] if c[3], ¬c[5:6]",
    "c[3] -> pauli_frame_update Z data[4] if !c[5]",
  ].join("\n");
  const p = qsysasm.parse(text);
  const [, , , x, frame] = p.ops;
  assert.deepEqual(x.guard, { bands: [{ negated: false, records: [{ register: "c", index: 3 }] }, { negated: true, records: [{ register: "c", index: 5 }, { register: "c", index: 6 }] }] });
  assert.deepEqual(x.qubits, [{ register: "data", index: 3 }]);
  assert.equal(frame.guard.bands[0].negated, true);
  assert.deepEqual(frame.paulis, ["Z"]);
  // Printed back with ¬, and read again to the same guard.
  assert.equal(qsysasm.guardText(x.guard), "if c[3], ¬c[5:6]");
  const again = qsysasm.parse(qsysasm.format({ ops: p.ops.map((o, i) => ({ ...o, start: i * 10, order: i })) }).text).ops;
  assert.deepEqual(again.map((o) => o.guard ?? null), p.ops.map((o) => o.guard ?? null));
  // Holds when c[3] = 1 and c[5] xor c[6] = 0.
  assert.equal(qsysasm.guardHolds(x.guard, { "c[3]": 1, "c[5]": 1, "c[6]": 1 }), true);
  assert.equal(qsysasm.guardHolds(x.guard, { "c[3]": 1, "c[5]": 1 }), false);
  assert.equal(qsysasm.guardHolds(x.guard, {}), false);
  // A band that is not one range of one register cannot be printed; a malformed band is refused.
  assert.throws(() => qsysasm.guardText({ bands: [{ negated: false, records: [{ register: "c", index: 1 }, { register: "c", index: 4 }] }] }));
  assert.throws(() => qsysasm.parse("X data[0] if c[i]"), SyntaxError);
  assert.throws(() => qsysasm.parse("X data[0] if"), SyntaxError);
  assert.throws(() => qsysasm.parse("when c[1]:"), SyntaxError);
  // The scheduler waits for the guard's measurements.
  const edges = dependencies(p.ops);
  for (const [from, why] of [[0, "guard c[3]"], [1, "guard c[5]"], [2, "guard c[6]"]]) assert.ok(edges.some((e) => e.from === from && e.to === 3 && e.why === why), why);
  const s = schedule(p);
  assert.equal(s.ops[3].start, 1000);
  assert.match(s.text, /X {2}data\[3\] {2}if c\[3\], ¬c\[5:6\]/);
});
