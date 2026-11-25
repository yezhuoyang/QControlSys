// Spec derivation: the system specification FormalRV compiles against, taken from the machine.
//
// The loop: write a spec → FormalRV compiles the program and its VM admits the listing → place
// the listing and build the platform's design for it → run it time-triggered → read, from the
// trace, how long each kind of operation took on the hardware → raise every duration of the
// spec that the hardware exceeded → repeat until the listing conforms. Durations only grow, so
// the loop ends; a value is raised to the controller's batch grid.
//
// A platform is an adapter (riscq/ftqvm/platforms.mjs):
//   { name, gridNs, place(listing, { distance }), design(listing, placement),
//     run(listing, placement, design, { outcomes }) → { report, result },
//     capacities(design, placement, durations) → machine capacity fields with their sources }.
//
// Each value says where it came from: "measured" (the trace's maximum, with the iteration that
// gave it), "derived" (a count of the machine's parts), or "provisional" (still the base
// machine's value, for what this machine does not realize yet).
import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as formalrv from "./formalrv.mjs";
import * as specText from "./spec.mjs";

/** Which machine duration each listing operation is charged (FormalRV's TIMINGS). */
export const FIELD_OF = Object.freeze({
  H: "gate1q_ns", S: "gate1q_ns", Sdg: "gate1q_ns", X: "gate1q_ns", Z: "gate1q_ns",
  CNOT: "gate2q_ns", CZ: "gate2q_ns", CY: "gate2q_ns",
  measure: "measure_ns", request_ancilla: "reset_ns", route: "route_latency_ns",
  decode_syndrome: "decoder_latency_ns", pauli_frame_update: "pauli_frame_update_ns", parity: "pauli_frame_update_ns",
});
const DURATIONS = [...new Set([...Object.values(FIELD_OF), "magic_state_latency_ns"])];

const up = (ns, gridNs) => Math.max(gridNs, Math.ceil(ns / gridNs) * gridNs);

/** Hardware time an operation needed, from a conformance row: pulses, and for a measurement its bit. */
function needed(row) {
  const pulses = row.hardwareNs ? row.hardwareNs[1] - row.start : 0;
  return Math.max(pulses, row.bitNs !== undefined ? row.bitNs - row.start : 0);
}

/** Per machine field: the longest time any listing operation of that field needed. */
export function measuredDurations(report) {
  const out = {};
  for (const row of report.rows) {
    const field = FIELD_OF[row.kind];
    // An operation the hardware never completed (a bit that was not measured) measures nothing.
    if (!field || !Number.isFinite(needed(row))) continue;
    out[field] = Math.max(out[field] ?? 0, needed(row));
  }
  return out;
}

/** Per kind of operation: min, median and max hardware time needed, against the listing's duration. */
export function slack(report, listing) {
  const declared = new Map(listing.ops.map((o) => [o.uid, o.duration]));
  const byKind = {};
  for (const r of report.rows) {
    (byKind[r.kind] ??= []).push({ need: needed(r), declared: declared.get(r.uid) });
  }
  const q = (xs, f) => xs[Math.floor(f * (xs.length - 1))];
  return Object.fromEntries(Object.entries(byKind).map(([k, xs]) => {
    const need = xs.map((x) => x.need).sort((a, b) => a - b);
    return [k, { count: xs.length, minNs: q(need, 0), medianNs: q(need, 0.5), maxNs: q(need, 1), declaredNs: Math.max(...xs.map((x) => x.declared)) }];
  }));
}

/**
 * A spec: durations as given, capacities from the platform's design, contracts for the round
 * gadgets and factories as given.
 */
export function specFor(durations, capacities, base, { gadgets = [], factories = {}, runtimeNs = 1_000_000_000, gridNs = 2 } = {}) {
  const v = (value, source, note) => ({ value, source, ...(note ? { note } : {}) });
  const dur = (field) => (durations[field]
    ? v(up(durations[field].value, gridNs), durations[field].source, durations[field].note)
    : v(up(base[field], gridNs), "provisional", "base machine value, rounded up to the " + gridNs + " ns grid"));
  const machine = { ...capacities, ...Object.fromEntries(DURATIONS.map((f) => [f, dur(f)])) };
  const whole = {
    qubits: machine.qubits, runtime: v(runtimeNs, "provisional"), gates: machine.max_parallel_gates, factories: machine.factories, decoders: machine.decoders,
    classical_data_bandwidth: machine.classical_data_bandwidth, qubit_routing_bandwidth: machine.qubit_routing_bandwidth, ancilla_bandwidth: machine.ancilla_bandwidth,
  };
  return {
    machine, factories,
    program: { qubits_min: v(0, "provisional"), qubits: machine.qubits, runtime_min: v(0, "provisional"), runtime: v(runtimeNs, "provisional") },
    contracts: Object.fromEntries(gadgets.map((name) => [name, whole])),
  };
}

const GATES = new Set(["H", "S", "Sdg", "X", "Z", "CNOT", "CZ", "CY"]);
const rate = (n, d) => (d > 0 ? Math.ceil((1000 * n) / d) : 0); // FormalRV's r(N, D), items/µs

/** Peak of summed loads over half-open intervals [from, to): ends are processed before starts. */
function peak(intervals) {
  const ev = [];
  for (const { from, to, load } of intervals) if (to > from && load) ev.push([from, load], [to, -load]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, best = 0;
  for (const [, d] of ev) best = Math.max(best, (cur += d));
  return best;
}

/**
 * Resource contracts of the round gadgets, from a conforming run. For each gadget, over all its
 * calls: the sites its operations touch, its span, and the peak of every service with FormalRV's
 * charging rule (each operation holds its demand over its listing interval, r(N, D) for rates).
 * `hardware` gives the same peaks over the intervals the trace shows the hardware busy, and the
 * span to the last pulse or bit: what the contract leaves unused.
 */
export function roundContracts(listing, placement, report) {
  const rows = new Map(report.rows.map((r) => [r.uid, r]));
  const byName = new Map();
  for (const call of listing.calls) {
    const ops = listing.ops.filter((o) => call.ops.includes(o.uid));
    const measure = (intervalOf) => {
      const iv = (o, load) => ({ ...intervalOf(o), load });
      return {
        gates: peak(ops.filter((o) => GATES.has(o.kind)).map((o) => iv(o, 1))),
        decoders: peak(ops.filter((o) => o.kind === "decode_syndrome").map((o) => iv(o, 1))),
        factories: peak(ops.filter((o) => o.kind === "request_magic").map((o) => iv(o, 1))),
        classical_data_bandwidth: peak(ops.filter((o) => o.kind === "measure").map((o) => iv(o, rate(1, o.duration)))),
        qubit_routing_bandwidth: peak(ops.filter((o) => o.kind === "route").map((o) => iv(o, rate(o.qubits.length, o.duration)))),
        ancilla_bandwidth: peak(ops.filter((o) => o.kind === "request_ancilla").map((o) => iv(o, rate(o.qubits.length, o.duration)))),
      };
    };
    const listed = measure((o) => ({ from: o.start, to: o.end }));
    const busy = measure((o) => {
      const r = rows.get(o.uid);
      return { from: o.start, to: Math.max(r?.hardwareNs?.[1] ?? o.start, r?.bitNs ?? o.start) };
    });
    const sites = new Set(ops.flatMap((o) => o.qubits.map((a) => placement.siteOf(a))));
    const hwEnd = Math.max(call.start, ...ops.map((o) => Math.max(rows.get(o.uid)?.hardwareNs?.[1] ?? 0, rows.get(o.uid)?.bitNs ?? 0)));
    const c = { qubits: sites.size, runtime: call.end - call.start, ...listed, hardware: { ...busy, runtime: hwEnd - call.start } };
    const prev = byName.get(call.name);
    byName.set(call.name, prev ? Object.fromEntries(Object.entries(c).map(([k, v]) =>
      [k, k === "hardware" ? Object.fromEntries(Object.entries(v).map(([h, x]) => [h, Math.max(x, prev.hardware[h])])) : Math.max(v, prev[k])])) : c);
  }
  return Object.fromEntries(byName);
}

/**
 * Derive a spec for a FormalRV program on a platform design, by the loop above.
 * options: { platform, qppm, specialize, code, distance, baseMachine (a FormalRV machine file:
 *            provisional values and factory contracts), maxIterations, dir, outcomes, contracts }.
 * Returns { iterations: [{ spec, verdict, report, sites, listing, placement, design, ... }], final }.
 */
export async function deriveSpec({ platform, qppm, qec: qecSource, specialize = {}, code = "surface", distance = 3, baseMachine,
  maxIterations = 5, dir = join(tmpdir(), "quantumos-derive-" + process.pid + "-" + Date.now()), outcomes = {}, contracts = true, staged = false, compileOptions = [] }) {
  const baseText = readFileSync(baseMachine, "utf8");
  const base = specText.parseMachine(baseText);
  let factories = specText.parseFactories(baseText);
  const gridNs = platform.gridNs;
  // First guess: the platform's own durations when it states them (its profile), else the base
  // machine's, marked provisional; the trace replaces each one it covers.
  let durations = platform.initialDurations ? platform.initialDurations() : {};
  let capacities = Object.fromEntries(Object.entries(specText.MACHINE_FIELDS).filter(([, u]) => u !== "ns").map(([f]) =>
    [f, { value: base[f], source: "provisional", note: "base machine value" }]));
  const qec = join(dir, "program.qec");
  // A program given at the encoded level (.qec) is compiled as it is; a .qppm is prepared first.
  if (qecSource) { mkdirSync(dir, { recursive: true }); copyFileSync(qecSource, qec); }
  else await formalrv.prepareQec(qppm, qec, { code, distance, specialize });
  // A parameter the program declares and the caller did not fix takes 1, as FormalRV's README does.
  const declared = /^params\s+(.+)$/m.exec(readFileSync(qec, "utf8"));
  const missing = declared ? declared[1].split(",").map((x) => x.trim()).filter((k) => !(k in specialize)) : [];
  // The program's own witness first, else 1.
  const witness = Object.fromEntries((/^witness\s+(.+)$/m.exec(readFileSync(qec, "utf8"))?.[1] ?? "").split(",").map((x) => x.trim().split("=")).filter((x) => x.length === 2).map(([k, v]) => [k, Number(v)]));
  if (missing.length) await formalrv.prepareQec(qppm, qec, { code, distance, specialize: { ...specialize, ...Object.fromEntries(missing.map((k) => [k, witness[k] ?? 1])) } });
  const gadgets = await formalrv.discoverGadgets(qec, { dir, name: "discover", staged, options: compileOptions,
    machine: specText.machineText({ machine: specFor({}, capacities, base, { gridNs }).machine, factories }),
    sysspecFor: (names) => specText.sysspecText(specFor({}, capacities, base, { gadgets: names, gridNs })) });
  const iterations = [];
  let factoryMeasured = false;
  const attempt = async (spec, name) => {
    const built = await formalrv.build({ qec, spec: specText.files(spec), name, dir, staged, options: compileOptions });
    if (built.verdict.status !== "RESOURCE_VALIDATED") return { spec, verdict: built.verdict.status, verdictDetail: built.verdict, report: { conforms: false, rows: [], byKind: {} }, files: built.files, listing: built.listing };
    const placement = platform.place(built.listing, { distance });
    const design = platform.design(built.listing, placement);
    const { report, result } = await platform.run(built.listing, placement, design, { outcomes, distance });
    return { spec, verdict: built.verdict.status, sites: placement.sites.length, report, files: built.files, listing: built.listing, placement, design,
      makespanNs: Math.max(...built.listing.ops.map((o) => o.end)), batches: result?.summary?.elapsedBatches, slack: slack(report, built.listing) };
  };
  for (let i = 0; i < maxIterations; i++) {
    const it = await attempt(specFor(durations, capacities, base, { gadgets, factories, gridNs }), "iter" + i);
    iterations.push(it);
    if (it.verdict !== "RESOURCE_VALIDATED") throw Error("FormalRV's VM did not admit iteration " + i + ": " + JSON.stringify(it.verdictDetail).slice(0, 400));
    const measured = measuredDurations(it.report);
    let changed = i === 0;
    const next = { ...durations };
    for (const [field, ns] of Object.entries(measured)) {
      const value = up(ns, gridNs);
      const prev = durations[field];
      // A measured value replaces a provisional one; a measured value only ever grows.
      const measuredBefore = prev?.source === "measured";
      if (!prev || !measuredBefore || value > prev.value) {
        if (!prev || prev.value !== value || !measuredBefore) changed = true;
        next[field] = { value: measuredBefore ? Math.max(value, prev.value) : value, source: "measured", note: "longest " + field.replace(/_ns$/, "") + " in the trace of iteration " + i };
      }
    }
    // The factory: its latency is the longest request the trace shows (injection rounds and
    // their decode), its contract the injection circuit's footprint (riscq/ftqvm/sc-run.mjs).
    const magic = it.report.rows.filter((r) => r.kind === "request_magic");
    if (magic.length && magic.some((r) => Number.isFinite(needed(r)))) {
      const latency = up(Math.max(0, ...magic.map(needed).filter(Number.isFinite)), gridNs);
      const n = it.placement.n, rounds = it.placement.d;
      if (!factoryMeasured || latency > factories.factory.latency) {
        factoryMeasured = true;
        changed = true;
        factories = { ...factories, factory: {
          output_qubits: n, workspace_qubits: n - 1, latency, gates: n - 1, decoders: 1,
          classical_data_bandwidth: Math.ceil((1000 * (n - 1) * rounds) / latency), qubit_routing_bandwidth: 0 } };
        next.magic_state_latency_ns = { value: latency, source: "measured", note: "the injection factory's longest request in iteration " + i };
      }
    }
    durations = next;
    const nextCaps = platform.capacities(it.design, it.placement, durations);
    if (JSON.stringify(nextCaps) !== JSON.stringify(capacities)) changed = true;
    capacities = nextCaps;
    if (it.report.conforms && !changed) break;
  }
  // Contract pass: every called round gadget gets the footprint its calls showed, instead of
  // the whole machine. FormalRV compiles once more against it; the run must still conform.
  const last = iterations.at(-1);
  if (contracts && last.report.conforms && last.listing.calls.length) {
    const measured = roundContracts(last.listing, last.placement, last.report);
    const spec = structuredClone(last.spec);
    for (const [name, c] of Object.entries(measured)) {
      if (!spec.contracts[name]) continue;
      const note = "peak over the gadget's calls in the conforming run, FormalRV's charging rule";
      spec.contracts[name] = Object.fromEntries(Object.keys(specText.CONTRACT_FIELDS).map((k) => [k, { value: c[k], source: "measured", note }]));
    }
    const it = await attempt(spec, "contracts");
    iterations.push({ ...it, contracts: measured });
  }
  return { iterations, final: iterations.at(-1), gadgets };
}

/** The transmon platform with its default design: kept for the tests and the command line. */
export async function deriveTransmon(options) {
  const { transmon } = await import("./platforms.mjs");
  return deriveSpec({ platform: transmon(options.design ?? {}), ...options });
}
