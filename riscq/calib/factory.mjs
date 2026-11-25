// Magic-state factories under demand: how many a T-state rate needs, and who starves.
//
// A factory attempt takes L ns and is kept with probability a (postselection); a request holds one
// factory until an attempt is kept, so its service time is L·G with G ~ Geometric(a). L and a are
// this tree's measurements of the two factories reproduced on digital twins
// (validation/ftqvm/papers/google-cultivation-2025.json and quera-distillation-2025.json `factory`).
// Requests arrive at a fixed interval (a T-gate stream of a logical program) and Executor B
// (riscq/os/des.mjs) queues them on F factories.
//
// What the compiler declares: one latency per factory and a count, `factories`; the VM admits a stream
// when ⌈latency / interval⌉ ≤ F. Three choices of that one latency are compared: one attempt (L),
// the mean (L/a), and the 99th percentile of L·G.
//
// Starvation: two classes of requests share the factories, "urgent" (priority 0, e.g. a T gate on
// the critical path) and "background" (priority 1). Under strict priority the background class's
// wait is reported against FIFO, as the load approaches 1.
import { readFileSync } from "node:fs";
import { simulate, stats, rng } from "../os/des.mjs";

const read = (id) => JSON.parse(readFileSync(new URL("../../validation/ftqvm/papers/" + id + ".json", import.meta.url), "utf8")).factory;

/** The measured factories: attempt time L (ns) and acceptance a. */
export const FACTORIES = (() => {
  const g = read("google-cultivation-2025"), q = read("quera-distillation-2025");
  return [
    { id: "cultivation", name: "magic state cultivation, Willow twin (" + g.circuit + ")", attemptNs: g.latencyNs, accept: g.acceptance, source: "validation/ftqvm/papers/google-cultivation-2025.json" },
    { id: "distillation", name: "5-to-1 distillation, Gemini twin, d = " + q.distance, attemptNs: q.latencyNs, accept: q.acceptance, source: "validation/ftqvm/papers/quera-distillation-2025.json" },
  ];
})();

/** Attempts until one is kept, by inversion: ⌈ln U / ln(1 − a)⌉. */
const attempts = (u, a) => Math.max(1, Math.ceil(Math.log(1 - u) / Math.log(1 - a)));

/** The p-quantile of the service time L·G. */
export const serviceQuantile = (f, p) => f.attemptNs * Math.max(1, Math.ceil(Math.log(1 - p) / Math.log(1 - f.accept)));

/**
 * One stream: requests every `intervalNs` (a fraction `urgent` of them priority 0), `factories` factories.
 * Returns waits and responses per class, utilization, and whether the wait stays bounded.
 */
export function run(f, { intervalNs, factories, requests = 2000, urgent = 0, policy = "fifo", seed = 11 } = {}) {
  const random = rng(seed), pick = rng(seed + 1);
  const ops = Array.from({ length: requests }, (_, k) => {
    const start = k * intervalNs;
    return { uid: k, order: k, kind: "request_magic", start, duration: f.attemptNs, end: start + f.attemptNs, qubits: [{ register: "t", index: k }], reads: [], writes: [], priority: pick() < urgent ? 0 : 1 };
  });
  const model = { pools: { factories }, needs: () => [["factories", 1]], latency: () => f.attemptNs * attempts(random(), f.accept) };
  const r = simulate({ ops }, { model, mode: "triggered", policy });
  const byClass = (p) => r.ops.filter((o, i) => ops[i].priority === p);
  const third = Math.floor(requests / 3);
  const avg = (xs) => xs.reduce((s, o) => s + o.waitNs, 0) / Math.max(1, xs.length);
  const growth = avg(r.ops.slice(-third)) - avg(r.ops.slice(0, third));
  return {
    intervalNs, factories, requests, urgent, policy,
    load: f.attemptNs / f.accept / (intervalNs * factories),
    wait: stats(r.ops.map((o) => o.waitNs)), response: stats(r.ops.map((o) => o.end - o.listedStart)),
    urgentWait: urgent ? stats(byClass(0).map((o) => o.waitNs)) : null, backgroundWait: urgent ? stats(byClass(1).map((o) => o.waitNs)) : null,
    stable: growth < 0.1 * f.attemptNs / f.accept,
    utilization: r.pools.factories.utilization,
  };
}

/** The fewest factories that keep the stream stable. */
export function criticalFactories(f, intervalNs) {
  let F = Math.max(1, Math.floor(f.attemptNs / f.accept / intervalNs));
  while (!run(f, { intervalNs, factories: F }).stable) F++;
  return F;
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const provisioning = [], starvation = [];
  for (const f of FACTORIES) {
    const mean = f.attemptNs / f.accept, p99 = serviceQuantile(f, 0.99);
    // T-gate intervals: from one request per mean service time down to a tenth of it.
    for (const ratio of [1, 2, 4, 10]) {
      const intervalNs = Math.round(mean / ratio);
      const crit = criticalFactories(f, intervalNs);
      const vm = (lat) => Math.ceil(lat / intervalNs);
      const atCrit = run(f, { intervalNs, factories: crit });
      const row = { factory: f.id, attemptNs: f.attemptNs, accept: f.accept, intervalNs, critical: crit,
        vmWithAttempt: vm(f.attemptNs), vmWithMean: vm(mean), vmWithP99: vm(p99), responseP99AtCritical: atCrit.response.p99, utilizationAtCritical: atCrit.utilization };
      for (const [k, F] of [["attempt", vm(f.attemptNs)], ["mean", vm(mean)], ["p99", vm(p99)]]) {
        const r = run(f, { intervalNs, factories: F });
        row["with_" + k] = { factories: F, stable: r.stable, responseP99: r.response.p99, waitMax: r.wait.max };
      }
      provisioning.push(row);
      console.log(f.id, "interval", intervalNs, "| critical", crit, "| VM: attempt", row.vmWithAttempt, row.with_attempt.stable ? "stable" : "UNSTABLE", "· mean", row.vmWithMean, row.with_mean.stable ? "stable" : "UNSTABLE", "· p99", row.vmWithP99, "| p99 response at critical", atCrit.response.p99);
    }
    // Starvation: 4 factories, a fifth of the requests urgent, load from 0.7 to 1.0.
    const F = 4;
    for (const load of [0.7, 0.9, 0.95, 1.0]) {
      const intervalNs = Math.round(mean / (load * F));
      for (const policy of ["fifo", "priority"]) {
        const r = run(f, { intervalNs, factories: F, urgent: 0.2, policy });
        starvation.push({ factory: f.id, load, policy, factories: F, urgentWait: r.urgentWait, backgroundWait: r.backgroundWait, stable: r.stable });
        console.log(f.id, "load", load, policy, "| urgent wait p50/p99", r.urgentWait.p50, r.urgentWait.p99, "| background wait p50/p99/max", r.backgroundWait.p50, r.backgroundWait.p99, r.backgroundWait.max);
      }
    }
  }
  const dir = new URL("../../validation/calib/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("factory.json", dir), JSON.stringify({ generated: new Date().toISOString(), factories: FACTORIES, provisioning, starvation }, null, 1) + "\n");
}
