// Contention across the corpus: what a dynamic runtime does with listings FormalRV admitted.
//
// For every program × design with a stored listing (validation/calib/insitu/*.json, written by
// riscq/calib/insitu.mjs), Executor B (riscq/os/des.mjs) runs the listing four ways:
//   triggered          at the listed starts with the listed durations: must reproduce the listing
//                      (no op moves, no wait), the executor's check against the VM's admission
//   greedy             dependency-driven, FIFO with backfill (an op that fits may pass one that
//                      waits): ancillas taken early can deadlock the program
//   strict             dependency-driven, program order without backfill, with the spec's durations
//   strict-measured    the same, each op lasting what it needed on the cycle-exact model
// Pools are the derived machine's: gates, decoders, factories, the bandwidths, and the ancilla
// qubits (machine qubits less the program's data qubits), held from request to release.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { simulate, machineModel } from "./des.mjs";

const DIR = new URL("../../validation/calib/", import.meta.url);

export function study({ filter = () => true } = {}) {
  const runs = readdirSync(new URL("insitu/", DIR)).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(new URL("insitu/" + f, DIR), "utf8"))).filter((r) => r.listing && !r.error && filter(r));
  const rows = [];
  for (const r of runs) {
    const listing = r.listing;
    const data = new Set(listing.ops.flatMap((o) => o.qubits).filter((q) => q.register !== "ancilla").map((q) => q.register + "[" + q.index + "]"));
    const machine = { ...listing.machine, qubits: listing.machine.qubits - data.size };
    const needed = new Map(r.samples.map((s) => [s.uid, s.neededNs]));
    const spec = machineModel(machine);
    const measured = machineModel(machine, { latency: (op) => needed.get(op.uid) ?? op.duration });
    const t = simulate(listing, { model: spec, mode: "triggered" });
    const g = simulate(listing, { model: spec, mode: "dependency", policy: "fifo" });
    const s = simulate(listing, { model: spec, mode: "dependency", policy: "order", strict: true });
    const m = simulate(listing, { model: measured, mode: "dependency", policy: "order", strict: true });
    // Ordered acquisition of the ancilla pool (resource ordering), with backfill for everything else.
    const o = simulate(listing, { model: spec, mode: "dependency", policy: "fifo", orderedPools: ["qubits"] });
    const om = simulate(listing, { model: measured, mode: "dependency", policy: "fifo", orderedPools: ["qubits"] });
    const waited = (x) => x.ops.filter((o) => o.waitNs > 0).length;
    rows.push({
      program: r.program, platform: r.platform, design: r.design, ops: listing.ops.length, ancillaPool: machine.qubits,
      listedNs: t.listedMakespanNs,
      triggered: { reproduces: t.ops.every((o) => o.start === o.listedStart) && waited(t) === 0 && !t.deadlock, makespanNs: t.makespanNs },
      greedy: { deadlock: !!g.deadlock, completed: g.completed, atNs: g.deadlock?.atNs ?? null, makespanNs: g.deadlock ? null : g.makespanNs, blockedOn: g.deadlock ? [...new Set(g.deadlock.blocked.map((b) => b.waitingFor))] : [] },
      strict: { deadlock: !!s.deadlock, makespanNs: s.deadlock ? null : s.makespanNs, waited: waited(s), speedup: s.deadlock ? null : t.listedMakespanNs / s.makespanNs },
      strictMeasured: { deadlock: !!m.deadlock, makespanNs: m.deadlock ? null : m.makespanNs, waited: waited(m), speedup: m.deadlock ? null : t.listedMakespanNs / m.makespanNs },
      ordered: { deadlock: !!o.deadlock, makespanNs: o.deadlock ? null : o.makespanNs, speedup: o.deadlock ? null : t.listedMakespanNs / o.makespanNs },
      orderedMeasured: { deadlock: !!om.deadlock, makespanNs: om.deadlock ? null : om.makespanNs, speedup: om.deadlock ? null : t.listedMakespanNs / om.makespanNs },
      peaks: Object.fromEntries(Object.entries(s.pools).map(([k, p]) => [k, p.peak + "/" + p.capacity])),
    });
  }
  return rows;
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const rows = study();
  writeFileSync(new URL("contention.json", DIR), JSON.stringify({ generated: new Date().toISOString(), rows }, null, 1) + "\n");
  for (const r of rows) console.log((r.program + " " + r.design).padEnd(30), "| ops", String(r.ops).padStart(5), "| VM reproduced", r.triggered.reproduces, "| greedy", r.greedy.deadlock ? "DEADLOCK at " + (r.greedy.atNs / 1000).toFixed(1) + " µs on " + r.greedy.blockedOn.join(",") : "ok", "| strict ×" + (r.strict.speedup?.toFixed(2) ?? "–"), "| strict measured ×" + (r.strictMeasured.speedup?.toFixed(2) ?? "DL"), "| ordered ×" + (r.ordered.speedup?.toFixed(2) ?? "DL"), "| ordered measured ×" + (r.orderedMeasured.speedup?.toFixed(2) ?? "DL"));
  const n = rows.length, dl = rows.filter((r) => r.greedy.deadlock).length, rep = rows.filter((r) => r.triggered.reproduces).length;
  console.log(n, "runs | triggered reproduces the VM listing:", rep + "/" + n, "| greedy deadlocks:", dl + "/" + n, "| strict deadlocks:", rows.filter((r) => r.strict.deadlock).length, "+ measured", rows.filter((r) => r.strictMeasured.deadlock).length, "| ordered deadlocks:", rows.filter((r) => r.ordered.deadlock).length, "+ measured", rows.filter((r) => r.orderedMeasured.deadlock).length);
}
