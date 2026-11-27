// Algorithms at medium scale (riscq/ftqvm/medium.mjs): the stored runs the site shows. Each was compiled
// offline, derived on the twin until every system call fit its window, and stored with its listing.
import test from "node:test";
import assert from "node:assert/strict";
import { MEDIUM_PROGRAMS, storedRun, mediumStudy, mediumRow } from "../riscq/ftqvm/medium.mjs";

const stored = MEDIUM_PROGRAMS.map((p) => ({ p, r: storedRun(p.id) })).filter((x) => x.r);

test("every stored medium run encodes 10–15 logical qubits in 500–1,000 physical qubits and keeps every window", () => {
  assert.ok(stored.length > 0);
  for (const { p, r } of stored) {
    assert.ok(p.logical >= 10 && p.logical <= 15, p.id);
    assert.ok(r.sites >= 500 && r.sites <= 1000, p.id + ": " + r.sites + " physical qubits");
    assert.equal(r.distance, 5);
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
