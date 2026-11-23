import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { simulate } from "../server.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../examples/qccd-broadcast.json", import.meta.url)),
);
const execute = (p) => simulate(JSON.stringify(p));
function design(changes = {}, second = {}) {
  return {
    ...structuredClone(fixture),
    zones: [{ ...fixture.zones[0] }, { ...fixture.zones[1], ...second }],
    ...changes,
  };
}
const event = (r, id) => r.frames.find((f) => f.id === id);
const lane = (r, id, zone) =>
  event(r, id).state.lanes.find((l) => l.id === zone);

test("a shared waveform moves exactly the connected lanes whose sampled switch was enabled", async () => {
  for (const wired of [false, true])
    for (const initialEnable of [false, true])
      for (const requestEnable of [false, true]) {
        for (const arrivalNs of [4999, 5000, 5001]) {
          const r = await execute(
            design({}, { wired, initialEnable, requestEnable, arrivalNs }),
          );
          const enabled = arrivalNs <= 5000 ? requestEnable : initialEnable;
          assert.equal(lane(r, "strobe", "B").latched, enabled);
          assert.equal(lane(r, "strobe", "B").stale, arrivalNs > 5000);
          for (const [i, k] of fixture.waveform.entries()) {
            const knot = event(r, "knot-" + i),
              b = knot.state.lanes[1];
            assert.equal(knot.atNs, 5000 + k.offsetNs);
            assert.equal(knot.state.busMv, k.mv);
            assert.equal(b.electrodeMv, wired && enabled ? k.mv : 0);
            assert.equal(
              b.ionUm,
              wired && enabled ? Math.floor((120 * k.mv) / 2000) : 0,
            );
            assert.deepEqual(
              knot.targets,
              wired && enabled ? ["zone-A", "zone-B"] : ["zone-A"],
            );
          }
          assert.equal(lane(r, "finish", "B").pending, requestEnable);
        }
      }
});

test("optical pulses address the chosen destination after settling, including an empty well", async () => {
  for (const [arrivalNs, hit] of [
    [4000, null],
    [6000, "B"],
  ]) {
    const r = await execute(design({ gateZone: "B" }, { arrivalNs }));
    assert.equal(event(r, "settle").atNs, 47000);
    assert.equal(event(r, "light").state.lightOn, true);
    assert.equal(event(r, "light").state.exposedIon, hit);
    assert.equal(event(r, "launch").atNs, 47000);
    assert.equal(event(r, "light").atNs, 47040);
    assert.equal(event(r, "dark").atNs, 50040);
    assert.equal(event(r, "dark").state.lightOn, false);
  }
});

test("the optical head receives both edges even if the source has already switched off", async () => {
  const r = await execute(design({ gateNs: 100, opticalDelayNs: 250 }));
  assert.equal(event(r, "end-launch").state.lightOn, false);
  assert.equal(event(r, "end-launch").opticalHeadPermille, 400);
  assert.equal(event(r, "end-launch").opticalTailPermille, 0);
  assert.equal(event(r, "light").state.sourceOn, false);
  assert.equal(event(r, "light").state.lightOn, true);
  assert.equal(event(r, "dark").atNs - event(r, "light").atNs, 100);
});

test("six-lane traces bind all recipients to geometry, preserve causal order and verify", async () => {
  const zones = [..."ABCDEF"].map((id, i) => ({
    ...fixture.zones[0],
    id,
    arrivalNs: i === 5 ? 90000 : i * 1000,
  }));
  const p = design({ zones }),
    r = await execute(p),
    seen = new Set(),
    scene = new Set(r.assemblies.map((n) => n.id));
  let previous = 0;
  for (const f of r.frames) {
    assert.ok(scene.has(f.part) && f.targets.every((id) => scene.has(id)));
    assert.ok(f.atNs >= previous && !seen.has(f.id));
    assert.ok(f.parents.every((id) => seen.has(id)));
    previous = f.atNs;
    seen.add(f.id);
  }
  assert.equal(r.frames.at(-1).atNs, 90000);
  assert.deepEqual(await simulate(JSON.stringify(r), { checkTrace: true }), {
    verified: true,
    events: r.frames.length,
  });
  lane(r, "knot-2", "B").ionUm++;
  await assert.rejects(
    simulate(JSON.stringify(r), { checkTrace: true }),
    /event knot-2/,
  );
});

test("invalid wiring documents, waveforms, clock alignment and optical addresses are rejected", async () => {
  for (const changes of [
    { gateZone: "X" },
    { zones: [] },
    { zones: [fixture.zones[0], fixture.zones[0]] },
    { clockNs: 0 },
    { latchNs: 4050 },
    { travelUm: 0 },
    {
      waveform: [
        { offsetNs: 0, mv: 0 },
        { offsetNs: 0, mv: 2000 },
      ],
    },
    {
      waveform: [
        { offsetNs: 0, mv: 1 },
        { offsetNs: 1, mv: 2000 },
      ],
    },
    { zones: [{ ...fixture.zones[0], unknown: 1 }] },
  ]) {
    await assert.rejects(execute(design(changes)));
  }
});
