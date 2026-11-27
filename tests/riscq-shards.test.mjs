// A sharded run (riscq/ftqvm/sc-shards.mjs) gives the report of the whole run: the cores meet once at the
// segment's barrier, which every shard runs whole, and then each plays only its own program. Checked here
// on Google's d = 3 memory across 19 boards; GHZ-12 at d = 5 (398,027 operations on 224 boards, 8 shards)
// gave the same per-kind summary and the same 296,807 track events as its whole run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runListing } from "../riscq/ftqvm/sc-run.mjs";
import { runListingSharded } from "../riscq/ftqvm/sc-shards.mjs";

test("a run sharded over groups of boards reports every row as the whole run does", { timeout: 600_000 }, async () => {
  const { willow } = await import("../riscq/ftqvm/twins.mjs");
  const { transmonTwin } = await import("../riscq/ftqvm/platforms.mjs");
  const src = JSON.parse(readFileSync(new URL("../validation/ftqvm/twins/google-2025/d3.json", import.meta.url), "utf8"));
  const twin = transmonTwin(willow(), src.platform.options);
  const placement = twin.place(src.listing, { distance: 3 });
  const design = twin.design(src.listing, placement);
  assert.ok(design.control.boards > 4);
  const whole = await runListing(src.listing, placement, design, { distance: 3, trace: "summary" });
  const sharded = await runListingSharded(src.listing, placement, design, { distance: 3, shards: 4 });
  assert.ok(sharded.shards > 1);
  const row = (r) => [r.uid, r.kind, r.ok, r.hardwareNs, r.overrunNs, r.late, r.overlap, r.bitNs, r.bitOverrunNs, r.skipped];
  assert.deepEqual(sharded.report.rows.map(row), whole.report.rows.map(row));
  assert.deepEqual(sharded.report.byKind, whole.report.byKind);
  assert.equal(sharded.report.baseBatch, whole.report.baseBatch);
  assert.deepEqual(Object.entries(sharded.report.bits).sort(), Object.entries(whole.report.bits).sort());
  assert.deepEqual(sharded.report.track.events, whole.report.track.events);
});

test("a run that reaches the model's time budget stops instead of reporting the missing work as late", async () => {
  const { batchBudget, checkFinished } = await import("../riscq/ftqvm/sc-run.mjs");
  // DJ-12 at d = 5 lasts 241,000,000 batches: past the model's default of 100,000,000.
  assert.ok(batchBudget({ segments: [{ span: 241_417_106 }] }) > 241_417_106);
  assert.equal(batchBudget({ segments: [{ span: 1000 }] }), 100_000_000);
  assert.throws(() => checkFinished({ summary: { status: "time limit", elapsedBatches: 100_000_001 } }), /before the program ended/);
});
