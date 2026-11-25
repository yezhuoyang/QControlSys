// A control program with the compiled union-find decoder on one of its cores, in the same run.
//
// The platform's lowering gives channel actions for every core (riscq/compile.mjs). This module
// adds the decode: it places the measured bits of the decode on the board's shared groups (as
// RISC-Q's firmware shares a lookup decoder's inputs), compiles the generated firmware of every
// other core as usual, and compiles riscq/decoders/uf_decoder.c in its in-run mode for the decoder
// core, with the segment count, barrier membership and the group and slot of every input and
// output. In the run:
//   segment k        the measuring cores read their bits and publish them to the hub
//   segment k + 1    every core meets at the barrier; the decoder reads the hub's words, decodes,
//                    publishes the corrected observables and the "a detector fired" flag
//   segment k + 2    every core meets again; a pulse conditioned on a decoded bit plays or not
// The hub has 4 words of 32 shared bits (riscq/compile.mjs), so one decode reads at most 128
// measured bits, less the outputs that other cores condition on.
import { plans } from "../compile.mjs";
import { compileCore } from "../firmware.mjs";
import { program } from "../soc.mjs";
import { loadElf } from "../rv32.mjs";
import { build } from "./uf.mjs";

/**
 * Compile `lowered` with a decode on `decoderCore` in segment `segment`.
 *   graph     the circuit's decoding graph (bridge/magic_sim.py "graph"), its measurements in
 *             the order of `inputs`
 *   inputs    the bit names of the circuit's measurements, in record order
 *   outputs   a bit name per observable: the corrected value, for `when` conditions
 *   flag      a bit name: 1 when any detector fired (for postselection or a repeat)
 * Returns { document, built, map, decoder: { bytes, words } } where `built` has the shape
 * riscq/compile.mjs assemble returns (images with their bit maps).
 */
export function assembleWithDecoder(spec, lowered, { decoderCore, segment, graph, inputs, outputs, flag, options = {}, publishMask = false }) {
  if (inputs.length !== graph.measurements) throw Error("the decode reads " + inputs.length + " bits; the graph has " + graph.measurements + " measurements");
  if (inputs.length > 128) throw Error("a decode reads " + inputs.length + " measured bits; the board hub shares 128");
  // Placeholder lookup decodes on the decoder core: plans() shares their inputs in consecutive
  // slots, a word per 32 bits, and the outputs that other cores condition on.
  const chunks = [];
  for (let k = 0; k < inputs.length; k += 32) chunks.push(inputs.slice(k, k + 32));
  const placeholders = chunks.map((bits, k) => ({
    segment, core: decoderCore, at: 0, source: "uf-decode",
    decode: { inputs: bits, table: [], outputs: k === 0 ? [...outputs, flag] : ["uf.pad" + k] },
  }));
  const all = { ...lowered, actions: [...lowered.actions, ...placeholders] };
  const corePlans = plans(spec, all);
  const mine = corePlans[decoderCore];
  const decodes = mine.segments[segment].ops.filter((op) => op.decode);
  const inputsMap = [], seen = new Map();
  decodes.forEach((op, k) => chunks[k].forEach((bit, i) => seen.set(bit, { group: op.decode.group, slot: op.decode.slot + i })));
  for (const bit of inputs) inputsMap.push(seen.get(bit));
  const pubs = decodes[0].publishes;
  if (process.env.UF_DEBUG) console.error("decode ops", JSON.stringify(decodes.map((op) => ({ outputs: op.decode.outputs, publishes: op.publishes, group: op.decode.group, slot: op.decode.slot }))));
  const unshared = { group: 255, slot: 0 };
  const map = {
    segments: all.segments.length, members: mine.segments[0].sync?.members ?? 1, decodeSegment: segment,
    inputs: inputsMap, outputs: outputs.map((_, j) => pubs[j] ?? unshared), flag: pubs[outputs.length] ?? unshared,
    // `publishMask`: the outputs are the correction's bits (the logical flips) instead of the corrected observables.
    publishMask,
  };
  const { elf, bytes, pruned } = build(graph, { kind: "inrun", map }, { spec, core: decoderCore });
  const images = corePlans.map((plan, i) => (i === decoderCore ? null : compileCore(spec, i, plan)));
  const decoderImage = { words: loadElf(elf), sourceMap: [], bits: Object.fromEntries([[flag, 6], ...outputs.map((b, j) => [b, 7 + j])]), bitBase: 0, stats: {} };
  images[decoderCore] = decoderImage;
  return {
    document: program(spec, images, options),
    built: { plans: corePlans, images: images.map((image, i) => ({ core: spec.cores[i].name, ...(image.stats ?? {}), bits: image.bits, bitBase: image.bitBase })) },
    map, decoder: { bytes, words: decoderImage.words.length, ramWords: spec.cores[decoderCore].memWords, pruned },
  };
}

/** The decoder core's record of an in-run decode, from its host stores. */
export function decodeRecord(result, decoderCore, periodNs) {
  const w = new Map(result.summary.host.filter((h) => h.core === decoderCore).map((h) => [h.offset / 4, { value: h.value >>> 0, at: h.atBatch }]));
  if (!w.has(1)) return null;
  // The core's own clock (now()) runs on its own base; the trace's time is the host store's. The
  // decode ended just before its store of t1, and lasted t1 − t0 core batches.
  const compute = w.get(1).value - w.get(0).value, end = w.get(1).at;
  return {
    startBatch: end - compute, endBatch: end, coreStart: w.get(0).value, computeNs: compute * periodNs,
    mask: w.get(2).value, observables: w.get(3).value, defects: w.get(4).value, rounds: w.get(5).value, flag: w.get(6)?.value,
    storedAtBatch: w.get(1).at,
  };
}
