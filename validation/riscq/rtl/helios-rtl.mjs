// The Helios union-find decoder (riscq/decoders/helios.mjs, the committed image of a distance) run
// on RISC-Q's RTL and in the Lean model: every instruction must commit on the same cycle, and each
// decode must take the same number of cycles.
//   node validation/riscq/rtl/helios-rtl.mjs [distance]
import * as helios from "../../../riscq/decoders/helios.mjs";
import { program, execute } from "../../../riscq/soc.mjs";
import { runRtl, compareCommits } from "../../../riscq/rtl.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const distance = Number(process.argv[2] ?? 3);
const spec = helios.decoderSpec();
const doc = program(spec, [helios.image(helios.prebuilt(distance))], { name: "helios-d" + distance, trace: "full", maxSteps: 20000000, maxEvents: 400000, maxBatches: 2000000000 });
const lean = await execute(doc);
const leanCommits = lean.frames.filter((f) => f.part === "decoder").length;
const leanEnd = lean.summary.elapsedBatches;
console.log("lean", lean.summary.status, "frames", leanCommits, "elapsed", leanEnd);
const rtl = runRtl(doc, { cycles: leanEnd + 200, dir: "output/rtl/helios-d" + distance });
const cmp = compareCommits({ ...lean, cores: doc.cores }, rtl, { limit: 10 })[0];
console.log("rtl commits", rtl.commits.length, "compared", cmp.compared, "same cycle", cmp.sameCycle, "pc mismatch", cmp.pcMismatch);
console.log("first differences", JSON.stringify(cmp.diffs.slice(0, 10)));
const r0 = rtl.commits[0][1];
const l0 = lean.frames.find((f) => f.part === "decoder").atBatch;
const lh = lean.summary.host.map((h) => h.atBatch - l0), rh = rtl.host.map((h) => h[1] - r0);
const sameHost = lh.length === rh.length && lh.every((v, i) => v === rh[i]);
console.log("host writes", lh.length, rh.length, "same cycles", sameHost);
const decodes = helios.decodes(lean, distance);
console.log("decode cycles (lean)", decodes.map((d) => d.decodeBatches).join(","));
mkdirSync("output/rtl", { recursive: true });
writeFileSync("output/rtl/helios-d" + distance + ".json", JSON.stringify({ distance, cmp, sameHost, lean: { commits: leanCommits, elapsed: leanEnd }, rtl: { commits: rtl.commits.length } }, null, 1));
