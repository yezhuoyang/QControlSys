// The decoder service: how a listing's `decode_syndrome` runs on the control system's decoder
// cores, with every decode time measured on a compiled decoder in the Lean model.
//
// A decode reads records that the listing's measurements wrote. Each record is a check of a
// code block, measured in X or in Z. The records of one block and one check type, over the
// rounds the decode covers, are one decoding job:
//   - a full rotated-surface-code type ((d²−1)/2 checks, at most d rounds) is decoded by the
//     Helios union-find, compiled from its C source for a RISC-Q core (riscq/decoders/helios.mjs),
//     on the syndrome of detection events (a check's value XOR its value in the round before);
//   - any other group of at most 10 bits (a merge's check outcomes) by the lookup decoder of the
//     controller firmware (riscq/firmware.mjs `decode`), whose time is measured by
//     riscq/limits.mjs `decodeFanIn`;
//   - anything else is refused: there is no decoder for it.
// Helios's checks are ordered by the row, then column, of their centre on the lattice; with
// outcomes all 0 every syndrome is empty, and the order does not change the timing.
//
// Timing. A job is ready when its last syndrome bit has reached the decoder core: the bit's
// store at its measuring core (from the listing run) plus the hub's publish latency. A design
// gives `decoders` decoder units; the jobs of one decode run on one unit, one after another
// (FormalRV charges a decode one decoder), or, with `coresPerDecoder > 1`, spread over that
// many cores of the unit. A unit is busy from a job's start to its end. The decode is done when
// its last job is. Decode times are properties of this model's core (one batch per instruction
// plus its penalties, riscq/soc.mjs), not of a board.
import * as helios from "../decoders/helios.mjs";
import { analyze } from "./place.mjs";

const helioCache = new Map(), lookupCache = new Map();

/**
 * Batches from a bit's store at its measuring core to the decoder core's board register on a
 * RISC-Q board with link depth 2: 86 − 34 ns from the window's close (tests/riscq-syscalls.test.mjs,
 * measured in the Lean model on the x6y3 build, the board the generated chips use).
 */
export const PUBLISH_NS = 52;

/** The decoding jobs of one decode operation. `d` is the code distance of the blocks. */
export function jobsOf(listing, op, placement, d) {
  const writer = new Map();
  for (const o of listing.ops) if (o.kind === "measure") for (const w of o.writes) writer.set(w.register + "[" + w.index + "]", o);
  const { partners } = analyze(listing);
  // Helios decodes the rotated surface code (blocks of d² qubits); other codes use the lookup.
  const n = placement.n ?? d * d, surface = n === d * d;
  const groups = new Map();
  for (const r of op.reads) {
    const name = r.register + "[" + r.index + "]";
    const m = writer.get(name);
    if (!m) throw Error("decode on line " + op.line + " reads " + name + ", which no measurement wrote");
    const a = m.qubits[0];
    // The check's support as qubit indices j of one code block, data or ancilla (placement.blockOf).
    const members = [...(partners.get(a.register + "[" + a.index + "]")?.keys() ?? [])].map((p) => placement.blockOf(p));
    const inBlock = members.length > 0 && members.every((b) => b && b.block === members[0].block);
    const support = inBlock ? members.map((b) => b.j).sort((x, y) => x - y) : [];
    const key = inBlock ? members[0].block + "/" + m.arg : "other";
    const g = groups.get(key) ?? groups.set(key, { key, bits: [] }).get(key);
    g.bits.push({ name, support: support.join(","), at: m.start, measure: m });
  }
  const jobs = [];
  for (const g of groups.values()) {
    const supports = [...new Set(g.bits.map((b) => b.support))];
    const rounds = Math.max(...supports.map((s) => g.bits.filter((b) => b.support === s).length));
    if (surface && g.key !== "other" && supports.length === (n - 1) / 2) {
      // Order checks by the centre of their support on the lattice.
      const centre = (s) => {
        const pts = s.split(",").map(Number).map((i) => [Math.floor((i % n) / d), i % d]);
        return [pts.reduce((x, p) => x + p[0], 0) / pts.length, pts.reduce((x, p) => x + p[1], 0) / pts.length];
      };
      const order = [...supports].sort((x, y) => centre(x)[0] - centre(y)[0] || centre(x)[1] - centre(y)[1]);
      // Helios's graph holds d rounds: a longer decode runs in consecutive windows of d rounds
      // (windowed decoding, here without overlap), each window one job.
      const roundOf = new Map();
      for (const s of supports) g.bits.filter((x) => x.support === s).sort((x, y) => x.at - y.at).forEach((x, r) => roundOf.set(x.name, r));
      for (let w = 0; w * d < rounds; w++) {
        const bits = g.bits.filter((x) => Math.floor(roundOf.get(x.name) / d) === w);
        jobs.push({ kind: "helios", distance: d, group: g.key + (rounds > d ? "/w" + w : ""), bits, order, rounds: Math.min(d, rounds - w * d) });
      }
    } else if (g.bits.length <= 10) jobs.push({ kind: "lookup", group: g.key, bits: g.bits });
    else
      // Groups no Helios graph fits (logical readouts, merge outcomes, a non-surface code's
      // checks over many rounds): consecutive lookups of at most 10 bits each, the table size.
      for (let k = 0; k < g.bits.length; k += 10) jobs.push({ kind: "lookup", group: g.key + "/" + k / 10, bits: g.bits.slice(k, k + 10) });
  }
  return jobs;
}

/** Helios syndrome of a job: detection events per round, check and Helios grid position. */
function heliosSyndrome(job, outcomes) {
  const d = job.distance, perRow = (d - 1) / 2;
  const values = job.order.map((s) => job.bits.filter((b) => b.support === s).sort((x, y) => x.at - y.at).map((b) => outcomes[b.name] ?? 0));
  const syndrome = [];
  for (let k = 0; k < d; k++)
    for (let i = 0; i <= d; i++)
      for (let j = 0; j < perRow; j++) {
        const c = i * perRow + j;
        const v = values[c] ?? [];
        syndrome.push(k < v.length ? (v[k] ^ (k > 0 ? v[k - 1] : 0)) : 0);
      }
  return syndrome;
}

/** Measured compute time of a job, in ns. */
export async function jobNs(job, outcomes = {}, periodNs = 2) {
  if (job.kind === "helios") {
    const syndrome = heliosSyndrome(job, outcomes);
    const key = job.distance + ":" + syndrome.join("");
    if (!helioCache.has(key)) {
      const { elf } = helios.build(job.distance, [{ id: 1, syndrome }]);
      const { decodes } = await helios.run(elf, job.distance);
      const [dec] = decodes;
      // The union-find itself, from the last syndrome value read to the first root it reports: the
      // roots are then in RAM. Printing them through the test harness's fprintf (about 9 µs at
      // d = 3) is kept apart as `reportNs`; it is Helios's test output, not decoding.
      helioCache.set(key, { ns: dec.decodeBatches * periodNs, reportNs: (dec.lastOutputAt - dec.firstOutputAt) * periodNs });
    }
    return helioCache.get(key).ns;
  }
  // The lookup decoder's time is measured by riscq/limits.mjs `decodeFanIn` on the 8-transmon
  // ring, so up to 8 bits; 9 and 10 bits use the line through the measured 1- and 8-bit times
  // (the firmware's cost is linear in the bits it stores: one load, shift, mask and store each).
  const k = job.bits.length;
  const measured = async (bits) => {
    if (!lookupCache.has(bits)) {
      const { decodeFanIn } = await import("../limits.mjs");
      lookupCache.set(bits, (await decodeFanIn(bits)).decodeNs);
    }
    return lookupCache.get(bits);
  };
  if (k <= 8) return measured(k);
  const [one, eight] = [await measured(1), await measured(8)];
  return Math.ceil(one + ((eight - one) * (k - 1)) / 7);
}

/**
 * Decode the injection rounds of every factory on the factory's own decoder core (FormalRV's
 * factory contract declares the decoders a factory holds): one Helios job per check type, in
 * series, each ready when its last round's bits have reached the decoder.
 * `factories`: [{ uid, records: [{ name, round, check, type, support }] }] from sc-run.
 */
export async function runFactoryDecodes(factories, bitNs, d, { outcomes = {}, periodNs = 2 } = {}) {
  const rows = [];
  for (const f of factories) {
    let free = 0;
    const jobs = [];
    for (const type of ["X", "Z"]) {
      const mine = f.records.filter((r) => r.type === type);
      const bits = mine.map((r) => ({ name: r.name, support: r.support.join(","), at: r.round }));
      const order = [...new Set(bits.map((b) => b.support))];
      const job = { kind: "helios", distance: d, group: "factory" + f.uid + "/" + type, bits, order, rounds: Math.max(...mine.map((r) => r.round)) + 1 };
      if (job.rounds > d) throw Error("a factory of " + job.rounds + " rounds exceeds the Helios graph of distance " + d);
      const ready = Math.max(...bits.map((b) => (bitNs[b.name] ?? Infinity) + PUBLISH_NS));
      const start = Math.max(ready, free);
      const ns = await jobNs(job, outcomes, periodNs);
      free = start + ns;
      jobs.push({ kind: "helios", group: job.group, bits: bits.length, readyNs: ready, startNs: start, endNs: free, computeNs: ns });
    }
    rows.push({ uid: f.uid, jobs, doneNs: free });
  }
  return rows;
}

/**
 * Run every decode of a listing on the decoder units of a design.
 * `bitStoredNs`: record name → ns at which its measuring core stored it (sc-run conformance rows).
 * Returns rows { uid, line, start, end, jobs: [{ kind, group, readyNs, startNs, endNs, unit }], doneNs, overrunNs, ok }.
 */
export async function runDecodes(listing, placement, d, bitStoredNs, { decoders = 1, coresPerDecoder = 1, outcomes = {}, periodNs = 2 } = {}) {
  const units = Array.from({ length: decoders }, () => Array(coresPerDecoder).fill(0));
  const rows = [];
  for (const op of listing.ops.filter((o) => o.kind === "decode_syndrome").sort((x, y) => x.start - y.start)) {
    const jobs = jobsOf(listing, op, placement, d);
    // FormalRV holds one decoder for the decode: take the unit that frees first.
    const u = units.map((cores, i) => [Math.min(...cores), i]).sort((x, y) => x[0] - y[0])[0][1];
    const cores = units[u];
    const out = [];
    for (const job of jobs) {
      const ready = Math.max(op.start, ...job.bits.map((b) => (bitStoredNs[b.name] ?? Infinity) + PUBLISH_NS));
      const c = cores.indexOf(Math.min(...cores));
      const start = Math.max(ready, cores[c]);
      const ns = await jobNs(job, outcomes, periodNs);
      cores[c] = start + ns;
      out.push({ kind: job.kind, group: job.group, bits: job.bits.length, readyNs: ready, startNs: start, endNs: start + ns, computeNs: ns, unit: u, core: c });
    }
    const doneNs = Math.max(op.start, ...out.map((j) => j.endNs));
    rows.push({ uid: op.uid, kind: op.kind, line: op.line, start: op.start, end: op.end, jobs: out, doneNs, overrunNs: Math.max(0, doneNs - op.end), ok: doneNs <= op.end });
  }
  return rows;
}
