// Logical programs scheduled by the operating system and run on hardware designs.
//
// A program (riscq/os/programs.mjs, flat QSysASM without times) is given to the operating system
// with a provisional machine line. The OS schedules it (riscq/os/schedule.mjs), the timetable is
// placed on a hardware design, compiled to RISC-Q firmware and run in the cycle-exact Lean model
// (the platform runners of riscq/ftqvm/platforms.mjs), and every latency the hardware needed beyond
// what the OS was told is raised; the loop (schedule.mjs calibrate) repeats until the run conforms.
// The result is the program as the OS runs it on that machine: its timetable, what the OS had to
// learn about the hardware, and the run with every pulse, move, readout and decode (its 3D track).
//
//   node riscq/os/program-runs.mjs [program] [design]
import { parse } from "../ftqvm/qsysasm.mjs";
import { calibrate, schedule } from "./schedule.mjs";
import { programText, PROGRAMS, D, STABILIZERS } from "./programs.mjs";
import { transmon, optical } from "../ftqvm/platforms.mjs";
import { DESIGNS } from "../ftqvm/corpus.mjs";

const ADAPTERS = { superconducting: transmon, neutral: (o) => optical(o.id), qccd: (o) => optical(o.id) };
export const platformOf = (design) => Object.entries(DESIGNS).find(([, ds]) => ds.some((d) => d.id === design))[0];

/**
 * A runner for calibrate(): place the timed listing on the design, build it, run it cycle-exact.
 * `machine` ({ adapter, title }) runs on a given machine instead of a corpus design (riscq/hw/compile.mjs).
 */
function runnerFor(design, machine) {
  const point = machine ? { title: machine.title } : Object.values(DESIGNS).flat().find((d) => d.id === design);
  const adapter = machine ? machine.adapter : ADAPTERS[platformOf(design)](point.options);
  return {
    adapter, point,
    async run(listing) {
      // In time order, as the timetable's text lists it: the twin gives each operation its channel
      // first-fit in listing order, which needs no more channels than are in use at once only
      // when the operations come in order of their starts (in program order a measurement can
      // find all 16 readout channels taken although at most 12 are busy at its time).
      const ops = listing.ops.map((o, i) => ({ work: [], reads: [], writes: [], inputNs: null, ...o, uid: o.uid ?? i, order: o.order ?? i }))
        .sort((a, b) => a.start - b.start || a.order - b.order);
      const l = { ops, calls: [] };
      const placement = adapter.place(l, { distance: D });
      const hw = adapter.design(l, placement);
      const r = await adapter.run(l, placement, hw, { outcomes: {}, distance: D });
      // A measurement holds its readout channel until the channel is free again, which on an
      // optical design is a little after its bit is stored: that is hardware time the OS has to
      // give it, or the next measurement on the channel finds it busy.
      for (const row of r.report.rows)
        if (row.channelNs !== undefined && row.hardwareNs && row.channelNs > row.hardwareNs[1]) {
          row.hardwareNs = [row.hardwareNs[0], row.channelNs];
          if (row.channelNs > row.end + 1e-6) { row.ok = false; row.channelHeld = true; r.report.conforms = false; }
        }
      return { ...r, placement, design: hw };
    },
  };
}

/**
 * One program on one design. Returns { program, design, platform, conforms, iterations (what the OS
 * was told, its makespan, whether the run conformed, what it raised), machine (what it learned),
 * timetable (the final QSysASM text), report, track }.
 */
export async function programRun(programId, design, { policy = "fifo", orderedPools = ["qubits"], maxIterations = 8, countReadouts = true, machine } = {}) {
  const platform = machine?.platform ?? platformOf(design);
  const parsed = parse(programText(programId, platform));
  const { run, point, adapter } = runnerFor(design, machine);
  const t0 = Date.now();
  // The OS first reads the machine's inventory: every capacity field is counted from the hardware
  // design (its beams, movers, decoders, readout channels, hub), as the platform states it
  // (riscq/ftqvm/platforms.mjs capacities). Only latencies are then learned from runs.
  const first = schedule(parsed, { policy, orderedPools });
  const firstOps = (first.text ? first.ops : parsed.ops.map((o, i) => ({ ...o, start: 0, end: o.duration ?? 0, uid: i, order: i }))).map((o, i) => ({ work: [], reads: [], writes: [], inputNs: null, ...o, uid: o.uid ?? i, order: o.order ?? i }));
  const l0 = { ops: firstOps, calls: [] }, p0 = adapter.place(l0, { distance: D }), d0 = adapter.design(l0, p0);
  const durations = Object.fromEntries(Object.entries(parsed.machine).filter(([k]) => /_ns$/.test(k)).map(([k, v]) => [k, { value: v }]));
  const counted = Object.fromEntries(Object.entries(adapter.capacities(d0, p0, durations)).map(([k, v]) => [k, v.value]));
  // The interface has no field for readout concurrency; an optical design has a fixed number of
  // readout channels (imaging or detection), so the OS also counts them (des.mjs `readout_channels`).
  if (countReadouts && d0.readouts !== undefined) counted.readout_channels = d0.readouts;
  // An optical design's factory region measures its checks with the device's beams and readout
  // channels (riscq/ftqvm/optical.mjs request_magic): one of each per check of its patch at once.
  if (countReadouts && d0.kind === "optical-design") counted.factory_gates = counted.factory_readouts = STABILIZERS.length;
  const program = { ...parsed, machine: { ...parsed.machine, ...counted } };
  const c = await calibrate(program, run, { maxIterations, policy, gridNs: platform === "superconducting" ? 2 : 10, title: programId + " on " + design, scheduleOptions: { orderedPools } });
  const report = c.result?.report;
  return {
    program: programId, design, platform, designTitle: point.title, conforms: c.conforms, reason: c.reason ?? null,
    told: parsed.machine, counted, learned: c.machine,
    iterations: c.iterations.map((it) => ({ makespanNs: it.makespanNs, conforms: it.conforms, raise: it.raise, late: it.rows.filter((r) => r.ok === false).length, ops: it.rows.length })),
    timetable: c.schedule?.text ?? null, makespanNs: c.schedule?.makespanNs ?? null,
    report: report && { conforms: report.conforms, byKind: report.byKind }, track: report?.track ?? null,
    lateRows: report ? report.rows.filter((r) => r.ok === false).slice(0, 12).map((r) => ({ kind: r.kind, line: r.line, start: r.start, end: r.end, hardwareNs: r.hardwareNs, bitNs: r.bitNs })) : [],
    statements: parsed.ops.length, endNs: report ? Math.max(...report.rows.map((r) => r.hardwareNs?.[1] ?? r.end ?? 0)) : null,
    late: report ? report.rows.filter((r) => r.ok === false).length : null, rows: report?.rows.length ?? 0,
    seconds: (Date.now() - t0) / 1000,
  };
}

const FIELD_WORD = { gate1q_ns: "one-qubit gate", gate2q_ns: "two-qubit gate", measure_ns: "measurement", reset_ns: "reset", route_latency_ns: "route",
  decoder_latency_ns: "decode", magic_state_latency_ns: "magic state", pauli_frame_update_ns: "frame update" };
const ns = (x) => (x >= 10000 ? (x / 1000).toLocaleString("en", { maximumFractionDigits: 1 }) + " µs" : x + " ns");

/**
 * One OS run as an Examples row (studio/examples, the design page): { label, conforms, byKind, track,
 * columns, failures, program (the timetable the OS ran), formKey (the form values it answers) }.
 * params: { program, design, policy, ordered ("on" | "off"), readouts ("counted" | "not counted") }.
 */
export async function programRow({ program = "bell", design = "sc-B", policy = "fifo", ordered = "on", readouts = "counted", label, machine } = {}) {
  const r = await programRun(program, design, { policy, orderedPools: ordered === "on" ? ["qubits"] : [], countReadouts: readouts === "counted", machine });
  const p = PROGRAMS.find((x) => x.id === program);
  const learned = Object.entries(r.learned).filter(([k, v]) => /_ns$/.test(k) && v !== r.told[k]).map(([k, v]) => FIELD_WORD[k] + " " + ns(r.told[k]) + " → " + ns(v));
  const c = r.counted;
  return {
    label: label ?? p.title + " · " + (design ?? r.designTitle), conforms: r.conforms, byKind: r.report?.byKind ?? {}, track: r.track, program: r.timetable,
    formKey: { program, design, policy, ordered, readouts },
    columns: {
      Program: p.title + " (" + r.statements + " statements, no times)",
      Design: design ? design + " (" + r.designTitle + ")" : r.designTitle,
      "Operating system": "scheduler policy " + policy + (ordered === "on" ? ", ancillas acquired in program order" : ", greedy acquisition"),
      "Capacities counted on the design": "gates " + c.max_parallel_gates + " · decoders " + c.decoders + " · factories " + c.factories + " · qubits " + c.qubits + (c.readout_channels !== undefined ? " · readout channels " + c.readout_channels : r.platform === "superconducting" ? " · a readout channel per transmon" : " · readout channels not counted") + (c.factory_gates ? " · a factory borrows " + c.factory_gates + " beams and " + c.factory_readouts + " readout channels" : ""),
      "Runs until it conforms": r.iterations.map((it, i) => "run " + (i + 1) + ": " + (it.conforms ? "conforms" : it.late + " of " + it.ops + " late") + ", " + (it.makespanNs / 1000).toFixed(1) + " µs").join("; "),
      "What the OS learned": learned.join("; ") || "nothing: every declared latency held",
      Result: r.conforms ? "conforms" : r.reason,
      "Machine time on the hardware (µs)": r.endNs !== null ? (r.endNs / 1000).toFixed(1) : "–",
      "Control cores / boards": r.track?.controller ? r.track.controller.cores.length + " / " + (r.track.controller.boards?.length ?? 1) : "–",
    },
    failures: r.lateRows.map((f) => ({ ...f, reason: f.bitNs === undefined && f.kind === "measure" ? "no bit: the design had no free readout channel" : "ran past its window" })),
  };
}

export const ALL_DESIGNS = ["sc-A", "sc-B", "atoms-moving", "atoms-static", "ions-qccd", "ions-modules"];

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const [only, onlyDesign] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const out = new URL("../../validation/calib/programs/", import.meta.url);
  mkdirSync(out, { recursive: true });
  for (const p of PROGRAMS.filter((x) => !only || x.id === only))
    for (const design of (onlyDesign ? [onlyDesign] : ALL_DESIGNS)) {
      let r;
      try {
        r = await programRun(p.id, design);
        console.log(p.id.padEnd(13), design.padEnd(13), r.conforms ? "CONFORMS" : "does not conform (" + r.reason + ")", "| iterations", r.iterations.length, "| makespan", (r.makespanNs / 1000).toFixed(1), "µs | raised", JSON.stringify(Object.assign({}, ...r.iterations.map((i) => i.raise))), "|", r.seconds + " s");
      } catch (error) {
        r = { program: p.id, design, error: error.message.slice(0, 2000) };
        console.log(p.id.padEnd(13), design.padEnd(13), "ERROR", error.message.slice(0, 300));
      }
      // Without its 3D track (the Examples rebuild it: riscq/calib/site.mjs).
      writeFileSync(new URL(p.id + "." + design + ".json", out), JSON.stringify({ ...r, track: undefined }) + "\n");
    }
}
