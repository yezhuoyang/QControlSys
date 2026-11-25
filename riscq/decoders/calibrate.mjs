// Calibration of the decode_syndrome system call: the compiled union-find decoder
// (riscq/decoders/uf_decoder.c) measured in the Lean model of a RISC-Q decoder core, and the
// FormalRV machine fields that QuantumOS declares for it, each read off those runs.
//
// Workload: rotated surface-code memory circuits (Stim's generated circuits) at distances d and
// round counts r, with SI1000 noise at strength p (Google Quantum AI's circuit noise model), so
// the decoder sees the syndromes of the device it serves. For each (d, r, p), shots are sampled,
// decoded by the compiled decoder in one bench run, and compared with PyMatching on the same shots.
//
// What a decode costs in a control program (riscq/ftqvm/qec-run.mjs measures it in a run):
//   bits in      from the close of the last readout window to the decoder's first instruction
//                (bit store, publish over the hub, the decode segment's barrier)
//   compute      the bench time of the decode, which depends on the syndrome
//   result out   from the decoder's last instruction to a conditioned pulse opening on another
//                core (publish, the next segment's barrier, fetch, pulse issue)
//
// FormalRV fields (FormalRV/ftq_vm/ocaml/resource_vm.ml), all in its units:
//   decoder_latency_ns       the longest decode seen, bits in + compute
//   decoder_latency_model    F(n) ≥ every decode seen, as a + b·n in the decode's input bits n
//   decoder_bandwidth        input bits per µs at the slowest decode seen (bits/us)
//   decoder_window_rounds    the most rounds of one block's syndrome one decode can take: the
//                            hub shares 128 bits per decode, and the compiled tables must fit RAM
//   classical_memory         the decoder core's RAM (bits)
import { stim } from "../ftqvm/magic.mjs";
import * as uf from "./uf.mjs";

const quantile = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };

/** Decode times and accuracy for one workload. */
export async function measure({ d, rounds, p, shots = 100, seed = 3 }) {
  const g = await stim({ mode: "graph", generated: { code_task: "surface_code:rotated_memory_z", distance: d, rounds }, noise: { model: "si1000", p }, shots, seed });
  const r = await uf.bench(g, g.shots);
  const ns = r.decodes.map((x) => x.ns);
  let ufWrong = 0, pmWrong = 0, agree = 0;
  r.decodes.forEach((x, i) => { ufWrong += x.mask !== g.actual[i]; pmWrong += g.pymatching[i] !== g.actual[i]; agree += x.mask === g.pymatching[i]; });
  return {
    d, rounds, p, shots, n: g.measurements, detectors: g.detectors.length, edges: g.edges.length,
    imageBytes: r.bytes, imageWords: r.footprint.words, ramWords: r.footprint.ramWords,
    ns: { min: Math.min(...ns), median: quantile(ns, 0.5), p90: quantile(ns, 0.9), p99: quantile(ns, 0.99), max: Math.max(...ns), mean: ns.reduce((a, b) => a + b, 0) / ns.length },
    perDefect: r.decodes.map((x) => [x.defects, x.ns]),
    accuracy: { ufWrong, pymatchingWrong: pmWrong, agree },
  };
}

/** The most rounds of a distance-d memory one decode can take: hub bits and RAM. */
export function windowRounds(d, { hubBits = 128 } = {}) {
  const perRound = d * d - 1, final = d * d; // measure qubits per round, data read at the end
  return Math.max(0, Math.floor((hubBits - final) / perRound));
}

/** Fit a + b·n (integers, ns) above every point (n, ns): the least b, then the least a. */
export function envelope(points) {
  const ns = [...new Set(points.map(([n]) => n))].sort((a, b) => a - b);
  let best;
  // b from the slopes between the worst points of each n; a to cover every point.
  const worst = ns.map((n) => [n, Math.max(...points.filter(([x]) => x === n).map(([, t]) => t))]);
  const candidates = [0, ...worst.flatMap(([n1, t1], i) => worst.slice(i + 1).map(([n2, t2]) => Math.max(0, (t2 - t1) / (n2 - n1))))];
  for (const b0 of candidates) {
    const b = Math.ceil(b0);
    const a = Math.ceil(Math.max(...worst.map(([n, t]) => t - b * n)));
    const cost = worst.reduce((s, [n]) => s + a + b * n, 0);
    if (!best || cost < best.cost) best = { a: Math.max(0, a), b, cost };
  }
  return { a: best.a, b: best.b, expression: `${best.a} + ${best.b}*n` };
}

/**
 * Calibrate: measure every workload, then the FormalRV fields. `inRun` are the overheads
 * measured in a control program run (riscq/ftqvm/qec-run.mjs): { bitsInNs, resultOutNs }.
 */
export async function calibrate({ distances = [3, 5], ps = [1e-3, 2.3e-3, 3e-3], shots = 100, inRun }) {
  const workloads = [];
  for (const d of distances)
    for (let rounds = 1; rounds <= Math.min(d, windowRounds(d)); rounds++)
      for (const p of ps) workloads.push(await measure({ d, rounds, p, shots }));
  const bitsIn = inRun.bitsInNs, ramBits = workloads[0].ramWords * 32;
  const points = workloads.map((w) => [w.n, bitsIn + w.ns.max]);
  const model = envelope(points);
  const slowest = workloads.reduce((a, w) => ((bitsIn + w.ns.max) / w.n > (bitsIn + a.ns.max) / a.n ? w : a));
  const fields = {
    decoder_latency_ns: { value: Math.ceil(Math.max(...points.map(([, t]) => t))), source: "measured", note: "the longest decode of every workload, bits in (" + bitsIn + " ns) + compute" },
    decoder_latency_model: { value: model.expression, source: "measured", note: "a + b·n above every (input bits, latency) of every workload" },
    decoder_bandwidth: { value: Math.max(1, Math.floor((1000 * slowest.n) / (bitsIn + slowest.ns.max))), source: "measured", note: "input bits per µs of the slowest decode (d = " + slowest.d + ", " + slowest.rounds + " rounds, p = " + slowest.p + ")" },
    decoder_window_rounds: { value: Math.min(...distances.map((d) => windowRounds(d))), source: "derived", note: "rounds of one block a decode takes: the board hub shares 128 bits (riscq/compile.mjs); per distance " + distances.map((d) => "d = " + d + ": " + windowRounds(d)).join(", ") },
    classical_memory: { value: ramBits, source: "derived", note: "the decoder core's RAM; the largest compiled image takes " + Math.max(...workloads.map((w) => w.imageWords)) + " of its " + workloads[0].ramWords + " words" },
  };
  return { workloads, inRun, fields, model };
}

/** The overheads of a decode in a control program: one d = 3 memory on the Willow-style twin. */
export async function inRunOverheads() {
  const { parseStim, czNative, runWithDecoder } = await import("../ftqvm/qec-run.mjs");
  const g = await stim({ mode: "graph", generated: { code_task: "surface_code:rotated_memory_z", distance: 3, rounds: 3 }, noise: { model: "si1000", p: 3e-3 }, shots: 20, seed: 5 });
  const circuit = czNative(parseStim(g.circuit, "surface-d3"));
  const i = g.defects.findIndex((x) => x > 0);
  const r = await runWithDecoder(circuit, g, { shot: g.shots[i], feedback: [{ qubit: circuit.qubits.length - 1, when: "uf.flag" }] });
  if (!r.latency?.toPulseNs) throw Error("the feedback pulse did not play");
  return {
    bitsInNs: r.latency.toDecoderNs, computeNs: r.latency.computeNs, resultOutNs: r.latency.afterDecodeNs, toPulseNs: r.latency.toPulseNs,
    circuit: "rotated surface-code memory, d = 3, 3 rounds, on " + circuit.qubits.length + " transmons; shot " + i + " with " + g.defects[i] + " detectors fired",
    decoderBytes: r.decoder.bytes,
  };
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const { writeFileSync } = await import("node:fs");
  const inRun = await inRunOverheads();
  console.log("in run", JSON.stringify(inRun));
  const result = await calibrate({ shots: Number(process.argv[2] ?? 100), inRun });
  const out = new URL("../../validation/ftqvm/decoder-calibration.json", import.meta.url);
  writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), decoder: "riscq/decoders/uf_decoder.c (union-find with peeling), compiled for a RISC-Q core, Lean model", ...result }, null, 1) + "\n");
  for (const w of result.workloads) console.log(`d=${w.d} r=${w.rounds} p=${w.p} n=${w.n} median ${w.ns.median} p99 ${w.ns.p99} max ${w.ns.max} | UF wrong ${w.accuracy.ufWrong} PM wrong ${w.accuracy.pymatchingWrong}`);
  console.log(JSON.stringify(result.fields, null, 1));
}
