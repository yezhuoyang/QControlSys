import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { simulate } from "../server.mjs";

const example = JSON.parse(
  await readFile(new URL("../examples/neutral-aod.json", import.meta.url)),
);
const execute = (p) => simulate(JSON.stringify(p));
const findEvent = (r, id) => r.frames.find((f) => f.id === id);
const findSite = (s, column, row) =>
  s.traps.find((t) => t.column === column && t.row === row);

function assertPhysicalState(program, state) {
  const x = state.deliveredXKHz.map((f) => (f - program.referenceKHz) * program.nmPerKHz);
  const y = state.deliveredYKHz.map((f) => (f - program.referenceKHz) * program.nmPerKHz);
  assert.equal(state.traps.length, x.length * y.length);
  assert.equal(state.atoms.length, program.atoms.length);
  for (const [column, xNm] of x.entries()) {
    for (const [row, yNm] of y.entries()) {
      const loaded = program.atoms.find((a) => a.column === column && a.row === row);
      assert.deepEqual(findSite(state, column, row), {
        id: `trap-${column}-${row}`, column, row, xNm, yNm, atom: loaded?.id ?? null,
      });
      if (loaded) {
        assert.deepEqual(state.atoms.find((a) => a.id === loaded.id), { ...loaded, xNm, yNm });
      }
    }
  }
}

test("all intersections follow their delivered tones, including a moving empty trap", async () => {
  const result = await execute(example);
  assertPhysicalState(example, result.initial);
  const scene = new Set(result.assemblies.map((n) => n.id));
  const seen = new Set();
  let timestamp = 0;
  for (const frame of result.frames) {
    assert.ok(!seen.has(frame.id) && frame.atNs >= timestamp);
    assert.ok(frame.parents.every((id) => seen.has(id)));
    assert.ok(scene.has(frame.part) && frame.targets.every((id) => scene.has(id)));
    assertPhysicalState(example, frame.state);
    seen.add(frame.id);
    timestamp = frame.atNs;
  }
  const rf = findEvent(result, "column-rf-1");
  const delivered = findEvent(result, "column-deliver-1");
  assert.deepEqual(rf.state.rfXKHz, [80550, 81000]);
  assert.deepEqual(rf.state.traps, result.initial.traps);
  assert.equal(delivered.atNs - rf.atNs, example.acousticNs);
  assert.ok(delivered.parents.includes(rf.id));
  assert.deepEqual(delivered.state.atoms.map((a) => a.xNm), [5500, 5500, 10000]);
  const final = result.frames.at(-1);
  assert.equal(final.state.done, true);
  assert.equal(final.state.issued, 2);
  assert.deepEqual(final.state.atoms.map((a) => [a.xNm, a.yNm]), [
    [7500, 5000], [7500, 12500], [10000, 5000],
  ]);
  assert.deepEqual(findSite(final.state, 1, 1), {
    column: 1, row: 1, id: "trap-1-1", atom: null, xNm: 10000, yNm: 12500,
  });
  assert.deepEqual(await simulate(JSON.stringify(result), { checkTrace: true }), {
    verified: true, events: result.frames.length,
  });
  findEvent(result, "column-rf-1").state.atoms[0].xNm++;
  await assert.rejects(simulate(JSON.stringify(result), { checkTrace: true }), /column-rf-1/);
});

test("independent axes, pipelined acoustic delivery, and back-to-back ramps replay in causal order", async () => {
  const p = {
    ...example, acousticNs: 6500, referenceKHz: 81000,
    moves: [
      { ...example.moves[0], startNs: 0, durationNs: 6000, targetKHz: 80249, steps: 3 },
      { ...example.moves[1], startNs: 0, durationNs: 6000, steps: 3 },
      { ...example.moves[0], id: "back", startNs: 6000, durationNs: 4000, steps: 2 },
    ],
  };
  const result = await execute(p);
  const seen = new Set();
  for (const f of result.frames) {
    assert.ok(f.parents.every((id) => seen.has(id)));
    seen.add(f.id);
    assertPhysicalState(p, f.state);
  }
  for (const [index, f] of [80416, 80332, 80249].entries()) {
    assert.equal(findEvent(result, "column-rf-" + (index + 1)).frequencyKHz, f);
  }
  const third = findEvent(result, "column-rf-3");
  assert.equal(third.state.deliveredXKHz[0], 80500);
  assert.equal(findEvent(result, "column-deliver-1").state.rfXKHz[0], 80499);
  assert.equal(findEvent(result, "back-rf-1").frequencyKHz, 80499);
  assert.equal(findEvent(result, "row-deliver-1").state.deliveredXKHz[0], 80416);
  assert.ok(findEvent(result, "back-issue").parents.includes(third.id));
  assert.ok(findEvent(result, "back-deliver-1").parents.includes("column-deliver-3"));
});

test("an unloaded layer retains every addressable site and can execute an empty program", async () => {
  const p = { ...example, columnsKHz: [79800, 79900, 80000, 80100], rowsKHz: [80000], atoms: [], moves: [] };
  const result = await execute(p);
  assertPhysicalState(p, result.initial);
  assert.deepEqual(result.initial.traps.map((t) => t.xNm), [-2000, -1000, 0, 1000]);
  assert.deepEqual(result.frames.map((f) => [f.id, f.atNs, f.parents]), [["finish", 0, []]]);
});

test("metric apparatus connects the FPGA, both RF outputs and the optical train to the sample", async () => {
  const r = await execute(example);
  const { system } = r;
  assert.equal(system.unit, "mm");
  assert.equal(system.arrayBoundsInsideReferenceField, true);
  const parts = new Map(system.parts.map((part) => [part.id, part]));
  assert.equal(parts.size, system.parts.length);
  const part = (id) => parts.get(id);
  assert.deepEqual(part("table").sizeMm, [900, 58, 600]);
  assert.deepEqual(part("chassis").sizeMm, [520, 153, 300]);
  assert.deepEqual(part("aod-x").sizeMm, [22.34, 16, 50.76]);
  assert.deepEqual(part("aod-y").sizeMm, [22.34, 50.76, 16]);
  assert.deepEqual(part("objective").sizeMm, [34, 78, 34]);
  function contains(p, point) {
    return point.every((v, i) => Math.abs(v - p.centerMm[i]) <= p.sizeMm[i] / 2 + 1e-9);
  }
  for (const node of r.assemblies) assert.ok(parts.has(node.id));
  for (const f of r.frames) assert.ok(parts.has(f.part) && f.targets.every((id) => parts.has(id)));
  for (const p of parts.values()) assert.ok(p.basis.length > 0);
  for (const id of ["controller", "dds"]) {
    const card = part(id);
    for (const sign of [-1, 1]) {
      const corner = card.centerMm.map((v, i) => v + sign * card.sizeMm[i] / 2);
      assert.ok(contains(part("chassis"), corner));
    }
  }
  for (const link of system.links) {
    assert.ok(link.pointsMm.length >= 2 && link.diameterMm > 0);
    assert.ok(contains(part(link.from), link.pointsMm[0]), link.id + " source port");
    assert.ok(contains(part(link.to), link.pointsMm.at(-1)), link.id + " destination port");
  }
  assert.deepEqual(system.links.filter((l) => l.kind === "rf").map((l) => [l.from, l.to]), [
    ["dds", "aod-x"], ["dds", "aod-y"],
  ]);
  const beams = system.links.filter((l) => l.kind === "optical");
  assert.equal(beams[0].from, "laser");
  beams.slice(1).forEach((b, i) => assert.equal(beams[i].to, b.from));
  const origin = part("array").centerMm;
  assert.deepEqual(beams.at(-1).pointsMm.at(-1), origin);
  for (const id of ["fold", "objective", "window"]) {
    const [x, , z] = part(id).centerMm;
    assert.equal(x, origin[0]);
    assert.equal(z, origin[2]);
  }
  assert.equal(part("objective").centerMm[1] - part("objective").sizeMm[1] / 2 - origin[1], 17);
  assert.ok(contains(part("chamber"), origin));
  const focus = system.focus.find((f) => f.id === "array");
  assert.deepEqual(focus.centerMm, [150.0075, 100, 29.99125]);
  for (const state of [r.initial, ...r.frames.map((f) => f.state)]) {
    for (const t of state.traps) {
      assert.ok(Math.abs(origin[0] + t.xNm / 1e6 - focus.centerMm[0]) < focus.spanMm / 2);
      assert.ok(Math.abs(origin[2] - t.yNm / 1e6 - focus.centerMm[2]) < focus.spanMm / 2);
    }
  }
  assert.equal(part("table").sizeMm[0] / ((example.columnsKHz[1] - example.columnsKHz[0]) *
    example.nmPerKHz / 1e6), 180000);
  part("objective").centerMm[1]++;
  await assert.rejects(simulate(JSON.stringify(r), { checkTrace: true }), /header/);
});

test("programmed displacements outside the reference objective field are exposed in the metric header", async () => {
  const p = { ...example, nmPerKHz: 1000 };
  const r = await execute(p);
  assert.equal(r.system.arrayBoundsInsideReferenceField, false);
  const f = r.system.focus.find((preset) => preset.id === "array");
  assert.deepEqual(f.centerMm, [150.75, 100, 29.125]);
  assert.deepEqual(await simulate(JSON.stringify(r), { checkTrace: true }), {
    verified: true, events: r.frames.length,
  });
});

test("colliding tones, invalid timing, unknown schema fields and duplicated sites are rejected", async () => {
  const first = example.moves[0];
  for (const [changes, reason] of [
    [{ moves: [{ ...first, targetKHz: example.columnsKHz[1] }] }, /merge or cross/],
    [{ moves: [{ ...first, targetKHz: example.columnsKHz[1] + 1 }] }, /merge or cross/],
    [{ moves: [first, { ...first, id: "conflict", tone: 1, startNs: first.startNs + 100 }] }, /overlap/],
    [{ moves: [{ ...first, tone: 2 }] }, /existing tone/],
    [{ moves: [{ ...first, steps: 0 }] }, /positive clock/],
    [{ moves: [{ ...first, steps: 7 }] }, /positive clock/],
    [{ moves: [{ ...first, startNs: 1001 }] }, /positive clock/],
    [{ moves: [{ ...first, targetMHz: 81 }] }, /Unexpected/],
    [{ columnsKHz: [81000, 81000] }, /increasing tones/],
    [{ atoms: [example.atoms[0], { ...example.atoms[0], id: "D" }] }, /unique/],
    [{ atoms: [{ ...example.atoms[0], row: 10 }] }, /existing column and row/],
    [{ nmPerKHz: 0 }, /positive slope/],
    [{ acousticNs: 0 }, /acoustic delay/],
  ]) {
    await assert.rejects(execute({ ...example, ...changes }), reason);
  }
});
