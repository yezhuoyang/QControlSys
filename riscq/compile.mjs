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
export function plans(spec, lowered) {
  // A core with no action parks at once and joins no barrier.
  const active = new Set(lowered.actions.map((a) => a.core));
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
  // A burst of simultaneous writes takes the core many cycles to issue. Every core delays the
  // segment by the same preroll so that the earliest write still leaves on time.
  const prerolls = lowered.segments.map((_, s) => Math.max(0, ...[...active].map((index) =>
    prerollOf(spec.cores[index], lowered.actions.filter((a) => a.segment === s && a.core === index)))));
  const shift = (op, by) => ({
    ...op, at: op.at + by,
    ...(op.read ? { read: { ...op.read, until: op.read.until + by } } : {}),
    ...(op.count ? { count: { ...op.count, until: op.count.until + by } } : {}),
  });
  return spec.cores.map((core, index) => {
    if (!active.has(index)) return { channels: [], segments: [] };
    const fetched = new Set();
    const segments = lowered.segments.map((segment, s) => {
      const mine = lowered.actions.filter((a) => a.segment === s && a.core === index);
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
        sync: members > 1 ? { barrier: s % 16, members } : undefined,
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

/** Compile lowered actions to the document the Lean executable runs, with per-core statistics. */
export function assemble(spec, lowered, options = {}) {
  const corePlans = plans(spec, lowered);
  const images = corePlans.map((plan, i) => compileCore(spec, i, plan));
  return {
    document: program(spec, images, options),
    plans: corePlans,
    images: images.map((image, i) => ({ core: spec.cores[i].name, ...image.stats, bits: image.bits, bitBase: image.bitBase })),
  };
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
