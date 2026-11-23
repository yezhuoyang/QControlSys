import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { simulate } from "../server.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../examples/feedforward.json", import.meta.url)),
);
const run = (changes = {}) =>
  simulate(JSON.stringify({ ...fixture, ...changes }));
const pulses = (result) => result.frames.filter((f) => f.op === "drive");

test("exported traces verify against Lean and identify an altered same-time event", async () => {
  const result = await run();
  const check = () => simulate(JSON.stringify(result), { checkTrace: true });
  assert.deepEqual(await check(), {
    verified: true,
    events: result.frames.length,
  });
  result.frames.find((f) => f.id === "sample").state.latched = 0;
  await assert.rejects(check(), /event sample, time 1600 ns/);
});

test("all measurement patterns select the reference amplitudes and pulse edges", async () => {
  const patterns = [[], [350], [500, 750], [500, 750, 750]];
  for (const [word, expected] of patterns.entries()) {
    const result = await run({ word });
    assert.deepEqual(
      pulses(result).map((f) => f.state.outputMv),
      expected,
    );
    assert.deepEqual(
      pulses(result).map((f) => f.atNs),
      expected.map((_, i) => 1600 + 80 * i),
    );
    assert.deepEqual(
      result.frames.filter((f) => f.op === "release").map((f) => f.atNs),
      expected.map((_, i) => 1650 + 80 * i),
    );
    assert.equal(result.frames.at(-1).state.emitted, expected.length);
    assert.equal(result.frames.at(-1).state.fault, false);
  }
});

test("arrival before or at the edge is visible, later data remains inspectable and cannot fire", async () => {
  for (const linkNs of [0, 449, 450, 451, 460, 2000]) {
    const result = await run({ word: 3, linkNs });
    const sample = result.frames.find((f) => f.op === "sample");
    const received = result.frames.find((f) => f.op === "receive");
    assert.equal(received.atNs, 1150 + linkNs);
    assert.equal(sample.state.latched, linkNs <= 450 ? 3 : null);
    assert.equal(sample.state.fault, linkNs > 450);
    assert.equal(sample.parents.includes("receive"), linkNs <= 450);
    assert.equal(result.frames.at(-1).state.received, 3);
    assert.equal(pulses(result).length, linkNs <= 450 ? 3 : 0);
  }
});

test("every event has geometry, a stable ID, a reachable prior state and earlier causal parents", async () => {
  for (const settings of [
    {},
    { linkNs: 470 },
    { demodNs: 0, linkNs: 0, gapNs: 0 },
    { readoutNs: 5 },
  ]) {
    const result = await run(settings);
    const ids = new Set(),
      assemblies = new Set(result.assemblies.map((a) => a.id));
    let time = 0;
    for (const frame of result.frames) {
      assert.ok(frame.atNs >= time);
      assert.ok(!ids.has(frame.id));
      assert.ok(assemblies.has(frame.part));
      for (const id of frame.parents)
        assert.ok(ids.has(id), frame.id + " missing cause " + id);
      ids.add(frame.id);
      time = frame.atNs;
    }
    assert.equal(result.frames.at(-1).state.done, true);
    assert.deepEqual(await run(settings), result);
  }
});

test("invalid programs fail before execution, valid layout edits preserve calibrated timing", async () => {
  for (const settings of [
    { word: 4 },
    { version: 2 },
    { clockNs: 0 },
    { sampleNs: 1601 },
    { widthNs: 0 },
    { linkNs: -1 },
    { readNs: 500 },
    { rx: fixture.tx },
    { tx: { x: -350, z: 0 } },
  ]) {
    await assert.rejects(run(settings));
  }
  const original = await run();
  const moved = await run({ tx: { x: -150, z: 12 } });
  assert.deepEqual(original.frames, moved.frames);
  assert.notDeepEqual(original.program.tx, moved.program.tx);
});
