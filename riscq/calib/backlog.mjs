// Decoder backlog: how many decoder cores a stream of syndrome rounds needs.
//
// One logical qubit produces a syndrome round every T ns. Every w rounds (the decoding window)
// a decode job is ready, once the window's last round has ended and its bits have reached the
// decoder (the measured bit delivery, validation/ftqvm/decoder-calibration.json inRun.bitsInNs).
// The job's service time is drawn from the compiled union-find decoder's measured decode times
// on noisy syndromes of that distance and window (the same file's workloads, 200 shots each, in
// the Lean model of a RISC-Q core). Executor B (riscq/os/des.mjs) queues the jobs on c decoder
// cores, triggered at their ready times. A configuration is stable when the waits do not grow
// over the stream; the backlog is the growth of the wait per window.
//
// What the compiler says: one decode holds one decoder for decoder_latency_ns, the declared worst
// case, and the VM admits the stream when the overlapping holds fit `decoders`. Both views are
// reported side by side.
import { readFileSync } from "node:fs";
import { simulate, stats, rng } from "../os/des.mjs";

const CAL = JSON.parse(readFileSync(new URL("../../validation/ftqvm/decoder-calibration.json", import.meta.url), "utf8"));

/** The decode-time samples (ns) of distance d, window w rounds, noise p. */
export function serviceSamples(d, w, p) {
  const wl = CAL.workloads.find((x) => x.d === d && x.rounds === w && x.p === p);
  if (!wl) throw Error("no calibration workload at d = " + d + ", " + w + " rounds, p = " + p);
  return wl.perDefect.map(([, ns]) => ns);
}

/** A stream of `jobs` decodes of one logical qubit as a listing (one op per window). */
function stream({ jobs, windowNs, bitsInNs, worstNs }) {
  return {
    ops: Array.from({ length: jobs }, (_, k) => {
      const start = (k + 1) * windowNs + bitsInNs;
      return { uid: k, order: k, kind: "decode_syndrome", start, duration: worstNs, end: start + worstNs, qubits: [{ register: "job", index: k }], reads: [], writes: [] };
    }),
  };
}

/**
 * Run one configuration: `logical` qubits, each with its own stream, sharing `decoders` cores.
 * Returns waits, the share of decodes that finish later than the declared worst case after they
 * were ready, and the backlog (growth of the wait over the second half of the stream, per window).
 */
export function backlog({ d = 5, w = 4, p = 0.003, roundNs = 1100, decoders = 1, logical = 1, jobs = 400, seed = 7 } = {}) {
  const samples = serviceSamples(d, w, p);
  const worstNs = Math.max(...samples);
  const windowNs = w * roundNs, bitsInNs = CAL.inRun.bitsInNs;
  // Every logical qubit's stream, interleaved; a job's qubit is its own name so jobs do not chain.
  const ops = [];
  for (let l = 0; l < logical; l++) for (const op of stream({ jobs, windowNs, bitsInNs, worstNs }).ops)
    ops.push({ ...op, uid: ops.length, order: ops.length, qubits: [{ register: "job" + l, index: op.uid }] });
  const random = rng(seed);
  const model = {
    pools: { decoders },
    latency: () => samples[Math.floor(random() * samples.length)],
    needs: () => [["decoders", 1]],
  };
  const r = simulate({ ops }, { model, mode: "triggered", policy: "fifo" });
  const waits = r.ops.map((o) => o.waitNs);
  // The worst wait of each window (all logical qubits' jobs of window k), and its growth from the
  // first third of the stream to the last: a stable stream clears every window's burst.
  const perWindow = Array(jobs).fill(0);
  r.ops.forEach((o, i) => { const k = i % jobs; perWindow[k] = Math.max(perWindow[k], o.waitNs); });
  const third = Math.max(1, Math.floor(jobs / 3));
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const growthPerWindow = (avg(perWindow.slice(-third)) - avg(perWindow.slice(0, third))) / Math.max(1, jobs - third);
  const response = r.ops.map((o) => o.end - o.listedStart); // ready → result
  const meanService = samples.reduce((s, x) => s + x, 0) / samples.length;
  return {
    d, w, p, roundNs, decoders, logical, jobs,
    load: (logical * meanService) / (decoders * windowNs), // offered load ρ
    service: stats(samples), worstNs,
    wait: stats(waits), response: stats(response),
    lateVsWorst: response.filter((x) => x > worstNs).length / response.length,
    backlogNsPerWindow: growthPerWindow, stable: growthPerWindow * jobs < 0.1 * windowNs,
    // The compiler's static view: each decode holds a decoder for the declared worst case, windows overlap
    // when worstNs > windowNs, so the VM needs ⌈logical · worstNs / windowNs⌉ decoders.
    vmDecoders: Math.ceil((logical * worstNs) / windowNs),
  };
}

/** The fewest decoders that keep the stream stable, by doubling then bisection. */
export function criticalDecoders(cfg) {
  let hi = 1;
  while (!backlog({ ...cfg, decoders: hi }).stable) { hi *= 2; if (hi > 1 << 16) return null; }
  let lo = Math.max(1, hi >> 1);
  while (lo < hi) { const mid = (lo + hi) >> 1; if (backlog({ ...cfg, decoders: mid }).stable) hi = mid; else lo = mid + 1; }
  return hi;
}

/** Round periods per platform, ns: what each design's syndrome round takes. */
export const ROUNDS = {
  superconducting: [{ name: "Willow cycle (Google 2025)", ns: 1100, source: "Google Quantum AI, Nature 638, 920 (2025): 1.1 µs cycle" }],
  neutral: [{ name: "Bluvstein 2025 round", ns: 4_450_000, source: "Bluvstein et al., Nature 649, 39 (2025): 4.45 ms per round (this tree's twin reproduces it)" }],
  qccd: [{ name: "H2 round (QCCD Studio model)", ns: 2_000_000, source: "order of the H2 twin's d = 3 memory round in this tree (riscq/calib/insitu); replace with the derived surfaceRound runtime" }],
};

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const rows = [];
  for (const [platform, rounds] of Object.entries(ROUNDS)) for (const round of rounds)
    for (const [d, ws] of [[3, [1, 2, 3]], [5, [1, 2, 3, 4]]]) for (const w of ws) for (const p of [0.001, 0.003]) {
      const cfg = { d, w, p, roundNs: round.ns, logical: 1, jobs: 300 };
      const c = criticalDecoders(cfg);
      const at = backlog({ ...cfg, decoders: c ?? 1 });
      const one = backlog({ ...cfg, decoders: 1 });
      rows.push({ platform, round: round.name, roundNs: round.ns, d, w, p, criticalDecoders: c, vmDecoders: at.vmDecoders, loadWithOne: one.load, oneDecoder: { stable: one.stable, backlogNsPerWindow: one.backlogNsPerWindow, waitP99: one.wait.p99 },
        atCritical: { waitP99: at.wait.p99, responseP99: at.response.p99, lateVsWorst: at.lateVsWorst }, serviceP50: at.service.p50, serviceMax: at.service.max });
      console.log(platform, "d=" + d, "w=" + w, "p=" + p, "| ρ(1 decoder) " + one.load.toFixed(2), "| critical decoders", c, "| VM static", at.vmDecoders, "| p99 wait at critical", at.wait.p99);
    }
  // The trade-off on superconducting hardware: p99 response against decoder cores, from the
  // critical count to the VM's static count.
  const tradeoff = [];
  for (const [d, w, p] of [[5, 4, 0.003], [5, 1, 0.001], [3, 3, 0.003]]) {
    const cfg = { d, w, p, roundNs: 1100, logical: 1, jobs: 300 };
    const c = criticalDecoders(cfg), vm = backlog({ ...cfg }).vmDecoders;
    for (const k of [...new Set([c, c + 1, c + 2, Math.round((c + vm) / 2), vm])].sort((x, y) => x - y)) {
      const r = backlog({ ...cfg, decoders: k });
      tradeoff.push({ d, w, p, decoders: k, critical: c, vmDecoders: vm, responseP50: r.response.p50, responseP99: r.response.p99, responseMax: r.response.max, worstNs: r.worstNs, lateVsWorst: r.lateVsWorst });
      console.log("SC tradeoff d=" + d, "w=" + w, "p=" + p, "decoders", k, "(critical " + c + ", VM " + vm + ") | response p50/p99/max", r.response.p50, r.response.p99, r.response.max, "| worst service", r.worstNs, "| later than worst", (100 * r.lateVsWorst).toFixed(1) + "%");
    }
  }
  // Logical qubits one decoder core serves on the slow platforms.
  const sharing = [];
  for (const [platform, rounds] of Object.entries(ROUNDS)) if (platform !== "superconducting") for (const round of rounds) for (const logical of [10, 100, 400]) {
    const cfg = { d: 5, w: 4, p: 0.003, roundNs: round.ns, logical, jobs: Math.max(30, Math.ceil(6000 / logical)) };
    const c = criticalDecoders(cfg), r = backlog({ ...cfg, decoders: c });
    sharing.push({ platform, roundNs: round.ns, logical, criticalDecoders: c, vmDecoders: r.vmDecoders, logicalPerDecoder: logical / c, responseP99: r.response.p99 });
    console.log(platform, "logical", logical, "| critical decoders", c, "| VM static", r.vmDecoders, "| p99 response", r.response.p99);
  }
  const dir = new URL("../../validation/calib/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("backlog.json", dir), JSON.stringify({ generated: new Date().toISOString(), calibration: CAL.generated, rounds: ROUNDS, rows, tradeoff, sharing }, null, 1) + "\n");
}
