// A sharded run of a listing on a transmon chip: the same run as runListing (riscq/ftqvm/sc-run.mjs),
// with the Lean model of the control system executed as several processes in parallel, each playing
// the programs of one group of boards.
//
// Why the shards play what the whole run plays. In a medium program's single segment the cores meet
// once, at the segment's barrier, and then each plays its own timed actions on its own channels:
// no measured bit crosses cores inside the run (the shards refuse a lowering that conditions on,
// publishes or decodes a bit), the decoder service runs outside it (riscq/ftqvm/decoder.mjs), and the
// frame core's classical work reads its own bit table. A core's trace is therefore set by its own
// program and the barrier's release. Every shard runs the whole machine's barrier: the cores of the
// other shards join it with no action (compile.mjs plans `members`), so it releases on every board as
// it does in the whole run, and every core is compiled with the whole run's prerolls and folded cores
// (three lowering passes: prerolls, folding, then the run). The shards' time bases must agree; the run
// stops if they do not.
//
// What a shard keeps: the listing operations that touch a qubit one of its cores serves (gate, cz,
// readout or demodulation, design.mjs locate), all of each such qubit's operations in time order, so
// its frames are the whole run's; the classical operations when it holds the frame core.
// Approximation boundary: none beyond the whole run's; the merge is exact for the report's rows.
import { availableParallelism } from "node:os";
import { execute } from "../soc.mjs";
import { assemble, corePrerolls, plans, remapSources } from "../compile.mjs";
import { compileCore } from "../firmware.mjs";
import * as superconducting from "../platforms/superconducting.mjs";
import * as hardwareDesign from "../design.mjs";
import { lowerListing, conformanceParts, conformanceReport, bestBase, completeReport, guardHolds, batchBudget, checkFinished } from "./sc-run.mjs";

const CLASSICAL = new Set(["pauli_frame_update", "parity"]);

/**
 * Contiguous groups of boards, about `count` of them, each a set of core indices, cut so that each
 * carries about the same load (`coreLoad[i]`: the listing operations core i serves).
 */
function shardCores(spec, count, coreLoad) {
  const boards = [...new Set(spec.cores.map((c) => c.board ?? 0))].sort((a, b) => a - b);
  const load = new Map(boards.map((b) => [b, 0]));
  spec.cores.forEach((c, i) => load.set(c.board ?? 0, load.get(c.board ?? 0) + (coreLoad[i] ?? 0) + 1));
  const total = [...load.values()].reduce((x, y) => x + y, 0), target = total / Math.max(1, Math.min(count, boards.length));
  const shardOfBoard = new Map();
  let shard = 0, sum = 0;
  for (const b of boards) {
    if (sum >= target * (shard + 1) && shard < count - 1) shard++;
    shardOfBoard.set(b, shard);
    sum += load.get(b);
  }
  const shards = Array.from({ length: shard + 1 }, () => new Set());
  spec.cores.forEach((c, i) => shards[shardOfBoard.get(c.board ?? 0)].add(i));
  return shards.filter((x) => x.size);
}

/**
 * Run a listing sharded. Same options as runListing, and { shards (about how many), parallel (Lean
 * processes at once) }. Returns { m, report, result: { summary }, decodes, factories, shards }.
 */
export async function runListingSharded(listing, placement, design, { outcomes = {}, trace = "summary", distance = placement.d, factoryRounds, guards,
  shards: count = 8, parallel = Math.min(4, Math.max(1, availableParallelism() - 2)) } = {}) {
  const t0 = Date.now();
  const log = process.env.QUANTUMOS_PROFILE ? (msg) => console.error("[shards] " + ((Date.now() - t0) / 1000).toFixed(1) + " s " + msg) : () => {};
  const m = hardwareDesign.machine(design);
  // The cores that serve each site, and the operations on each site.
  const locate = m.locate ?? ((q, role, pair) => ({ core: q, channel: role === "cz" ? m.czChannel(q, pair) : role }));
  const pairsOf = placement.sites.map(() => []);
  for (const pair of m.pairs) for (const q of pair.pair) pairsOf[q]?.push(pair);
  const siteCores = placement.sites.map((_, q) => {
    const cores = new Set(["gate", "ro", "demod"].map((role) => locate(q, role)?.core));
    for (const pair of pairsOf[q]) cores.add(locate(q, "cz", pair)?.core);
    return [...cores].filter((c) => c !== undefined);
  });
  const sitesOfOp = (op) => [...op.qubits, ...(op.kind === "request_magic" ? op.work : [])].map((a) => placement.siteOf(a));
  const coreLoad = new Float64Array(m.spec.cores.length);
  for (const op of listing.ops) if (!CLASSICAL.has(op.kind) && op.kind !== "decode_syndrome") for (const q of sitesOfOp(op)) for (const c of siteCores[q]) coreLoad[c]++;
  const shards = shardCores(m.spec, count, coreLoad);
  const shardOf = new Int32Array(m.spec.cores.length);
  shards.forEach((cores, k) => cores.forEach((c) => (shardOf[c] = k)));
  const frameShard = m.decoderCore >= 0 ? shardOf[m.decoderCore] : -1;
  // The shards whose cores serve a site.
  const siteShards = siteCores.map((cores) => [...new Set(cores.map((c) => shardOf[c]))]);
  const opsOf = shards.map(() => []);
  for (const op of listing.ops) {
    if (op.kind === "decode_syndrome") continue;
    if (CLASSICAL.has(op.kind)) {
      if (frameShard >= 0) opsOf[frameShard].push(op);
      continue;
    }
    const mine = new Set();
    for (const q of sitesOfOp(op)) for (const k of siteShards[q]) mine.add(k);
    for (const k of mine) opsOf[k].push(op);
  }
  log(shards.length + " shards of " + shards.map((s) => s.size).join("/") + " cores, " + opsOf.map((o) => o.length).join("/") + " ops");
  // One shard's lowering: its operations, with only its cores' actions and readouts.
  const lowerShard = (k) => {
    const low = lowerListing({ ...listing, ops: opsOf[k] }, placement, m, { factoryRounds, guards, outcomes });
    const lowered = superconducting.lower(low.hardware, m);
    if (k === frameShard)
      for (const c of low.classical) {
        const { uid: _u, id, ...rest } = c;
        lowered.actions.push({ segment: 0, core: m.decoderCore, timed: true, ...rest, source: id });
      }
    const owned = shards[k];
    lowered.actions = lowered.actions.filter((a) => owned.has(a.core));
    lowered.readouts = lowered.readouts.filter((r) => owned.has(r.core));
    for (const a of lowered.actions)
      if (a.when !== undefined || a.decode || a.publish) throw Error("a sharded run cannot carry " + a.source + ": it conditions on, decodes or publishes a bit");
    return { low, lowered };
  };
  // Pass 1: every core's preroll, and the cores that join the barrier.
  const members = new Set();
  let prerollOf = {};
  for (let k = 0; k < shards.length; k++) {
    const { lowered } = lowerShard(k);
    for (const a of lowered.actions) members.add(a.core);
    prerollOf = { ...prerollOf, ...corePrerolls(m.spec, lowered) };
  }
  const segments = 1;
  const maxPreroll = (table) => Array.from({ length: segments }, (_, s) => Object.values(table).reduce((x, p) => Math.max(x, p[s] ?? 0), 0));
  const p0 = maxPreroll(prerollOf);
  log("pass 1: " + members.size + " active cores, preroll " + p0.join(","));
  // Pass 2: the cores whose program does not fit their RAM, as assemble finds them, and their folded prerolls.
  const compact = new Set();
  for (let k = 0; k < shards.length; k++) {
    const { lowered } = lowerShard(k);
    const corePlans = plans(m.spec, lowered, { prerolls: p0, members });
    const tooBig = new Set();
    for (const c of shards[k]) {
      if (!corePlans[c].segments.length) continue;
      try {
        compileCore(m.spec, c, corePlans[c]);
      } catch (error) {
        if (!/the program needs \d+ words/.test(error.message)) throw error;
        tooBig.add(c);
      }
    }
    if (tooBig.size) {
      const folded = corePrerolls(m.spec, lowered, { compact: tooBig });
      for (const c of tooBig) {
        compact.add(c);
        prerollOf[c] = folded[c];
      }
    }
  }
  const p1 = maxPreroll(prerollOf);
  log("pass 2: " + compact.size + " folded cores, preroll " + p1.join(","));
  // Pass 3: each shard compiled and run; up to `parallel` Lean processes at once.
  const done = [];
  const running = new Set();
  for (let k = 0; k < shards.length; k++) {
    while (running.size >= parallel) await Promise.race(running);
    const { low, lowered } = lowerShard(k);
    const built = assemble(m.spec, lowered, { shard: { prerolls: p1, compact, members }, trace, maxEvents: 400_000, maxBatches: batchBudget(lowered),
      maxSteps: trace === "summary" ? 2_000_000_000 : 20_000_000, bindings: m.bindings, readouts: superconducting.readoutOracle(lowered, m, outcomes) });
    // What the check needs once the trace is back; the lowering itself is let go.
    const context = {
      hardware: { segments: [{ ops: low.hardware.segments[0].ops.map((o) => ({ id: o.id })) }] },
      lowered: { actions: lowered.actions.filter((a) => a.fire).map((a) => ({ fire: true, source: a.source, core: a.core, at: a.at })) },
      origin: low.origin,
    };
    if (lowered.segments.length !== segments) throw Error("a sharded run plays one segment; this lowering has " + lowered.segments.length);
    const document = built.document;
    built.document = null;
    built.plans = null;
    const { origin, classical, factories: shardFactories } = low;
    const opOf = new Map(opsOf[k].map((o) => [o.uid, o]));
    const job = execute(document).then((result) => {
      checkFinished(result);
      remapSources(result, built);
      const parts = conformanceParts(context, result, built, m);
      const base = bestBase(parts.offsets);
      const first = [...result.summary.pulses].sort((a, b) => a.opens - b.opens).slice(0, 30000)
        .map((p) => ({ ...p, source: k + ":" + p.source, sites: opOf.get(origin.get(p.source))?.qubits.map((q) => placement.siteOf(q)) }));
      done[k] = { base, voted: parts.offsets.size > 0, ...parts.aggregate(base), bits: parts.bits, status: parts.status, faults: parts.faults,
        first, classical: k === frameShard ? classical : [], factories: shardFactories,
        elapsedBatches: result.summary.elapsedBatches, steps: result.summary.steps, pulses: result.summary.pulses.length };
      log("shard " + k + " done: " + done[k].pulses + " pulses, base " + base);
    });
    running.add(job);
    job.then(() => running.delete(job), () => running.delete(job));
  }
  await Promise.all(running);
  // The merge. The shards share the barrier, so they share the time base.
  const bases = new Set(done.filter((d) => d.voted).map((d) => d.base));
  if (bases.size > 1) throw Error("the shards disagree on the segment's time base: " + [...bases].join(", "));
  const base = [...bases][0] ?? 0;
  const byOp = new Map(), bitAt = new Map(), writesOf = new Map(), bits = {};
  for (const d of done) {
    for (const [uid, x] of d.byOp) {
      const y = byOp.get(uid);
      if (!y) byOp.set(uid, { ...x });
      else Object.assign(y, { pulses: y.pulses + x.pulses, opens: Math.min(y.opens, x.opens), closes: Math.max(y.closes, x.closes), late: y.late + x.late, overlap: y.overlap + x.overlap });
    }
    for (const [name, at] of d.bitAt) if (!bitAt.has(name) || at < bitAt.get(name)) bitAt.set(name, at);
    for (const [name, list] of d.writesOf) writesOf.set(name, list);
    Object.assign(bits, d.bits);
  }
  const statuses = done.map((d) => d.status);
  const status = statuses.find((x) => x !== "quiescent") ?? "quiescent";
  const faults = done.flatMap((d) => d.faults);
  // The whole listing's skipped and unrealized operations and its largest slip onto the batch grid,
  // as lowerListing gives them.
  const skipped = new Set(listing.ops.filter((op) => op.guard && !guardHolds(op.guard, { guards, outcomes })).map((op) => op.uid));
  let maxSlipPs = 0;
  for (const op of listing.ops) {
    if (skipped.has(op.uid) || op.kind === "decode_syndrome" || CLASSICAL.has(op.kind)) continue;
    const startPs = op.start * 1000;
    maxSlipPs = Math.max(maxSlipPs, Math.ceil(startPs / m.period) * m.period - startPs);
  }
  const report = conformanceReport(listing, { unrealized: [], classical: done[frameShard]?.classical ?? [], skipped, quantization: { maxSlipPs, gridPs: m.period } },
    { base, byOp, bitAt, writesOf, bits, status, faults }, m);
  log("merged: " + report.rows.length + " rows, conforms " + report.conforms);
  const decodes = listing.ops.filter((op) => op.kind === "decode_syndrome" && !skipped.has(op.uid));
  const factories = [...new Map(done.flatMap((d) => d.factories).map((f) => [f.uid, f])).values()];
  const first = done.flatMap((d) => d.first).sort((a, b) => a.opens - b.opens).slice(0, 30000);
  const sitesOf = new Map(first.map((p) => [p.source, p.sites]));
  const summary = { status, faults, pulses: first, elapsedBatches: Math.max(...done.map((d) => d.elapsedBatches)), steps: done.reduce((n, d) => n + d.steps, 0),
    pulseCount: done.reduce((n, d) => n + d.pulses, 0) };
  const { decodeRows, factoryRows } = await completeReport({ listing, placement, design, m, report, skipped, decodes, factories, outcomes, distance,
    controller: { result: { summary }, sitesOfOp: (id) => sitesOf.get(id) } });
  report.track.controller.truncated = summary.pulseCount > first.length;
  log("report complete");
  return { m, report, result: { summary }, decodes: decodeRows, factories: factoryRows, shards: shards.length };
}
