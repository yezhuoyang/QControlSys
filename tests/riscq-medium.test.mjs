// Algorithms at medium scale (riscq/ftqvm/medium.mjs): the stored runs the site shows. Each was compiled
// offline for one hardware design, derived on the twin until every system call fit its window, and stored
// with its listing.
import test from "node:test";
import assert from "node:assert/strict";
import { MEDIUM_PROGRAMS, MEDIUM_HARDWARE, MEDIUM_RUNS, MEDIUM_BUDGET_S, storedRun, storedRuns, mediumStudy, mediumRow, runId } from "../riscq/ftqvm/medium.mjs";

const stored = storedRuns().map(({ p, h, id }) => ({ p, h, id, r: storedRun(id) }));
// The largest reproduced paper's twin: 98 physical qubits (Bluvstein et al. 2024), about 3,900 operations.
const LARGEST_PAPER = { sites: 98, ops: 3937 };

test("three platforms, two designs each, and every design runs at least two programs", () => {
  const platforms = new Map();
  for (const h of MEDIUM_HARDWARE) platforms.set(h.platform, (platforms.get(h.platform) ?? 0) + 1);
  assert.deepEqual([...platforms.entries()].sort(), [["Neutral atoms", 2], ["Superconducting", 2], ["Trapped ions", 2]]);
  for (const h of MEDIUM_HARDWARE) assert.ok(MEDIUM_RUNS.filter((x) => x.params.hardware === h.id).length >= 2, h.id);
  assert.equal(new Set(MEDIUM_RUNS.map((x) => runId(x.params.program, x.params.hardware))).size, MEDIUM_RUNS.length);
});

test("every stored medium run is larger than every reproduced paper, was derived within the hour, and keeps every window", () => {
  assert.ok(stored.length > 0);
  for (const { p, h, id, r } of stored) {
    assert.ok(r.sites > LARGEST_PAPER.sites && r.ops > LARGEST_PAPER.ops, id + ": " + r.sites + " physical qubits, " + r.ops + " operations");
    assert.ok(r.seconds <= MEDIUM_BUDGET_S, id + ": derived in " + Math.round(r.seconds) + " s");
    assert.equal(r.distance, p.distance);
    assert.equal(r.hardware ?? MEDIUM_HARDWARE[0].id, h.id, id);
    assert.equal(r.conforms, true, id);
    assert.ok(Object.values(r.byKind).every((k) => k.ok === k.count), id);
    assert.equal(r.listing.ops?.length ?? r.listing.opCount, r.ops);
  }
});

test("every move of a stored track is between positions in its device's unit", () => {
  for (const { id, r } of stored) {
    if (!r.track?.moves?.length) continue;
    const ring = r.track.device.kind === "ions-ring";
    const ok = (p) => (ring ? Number.isFinite(p) : Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite));
    const bad = r.track.moves.filter((m) => !ok(m.from) || !ok(m.to));
    assert.equal(bad.length, 0, id + " (" + r.track.device.kind + ", " + r.track.device.unit + "): " + JSON.stringify(bad[0]));
  }
});

test("a stored run carries no path of the machine it was compiled on", () => {
  for (const { id, r } of stored) {
    const source = JSON.stringify(r.listing.source ?? {});
    assert.ok(!/[\\/]Users[\\/]|AppData|[A-Z]:\\\\/.test(source), id + ": " + source);
    assert.equal(r.listing.source?.compiler, undefined);
  }
});

test("the study and the stored machine's row read the stored runs", async () => {
  const study = mediumStudy();
  const table = study.sections.find((s) => s.table).table;
  assert.equal(table.rows.length, stored.length);
  for (const { p, h, r } of [stored[0], stored.find((x) => x.h !== MEDIUM_HARDWARE[0])].filter(Boolean)) {
    const row = await mediumRow({ program: p.id, hardware: h.id });
    assert.equal(row.conforms, true);
    assert.equal(row.program, r.listing.qsysasm);
    assert.match(row.columns["Physical qubits"], new RegExp("^" + r.sites + " " + h.qubits));
    assert.equal(row.formKey.hardware, h.id);
  }
  assert.ok(MEDIUM_PROGRAMS.length > 0);
});
