// Shared back end: timed channel actions → one firmware plan per core → the RISC-Q program
// that the Lean model executes. Each platform lowers its hardware instructions to actions.
import { program } from "./soc.mjs";
import { compileCore, prerollOf } from "./firmware.mjs";

/**
 * Group a platform's actions into per-core plans.
 *
 * lowered = {
 *   tables: [{ core, channel, freq?, slots }],          // pulse tables and carriers per channel
 *   segments: [{ span }],                               // batches each statically timed segment lasts
 *   actions: [{ segment, core, at, fire | freq | read | count | decode | frame, bit?, bits?, when?, set?, phaseOffset?, source }],
 * }
 * decode = { inputs: [bit], table: [word], outputs: [bit] } and frame = { name, mask } run on a
 * core that plays no pulse for them. A segment whose span is undefined ends as soon as its
 * cores are done.
 * A segment begins with a barrier among the active cores, which gives them one time base.
 * A measured bit is published to a shared group slot. A core that conditions on a bit it did
 * not measure reads the shared slot after the barrier of the segment that uses it.
 */
export function plans(spec, lowered, { compact = new Set(), prerolls: givenPrerolls, members: extraMembers } = {}) {
  // A core with no action parks at once and joins no barrier. `members`: cores that join the
  // barriers although this lowering gives them no action (a sharded run: the cores of the other
  // shards, so that every barrier has the members, and releases as, it does in the whole run).
  const active = new Set(lowered.actions.map((a) => a.core));
  for (const c of extraMembers ?? []) active.add(c);
  const members = active.size;
  const shared = new Map();
  const owner = new Map();
  for (const action of lowered.actions)
    for (const bit of action.count ? action.bits : action.decode ? action.decode.outputs
      : action.read && action.bit !== undefined ? [action.bit] : []) {
      if (owner.has(bit)) throw Error("Classical bit " + bit + " is produced twice.");
      owner.set(bit, action.core);
    }
  // The hub holds 4 words of 32 shared bits. A decoder reads its inputs as one field of one
  // word, so they take consecutive slots, allocated first.
  let next = 0;
  const share = (bit) => {
    if (!owner.has(bit)) throw Error("Classical bit " + bit + " has no measurement.");
    if (next >= 4 * 32) throw Error("More than 128 shared classical bits.");
    shared.set(bit, { group: Math.floor(next / 32), slot: next % 32 });
    next++;
  };
  for (const action of lowered.actions.filter((a) => a.decode)) {
    const { inputs } = action.decode;
    if (inputs.some((bit) => shared.has(bit) || owner.get(bit) === action.core) || new Set(inputs).size !== inputs.length)
      throw Error("The inputs of a decode are distinct bits measured on other cores, each decoded once.");
    if ((next % 32) + inputs.length > 32) next += 32 - (next % 32);
    inputs.forEach(share);
  }
  const needsShare = new Set(
    lowered.actions.filter((a) => a.when !== undefined && owner.get(a.when) !== a.core).map((a) => a.when));
  for (const bit of needsShare) if (!shared.has(bit)) share(bit);
  // Frames that can still be on a board-to-board lane when a segment's barrier releases: the shared
  // bits the previous segment published (each one put, crossing every lane once; an earlier segment's
  // went ahead of the previous release). firmware.mjs adds a lane frame time per frame to the lead.
  const producedIn = new Map();
  for (const action of lowered.actions)
    for (const bit of action.count ? action.bits : action.decode ? action.decode.outputs : action.read && action.bit !== undefined ? [action.bit] : [])
      producedIn.set(bit, action.segment);
  const backlog = lowered.segments.map((_, s) => [...shared.keys()].filter((bit) => producedIn.get(bit) === s - 1).length);
  // A burst of simultaneous writes takes the core many cycles to issue. Every core delays the
  // segment by the same preroll so that the earliest write still leaves on time.
  // Each core's actions per segment, grouped once (a medium program has millions of actions).
  const bySegmentCore = new Map();
  for (const a of lowered.actions) {
    const key = a.segment + "/" + a.core;
    (bySegmentCore.get(key) ?? bySegmentCore.set(key, []).get(key)).push(a);
  }
  const actionsOf = (s, index) => bySegmentCore.get(s + "/" + index) ?? [];
  // `prerolls`: given by a sharded run, the whole run's (corePrerolls over every shard).
  const prerolls = givenPrerolls ?? lowered.segments.map((_, s) => [...active].reduce((m, index) =>
    Math.max(m, prerollOf(spec.cores[index], actionsOf(s, index), { compact: compact.has(index) })), 0));
  const shift = (op, by) => ({
    ...op, at: op.at + by,
    ...(op.read ? { read: { ...op.read, until: op.read.until + by } } : {}),
    ...(op.count ? { count: { ...op.count, until: op.count.until + by } } : {}),
  });
  return spec.cores.map((core, index) => {
    if (!active.has(index)) return { channels: [], segments: [] };
    const fetched = new Set();
    const segments = lowered.segments.map((segment, s) => {
      const mine = actionsOf(s, index);
      const fetch = [];
      for (const a of mine)
        if (a.when !== undefined && owner.get(a.when) !== index && !fetched.has(a.when)) {
          fetched.add(a.when);
          fetch.push({ ...shared.get(a.when), bit: a.when });
        }
      const ops = mine.map(({ segment: _s, core: _c, ...op }) => shift(
        op.count ? { ...op, publishes: op.bits.map((bit) => shared.get(bit)) }
          : op.decode ? { ...op, publishes: op.decode.outputs.map((bit) => shared.get(bit)),
              decode: { ...op.decode, ...shared.get(op.decode.inputs[0]), width: op.decode.inputs.length } }
          : op.read && shared.has(op.bit) ? { ...op, publish: shared.get(op.bit) } : op, prerolls[s]));
      return {
        sync: members > 1 ? { barrier: s % 16, members, laneBacklog: backlog[s] } : undefined,
        fetch,
        ops,
        span: segment.span === undefined ? undefined : segment.span + prerolls[s],
        preroll: prerolls[s],
      };
    });
    return {
      channels: lowered.tables.filter((t) => t.core === index).map(({ core: _c, ...t }) => t),
      segments,
    };
  });
}

/**
 * Each core's preroll per segment, for the cores with actions: `{ core: [batches per segment] }`.
 * The segment's preroll is the largest over the run's cores (plans); a sharded run takes it over
 * every shard. `compact`: the cores on folded firmware.
 */
export function corePrerolls(spec, lowered, { compact = new Set() } = {}) {
  const out = {};
  const bySegmentCore = new Map();
  for (const a of lowered.actions) {
    const key = a.segment + "/" + a.core;
    (bySegmentCore.get(key) ?? bySegmentCore.set(key, []).get(key)).push(a);
  }
  for (const index of new Set(lowered.actions.map((a) => a.core)))
    out[index] = lowered.segments.map((_, s) => prerollOf(spec.cores[index], bySegmentCore.get(s + "/" + index) ?? [], { compact: compact.has(index) }));
  return out;
}

/** Compile lowered actions to the document the Lean executable runs, with per-core statistics. */
export function assemble(spec, lowered, options = {}) {
  // A shard of a sharded run (riscq/ftqvm/sc-shards.mjs): the whole run's prerolls, folded cores and
  // barrier members are given, and every core is compiled as the whole run compiles it.
  if (options.shard) {
    const { prerolls, compact, members } = options.shard;
    const corePlans = plans(spec, lowered, { compact, prerolls, members });
    const images = corePlans.map((plan, i) => compileCore(spec, i, plan, { compact: compact.has(i) }));
    return {
      document: program(spec, images, (({ forceCompact: _f, shard: _s, ...rest }) => rest)(options)),
      plans: corePlans,
      images: images.map((image, i) => ({ core: spec.cores[i].name, ...image.stats, bits: image.bits, bitBase: image.bitBase, ...(image.remap ? { remap: image.remap } : {}) })),
      compact: [...compact],
    };
  }
  let corePlans = plans(spec, lowered);
  // A core whose program does not fit its RAM runs its segments on the compact interpreter
  // (riscq/firmware.mjs): the plans are made again with its costs, which every core's preroll sees.
  // `options.forceCompact`: every core on the compact interpreter (tests and measurements).
  const tooBig = new Set(options.forceCompact ? spec.cores.map((_, i) => i) : []);
  let images = options.forceCompact ? [] : corePlans.map((plan, i) => {
    try {
      return compileCore(spec, i, plan);
    } catch (error) {
      if (!/the program needs \d+ words/.test(error.message)) throw error;
      tooBig.add(i);
      return null;
    }
  });
  if (tooBig.size) {
    corePlans = plans(spec, lowered, { compact: tooBig });
    images = corePlans.map((plan, i) => compileCore(spec, i, plan, { compact: tooBig.has(i) }));
  }
  return {
    document: program(spec, images, (({ forceCompact: _f, ...rest }) => rest)(options)),
    plans: corePlans,
    images: images.map((image, i) => ({ core: spec.cores[i].name, ...image.stats, bits: image.bits, bitBase: image.bitBase,
      ...(image.remap ? { remap: image.remap } : {}) })),
    compact: [...tooBig],
  };
}

/**
 * A core on the compact interpreter plays a repeated round from one set of table words, so the run
 * names every repetition's pulses after the first. Name each pulse after the operation whose channel
 * and start it plays: the segment's time base is where the core's first pulse, named rightly, starts.
 */
export function remapSources(result, built) {
  for (const image of built.images) {
    if (!image.remap) continue;
    const core = built.images.indexOf(image);
    const pulses = result.summary.pulses.filter((p) => p.core === core).sort((x, y) => x.startTime - y.startTime);
    if (!pulses.length) continue;
    const first = image.remap.find(([ch, , src]) => ch === pulses[0].channel && src === pulses[0].source);
    if (!first) continue;
    const base = pulses[0].startTime - first[1];
    const byKey = new Map(image.remap.map(([ch, at, src]) => [ch + ":" + at, src]));
    for (const p of pulses) {
      const src = byKey.get(p.channel + ":" + (p.startTime - base));
      if (src !== undefined) p.source = src;
    }
  }
  return result;
}

/** Measured bits by name, read from the words each core stored to the host result window. */
export function measuredBits(result, built) {
  const bits = {};
  for (const write of result.summary.host) {
    const name = Object.entries(built.images[write.core].bits).find(([, index]) => 4 * index === write.offset)?.[0];
    if (name !== undefined) bits[name] = write.value;
  }
  return bits;
}
