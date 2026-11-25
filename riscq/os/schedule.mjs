// The operating system's scheduler for a QSysASM program (riscq/ftqvm/qsysasm.mjs).
//
// A program states what to do to which physical qubits and which services it needs. The
// operating system decides when. This module turns an untimed (or timed) flat program into a
// timetable: every statement gets an absolute start, and the result is again a QSysASM program.
//
// Execution semantics (the interface's, as the resource VM checks them):
//   qubit order      a statement waits for the previous statement on each of its qubits
//   records          a statement that reads a record waits for the measurement that wrote it
//   decoding         a statement that reads a record a decode_syndrome has read (a frame update,
//                    a parity) waits for that decode: consumers of a syndrome need it decoded
//   services         gates, decoders, factories, qubits and the three bandwidths are pools with the
//                    machine line's capacities; a statement holds its demand while it runs, and
//                    request_ancilla holds its qubits until their release_ancilla
// Durations are the machine line's latencies for each kind (qsysasm.DURATION_FIELD). Times are
// integer nanoseconds. The scheduling itself is riscq/os/des.mjs: list scheduling in a policy's
// order, with backfill unless `strict`.
import { simulate, machineModel } from "./des.mjs";
import * as qsysasm from "../ftqvm/qsysasm.mjs";

const key = (s) => s.register + "[" + s.index + "]";

/**
 * The dependency edges of a program: [{ from, to, why }] with statement indices into `ops`
 * (program order) and the reason ("qubit data[1]", "record s[0]", "decoded s[0]").
 */
export function dependencies(ops) {
  const edges = [], lastOn = new Map(), writer = new Map(), decodedBy = new Map();
  const add = (from, to, why) => { if (from !== undefined && from !== to && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, why }); };
  ops.forEach((op, i) => {
    for (const q of [...op.qubits, ...(op.work ?? [])]) { add(lastOn.get(key(q)), i, "qubit " + key(q)); lastOn.set(key(q), i); }
    for (const r of op.reads ?? []) {
      add(writer.get(key(r)), i, "record " + key(r));
      if (op.kind !== "decode_syndrome") add(decodedBy.get(key(r)), i, "decoded " + key(r));
    }
    for (const w of op.writes ?? []) writer.set(key(w), i);
    if (op.kind === "decode_syndrome") for (const r of op.reads) decodedBy.set(key(r), i);
  });
  return edges;
}

/** Ops in the shape riscq/os/des.mjs reads, with the decoding rule made a record dependency. */
function forSimulation(ops) {
  const decodedBy = new Map();
  return ops.map((op, i) => {
    const reads = [...(op.reads ?? [])], writes = [...(op.writes ?? [])];
    if (op.kind === "decode_syndrome") for (const r of op.reads) { writes.push({ register: "decoded:" + r.register, index: r.index }); decodedBy.set(key(r), true); }
    else for (const r of op.reads ?? []) if (decodedBy.has(key(r))) reads.push({ register: "decoded:" + r.register, index: r.index });
    return { ...op, uid: i, order: i, reads, writes, qubits: [...op.qubits, ...(op.work ?? [])], start: op.start ?? 0, end: (op.start ?? 0) + op.duration };
  });
}

/**
 * Schedule a parsed program ({ machine, ops } from qsysasm.parse). options: { policy ("order",
 * "fifo", "deadline", "priority"), strict, acquisition ("atomic" | "incremental"), orderedPools,
 * mode ("dependency" | "triggered") }. Returns { ops (timed, program order), text (timed QSysASM),
 * makespanNs, edges, sim (des.mjs's result: waits, pool use, deadlock, starvation) }.
 */
export function schedule(program, { policy = "order", strict = false, acquisition = "atomic", orderedPools = [], mode = "dependency", title } = {}) {
  const parsed = qsysasm.withDurations({ machine: program.machine, ops: program.ops.map((o) => ({ ...o })) });
  const ops = parsed.ops;
  const sim = simulate({ ops: forSimulation(ops) }, { model: machineModel(program.machine), mode, policy, strict, acquisition, orderedPools });
  const timed = ops.map((op, i) => {
    const s = sim.ops.find((x) => x.uid === i);
    return { ...op, uid: i, order: i, start: s?.start ?? null, end: s?.start === null || s?.start === undefined ? null : s.start + op.duration };
  });
  const done = timed.filter((o) => o.start !== null);
  const flat = done.length === timed.length ? qsysasm.flatten({ ops: timed }, { title, machineLine: qsysasm.machineLine(program.machine), factories: program.factories }) : null;
  return { ops: flat ? flat.listing.ops : timed, text: flat?.text ?? null, makespanNs: sim.makespanNs, edges: dependencies(ops), sim };
}

/**
 * The calibration loop: declare → schedule → run → measure → raise, until the run conforms.
 * `program` is a parsed QSysASM program ({ machine, ops }; statements may be untimed); `run` takes a
 * timed listing ({ ops }) and returns { report } in the shape of riscq/ftqvm/sc-run.mjs conformance
 * (rows with kind, start, hardwareNs, bitNs; conforms), so any platform's runner fits. Each field
 * whose operations needed more than declared is raised to the need, rounded up to `gridNs`.
 * Returns { conforms, machine, iterations: [{ machine, text, makespanNs, conforms, rows, needed, raise }],
 * schedule (the last), result (the last run's value) }.
 */
/**
 * Per machine field (qsysasm.DURATION_FIELD, the interface's own table, request_magic included): the
 * longest time any statement charged to it needed on the hardware, from its start to its last
 * pulse, or for a measurement to its bit. A statement the hardware never completed measures nothing.
 */
export function measuredDurations(report) {
  const out = {};
  for (const r of report.rows) {
    const field = qsysasm.DURATION_FIELD[r.kind];
    if (!field) continue;
    const need = Math.max(r.hardwareNs ? r.hardwareNs[1] - r.start : 0, r.bitNs !== undefined && r.bitNs !== null ? r.bitNs - r.start : 0);
    if (Number.isFinite(need)) out[field] = Math.max(out[field] ?? 0, need);
  }
  return out;
}

export async function calibrate(program, run, { maxIterations = 6, policy = "order", gridNs = 2, title, scheduleOptions = {} } = {}) {
  let machine = { ...program.machine };
  const iterations = [];
  let last;
  for (let i = 0; i < maxIterations; i++) {
    const s = schedule({ ...program, machine }, { policy, ...scheduleOptions, title: title && title + " (iteration " + (i + 1) + ")" });
    if (!s.text) return { conforms: false, machine, iterations, schedule: s, result: null, reason: "the program cannot be scheduled on this machine (" + (s.sim.deadlock ? "deadlock" : "a statement can never start") + ")" };
    const result = await run({ ops: s.ops });
    const report = result.report;
    const needed = measuredDurations(report);
    const raise = Object.fromEntries(Object.entries(needed).filter(([f, n]) => machine[f] !== undefined && n > machine[f]).map(([f, n]) => [f, Math.ceil(n / gridNs) * gridNs]));
    const rows = report.rows.map((r) => ({ uid: r.uid, kind: r.kind, start: r.start, end: r.end, hw: r.hardwareNs ?? null, bitNs: r.bitNs ?? null, ok: r.ok, overrunNs: r.overrunNs ?? 0 })).sort((a, b) => a.uid - b.uid);
    iterations.push({ machine: { ...machine }, text: s.text, makespanNs: s.makespanNs, conforms: report.conforms, rows, needed, raise });
    last = { schedule: s, result };
    if (report.conforms) return { conforms: true, machine, iterations, ...last };
    if (!Object.keys(raise).length) return { conforms: false, machine, iterations, ...last, reason: "the run does not conform, and no declared latency is short: the overrun is not a duration (a window the timetable cannot give)" };
    machine = { ...machine, ...raise };
  }
  return { conforms: false, machine, iterations, ...last, reason: "no conforming run within " + maxIterations + " iterations" };
}

/** The machine line's fields as numbers, with `fields` replaced. */
export const withFields = (machine, fields) => ({ ...machine, ...fields });
