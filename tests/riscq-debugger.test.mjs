// The debugger page reconstructs machine state from the frames of a run (studio/riscq-model.js).
// These tests replay runs and compare that reconstruction with the summary Lean computes from
// its own state, so the page and a headless reader inspect the same result.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../riscq/examples.mjs";
import * as model from "../studio/riscq-model.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = resolve(process.env.QCCD_STUDIO_ROOT || join(root, "..", "QCCD"));
const integration = { skip: existsSync(upstream) ? false : "QCCD Studio checkout not found" };

/** The reconstructed state after the last frame equals the summary of the run. */
function agreesWithSummary(bundle) {
  const { frames, summary } = bundle;
  const end = model.stateAt(bundle, frames.length - 1);
  summary.cores.forEach((core, i) => {
    const mine = end.cores[i];
    core.channels.forEach((channel, j) => {
      const seen = mine.channels[j];
      assert.equal(seen.part, channel.part);
      assert.deepEqual(seen.buffer, channel.buffer, "pulse table and start time of " + channel.part);
      assert.equal(seen.freq, channel.freq, "carrier of " + channel.part);
      assert.equal(seen.windows, channel.windows, "window count of " + channel.part);
      assert.deepEqual([seen.dout, seen.din], [channel.dout, channel.din], "digital levels of " + channel.part);
    });
    assert.equal(mine.retired, core.retired, "retired instructions of " + core.name);
    assert.equal(mine.stopped, core.stopped);
    assert.equal(mine.done, core.done);
    assert.deepEqual(mine.sinks.map(({ channel: _c, popped: _p, ...rest }) => rest), core.sinks);
    if (bundle.program.trace === "full") assert.deepEqual(mine.regs, core.regs, "registers of " + core.name);
  });
  assert.deepEqual(end.hub.groups, summary.hub.groups);
  // Each hub frame states how many system puts are still held at the arbiter.
  assert.deepEqual(end.hub.waiting, []);
  let held = 0;
  frames.forEach((frame, i) => {
    if (frame.part !== "hub" || frame.state.waiting === undefined) return;
    assert.equal(model.stateAt(bundle, i).hub.waiting.length, frame.state.waiting, "puts waiting after " + frame.id);
    held = Math.max(held, frame.state.waiting);
  });
  assert.equal(held, summary.hub.peakWaiting);
  assert.deepEqual(end.host.map((h) => [h.frame, h.offset, h.value]), summary.host.map((h) => [h.frame, h.offset, h.value]));
  return end;
}

/** Every frame has a stable ID, a part of the scene, and causes that precede it. */
function framesAreInspectable(bundle) {
  const parts = new Set(bundle.system.parts.map((part) => part.id));
  const cores = new Set(bundle.machine.cores.map((core) => core.name));
  const position = new Map();
  bundle.frames.forEach((frame, i) => {
    assert.ok(!position.has(frame.id), "frame ID " + frame.id + " is used twice");
    assert.ok(parts.has(frame.part), frame.id + " acts on " + frame.part + ", which is not in the scene");
    for (const target of frame.targets ?? []) assert.ok(parts.has(target), frame.id + " targets " + target);
    for (const parent of frame.parents) assert.ok(position.has(parent), frame.id + " names the later or unknown cause " + parent);
    position.set(frame.id, i);
  });
  // Following causes from any frame ends at an instruction of a core.
  for (const frame of bundle.frames) {
    const chain = model.causalChain(bundle, frame.id);
    assert.equal(chain.at(-1), frame);
    assert.ok(cores.has(chain[0].part), frame.id + " traces back to " + chain[0].part);
  }
  // The scene gives every part its own position.
  const places = bundle.system.parts.map((part) => part.position.join(","));
  assert.equal(new Set(places).size, places.length, "two parts of the scene share a position");
}

/** A state asked for out of order equals a replay from reset. */
function steppingIsReplay(bundle) {
  const copy = JSON.parse(JSON.stringify(bundle));
  const last = bundle.frames.length - 1;
  for (const index of [last, 0, Math.floor(last / 2), -1, Math.floor(last / 3), last - 1])
    assert.deepEqual(model.stateAt(bundle, index), model.stateAt(JSON.parse(JSON.stringify(copy)), index), "state at step " + index);
}

test("the debugger reconstructs the transmon feed-forward run that Lean summarizes", async () => {
  for (const trace of ["io", "full"]) {
    const bundle = await run({ example: "superconducting-feedforward", outcomes: { c: 1 }, trace });
    agreesWithSummary(bundle);
    framesAreInspectable(bundle);
    steppingIsReplay(bundle);
    // Stepping by pulse visits each pulse of the summary once.
    const stop = model.stops(bundle);
    let index = -1, pulses = 0;
    while ((index = model.nextIndex(bundle, index, stop.pulse)) >= 0) pulses++;
    assert.equal(pulses, bundle.summary.pulses.length);
    // Each hardware instruction that reaches the controller has a first frame to step to.
    const reached = model.hardwareOps(bundle).filter((entry) => entry.first >= 0);
    assert.ok(reached.length > 0);
    assert.ok(reached.every((entry) => bundle.frames[entry.first].source === entry.op.id));
  }
});

test("the debugger follows every AOD tone of the neutral-atom run to its final position", async () => {
  const bundle = await run({ example: "neutral-bv14" });
  agreesWithSummary(bundle);
  framesAreInspectable(bundle);
  steppingIsReplay(bundle);
  // The position shown for a tone at the end is its last carrier update of the run.
  const shown = model.tonesAt(bundle, bundle.frames.at(-1).atBatch);
  const last = new Map(bundle.derived.tonePositions.map((entry) => [entry.part, entry.um]));
  assert.equal(shown.length, last.size);
  for (const tone of shown) assert.equal(tone.um, last.get(tone.part), tone.part);
  assert.ok(shown.filter((tone) => tone.axis).length >= 4);
  assert.deepEqual(model.faultFrames(bundle), []);
});

test("the debugger places every ion of the Studio rotation where the run delivers it", integration, async () => {
  const bundle = await run({ example: "qccd-rotation" });
  agreesWithSummary(bundle);
  framesAreInspectable(bundle);
  steppingIsReplay(bundle);
  const { ions } = model.ionsAt(bundle, bundle.frames.at(-1).atBatch);
  const final = new Map();
  for (const record of bundle.derived.ionMoves) for (const move of record.moves) final.set(move.ion, move.to);
  assert.ok(final.size > 0);
  for (const [name, site] of final) assert.equal(ions.find((ion) => ion.ion === name)?.site, site, name);
  // Before the first cycle opens, every ion is where its first move starts.
  const before = model.ionsAt(bundle, -1).ions;
  const first = new Map();
  for (const record of bundle.derived.ionMoves) for (const move of record.moves) if (!first.has(move.ion)) first.set(move.ion, move.from);
  for (const [name, site] of first) assert.equal(before.find((ion) => ion.ion === name)?.site, site, name);
});
