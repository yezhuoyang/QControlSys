import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { examples } from "../machine/examples.mjs";
import { runMachine } from "../server.mjs";
import {
  registerLens,
  radiusScale,
  deliveryBranches,
  producingParts,
  installedPoint,
} from "../machine/installation-display.mjs";
import { boardLayout, pulseProvenance } from "../machine/provenance.mjs";
const fixture = (path) =>
  JSON.parse(readFileSync(new URL("../" + path, import.meta.url)));

test("the hardware register includes every physical qubit, including idle qubits", () => {
  const [chip, atoms, ions] = examples.map((e) => e.design.device);
  const metal = fixture("validation/superconducting/metal-layout.json");
  assert.deepEqual(chip.layout.metalPolygons, metal.metalPolygons);
  assert.deepEqual(chip.layout.junctions, metal.junctions);
  for (const [device, count] of [
    [chip, 2],
    [atoms, 14],
    [ions, 32],
  ]) {
    assert.deepEqual(
      new Set(device.qubits.map((q) => q.id)),
      new Set(Array.from({ length: count }, (_, i) => "q[" + i + "]")),
    );
  }
  const { instructions } = fixture(
    "validation/neutral/zac/bv_n14_transpiled_code.json",
  );
  const placement = new Map(
    [
      ...instructions[0].init_locs,
      ...instructions.find((i) => i.id === 2).end_locs,
    ].map((loc) => [loc[0], loc]),
  );
  const arch = fixture("validation/neutral/zac/full_architecture_2aod.json");
  for (const [i, slm, r, c] of placement.values()) {
    const s = [...arch.storage_zones, ...arch.entanglement_zones]
      .flatMap((z) => z.slms)
      .find((g) => g.id === slm);
    const q = atoms.qubits.find((q) => q.id === "q[" + i + "]");
    assert.deepEqual(q.positionMm, [
      (s.location[0] + c * s.site_seperation[0]) / 1000,
      0,
      (s.location[1] + r * s.site_seperation[1]) / 1000,
    ]);
  }
  const h2 = fixture("physical/h2-register.json");
  const gate = fixture("physical/h2-gate-register.json");
  const model = fixture("physical/qccd-installation.json").chipModel;
  for (const [id, site] of Object.entries(gate.placement)) {
    const q = ions.qubits.find((q) => q.id === "q[" + id.slice(1) + "]");
    const [, x, z] = h2.sites.find((s) => s[0] === site);
    assert.equal(q.site, site);
    assert.deepEqual(q.positionMm, [
      (x - model.h2OriginPitch[0]) * model.h2PitchMm +
        (id === "q0" ? -0.0025 : id === "q1" ? 0.0025 : 0),
      model.ionHeightMm,
      (z - model.h2OriginPitch[1]) * model.h2PitchMm,
    ]);
    assert.equal(
      installedPoint(ions, q.positionMm)[1],
      ions.centerMm[1] - model.ionHeightMm,
    );
  }
});

test("each recorded pulse exposes its source line, FPGA, DAC, real wires, optical arms and recipient", async () => {
  for (const example of examples.slice(0, 3)) {
    const run = await runMachine({ ...example, sourceName: "example.qasm" });
    const pcb = boardLayout(example.design);
    const allLinks = new Set(
      [...example.design.wires, ...run.apparatus.links, ...pcb.links].map(
        (l) => l.id,
      ),
    );
    for (const probe of ["driveA", "driveB", "pair-drive"]) {
      const sample = run.terminalActivity.find(
        (a) => a.probe === probe && a.valueUv !== 0,
      );
      const pulse = pulseProvenance(run, sample.event);
      assert.equal(pulse.sourceName, "example.qasm");
      assert.match(pulse.origin, /OpenQASM line/);
      assert.equal(pulse.chain[0].hardware, "sequencer");
      assert.equal(pulse.chain.at(-1).label, sample.targets[0]);
      assert.equal(pulse.chain.at(-1).atPs, sample.atPs);
      assert.ok(
        pulse.chain.every((h, i) => !i || pulse.chain[i - 1].atPs <= h.atPs),
      );
      for (const h of [
        ...pulse.chain,
        ...pulse.controls.flatMap((c) => c.hops),
      ]) {
        if (h.wire) assert.ok(allLinks.has(h.wire), h.wire);
        assert.equal(run.trace.frames[h.event].atPs, h.atPs);
      }
      if (probe === "pair-drive") {
        for (const key of ["request", "word"])
          assert.ok(
            pulse.chain.some((h) => h.wire === pcb.id("pair-board", key)),
          );
        assert.ok(
          pulse.controls.some((c) =>
            c.hops.some((h) => h.wire === pcb.id("pair-board", "play")),
          ),
        );
      } else {
        for (const id of ["addr", "data", "payload"])
          assert.ok(pulse.chain.some((h) => h.wire === id));
        assert.ok(pulse.controls.some((c) => c.label === "Channel selection"));
      }
      if (example.design.device.kind !== "transmon")
        assert.ok(pulse.carriers.length);
    }
  }
});

test("register activity is driven by physical receipt, including fan-out, zero and disconnected recipients", async () => {
  const e = structuredClone(examples[2]);
  e.source =
    'OPENQASM 3.0; include "stdgates.inc"; qubit[2] q; x q[0]; cz q[0], q[1];';
  const r = await runMachine(e);
  const parts = new Map(
    [...e.design.parts, ...r.apparatus.parts].map((p) => [p.id, p]),
  );
  assert.deepEqual(
    parts.get(r.apparatus.chip).centerMm,
    e.design.device.centerMm,
  );
  for (const link of r.apparatus.links) {
    for (const [id, point, offset] of [
      [link.from, link.pointsMm[0], link.fromOffsetMm],
      [link.to, link.pointsMm.at(-1), link.toOffsetMm],
    ]) {
      assert.deepEqual(
        point,
        parts.get(id).centerMm.map((v, i) => v + (offset?.[i] ?? 0)),
      );
    }
  }
  const first = r.deviceActivity.find((a) => a.valueUv !== 0);
  assert.equal(first.probe, "driveA");
  assert.deepEqual(first.targets, ["q[0]"]);
  for (const a of r.deviceActivity) {
    const f = r.trace.frames[a.event];
    assert.equal(f.part, a.probe);
    assert.deepEqual(f.received, ["in", a.valueUv]);
    assert.equal(f.atPs, a.atPs);
    assert.ok(f.parents.length);
  }
  assert.deepEqual(
    r.deviceActivity.find((a) => a.probe === "pair-drive" && a.valueUv !== 0)
      .targets,
    ["q[0]", "q[1]"],
  );
  assert.ok(
    r.deviceActivity.some(
      (a) => a.event > first.event && a.valueUv === 0 && a.probe === "driveA",
    ),
  );
  e.design.wires = e.design.wires.filter((w) => w.dst.part !== "driveA");
  const rerouted = await runMachine(e);
  assert.ok(!rerouted.deviceActivity.some((a) => a.probe === "driveA"));
  assert.ok(!rerouted.terminalActivity.some((a) => a.probe === "driveA"));
  e.design.device.drives[0].targets = ["missing"];
  await assert.rejects(runMachine(e, true), /recipient/);
  delete e.design.device;
  assert.ok(!("deviceActivity" in (await runMachine(e))));
});

test("each qubit delivery follows timed physical stages in the executing electronics netlist", async () => {
  for (const e of examples.slice(0, 3)) {
    const doc = structuredClone(e);
    doc.source =
      'OPENQASM 3.0; include "stdgates.inc"; qubit[2] q; x q[0]; cz q[0],q[1];';
    const r = await runMachine(doc),
      frames = r.trace.frames;
    const stages = new Map(r.delivery.stages.map((s) => [s.id, s]));
    const branches = deliveryBranches(doc.design.device, r.apparatus);
    for (const b of branches) {
      const end = r.terminalActivity.find(
        (a) =>
          a.probe === b.probe &&
          a.targets.includes(b.target) &&
          a.valueUv !== 0,
      );
      if (b.probe === "driveB") continue; // No independent driveB instruction in this program.
      assert.ok(end);
      const sink = r.trace.program.parts.find((p) => p.id === end.receiver);
      assert.deepEqual(sink.centerMm, b.endMm);
      const route = producingParts(frames, end.event);
      assert.ok(route.parts.includes(b.probe));
      assert.equal(route.parts.at(-1), sink.id);
      let f = frames[end.event];
      while (stages.has(f.part)) {
        const s = stages.get(f.part),
          prev = frames[f.parents[0]];
        assert.equal(f.atPs - prev.atPs, s.delayPs);
        assert.equal(f.received[1], end.valueUv);
        assert.ok(r.apparatus.parts.some((p) => p.id === s.hardware));
        assert.ok(r.apparatus.links.some((l) => l.id === s.link));
        f = prev;
      }
      assert.equal(f.part, b.probe);
      assert.ok(end.atPs > f.atPs);
    }
  }
});

test("the display magnification fixes the device origin and preserves ordering through both boundaries", () => {
  for (const { design } of examples.slice(0, 3)) {
    const l = registerLens(design.device);
    assert.equal(radiusScale(0, l) * 0, 0);
    assert.ok(
      Math.abs(radiusScale(l.inner, l) * l.inner - l.enlarged) <=
        Number.EPSILON * l.enlarged,
    );
    assert.equal(radiusScale(l.outer, l), 1);
    let prev = -1;
    for (let i = 0; i <= 300; i++) {
      const r = (l.outer * i) / 250,
        display = r * radiusScale(r, l);
      assert.ok(display > prev);
      prev = display;
    }
  }
});
