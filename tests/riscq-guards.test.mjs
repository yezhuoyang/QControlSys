// Guarded operations of a listing (QSysASM `… if c[i]`): a body runs when every band's parity is 1
// (0 for a negated band), as the compiler's `when` and `when ¬` define it. A run decides each guard
// from its record values; `guards: "taken"` runs every guarded body, the bound the resource VM reserves.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guardHolds, runListing } from "../riscq/ftqvm/sc-run.mjs";

const rec = (index, register = "c") => ({ register, index });

test("a guard is a conjunction of band parities, each band plain or negated", () => {
  const g = { bands: [{ negated: false, records: [rec(0), rec(1)] }, { negated: true, records: [rec(2)] }] };
  assert.equal(guardHolds(g, { outcomes: { "c[0]": 1 } }), true); // 1 ⊕ 0 = 1, and c[2] = 0
  assert.equal(guardHolds(g, { outcomes: { "c[0]": 1, "c[1]": 1 } }), false); // parity 0
  assert.equal(guardHolds(g, { outcomes: { "c[0]": 1, "c[2]": 1 } }), false); // the negated band fails
  assert.equal(guardHolds(g, { guards: "taken" }), true);
  assert.equal(guardHolds(undefined, {}), true);
});

test("a guarded operation plays only when its guard holds, and the run still checks every window", { timeout: 600_000 }, async () => {
  const { willow } = await import("../riscq/ftqvm/twins.mjs");
  const { transmonTwin } = await import("../riscq/ftqvm/platforms.mjs");
  const src = JSON.parse(readFileSync(new URL("../validation/ftqvm/twins/google-2025/d3.json", import.meta.url), "utf8"));
  const twin = transmonTwin(willow(), src.platform.options);
  const listing = structuredClone(src.listing);
  const target = listing.ops.find((o) => o.kind === "CNOT");
  target.guard = { bands: [{ negated: false, records: [rec(999, "c")] }] };
  const placement = twin.place(listing, { distance: 3 });
  const design = twin.design(listing, placement);
  // The op's pulses, as conformance matched them to it: its row has hardware times only when they played.
  const played = (r) => r.report.rows.find((x) => x.uid === target.uid).hardwareNs;
  const off = await runListing(listing, placement, design, { distance: 3 });
  const row = off.report.rows.find((r) => r.uid === target.uid);
  assert.deepEqual([row.skipped, row.ok, off.report.skipped], [true, true, 1]);
  assert.equal(played(off), undefined);
  const on = await runListing(listing, placement, design, { distance: 3, outcomes: { "c[999]": 1 } });
  assert.equal(on.report.skipped, 0);
  assert.ok(played(on));
  assert.equal(on.report.rows.find((x) => x.uid === target.uid).ok, true);
  const taken = await runListing(listing, placement, design, { distance: 3, guards: "taken" });
  assert.deepEqual(played(taken), played(on));
  assert.ok(on.result.summary.pulses.length > off.result.summary.pulses.length);
  for (const r of [off, on, taken]) assert.deepEqual(r.result.summary.faults, []);
});
