// Folded firmware (riscq/firmware.mjs `compileCore` with `compact`), which a core whose program does not fit
// its RAM runs: inline code, with each run of repeating rounds emitted once inside a counted loop that
// advances the time base and the bit bases. A whole reproduction run on it plays the same pulses as on
// unfolded firmware, in fewer words; the loop step fits the room the schedule leaves at a round's end.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { socSpec, program, execute } from "../riscq/soc.mjs";
import { compileCore, FOLD_OVERHEAD } from "../riscq/firmware.mjs";

const spec = socSpec({ name: "fold", dsp_freq_hz: 5e8, link_pipe: 4, core_defaults: { mem_depth: 8192, with_mul: true, queue_depth: 32 },
  cores: [{ name: "c0", channels: [{ name: "ch", kind: "pulse", dac: 0, slots: 2, env_depth: 16, interp: 4 }, { name: "demod", kind: "demod", adc: 0, slots: 1, env_depth: 16, interp: 4 }] }] });

test("a round that repeats is one copy of its code, and each repetition still fires on time", async () => {
  // Forty rounds of two fires (one with a phase offset), 200 batches apart.
  const ops = Array.from({ length: 40 }, (_, r) => [
    { at: 3000 + 200 * r, fire: { channel: "ch", slot: 0 }, phaseOffset: 1000, source: "a" + r },
    { at: 3000 + 200 * r + 40, fire: { channel: "ch", slot: 1 }, source: "b" + r }]).flat();
  const plan = { channels: [{ channel: 0, slots: [{ slot: 0, phase: 0, amp: 1000, env: 0, dur: 10 }, { slot: 1, phase: 0, amp: 900, env: 0, dur: 10 }] }],
    segments: [{ ops, span: 3000 + 200 * 40 + 200 }] };
  const unfolded = compileCore(spec, 0, plan);
  const folded = compileCore(spec, 0, plan, { compact: true });
  assert.ok(folded.words.length < unfolded.words.length / 5, folded.words.length + " words against " + unfolded.words.length);
  const run = async (image) => (await execute(program(spec, [{ words: image.words, sourceMap: image.sourceMap }], { trace: "io" }))).summary;
  const [u, f] = [await run(unfolded), await run(folded)];
  assert.deepEqual(f.faults, []);
  assert.ok(f.pulses.every((p) => p.onTime && p.aligned !== false));
  // The same pulses at the same times from the first (a folded core loads one more base register first).
  const rel = (ps) => ps.map((p) => [p.startTime - ps[0].startTime, p.phase, p.amp]);
  assert.deepEqual(rel(f.pulses), rel(u.pulses));
  assert.ok(FOLD_OVERHEAD > 0);
});

test("Google's d = 3 memory on folded firmware plays the same pulses, phases and bits in fewer words", { timeout: 600_000 }, async () => {
  const { willow } = await import("../riscq/ftqvm/twins.mjs");
  const { transmonTwin } = await import("../riscq/ftqvm/platforms.mjs");
  const { runListing } = await import("../riscq/ftqvm/sc-run.mjs");
  const src = JSON.parse(readFileSync(new URL("../validation/ftqvm/twins/google-2025/d3.json", import.meta.url), "utf8"));
  const twin = transmonTwin(willow(), src.platform.options);
  const placement = twin.place(src.listing, { distance: 3 });
  const design = twin.design(src.listing, placement);
  const inline = await runListing(src.listing, placement, design, { distance: 3 });
  const compact = await runListing(src.listing, placement, design, { distance: 3, forceCompact: true });
  assert.deepEqual(compact.result.summary.faults, []);
  assert.ok(compact.result.summary.pulses.every((p) => p.onTime && p.aligned !== false));
  // The same pulse on the same channel at the same time from the segment's start, with its phase, amplitude and source.
  const base = (r) => Math.min(...r.result.summary.pulses.map((p) => p.startTime));
  const key = (r, p) => p.core + ":" + p.channel + ":" + (p.startTime - base(r));
  const ref = new Map(inline.result.summary.pulses.map((p) => [key(inline, p), p]));
  assert.equal(compact.result.summary.pulses.length, inline.result.summary.pulses.length);
  for (const p of compact.result.summary.pulses) {
    const q = ref.get(key(compact, p));
    assert.ok(q, "no inline pulse at " + key(compact, p));
    assert.deepEqual([p.phase, p.amp, p.source], [q.phase, q.amp, q.source]);
  }
  assert.deepEqual(compact.report.bits, inline.report.bits);
  assert.equal(compact.report.conforms, inline.report.conforms);
  const words = (r) => r.built.images.reduce((n, im) => n + im.instructions, 0);
  assert.ok(words(compact) < words(inline), words(compact) + " words against " + words(inline));
});
