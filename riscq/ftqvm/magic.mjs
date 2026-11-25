// Two magic-state experiments reproduced on digital twins, at both levels of QuantumOS:
//
//   the factory   the paper's own physical circuit (riscq/ftqvm/magic-circuits.mjs), timed on the
//                 twin's calibrated durations, lowered to RISC-Q channel actions and run in the Lean
//                 model of the controller; every operation is checked against its window. Its
//                 noise is simulated with the paper's own error model (bridge/magic_sim.py).
//   the call      a FormalRV program that consumes one magic state (`prepare |T>`), compiled by
//                 FormalRV against a machine whose `request_magic` factory is that circuit: its
//                 output and workspace qubits and its latency are the twin's, and FormalRV's VM
//                 must admit the listing.
//
// Google Quantum AI, "Magic state cultivation on a superconducting quantum processor",
//   arXiv:2512.13908 (Willow, transmons).
// Sales Rodriguez et al., "Experimental demonstration of logical magic state distillation",
//   Nature 645, 620 (2025), arXiv:2412.15165 (QuEra Gemini-class, neutral atoms).
//
// Every duration and rate below carries its source. Where a paper does not state a value, the
// value used and its source are named; `limits` on the reproduction pages repeat them.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execute, socSpec, phaseCode, ampCode, AMP_SCALE } from "../soc.mjs";
import { assemble, measuredBits } from "../compile.mjs";
import * as superconducting from "../platforms/superconducting.mjs";
import * as hardwareDesign from "../design.mjs";
import { STANDARD } from "../standards.mjs";
import { chipDesign } from "./sc-chip.mjs";
import { conformance, addRows } from "./sc-run.mjs";
import { slack, specFor } from "./derive.mjs";
import * as formalrv from "./formalrv.mjs";
import * as specText from "./spec.mjs";
import * as mc from "./magic-circuits.mjs";
import { controllerTrack } from "./track.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const v = (value, source, note) => ({ value, source, ...(note ? { note } : {}) });

/* ================================================================== the bridge to Stim */

/** Run bridge/magic_sim.py on one request. */
export function stim(request) {
  return new Promise((ok, fail) => {
    const child = execFile(process.env.QCONTROL_PYTHON || "python", ["-I", join(REPO, "bridge", "magic_sim.py")],
      { windowsHide: true, maxBuffer: 1 << 28, timeout: 1_800_000 }, (error, stdout, stderr) => {
        if (error && (error.code === "ENOENT" || /No module named '(numpy|stim)'/.test(stderr ?? "")))
          return fail(Error("The noise simulation needs Python with numpy and stim (pip install stim numpy), which this server does not have. Runs without noise do not need them."));
        if (error) return fail(Error("bridge/magic_sim.py: " + (stderr || error.message).trim().split("\n").slice(-3).join(" ")));
        ok(JSON.parse(stdout));
      });
    child.stdin.end(JSON.stringify(request));
  });
}

/* ================================================================== Google: the Willow twin */

const rosenfeld = "Rosenfeld et al., arXiv:2512.13908";

/**
 * The part of Google's Willow processor a published circuit runs on: its qubits at the circuit's
 * own coordinates (Crumble's grid of the square lattice), a tunable coupler between every pair one
 * lattice step apart, and the paper's gate durations. The 105-qubit chip's full coordinate map is
 * not published; a circuit's qubits are all the twin holds.
 */
/** A twin parameter, replaced by an edit from the design page when one is given. */
const edit = (entry, value) => (value === undefined || value === entry.value ? entry : v(Number(value), "edited", "the paper's twin has " + entry.value + " (" + entry.source + ")"));

/** The parameters of the Willow twin a design page may change, with the twin's values and sources. */
export const WILLOW_EDITS = Object.freeze({
  gate1qNs: { label: "Single-qubit gate", unit: "ns", min: 10, max: 200, step: 1 },
  czNs: { label: "CZ gate", unit: "ns", min: 10, max: 400, step: 1 },
  readoutNs: { label: "Readout", unit: "ns", min: 100, max: 3000, step: 10 },
  resetNs: { label: "Reset", unit: "ns", min: 20, max: 2000, step: 10 },
});

export function willowTwin(circuit, edits = {}) {
  const measured = new Set(circuit.moments.flatMap((m) => m.ops.filter((o) => o.gate === "M").flatMap((o) => o.targets)));
  const sites = circuit.qubits.map((q, i) => ({ rc: [q.y, q.x], kind: measured.has(i) ? "measure" : "data", id: "w" + q.x + "_" + q.y }));
  const couplers = [];
  for (let a = 0; a < sites.length; a++)
    for (let b = a + 1; b < sites.length; b++)
      if (Math.abs(Math.hypot(sites[a].rc[0] - sites[b].rc[0], sites[a].rc[1] - sites[b].rc[1]) - 1) < 1e-9) couplers.push([a, b]);
  const one = v(35, rosenfeld + ", Supplementary Fig. S1 caption: \"The single-qubit gates all had duration 35 ns\"");
  return {
    id: "willow-" + circuit.name, title: "Willow (Google), the " + circuit.qubits.length + " transmons of " + circuit.name, platform: "superconducting",
    sites, couplers,
    durations: {
      x90Ns: edit(one, edits.gate1qNs),
      xNs: edit(one, edits.gate1qNs),
      czNs: edit(v(35, rosenfeld + ", Supplementary Fig. S3 caption: \"The CZ gates all had duration 35 ns\""), edits.czNs),
      readoutNs: edit(v(STANDARD.superconducting.readoutNs.value, STANDARD.superconducting.readoutNs.source + " (the cultivation paper gives no readout duration)"), edits.readoutNs),
      resetNs: edit(v(STANDARD.superconducting.resetNs.value, STANDARD.superconducting.resetNs.source + " (the cultivation paper gives no reset duration)"), edits.resetNs),
    },
    published: {
      processorQubits: v(105, rosenfeld + ", Supplementary Sec. \"Device\": \"105 tunable transmon qubits in a square lattice\""),
      kickbackGates: v(216, rosenfeld + ", Sec. II: \"the 216 physical two-qubit gates in the circuit, as well as its 54 measurements\""),
      kickbackMeasurements: v(54, rosenfeld + ", Sec. II"),
      graftQubits: v(54, rosenfeld + ", Sec. III and Supplementary: the distance-5 grafting experiment on 54 qubits"),
      retention: v(0.08, rosenfeld + ", abstract and Sec. II: \"retaining 8% of attempts\""),
      fidelity: v(0.9999, rosenfeld + ", abstract: \"a state fidelity of 0.9999(1)\""),
      injectionError: v(4.4e-3, rosenfeld + ", Sec. II, Fig. 3b: injection only, logical error 4.4(2)×10⁻³ at θ = π/4"),
      cultivationError: v(1e-4, rosenfeld + ", Sec. II: \"hovers between 1×10⁻⁴ and 2×10⁻⁴\" near θ = π/4"),
      noiseP: v(2.3e-3, rosenfeld + ", Figs. 3–4 simulations: SI1000 with p = 2.3×10⁻³"),
    },
    basis: "The circuit is the paper's own (Supplementary \"Explicit circuits\", Crumble links), qubit for qubit. Gate durations are the paper's; " +
      "readout and reset are not given there and come from the group's 2023 surface-code paper. Every CZ of the circuit must be on a coupler " +
      "of the square grid (checked). Pulse shapes, frequencies and the readout multiplexing are not published: the chip reuses RISC-Q's " +
      "x6y3 calibration shapes at these durations. The controller is QuantumOS's RISC-Q model, not Google's.",
  };
}

/** Every CZ of a circuit is on a coupler of its twin; returns the pairs that are not. */
export function uncoupled(circuit, device) {
  const set = new Set(device.couplers.map(([a, b]) => a + "-" + b));
  const bad = [];
  for (const m of circuit.moments) for (const op of m.ops) if (op.gate === "CZ")
    for (let k = 0; k < op.targets.length; k += 2) {
      const [a, b] = [op.targets[k], op.targets[k + 1]].sort((x, y) => x - y);
      if (!set.has(a + "-" + b)) bad.push([a, b]);
    }
  return bad;
}

/**
 * The chip of a Willow twin as a hardware design document (riscq/design.mjs), with one more
 * drive-table entry per transmon: a 45° pulse (half the 90° amplitude, same 35 ns) for the T
 * gates exp(∓iπσy/8) that cultivation plays.
 */
export function willowDesign(device, { qubitsPerCore = 1 } = {}) {
  const placement = { sites: device.sites.map((s) => ({ id: s.id, rc: s.rc, kind: s.kind })) };
  const { design } = chipDesign({ ops: [] }, placement, { device, qubitsPerCore, decoders: 1, coresPerDecoder: 1, name: device.title, pitchMm: 1 });
  for (const ch of design.channels) if (ch.name.endsWith("gate")) ch.slots = 4;
  return design;
}

/** The machine of a design, with the 45° entry added to every drive table. */
export function willowMachine(design) {
  const m = hardwareDesign.machine(design);
  design.qubits.forEach((q, i) => {
    const at = m.locate(i, "gate");
    const table = m.tables.find((t) => t.core === at.core && t.channel === at.channel);
    const x90 = table.slots[0], lines = table.slots.reduce((s, x) => s + x.dur, 0);
    const slot = table.slots.length;
    table.slots.push({ slot, amp: Math.round(x90.amp / 2), phase: x90.phase, dur: x90.dur, env: lines });
    const ref = m.bindings.find((b) => b.core === at.core && b.slot === 0 && b.detail?.gate === "x90" && b.detail.qubit === i);
    m.bindings.push({ ...ref, slot, id: q.part + ".x45", detail: { kind: "drive", gate: "x45", qubit: i } });
  });
  return m;
}

const SLOT = new Map([[Math.PI / 2, 0], [Math.PI, 1], [Math.PI / 4, 3]]);
const KIND = { pulse: "1Q pulse", frame: "virtual Z", cz: "CZ", measure: "measure", reset: "reset" };

/**
 * The paper's circuit as a time-triggered listing on the twin: each moment (Stim TICK) starts
 * when the previous one ends and lasts as long as its longest operation on the controller's
 * 2 ns grid (a 35 ns pulse takes 36 ns); virtual Z rotations take no time. Returns the listing
 * (one row per operation and qubit, FormalRV's listing shape) and its native instructions.
 */
export function transmonSchedule(circuit, m, { theta = Math.PI / 4, momentNs } = {}) {
  // `momentNs`: a paper's own timeline, one duration per moment (ns). A moment then lasts that
  // long on the controller's grid; its operations keep their own lengths, so a readout longer
  // than its moment runs on under the next moments (pipelined readout).
  const period = m.period, ns = (s) => m.span(s) * period / 1000; // seconds → ns on the grid
  const q0 = m.calibration.qubits[0];
  const pulseNs = ns(q0.X90.time), czNs = ns(m.pairs[0].pulses[0].time), resetNs = ns(q0.reset.time);
  // A π rotation plays the X table entry (slot 1), whose length is the calibration's X pulse; every
  // other rotation plays the π/2 (or π/4) entry, which lasts as long as X90.
  const piNs = ns(q0.X.time);
  const lengthOf = (play) => (play.kind === "pulse" && Math.abs(play.angle) === Math.PI ? piNs : { pulse: pulseNs, cz: czNs, measure: readoutNs, reset: resetNs, frame: 0 }[play.kind] ?? 0);
  const readoutNs = ns(Math.max(q0.readout.time, q0.readout.demod.delay + q0.readout.demod.time));
  const ops = [], natives = [], origin = new Map(), moments = [];
  let t = 0, uid = 0, rec = 0, nid = 0;
  const native = (op, n) => { const id = "h" + nid++; origin.set(id, op.uid); natives.push({ ...n, id, source: "moment " + op.moment + " · " + op.text }); };
  circuit.moments.forEach((mo, k) => {
    const plays = mo.ops.map((op) => ({ op, play: mc.transmonPlay(op, { theta }) }));
    const longest = Math.max(0, ...plays.map(({ play }) => (play.kind === "frame" || play.kind === "idle" ? 0 : lengthOf(play))));
    const grid = (x) => Math.ceil((x * 1000) / period) * period / 1000;
    const dur = momentNs && momentNs[k] != null ? grid(momentNs[k]) : longest;
    moments.push({ index: k, start: t, dur, ops: mo.ops.map((o) => ({ gate: o.gate, tag: o.tag, targets: o.targets })) });
    for (const { op, play } of plays) {
      if (play.kind === "idle") continue;
      const step = play.kind === "cz" ? 2 : 1;
      for (let i = 0; i < op.targets.length; i += step) {
        const qs = op.targets.slice(i, i + step);
        const name = op.gate + (op.tag ? "[" + op.tag + "]" : "");
        const own = lengthOf(play);
        // A gate's window is its moment: on a paper's timeline a gate longer than its layer would
        // run into the next layer's gates, so it is late. A readout (or reset) may run on under the
        // next moments, as the papers pipeline them.
        const window = momentNs && (play.kind === "pulse" || play.kind === "cz") ? Math.min(own, dur) : own;
        const row = { uid: uid++, kind: play.kind === "pulse" && Math.abs(play.angle) === Math.PI / 4 ? "T pulse" : KIND[play.kind], line: k + 1, moment: k,
          text: name + " " + qs.join(" "), qubits: qs, start: t, duration: window, end: t + window };
        if (play.kind === "measure") row.writes = [{ register: "m", index: rec++ }];
        ops.push(row);
        const ps = t * 1000;
        if (play.kind === "frame") native(row, { op: "frame", qubits: qs, angle: play.angle, t: ps, dur: 0 });
        else if (play.kind === "pulse") {
          if (play.before) native(row, { op: "frame", qubits: qs, angle: play.before, t: ps, dur: 0 });
          native(row, { op: "pulse", qubits: qs, angle: play.angle, axis: play.axis, t: ps, dur: own * 1000 });
        } else if (play.kind === "cz") native(row, { op: "cz", qubits: qs, t: ps, dur: czNs * 1000 });
        else if (play.kind === "measure") native(row, { op: "measure", qubits: qs, t: ps, dur: readoutNs * 1000, result: "m[" + row.writes[0].index + "]" });
        else if (play.kind === "reset") native(row, { op: "reset", qubits: qs, t: ps, dur: resetNs * 1000 });
      }
    }
    t += dur;
  });
  return { listing: { ops, calls: [] }, natives, origin, moments, makespanNs: t, durations: { pulseNs, piNs, czNs, readoutNs, resetNs } };
}

/** Native instructions → RISC-Q channel actions (as platforms/superconducting.mjs lower, with the 45° entry). */
export function lowerTransmon(natives, m, spanNs) {
  const period = m.period, frame = new Map(), actions = [], readouts = [];
  const batch = (ps) => { if (ps % period) throw Error("time " + ps + " ps is off the " + period + " ps grid"); return ps / period; };
  for (const op of [...natives].sort((x, y) => x.t - y.t || (x.op === "frame" ? -1 : 1) - (y.op === "frame" ? -1 : 1))) {
    const at = batch(op.t), [q] = op.qubits;
    if (op.op === "frame") frame.set(q, (frame.get(q) ?? 0) - op.angle);
    else if (op.op === "pulse") {
      const slot = SLOT.get(Math.abs(op.angle) === Math.PI / 4 ? Math.PI / 4 : Math.abs(op.angle));
      const g = m.locate(q, "gate");
      actions.push({ segment: 0, core: g.core, at, fire: { channel: g.channel, slot }, phaseOffset: phaseCode((frame.get(q) ?? 0) + op.axis), source: op.id });
    } else if (op.op === "reset") {
      const g = m.locate(q, "gate");
      actions.push({ segment: 0, core: g.core, at, fire: { channel: g.channel, slot: 2 }, source: op.id });
    } else if (op.op === "cz") {
      const pair = m.pairs.find((p) => p.pair.every((x) => op.qubits.includes(x)));
      if (!pair) throw Error(op.source + ": no coupler between " + op.qubits.join(" and "));
      for (const x of op.qubits) {
        const tone = m.locate(x, "cz", pair);
        actions.push({ segment: 0, core: tone.core, at, fire: { channel: tone.channel, slot: 0 }, source: op.id });
      }
      for (const z of pair.virtualZ) frame.set(z.qubit, (frame.get(z.qubit) ?? 0) - z.phase);
    } else if (op.op === "measure") {
      const ro = m.locate(q, "ro"), demod = m.locate(q, "demod"), cal = m.calibration.qubits[q].readout;
      const delay = m.span(cal.demod.delay), window = m.span(cal.demod.time);
      actions.push({ segment: 0, core: ro.core, at, fire: { channel: ro.channel, slot: 0 }, source: op.id });
      actions.push({ segment: 0, core: demod.core, at: at + delay, fire: { channel: demod.channel, slot: 0 }, source: op.id });
      actions.push({ segment: 0, core: demod.core, at: at + delay, bit: op.result, read: { channel: demod.channel, until: at + delay + window }, source: op.id });
      readouts.push({ qubit: q, core: demod.core, channel: demod.channel, bit: op.result, op: op.id });
    }
  }
  return { tables: m.tables, segments: [{ span: batch(spanNs * 1000) }], actions, readouts };
}

/**
 * The papers' circuits read their bits only after the run (postselection is offline), so a
 * measurement conforms when its pulses and window are kept and its bit is stored at all; how long
 * after the window the bit reached the controller's memory is kept as `bitAfterWindowNs`.
 */
export function bitLatency(report) {
  for (const r of report.rows) {
    if (r.kind !== "measure") continue;
    r.bitAfterWindowNs = r.bitOverrunNs;
    r.ok = r.bitNs !== undefined && !(r.overrunNs > 0) && !r.late && !r.overlap;
  }
  addRows(report, []);
  report.bitAfterWindowNs = Math.max(0, ...report.rows.filter((r) => r.kind === "measure").map((r) => r.bitAfterWindowNs ?? 0));
}

/**
 * Run one of the paper's circuits on its Willow twin: schedule, lower, run in the Lean model,
 * check every operation against its window. `outcomes` are the bits the readout returns.
 */
export async function runWillow(circuit, { theta = Math.PI / 4, outcomes = [], qubitsPerCore = 1, edits = {} } = {}) {
  const device = willowTwin(circuit, edits);
  const bad = uncoupled(circuit, device);
  if (bad.length) throw Error(circuit.name + ": " + bad.length + " CZ pairs are not neighbours on the square grid");
  const design = willowDesign(device, { qubitsPerCore });
  const m = willowMachine(design);
  const s = transmonSchedule(circuit, m, { theta });
  const lowered = lowerTransmon(s.natives, m, s.makespanNs);
  const bits = Object.fromEntries(outcomes.map((b, i) => ["m[" + i + "]", b]));
  const built = assemble(m.spec, lowered, { trace: "io", maxEvents: 400_000, maxSteps: 20_000_000, bindings: m.bindings,
    readouts: superconducting.readoutOracle(lowered, m, bits) });
  const result = await execute(built.document);
  const hardware = { segments: [{ ops: s.natives.map((n) => ({ id: n.id, t: n.t })), span: s.makespanNs * 1000 }] };
  const report = conformance(s.listing, { hardware, lowered, origin: s.origin, unrealized: [], classical: [], quantization: { maxSlipPs: 0, gridPs: m.period } }, result, built, m);
  bitLatency(report);
  const stored = measuredBits(result, built);
  const readBack = Object.entries(bits).every(([k, b]) => stored[k] !== undefined && Number(stored[k]) === b);
  // The control system for the 3D view: every pulse with the transmons it drives.
  const nativeQubits = new Map(s.natives.map((n) => [n.id, n.qubits]));
  const coreSites = m.spec.cores.map(() => []);
  design.qubits.forEach((_, q) => coreSites[m.locate(q, "gate").core]?.push(q));
  const controller = controllerTrack({ spec: m.spec, result, baseBatch: report.baseBatch, periodPs: m.period, name: "RISC-Q board, 500 MHz",
    sitesOfOp: (id) => nativeQubits.get(id) ?? [], coreSites });
  return { device, design, schedule: s, report, readBack, cores: m.spec.cores.length, qubitsPerCore, pulses: result.summary.pulses.length, status: result.summary.status, controller };
}

/* ================================================================== QuEra: the Gemini twin */

const quera = "Sales Rodriguez et al., Nature 645, 620 (2025), arXiv:2412.15165, Methods";
const bluvstein = "Bluvstein et al., Nature 626, 58 (2024), arXiv:2312.03982, Methods";

/**
 * QuEra's Gemini-class array as the distillation paper runs it, with the source of every number.
 * Times in ns, lengths in µm. The paper gives Rabi frequencies, gate fidelities, separations and
 * the 17 × 5 grid, but no durations of moves, Rydberg pulses or imaging; those come from the same
 * group's 2024 paper on the same kind of machine, or from a cited motion law, and are marked.
 */
/** The parameters of the Gemini twin a design page may change. */
export const GEMINI_EDITS = Object.freeze({
  pitchUm: { label: "Site pitch", unit: "µm", min: 4, max: 40, step: 0.5 },
  gateUm: { label: "Gate-pair separation", unit: "µm", min: 0.5, max: 6, step: 0.1 },
  globalHz: { label: "Global Raman Rabi frequency", unit: "Hz", min: 50e3, max: 5e6, step: 10e3 },
  localHz: { label: "Local Raman Rabi frequency", unit: "Hz", min: 20e3, max: 5e6, step: 10e3 },
  czNs: { label: "Rydberg CZ pulse", unit: "ns", min: 50, max: 2000, step: 10 },
  transferNs: { label: "SLM↔AOD transfer", unit: "ns", min: 0, max: 100_000, step: 500 },
  accel: { label: "AOD acceleration", unit: "m/s²", min: 100, max: 20_000, step: 50 },
  imagingNs: { label: "Imaging", unit: "ns", min: 1000, max: 5_000_000, step: 1000 },
  pumpNs: { label: "Optical pumping", unit: "ns", min: 1000, max: 1_000_000, step: 1000 },
});

export function geminiTwin(edits = {}) {
  const global = 650e3, local = 250e3;
  return {
    id: "quera-gemini", title: "QuEra Gemini-class array, the 17 × 5 entanglement zone", platform: "neutral",
    grid: { columns: 17, rows: 5, source: quera + ", \"Circuit details\": \"a rectangular grid of 17 × 5 SLM traps\"" },
    pitchUm: edit(v(10, "derived: gate pairs 2 µm apart with 8 µm to every other pair (" + quera + ", \"Circuit details\") need a pitch of at least 10 µm; the paper gives no pitch"), edits.pitchUm),
    gateUm: edit(v(2, quera + ": \"gate pairs are 2 µm away, within the Rydberg blockade radius\""), edits.gateUm),
    rabi: {
      global: edit(v(global, quera + ": \"global single-qubit rotations at 650 kHz\""), edits.globalHz),
      local: edit(v(local, quera + ": \"locally at 250 kHz by addressing atoms using another pair of AODs\""), edits.localHz),
    },
    durations: {
      czNs: edit(v(270, bluvstein + ": \"Entangling gates (270-ns duration)\" (the distillation paper gives no CZ duration)"), edits.czNs),
      transferNs: edit(v(STANDARD.neutral.transferNs.value, STANDARD.neutral.transferNs.source + ": SLM↔AOD transfer (pick-up and drop)"), edits.transferNs),
      imagingNs: edit(v(500_000, bluvstein + ": \"the 500-μs midcircuit imaging\" (the distillation paper gives no imaging time)"), edits.imagingNs),
      pumpNs: edit(v(100_000, "Norcia et al., PRX 13, 041034 (2023): \"we use 100 μs for OP\" (initialization; not given in the paper)"), edits.pumpNs),
    },
    accel: edit(v(STANDARD.neutral.moveAcceleration.value, STANDARD.neutral.moveAcceleration.source + ": a move of d takes √(d/a)"), edits.accel),
    t2s: v(2, quera + ": \"T2 coherence time of approximately 2 s\""),
    errors: {
      // Average infidelities as benchmarked; the channel probabilities below convert them.
      local1q: v(1 - 0.9981, quera + ", \"Error model\": local single-qubit gate fidelity 99.81(2)%"),
      global1q: v(1 - 0.99978, quera + ", \"Error model\": global single-qubit gate fidelity 99.978(1)%"),
      cz: v(1 - 0.9942, quera + ", \"Error model\": 99.42(1)% per entangling gate"),
      spam: v(0.01, quera + ", \"Error model\": \"state preparation and measurement errors to be a total of 1%\""),
    },
    published: {
      atomsD3: v(35, quera + ": \"A single factory instance using d=3 and d=5 data codes requires 35 and 85 atoms\""),
      atomsD5: v(85, quera),
      injectedD3: v(0.951, quera.replace(", Methods", "") + ", Fig. 2d: error-corrected injected fidelity 95.1%"),
      injectedPsD3: v(0.983, quera.replace(", Methods", "") + ", Fig. 2d: error-detected (postselected) 98.3%"),
      distilledD3: v(0.994, quera.replace(", Methods", "") + ", abstract: \"from 95.1 to 99.4\" (d = 3)"),
      injectedD5: v(0.925, quera.replace(", Methods", "") + ", abstract: \"from 92.5 to 98.6\" (d = 5)"),
      distilledD5: v(0.986, quera.replace(", Methods", "") + ", abstract (d = 5)"),
      acceptanceIdeal: v(1 / 6, quera + ": \"the factory only has a 1/6 acceptance rate\""),
    },
    basis: "The circuit is rebuilt from the paper's Methods (row operations of both encoders) and Fig. 3a (distillation), and checked: " +
      "both encoders produce the stated color codes, and Fig. 3a accepts 1/6 of perfect inputs with a pure magic state out. Rabi frequencies, " +
      "fidelities, separations and the grid are the paper's. The paper gives no durations of moves, Rydberg pulses, imaging or initialization: " +
      "they come from the group's 2024 paper and the cited motion law, as marked. Composite (amplitude-robust) pulse sequences are not published; " +
      "a rotation takes its Rabi time. The controller is QuantumOS's RISC-Q model at 100 MHz.",
  };
}

const up10 = (ns) => Math.ceil(ns / 10) * 10;

/**
 * The factory circuit as a time-triggered listing on the Gemini twin. A moment is one operation
 * of the hardware: a global or local Raman rotation, a CZ layer (pick up and move the moving
 * atoms, one global Rydberg pulse, the echo, move back and drop), optical pumping, or the camera
 * exposure (one measurement row per atom). Returns the listing, the natives per controller
 * channel, and each moment's duration (for the idle dephasing of the noise model).
 */
export function atomSchedule(circuit, twin = geminiTwin()) {
  const T = twin.durations, pitch = twin.pitchUm.value, gate = twin.gateUm.value;
  const rot = (angle, f) => up10((angle / (2 * Math.PI * f)) * 1e9); // a rotation at Rabi frequency f
  const moveNs = (um) => up10(T.transferNs.value + Math.sqrt((Math.max(0, um) * 1e-6) / twin.accel.value) * 1e9);
  const ops = [], natives = [], origin = new Map(), moments = [];
  let t = 0, uid = 0, nid = 0, rec = 0;
  const native = (row, n) => { const id = "h" + nid++; origin.set(id, row.uid); natives.push({ ...n, id }); return id; };
  circuit.moments.forEach((mo, k) => {
    const first = mo.ops[0];
    const row = { uid: uid++, line: k + 1, moment: k, text: mo.label ?? first.gate, qubits: [], start: t };
    let dur = 0;
    const detail = {};
    if (first.drive === "pump") {
      dur = up10(T.pumpNs.value);
      row.kind = "initialize";
      native(row, { channel: "pump", at: t, dur });
    } else if (first.drive === "local") {
      const angle = first.tag === "injection" ? Math.acos(1 / Math.sqrt(3)) : first.gate === "H" || first.gate === "H_YZ" ? Math.PI / 2 : Math.PI / 2;
      dur = rot(angle, twin.rabi.local.value);
      row.kind = first.tag === "injection" ? "injection rotation" : "local Raman";
      for (const ch of ["local", "addrX", "addrY"]) native(row, { channel: ch, at: t, dur });
    } else if (first.drive === "global") {
      dur = rot(Math.PI / 2, twin.rabi.global.value);
      row.kind = "global Raman";
      native(row, { channel: "raman", at: t, dur });
    } else if (first.drive === "rydberg") {
      // Move: the longest trip of the layer, all atoms of the layer on one AOD job.
      const span = Math.max(...first.move.pairs.map(([a, b]) => Math.abs(a - b) * pitch - gate));
      const go = moveNs(span), cz = up10(T.czNs.value), echo = rot(Math.PI, twin.rabi.global.value);
      const axis = first.move.axis === "x" ? "aodX" : "aodY";
      native(row, { channel: axis, at: t, dur: go });
      native(row, { channel: "rydberg", at: t + go, dur: cz });
      native(row, { channel: "raman", at: t + go + cz, dur: echo });
      native(row, { channel: axis, at: t + go + cz + echo, dur: go });
      dur = 2 * go + cz + echo;
      row.kind = "CZ layer";
      Object.assign(detail, { moveUm: span, moveNs: go, czNs: cz, echoNs: echo, axis: first.move.axis, pairs: first.move.pairs });
    } else if (first.drive === "image") {
      dur = up10(T.imagingNs.value);
      // One row per atom: the bit it reads. The camera's counter cores share one exposure.
      first.targets.forEach((q, i) => {
        ops.push({ uid: uid++, kind: "measure", line: k + 1, moment: k, text: "image atom " + q, qubits: [q], start: t, duration: dur, end: t + dur, writes: [{ register: "m", index: rec++ }], camera: Math.floor(i / 4), line4: i % 4 });
      });
      moments.push({ index: k, start: t, dur, label: mo.label, kind: "image" });
      t += dur;
      return;
    } else throw Error("no Gemini realization for " + first.gate + " (" + first.drive + ")");
    Object.assign(row, { duration: dur, end: t + dur });
    ops.push(row);
    moments.push({ index: k, start: t, dur, label: mo.label, kind: row.kind, ...detail });
    t += dur;
  });
  return { listing: { ops, calls: [] }, natives, origin, moments, makespanNs: t };
}

/**
 * Run the factory's schedule on the Gemini twin's controller: one core per optical system
 * (global Raman, local Raman with its two addressing AODs, Rydberg, the two moving AODs, optical
 * pumping), camera cores that each threshold four atoms' photon counts, and a frame core.
 */
export async function runGemini(circuit, { outcomes = [], twin = geminiTwin() } = {}) {
  const s = atomSchedule(circuit, twin);
  const period = 10_000; // 100 MHz
  const b = (ns) => Math.round((ns * 1000) / period);
  const measures = s.listing.ops.filter((o) => o.kind === "measure");
  const cameras = Math.ceil(measures.length / 4);
  let dac = 0;
  const pulse = (name) => ({ name, kind: "pulse", dac: dac++, slots: 16, env_depth: 1024, interp: 4 });
  const cores = [
    // Core names follow riscq/ftqvm/track.mjs roleOf, so the 3D view knows each core's role.
    { name: "global-raman", channels: [pulse("raman")] },
    { name: "beams-local", channels: [pulse("local"), pulse("addrX"), pulse("addrY")] },
    { name: "global-rydberg", channels: [pulse("rydberg")] },
    { name: "movers-aod", channels: [pulse("aodX"), pulse("aodY")] },
    { name: "pumps", channels: [pulse("pump")] },
    ...Array.from({ length: cameras }, (_, c) => ({ name: "readout" + c, channels: [pulse("image"), { name: "pmt", kind: "dio", slots: 1 }] })),
    { name: "frame", channels: [{ name: "status", kind: "dio", slots: 1 }] },
  ];
  if (cores.length > 64) throw Error("the controller needs " + cores.length + " cores, more than one board's 64");
  const spec = socSpec({ name: twin.id, dsp_freq_hz: 100e6, link_pipe: 4, core_defaults: { mem_depth: 16384, with_mul: true, queue_depth: 32 }, cores });
  const coreOf = (name) => spec.cores.findIndex((c) => c.name === name);
  const coreOfChannel = (ch) => spec.cores.findIndex((c) => c.channels.some((x) => x.name === ch));
  const tables = new Map(), actions = [], bindings = [];
  const slotOf = (core, channel, dur) => {
    const key = core + "/" + channel;
    if (!tables.has(key)) tables.set(key, { core, channel, freq: 0, slots: [], keys: new Map(), lines: 0 });
    const tb = tables.get(key);
    if (!tb.keys.has(dur)) {
      const index = tb.slots.length;
      tb.keys.set(dur, index);
      tb.slots.push({ slot: index, phase: 0, amp: AMP_SCALE, env: 0, dur });
      bindings.push({ core, channel: spec.cores[core].channels.findIndex((c) => c.name === channel), slot: index, id: spec.cores[core].name + "." + channel + "#" + index, part: channel, delayPs: 0, detail: { kind: channel } });
    }
    return tb.keys.get(dur);
  };
  const natives = [...s.natives];
  const hardwareOps = [];
  for (const n of natives) {
    const core = coreOfChannel(n.channel);
    let left = b(n.dur), at = b(n.at);
    // A pulse longer than one table entry (65535 batches) is played as consecutive entries.
    while (left > 0) {
      const part = Math.min(left, 65535);
      actions.push({ segment: 0, core, at, fire: { channel: n.channel, slot: slotOf(core, n.channel, part) }, source: n.id });
      at += part; left -= part;
    }
    hardwareOps.push({ id: n.id, t: n.at * 1000 });
  }
  // The camera: core c exposes for its four atoms and counts their lines; one exposure each.
  const responses = [];
  const gap = 40;
  for (let c = 0; c < cameras; c++) {
    const mine = measures.filter((o) => o.camera === c);
    const core = coreOf("readout" + c), at = b(mine[0].start), dur = b(mine[0].duration);
    const id = "cam" + c;
    s.origin.set(id, mine[0].uid);
    actions.push({ segment: 0, core, at, fire: { channel: "image", slot: slotOf(core, "image", dur) }, source: id });
    actions.push({ segment: 0, core, at, bits: mine.map((o) => "m[" + o.writes[0].index + "]"), source: id,
      count: { channel: "pmt", lines: mine.map((_, i) => i), until: at + dur, threshold: 1, atEnd: true } });
    hardwareOps.push({ id, t: mine[0].start * 1000 });
    const edges = [];
    mine.forEach((o, i) => { if (outcomes[o.writes[0].index]) edges.push({ after: gap * (2 * i + 1), levels: 1 << i }, { after: gap * (2 * i + 1) + 5, levels: 0 }); });
    const chs = spec.cores[core].channels;
    responses.push({ core, channel: chs.findIndex((x) => x.name === "image"), occurrence: 0, toCore: core, toChannel: chs.findIndex((x) => x.name === "pmt"), edges });
  }
  const lowered = { tables: [...tables.values()].map(({ keys: _k, lines: _l, ...t }) => t), segments: [{ span: b(s.makespanNs) }], actions, bindings };
  const built = assemble(spec, lowered, { trace: "io", maxEvents: 400_000, maxSteps: 20_000_000, bindings, responses });
  const result = await execute(built.document);
  const m = { period, decoderCore: coreOf("frame") };
  const report = conformance(s.listing, { hardware: { segments: [{ ops: hardwareOps, span: s.makespanNs * 1000 }] }, lowered, origin: s.origin, unrealized: [], classical: [], quantization: { gridPs: period } }, result, built, m);
  bitLatency(report);
  const stored = measuredBits(result, built);
  const readBack = measures.every((o) => Number(stored["m[" + o.writes[0].index + "]"] ?? -1) === (outcomes[o.writes[0].index] ?? 0));
  // The control system for the 3D view: each pulse with the atoms it acts on.
  const opOf = new Map(s.listing.ops.map((o) => [o.uid, o]));
  const targetsOf = (k) => [...new Set(circuit.moments[k].ops.filter((o) => o.gate !== "I" || o.tag === "injection").flatMap((o) => o.targets))];
  const controller = controllerTrack({ spec, result, baseBatch: report.baseBatch, periodPs: period, name: "RISC-Q board, 100 MHz",
    sitesOfOp: (id) => { const op = opOf.get(s.origin.get(id)); return !op ? [] : op.kind === "measure" ? measures.filter((x) => x.camera === op.camera).flatMap((x) => x.qubits) : targetsOf(op.moment); },
    coreSites: spec.cores.map((c) => (/^readout(\d+)$/.test(c.name) ? measures.filter((x) => x.camera === Number(c.name.slice(7))).flatMap((x) => x.qubits) : [])) });
  return { twin, schedule: s, report, readBack, cores: spec.cores.length, pulses: result.summary.pulses.length, status: result.summary.status, controller };
}

/** QuEra's error model as the channels of bridge/magic_sim.py. Average infidelity r of a
 *  depolarizing channel of probability p is r = p·d/(d+1): p = 3r/2 for one qubit, 5r/4 for two. */
export function queraNoise(twin = geminiTwin()) {
  const e = twin.errors;
  return {
    model: "quera", local1q: 1.5 * e.local1q.value, global1q: 1.5 * e.global1q.value, cz: 1.25 * e.cz.value,
    prepare: e.spam.value / 2, measure: e.spam.value / 2, t2_s: twin.t2s.value,
  };
}

/* ================================================================== the system call */

const baseMachine = join(REPO, "validation", "ftqvm", "base.machine");

/**
 * One magic state consumed by a FormalRV program: `prepare |T>` (the request_magic system call),
 * a Z⊗Z merge with the data block and an X readout, and the frame update (FormalRV's tinject
 * example, one T gate). Compiled against `durations` and `capacities` of the twin and a factory
 * contract whose latency is the factory circuit's on the twin. Returns the files, FormalRV's VM
 * verdict, the listing and the request_magic window.
 */
export async function systemCall({ code, distance, factory, durations, capacities, gridNs, dir, program, optional = {} }) {
  mkdirSync(dir, { recursive: true });
  // `program`: the body of another FormalRV program (default: one T gate by magic-state
  // injection); `optional`: optional machine fields (the decoder's measured fields).
  const programText = `code ${code} d=${distance}\n\nparams  n\n\n` + (program ?? `program[q: 1, c: 2]:\n  prepare |T> -> ancilla[0]\n  measure Z data[0] Z ancilla[0] -> c[0]\n  measure X ancilla[0] -> c[1]\n  when c[1]:\n    frame Z data[0]\n`);
  const qppm = join(dir, "t-gate.qppm"), qec = join(dir, "t-gate.qec");
  writeFileSync(qppm, programText);
  await formalrv.prepareQec(qppm, qec, { code, distance, specialize: { n: 1 } });
  const baseText = readFileSync(baseMachine, "utf8");
  const base = specText.parseMachine(baseText);
  const factories = factory ? { factory: factory.contract } : specText.parseFactories(baseText);
  capacities = { ...capacities, ...optional };
  const gadgets = await formalrv.discoverGadgets(qec, { dir, name: "discover",
    machine: specText.machineText({ machine: specFor(durations, capacities, base, { gridNs }).machine, factories }),
    sysspecFor: (names) => specText.sysspecText(specFor(durations, capacities, base, { gadgets: names, gridNs })) });
  const spec = specFor(durations, capacities, base, { gadgets, factories, gridNs });
  const built = await formalrv.build({ qec, spec: specText.files(spec), name: "t-gate", dir });
  const listing = readFileSync(built.files.sysprog, "utf8").split("\n");
  const magic = built.listing.ops.filter((o) => o.kind === "request_magic");
  const peak = Math.max(0, ...built.listing.ops.map((o) => o.end));
  return {
    programText, qecText: readFileSync(qec, "utf8"), verdict: built.verdict.status, verdictDetail: built.verdict,
    machineText: specText.machineText(spec), sysspecText: specText.sysspecText(spec), spec: spec.machine, factories,
    ops: built.listing.ops.length, kinds: [...new Set(built.listing.ops.map((o) => o.kind))],
    listingHead: listing.filter((l) => l.trim() && !l.startsWith("#")).slice(0, 40).join("\n"), listingLines: listing.length,
    requestMagic: magic.map((o) => ({ start: o.start, end: o.end, output: o.qubits.length, workspace: o.work?.length ?? 0, text: o.text })),
    makespanNs: peak,
  };
}

/* ================================================================== tracks for the 3D twin */

// The animation track of a run (riscq/ftqvm/track.mjs format): every event is an operation of
// the run with the interval its conformance row shows; moves are the moves the controller played.

/** The Willow twin's track: transmons at the circuit's coordinates, pulses, CZs, readouts, resets. */
export function willowTrack(run) {
  const K = { "1Q pulse": "1q", "T pulse": "1q", CZ: "2q", measure: "measure", reset: "reset" };
  const ops = new Map(run.schedule.listing.ops.map((o) => [o.uid, o]));
  const events = [];
  for (const r of run.report.rows) {
    const k = K[r.kind], op = ops.get(r.uid);
    if (!k || !op) continue;
    const t0 = r.hardwareNs?.[0] ?? r.start, t1 = Math.max(r.hardwareNs?.[1] ?? r.end, k === "measure" ? r.bitNs ?? 0 : 0, t0 + 1);
    events.push({ k, t0, t1, s: op.qubits, line: op.text + " · moment " + op.moment });
  }
  events.sort((a, b) => a.t0 - b.t0);
  return {
    device: { kind: "transmon", unit: "lattice", sites: run.device.sites.map((s) => ({ kind: s.kind === "measure" ? "ancilla" : "data", at: [s.rc[1], s.rc[0]] })), couplers: run.device.couplers },
    endNs: Math.max(...events.map((e) => e.t1)), events, moves: [],
  };
}

/**
 * The Gemini twin's track: atoms at their SLM sites (µm), the AOD moves of every CZ layer (the
 * first atom of each pair, or each atom of the first row, moves to 2 µm from its partner and
 * back), the Rydberg pulse on every pair, the Raman pulses on the atoms they address, imaging.
 */
export function geminiTrack(run, circuit) {
  const twin = run.twin, pitch = twin.pitchUm.value, gate = twin.gateUm.value;
  const home = circuit.qubits.map((q) => [q.x * pitch, q.y * pitch]);
  const sites = circuit.qubits.map((q, i) => ({ kind: "data", at: home[i] })); // every atom is a data qubit of a color code
  const events = [], moves = [];
  const rows = new Map(run.report.rows.map((r) => [r.uid, r]));
  for (const op of run.schedule.listing.ops) {
    const r = rows.get(op.uid), mo = run.schedule.moments.find((m) => m.index === op.moment), cm = circuit.moments[op.moment];
    const t0 = r?.hardwareNs?.[0] ?? op.start;
    if (op.kind === "measure") { events.push({ k: "measure", t0, t1: Math.max(r?.bitNs ?? op.end, op.end), s: op.qubits, line: op.text }); continue; }
    const targets = [...new Set(cm.ops.filter((o) => o.gate !== "I" || o.tag === "injection").flatMap((o) => o.targets))];
    if (op.kind === "initialize") events.push({ k: "reset", t0, t1: op.end, s: targets, line: op.text });
    else if (op.kind === "CZ layer") {
      const cz = cm.ops.find((o) => o.gate === "CZ");
      const go = mo.moveNs, at = op.start + go;
      for (let i = 0; i < cz.targets.length; i += 2) {
        const [a, b] = [cz.targets[i], cz.targets[i + 1]];
        const dx = Math.sign(home[a][0] - home[b][0]), dy = Math.sign(home[a][1] - home[b][1]);
        const near = [home[b][0] + dx * gate, home[b][1] + dy * gate];
        moves.push({ t0: op.start, t1: at, s: a, from: home[a], to: near }, { t0: at + mo.czNs + mo.echoNs, t1: op.end, s: a, from: near, to: home[a] });
        events.push({ k: "2q", t0: at, t1: at + mo.czNs, s: [a, b], line: op.text });
      }
      events.push({ k: "1q", t0: at + mo.czNs, t1: at + mo.czNs + mo.echoNs, s: circuit.qubits.map((_, i) => i), line: "global echo π pulse" });
    } else events.push({ k: "1q", t0, t1: op.end, s: targets, line: op.text });
  }
  events.sort((a, b) => a.t0 - b.t0);
  return { device: { kind: "atoms", unit: "µm", sites }, endNs: run.schedule.makespanNs, events, moves };
}

/* ================================================================== the experiments */

const quantile = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(f * (s.length - 1))]; };
const pct = (x, digits = 1) => (100 * x).toFixed(digits) + "%";
const sci = (x) => (x === 0 ? "0" : x.toExponential(1).replace(/e([+-])(\d+)/, (_, s, e) => "×10" + (s === "-" ? "⁻" : "") + [...e].map((c) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[c]).join("")));

/** A run's conformance in the shape the reproduction page shows (byKind, slack). */
function conformanceView(report, listing) {
  return { conforms: report.conforms, byKind: report.byKind, slack: slack(report, listing), status: report.status };
}

/** Clopper–Pearson-free summary: the rate and its 1σ binomial error. */
const rate = (k, n) => ({ k, n, value: n ? k / n : 0, sigma: n ? Math.sqrt(Math.max(k, 1) * (1 - k / n)) / n : 0 });

/**
 * Google's cultivation on the Willow twin: the three circuits of Figs. 2–4 run on RISC-Q; the
 * noise simulation of Figs. 2–3 with the paper's SI1000 model; the FormalRV call whose factory is
 * the Fig. 4 circuit (injection, cultivation, graft into the distance-5 code on 54 qubits).
 */
const GOOGLE_PUBLISHED = {
  "fig2-cultivation": "–",
  "fig3-kickback": "kept 8%, error 1–2×10⁻⁴ (experiment)",
  "fig4-graft-N2": "54 qubits; decoded with Tesseract",
};

/**
 * One of Google's circuits on the Willow twin, as a row of the reproduction page and of the
 * design page: the RISC-Q run, its conformance, its track (device and controller), and with
 * `shots` the SI1000 noise simulation. `edits` change the twin (WILLOW_EDITS).
 */
export async function googleRow(name, { shots = 0, p = 2.3e-3, edits = {}, qubitsPerCore = 1, outcomes: given } = {}) {
  const circuit = mc.googleCircuit(name);
  const counts = mc.counts(circuit);
  // The bits the readout returns: a state-vector shot with the real T gates where it fits,
  // else a noiseless shot of the Clifford proxy.
  let outcomes, sv;
  if (circuit.qubits.length <= 16) {
    let seed = 11;
    const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    sv = mc.runTransmonCircuit(circuit, { rng, trace: true });
    outcomes = sv.record;
  } else outcomes = given ?? (await stim({ mode: "sample", stim: mc.stimText(circuit), seed: 3 })).bits;
  const run = await runWillow(circuit, { outcomes, edits, qubitsPerCore });
  let noise = null;
  if (shots && name !== "fig4-graft-N2") {
    const r = await stim({ mode: "postselect", stim: mc.stimText(circuit), noise: { model: "si1000", p }, shots, seed: 7 });
    noise = { p, shots: r.shots, kept: rate(r.kept, r.shots), error: rate(r.flipped, r.kept), stim: r.stim };
  }
  const row = {
    label: "d = " + (name === "fig4-graft-N2" ? 5 : 3) + " · " + mc.GOOGLE_CIRCUITS[name],
    distance: name === "fig4-graft-N2" ? 5 : 3, basis: mc.GOOGLE_CIRCUITS[name], circuit: name, view: "circuit",
    qubits: counts.qubits, ops: run.schedule.listing.ops.length, twoQubit: counts.twoQubit, measurements: counts.measurements, detectors: counts.detectors,
    tagged: counts.tagged, moments: counts.moments, circuitNs: run.schedule.makespanNs, bitAfterWindowNs: run.report.bitAfterWindowNs,
    ...conformanceView(run.report, run.schedule.listing), readBack: run.readBack, cores: run.cores, qubitsPerCore, pulses: run.pulses,
    couplers: run.device.couplers.length, noise, outcomes,
    columns: {
      "On the twin (µs)": (run.schedule.makespanNs / 1000).toFixed(2),
      "RISC-Q cores": String(run.cores),
      "Kept (SI1000, p = 2.3×10⁻³)": noise ? pct(noise.kept.value) : "–",
      "Error among kept (sim.)": noise ? sci(noise.error.value) + " (" + noise.error.k + " of " + noise.error.n + ")" : "–",
      "Paper": GOOGLE_PUBLISHED[name],
    },
    track: { ...willowTrack(run), controller: run.controller },
    steps: debugSteps(run, (k) => (sv ? { state: { x: sv.steps[k].x, z: sv.steps[k].z }, bits: sv.steps[k].bits, detectors: sv.steps[k].detectors } : {})),
    qubitLabels: circuit.qubits.map((q, i) => i + " (" + q.x + "," + q.y + ")"),
  };
  return { row, run };
}

/**
 * The debugger's steps of a run: one per moment of the circuit, with its time window, the
 * operations in it and whether each ran inside its window on the twin, the interval the Lean
 * trace shows for them, and what `extra(k)` adds (the state after the moment).
 */
export function debugSteps(run, extra = () => ({})) {
  const rows = new Map(run.report.rows.map((r) => [r.uid, r]));
  const byMoment = new Map();
  for (const op of run.schedule.listing.ops) (byMoment.get(op.moment) ?? byMoment.set(op.moment, []).get(op.moment)).push(op);
  return run.schedule.moments.map((m) => {
    const ops = byMoment.get(m.index) ?? [];
    const rs = ops.map((o) => rows.get(o.uid)).filter(Boolean);
    const hw = rs.filter((r) => r.hardwareNs);
    const gates = [...new Set((m.ops ?? []).map((o) => o.gate + (o.tag ? "[" + o.tag + "]" : "")))].join(", ");
    return {
      k: m.index, t0: m.start, t1: m.start + m.dur, label: m.label ?? gates, kind: m.kind, moveUm: m.moveUm,
      ops: ops.length > 12 ? [...ops.slice(0, 12).map((o) => o.text), "… " + (ops.length - 12) + " more"] : ops.map((o) => o.text),
      count: ops.length, inWindow: rs.filter((r) => r.ok).length,
      hardware: hw.length ? [Math.min(...hw.map((r) => r.hardwareNs[0])), Math.max(...hw.map((r) => r.hardwareNs[1]))] : null,
      ...extra(m.index),
    };
  });
}

/**
 * Google's cultivation on the Willow twin: the three circuits of Figs. 2–4 run on RISC-Q; the
 * noise simulation of Figs. 2–3 with the paper's SI1000 model; the FormalRV call whose factory is
 * the Fig. 4 circuit (injection, cultivation, graft into the distance-5 code on 54 qubits).
 */
export async function googleCultivation({ shots = 2_000_000, sweepShots = 0, dir = join(tmpdir(), "quantumos-cultivation-" + process.pid) } = {}) {
  const rows = [];
  let factoryRun;
  for (const name of ["fig2-cultivation", "fig3-kickback", "fig4-graft-N2"]) {
    const { row, run } = await googleRow(name, { shots });
    if (name === "fig4-graft-N2") factoryRun = run;
    rows.push(row);
  }
  // The p³ law of the kickback circuit (Supplementary Fig. S19): error among kept shots against p.
  const sweep = [];
  if (sweepShots) for (const p of [1.5e-3, 2.3e-3, 3e-3, 4e-3]) {
    const r = await stim({ mode: "postselect", stim: mc.stimText(mc.googleCircuit("fig3-kickback")), noise: { model: "si1000", p }, shots: sweepShots, seed: 17 });
    sweep.push({ p, shots: r.shots, kept: rate(r.kept, r.shots), error: rate(r.flipped, r.kept) });
  }
  // The system call: a T gate on a distance-5 surface-code block, served by the Fig. 4 factory.
  const d = 5, n = d * d, graft = rows.find((r) => r.circuit === "fig4-graft-N2"), prep = rows.find((r) => r.circuit === "fig2-cultivation");
  const dur = factoryRun.schedule.durations;
  const latency = Math.ceil(graft.circuitNs / 2) * 2;
  const call = await systemCall({
    code: "surface", distance: d, gridNs: 2, dir: join(dir, "call"),
    factory: { contract: { output_qubits: n, workspace_qubits: graft.qubits - n, latency, gates: graft.qubits, decoders: 1,
      classical_data_bandwidth: Math.ceil((1000 * graft.measurements) / latency), qubit_routing_bandwidth: 0 } },
    durations: {
      gate1q_ns: v(dur.pulseNs, "twin", "35 ns XY pulse on the 2 ns grid"), gate2q_ns: v(2 * dur.pulseNs + dur.czNs, "twin", "CNOT = H·CZ·H, each 36 ns"),
      measure_ns: v(dur.readoutNs, "twin", "readout"), reset_ns: v(dur.resetNs, "twin", "reset"), route_latency_ns: v(2, "twin", "a coupler for every gated pair: a route needs no action"),
      magic_state_latency_ns: v(latency, "twin", "the Fig. 4 circuit (injection, cultivation, graft, N = 2) on the Willow twin"),
    },
    capacities: {
      qubits: v(105, "published", "Willow's 105 transmons"), factories: v(1, "twin", "one cultivation region"), max_parallel_gates: v(105, "twin", "every transmon has its own drive"),
      decoders: v(1, "twin", "one decoder unit"), classical_data_bandwidth: v(500, "twin", "board hub: one bit per batch at 500 MHz"),
      qubit_routing_bandwidth: v(Math.ceil((1000 * 105) / 2), "twin", "every site in a route at once"), ancilla_bandwidth: v(Math.ceil((1000 * 105) / dur.resetNs), "twin", "every site reset at once"),
    },
  });
  const keep = prep.noise.kept.value;
  return {
    device: willowTwin(mc.googleCircuit("fig3-kickback")), rows, sweep, call,
    factory: { circuit: "fig4-graft-N2", latencyNs: latency, qubits: graft.qubits, acceptance: keep, expectedNs: Math.round(latency / keep),
      note: "One attempt is the Fig. 4 circuit on the twin. The paper keeps an attempt when no detector before the graft fires; the kept fraction used here is that of the Fig. 2 circuit (injection and cultivation, every detector), simulated with SI1000. FormalRV's factory contract has a fixed latency and no acceptance probability." },
  };
}

/**
 * QuEra's distillation on the Gemini twin: the d = 3 and d = 5 factories run on RISC-Q; the
 * injected and distilled fidelities and the acceptance from the noise learned with Stim on the
 * paper's error model, applied to the exact 5-qubit logical channel; the FormalRV call whose
 * factory is the d = 3 circuit (the Steane code is FormalRV's d = 3 color code).
 */
/**
 * One of QuEra's factories on the Gemini twin, as a row of the reproduction page and of the design
 * page: the RISC-Q run, its conformance, its track, and with `shots` the injected and distilled
 * fidelities from the noise learned with Stim. `edits` change the twin (GEMINI_EDITS).
 */
export async function queraRow(d, { shots = 0, edits = {}, outcomes: given } = {}) {
  const twin = geminiTwin(edits), noise = queraNoise(twin);
  const code = mc.encoderCode(d), c = mc.QUERA_CODES[d];
  // Rows of atoms as code blocks. In the factory the output (row 1) is decoded after the four
  // syndrome rows (0, 2, 3, 4) are postselected, so its decoder is trained on those shots.
  const blocks = (n, stage) => [0, 1, 2, 3, 4].map((r) => ({ atoms: [...Array(n).keys()].map((q) => r * n + q), checks: code.xChecks, logical: code.logicalX,
    ...(stage === "factory" && r === 1 ? { given: [0, 2, 3, 4] } : {}) }));
  // Run the factory (Z basis) on RISC-Q with a noiseless shot as the readout.
  const factory = mc.queraFactory(d, { basis: "Z" });
  const sample = given ?? (await stim({ mode: "sample", stim: mc.stimText(factory, { drives: true }), seed: 5 })).bits;
  const run = await runGemini(factory, { outcomes: sample, twin });
  let inj = null, dist = null;
  if (shots) {
    // Noise: injected fidelity (encoding, then tomography) and the factory, per basis.
    const learn = async (stage, basis) => {
      const circ = mc.queraFactory(d, { basis, stage });
      const sched = atomSchedule(circ, twin);
      const momentsNs = circ.moments.map((_, k) => sched.moments.find((x) => x.index === k)?.dur ?? 0);
      return stim({ mode: "frames", stim: mc.stimText(circ, { drives: true }), noise, moments_ns: momentsNs, blocks: blocks(c.n, stage), shots, train: 2 * shots, seed: 13 });
    };
    const injected = {}, factoryFrames = {};
    for (const B of ["X", "Y", "Z"]) {
      injected[B] = await learn("injection", B);
      factoryFrames[B] = await learn("factory", B);
    }
    inj = injectedFidelity(injected);
    dist = distilledFidelity(factoryFrames);
  }
  const tw = twin.published;
  const paper = d === 3 ? [tw.injectedD3.value, tw.distilledD3.value] : [tw.injectedD5.value, tw.distilledD5.value];
  const row = {
    label: "d = " + d + " · " + c.name,
    distance: d, basis: c.name, view: "circuit", qubits: 5 * c.n, ops: run.schedule.listing.ops.length, circuitNs: run.schedule.makespanNs, bitAfterWindowNs: run.report.bitAfterWindowNs,
    ...conformanceView(run.report, run.schedule.listing), readBack: run.readBack, cores: run.cores, pulses: run.pulses,
    encoderLayers: c.layers, injected: inj, distilled: dist, shots, moments: run.schedule.moments, outcomes: sample,
    columns: {
      "On the twin (ms)": (run.schedule.makespanNs / 1e6).toFixed(3),
      "RISC-Q cores": String(run.cores),
      "Injected, corrected (sim. / paper)": (inj ? pct(inj.corrected) : "–") + " / " + pct(paper[0]),
      "Distilled (sim. / paper)": (dist ? pct(dist.fidelity) : "–") + " / " + pct(paper[1]),
      "Factory accepts (sim.)": dist ? pct(dist.acceptance.value, 2) : "–",
    },
    track: { ...geminiTrack(run, factory), controller: run.controller },
    // The logical qubits through Fig. 3a: from the end of encoding on, each moment shows the
    // five Bloch vectors after the last distillation layer it completes.
    steps: (() => {
      const logical = mc.distillationSteps();
      let at = -1;
      return debugSteps(run, (k) => {
        const label = factory.moments[k].label ?? "";
        if (/after the last encoding layer/.test(label) || (at < 0 && /^distillation CZ round 1/.test(label))) at = Math.max(at, 0);
        const i = logical.findIndex((l, j) => j > 0 && label.startsWith(l.label));
        if (i > 0) at = i;
        return at >= 0 ? { logical: logical[at] } : {};
      });
    })(),
  };
  return { row, run, twin, noise };
}

/**
 * QuEra's distillation on the Gemini twin: the d = 3 and d = 5 factories run on RISC-Q; the
 * injected and distilled fidelities and the acceptance from the noise learned with Stim on the
 * paper's error model, applied to the exact 5-qubit logical channel; the FormalRV call whose
 * factory is the d = 3 circuit (the Steane code is FormalRV's d = 3 color code).
 */
export async function queraDistillation({ shots = 200_000, dir = join(tmpdir(), "quantumos-distillation-" + process.pid), distances = [3, 5] } = {}) {
  const twin = geminiTwin(), noise = queraNoise(twin);
  const rows = [];
  for (const d of distances) rows.push((await queraRow(d, { shots })).row);
  // The system call: one T gate on a Steane (d = 3 color code) block, served by the d = 3 factory.
  const d3 = rows.find((r) => r.distance === 3);
  const sched = atomSchedule(mc.queraFactory(3), twin);
  const local = sched.moments.find((m) => m.kind === "local Raman")?.dur ?? 1000;
  const czLayer = Math.max(...sched.moments.filter((m) => m.kind === "CZ layer").map((m) => m.dur));
  const latency = Math.ceil(d3.circuitNs / 10) * 10;
  let call;
  try {
    call = await systemCall({
      code: "steane", distance: 3, gridNs: 10, dir: join(dir, "call"),
      factory: { contract: { output_qubits: 7, workspace_qubits: 28, latency, gates: 35, decoders: 1,
        classical_data_bandwidth: Math.max(1, Math.ceil((1000 * 35) / latency)), qubit_routing_bandwidth: 1 } },
      durations: {
        gate1q_ns: v(local, "twin", "a local Raman π/2 at 250 kHz"), gate2q_ns: v(2 * local + czLayer, "twin", "CNOT = two local rotations and the longest CZ layer (moves, Rydberg pulse, echo)"),
        measure_ns: v(up10(twin.durations.imagingNs.value), "twin", "imaging"), reset_ns: v(up10(twin.durations.pumpNs.value), "twin", "optical pumping"),
        route_latency_ns: v(czLayer, "twin", "a route is the AOD move of a CZ layer"),
        magic_state_latency_ns: v(latency, "twin", "the d = 3 factory on the Gemini twin"),
      },
      capacities: {
        qubits: v(85, "published", "the 17 × 5 SLM grid"), factories: v(1, "twin", "one factory"), max_parallel_gates: v(85, "twin", "global pulses act on every atom"),
        decoders: v(1, "twin", "one decoder unit"), classical_data_bandwidth: v(100, "twin", "board hub: one bit per batch at 100 MHz"),
        qubit_routing_bandwidth: v(85, "twin", "one AOD job moves every atom of a layer"), ancilla_bandwidth: v(85, "twin", "global optical pumping"),
      },
    });
  } catch (error) {
    call = { error: error.message.split("\n")[0].slice(0, 400) };
  }
  const acc = d3.distilled.acceptance.value;
  return {
    device: { id: twin.id, title: twin.title, basis: twin.basis, durations: twin.durations, published: twin.published, rabi: twin.rabi, errors: twin.errors, pitchUm: twin.pitchUm, grid: twin.grid, noise },
    rows, call,
    factory: { distance: 3, latencyNs: latency, qubits: 35, acceptance: acc, expectedNs: Math.round(latency / acc),
      note: "One attempt of the factory takes the d = 3 circuit's time; it is kept for the accepted distillation syndrome and perfect stabilizers on the four syndrome qubits. FormalRV's factory contract has a fixed latency and no acceptance probability." },
  };
}

/**
 * Injected-state fidelity from the learned frames of the injection circuit, per basis: for the
 * five rows, the flip of each row's logical readout raw, after the lookup decoder, and among
 * shots with a perfect syndrome. The ideal injected state is the magic state (1,1,1)/√3.
 */
export function injectedFidelity(byBasis) {
  const out = { raw: [], corrected: [], postselected: [], kept: 0 };
  ["X", "Y", "Z"].forEach((B, i) => {
    let n = 0, rawFlip = 0, decFlip = 0, psN = 0, psFlip = 0;
    for (const [trivial, raw, dec, count] of byBasis[B].histogram) for (let r = 0; r < raw.length; r++) {
      n += count;
      rawFlip += raw[r] === "1" ? count : 0;
      decFlip += dec[r] !== "0" ? count : 0; // a syndrome beyond the table counts as a failure
      if (trivial[r] === "1") { psN += count; psFlip += raw[r] === "1" ? count : 0; }
    }
    const m = mc.MAGIC[i];
    out.raw.push(m * (1 - 2 * rawFlip / n)); out.corrected.push(m * (1 - 2 * decFlip / n)); out.postselected.push(m * (1 - 2 * psFlip / psN));
    out.kept += psN / n / 3;
  });
  return { bloch: out.corrected, raw: mc.fidelity(out.raw, mc.MAGIC), corrected: mc.fidelity(out.corrected, mc.MAGIC), postselected: mc.fidelity(out.postselected, mc.MAGIC), keptFraction: out.kept };
}

/**
 * Distilled fidelity and acceptance: the exact 5-qubit channel of Fig. 3a (magic-circuits
 * distill), combined with the learned frames of the factory. A shot survives when the four
 * syndrome rows show perfect stabilizers; its syndrome-row flips g change which ideal outcome
 * the accepted readout "1011" was, and its decoded output flip ℓ flips the output readout.
 * Input states: the magic state (1,1,1)/√3 (the frames carry all physical errors).
 */
export function distilledFidelity(byBasis) {
  const ideal = mc.distill();
  const ACCEPT = "1011";
  // Physical rows: row 1 is LQ1 (output); rows 0, 2, 3, 4 are LQ2..LQ5 (Extended Data Fig. 1).
  const syndromeRows = [0, 2, 3, 4], outputRow = 1;
  const bloch = [], perBasis = {};
  let acceptance = 0;
  ["X", "Y", "Z"].forEach((B, i) => {
    let weight = 0, sum = 0, n = 0;
    for (const [trivial, raw, dec, count] of byBasis[B].histogram) {
      n += count;
      if (!syndromeRows.every((r) => trivial[r] === "1")) continue;
      const g = syndromeRows.map((r) => Number(raw[r]));
      const truth = ACCEPT.split("").map((c, k) => String(Number(c) ^ g[k])).join("");
      const o = ideal[truth];
      if (!o) continue;
      const flip = dec[outputRow] === "1" || dec[outputRow] === "2" ? -1 : 1;
      weight += count * o.p;
      sum += count * o.p * o.bloch[i] * flip;
    }
    bloch.push(sum / weight);
    perBasis[B] = { acceptance: weight / n };
    acceptance += weight / n / 3;
  });
  return { bloch, fidelity: mc.fidelity(bloch, mc.MAGIC), acceptance: { value: acceptance, ideal: ideal[ACCEPT].p }, perBasis };
}

/* ================================================================== the design pages */

/**
 * The readout bits a stored run used (a noiseless Stim shot), so that a rerun of an edited twin
 * returns the same bits without Python; only the noise simulation needs Stim on the server.
 */
function storedOutcomes(id, match) {
  try {
    const data = JSON.parse(readFileSync(join(REPO, "validation", "ftqvm", "papers", id + ".json"), "utf8"));
    return data.rows.find(match)?.outcomes;
  } catch {
    return undefined;
  }
}

/** Parameter fields of a design page from an edit table and the twin's own values and sources. */
function fields(table, values, group) {
  return Object.entries(table).map(([key, f]) => ({ key, label: f.label, value: values[key].value, unit: f.unit || undefined, min: f.min, max: f.max, step: f.step, source: values[key].source, group }));
}

/**
 * What /reproduce/<id>/design shows and reruns for the two magic-state reproductions (the page
 * and route belong to the shared design page; server.mjs dispatches here for these ids):
 *   params()      the fields a user may change: which circuit, the twin's parameters with the
 *                 paper's values and their sources, the controller, and the noise simulation
 *   run(params)   the circuit on the edited twin through RISC-Q, as { rows, design? }; each row
 *                 has the conformance, the columns, and the track the 3D view plays (device and
 *                 controller). A Willow run also returns its chip as a hardware design document.
 */
export const MAGIC_DESIGNS = {
  "google-cultivation-2025": {
    intro: "The program is the paper's own circuit, qubit for qubit, as its supplement links it: injection, cultivation and, for Figure 4, the graft into the distance-5 code. Change the gate, readout and reset durations or how many transmons one RISC-Q core drives, and run it again: every pulse is timed on the edited chip, played in the Lean model of the board, and checked against its window.",
    params() {
      const t = willowTwin(mc.googleCircuit("fig3-kickback")).durations;
      const values = {
        gate1qNs: t.x90Ns, czNs: t.czNs, readoutNs: t.readoutNs, resetNs: t.resetNs,
      };
      return [
        { key: "circuit", label: "Circuit", value: "fig3-kickback", group: "Program", source: mc.GOOGLE_SOURCE,
          options: ["fig2-cultivation", "fig3-kickback", "fig4-graft-N2"].map((c) => ({ value: c, label: mc.GOOGLE_CIRCUITS[c] })) },
        ...fields({ gate1qNs: WILLOW_EDITS.gate1qNs, czNs: WILLOW_EDITS.czNs, readoutNs: WILLOW_EDITS.readoutNs, resetNs: WILLOW_EDITS.resetNs }, values, "Device"),
        { key: "shots", label: "Noise simulation (SI1000, p = 2.3×10⁻³)", value: 0, group: "Noise", source: rosenfeld + ", the paper's simulation model",
          options: [{ value: 0, label: "none" }, { value: 1_000_000, label: "10⁶ shots (a few seconds)" }] },
      ];
    },
    async run(params = {}) {
      const name = mc.GOOGLE_CIRCUITS[params.circuit] ? params.circuit : "fig3-kickback";
      const edits = Object.fromEntries(["gate1qNs", "czNs", "readoutNs", "resetNs"].filter((k) => params[k] !== undefined).map((k) => [k, Number(params[k])]));
      const outcomes = storedOutcomes("google-cultivation-2025", (r) => r.circuit === name);
      const { row, run } = await googleRow(name, { edits, shots: Number(params.shots ?? 0), outcomes });
      return { rows: [row], design: run.design };
    },
  },
  "quera-distillation-2025": {
    intro: "The program is the paper's factory: five magic states injected into color codes by the encoders of its Methods, then the 5-to-1 circuit of Fig. 3a on whole rows of atoms. Change the array (pitch, gate-pair separation), the lasers (Rabi frequencies, Rydberg pulse), the AOD moves or the readout and run it again: the moves, pulses and imaging are timed on the edited array, played in the Lean model of the board, and checked against their windows. With the noise simulation on, the fidelities follow the edited durations through dephasing.",
    params() {
      const t = geminiTwin();
      const values = {
        pitchUm: t.pitchUm, gateUm: t.gateUm, globalHz: t.rabi.global, localHz: t.rabi.local, czNs: t.durations.czNs,
        transferNs: t.durations.transferNs, accel: t.accel, imagingNs: t.durations.imagingNs, pumpNs: t.durations.pumpNs,
      };
      return [
        { key: "d", label: "Color-code distance", value: 3, group: "Program", source: QUERA_SOURCE_TEXT,
          options: [{ value: 3, label: "d = 3, 35 atoms" }, { value: 5, label: "d = 5, 85 atoms" }] },
        ...fields({ pitchUm: GEMINI_EDITS.pitchUm, gateUm: GEMINI_EDITS.gateUm }, values, "Array"),
        ...fields({ globalHz: GEMINI_EDITS.globalHz, localHz: GEMINI_EDITS.localHz, czNs: GEMINI_EDITS.czNs }, values, "Lasers"),
        ...fields({ transferNs: GEMINI_EDITS.transferNs, accel: GEMINI_EDITS.accel }, values, "AOD moves"),
        ...fields({ imagingNs: GEMINI_EDITS.imagingNs, pumpNs: GEMINI_EDITS.pumpNs }, values, "Readout and initialization"),
        { key: "shots", label: "Noise simulation (the paper's error model)", value: 0, group: "Noise", source: QUERA_SOURCE_TEXT + ", Methods, \"Error model\"",
          options: [{ value: 0, label: "none" }, { value: 20_000, label: "2×10⁴ shots per basis (about half a minute)" }] },
      ];
    },
    async run(params = {}) {
      const d = Number(params.d) === 5 ? 5 : 3;
      const edits = Object.fromEntries(Object.keys(GEMINI_EDITS).filter((k) => params[k] !== undefined).map((k) => [k, Number(params[k])]));
      const { row } = await queraRow(d, { edits, shots: Number(params.shots ?? 0), outcomes: storedOutcomes("quera-distillation-2025", (r) => r.distance === d) });
      return { rows: [row] };
    },
  },
};

const QUERA_SOURCE_TEXT = mc.QUERA_SOURCE;

/* ================================================================== command line */

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const which = process.argv[2] ?? "google";
  const out = join(REPO, "validation", "ftqvm", "papers");
  const { byId } = await import("./magic-reproductions.mjs");
  const write = (id, result) => {
    writeFileSync(join(out, id + ".json"), JSON.stringify({ meta: byId(id), generated: new Date().toISOString(), ...result }, null, 1));
    console.log("wrote", join(out, id + ".json"));
  };
  if (which === "google") write("google-cultivation-2025", await googleCultivation({ shots: Number(process.argv[3] ?? 2e6), sweepShots: Number(process.argv[4] ?? 0) }));
  if (which === "quera") write("quera-distillation-2025", await queraDistillation({ shots: Number(process.argv[3] ?? 2e5) }));
}

void quantile;
