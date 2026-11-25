// The conformance gate: does the cycle-exact model execute what Executor B schedules?
//
// Executor B (riscq/os/des.mjs) runs a listing dependency-driven with ordered acquisition of the
// ancilla pool and produces a schedule: every op at a new start. That schedule is written back as a
// listing (same ops, retimed) and run time-triggered on the cycle-exact multi-board model, on the
// same design and placement as the in-situ run (riscq/ftqvm/platforms.mjs adapters). The gate
// passes when every op of the retimed listing finishes inside its window there. A failure is
// something Executor B does not model (a shared channel, an AOD or zone conflict, the issue rate of
// a core, a bit that arrives late), and the op says which.
//
// Two schedules per run:
//   spec       ops last the spec's durations (the derived machine); windows are those durations
//   measured   ops last what they needed in the in-situ run; windows are exactly that, so the gate
//              also tests that an op's cost does not change when its neighbours move
//
//   node riscq/os/gate.mjs [--program id]… [--design id]…   → validation/calib/gate.json
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { simulate, machineModel } from "./des.mjs";
import { transmon, optical } from "../ftqvm/platforms.mjs";
import { DESIGNS } from "../ftqvm/corpus.mjs";
import { OPTICAL_DESIGNS } from "../ftqvm/optical.mjs";

/**
 * The compiler's pools plus the hardware pools of an optical design (riscq/ftqvm/optical.mjs): a route
 * takes movers (atoms: one AOD job per route; ions: one electrode lane per moving ion, at most the
 * route's qubits but one), and a measurement takes one of the design's readout channels.
 */
export function hardwareModel(machine, designId, options = {}) {
  const base = machineModel(machine, options);
  const point = OPTICAL_DESIGNS[designId];
  if (!point) return base;
  const atoms = point.profile !== "ions" && point.profile !== "h2";
  return {
    ...base,
    pools: { ...base.pools, movers: point.movers, readouts: point.readouts ?? 16 },
    needs(op, ns) {
      const n = base.needs(op, ns);
      if (op.kind === "route") n.push(["movers", atoms ? 1 : Math.max(1, Math.min(point.movers, op.qubits.length - 1))]);
      if (op.kind === "measure") n.push(["readouts", 1]);
      return n;
    },
  };
}

const DIR = new URL("../../validation/calib/", import.meta.url);
const ADAPTERS = { superconducting: transmon, neutral: (o) => optical(o.id), qccd: (o) => optical(o.id) };

/** The retimed listing of a schedule: every op at its scheduled start, lasting `dur`. */
function retime(listing, result, gridNs) {
  const at = new Map(result.ops.map((o) => [o.uid, o]));
  const up = (x) => Math.ceil(x / gridNs) * gridNs;
  return {
    ...listing,
    ops: listing.ops.map((op) => {
      const s = at.get(op.uid);
      const start = up(s.start), duration = s.dur;
      return { ...op, start, duration, end: start + duration };
    }),
  };
}

export async function gate(run, { which = "spec", hardware = false } = {}) {
  // Listings stored before `work` was kept: it is empty for every op but request_magic.
  if (run.listing.ops.some((o) => o.kind === "request_magic" && !o.work)) throw Error("stored listing lacks request_magic workspace; re-collect with riscq/calib/insitu.mjs");
  const listing = { ...run.listing, ops: run.listing.ops.map((o) => ({ work: [], inputNs: null, ...o })) };
  const data = new Set(listing.ops.flatMap((o) => o.qubits).filter((q) => q.register !== "ancilla").map((q) => q.register + "[" + q.index + "]"));
  const machine = { ...listing.machine, qubits: listing.machine.qubits - data.size };
  const needed = new Map(run.samples.map((s) => [s.uid, s.neededNs]));
  const opts = which === "measured" ? { latency: (op) => needed.get(op.uid) ?? op.duration } : {};
  const model = hardware ? hardwareModel(machine, run.design, opts) : machineModel(machine, opts);
  const des = simulate(listing, { model, mode: "dependency", policy: "fifo", orderedPools: ["qubits"] });
  if (des.deadlock) return { which, error: "Executor B deadlocked" };
  const design = Object.values(DESIGNS).flat().find((d) => d.id === run.design);
  const platform = ADAPTERS[run.platform](design.options);
  const retimed = retime(listing, des, platform.gridNs ?? 2);
  const placement = platform.place(retimed, { distance: run.distance });
  const hw = platform.design(retimed, placement);
  const { report } = await platform.run(retimed, placement, hw, { outcomes: {}, distance: run.distance });
  const late = report.rows.filter((r) => r.ok === false);
  const byKind = {};
  for (const r of late) { const k = (byKind[r.kind] ??= { late: 0, maxOverrunNs: 0 }); k.late++; k.maxOverrunNs = Math.max(k.maxOverrunNs, r.overrunNs ?? 0); }
  return {
    which, hardware, conforms: report.conforms, ops: report.rows.length, late: late.length, byKind,
    desMakespanNs: des.makespanNs, listedMakespanNs: des.listedMakespanNs, speedup: des.listedMakespanNs / des.makespanNs,
    firstLate: late.slice(0, 5).map((r) => ({ uid: r.uid, kind: r.kind, line: r.line, overrunNs: r.overrunNs, late: r.late, overlap: r.overlap })),
  };
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const arg = (flag) => process.argv.flatMap((a, i) => (a === flag ? [process.argv[i + 1]] : []));
  const only = arg("--program"), designs = arg("--design");
  const runs = readdirSync(new URL("insitu/", DIR)).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(new URL("insitu/" + f, DIR), "utf8")))
    .filter((r) => r.listing && !r.error && r.conforms && (!only.length || only.includes(r.program)) && (!designs.length || designs.includes(r.design)));
  const rows = [];
  const variants = process.argv.includes("--hardware") ? [["spec", true]] : [["spec", false], ["measured", false]];
  for (const r of runs) for (const [which, hardware] of variants) {
    const t0 = Date.now();
    try {
      const g = await gate(r, { which, hardware });
      rows.push({ program: r.program, platform: r.platform, design: r.design, ...g, seconds: (Date.now() - t0) / 1000 });
      console.log((r.program + " " + r.design).padEnd(30), which.padEnd(8), g.error ?? ((g.conforms ? "PASS" : "FAIL " + g.late + "/" + g.ops + " late " + JSON.stringify(g.byKind)) + " | ×" + g.speedup.toFixed(2)));
    } catch (error) {
      rows.push({ program: r.program, platform: r.platform, design: r.design, which, error: error.message.slice(0, 500) });
      console.log((r.program + " " + r.design).padEnd(30), which.padEnd(8), "ERROR", error.message.slice(0, 160));
    }
  }
  writeFileSync(new URL(process.argv.includes("--hardware") ? "gate-hardware.json" : "gate.json", DIR), JSON.stringify({ generated: new Date().toISOString(), rows }, null, 1) + "\n");
  const ok = (w) => rows.filter((x) => x.which === w && x.conforms).length + "/" + rows.filter((x) => x.which === w).length;
  console.log("gate passes: spec", ok("spec"), "| measured", ok("measured"));
}
