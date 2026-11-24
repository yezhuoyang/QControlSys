// The workspace's three views show one world (studio/riscq-world.js): every part has one position,
// the views only choose a frame and an emphasis, and the signals drawn on the wires follow the
// trace's windows and the wires' delays.
import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../riscq/examples.mjs";
import * as model from "../studio/riscq-model.js";
import * as layers from "../studio/riscq-layers.js";
import { worldLayout, viewOf, signalsAt } from "../studio/riscq-world.js";

for (const example of ["superconducting-feedforward", "neutral-bv14", "decoder-helios-d3"]) {
  test("one world for every view: " + example, async () => {
    const bundle = await run({ example });
    const world = worldLayout(bundle);
    // Every part of the run is placed once, at a finite position.
    assert.deepEqual(new Set(world.parts.keys()), new Set(bundle.system.parts.map((p) => p.id)));
    for (const p of world.parts.values()) assert.ok(p.at.every(Number.isFinite), p.id);
    // Views choose a frame and an emphasis, and leave every position as it was.
    const before = JSON.stringify([...world.parts.values()].map((p) => p.at));
    const emphasis = {};
    for (const view of Object.keys(layers.VIEWS)) {
      const v = viewOf(bundle, view);
      assert.ok(v.frame.half.every((h) => h > 0));
      emphasis[view] = v.emphasis;
    }
    assert.equal(JSON.stringify([...worldLayout(bundle).parts.values()].map((p) => p.at)), before);
    assert.equal(worldLayout(bundle), world, "the world is built once per run");
    // Together the chip and control views emphasise the whole machine, which the machine view shows.
    assert.deepEqual(new Set([...emphasis.chip, ...emphasis.control]), new Set(world.parts.keys()));
    assert.deepEqual(emphasis.machine, new Set(world.parts.keys()));
    // The chip view's frame holds the apparatus and the parts that drive it.
    if (bundle.system.parts.some((p) => p.kind === "device")) {
      const { half } = world.frames.chip;
      for (const p of world.parts.values())
        if (p.region === "apparatus" || p.region === "drive") assert.ok(Math.abs(p.at[0]) <= half[0] && Math.abs(p.at[2]) <= half[1], p.id + " is outside the chip frame");
    }
  });
}

test("the light holds what moves: every carried atom sits in the focus of a live tweezer", async () => {
  const benches = await import("../studio/riscq-benches.js");
  const { lightScene } = await import("../studio/riscq-beamview.js");
  const bundle = await run({ example: "neutral-bv14" });
  const world = worldLayout(bundle), bench = benches.benchFor(bundle);
  let carried = 0;
  for (let i = 0; i < bundle.frames.length; i += 97) {
    const state = model.stateAt(bundle, i);
    const tones = new Map(model.tonesAt(bundle, state.atBatch).map((t) => [t.part, t.um]));
    const scene = lightScene(world, bench, benches.beamsAt(bundle, bench, state, { tones }), { height: 90 });
    const spots = scene.close.filter((c) => c.id.startsWith("tweezer:")).map((c) => c.focused.focus);
    for (const atom of layers.atomPositions(bundle, state.atBatch).filter((a) => a.carried)) {
      const [x, , z] = world.toWorld(atom.at);
      // Within one 16-bit frequency step of the tone map (0.13 µm), in world units.
      const near = spots.some((p) => Math.hypot(p[0] - x, p[2] - z) <= 0.2 * world.scale);
      assert.ok(near, "atom " + atom.atom + " at step " + i + " has no tweezer focus at its position");
      carried++;
    }
  }
  assert.ok(carried > 0, "some atom is carried at the sampled steps");
});

test("a signal leaves its converter when its window opens and arrives after its wire delay", async () => {
  const bundle = await run({ example: "superconducting-feedforward", outcomes: { c: 1 } });
  const period = bundle.machine.dspPeriodPs, world = worldLayout(bundle);
  let checked = 0;
  for (let i = 0; i < bundle.frames.length && checked < 20; i++) {
    const state = model.stateAt(bundle, i);
    for (const s of signalsAt(bundle, state)) {
      const elapsed = (state.atBatch - s.window.opens) * period;
      if (s.kind === "acquire") {
        // The return runs from the resonator to the ADC.
        assert.deepEqual([s.from[0], s.from[2]], [world.parts.get(s.binding.part).at[0], world.parts.get(s.binding.part).at[2]]);
        continue;
      }
      assert.equal(s.t, Math.min(1, elapsed / s.binding.delayPs), s.id);
      assert.deepEqual([s.from[0], s.from[2]], [world.parts.get(s.window.converter).at[0], world.parts.get(s.window.converter).at[2]]);
      assert.deepEqual([s.to[0], s.to[2]], [world.parts.get(s.binding.part).at[0], world.parts.get(s.binding.part).at[2]]);
      checked++;
    }
  }
  assert.ok(checked > 0);
  // No window, no signal: before the first window opens nothing is in flight.
  assert.deepEqual(signalsAt(bundle, model.stateAt(bundle, -1)), []);
});
