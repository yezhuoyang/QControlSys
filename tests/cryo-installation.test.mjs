import assert from "node:assert/strict";
import test from "node:test";
import { apparatus } from "../machine/apparatus.mjs";
import { examples } from "../machine/examples.mjs";
import { deliveryBranches } from "../machine/installation-display.mjs";
import { lowerDelivery } from "../machine/delivery.mjs";

test("cold RF routes match the paper's cable lengths and meet the physical package launch", () => {
  const { device, parts, wires } = structuredClone(examples[0].design);
  const equipment = apparatus(device, parts, wires);
  const branches = deliveryBranches(device, equipment);
  const lowered = lowerDelivery(device, parts, wires);
  const expectedLengths = [200, 290, 250, 170, 140];
  const launchPoints = new Set();
  for (const { probe, targets } of device.drives) {
    const links = equipment.links.filter((l) => l.probes.includes(probe));
    const thermalized = links.filter((l) => l.cableLengthMm !== undefined);
    assert.deepEqual(thermalized.map((l) => l.cableLengthMm), expectedLengths);
    assert.equal(links[0].from, probe);
    assert.equal(links.at(-1).to, equipment.chip);
    for (let i = 1; i < links.length; i++) {
      assert.equal(links[i - 1].to, links[i].from);
      assert.deepEqual(links[i - 1].pointsMm.at(-1), links[i].pointsMm[0]);
    }
    for (const l of thermalized) {
      const pathLength = l.pointsMm.slice(1).reduce((sum, p, i) =>
        sum + Math.hypot(...p.map((x, j) => x - l.pointsMm[i][j])), 0);
      assert.ok(Math.abs(pathLength - l.cableLengthMm) < 1e-8);
      assert.ok(l.pointsMm[0][1] - l.pointsMm.at(-1)[1] < l.cableLengthMm);
      const stage = lowered.stages.find((s) => s.probe === probe && s.link === l.id);
      assert.equal(stage.delayPs, Math.ceil(l.cableLengthMm * 1000 / device.propagation.electricalMmPerNs));
    }
    const pins = branches.filter((b) => b.probe === probe);
    assert.deepEqual(pins.map((b) => b.target), targets);
    for (const pin of pins) {
      assert.deepEqual(pin.sourceMm, links.at(-2).pointsMm.at(-1));
      assert.equal(pin.link, links.at(-1).id);
    }
    launchPoints.add(JSON.stringify(pins[0].sourceMm));
  }
  assert.equal(launchPoints.size, device.drives.length);
  const base = equipment.parts.find((p) => p.form === "cryo-package-base");
  const dieBack = device.centerMm[1] - device.layout.chip.substrateThicknessMm;
  assert.equal(base.centerMm[1] + base.sizeMm[1] / 2, dieBack);
});
