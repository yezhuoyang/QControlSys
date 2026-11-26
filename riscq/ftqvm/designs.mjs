// Editable digital twins of the reproduced papers: what /reproduce/<id>/design shows and runs.
//
// A design page runs a row of a reproduction again on an edited twin. The program is fixed: it is
// the QSysASM listing compiled for the paper's twin (validation/ftqvm/twins/<id>/<key>.json,
// written by riscq/ftqvm/papers.mjs), with the windows of the spec derived for that twin. An edit
// changes the hardware only (gate, readout and transport durations, and the control system's
// cores, decoders, beams and movers). The run is the same time-triggered run in the Lean SoC
// model, and its trace is checked against the listing. So the answer to an edit is whether the
// same compiled program still runs inside its windows on the changed machine. To compile for the
// changed machine, the compiler must derive its spec again (the paper's command in reproductions.mjs),
// which needs the compiler and the riscv32 clang and is not done by the web server.
//
// Contract (shared with riscq/ftqvm/magic.mjs MAGIC_DESIGNS):
//   params()      → [{ key, label, value, unit?, min?, max?, step?, source?, group?, options? }]
//   run(params)   → { rows: [{ label, conforms, byKind, columns, track, failures? }], design? }
import { existsSync, readdirSync, readFileSync } from "node:fs";

const twinsDir = new URL("../../validation/ftqvm/twins/", import.meta.url);
const EDITED = "edited on the design page";

/** The stored rows of a reproduction, in file order. */
function sources(id) {
  const dir = new URL(id + "/", twinsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
}

const rowParam = (rows) => ({ key: "row", label: "Run", group: "Program", value: rows[0]?.key, options: rows.map((r) => ({ value: r.key, label: r.label })),
  source: "the QSysASM listing compiled for the paper's twin; fixed on this page" });

const num = (key, label, value, unit, min, max, step, source, group) => ({ key, label, value, unit, min, max, step, source, group });

/** Willow: durations of the device, and the RISC-Q control system's layout. */
async function willowParams() {
  const { willow } = await import("./twins.mjs");
  const d = willow().durations, dev = "Device: Willow transmons";
  return [
    num("xyNs", "XY rotation (one-qubit gate)", d.x90Ns.value, "ns", 2, 400, 1, d.x90Ns.source, dev),
    num("czNs", "CZ through the tunable coupler", d.czNs.value, "ns", 2, 400, 1, d.czNs.source, dev),
    num("readoutNs", "Readout tone and integration", d.readoutNs.value, "ns", 50, 5000, 10, d.readoutNs.source, dev),
    num("resetNs", "Reset", d.resetNs.value, "ns", 10, 2000, 10, d.resetNs.source, dev),
    num("decoders", "Decoder units", 1, "", 1, 8, 1, "the reproduction's choice", "Control system: RISC-Q board"),
    num("coresPerDecoder", "Cores per decoder unit", 4, "", 1, 8, 1, "the reproduction's choice: each Helios job on its own core", "Control system: RISC-Q board"),
  ];
}

async function willowRun(src, p) {
  const { willow } = await import("./twins.mjs");
  const { transmonTwin } = await import("./platforms.mjs");
  const device = willow();
  // A parameter left out keeps the paper's value.
  const set = (field, value) => {
    if (value === undefined || value === "" || !Number.isFinite(Number(value))) return;
    if (Number(value) !== device.durations[field].value) device.durations[field] = { value: Number(value), source: EDITED };
  };
  const int = (value, fallback) => (Number.isFinite(Number(value)) && value !== undefined && value !== "" ? Number(value) : fallback);
  set("x90Ns", p.xyNs); set("xNs", p.xyNs); set("czNs", p.czNs); set("readoutNs", p.readoutNs); set("resetNs", p.resetNs);
  // One transmon per core: RISC-Q builds exactly one demod channel into every core.
  const platform = transmonTwin(device, { qubitsPerCore: 1, decoders: int(p.decoders, 1), coresPerDecoder: int(p.coresPerDecoder, 4) });
  const placement = platform.place(src.listing, { distance: src.distance });
  const design = platform.design(src.listing, placement);
  const { report } = await platform.run(src.listing, placement, design, { outcomes: {}, distance: src.distance });
  return { report, design };
}

/** Optical twins: the profile's durations and the controller's beams, movers and decoders. */
const OPTICAL_FIELDS = {
  bluvstein: [
    ["twoQubitNs", "Rydberg CZ (global pulse)"], ["globalOneQubitNs", "Global Raman layer"], ["oneQubitNs", "Local one-qubit gate (a row)"],
    ["moveNs", "AOD move (one route)"], ["readoutMoveNs", "Move to the readout zone"], ["measureNs", "Imaging"], ["resetNs", "Optical pumping (reset)"],
  ],
  h2: [
    ["twoQubitNs", "MS gate"], ["oneQubitNs", "One-qubit gate"], ["measureNs", "Measurement"], ["resetNs", "Reset"],
    ["splitNs", "Split"], ["mergeNs", "Merge"], ["shuttleNs", "Shuttle by one zone"],
  ],
};
const CONTROL_FIELDS = [
  ["beams", "Addressing beams", 1, 64], ["movers", "Movers (AODs or electrode lanes)", 1, 64], ["readouts", "Readout channels", 1, 32],
  ["decoders", "Decoder units", 1, 8], ["coresPerDecoder", "Cores per decoder unit", 1, 8],
];

async function opticalParams(src) {
  const { PROFILES, OPTICAL_DESIGNS } = await import("./optical.mjs");
  const point = { ...OPTICAL_DESIGNS[src.platform.id], ...src.platform.overrides }, prof = PROFILES[point.profile];
  const dev = "Device: " + (prof.platform === "neutral" ? "atom array" : "ion trap"), ctl = "Control system: RISC-Q board and optics";
  return [
    ...(OPTICAL_FIELDS[point.profile] ?? []).filter(([f]) => prof[f]).map(([f, label]) =>
      num(f, label, prof[f].value, "ns", 10, Math.max(10 * prof[f].value, 10000), 10, prof[f].source, dev)),
    ...CONTROL_FIELDS.map(([f, label, min, max]) => num(f, label, point[f] ?? (f === "readouts" ? 16 : f === "coresPerDecoder" ? 4 : f === "decoders" ? 1 : 16), "", min, max, 1,
      "the twin's design point (optical design " + src.platform.id + ")", ctl)),
  ];
}

async function opticalRun(src, p) {
  const { PROFILES, OPTICAL_DESIGNS } = await import("./optical.mjs");
  const { optical } = await import("./platforms.mjs");
  const point = { ...OPTICAL_DESIGNS[src.platform.id], ...src.platform.overrides }, prof = PROFILES[point.profile];
  const profileOverrides = {};
  for (const [f] of OPTICAL_FIELDS[point.profile] ?? [])
    if (prof[f] && p[f] !== undefined && p[f] !== "" && Number.isFinite(Number(p[f])) && Number(p[f]) !== prof[f].value)
      profileOverrides[f] = { value: Number(p[f]), source: EDITED };
  const control = Object.fromEntries(CONTROL_FIELDS.filter(([f]) => p[f] !== undefined && p[f] !== "" && Number.isFinite(Number(p[f]))).map(([f]) => [f, Number(p[f])]));
  const platform = optical(src.platform.id, { ...src.platform.overrides, ...control, profileOverrides });
  const placement = platform.place(src.listing, { distance: src.distance });
  const design = platform.design(src.listing, placement);
  const { report } = await platform.run(src.listing, placement, design, { outcomes: {}, distance: src.distance });
  return { report };
}

/** One page row from a run's conformance report. */
function rowOf(src, report) {
  const rows = report.rows ?? [], bad = rows.filter((r) => !r.ok);
  const worst = Math.max(0, ...bad.flatMap((r) => [r.overrunNs ?? 0, r.bitOverrunNs ?? 0]).filter(Number.isFinite));
  const reason = (r) => r.lentChannel ? "no free channel on this design: not played"
    : r.overrunNs > 0 ? "finished " + Math.round(r.overrunNs) + " ns late"
    : r.bitOverrunNs > 0 ? "bit stored " + Math.round(r.bitOverrunNs) + " ns late"
    : r.kind === "measure" && r.bitNs === undefined ? "no bit stored"
    : r.late ? "a pulse opened off its planned batch" : r.overlap ? "pulses overlapped on one channel" : "outside its window";
  const counts = {};
  for (const r of bad) counts[reason(r).replace(/\d+ ns/, "N ns")] = (counts[reason(r).replace(/\d+ ns/, "N ns")] ?? 0) + 1;
  const ctl = report.track?.controller;
  return {
    label: src.label, conforms: report.conforms, byKind: report.byKind,
    columns: {
      "Operations": rows.length, "Inside their window": rows.length - bad.length, "Worst overrun": worst ? Math.round(worst) + " ns" : "–",
      "Why not": bad.length ? Object.entries(counts).map(([k, n]) => n + " × " + k).join("; ") : undefined,
      "Qubits placed": report.track?.device?.sites?.length, "Controller cores": ctl?.cores.length, "Pulses played": ctl ? ctl.pulses.length + (ctl.truncated ? "+" : "") : undefined,
      "Machine time": report.track ? (report.track.endNs / 1000).toFixed(1) + " µs" : undefined,
    },
    failures: bad.slice(0, 12).map((r) => ({ kind: r.kind, line: r.line, start: r.start, end: r.end, hardwareNs: r.hardwareNs, bitNs: r.bitNs, reason: reason(r) })),
    track: report.track,
  };
}

function registry(id, kind) {
  return {
    async params() {
      const rows = sources(id);
      if (!rows.length) throw Error("no stored twin for " + id + ": run `" + "npm run papers` for it first");
      return [rowParam(rows), ...(kind === "transmon" ? await willowParams() : await opticalParams(rows[0]))];
    },
    async run(params = {}) {
      const rows = sources(id), src = rows.find((r) => r.key === params.row) ?? rows[0];
      if (!src) throw Error("no stored twin for " + id);
      const { report, design } = kind === "transmon" ? await willowRun(src, params) : await opticalRun(src, params);
      return { rows: [rowOf(src, report)], ...(design ? { design } : {}) };
    },
  };
}

export const DESIGNS = {
  "google-2025": registry("google-2025", "transmon"),
  "bluvstein-2024": registry("bluvstein-2024", "optical"),
  "ryan-anderson-2024": registry("ryan-anderson-2024", "optical"),
};
