// The worked examples of /schedule's interactive stepper (riscq/os/teaching-examples.mjs) show what
// their lessons say, on the operating system's own scheduler (riscq/os/schedule.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { EXAMPLES } from "../riscq/os/teaching-examples.mjs";
import * as qsysasm from "../riscq/ftqvm/qsysasm.mjs";
import { schedule } from "../riscq/os/schedule.mjs";

const ex = (id) => EXAMPLES.find((e) => e.id === id);
function run(text, options = {}, fields = {}) {
  const p = qsysasm.parse(text);
  p.machine = { ...p.machine, ...fields };
  return schedule(p, { mode: p.ops.every((o) => o.start !== null) ? "triggered" : "dependency", ...options });
}

test("every example is a complete QSysASM program with a machine line", () => {
  for (const e of EXAMPLES) {
    const p = qsysasm.parse(e.text);
    assert.ok(p.machine, e.id);
    assert.ok(p.ops.length > 0, e.id);
    for (const f of e.controls) assert.ok(p.machine[f] !== undefined, e.id + " controls " + f);
  }
});

test("the critical path: nothing waits for a service", () => {
  const s = run(ex("critical-path").text, ex("critical-path").options);
  assert.equal(s.sim.ops.filter((o) => o.waitNs > 0).length, 0);
  assert.equal(s.makespanNs, 4032); // the cycle-exact round's timetable (§ 3)
});

test("services change the makespan as each lesson says", () => {
  assert.ok(run(ex("gate-slots").text).makespanNs > run(ex("gate-slots").text, {}, { max_parallel_gates: 6 }).makespanNs);
  assert.equal(run(ex("order-matters").text, ex("order-matters").options).makespanNs, 3000);
  assert.equal(run(ex("order-matters").variants[1].text, ex("order-matters").options).makespanNs, 2600);
  assert.equal(run(ex("classical-bandwidth").text).makespanNs, 2000);
  assert.equal(run(ex("classical-bandwidth").text, {}, { classical_data_bandwidth: 8 }).makespanNs, 1000);
  assert.deepEqual(run(ex("ancilla-bandwidth").text).sim.ops.filter((o) => o.kind === "request_ancilla").map((o) => o.start), [0, 160, 320]);
  assert.ok(run(ex("decoder-backlog").text, { policy: "fifo" }).makespanNs > run(ex("decoder-backlog").text, { policy: "fifo" }, { decoders: 2 }).makespanNs);
  assert.equal(run(ex("factory").text).makespanNs - run(ex("factory").text, {}, { factories: 2 }).makespanNs, 5000);
  assert.ok(run(ex("routing").text).makespanNs >= 150_000);
  assert.ok(run(ex("routing").text, {}, { qubit_routing_bandwidth: 3 }).makespanNs < 51_000);
});

test("deadlock under first-ready; none with ancillas granted in program order", () => {
  assert.ok(run(ex("deadlock").text, { policy: "fifo" }).sim.deadlock);
  assert.equal(run(ex("deadlock").text, { policy: "fifo", orderedPools: ["qubits"] }).sim.deadlock, null);
});

test("starvation under backfill; served at once in program order", () => {
  const backfill = run(ex("starvation").text, { policy: "fifo" }).sim.ops[0];
  assert.ok(backfill.waitNs > 4000 && backfill.bypassed > 10);
  assert.equal(run(ex("starvation").text, { policy: "fifo", orderedPools: ["qubits"] }).sim.ops[0].waitNs, 0);
});
