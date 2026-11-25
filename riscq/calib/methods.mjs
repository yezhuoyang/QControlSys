// How to choose the one number a FormalRV field declares: a held-out test.
//
// For each design and field, the value is fitted on every program but one (the training set) by
// a rule: the worst case (max), the 99th percentile, the median, or the worst case of the
// training set plus nothing else. It is then judged on the held-out program's operations:
//   coverage   the fraction of its operations that needed no more than the value (each one that
//              needed more is late in a time-triggered run, so the listing does not conform)
//   overrun    the largest amount an operation needed beyond the value
//   slack      the mean of value − needed over the operations that fit (time the spec charges and
//              the hardware does not use)
// Inputs: validation/calib/insitu/*.json (riscq/calib/insitu.mjs). Output: methods.json.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const DIR = new URL("../../validation/calib/", import.meta.url);
const FIELD_OF = {
  H: "gate1q_ns", S: "gate1q_ns", Sdg: "gate1q_ns", X: "gate1q_ns", Z: "gate1q_ns",
  CNOT: "gate2q_ns", CZ: "gate2q_ns", CY: "gate2q_ns",
  measure: "measure_ns", request_ancilla: "reset_ns", route: "route_latency_ns",
  decode_syndrome: "decoder_latency_ns", pauli_frame_update: "pauli_frame_update_ns",
};
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
export const RULES = {
  max: (v) => v.at(-1),
  p99: (v) => quantile(v, 0.99),
  p90: (v) => quantile(v, 0.9),
  p50: (v) => quantile(v, 0.5),
};

export function heldOut() {
  const runs = readdirSync(new URL("insitu/", DIR)).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(new URL("insitu/" + f, DIR), "utf8"))).filter((r) => !r.error && r.conforms);
  const out = [];
  for (const design of [...new Set(runs.map((r) => r.design))]) {
    const mine = runs.filter((r) => r.design === design);
    const byProgramField = new Map();
    for (const r of mine) for (const s of r.samples) {
      const f = FIELD_OF[s.kind];
      if (!f || s.neededNs === null) continue;
      const k = r.program + "|" + f;
      if (!byProgramField.has(k)) byProgramField.set(k, []);
      byProgramField.get(k).push(s.neededNs);
    }
    for (const field of [...new Set([...byProgramField.keys()].map((k) => k.split("|")[1]))]) {
      const programs = mine.map((r) => r.program).filter((p) => byProgramField.has(p + "|" + field));
      if (programs.length < 2) continue;
      for (const [rule, fit] of Object.entries(RULES)) {
        let ops = 0, covered = 0, worstOver = 0, slack = 0, fits = 0, programsCovered = 0;
        for (const test of programs) {
          const train = programs.filter((p) => p !== test).flatMap((p) => byProgramField.get(p + "|" + field)).sort((a, b) => a - b);
          const value = fit(train);
          const held = byProgramField.get(test + "|" + field);
          let all = true;
          for (const need of held) {
            ops++;
            if (need <= value) { covered++; fits++; slack += value - need; } else { all = false; worstOver = Math.max(worstOver, need - value); }
          }
          if (all) programsCovered++;
        }
        out.push({ platform: mine[0].platform, design, field, rule, programs: programs.length, ops, coverage: covered / ops, programsConforming: programsCovered / programs.length, worstOverrunNs: worstOver, meanSlackNs: fits ? slack / fits : null });
      }
    }
  }
  return out;
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const rows = heldOut();
  writeFileSync(new URL("methods.json", DIR), JSON.stringify({ generated: new Date().toISOString(), rows }, null, 1) + "\n");
  // A summary per rule: over every design and field, the share of held-out programs that would conform.
  for (const rule of Object.keys(RULES)) {
    const mine = rows.filter((r) => r.rule === rule);
    const conform = mine.reduce((s, r) => s + r.programsConforming * r.programs, 0) / mine.reduce((s, r) => s + r.programs, 0);
    const coverage = mine.reduce((s, r) => s + r.coverage * r.ops, 0) / mine.reduce((s, r) => s + r.ops, 0);
    console.log(rule.padEnd(4), "| held-out programs whose every op of the field fits:", (100 * conform).toFixed(1) + "%", "| ops covered:", (100 * coverage).toFixed(2) + "%");
  }
  for (const r of rows.filter((x) => x.rule === "max" && x.programsConforming < 1)) console.log("  max fails:", r.design, r.field, "conforming", (100 * r.programsConforming).toFixed(0) + "%", "worst overrun", r.worstOverrunNs);
}
