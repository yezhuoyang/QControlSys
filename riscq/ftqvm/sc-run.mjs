// Execute a QSysASM listing on a transmon chip, time-triggered, and check the trace against it.
//
// Time-triggered: every listing operation starts its pulses at the listing's own start time
// (on the controller's batch grid), as RISC-Q's timed queues post them. Nothing is reordered or
// stretched. The trace then shows whether the hardware kept the listing's timing: an operation
// conforms when all its pulses lie inside [start, start + duration) of the listing, and a
// measurement when its bit is also known by then.
//
// Realization on this chip (riscq/ftqvm/sc-chip.mjs):
//   H S Sdg X Z     native drive pulses and virtual Z (superconducting.decompose)
//   CZ              the coupler's calibrated CZ, then its frame corrections
//   CNOT c, t       H(t) · CZ · H(t);  CY c, t = S†(t) · CNOT · S(t)
//   measure basis=Z the readout tone and demodulation window; basis=X adds H first
//   request_ancilla the reset pulse on every requested site, in parallel
//   release_ancilla nothing: the site is free for the next identity placed on it
//   route           nothing: the chip has a coupler for every pair the listing gates
//   pauli_frame_update  at its start, the frame core flips each named qubit's frame word
//                       (X = 1, Z = 2, Y = 3) in its memory; no pulse is played
//   parity              at its start, the frame core XORs the records into the output record
//   decode_syndrome     the decoder service (riscq/ftqvm/decoder.mjs): Helios union-find or the
//                       lookup decoder, compiled for the decoder cores and measured in the Lean
//                       model, started when the decode's bits have reached the decoder
// The frame core runs in the same Lean run as the pulses. The decoder cores run the compiled
// decoder in runs of their own (one per distinct syndrome), joined to this run by the bits'
// arrival times. The decoded values a frame update or a parity reads come from the decoder,
// so in this run the frame core applies every update (its timing does not depend on the bit).
// Not realized yet, and reported as such: request_magic.
import { execute } from "../soc.mjs";
import { assemble, measuredBits, remapSources } from "../compile.mjs";
import * as superconducting from "../platforms/superconducting.mjs";
import * as hardwareDesign from "../design.mjs";
import { runDecodes, runFactoryDecodes } from "./decoder.mjs";
import { layers } from "./surface.mjs";
import { buildTrack, controllerTrack } from "./track.mjs";

const NOT_YET = new Set([]);
const CLASSICAL = new Set(["pauli_frame_update", "parity"]);
const PAULI_MASK = { X: 1, Z: 2, Y: 3 };

/** The Pauli of each operand of a frame update, in operand order, from its statement. */
function paulisOf(op) {
  // Operand groups `P reg[i]` or `P reg[lo:hi]` (inclusive); one group's Pauli applies to its range.
  const groups = [...op.text.replace(/^.*pauli_frame_update/, "").matchAll(/\b([XYZ])\s+(?:data|ancilla|d|a)\[([^\]]+)\]/g)];
  const letters = groups.length === 1 ? op.qubits.map(() => groups[0][1]) : groups.flatMap((g) => {
    const range = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(g[2]);
    return Array(range ? Number(range[2]) - Number(range[1]) + 1 : 1).fill(g[1]);
  });
  if (letters.length !== op.qubits.length) throw Error("listing line " + op.line + ": cannot read a Pauli for every operand of " + op.text);
  return letters;
}

/** Listing records as bit names: `c[3]`, `syndrome[12]`. */
const recordName = (r) => r.register + "[" + r.index + "]";

/**
 * A schedule of native instructions with one timeline per qubit: an instruction starts when all
 * its qubits are free. Times are ps from the listing operation's start.
 */
function timeline(m, where) {
  const period = m.period;
  const out = [], free = new Map();
  const at = (qs) => Math.max(0, ...qs.map((q) => free.get(q) ?? 0));
  const take = (qs, t, dur) => qs.forEach((q) => free.set(q, t + dur));
  const fail = (msg) => { throw Error(where + ": " + msg); };
  const api = {
    out, free,
    oneQubit(name, q) {
      for (const n of superconducting.decompose({ name, targets: [q] }, fail)) {
        const t = at([q]);
        if (n.op === "frame") out.push({ op: "frame", qubits: [q], angle: n.angle, t, dur: 0 });
        else {
          const cal = m.calibration.qubits[q][n.op === "x" ? "X" : "X90"];
          const dur = m.span(cal.time) * period;
          for (const angle of cal.virtualZ.slice(0, 1)) out.push({ op: "frame", qubits: [q], angle, t, dur: 0 });
          out.push({ op: n.op, qubits: [q], t, dur });
          take([q], t, dur);
          for (const angle of cal.virtualZ.slice(1)) out.push({ op: "frame", qubits: [q], angle, t: t + dur, dur: 0 });
        }
      }
    },
    cz(a, b) {
      const pair = m.pairs.find((p) => p.pair.includes(a) && p.pair.includes(b));
      if (!pair) fail("no coupler between qubits " + a + " and " + b);
      const t = at([a, b]), dur = m.span(pair.pulses[0].time) * period;
      out.push({ op: "cz", qubits: [a, b], t, dur, params: { pair: pair.pair } });
      take([a, b], t, dur);
      for (const z of pair.virtualZ) out.push({ op: "frame", qubits: [z.qubit], angle: z.phase, t: t + dur, dur: 0 });
    },
    cnot(c, x) { api.oneQubit("h", x); api.cz(c, x); api.oneQubit("h", x); },
    measure(q, basis, result) {
      if (basis === "X") api.oneQubit("h", q);
      const ro = m.calibration.qubits[q].readout;
      const tone = m.span(ro.time), delay = m.span(ro.demod.delay), window = m.span(ro.demod.time);
      const t = at([q]), dur = Math.max(tone, delay + window) * period;
      out.push({ op: "measure", qubits: [q], t, dur, params: { tonePs: tone * period, delayPs: delay * period, windowPs: window * period }, result });
      take([q], t, dur);
    },
    reset(q) {
      const t = at([q]), dur = m.span(m.calibration.qubits[q].reset.time) * period;
      out.push({ op: "reset", qubits: [q], t, dur });
      take([q], t, dur);
    },
    /** Wait until every qubit in `qs` is free: a barrier between layers. */
    align(qs) {
      const t = at(qs);
      take(qs, t, 0);
    },
  };
  return api;
}

/**
 * The injection factory a `request_magic` runs on this chip (riscq/ftqvm/surface.mjs geometry):
 * reset its workspace (the output patch's measure sites); put the state on the corner data
 * qubit (H, then T as a virtual Z) and |+> on the data qubits above the diagonal, |0> (as
 * reset by the output's request) on the rest, after Li, NJP 17, 023037 (2015); then `rounds`
 * rounds of every check of the patch in the conflict-free order, each round resetting its
 * measure qubits. The rounds' syndrome is decoded by the decoder service afterwards
 * (factoryDecode). Records are named `factory<uid>.r<round>.c<check>`.
 */
function factoryNatives(op, placement, m, rounds) {
  const f = placement.factories.find((x) => x.uid === op.uid);
  if (!f) throw Error("listing line " + op.line + ": no factory placed for this request");
  const d = placement.d;
  const T = timeline(m, "factory on line " + op.line);
  const data = f.output.map((a) => placement.siteOf(a));
  const patch = layers(d);
  const ws = f.workspace.slice(0, patch.length).map((a) => placement.siteOf(a));
  for (const q of ws) T.reset(q);
  data.forEach((q, j) => {
    const [r, c] = [Math.floor(j / d), j % d];
    if (j === 0) { T.oneQubit("h", q); T.oneQubit("t", q); }
    else if (c > r) T.oneQubit("h", q);
  });
  const records = [];
  for (let r = 0; r < rounds; r++) {
    T.align([...data, ...ws]);
    patch.forEach((ch, i) => { if (ch.type === "X") T.oneQubit("h", ws[i]); });
    for (let layer = 0; layer < 4; layer++) {
      T.align([...data, ...ws]);
      patch.forEach((ch, i) => {
        const j = ch.order[layer];
        if (j === undefined) return;
        if (ch.type === "X") T.cnot(ws[i], data[j]);
        else T.cnot(data[j], ws[i]);
      });
    }
    T.align([...data, ...ws]);
    patch.forEach((ch, i) => {
      const name = "factory" + op.uid + ".r" + r + ".c" + i;
      records.push({ name, round: r, check: i, type: ch.type, support: ch.data });
      T.measure(ws[i], ch.type, name);
    });
    if (r < rounds - 1) for (const q of ws) T.reset(q);
  }
  return { natives: T.out, records };
}

/** Native instructions of one listing operation, relative to its start, in ps. */
function natives(op, placement, m, options = {}) {
  const qs = op.qubits.map((a) => placement.siteOf(a));
  const T = timeline(m, "listing line " + op.line);
  switch (op.kind) {
    case "H": case "S": case "Sdg": case "X": case "Z":
      T.oneQubit(op.kind.toLowerCase(), qs[0]);
      break;
    case "CZ": T.cz(qs[0], qs[1]); break;
    case "CNOT": T.cnot(qs[0], qs[1]); break;
    case "CY": T.oneQubit("sdg", qs[1]); T.cnot(qs[0], qs[1]); T.oneQubit("s", qs[1]); break;
    case "measure": T.measure(qs[0], op.arg, recordName(op.writes[0])); break;
    case "request_ancilla": for (const q of qs) T.reset(q); break;
    case "release_ancilla": case "route": break;
    case "request_magic": return factoryNatives(op, placement, m, options.factoryRounds ?? placement.d).natives;
    default:
      throw Error("listing line " + op.line + ": " + op.kind + " has no realization on this chip");
  }
  return T.out;
}

/**
 * Lower a listing to one time-triggered segment of native instructions.
 * Returns { hardware, origin: Map(native id → listing uid), unrealized: [op], quantization }.
 */
export function lowerListing(listing, placement, m, options = {}) {
  const period = m.period;
  const ops = [], origin = new Map(), unrealized = [], classical = [], decodes = [], factories = [];
  let maxSlipPs = 0, counter = 0;
  for (const op of listing.ops) {
    if (NOT_YET.has(op.kind)) {
      unrealized.push(op);
      continue;
    }
    if (op.kind === "decode_syndrome") {
      decodes.push(op);
      continue;
    }
    if (CLASSICAL.has(op.kind)) {
      const at = Math.ceil((op.start * 1000) / period);
      const id = "h" + counter++;
      origin.set(id, op.uid);
      const source = "listing line " + op.line + " · " + op.text;
      if (op.kind === "pauli_frame_update")
        paulisOf(op).forEach((pauli, i) => classical.push({ uid: op.uid, id, at, source, frame: { name: "frame:" + recordName(op.qubits[i]), mask: PAULI_MASK[pauli] } }));
      else classical.push({ uid: op.uid, id, at, source, parity: { inputs: op.reads.map(recordName), output: recordName(op.writes[0]) } });
      continue;
    }
    const startPs = op.start * 1000;
    const base = Math.ceil(startPs / period) * period;
    maxSlipPs = Math.max(maxSlipPs, base - startPs);
    if (op.kind === "request_magic") {
      const { records } = factoryNatives(op, placement, m, options.factoryRounds ?? placement.d);
      factories.push({ uid: op.uid, records, startNs: base / 1000 });
    }
    for (const n of natives(op, placement, m, options)) {
      const id = "h" + counter++;
      origin.set(id, op.uid);
      ops.push({ ...n, id, t: base + n.t, source: "listing line " + op.line + " · " + op.text });
    }
  }
  ops.sort((a, b) => a.t - b.t);
  const span = ops.reduce((m, o) => Math.max(m, o.t + o.dur), 0);
  return {
    hardware: { kind: "hardware-program", version: 1, platform: "superconducting", machine: m.name, timeUnit: "ps", segments: [{ ops, span }] },
    origin, unrealized, classical, decodes, factories, quantization: { maxSlipPs, gridPs: period },
  };
}

/**
 * Run a listing on a chip design and check it. options: { outcomes: { "c[0]": 1, … } }.
 * Returns { result, built, lowered, report }.
 */
export async function runListing(listing, placement, design, { outcomes = {}, trace = "io", distance = placement.d, factoryRounds, forceCompact = false } = {}) {
  const m = hardwareDesign.machine(design);
  const { hardware, origin, unrealized, classical, decodes, factories, quantization } = lowerListing(listing, placement, m, { factoryRounds });
  const lowered = superconducting.lower(hardware, m);
  // Frame updates and parities: timed classical work on the frame core, in the same run.
  for (const c of classical) {
    if (m.decoderCore < 0) throw Error("the design has no frame core for " + c.source);
    const { uid: _u, id, ...rest } = c;
    lowered.actions.push({ segment: 0, core: m.decoderCore, timed: true, ...rest, source: id });
  }
  const built = assemble(m.spec, lowered, { trace, maxEvents: 400_000, maxSteps: 20_000_000, forceCompact,
    bindings: m.bindings, readouts: superconducting.readoutOracle(lowered, m, outcomes) });
  // A core on the compact interpreter: name its repeated rounds' pulses after their operations.
  const result = remapSources(await execute(built.document), built);
  const report = conformance(listing, { hardware, lowered, origin, unrealized, classical, quantization }, result, built, m);
  // Decodes: the decoder service, from the bits' stores in this run.
  const bitStoredNs = {};
  for (const r of report.rows) if (r.kind === "measure" && r.bitNs !== undefined) bitStoredNs[r.record] = r.bitNs;
  const control = design.control ?? {};
  const decodeRows = decodes.length ? await runDecodes(listing, placement, distance, bitStoredNs,
    { decoders: control.decoders ?? 1, coresPerDecoder: control.coresPerDecoder ?? 1, outcomes, periodNs: m.period / 1000 }) : [];
  addRows(report, decodeRows.map((r) => ({ ...r, hardwareNs: [r.start, r.doneNs] })));
  // Factories: the injection rounds ran in this run; their syndrome goes to the factory's own
  // decoder, and the state is ready when that decode is done.
  const factoryRows = await runFactoryDecodes(factories, report.bitNs, distance, { outcomes, periodNs: m.period / 1000 });
  for (const f of factoryRows) {
    const row = report.rows.find((r) => r.uid === f.uid);
    row.factory = f;
    row.hardwareNs = [row.hardwareNs?.[0] ?? row.start, Math.max(row.hardwareNs?.[1] ?? row.start, f.doneNs)];
    row.overrunNs = Math.max(0, row.hardwareNs[1] - row.end);
    row.ok = row.ok && row.overrunNs === 0;
  }
  addRows(report, []);
  // The animation track (riscq/ftqvm/track.mjs): the chip's transmons and couplers on the lattice.
  report.track = buildTrack({ listing, placement, report, device: {
    kind: "transmon", unit: "lattice", sites: placement.sites.map((s) => ({ kind: s.kind, at: [s.rc[1], s.rc[0]] })),
    couplers: (design.couplings ?? []).map((c) => c.qubits) } });
  // The control system: each core and the transmons it drives, and every pulse it played.
  const opOf = new Map(listing.ops.map((o) => [o.uid, o]));
  const coreIndex = new Map(m.spec.cores.map((c, i) => [c.name, i]));
  const coreSites = m.spec.cores.map(() => []);
  design.qubits.forEach((q, k) => coreSites[coreIndex.get(design.channels.find((c) => c.id === q.gate)?.core)]?.push(k));
  report.track.controller = controllerTrack({ spec: m.spec, result, baseBatch: report.baseBatch, periodPs: m.period, coreSites, name: design.name,
    sitesOfOp: (id) => opOf.get(origin.get(id))?.qubits.map((q) => placement.siteOf(q)) });
  return { m, hardware, lowered, built, result, report, origin, unrealized, quantization, decodes: decodeRows, factories: factoryRows };
}

/** Add rows to a report and recompute its per-kind summary and verdict. */
export function addRows(report, rows) {
  report.rows.push(...rows);
  report.rows.sort((a, b) => a.start - b.start || a.uid - b.uid);
  report.byKind = summarize(report.rows);
  report.conforms = report.rows.every((r) => r.ok);
}

function summarize(rows) {
  const byKind = {};
  for (const r of rows) {
    const k = byKind[r.kind] ?? (byKind[r.kind] = { count: 0, ok: 0, maxOverrunNs: 0, maxHardwareNs: 0, maxBitOverrunNs: 0 });
    k.count++;
    if (r.ok) k.ok++;
    k.maxOverrunNs = Math.max(k.maxOverrunNs, r.overrunNs ?? 0);
    if (r.hardwareNs) k.maxHardwareNs = Math.max(k.maxHardwareNs, r.hardwareNs[1] - r.hardwareNs[0]);
    k.maxBitOverrunNs = Math.max(k.maxBitOverrunNs, r.bitOverrunNs ?? 0);
  }
  return byKind;
}

/**
 * Check a trace against its listing. Every pulse must open at the batch its lowered action
 * planned (a demodulation window opens its delay after its measurement starts) plus one common
 * offset (the segment's time base), and the
 * pulses of one listing operation must lie inside the operation's window. A measured bit must
 * be stored by the end of its measurement.
 */
export function conformance(listing, lowering, result, built, m) {
  const period = m.period;
  const { hardware, lowered, origin, unrealized, classical = [], quantization } = lowering;
  const planned = new Map(hardware.segments[0].ops.map((o) => [o.id, o]));
  // Planned opening batches of every fired pulse, per native instruction and core.
  const plannedAt = new Map();
  for (const a of lowered.actions)
    if (a.fire) (plannedAt.get(a.source) ?? plannedAt.set(a.source, []).get(a.source)).push({ core: a.core, at: a.at });
  const pulses = result.summary.pulses.filter((p) => planned.has(p.source));
  const nearest = (p, base) => {
    const ats = (plannedAt.get(p.source) ?? []).filter((x) => x.core === p.core).map((x) => x.at);
    return ats.reduce((best, at) => (Math.abs(p.opens - base - at) < Math.abs(p.opens - base - best) ? at : best), ats[0]);
  };
  // The time base: the offset that most pulses share between the trace and the plan.
  const offsets = new Map();
  for (const p of pulses) {
    const o = p.opens - nearest(p, 0);
    offsets.set(o, (offsets.get(o) ?? 0) + 1);
  }
  const base = [...offsets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const byOp = new Map();
  for (const p of pulses) {
    const uid = origin.get(p.source);
    const at = byOp.get(uid) ?? byOp.set(uid, { pulses: 0, opens: Infinity, closes: -Infinity, late: 0, overlap: 0 }).get(uid);
    at.pulses++;
    at.opens = Math.min(at.opens, p.opens - base);
    at.closes = Math.max(at.closes, p.closes - base);
    if (p.opens - base !== nearest(p, base)) at.late++;
    if (p.overlap) at.overlap++;
  }
  // When each measured bit was stored: the host write of the bit, in batches.
  const bitAt = new Map();
  for (const w of result.summary.host) {
    const name = Object.entries(built.images[w.core].bits).find(([, index]) => 4 * index === w.offset)?.[0];
    if (name !== undefined && !bitAt.has(name)) bitAt.set(name, w.atBatch - base);
  }
  // Classical work on the frame core: done when its last word is stored. A frame word that
  // several updates change is matched to them in time order.
  const frameCore = m.decoderCore;
  const writesOf = new Map();
  for (const w of result.summary.host) {
    if (w.core !== frameCore) continue;
    const name = Object.entries(built.images[frameCore].bits).find(([, index]) => 4 * index === w.offset)?.[0];
    if (name !== undefined) (writesOf.get(name) ?? writesOf.set(name, []).get(name)).push(w.atBatch - base);
  }
  const doneOf = new Map();
  for (const c of [...classical].sort((x, y) => x.at - y.at)) {
    const name = c.frame ? c.frame.name : c.parity.output;
    const at = writesOf.get(name)?.shift();
    doneOf.set(c.uid, Math.max(doneOf.get(c.uid) ?? -Infinity, at ?? Infinity));
  }
  const rows = [];
  for (const op of listing.ops) {
    if (unrealized.includes(op) || op.kind === "decode_syndrome") continue;
    if (CLASSICAL.has(op.kind)) {
      const done = (doneOf.get(op.uid) * period) / 1000;
      rows.push({ uid: op.uid, kind: op.kind, line: op.line, start: op.start, end: op.end, hardwareNs: [op.start, done],
        overrunNs: Math.max(0, done - op.end), ok: Number.isFinite(done) && done <= op.end });
      continue;
    }
    const window = [op.start * 1000 / period, op.end * 1000 / period];
    const seen = byOp.get(op.uid);
    const row = { uid: op.uid, kind: op.kind, line: op.line, start: op.start, end: op.end };
    if (seen) {
      row.hardwareNs = [seen.opens * period / 1000, seen.closes * period / 1000];
      row.overrunNs = Math.max(0, (seen.closes - window[1]) * period / 1000);
      row.late = seen.late;
      row.overlap = seen.overlap;
    }
    if (op.kind === "measure") {
      const name = recordName(op.writes[0]);
      row.record = name;
      row.bitNs = bitAt.has(name) ? bitAt.get(name) * period / 1000 : undefined;
      row.bitOverrunNs = row.bitNs === undefined ? undefined : Math.max(0, row.bitNs - op.end);
    }
    row.ok = (!seen || (row.overrunNs === 0 && !row.late && !row.overlap)) && !(row.bitOverrunNs > 0) && !(op.kind === "measure" && row.bitNs === undefined);
    rows.push(row);
  }
  const byKind = summarize(rows);
  const bitNs = Object.fromEntries([...bitAt].map(([name, b]) => [name, (b * period) / 1000]));
  return {
    bitNs,
    status: result.summary.status, faults: result.summary.faults,
    baseBatch: base, quantization, conforms: rows.every((r) => r.ok),
    byKind, rows, bits: measuredBits(result, built),
    unrealized: unrealized.map((op) => ({ uid: op.uid, kind: op.kind, line: op.line, start: op.start, text: op.text })),
  };
}
