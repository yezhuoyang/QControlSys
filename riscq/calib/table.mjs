// The calibration table: every the compiler machine field on every design, against the audits.
//
// Inputs (all in validation/calib or validation/ftqvm):
//   insitu/*.json            every operation of the corpus on each design (riscq/calib/insitu.mjs)
//   fabric.json              classical fabric microbenchmarks (riscq/calib/fabric.mjs)
//   ../ftqvm/decoder-calibration.json   the compiled decoder's calibration (riscq/decoders/calibrate.mjs)
//   backlog.json, factory.json          the contention studies (riscq/calib/backlog.mjs, factory.mjs)
// Output: table.json and table.md, one row per field × design: the derived value (what the spec
// must say for the corpus to conform), the distribution of what operations needed, the slack the
// derived value leaves at the median, and the values the compiler's audit machines declare for that
// platform.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { stats } from "../os/des.mjs";

const DIR = new URL("../../validation/calib/", import.meta.url);
const read = (u) => JSON.parse(readFileSync(u, "utf8"));
const FIELD_OF = {
  H: "gate1q_ns", S: "gate1q_ns", Sdg: "gate1q_ns", X: "gate1q_ns", Z: "gate1q_ns",
  CNOT: "gate2q_ns", CZ: "gate2q_ns", CY: "gate2q_ns",
  measure: "measure_ns", request_ancilla: "reset_ns", route: "route_latency_ns",
  decode_syndrome: "decoder_latency_ns", pauli_frame_update: "pauli_frame_update_ns", parity: "pauli_frame_update_ns",
  request_magic: "magic_state_latency_ns",
};

/** The compiler's audit machines, by platform (Audit/*; values as declared there). */
export const AUDITS = {
  superconducting: {
    GE2021: { gate1q_ns: 25, gate2q_ns: 50, measure_ns: 550, reset_ns: 250, route_latency_ns: 100, decoder_latency_ns: 10000, magic_state_latency_ns: 135000, pauli_frame_update_ns: 40, classical_data_bandwidth: 17873856, decoders: 12276 },
    Gidney2025: { gate1q_ns: 25, gate2q_ns: 50, measure_ns: 550, reset_ns: 250, route_latency_ns: 100, decoder_latency_ns: 10000, magic_state_latency_ns: 150000, pauli_frame_update_ns: 40, classical_data_bandwidth: 922272, decoders: 1550 },
    Beverland2022: { gate1q_ns: 50, gate2q_ns: 50, measure_ns: 100, reset_ns: 100, route_latency_ns: 400, decoder_latency_ns: 10000, magic_state_latency_ns: 72800, pauli_frame_update_ns: 40, classical_data_bandwidth: 43062890, decoders: 25481 },
    Pinnacle: { gate1q_ns: 100, gate2q_ns: 100, measure_ns: 200, reset_ns: 200, route_latency_ns: 1000, decoder_latency_ns: 10000, magic_state_latency_ns: 18000, pauli_frame_update_ns: 40, classical_data_bandwidth: 23984930, decoders: 166 },
    Jacinto2026: { gate1q_ns: 25, gate2q_ns: 50, measure_ns: 475, reset_ns: 250, route_latency_ns: 100, decoder_latency_ns: 10000, magic_state_latency_ns: 109300, pauli_frame_update_ns: 40, classical_data_bandwidth: 100000000, decoders: 100000 },
  },
  neutral: {
    Zhou2025: { gate1q_ns: 1000, gate2q_ns: 100000, measure_ns: 500000, reset_ns: 1000, route_latency_ns: 500000, decoder_latency_ns: 1000000, magic_state_latency_ns: 34000000, pauli_frame_update_ns: 40, classical_data_bandwidth: 100000000, decoders: 100000 },
    CainXu2026: { gate1q_ns: 10000, gate2q_ns: 20000, measure_ns: 400000, reset_ns: 100000, route_latency_ns: 1000, decoder_latency_ns: 1000000, magic_state_latency_ns: 1000, pauli_frame_update_ns: 1000, classical_data_bandwidth: 1000000, decoders: 1e12 },
  },
  qccd: {},
};

export function buildTable() {
  const insitu = existsSync(new URL("insitu/", DIR)) ? readdirSync(new URL("insitu/", DIR)).filter((f) => f.endsWith(".json")).map((f) => read(new URL("insitu/" + f, DIR))) : [];
  const runs = insitu.filter((r) => !r.error && r.conforms);
  const failed = insitu.filter((r) => r.error || !r.conforms).map((r) => ({ program: r.program, design: r.design, why: r.error ? r.error.split("\n")[0].slice(0, 160) : "does not conform" }));
  const designs = [...new Set(runs.map((r) => r.platform + "/" + r.design))];
  const rows = [];
  for (const pd of designs) {
    const [platform, design] = pd.split("/");
    const mine = runs.filter((r) => r.design === design);
    const fields = {};
    for (const r of mine) for (const s of r.samples) {
      const f = FIELD_OF[s.kind];
      if (!f || s.neededNs === null) continue;
      (fields[f] ??= { needed: [], declared: [], programs: new Set() });
      fields[f].needed.push(s.neededNs); fields[f].declared.push(s.declaredNs); fields[f].programs.add(r.program);
    }
    for (const [field, x] of Object.entries(fields)) {
      const derived = Math.max(...mine.map((r) => r.machine[field]?.value ?? 0));
      const st = stats(x.needed);
      rows.push({
        platform, design, field, programs: [...x.programs].sort(), samples: st.n, derived,
        needed: st, slackAtMedian: derived - st.p50, coverageOfP50: x.needed.filter((v) => v <= st.p50).length / st.n,
        audits: Object.fromEntries(Object.entries(AUDITS[platform] ?? {}).map(([k, m]) => [k, m[field] ?? null])),
      });
    }
    // Capacities and bandwidths as derived (the largest any program's spec declared).
    for (const field of ["decoders", "classical_data_bandwidth", "max_parallel_gates", "qubit_routing_bandwidth", "ancilla_bandwidth", "factories", "qubits"]) {
      const vals = mine.map((r) => r.machine[field]?.value).filter((v) => v !== undefined);
      if (vals.length) rows.push({ platform, design, field, derived: Math.max(...vals), source: mine[0].machine[field]?.source, audits: Object.fromEntries(Object.entries(AUDITS[platform] ?? {}).map(([k, m]) => [k, m[field] ?? null])) });
    }
  }
  const fabric = existsSync(new URL("fabric.json", DIR)) ? read(new URL("fabric.json", DIR)) : null;
  const decoder = read(new URL("../ftqvm/decoder-calibration.json", DIR));
  return {
    generated: new Date().toISOString(), runs: runs.length, failed, rows,
    fabric: fabric && { publish: fabric.publish, barrier: fabric.barrier, flood: fabric.flood, ops: fabric.ops, laneDelay: fabric.laneDelay },
    decoder: { fields: decoder.fields, model: decoder.model, inRun: decoder.inRun },
  };
}

/** The table as Markdown. */
export function markdown(t) {
  const fmt = (v) => (v === null || v === undefined ? "–" : typeof v === "number" ? (Math.abs(v) >= 1e6 ? v.toExponential(2) : String(Math.round(v * 100) / 100)) : String(v));
  const lines = ["# System-call calibration", "", "Generated " + t.generated + " from " + t.runs + " conforming runs.", ""];
  lines.push("| Platform | Design | Field | Programs | Ops | Derived | Needed min / p50 / p99 / max | Slack at p50 | Audits |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of t.rows) lines.push("| " + [r.platform, r.design, "`" + r.field + "`", r.programs ? r.programs.length : "–", r.samples ?? "–", fmt(r.derived),
    r.needed ? [r.needed.min, r.needed.p50, r.needed.p99, r.needed.max].map(fmt).join(" / ") : (r.source ?? ""), r.slackAtMedian !== undefined ? fmt(r.slackAtMedian) : "–",
    Object.entries(r.audits ?? {}).map(([k, v]) => k + " " + fmt(v)).join(", ") || "–"].join(" | ") + " |");
  if (t.failed.length) { lines.push("", "Not conforming or failed:", ""); for (const f of t.failed) lines.push("- " + f.program + " on " + f.design + ": " + f.why); }
  return lines.join("\n") + "\n";
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const t = buildTable();
  writeFileSync(new URL("table.json", DIR), JSON.stringify(t, null, 1) + "\n");
  writeFileSync(new URL("table.md", DIR), markdown(t));
  console.log("rows", t.rows.length, "from", t.runs, "runs;", t.failed.length, "failed");
}
