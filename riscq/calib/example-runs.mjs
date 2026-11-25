// The runs behind the Examples pages (/examples): a program of the corpus on one of the six designs,
// executed either as the compiler's timetable or as the runtime simulator's schedule, on the cycle-exact
// model, with its 3D track. The same function serves the stored runs of each page (written by
// riscq/calib/site.mjs) and the reruns of its design page (/examples/<id>/design, POST
// /api/reproduce/run), so a person and a headless script get the same result.
//
// A run is:
//   program, design      a compiled listing of the corpus (validation/calib/site/runs/<program>.<design>.json,
//                        the compiler's own expansion as admitted by the resource VM; written from the in-situ runs)
//   execution            "timetable": the listing as compiled (every op at its listed start);
//                        "greedy" | "strict" | "ordered": the runtime simulator (riscq/os/des.mjs) runs it
//                        dependency-driven with that policy, and its schedule is written back as a
//                        timetable; a schedule that deadlocks is shown as the simulator ran it, up to
//                        the deadlock
//   decoders, factories, ancillas (%)   the runtime's pools (the derived machine's by default)
//   windows              "spec": the listing's own durations; "max" | "p99" | "p50": every operation is
//                        judged against the number fitted on the other programs of the corpus on the
//                        same design (riscq/calib/methods.mjs), keeping the timetable
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { simulate, machineModel } from "../os/des.mjs";
import { buildTrack } from "../ftqvm/track.mjs";
import { transmon, optical } from "../ftqvm/platforms.mjs";
import { DESIGNS } from "../ftqvm/corpus.mjs";
import { programRow } from "../os/program-runs.mjs";
import { PROGRAMS as OS_PROGRAMS } from "../os/programs.mjs";

const RUNS = new URL("../../validation/calib/site/runs/", import.meta.url);
const ADAPTERS = { superconducting: transmon, neutral: (o) => optical(o.id), qccd: (o) => optical(o.id) };
const FIELD_OF = {
  H: "gate1q_ns", S: "gate1q_ns", Sdg: "gate1q_ns", X: "gate1q_ns", Z: "gate1q_ns", CNOT: "gate2q_ns", CZ: "gate2q_ns", CY: "gate2q_ns",
  measure: "measure_ns", request_ancilla: "reset_ns", route: "route_latency_ns", decode_syndrome: "decoder_latency_ns", pauli_frame_update: "pauli_frame_update_ns",
};

/** The programs and designs the Examples offer (each needs a stored run). */
export const PROGRAMS = ["memory-d3", "zzmerge-d3", "measurement-d3", "bell-d3", "ghz3-d3", "loop-d3", "tinject-d3", "bell-d5", "zzmerge-d5"];
export const DESIGN_IDS = ["sc-A", "sc-B", "atoms-moving", "atoms-static", "ions-qccd", "ions-modules"];
const platformOf = (design) => Object.entries(DESIGNS).find(([, ds]) => ds.some((d) => d.id === design))[0];

export function storedRun(program, design) {
  // Stored gzip-compressed (only the server reads them): validation/calib/site/runs/<program>.<design>.json.gz
  const file = new URL(program + "." + design + ".json.gz", RUNS);
  if (!existsSync(file)) throw Error("no stored run of " + program + " on " + design + (/-d5$/.test(program) ? " (distance-5 programs are stored on sc-B only)" : ""));
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
}

/** The runtime's model: the derived machine's pools, with the run's overrides. */
function model(run, { decoders, factories, ancillas = 100 }) {
  const L = run.listing;
  const data = new Set(L.ops.flatMap((o) => o.qubits).filter((q) => q.register !== "ancilla").map((q) => q.register + "[" + q.index + "]"));
  const machine = { ...L.machine, qubits: Math.max(1, Math.round(((L.machine.qubits - data.size) * ancillas) / 100)) };
  if (decoders) machine.decoders = Number(decoders);
  if (factories) machine.factories = Number(factories);
  return { machine, model: machineModel(machine) };
}

const retime = (listing, result) => {
  const at = new Map(result.ops.map((o) => [o.uid, o]));
  return { ...listing, ops: listing.ops.map((op) => { const s = at.get(op.uid); const start = Math.ceil(s.start / 2) * 2; return { ...op, start, duration: s.dur, end: start + s.dur }; }) };
};

/** One run; returns a row as the Reproduce pages show it: { label, conforms, byKind, columns, track, failures }. */
export async function exampleRun({ program = "zzmerge-d3", design = "sc-B", execution = "timetable", decoders, factories, ancillas = 100, windows = "spec", label } = {}) {
  const run = storedRun(program, design);
  const platform = platformOf(design);
  const point = Object.values(DESIGNS).flat().find((d) => d.id === design);
  const adapter = ADAPTERS[platform](point.options);
  const listing = { ...run.listing, ops: run.listing.ops.map((o) => ({ work: [], inputNs: null, text: "", ...o })) };
  let toRun = listing, des = null;
  const columns = { Program: program, Design: design + " (" + point.title + ")", Execution: execution === "timetable" ? "the compiler's timetable" : "runtime, " + execution };
  if (execution !== "timetable") {
    const { model: m, machine } = model(run, { decoders, factories, ancillas });
    des = simulate(listing, { model: m, mode: "dependency", policy: execution === "greedy" ? "fifo" : "order", strict: execution === "strict", orderedPools: execution === "ordered" ? ["qubits"] : [] });
    Object.assign(columns, { "Decoders / factories / ancilla qubits": machine.decoders + " / " + machine.factories + " / " + machine.qubits, "Operations that waited": String(des.ops.filter((o) => o.waitNs > 0).length) });
    if (des.deadlock) {
      // The simulator's schedule up to the deadlock, on the design's placement (no hardware run).
      const placement = adapter.place(listing, { distance: run.distance });
      const hw = adapter.design(listing, placement);
      const { report: ref } = await adapter.run(listing, placement, hw, { outcomes: {}, distance: run.distance });
      const rows = des.ops.filter((o) => o.start !== null).map((o) => ({ uid: o.uid, kind: o.kind, start: o.start, end: o.end ?? des.deadlock.atNs, hardwareNs: [o.start, o.end ?? des.deadlock.atNs] }));
      const track = buildTrack({ listing, placement, report: { rows }, device: ref.track.device });
      track.controller = undefined;
      return { label: label ?? program + " · " + design + " · runtime, greedy", conforms: false, deadlock: true, byKind: {}, track, twinKey: key({ program, design, execution, decoders, factories, ancillas, windows }),
        columns: { ...columns, Result: "deadlock at " + (des.deadlock.atNs / 1000).toFixed(1) + " µs after " + des.completed + " of " + des.total + " operations; " + des.deadlock.waitingOps + " wait for " + [...new Set(des.deadlock.blocked.map((b) => b.waitingFor))].join(", "), "Animation": "the runtime simulator up to the deadlock (no hardware run: the schedule never completes)" },
        failures: des.deadlock.blocked.slice(0, 8).map((b) => ({ kind: b.kind, line: b.line, reason: "waits for " + b.waitingFor + " held by operations that wait for it" })) };
    }
    toRun = retime(listing, des);
    columns["Makespan: runtime / timetable (µs)"] = (des.makespanNs / 1000).toFixed(1) + " / " + (des.listedMakespanNs / 1000).toFixed(1);
  }
  if (windows !== "spec") {
    // Judge each op against the number fitted on the other programs (riscq/calib/methods.mjs).
    const fitted = run.fitted?.[windows] ?? {};
    toRun = { ...toRun, ops: toRun.ops.map((op) => { const f = fitted[FIELD_OF[op.kind]]; return f !== undefined ? { ...op, duration: f, end: op.start + f } : op; }) };
    columns.Windows = "each operation against the " + { max: "worst case", p99: "99th percentile", p50: "median" }[windows] + " of the other programs on " + design;
  }
  const placement = adapter.place(toRun, { distance: run.distance });
  const hw = adapter.design(toRun, placement);
  const { report } = await adapter.run(toRun, placement, hw, { outcomes: {}, distance: run.distance });
  const late = report.rows.filter((r) => r.ok === false);
  const end = Math.max(...report.rows.map((r) => r.hardwareNs?.[1] ?? r.end ?? 0));
  return {
    label: label ?? program + " · " + design + " · " + (execution === "timetable" ? "timetable" : "runtime, " + execution),
    conforms: report.conforms, byKind: report.byKind, track: report.track, twinKey: key({ program, design, execution, decoders, factories, ancillas, windows }),
    columns: { ...columns, "Machine time on the hardware (µs)": (end / 1000).toFixed(1), "Operations outside their window": late.length + " of " + report.rows.length, "Control cores / boards": report.track?.controller ? report.track.controller.cores.length + " / " + (report.track.controller.boards?.length ?? 1) : "–" },
    failures: late.slice(0, 12).map((r) => ({ kind: r.kind, line: r.line, start: r.start, end: r.end, hardwareNs: r.hardwareNs, bitNs: r.bitNs, reason: r.late ? "started late" : r.overlap ? "channel busy" : "ran past its window" })),
  };
}

/** The key that identifies a run's parameters (the design page matches stored rows by it). */
export function key(p) {
  // Every value as a string, as a form gives it (studio/reproduce/design.js computes the same key).
  return JSON.stringify([p.program, p.design, p.execution || "timetable", String(p.decoders ?? ""), String(p.factories ?? ""), String(p.ancillas ?? 100), p.windows || "spec"]);
}

/** The default runs of each Examples page: [{ label, params }]. */
export const STUDY_RUNS = {
  fabric: [
    { label: "Bell pair at d = 5 on 131 transmons, the timetable", params: { program: "bell-d5", design: "sc-B" } },
    { label: "Z⊗Z merge at d = 3, the timetable", params: { program: "zzmerge-d3", design: "sc-B" } },
  ],
  decoder: [
    { label: "GHZ of three blocks, 12 decodes, superconducting", params: { program: "ghz3-d3", design: "sc-B" } },
    { label: "The same program on neutral atoms", params: { program: "ghz3-d3", design: "atoms-moving" } },
  ],
  "system-calls": [
    { label: "Z⊗Z merge · superconducting", params: { program: "zzmerge-d3", design: "sc-B" } },
    { label: "Z⊗Z merge · neutral atoms", params: { program: "zzmerge-d3", design: "atoms-moving" } },
    { label: "Z⊗Z merge · trapped ions", params: { program: "zzmerge-d3", design: "ions-qccd" } },
  ],
  "choosing-the-number": [
    { label: "Checked measurement on atoms, its own specification", params: { program: "measurement-d3", design: "atoms-moving" } },
    { label: "The same, against the worst case of the other programs", params: { program: "measurement-d3", design: "atoms-moving", windows: "max" } },
  ],
  "decoder-backlog": [
    { label: "GHZ of three blocks, runtime, 1 decoder", params: { program: "ghz3-d3", design: "sc-B", execution: "ordered", decoders: 1 } },
    { label: "The same with 4 decoders", params: { program: "ghz3-d3", design: "sc-B", execution: "ordered", decoders: 4 } },
  ],
  factories: [
    { label: "T injection, runtime, 1 factory", params: { program: "tinject-d3", design: "sc-B", execution: "ordered", factories: 1 } },
    { label: "The same with 2 factories", params: { program: "tinject-d3", design: "sc-B", execution: "ordered", factories: 2 } },
  ],
  deadlock: [
    { label: "Bell pair, runtime, greedy: deadlock", params: { program: "bell-d3", design: "sc-B", execution: "greedy" } },
    { label: "The same with ordered acquisition of ancillas", params: { program: "bell-d3", design: "sc-B", execution: "ordered" } },
  ],
  "hardware-gate": [
    { label: "Bell pair, runtime schedule, superconducting", params: { program: "bell-d3", design: "sc-B", execution: "ordered" } },
    { label: "Bell pair, runtime schedule, neutral atoms", params: { program: "bell-d3", design: "atoms-moving", execution: "ordered" } },
  ],
  // Logical programs scheduled by the operating system (riscq/os/program-runs.mjs programRow): `os`.
  programs: [
    { label: "Bell pair · superconducting", os: true, params: { program: "bell", design: "sc-B" } },
    { label: "Bell pair · neutral atoms", os: true, params: { program: "bell", design: "atoms-moving" } },
    { label: "Bell pair · trapped ions", os: true, params: { program: "bell", design: "ions-qccd" } },
    { label: "T gate by injection · superconducting", os: true, params: { program: "t-injection", design: "sc-B" } },
    { label: "Two T gates, one factory · superconducting", os: true, params: { program: "two-t", design: "sc-B" } },
    { label: "Four memories, one decoder · neutral atoms", os: true, params: { program: "four-memories", design: "atoms-static" } },
    { label: "Z⊗Z parity check · trapped ions", os: true, params: { program: "parity", design: "ions-modules" } },
    { label: "Bell pair on atoms, readout channels not counted", os: true, params: { program: "bell", design: "atoms-moving", readouts: "not counted" } },
  ],
  scale: [
    { label: "Z⊗Z merge at d = 5 on 109 transmons", params: { program: "zzmerge-d5", design: "sc-B" } },
    { label: "Bell pair at d = 5 on 131 transmons", params: { program: "bell-d5", design: "sc-B" } },
  ],
};

const INTRO = "Choose a program, a hardware design and how the operating system runs it, then run it on the cycle-exact model of the RISC-Q control hardware. The timetable is the compiler's QSysASM listing; a runtime policy runs the same program as soon as its dependencies and resources allow and the hardware then plays that schedule. Every operation is checked against its window.";

/** A study's run: the operating system's (programRow) or the corpus listing's (exampleRun). */
export const studyRun = (r) => (r.os ? programRow({ ...r.params, label: r.label }) : exampleRun({ ...r.params, label: r.label }));

const OS_INTRO = "Choose a logical program, a hardware design and how the operating system schedules it. The OS counts the design's capacities, schedules the untimed QSysASM program, compiles the timetable to RISC-Q firmware and runs it on the cycle-exact model; every latency the hardware needed beyond what the OS was told is learned, and the program is scheduled again until every operation fits its window.";

/** The design page of the operating-system study: a program of riscq/os/programs.mjs on a design. */
const osDesign = (runs) => ({
  intro: OS_INTRO,
  params() {
    const d = runs[0].params;
    const opt = (xs, labels = {}) => xs.map((x) => ({ value: x, label: labels[x] ?? String(x) }));
    return [
      { key: "program", label: "Logical program", value: d.program, group: "Program", source: "flat QSysASM without times (riscq/os/programs.mjs)", options: OS_PROGRAMS.map((p) => ({ value: p.id, label: p.title })) },
      { key: "design", label: "Hardware design", value: d.design, group: "Machine", source: "two designs per platform (riscq/ftqvm/corpus.mjs)", options: DESIGN_IDS.map((x) => ({ value: x, label: x + " · " + Object.values(DESIGNS).flat().find((p) => p.id === x).title })) },
      { key: "policy", label: "Scheduler policy", value: d.policy ?? "fifo", group: "Operating system", source: "riscq/os/des.mjs", options: opt(["fifo", "order", "deadline"], { fifo: "first ready, first served", order: "program order", deadline: "earliest listed start" }) },
      { key: "ordered", label: "Ancilla acquisition", value: d.ordered ?? "on", group: "Operating system", source: "ordered acquisition cannot deadlock", options: opt(["on", "off"], { on: "in program order", off: "greedy (may deadlock)" }) },
      { key: "readouts", label: "Readout channels", value: d.readouts ?? "counted", group: "Operating system", source: "not a field of the interface's machine line", options: opt(["counted", "not counted"], { counted: "counted on the design", "not counted": "not counted (the interface alone)" }) },
    ];
  },
  async run(params = {}) {
    const p = { ...runs[0].params, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== "" && v !== undefined && v !== null)) };
    return { rows: [await programRow(p)] };
  },
});

/** The design page of every Examples study: same machinery, the study's runs as starting points. */
export const EXAMPLE_DESIGNS = Object.fromEntries(Object.entries(STUDY_RUNS).map(([id, runs]) => [id, runs[0].os ? osDesign(runs) : {
  intro: INTRO,
  params() {
    const d = runs[0].params;
    const opt = (xs, labels = {}) => xs.map((x) => ({ value: x, label: labels[x] ?? String(x) }));
    return [
      { key: "program", label: "Program", value: d.program, group: "Program", source: "logical programs of the corpus, compiled and admitted", options: opt(PROGRAMS) },
      { key: "design", label: "Hardware design", value: d.design, group: "Machine", source: "two designs per platform (riscq/ftqvm/corpus.mjs)", options: DESIGN_IDS.map((x) => ({ value: x, label: x + " · " + Object.values(DESIGNS).flat().find((p) => p.id === x).title })) },
      { key: "execution", label: "How the OS runs it", value: d.execution ?? "timetable", group: "Operating system", source: "riscq/os/des.mjs policies",
        options: opt(["timetable", "greedy", "strict", "ordered"], { timetable: "the compiler's timetable", greedy: "runtime, greedy (may deadlock)", strict: "runtime, strict order", ordered: "runtime, ordered ancilla acquisition" }) },
      { key: "decoders", label: "Decoders (runtime)", value: d.decoders ?? "", unit: "", min: 1, max: 16, step: 1, group: "Operating system", source: "empty: the derived machine's count" },
      { key: "factories", label: "Factories (runtime)", value: d.factories ?? "", unit: "", min: 1, max: 8, step: 1, group: "Operating system", source: "empty: the derived machine's count" },
      { key: "ancillas", label: "Ancilla qubits available", value: d.ancillas ?? 100, unit: "%", min: 25, max: 100, step: 5, group: "Operating system", source: "share of the derived machine's ancilla qubits" },
      { key: "windows", label: "Windows", value: d.windows ?? "spec", group: "Specification", source: "riscq/calib/methods.mjs",
        options: opt(["spec", "max", "p99", "p50"], { spec: "the listing's own durations", max: "worst case of the other programs", p99: "99th percentile of the other programs", p50: "median of the other programs" }) },
    ];
  },
  async run(params = {}) {
    const p = { ...runs[0].params, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== "" && v !== undefined && v !== null)) };
    for (const k of ["decoders", "factories", "ancillas"]) if (p[k] !== undefined) p[k] = Number(p[k]);
    return { rows: [await exampleRun(p)] };
  },
}]));
