// The compiled union-find decoder (riscq/decoders/uf_decoder.c) as the decode_syndrome service:
// its corrections against PyMatching, and the decode inside a control program with feedback.
// Skipped without a riscv32 clang or without Python's stim and pymatching.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { findClang } from "../riscq/toolchain.mjs";
import { stim } from "../riscq/ftqvm/magic.mjs";
import * as uf from "../riscq/decoders/uf.mjs";
import { envelope, windowRounds } from "../riscq/decoders/calibrate.mjs";

const hasPython = (() => {
  try { execFileSync(process.env.QCONTROL_PYTHON || "python", ["-I", "-c", "import stim, pymatching"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const skip = (!findClang() && "no riscv32 clang") || (!hasPython && "Python's stim and pymatching are not installed");

test("the compiled decoder sees Stim's detectors and corrects like PyMatching", { skip, timeout: 600_000 }, async () => {
  const g = await stim({ mode: "graph", generated: { code_task: "surface_code:rotated_memory_z", distance: 3, rounds: 3 }, noise: { model: "si1000", p: 3e-3 }, shots: 60, seed: 3 });
  const r = await uf.bench(g, g.shots);
  const obsRef = g.obsRef.reduce((m, b, k) => m | (b << k), 0);
  let agree = 0, wrong = 0, pmWrong = 0;
  r.decodes.forEach((x, i) => {
    assert.equal(x.defects, g.defects[i], "detectors fired, shot " + i);
    assert.equal((x.measured ^ obsRef) >>> 0, g.actual[i], "measured observable, shot " + i);
    agree += x.mask === g.pymatching[i];
    wrong += x.mask !== g.actual[i];
    pmWrong += g.pymatching[i] !== g.actual[i];
  });
  // Union-find is not minimum weight: it may differ from PyMatching on a few shots.
  assert.ok(agree >= 0.9 * g.shots.length, "agrees with PyMatching on " + agree + " of " + g.shots.length);
  assert.ok(wrong <= pmWrong + 4, `UF wrong ${wrong}, PyMatching wrong ${pmWrong}`);
  // A shot with no detector fired is the cheapest decode.
  const empty = r.decodes.filter((x) => x.defects === 0), busy = r.decodes.filter((x) => x.defects > 2);
  if (empty.length && busy.length) assert.ok(Math.max(...empty.map((x) => x.ns)) < Math.min(...busy.map((x) => x.ns)));
});

test("in a control program the decoded bit conditions a pulse on another core", { skip, timeout: 600_000 }, async () => {
  const { parseStim, czNative, runWithDecoder } = await import("../riscq/ftqvm/qec-run.mjs");
  const g = await stim({ mode: "graph", generated: { code_task: "surface_code:rotated_memory_z", distance: 3, rounds: 3 }, noise: { model: "si1000", p: 3e-3 }, shots: 20, seed: 5 });
  const circuit = czNative(parseStim(g.circuit, "surface-d3"));
  const fired = g.defects.findIndex((x) => x > 0), quiet = g.defects.findIndex((x) => x === 0);
  const a = await runWithDecoder(circuit, g, { shot: g.shots[fired], feedback: [{ qubit: 16, when: "uf.flag" }] });
  assert.equal(a.flag, 1);
  assert.equal(a.decode.defects, g.defects[fired]);
  assert.equal(a.decode.mask, g.pymatching[fired]);
  assert.equal(a.feedback.length, 1, "the conditioned pulse played");
  // The loop, from the last readout window to the pulse, is the sum of its measured parts.
  const l = a.latency;
  assert.ok(Math.abs(l.toPulseNs - (l.toDecoderNs + l.computeNs + l.afterDecodeNs)) <= 4, JSON.stringify(l));
  const b = await runWithDecoder(circuit, g, { shot: g.shots[quiet], feedback: [{ qubit: 16, when: "uf.flag" }] });
  assert.equal(b.flag, 0);
  assert.equal(b.feedback.length, 0, "no pulse when no detector fired");
});

test("the latency model lies above every measured decode", () => {
  const points = [[33, 15000], [33, 20000], [145, 90000], [145, 180000], [97, 60000]];
  const { a, b } = envelope(points);
  for (const [n, t] of points) assert.ok(a + b * n >= t);
  assert.equal(windowRounds(5), 4); // (128 − 25) / 24 rounds of a distance-5 block fit the hub
});
