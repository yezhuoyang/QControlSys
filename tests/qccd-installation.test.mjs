import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Vector3 } from "three";
import { simulate } from "../server.mjs";
import {
  buildQccdInstallation,
  studioCycleParts,
} from "../studio/qccd-installation.js";

const system = JSON.parse(
  readFileSync(new URL("../physical/qccd-installation.json", import.meta.url)),
);
const chip = system.parts.find((p) => p.id === "chip");

test("the executable embeds the current physical installation and its control bindings", async () => {
  const input = readFileSync(new URL("../examples/qccd-broadcast.json", import.meta.url), "utf8");
  const run = await simulate(input);
  assert.deepEqual(run.system, system);
});
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} versus ${expected}`);
const point = (model, name) =>
  model.root.getObjectByName(name).getWorldPosition(new Vector3());

test("physical reference fits its carrier, cable interfaces and published H2 dimensions", () => {
  const parts = new Map(system.parts.map((p) => [p.id, p]));
  assert.equal(system.unit, "mm");
  for (const l of system.links) {
    assert.ok(parts.has(l.from) && parts.has(l.to));
    assert.ok(
      l.pointsMm.length >= 2 &&
        l.pointsMm.every((p) => p.length === 3 && p.every(Number.isFinite)),
    );
  }
  const carrier = parts.get("carrier");
  near(
    carrier.centerMm[1] + carrier.sizeMm[1] / 2,
    chip.centerMm[1] - chip.sizeMm[1] / 2,
  );
  assert.deepEqual(
    [
      system.chipModel.electrodeSpanMm,
      system.chipModel.isthmusWidthMm,
      system.chipModel.h2PitchMm,
      system.chipModel.ionHeightMm,
    ],
    [6.58, 2.02, 0.75, 0.07],
  );
});

test("synthetic broadcast stays inside its die at maximum travel and lane count, including rewind", () => {
  const zones = Array.from({ length: 6 }, (_, i) => ({
    id: String.fromCharCode(65 + i),
  }));
  const initial = { lanes: zones.map((z) => ({ ...z, ionUm: 0 })) };
  const run = { program: { travelUm: 1000, zones, gateZone: "A" }, initial };
  const model = buildQccdInstallation(system, run);
  model.update(null);
  const start = point(model, "ion:A");
  const state = {
    ...initial,
    lanes: initial.lanes.map((l, i) => ({ ...l, ionUm: i % 2 ? 0 : 1000 })),
    lightOn: true,
    exposedIon: "A",
  };
  model.update({
    state,
    part: "optics",
    targets: ["zone-A"],
    opticalHeadPermille: 1000,
    opticalTailPermille: 0,
  });
  for (const [i, zone] of zones.entries()) {
    const pos = point(model, "ion:" + zone.id);
    near(pos.x - start.x, i % 2 ? 0 : 1);
    near(pos.y, chip.centerMm[1] + chip.sizeMm[1] / 2 + 0.07);
    assert.ok(Math.abs(pos.z - chip.centerMm[2]) < 2.02 / 2);
  }
  const rays = model.root
    .getObjectByName("gate-beam")
    .children.filter((r) => r.visible);
  assert.equal(rays.length, 1);
  assert.equal(rays[0].userData.eventPart, "zone-A");
  model.update(null);
  near(point(model, "ion:A").x, start.x);
  assert.ok(
    model.root.getObjectByName("gate-beam").children.every((r) => !r.visible),
  );
  model.dispose();
});

test("imported wells use the native floorplan pitch and actual per-cycle occupancy and gate targets", () => {
  const machine = {
    nodes: [
      { id: "DG01", pos: [0, 0, 0], gate: true },
      { id: "DG02", pos: [1, 0, 0], gate: true },
    ],
    segments: [{ id: "e01", a: "DG01", b: "DG02" }],
  };
  const model = buildQccdInstallation(system, {
    machine,
    program: { name: "reference" },
  });
  const f = {
    op: "gate",
    control: { driver: "optical" },
    physicalParts: system.studioBindings.driver.optical,
    ions: ["q0", "q1"],
    targets: ["DG02"],
    moves: [],
  };
  const positions = new Map([
    ["q0", "DG01"],
    ["q1", "DG02"],
  ]);
  model.update(f, positions);
  near(point(model, "ion:q1").x - point(model, "ion:q0").x, 0.75);
  near(point(model, "ion:q0").y - chip.centerMm[1] - chip.sizeMm[1] / 2, 0.07);
  positions.set("q0", "DG02");
  model.update(f, positions);
  const center = model.anchors.get("DG02");
  near((point(model, "ion:q1").x + point(model, "ion:q0").x) / 2, center.x);
  assert.equal(
    model.root.getObjectByName("gate-beam").children.find((r) => r.visible)
      .userData.eventPart,
    "DG02",
  );
  assert.ok(studioCycleParts(f).includes("optics"));
  assert.ok(
    studioCycleParts({
      ...f,
      physicalParts: system.studioBindings.driver.transport,
    }).includes("dac"),
  );
  model.dispose();
});
