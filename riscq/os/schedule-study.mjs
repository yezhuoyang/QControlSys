// The data of the Schedule and Compilation page (/schedule): every number on it is computed here,
// from QSysASM programs scheduled by the operating system (riscq/os/schedule.mjs) and executed on
// a generated transmon chip in the cycle-exact Lean model of RISC-Q (riscq/ftqvm/sc-run.mjs).
//
//   node riscq/os/schedule-study.mjs        → validation/os/schedule.json
//
// Parts:
//   round        one parity round of the 3-qubit bit-flip code, from source to firmware: the
//                dependency graph, the calibration loop (declare → schedule → run → measure →
//                raise), the final timetable, every pulse, every core's RV32I firmware with the
//                statement each instruction implements, and the path of a measured bit
//   problems     the scheduling problem on small programs: how far list scheduling is from the
//                optimum (exhaustive search), deadlock under hold-and-wait, starvation under
//                backfill, and a decoder that cannot keep pace (des.mjs, the same executor)
//   calibration  each system call run alone and k at a time on the chip: latency and the rate
//                one service sustains; and the corpus-wide figures of the Examples studies
// Scope: the classical control system and the timing of scheduled operations. No quantum state
// is simulated; measurement outcomes are inputs.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import * as qsysasm from "../ftqvm/qsysasm.mjs";
import { schedule, dependencies, calibrate } from "./schedule.mjs";
import { simulate, machineModel } from "./des.mjs";
import { place } from "../ftqvm/place.mjs";
import { chipDesign } from "../ftqvm/sc-chip.mjs";
import { runListing } from "../ftqvm/sc-run.mjs";
import { compileCore } from "../firmware.mjs";
import { MAP } from "../soc.mjs";
import { decode as disassemble } from "../../studio/riscq-disasm.js";

const OUT = new URL("../../validation/os/", import.meta.url);
const key = (s) => s.register + "[" + s.index + "]";
const CHIP = { qubitsPerCore: 1, decoders: 1, coresPerDecoder: 1 };

// ---------------------------------------------------------------------------------------------
// The program of the walk-through, written as a person would: no times, the OS assigns them.
export const ROUND_SOURCE = `# One round of the 3-qubit bit-flip code: two parity checks, a decode, a frame update.
# Data qubits data[0:2]; two ancillas; no statement carries a time: the OS schedules them.
request_ancilla  count=2  ancilla[0:1]
route  ancilla[0], data[0:1]
CNOT  data[0], ancilla[0]
CNOT  data[1], ancilla[0]
route  ancilla[1], data[1:2]
CNOT  data[1], ancilla[1]
CNOT  data[2], ancilla[1]
measure  basis=Z  ancilla[0] -> s[0]
measure  basis=Z  ancilla[1] -> s[1]
release_ancilla  count=2  ancilla[0:1]
s[0:1] -> decode_syndrome  rounds=1
s[0:1] -> pauli_frame_update  X data[0:2]
`;

// What a person would declare before measuring anything: typical transmon figures, provisional.
export const PROVISIONAL = {
  qubits: 5, decoders: 1, factories: 0, classical_data_bandwidth: 500, qubit_routing_bandwidth: 2500, ancilla_bandwidth: 32,
  max_parallel_gates: 5, gate1q_ns: 40, gate2q_ns: 200, measure_ns: 1000, reset_ns: 160, route_latency_ns: 2,
  decoder_latency_ns: 200, magic_state_latency_ns: 1, pauli_frame_update_ns: 30,
};

/** Place a program's qubits on a row of n transmons (plus ancillas) and build its chip design. */
function chipFor(listing, n) {
  const placement = place(listing, { d: Math.max(1, n), n, gap: 1 });
  const { design } = chipDesign(listing, placement, CHIP);
  return { placement, design };
}

/** One run on the chip; returns the run and per-statement rows in program order. */
async function runOnChip(listing, n, outcomes = {}) {
  const { placement, design } = chipFor(listing, n);
  const run = await runListing(listing, placement, design, { outcomes, distance: Math.max(1, n) });
  return { ...run, placement, design };
}

const PERIOD_NS = (m) => m.period / 1000;
const nsOfBatch = (run, batch) => Math.round(((batch - run.report.baseBatch) * run.m.period) / 1000);

/**
 * A comment for every instruction of a core's image: the registers the firmware keeps (s0 the
 * segment's time base, s1 the timer block, s2 the bit table), constants followed through lui/addi,
 * and every store or load named by the SoC's address map (riscq/soc.mjs MAP).
 */
export function annotate(rows, core, periodNs) {
  const ABI = { x0: "zero", x5: "t0", x6: "t1", x7: "t2", x8: "s0", x9: "s1", x10: "a0", x11: "a1", x12: "a2", x13: "a3", x14: "a4", x15: "a5", x16: "a6", x18: "s2" };
  const known = new Map([["x0", 0]]);
  const name = (addr) => {
    const a = addr >>> 0;
    if (a === MAP.CTRL_TIME_CMP) return "TIME_CMP";
    if (a === MAP.CTRL_WAIT_TIME_CMP) return "WAIT (stalls until the batch counter reaches TIME_CMP)";
    if (a === MAP.CTRL_DONE) return "DONE";
    if (a === MAP.CTRL_TIME) return "TIME (the batch counter)";
    if (a >= MAP.SINK_BASE && a < MAP.INBOX_BOARD) return "sink " + Math.floor((a - MAP.SINK_BASE) / MAP.SINK_STRIDE) + " (a demodulated result)";
    if (a === MAP.INBOX_BOARD) return "board inbox (bits published by other cores)";
    if (a === MAP.INBOX_RELEASE) return "release inbox (barrier)";
    if (a >= MAP.INBOX_MAILBOX0 && a < MAP.PUT_WINDOW) return "mailbox " + ((a - MAP.INBOX_MAILBOX0) >> 2);
    if (a >= MAP.HOSTWIN) return "host window word " + ((a - MAP.HOSTWIN) >> 2) + " (a result for the host)";
    if (a >= MAP.MEM_BASE) return "RAM 0x" + a.toString(16);
    if (a >= MAP.PUT_WINDOW) {
      const ch = Math.floor((a - MAP.PUT_WINDOW) / MAP.RF_CH_STRIDE), off = (a - MAP.PUT_WINDOW) % MAP.RF_CH_STRIDE;
      // Put windows past the core's own channels are nodes of the board hub.
      if (ch >= MAP.INBOX_NODE0) return "hub inbox node " + (ch - MAP.INBOX_NODE0) + " (publish to every core of the board)";
      if (ch >= MAP.BARRIER_NODE0) return "hub barrier " + (ch - MAP.BARRIER_NODE0) + " (arrive)";
      if (ch >= MAP.GROUP_NODE0) return "hub group node " + (ch - MAP.GROUP_NODE0);
      const reg = off === MAP.RF_START_TIME ? "start_time" : off === MAP.RF_FIRE ? "fire" : off === MAP.RF_FREQ ? "freq" : off === MAP.RF_DC_OFFSET ? "dc_offset" : off === MAP.RF_PHASE_OFFSET ? "phase_offset"
        : off < MAP.RF_START_TIME ? "slot" + (Math.floor(off / MAP.RF_SLOT_STRIDE) - 1) + "." + ["phase", "amp", "env", "dur"][(off % MAP.RF_SLOT_STRIDE) / 4] : "0x" + off.toString(16);
      return "channel " + (core?.channels[ch]?.name ?? ch) + "." + reg;
    }
    return "0x" + a.toString(16);
  };
  const r = (x) => ABI[x] ?? x;
  return rows.map((row) => {
    const t = row[2];
    let m, note = "";
    if ((m = /^lui (x\d+), 0x([0-9a-f]+)$/.exec(t))) { known.set(m[1], (parseInt(m[2], 16) << 12) >>> 0); note = r(m[1]) + " = 0x" + known.get(m[1]).toString(16); }
    else if ((m = /^addi (x\d+), (x\d+), (-?\d+)$/.exec(t))) {
      const k = Number(m[3]);
      if (m[2] === "x8") { known.delete(m[1]); note = r(m[1]) + " = s0 " + (k < 0 ? "− " + -k : "+ " + k) + " batches (" + Math.abs(k * periodNs) + " ns " + (k < 0 ? "before" : "after") + " the time base)"; }
      else if (known.has(m[2])) { known.set(m[1], (known.get(m[2]) + k) >>> 0); note = r(m[1]) + " = " + (known.get(m[1]) < 4096 ? known.get(m[1]) : "0x" + known.get(m[1]).toString(16)); }
      else { known.delete(m[1]); note = r(m[1]) + " = " + r(m[2]) + " + " + k; }
    } else if ((m = /^(sw|lw) (x\d+), (-?\d+)\((x\d+)\)$/.exec(t))) {
      const [, op, rd, off, base] = m;
      const where = base === "x18" ? "bit table word " + (Number(off) >> 2) : known.has(base) ? name(known.get(base) + Number(off)) : r(base) + "+" + off;
      note = op === "sw" ? where + " ← " + r(rd) : r(rd) + " ← " + where;
      if (op === "lw") known.delete(rd);
    } else if ((m = /^xori (x\d+), (x\d+), (-?\d+)$/.exec(t))) note = r(m[1]) + " = " + r(m[2]) + " xor " + m[3] + (m[3] === "1" ? " (flip the X bit of a frame word)" : m[3] === "2" ? " (flip the Z bit)" : "");
    else if ((m = /^add (x\d+), (x\d+), (x\d+)$/.exec(t))) { known.delete(m[1]); note = r(m[1]) + " = " + r(m[2]) + " + " + r(m[3]); }
    else if ((m = /^andi (x\d+), (x\d+), (-?\d+)$/.exec(t))) { known.delete(m[1]); note = r(m[1]) + " = " + r(m[2]) + " & " + m[3]; }
    else if ((m = /^(srli|slli) (x\d+), (x\d+), (\d+)$/.exec(t))) { known.delete(m[2]); note = r(m[2]) + " = " + r(m[3]) + (m[1] === "srli" ? " >> " : " << ") + m[4]; }
    else if ((m = /^auipc (x\d+), 0x0$/.exec(t))) { known.delete(m[1]); note = r(m[1]) + " = this instruction's address (the table is placed after the code)"; }
    else if ((m = /^beq (x\d+), x0, (-?\d+)$/.exec(t))) note = "if " + r(m[1]) + " = 0, skip ahead " + m[2] + " bytes";
    else if (/^(beq|bne|blt|bge|bltu|bgeu|jal|jalr)\b/.test(t)) note = "branch";
    else if (/^\.word/.test(t)) note = "data";
    return [...row, note];
  });
}

/** The parity round from source to firmware. */
/**
 * A program from source to firmware on its own generated chip: the calibration loop, the final
 * timetable, every pulse, every core's annotated firmware, and the chip's geometry for the page's
 * machine-level player. spec: { id, title, idea, source, n (data qubits in a row), outcomes }.
 */
async function machineRun({ id, title, idea, source: text, n, outcomes = {} }) {
  const source = qsysasm.parse(text);
  // The OS's calibration loop (riscq/os/schedule.mjs calibrate) with this chip as the runner.
  const cal = await calibrate({ ...source, machine: { ...PROVISIONAL, qubits: 16, max_parallel_gates: 16 } }, (listing) => runOnChip(listing, n, outcomes),
    { title: title + ", scheduled by the OS" });
  if (!cal.conforms) throw Error(id + ": " + cal.reason);
  const iterations = cal.iterations;
  const s = cal.schedule, run = cal.result;
  // Cores, and the transmon each drives.
  const siteKey = new Map([...run.placement.assignment].map(([k, s]) => [s, k]));
  const coreOf = new Map(run.m.spec.cores.map((c, i) => [c.name, i]));
  const cores = run.m.spec.cores.map((c, i) => ({ name: c.name, board: c.board ?? 0, channels: c.channels.map((ch) => ch.name), role: c.name.startsWith("dec") || c.name === "decoder" ? (i === run.m.decoderCore ? "frame and decoder" : "decoder") : "control" }));
  run.design.qubits.forEach((q, k) => {
    const core = coreOf.get(run.design.channels.find((c) => c.id === q.gate)?.core);
    if (core !== undefined) cores[core].drives = run.placement.sites[k]?.address ?? siteKey.get(k) ?? run.placement.sites[k]?.id;
  });
  // Native instructions per statement (origin: hardware id → statement uid).
  const natives = run.hardware.segments.flatMap((seg) => seg.ops).map((o) => ({ id: o.id, uid: run.origin.get(o.id), op: o.op ?? o.kind, name: o.name ?? o.gate ?? o.op, qubits: o.qubits ?? o.targets ?? [], t: Math.round(o.t / 1000), dur: Math.round(o.dur / 1000) }));
  // Every pulse the trace shows, in ns of the program's clock.
  const pulses = run.result.summary.pulses.map((p) => ({ core: run.m.spec.cores[p.core].name, channel: run.m.spec.cores[p.core].channels[p.channel]?.name, converter: p.converter,
    opens: nsOfBatch(run, p.opens), closes: nsOfBatch(run, p.closes), uid: run.origin.get(p.source), onTime: p.onTime }));
  // Bits stored to the host window: when each measured bit was in a core's memory.
  const stores = (run.result.summary.host ?? []).map((w) => ({ core: run.m.spec.cores[w.core].name, atNs: nsOfBatch(run, w.atBatch), value: w.value }));
  // Firmware: every core's image again (deterministic), disassembled, with the statement each run of
  // instructions implements (the assembler's source map).
  const firmware = run.built.plans.map((plan, i) => {
    const image = compileCore(run.m.spec, i, plan);
    const sources = image.sourceMap;
    const label = (pc) => { let s = ""; for (const e of sources) { if (e.pc > pc) break; s = e.source; } return s; };
    const rows = image.words.map((w, k) => [k * 4, (w >>> 0).toString(16).padStart(8, "0"), disassemble(w).text, label(k * 4)]);
    return { core: run.m.spec.cores[i].name, words: image.words.length, rows };
  });
  const sourceOf = (label) => /^h\d+$/.test(label) ? run.origin.get(label) : null;
  for (const f of firmware) { for (const r of f.rows) { const uid = sourceOf(r[3]); r[4] = uid ?? null; } f.rows = annotate(f.rows, run.m.spec.cores.find((c) => c.name === f.core), PERIOD_NS(run.m)); }
  // The issue table at the end of a control core's image (riscq/firmware.mjs compileCore, "plain"
  // segments): four words per register write, [issue batch, start batch, register address, data],
  // both batches relative to the segment's time base s0. The issue loop waits until s0 + issue,
  // stores s0 + start to the channel's start-time register, then stores the data.
  const REG = (offset) => offset === MAP.RF_FIRE ? "fire" : offset === MAP.RF_FREQ ? "freq" : offset === MAP.RF_DC_OFFSET ? "dc_offset" : offset === MAP.RF_PHASE_OFFSET ? "phase_offset"
    : "slot" + (Math.floor(offset / MAP.RF_SLOT_STRIDE) - 1) + "." + ["phase", "amp", "env", "dur"][(offset % MAP.RF_SLOT_STRIDE) / 4];
  for (const f of firmware) {
    let last = -1;
    f.rows.forEach((r, k) => { if (!/^h\d+$/.test(r[3])) last = k; });
    const data = f.rows.slice(last + 1);
    f.codeWords = last + 1;
    f.table = [];
    const core = run.m.spec.cores.find((c) => c.name === f.core);
    for (let k = 0; k + 3 < data.length; k += 4) {
      const [issue, start, addr, value] = data.slice(k, k + 4).map((r) => parseInt(r[1], 16) >>> 0);
      const channel = Math.floor((addr - MAP.PUT_WINDOW) / MAP.RF_CH_STRIDE), offset = (addr - MAP.PUT_WINDOW) % MAP.RF_CH_STRIDE;
      f.table.push({ issueNs: issue * PERIOD_NS(run.m), startNs: start * PERIOD_NS(run.m), channel: core?.channels[channel]?.name ?? channel, register: REG(offset), value, uid: data[k][4] });
    }
  }
  // Couplers (site pairs), and the coupler each core's flux channel drives.
  const couplers = (run.design.couplings ?? []).map((c) => c.qubits);
  const couplerOf = {};
  (run.design.couplings ?? []).forEach((c, k) => { for (const p of c.pulses ?? []) couplerOf[p.channel] = k; });
  for (const p of pulses) { const k = couplerOf[p.core + "." + p.channel]; if (k !== undefined) p.coupler = k; }
  return {
    id, title, idea, source: text, provisional: PROVISIONAL, edges: s.edges, iterations, outcomes,
    final: {
      text: s.text, makespanNs: s.makespanNs, conforms: run.report.conforms, machineLine: qsysasm.machineLine(iterations.at(-1).machine),
      statements: s.ops.map((o) => ({ uid: o.uid, kind: o.kind, line: o.line, text: o.text, start: o.start, end: o.end, qubits: o.qubits.map(key) })),
      rows: iterations.at(-1).rows, decodes: run.decodes, cores, natives, pulses, stores, firmware,
      periodNs: PERIOD_NS(run.m), couplers,
      // The 3D twin's track (riscq/ftqvm/track.mjs): the chip, its control system, and every operation and pulse of this run.
      track: run.report.track,
      sites: run.placement.sites.map((x, k) => ({ id: x.id, kind: x.kind, rc: x.rc, address: x.address ?? siteKey.get(k) ?? null })),
    },
  };
}

// The programs the page's machine-level player replays.
const MACHINE_RUNS = [
  { id: "parity", title: "One parity round of the 3-qubit bit-flip code", n: 3, outcomes: { "s[0]": 1 }, source: ROUND_SOURCE,
    idea: "Two parity checks, a decode on the decoder core and a frame update on the frame core: every kind of system call a round needs." },
  { id: "ghz4", title: "A 4-qubit GHZ state", n: 4, outcomes: { "c[0]": 1, "c[1]": 1, "c[2]": 1, "c[3]": 1 },
    idea: "A chain of CNOTs is the critical path; the four measurements then run in parallel, each on its own core.",
    source: `# A 4-qubit GHZ state: H, a chain of CNOTs, every qubit measured.
H  data[0]
CNOT  data[0], data[1]
CNOT  data[1], data[2]
CNOT  data[2], data[3]
measure  basis=Z  data[0] -> c[0]
measure  basis=Z  data[1] -> c[1]
measure  basis=Z  data[2] -> c[2]
measure  basis=Z  data[3] -> c[3]
` },
  { id: "memory2", title: "Two rounds of the 3-qubit memory", n: 3, outcomes: { "s[1]": 1, "s[3]": 1 },
    idea: "Ancillas are requested, measured and released every round; the second round's ancillas reuse the first round's transmons, and one decode reads both rounds.",
    source: `# Two rounds of the bit-flip code; each round takes fresh ancillas and returns them.
request_ancilla  count=2  ancilla[0:1]
CNOT  data[0], ancilla[0]
CNOT  data[1], ancilla[0]
CNOT  data[1], ancilla[1]
CNOT  data[2], ancilla[1]
measure  basis=Z  ancilla[0] -> s[0]
measure  basis=Z  ancilla[1] -> s[1]
release_ancilla  count=2  ancilla[0:1]
request_ancilla  count=2  ancilla[2:3]
CNOT  data[0], ancilla[2]
CNOT  data[1], ancilla[2]
CNOT  data[1], ancilla[3]
CNOT  data[2], ancilla[3]
measure  basis=Z  ancilla[2] -> s[2]
measure  basis=Z  ancilla[3] -> s[3]
release_ancilla  count=2  ancilla[2:3]
s[0:3] -> decode_syndrome  rounds=2
s[0:3] -> pauli_frame_update  X data[0:2]
` },
];
const round = () => machineRun(MACHINE_RUNS[0]);

/**
 * decode_syndrome as a decoder core runs it: the walk-through's two syndrome bits decoded by the
 * lookup decoder of the controller firmware (riscq/firmware.mjs `decode`) on RISC-Q's transmon
 * ring with a decoder core, its firmware disassembled and its timing read from the trace.
 */
async function lookupDecoder() {
  const { run } = await import("../examples.mjs");
  const { decodeSamples } = await import("../syscalls.mjs");
  const superconducting = await import("../platforms/superconducting.mjs");
  const { assemble } = await import("../compile.mjs");
  // The bit-flip code's table: syndrome s0 + 2·s1 → which data qubit to flip (bit k of the entry: data[k]).
  const calls = { kind: "system-calls", version: 1, calls: [
    { call: "measure", qubit: 1, bit: "s0" }, { call: "measure", qubit: 3, bit: "s1" },
    { call: "decode_syndrome", bits: ["s0", "s1"], lut: [0b000, 0b001, 0b100, 0b010], into: ["e0", "e1", "e2"] },
    { call: "pauli_frame_update", when: "e0", pauli: "X", qubit: 0 }] };
  const outcomes = { s0: 1, s1: 0 };
  const result = await run({ platform: "superconducting", calls, outcomes });
  const [sample] = decodeSamples(result);
  // The decoder core's image, compiled again from the same plan (deterministic).
  const m = superconducting.machine({ decoder: true });
  const lowered = superconducting.lower(superconducting.scheduleCalls(calls, m), m);
  const built = assemble(m.spec, lowered, { bindings: m.bindings, readouts: superconducting.readoutOracle(lowered, m, outcomes) });
  const image = compileCore(m.spec, m.decoderCore, built.plans[m.decoderCore]);
  const label = (pc) => { let s = ""; for (const e of image.sourceMap) { if (e.pc > pc) break; s = e.source; } return s; };
  const rows = annotate(image.words.map((w, k) => [k * 4, (w >>> 0).toString(16).padStart(8, "0"), disassemble(w).text, label(k * 4), null]), m.spec.cores[m.decoderCore], m.period / 1000);
  return { calls, outcomes, sample, decoded: result.derived.bits, core: m.spec.cores[m.decoderCore].name, rows,
    note: "Times are from the close of the later measurement window, in the run of RISC-Q's transmon ring at 500 MHz (riscq/syscalls.mjs decodeSamples)." };
}

// ---------------------------------------------------------------------------------------------
// The scheduling problem on small programs, with the same executor (riscq/os/des.mjs).
const M = (fields) => ({ ...PROVISIONAL, gate1q_ns: 40, gate2q_ns: 200, measure_ns: 1000, reset_ns: 160, decoder_latency_ns: 400, ...fields });
const listingOf = (text, machine) => {
  const p = qsysasm.withDurations({ ...qsysasm.parse(text), machine });
  return { machine, ops: p.ops.map((o, i) => ({ ...o, uid: i, order: i, start: o.start ?? 0, end: (o.start ?? 0) + o.duration, qubits: [...o.qubits, ...o.work] })) };
};
const summary = (sim) => ({ makespanNs: sim.makespanNs, completed: sim.completed, total: sim.total, deadlock: sim.deadlock, starved: sim.starved,
  ops: sim.ops.map((o) => ({ uid: o.uid, kind: o.kind, start: o.start, end: o.end, waitNs: o.waitNs, waitedFor: o.waitedFor, bypassed: o.bypassed })),
  pools: Object.fromEntries(Object.entries(sim.pools).map(([k, p]) => [k, { capacity: p.capacity, peak: p.peak, utilization: +p.utilization.toFixed(3) }])) });

/** How far list scheduling is from the optimum: every priority order of a small program. */
function hardness() {
  // Three independent checks share one gate slot and one decoder. A short check, a long one.
  const text = `# Two checks share one gate slot (max_parallel_gates: 1) and one decoder.
# The weight-3 check is written first, the weight-1 check second.
CNOT data[1], ancilla[1]
CNOT data[2], ancilla[1]
CNOT data[3], ancilla[1]
measure basis=Z ancilla[1] -> s[1]
s[1] -> decode_syndrome rounds=1
CNOT data[0], ancilla[0]
measure basis=Z ancilla[0] -> s[0]
s[0] -> decode_syndrome rounds=1
`;
  const machine = M({ max_parallel_gates: 1, decoders: 1, measure_ns: 600, decoder_latency_ns: 900 });
  const base = listingOf(text, machine);
  const n = base.ops.length;
  const perms = [];
  const permute = (a, k) => { if (k === a.length) { perms.push([...a]); return; } for (let i = k; i < a.length; i++) { [a[k], a[i]] = [a[i], a[k]]; permute(a, k + 1); [a[k], a[i]] = [a[i], a[k]]; } };
  permute([...Array(n).keys()], 0);
  const makespans = new Map();
  let best = null, worst = null;
  for (const p of perms) {
    const ops = base.ops.map((o, i) => ({ ...o, priority: p[i] }));
    const sim = simulate({ ops }, { model: machineModel(machine), mode: "dependency", policy: "priority", strict: true });
    const ms = sim.makespanNs;
    makespans.set(ms, (makespans.get(ms) ?? 0) + 1);
    if (!best || ms < best.ms) best = { ms, order: p, sim };
    if (!worst || ms > worst.ms) worst = { ms, order: p, sim };
  }
  const inOrder = simulate({ ops: base.ops }, { model: machineModel(machine), mode: "dependency", policy: "order", strict: true });
  const greedy = simulate({ ops: base.ops }, { model: machineModel(machine), mode: "dependency", policy: "fifo" });
  return { text, machineLine: qsysasm.machineLine(machine), orders: perms.length, statements: n,
    distribution: [...makespans].sort((a, b) => a[0] - b[0]).map(([ms, count]) => ({ makespanNs: ms, orders: count })),
    best: { makespanNs: best.ms, priority: best.order, ...summary(best.sim) }, worst: { makespanNs: worst.ms, ...summary(worst.sim) },
    programOrder: summary(inOrder), greedy: summary(greedy) };
}

/** Hold-and-wait: two tenants each take one ancilla, then wait for a second the other holds. */
function deadlock() {
  const text = `# Two tenants share a pool of 2 ancilla qubits (qubits: 2 total). Each was compiled
# alone, against the whole machine, so each timetable is valid by itself.
# Tenant A
@0 ns     request_ancilla count=1 ancilla[0]
@160 ns   H ancilla[0]
@200 ns   request_ancilla count=1 ancilla[1]
@360 ns   CNOT ancilla[0], ancilla[1]
@560 ns   measure basis=Z ancilla[1] -> a[0]
@1560 ns  release_ancilla count=2 ancilla[0:1]
# Tenant B
@0 ns     request_ancilla count=1 ancilla[2]
@160 ns   H ancilla[2]
@200 ns   request_ancilla count=1 ancilla[3]
@360 ns   CNOT ancilla[2], ancilla[3]
@560 ns   measure basis=Z ancilla[3] -> b[0]
@1560 ns  release_ancilla count=2 ancilla[2:3]
`;
  const machine = M({ qubits: 2, ancilla_bandwidth: 64 });
  const l = listingOf(text, machine);
  const model = machineModel(machine);
  const greedy = simulate(l, { model, mode: "triggered", policy: "fifo" });
  // Who holds what when it stops: requests that started and whose release has not.
  const released = new Set(greedy.ops.filter((o) => o.kind === "release_ancilla" && o.start !== null).flatMap((o) => l.ops[o.uid].qubits.map(key)));
  const holds = greedy.ops.filter((o) => o.kind === "request_ancilla" && o.start !== null).map((o) => ({ uid: o.uid, line: l.ops[o.uid].line, qubits: l.ops[o.uid].qubits.map(key).filter((q) => !released.has(q)) })).filter((h) => h.qubits.length);
  return { text, machineLine: qsysasm.machineLine(machine), holds,
    note: "Run together as the timetables say (each statement no earlier than its time, later if a service is busy).",
    greedy: summary(greedy),
    ordered: summary(simulate(l, { model, mode: "triggered", policy: "fifo", orderedPools: ["qubits"] })) };
}

/** Starvation: a request for the whole pool waits while small requests keep slipping past it. */
function starvation() {
  // Three small tenants each hold one ancilla for 1.2 µs of every 1.3 µs, staggered by 430 ns, so at
  // any moment at least one of them holds a qubit. The big tenant needs the whole pool at 100 ns.
  const lines = ["# A pool of 4 ancilla qubits (qubits: 4 total). Tenant L needs all 4 at once;",
    "# tenants S0, S1, S2 need 1 each, again and again. Every timetable is valid alone.",
    "# Tenant L", "@100 ns   request_ancilla count=4 ancilla[0:3]", "@260 ns   measure basis=Z ancilla[0] -> big[0]", "@1260 ns  release_ancilla count=4 ancilla[0:3]"];
  let a = 4, r = 0;
  for (let t = 0; t < 3; t++) {
    lines.push("# Tenant S" + t);
    for (let rep = 0; rep < 4; rep++, a++, r++) {
      const at = rep * 1300 + t * 430;
      lines.push(`@${at} ns  request_ancilla count=1 ancilla[${a}]`, `@${at + 160} ns  H ancilla[${a}]`, `@${at + 200} ns  measure basis=Z ancilla[${a}] -> small[${r}]`, `@${at + 1200} ns  release_ancilla count=1 ancilla[${a}]`);
    }
  }
  const text = lines.join("\n").replace(/@(\d+) ns  (?=\S)/g, (m, t) => ("@" + t + " ns").padEnd(11)) + "\n";
  const machine = M({ qubits: 4, ancilla_bandwidth: 64, measure_ns: 1000 });
  const l = listingOf(text, machine);
  const model = machineModel(machine);
  return { text, machineLine: qsysasm.machineLine(machine), note: "Run together as the timetables say: a statement starts no earlier than its time, later if its service is busy. A request that could not start while later ones did counts as bypassed.",
    backfill: summary(simulate(l, { model, mode: "triggered", policy: "fifo", starvationBypass: 3 })),
    // Reservation: the qubit pool is granted in program order, so L, written first, is served
    // as soon as the qubits held before it are returned; the others' work goes on meanwhile.
    ordered: summary(simulate(l, { model, mode: "triggered", policy: "fifo", orderedPools: ["qubits"], starvationBypass: 3 })),
    // Strict order for every statement: nothing may pass a waiting one, not even the gates and
    // releases of the tenants that hold the qubits L waits for. Head-of-line blocking.
    strict: summary(simulate(l, { model, mode: "triggered", policy: "fifo", strict: true, starvationBypass: 3 })) };
}

/** A decoder that cannot keep pace: rounds every T, one decode per round, latency D > T. */
function backlog() {
  const rounds = 8, lines = ["# One syndrome bit per round, measured every round; each round's syndrome is decoded."];
  for (let k = 0; k < rounds; k++) lines.push(`measure basis=Z ancilla[0] -> s[${k}]`, `s[${k}] -> decode_syndrome rounds=1`);
  const text = lines.join("\n") + "\n";
  const out = {};
  for (const decoders of [1, 2]) {
    const machine = M({ decoders, measure_ns: 1000, decoder_latency_ns: 1600 });
    const l = listingOf(text, machine);
    const sim = simulate(l, { model: machineModel(machine), mode: "dependency", policy: "fifo" });
    out["decoders" + decoders] = { machineLine: qsysasm.machineLine(machine), ...summary(sim),
      lag: sim.ops.filter((o) => o.kind === "decode_syndrome").map((o, k) => ({ round: k, syndromeAtNs: sim.ops[2 * k].end, decodedAtNs: o.end, lagNs: o.end - sim.ops[2 * k].end })) };
  }
  return { text, rounds, ...out };
}

// ---------------------------------------------------------------------------------------------
// Calibration: each system call alone and k at a time, on the chip, in the cycle-exact model.

/** k concurrent statements of one kind at t = 0 (after their ancillas are ready). */
function benchProgram(kind, k) {
  const L = [];
  const idx = (i) => `data[${i}]`;
  if (kind === "request_ancilla") for (let i = 0; i < k; i++) L.push(`@0 ns  request_ancilla count=1 ancilla[${i}]`, `@1000 ns  release_ancilla count=1 ancilla[${i}]`);
  if (kind === "H") for (let i = 0; i < k; i++) L.push(`@0 ns  H ${idx(i)}`);
  if (kind === "CNOT") for (let i = 0; i < k; i++) L.push(`@0 ns  CNOT ${idx(2 * i)}, ${idx(2 * i + 1)}`);
  if (kind === "measure") for (let i = 0; i < k; i++) L.push(`@0 ns  measure basis=Z ${idx(i)} -> c[${i}]`);
  if (kind === "decode_syndrome") {
    for (let i = 0; i < k; i++) L.push(`@0 ns  measure basis=Z ${idx(2 * i)} -> s[${2 * i}]`, `@0 ns  measure basis=Z ${idx(2 * i + 1)} -> s[${2 * i + 1}]`);
    for (let i = 0; i < k; i++) L.push(`@3000 ns  s[${2 * i}:${2 * i + 1}] -> decode_syndrome rounds=1`);
  }
  if (kind === "pauli_frame_update") {
    for (let i = 0; i < k; i++) L.push(`@0 ns  measure basis=Z ${idx(i)} -> c[${i}]`);
    for (let i = 0; i < k; i++) L.push(`@3000 ns  c[${i}] -> pauli_frame_update X ${idx(i)}`);
  }
  return [...ANCHORS, ...L].join("\n") + "\n";
}
const BENCH = { request_ancilla: [1, 2, 4], H: [1, 2, 4, 8], CNOT: [1, 2, 4], measure: [1, 2, 4, 8], decode_syndrome: [1, 2, 4], pauli_frame_update: [1, 2, 4, 8] };
// Eight transmons for the statements under test, three more for reference pulses: three H at 0 ns
// on data[8:10] fix the run's time origin, which the conformance check takes as the offset most
// pulses share (riscq/ftqvm/sc-run.mjs); with one or two pulses that choice can be a tie.
const BENCH_CHIP = 11;
const ANCHORS = ["@0 ns  H data[8]", "@0 ns  H data[9]", "@0 ns  H data[10]"];

async function microbenchmarks() {
  const out = [];
  for (const [kind, ks] of Object.entries(BENCH))
    for (const k of ks) {
      const text = benchProgram(kind, k);
      const p = qsysasm.withDurations({ ...qsysasm.parse(text), machine: { ...PROVISIONAL, decoder_latency_ns: 400, measure_ns: 2000, gate2q_ns: 600, gate1q_ns: 100, reset_ns: 400, pauli_frame_update_ns: 200 } });
      const ops = p.ops.map((o, i) => ({ ...o, uid: i, order: i }));
      // Every benchmark runs on the same chip: eight transmons in a row, each with its own core.
      const run = await runOnChip({ ops }, BENCH_CHIP, {});
      const rows = run.report.rows.filter((r) => r.kind === kind);
      // Latency: from the statement's start to its last hardware effect (a measurement: its bit at the core).
      const lat = rows.map((r) => Math.max((r.hardwareNs?.[1] ?? r.start) - r.start, r.bitNs !== undefined ? r.bitNs - r.start : 0));
      const span = Math.max(...rows.map((r, i) => r.start + lat[i])) - Math.min(...rows.map((r) => r.start));
      out.push({ kind, k, text, latencyNs: { min: Math.min(...lat), max: Math.max(...lat) }, spanNs: span, ratePerUs: +((1000 * k) / span).toFixed(2),
        decodes: kind === "decode_syndrome" ? run.decodes.map((d) => ({ uid: d.uid, doneNs: d.doneNs, jobs: d.jobs.map((j) => ({ readyNs: j.readyNs, startNs: j.startNs, endNs: j.endNs, computeNs: j.computeNs, core: j.core })) })) : undefined,
        bits: kind === "measure" || kind === "decode_syndrome" ? rows.map((r) => r.bitNs).filter((x) => x !== undefined) : undefined });
      console.log("bench", kind, "k=" + k, "latency", lat.join("/"), "span", span);
    }
  return out;
}

/** The corpus-wide calibration of the Examples studies (validation/calib/site), summarized. */
function corpus() {
  const read = (id) => {
    const f = new URL("../../validation/calib/site/" + id + ".json", import.meta.url);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  };
  const sc = read("system-calls");
  const needed = sc?.sections?.find((s) => /Needed against declared/.test(s.heading))?.table;
  return { systemCalls: needed ? { head: needed.head, rows: needed.rows } : null, studies: ["fabric", "decoder", "system-calls", "factories", "decoder-backlog", "deadlock"].filter((id) => read(id)).map((id) => ({ id, title: read(id).title, summary: read(id).summary })) };
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const t0 = Date.now();
  const runs = [];
  for (const spec of MACHINE_RUNS) runs.push(await machineRun(spec));
  // `round` is the walk-through (§ 3); `machineRuns` the other programs of the machine-level player.
  const data = { generated: new Date().toISOString(), round: runs[0], machineRuns: runs.slice(1), decoder: await lookupDecoder() };
  console.log("round: iterations", data.round.iterations.length, "conforms", data.round.final.conforms, "makespan", data.round.final.makespanNs);
  data.problems = { hardness: hardness(), deadlock: deadlock(), starvation: starvation(), backlog: backlog() };
  console.log("problems: orders", data.problems.hardness.orders, "best", data.problems.hardness.best.makespanNs, "program order", data.problems.hardness.programOrder.makespanNs,
    "| deadlock", !!data.problems.deadlock.greedy.deadlock, "ordered completes", data.problems.deadlock.ordered.completed, "| starved", data.problems.starvation.backfill.starved.length);
  data.calibration = { microbenchmarks: await microbenchmarks(), corpus: corpus() };
  data.seconds = (Date.now() - t0) / 1000;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL("schedule.json", OUT), JSON.stringify(data) + "\n");
  console.log("wrote validation/os/schedule.json in", data.seconds, "s");
}

export { dependencies };
