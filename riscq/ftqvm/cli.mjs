// Derive a system specification for a FormalRV program on a transmon chip, headless.
//
//   node riscq/ftqvm/cli.mjs --qppm ../FormalRV/FormalRV/Examples/QParamPPM/ZZmerge.qppm \
//     --specialize a=0 --specialize b=1 \
//     --base-machine ../FormalRV/FormalRV/Examples/QParamPPM/ZZmerge.machine \
//     --gadget surfaceRound --gadget surfaceRoundLogicalAncilla --out out/zzmerge
//
// FormalRV (unchanged, at FORMALRV_ROOT or ../FormalRV, compiler built) compiles the program
// against each spec, its VM admits the listing, and the chip runs it time-triggered
// (riscq/ftqvm/derive.mjs). `--out` receives, for the last iteration: the spec as FormalRV
// files (`derived.machine`, `derived.sysspec`) and as JSON with every value's source
// (`spec.json`), the listing FormalRV compiled against it (`listing.sysprog`), the chip
// (`chip.json`, a design the editor opens), and the conformance report (`report.json`).
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveTransmon } from "./derive.mjs";
import * as specText from "./spec.mjs";

const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const all = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
try {
  if (!value("--qppm") || !value("--base-machine")) throw Error("Usage: node riscq/ftqvm/cli.mjs --qppm P.qppm --base-machine M.machine [--specialize k=v]… [--gadget name]… [--distance 3] [--out dir]");
  const specialize = Object.fromEntries(all("--specialize").map((s) => s.split("=")).map(([k, v]) => [k, Number(v)]));
  const { iterations } = await deriveTransmon({
    qppm: value("--qppm"), baseMachine: value("--base-machine"), specialize, gadgets: all("--gadget"),
    distance: Number(value("--distance") ?? 3), maxIterations: Number(value("--iterations") ?? 5),
  });
  const last = iterations.at(-1);
  const summary = {
    iterations: iterations.map((it, i) => ({ iteration: i, verdict: it.verdict, conforms: it.report.conforms, sites: it.sites, makespanNs: it.makespanNs,
      byKind: Object.fromEntries(Object.entries(it.report.byKind).map(([k, v]) => [k, v.ok + "/" + v.count])) })),
    machine: specText.machineText(last.spec).trim(),
    unrealized: last.report.unrealized.map((u) => u.kind + " @" + u.start + " ns (line " + u.line + ")"),
  };
  console.log(JSON.stringify(summary, null, 1));
  if (value("--out")) {
    const out = value("--out");
    await mkdir(out, { recursive: true });
    const files = specText.files(last.spec);
    await writeFile(join(out, "derived.machine"), files.machine);
    await writeFile(join(out, "derived.sysspec"), files.sysspec);
    await writeFile(join(out, "spec.json"), JSON.stringify(last.spec, null, 1));
    await copyFile(last.files.sysprog, join(out, "listing.sysprog"));
    await writeFile(join(out, "chip.json"), JSON.stringify(last.design, null, 1));
    await writeFile(join(out, "report.json"), JSON.stringify({ ...summary, contracts: last.contracts, report: last.report }, null, 1));
  }
  if (!last.report.conforms) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
