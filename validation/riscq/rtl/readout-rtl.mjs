// The readout path on RISC-Q's RTL and in the Lean model: QuantumOS's superconducting feed-forward
// example (a measured bit conditions an X on another core) runs with every outcome 0. On the RTL the ADC
// inputs are held at 0, so each demodulation window still closes and reports a result at its own
// time; the result's value does not change when it arrives. Every commit and pulse must agree.
//   node validation/riscq/rtl/readout-rtl.mjs [example]
import * as superconducting from "../../../riscq/platforms/superconducting.mjs";
import { assemble } from "../../../riscq/compile.mjs";
import { execute } from "../../../riscq/soc.mjs";
import { examples } from "../../../riscq/examples.mjs";
import { runRtl, compareCommits } from "../../../riscq/rtl.mjs";

const id = process.argv[2] ?? "superconducting-feedforward";
const example = examples.find((e) => e.id === id);
const calls = example.calls;
const m = superconducting.machine({ decoder: calls !== undefined });
const hardware = calls ? superconducting.scheduleCalls(calls, m) : superconducting.schedule(example.source.text, m);
const lowered = superconducting.lower(hardware, m);
const built = assemble(m.spec, lowered, { trace: "full", maxEvents: 400000, maxSteps: 20000000, bindings: m.bindings,
  readouts: superconducting.readoutOracle(lowered, m, {}) });
const doc = { ...built.document, name: id };
const lean = await execute(doc);
console.log("lean", lean.summary.status, "faults", JSON.stringify(lean.summary.faults.slice(0, 3)));
const rtl = runRtl(doc, { cycles: lean.summary.elapsedBatches + 400, dir: "output/rtl/" + id });
for (const c of compareCommits({ ...lean, cores: doc.cores }, rtl)) console.log("core", c.core, "compared", c.compared, "of", c.leanCommits, "same cycle", c.sameCycle, "pc mismatch", c.pcMismatch, JSON.stringify(c.diffs.slice(0, 3)));
const l0 = lean.frames.find((f) => f.op === "exec").atBatch, r0 = Math.min(...rtl.commits.map((c) => c[1]));
const lp = lean.summary.pulses.map((p) => [p.core, p.channel, p.opens - l0]).sort((a, b) => a[2] - b[2] || a[0] - b[0]);
const rp = rtl.pulses.map((p) => [p[0], p[1], p[2] - r0]).sort((a, b) => a[2] - b[2] || a[0] - b[0]);
console.log("pulses lean", JSON.stringify(lp));
console.log("pulses rtl ", JSON.stringify(rp));
