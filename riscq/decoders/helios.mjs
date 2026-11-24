// The Helios union-find decoder as firmware for a RISC-Q control core.
//
// Helios (Liyanage, Wu, Tagare, Zhong: "FPGA-based Distributed Union-Find Decoder for Surface
// Codes", IEEE TQE 2024, https://github.com/NamiLiy/Helios_scalable_QEC, BSD-3-Clause) is an
// FPGA decoder. Its repository carries a C program, software_code/union_find.c, that computes
// what the hardware computes and that the hardware test benches are checked against. This
// module compiles that C file, unmodified except for its distance constant, with RISC-Q's
// firmware runtime, and runs it in the Lean model of a RISC-Q core.
//
// The decoding graph is that of one error type of a rotated surface code of distance D over D
// measurement rounds: D · (D + 1) · (D − 1)/2 nodes. A syndrome is one 0/1 value per node. The
// decoder grows and merges clusters and reports the root node of every node as 0x00KKIIJJ
// (round, row, column). It does not turn clusters into a correction.
//
// Units: times are batches (dspClk cycles) of the core. The core costs one batch per
// instruction plus the model's branch and bus penalties (riscq/soc.mjs `model`), an assumed
// cost, so a decode time here is a property of this model and not of a board.
import { readFileSync } from "node:fs";
import { socSpec, program, execute } from "../soc.mjs";
import { loadElf } from "../rv32.mjs";
import { compileC, functionSourceMap } from "../toolchain.mjs";

const upstreamDir = new URL("../../validation/decoders/helios/", import.meta.url);
const libcDir = new URL("./libc/", import.meta.url);
const text = (url) => readFileSync(url, "utf8");

export const provenance = {
  repository: "https://github.com/NamiLiy/Helios_scalable_QEC",
  commit: "622d85d",
  file: "software_code/union_find.c",
  license: "BSD-3-Clause",
  change: "the line '#define D 13' is set to the distance, as the upstream README instructs",
};

/** Nodes of the decoding graph of distance `d`. */
export const nodes = (d) => d * (d + 1) * ((d - 1) / 2);

/** The upstream C source with its distance constant set. */
export function source(distance) {
  if (!Number.isInteger(distance) || distance < 3 || distance % 2 === 0) throw Error("The code distance is an odd number of at least 3.");
  const upstream = text(new URL("union_find.c", upstreamDir));
  const line = "#define D 13";
  if (upstream.split(line).length !== 2) throw Error("The Helios source is expected to contain '#define D 13' once.");
  return upstream.replace(line, "#define D " + distance);
}

/**
 * Helios's own test vectors for distance 3 (test_benches/test_data/*_3_rsc.txt): 1000 cases
 * as [{ id, syndrome: [0 or 1 per node], roots: [0x00KKIIJJ per node] }].
 */
export function upstreamVectors() {
  const words = (name) => text(new URL(name, upstreamDir)).split(/\r?\n/).filter(Boolean).map((line) => parseInt(line, 16));
  const input = words("input_data_3_rsc.txt"), output = words("output_data_3_rsc.txt");
  const record = 1 + nodes(3);
  const cases = [];
  for (let at = 0; at + record <= input.length; at += record) {
    if (input[at] !== output[at]) throw Error("The Helios input and output vectors disagree on a test id.");
    cases.push({ id: input[at], syndrome: input.slice(at + 1, at + record), roots: output.slice(at + 1, at + record) });
  }
  return cases;
}

/** A one-core build for the decoder alone: 64 KiB of RAM at the 500 MHz of the x6y3 build. */
export function decoderSpec() {
  return socSpec({
    name: "helios-union-find", dsp_freq_hz: 500e6, link_pipe: 4,
    core_defaults: { mem_depth: 16384, with_mul: true, queue_depth: 4 },
    // RISC-Q requires a channel on every core. The decoder does not use it.
    cores: [{ name: "decoder", channels: [{ name: "status", kind: "dio", slots: 1 }] }],
  });
}

/**
 * Compile the decoder for `distance` with the syndromes of `cases` ([{ id, syndrome }]) placed
 * in its RAM. Returns the ELF bytes. Needs clang with the riscv32 target.
 */
export function build(distance, cases, { spec = decoderSpec(), core = 0, clang } = {}) {
  const record = 1 + nodes(distance);
  for (const c of cases)
    if (c.syndrome.length !== record - 1 || c.syndrome.some((bit) => bit !== 0 && bit !== 1))
      throw Error("A syndrome of distance " + distance + " has " + (record - 1) + " values of 0 or 1.");
  const words = cases.flatMap((c) => [c.id >>> 0, ...c.syndrome]);
  const input = "#include <stdint.h>\nconst uint32_t rq_input[] = { " + (words.length ? words.join(", ") : "0") + " };\n" +
    "const uint32_t rq_input_words = " + words.length + ";\nconst uint32_t rq_record_words = " + record + ";\n";
  const files = { "union_find.c": source(distance), "rq_input.c": input };
  for (const name of ["rq_libc.c", "stdio.h", "stdlib.h", "math.h", "time.h"]) files[name] = text(new URL(name, libcDir));
  return compileC(spec, core, files, { clang });
}

/** The phase of the program a C function belongs to. Frames of the trace carry it as their source. */
export const phases = {
  load: { title: "load syndrome", functions: ["loadFileData", "fscanf"] },
  decode: { title: "union-find", functions: ["union_find", "grow", "merge", "merge_internal", "get_root", "get_parity", "update_boundary", "max"] },
  report: { title: "report roots", functions: ["print_output", "fprintf"] },
};
const phaseOf = (name) => Object.keys(phases).find((phase) => phases[phase].functions.includes(name)) ?? "runtime";

/** The image the Lean model loads: RAM words and a source map that names the phase of each instruction. */
export function image(elf) {
  return { words: loadElf(elf), sourceMap: functionSourceMap(elf, phaseOf) };
}

/**
 * Run a compiled decoder in the Lean model and read its results from the trace.
 * Returns the run and, per decoded record:
 *   id, roots           what the firmware stored to the host window
 *   inputAt             batch at which the record's last syndrome value had been read
 *   firstOutputAt       batch of the record's first stored word
 *   lastOutputAt        batch of its last stored word
 *   decodeBatches       firstOutputAt − inputAt: the union-find itself
 */
export async function run(elf, distance, { spec = decoderSpec(), core = 0, trace = "io", maxSteps = 20000000 } = {}) {
  const images = spec.cores.map((_, i) => (i === core ? image(elf) : { words: [0x0000006f], sourceMap: [] }));
  const result = await execute(program(spec, images, { trace, maxSteps, maxEvents: 400000, maxBatches: 2000000000 }));
  return { result, decodes: decodes(result, distance, spec.cores[core].name) };
}

/** Decoded records of a run, from the frames of the decoder core. */
export function decodes(result, distance, coreName = "decoder") {
  const record = 1 + nodes(distance);
  const marks = result.frames.filter((f) => f.part === coreName && f.op === "read" && f.state.register === "time" && f.source === "load");
  const stores = result.frames.filter((f) => f.part === coreName && f.op === "host");
  const out = [];
  for (let k = 0; (k + 1) * record <= stores.length; k++) {
    const mine = stores.slice(k * record, (k + 1) * record);
    out.push({
      id: mine[0].state.store, roots: mine.slice(1).map((f) => f.state.store),
      inputAt: marks[k]?.atBatch, firstOutputAt: mine[0].atBatch, lastOutputAt: mine.at(-1).atBatch,
      decodeBatches: marks[k] ? mine[0].atBatch - marks[k].atBatch : undefined,
      frames: { input: marks[k]?.id, firstOutput: mine[0].id, lastOutput: mine.at(-1).id },
    });
  }
  return out;
}

/** Reference cases of a distance (validation/decoders/helios/reference-d<D>.json): syndromes and expected roots. */
export function reference(distance) {
  const file = JSON.parse(text(new URL("reference-d" + distance + ".json", upstreamDir)));
  return { ...file, cases: file.cases.map((c) => ({ ...c, syndrome: [...c.syndrome].map(Number) })) };
}

/** The committed firmware image of a distance, compiled from the reference cases (images.json). */
export function prebuilt(distance) {
  return new Uint8Array(readFileSync(new URL("uf-d" + distance + ".elf", upstreamDir)));
}

/**
 * Run a decoder image on the reference cases of its distance and compare every root with the
 * expected one. Returns the Lean run and, per case, whether it matches and how long it took.
 */
export async function conformance(distance, { elf = prebuilt(distance), ...options } = {}) {
  const expected = reference(distance);
  const { result, decodes: decoded } = await run(elf, distance, options);
  const periodNs = result.program.dspPeriodPs / 1000;
  const cases = expected.cases.map((c, k) => {
    const mine = decoded[k];
    return {
      id: c.id, origin: c.origin, weight: c.weight,
      matches: Boolean(mine) && mine.id === c.id && mine.roots.length === c.roots.length && mine.roots.every((root, i) => root === c.roots[i]),
      decodeBatches: mine?.decodeBatches, decodeNs: mine ? mine.decodeBatches * periodNs : undefined,
      reportNs: mine ? (mine.lastOutputAt - mine.firstOutputAt) * periodNs : undefined,
      clusters: mine ? new Set(mine.roots).size : undefined, frames: mine?.frames,
    };
  });
  return { distance, nodes: expected.nodes, result, decodes: decoded, cases };
}
