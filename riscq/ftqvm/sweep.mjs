// Run the corpus on every design point: derive a spec per (program, design), record what the
// hardware did, and write a table.
//
//   node riscq/ftqvm/sweep.mjs [--program id]… [--design id]… [--out validation/ftqvm/results]
//
// Writes <out>/<program>.<design>.json (spec with sources, per-kind slack, decodes, factories)
// and <out>/summary.json and summary.md.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deriveSpec } from "./derive.mjs";
import { transmon, optical } from "./platforms.mjs";
import { programs, DESIGNS } from "./corpus.mjs";
import * as specText from "./spec.mjs";

const ADAPTERS = { superconducting: transmon, neutral: (o) => optical(o.id), qccd: (o) => optical(o.id) };

export async function sweep({ only = [], designs = [], out, baseMachine = resolve("validation/ftqvm/base.machine"), log = console.log } = {}) {
  const rows = [];
  for (const program of programs().filter((p) => !only.length || only.includes(p.id)))
    for (const [platform, points] of Object.entries(DESIGNS))
      for (const design of points.filter((d) => !designs.length || designs.includes(d.id))) {
        const t0 = Date.now();
        const row = { program: program.id, scale: program.scale, distance: program.distance, platform, design: design.id };
        try {
          const { iterations } = await deriveSpec({ platform: ADAPTERS[platform](design.options), qppm: program.qppm, specialize: program.specialize, distance: program.distance, baseMachine });
          const last = iterations.at(-1);
          const kinds = {};
          for (const o of last.listing.ops) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
          Object.assign(row, {
            pools: last.report.pools,
            verdict: last.verdict, conforms: last.report.conforms, iterations: iterations.length,
            sites: last.sites, ops: last.listing.ops.length, kinds, makespanNs: last.makespanNs,
            machine: Object.fromEntries(Object.entries(last.spec.machine).map(([k, v]) => [k, v.value])),
            sources: Object.fromEntries(Object.entries(last.spec.machine).map(([k, v]) => [k, v.source])),
            factory: last.spec.factories?.factory, contracts: last.contracts, slack: last.slack,
            seconds: (Date.now() - t0) / 1000,
          });
          if (out) {
            await mkdir(out, { recursive: true });
            await writeFile(join(out, program.id + "." + design.id + ".json"), JSON.stringify({ ...row, spec: last.spec,
              machineText: specText.machineText(last.spec), sysspecText: specText.sysspecText(last.spec),
              report: { byKind: last.report.byKind, unrealized: last.report.unrealized } }, null, 1));
          }
        } catch (error) {
          Object.assign(row, { error: error.message.split("\n")[0].slice(0, 300), seconds: (Date.now() - t0) / 1000 });
        }
        rows.push(row);
        log([row.program, row.design, row.error ? "ERROR " + row.error : (row.conforms ? "conforms" : "DOES NOT CONFORM") + " sites " + row.sites + " ops " + row.ops + " makespan " + row.makespanNs + " ns", row.seconds + " s"].join(" · "));
      }
  if (out) {
    await writeFile(join(out, "summary.json"), JSON.stringify(rows, null, 1));
    await writeFile(join(out, "summary.md"), table(rows));
  }
  return rows;
}

/** A Markdown table of a sweep. */
export function table(rows) {
  const head = "| Program | Scale | d | Design | Qubits | Ops | Calls | Conforms | Makespan (µs) | 1q / 2q / meas / reset / route (ns) | Decoder (µs) | Frame (ns) | Factory (µs) |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n";
  return head + rows.map((r) => r.error
    ? `| ${r.program} | ${r.scale} | ${r.distance} | ${r.design} | | | | error: ${r.error.replace(/\|/g, "/")} | | | | | |`
    : `| ${r.program} | ${r.scale} | ${r.distance} | ${r.design} | ${r.sites} | ${r.ops} | ${Object.keys(r.kinds).length} | ${r.conforms ? "yes" : "no"} | ${(r.makespanNs / 1000).toFixed(1)} | ${["gate1q_ns", "gate2q_ns", "measure_ns", "reset_ns", "route_latency_ns"].map((k) => r.machine[k]).join(" / ")} | ${(r.machine.decoder_latency_ns / 1000).toFixed(1)} | ${r.kinds.pauli_frame_update ? r.machine.pauli_frame_update_ns : "–"} | ${r.kinds.request_magic ? (r.factory.latency / 1000).toFixed(1) : "–"} |`).join("\n") + "\n";
}

if (import.meta.url === "file:///" + process.argv[1].replace(/\\/g, "/").replace(/^\//, "")) {
  const args = process.argv.slice(2);
  const all = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const out = all("--out")[0] ?? "validation/ftqvm/results";
  await sweep({ only: all("--program"), designs: all("--design"), out });
  console.log(await readFile(join(out, "summary.md"), "utf8"));
}
