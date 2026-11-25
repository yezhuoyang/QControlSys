// RISC-Q's own firmware binaries (validation/riscq/firmware/, vendored from RISC-Q) on RISC-Q's RTL and
// in the Lean model: commit cycles of every core, the cycle and batch time of every pulse opening at a
// channel output, and every host-window write.
//   node validation/riscq/rtl/firmware-rtl.mjs
import { readFileSync } from "node:fs";
import { loadElf } from "../../../riscq/rv32.mjs";
import { socSpec, program, execute } from "../../../riscq/soc.mjs";
import { runRtlBatch, compareCommits } from "../../../riscq/rtl.mjs";

const fixture = (name) => readFileSync(new URL("../" + name, import.meta.url));
const elf = (name) => loadElf(new Uint8Array(fixture("firmware/" + name)));
const spec = socSpec({ ...JSON.parse(fixture("sim-2q.json")), dac_map: [[8, 8], [1, 1]] });
const parked = { words: [0x0000006f], sourceMap: [] };
function withParameter(words, index, value) {
  const image = words.slice();
  while (image.length <= index) image.push(0);
  image[index] = value;
  return { words: image, sourceMap: [] };
}
const last = spec.cores[0].memWords - 1;
const xcore = elf("xcore.elf");
const docs = [
  program(spec, [{ words: elf("pulse_sched.elf"), sourceMap: [] }, parked], { name: "pulse_sched", trace: "full" }),
  program(spec, [withParameter(xcore, last, 0), withParameter(xcore, last, 1)], { name: "xcore", trace: "full" }),
];
const leans = [];
for (const d of docs) leans.push(await execute(d));
const rtls = runRtlBatch(docs, { cycles: 3000, dir: "output/rtl/firmware" });
docs.forEach((doc, i) => {
  const lean = leans[i], rtl = rtls[i];
  console.log("==", doc.name, "lean", lean.summary.status);
  for (const c of compareCommits({ ...lean, cores: doc.cores }, rtl)) console.log(" core", c.core, "compared", c.compared, "same cycle", c.sameCycle, "pc mismatch", c.pcMismatch, JSON.stringify(c.diffs.slice(0, 4)));
  // Align on core 0's first commit.
  const l0 = lean.frames.find((f) => f.part === doc.cores[0].name && f.op === "exec").atBatch, r0 = rtl.commits.find((c) => c[0] === 0)[1];
  console.log(" pulses lean (core, opens−first commit, time at opens)", JSON.stringify(lean.summary.pulses.map((p) => [p.core, p.channel, p.opens - l0, p.startTime])));
  console.log(" pulses rtl  (core, channel, open−first commit, time at open)", JSON.stringify(rtl.pulses.map((p) => [p[0], p[1], p[2] - r0, p[3]])));
  console.log(" host lean", JSON.stringify(lean.summary.host.map((h) => [h.core, h.atBatch - l0, h.value])), "rtl", JSON.stringify(rtl.host.map((h) => [h[0], h[1] - r0, h[4]])));
});
