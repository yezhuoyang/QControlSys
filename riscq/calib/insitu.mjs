// In-situ calibration: what each system call costs inside real programs.
//
// For every program of the corpus (riscq/ftqvm/corpus.mjs) on every design point, the spec is
// derived as usual (riscq/ftqvm/derive.mjs: FormalRV compiles, the VM admits, the listing runs
// time-triggered on the cycle-exact model, durations are raised to what the trace needed). From the
// final, conforming run this keeps every operation's sample: the hardware time it needed (its
// pulses, and for a measurement its bit in memory) against the time the listing declared, with the
// context its cost may depend on (qubits in a route, input bits of a decode, the measured qubit).
// The microbenchmarks (riscq/calib/fabric.mjs and the platform probes) are compared against these.
//
//   node riscq/calib/insitu.mjs [--program id]… [--design id]…   → validation/calib/insitu/<program>.<design>.json
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveSpec } from "../ftqvm/derive.mjs";
import { transmon, optical } from "../ftqvm/platforms.mjs";
import { programs, DESIGNS } from "../ftqvm/corpus.mjs";

const ADAPTERS = { superconducting: transmon, neutral: (o) => optical(o.id), qccd: (o) => optical(o.id) };
const OUT = new URL("../../validation/calib/insitu/", import.meta.url);

/** Hardware time a conformance row needed (as derive.mjs): pulses, and for a measurement its bit. */
export function needed(row) {
  const pulses = row.hardwareNs ? row.hardwareNs[1] - row.start : 0;
  return Math.max(pulses, row.bitNs !== undefined ? row.bitNs - row.start : 0);
}

/** One program on one design: the derived spec and every operation's sample. */
export async function collect(program, platform, design) {
  const t0 = Date.now();
  const { iterations } = await deriveSpec({ platform: ADAPTERS[platform](design.options), qppm: program.qppm, specialize: program.specialize, distance: program.distance, baseMachine: resolve("validation/ftqvm/base.machine") });
  const last = iterations.at(-1);
  const byUid = new Map(last.listing.ops.map((o) => [o.uid, o]));
  const samples = last.report.rows.map((r) => {
    const op = byUid.get(r.uid) ?? {};
    const need = needed(r);
    return {
      uid: r.uid, kind: r.kind, declaredNs: op.duration, neededNs: Number.isFinite(need) ? need : null, listedStart: op.start,
      qubits: op.qubits?.length, reads: op.reads?.length, ok: r.ok !== false,
      ...(r.kind === "measure" ? { qubit: op.qubits?.[0] && op.qubits[0].register + "[" + op.qubits[0].index + "]" } : {}),
    };
  });
  return {
    program: program.id, distance: program.distance, platform, design: design.id, conforms: last.report.conforms, verdict: last.verdict,
    iterations: iterations.length, sites: last.sites, ops: last.listing.ops.length, makespanNs: last.makespanNs,
    machine: Object.fromEntries(Object.entries(last.spec.machine).map(([k, v]) => [k, { value: v.value, source: v.source }])),
    factory: last.spec.factories?.factory ?? null, contracts: last.contracts ?? null,
    samples, seconds: (Date.now() - t0) / 1000,
  };
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const arg = (flag) => process.argv.flatMap((a, i) => (a === flag ? [process.argv[i + 1]] : []));
  const only = arg("--program"), designs = arg("--design");
  mkdirSync(OUT, { recursive: true });
  for (const program of programs().filter((p) => !only.length || only.includes(p.id)))
    for (const [platform, points] of Object.entries(DESIGNS))
      for (const design of points.filter((d) => !designs.length || designs.includes(d.id))) {
        const name = program.id + "." + design.id;
        try {
          const r = await collect(program, platform, design);
          writeFileSync(new URL(name + ".json", OUT), JSON.stringify(r) + "\n");
          console.log(name, r.conforms ? "conforms" : "DOES NOT CONFORM", r.ops, "ops", r.seconds + " s");
        } catch (error) {
          writeFileSync(new URL(name + ".json", OUT), JSON.stringify({ program: program.id, platform, design: design.id, error: error.message.slice(0, 2000) }) + "\n");
          console.log(name, "ERROR", error.message.slice(0, 200));
        }
      }
}
