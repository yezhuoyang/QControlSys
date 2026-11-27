// Algorithms at medium scale (riscq/ftqvm/medium.mjs): the stored runs the site shows. Each was compiled
// offline, derived on the twin until every system call fit its window, and stored with its listing.
import test from "node:test";
import assert from "node:assert/strict";
import { MEDIUM_PROGRAMS, MEDIUM_BUDGET_S, storedRun, mediumStudy, mediumRow } from "../riscq/ftqvm/medium.mjs";

const stored = MEDIUM_PROGRAMS.map((p) => ({ p, r: storedRun(p.id) })).filter((x) => x.r);
// The largest reproduced paper's twin: 98 physical qubits (Bluvstein et al. 2024), about 3,900 operations.
const LARGEST_PAPER = { sites: 98, ops: 3937 };

test("every stored medium run is larger than every reproduced paper, was derived within the hour, and keeps every window", () => {
  assert.ok(stored.length > 0);
  for (const { p, r } of stored) {
    assert.ok(r.sites > LARGEST_PAPER.sites && r.ops > LARGEST_PAPER.ops, p.id + ": " + r.sites + " physical qubits, " + r.ops + " operations");
    assert.ok(r.seconds <= MEDIUM_BUDGET_S, p.id + ": derived in " + Math.round(r.seconds) + " s");
    assert.equal(r.distance, p.distance);
    assert.equal(r.conforms, true, p.id);
    assert.ok(Object.values(r.byKind).every((k) => k.ok === k.count), p.id);
    assert.equal(r.listing.ops?.length ?? r.listing.opCount, r.ops);
  }
});

test("a stored run carries no path of the machine it was compiled on", () => {
  for (const { p, r } of stored) {
    const source = JSON.stringify(r.listing.source ?? {});
    assert.ok(!/[\\/]Users[\\/]|AppData|[A-Z]:\\\\/.test(source), p.id + ": " + source);
    assert.equal(r.listing.source?.compiler, undefined);
  }
});

test("the study and the stored machine's row read the stored runs", async () => {
  const study = mediumStudy();
  const table = study.sections.find((s) => s.table).table;
  assert.equal(table.rows.length, stored.length);
  const { p, r } = stored[0];
  const row = await mediumRow({ program: p.id });
  assert.equal(row.conforms, true);
  assert.equal(row.program, r.listing.qsysasm);
  assert.match(row.columns["Physical qubits"], new RegExp("^" + r.sites + " transmons"));
});
