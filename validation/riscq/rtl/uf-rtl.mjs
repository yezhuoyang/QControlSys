// The compiled union-find decoder (riscq/decoders/uf_decoder.c, the decode_syndrome service) run on
// RISC-Q's RTL and in the Lean model: every instruction must commit on the same cycle, and every
// decode's result and its start and end times (the host writes) must be the same.
//
// The decoder is the one a logical-qubit page compiled for its circuit (the cached graph of
// riscq/ftqvm/logical.mjs, validation/ftqvm/papers/<dir>/graph-<circuit>.json), the cases its noisy
// shots, in the bench build: one decode after another on one core.
//   node validation/riscq/rtl/uf-rtl.mjs <dir> <circuit> [cases]
//   e.g. node validation/riscq/rtl/uf-rtl.mjs caune2024 circuit-feedback-n9 12
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { program, execute } from "../../../riscq/soc.mjs";
import { loadElf } from "../../../riscq/rv32.mjs";
import { runRtl, compareCommits, available } from "../../../riscq/rtl.mjs";
import { build, benchSpec } from "../../../riscq/decoders/uf.mjs";

const [dir, circuit, n = "12"] = process.argv.slice(2);
if (!available()) throw Error("RISC-Q's RTL checkout is not set up in WSL (validation/riscq/rtl/README.md)");
const cache = JSON.parse(readFileSync(fileURLToPath(new URL("../../ftqvm/papers/" + dir + "/graph-" + circuit + ".json", import.meta.url)), "utf8"));
const graph = cache.graph;
// Shots where detectors fired first: those are the decodes that do work.
const order = graph.shots.map((s, i) => i).sort((a, b) => (graph.defects[b] > 0) - (graph.defects[a] > 0) || a - b);
const cases = order.slice(0, Number(n)).map((i) => graph.shots[i]);
const spec = benchSpec();
const { elf, bytes, pruned } = build(graph, { kind: "bench", cases }, { spec });
const images = spec.cores.map(() => ({ words: loadElf(elf), sourceMap: [] }));
const name = "uf-" + dir + "-" + circuit;
const doc = program(spec, images, { name, trace: "full", maxSteps: 20_000_000, maxEvents: 400_000, maxBatches: 2_000_000_000 });
const lean = await execute(doc);
const frames = lean.frames.filter((f) => f.part === "dec0.0");
const leanEnd = lean.summary.elapsedBatches;
console.log(name, "image", bytes, "bytes", pruned ? "(pruned)" : "", "| lean", lean.summary.status, "frames", frames.length, "elapsed", leanEnd);
// The same image; only the core's name changes for the RTL (a Verilog name cannot hold "dec0.0"'s dot).
const rtl = runRtl({ ...doc, cores: doc.cores.map((c) => ({ ...c, name: c.name.replace(/\W/g, "_") })) }, { cycles: leanEnd + 400, dir: "output/rtl/" + name });
const cmp = compareCommits({ ...lean, cores: doc.cores }, rtl, { limit: 10 })[0];
console.log("rtl commits", rtl.commits.length, "compared", cmp.compared, "same cycle", cmp.sameCycle, "pc mismatch", cmp.pcMismatch);
if (cmp.diffs.length) console.log("first differences", JSON.stringify(cmp.diffs.slice(0, 10)));
// Host writes: every case stores its index, start and end batch, correction, measured observable,
// detectors fired and rounds. Compared value for value, and time for time from each first commit.
const l0 = frames[0].atBatch, r0 = rtl.commits[0][1];
const lh = lean.summary.host.map((h) => [h.atBatch - l0, h.offset, h.value >>> 0]);
const rh = rtl.host.map((h) => [h[1] - r0, h[3], h[4] >>> 0]);
const sameTimes = lh.length === rh.length && lh.every((x, i) => x[0] === rh[i][0]);
// Words 1 and 2 of a case are the batch-time register at the decode's start and end: the two runs
// count batches from different origins, so those compare as the decode's length.
const per = (h) => { const m = new Map(h.map(([, off, val]) => [off / 4, val])); return cases.map((_, c) => ({ index: m.get(c * 7), batches: m.get(c * 7 + 2) - m.get(c * 7 + 1), mask: m.get(c * 7 + 3), measured: m.get(c * 7 + 4), defects: m.get(c * 7 + 5), rounds: m.get(c * 7 + 6) })); };
const decodes = per(rh), leanDecodes = per(lh);
const sameValues = JSON.stringify(decodes) === JSON.stringify(leanDecodes);
console.log("host writes", lh.length, rh.length, "same cycles", sameTimes, "same results and decode lengths", sameValues);
console.log("decode cycles on the RTL", decodes.map((d) => d.batches).join(","));
if (!sameValues) console.log("lean", JSON.stringify(leanDecodes), "\nrtl ", JSON.stringify(decodes));
mkdirSync("output/rtl", { recursive: true });
const out = { name, circuit: dir + "/" + circuit, cases: cases.length, bytes, pruned, cmp: { compared: cmp.compared, sameCycle: cmp.sameCycle, pcMismatch: cmp.pcMismatch, diffs: cmp.diffs.slice(0, 10) },
  host: { lean: lh.length, rtl: rh.length, sameTimes, sameValues }, decodes, lean: { commits: frames.length, elapsed: leanEnd }, rtl: { commits: rtl.commits.length } };
writeFileSync("output/rtl/" + name + ".json", JSON.stringify(out, null, 1));
