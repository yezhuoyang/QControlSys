// Limits of the modeled controller: gate concurrency of one core, pulse rate of one channel, the
// deepest posted link the schedule lead covers, and the board hub. The core and the hub are the cycle
// models that match RISC-Q's RTL (QControl/RiscQ/Pipe.lean, Soc.lean hubServe; validation/riscq/rtl/).
import test from "node:test";
import assert from "node:assert/strict";
import * as limits from "../riscq/limits.mjs";
import { TABLE_COST } from "../riscq/firmware.mjs";

test("n simultaneous pulses from one core open on one batch after (n − 1) · 63 batches of preroll", async () => {
  // The table loop issues one timed write every 63 core cycles (riscq/firmware.mjs TABLE_COST).
  assert.equal(TABLE_COST, 63);
  for (const n of [1, 2, 4, 8, 16]) {
    const r = await limits.concurrency(n);
    assert.deepEqual(r, { pulses: n, prerollBatches: TABLE_COST * (n - 1), onTime: true, sameBatch: true });
  }
});

test("a deeper timed queue admits shorter pulses in a long back-to-back train", async () => {
  // A train is issue-rate bound: one write per 63 cycles for a queue of one, shorter with more
  // entries to absorb the lead.
  const shortest = Object.fromEntries([1, 4, 8, 32].map((depth) => [depth, limits.shortestTrainPulse(depth)]));
  assert.deepEqual(shortest, { 1: 63, 4: 60, 8: 56, 32: 30 });
  for (const [depth, dur] of Object.entries(shortest))
    assert.deepEqual(await limits.train(Number(depth), dur), { onTime: true, pulses: 60, contiguous: true });
});

test("the schedule lead covers a posted link of at most 36 stages in this model", async () => {
  const r = await limits.deepestLink();
  assert.equal(r.deepest, 36);
  // One stage deeper, the slowest parameter misses while the window still opens.
  assert.deepEqual(r.firstFault, { linkPipe: 37, reason: "pulse parameters did not land on the same batch" });
});

test("simultaneous shared bits pass the hub one per cycle in round-robin order", async () => {
  // One publish: dispatched 14 batches after its store commits and readable at every core 29 after it
  // (RISC-Q RTL, xcore.elf: commit 18 → hub out 33 → inbox 43 → a read returns 4 later).
  const alone = await limits.publishBurst(1);
  assert.deepEqual([alone.dispatched, alone.atEveryBoard], [[14], [29]]);
  const burst = await limits.publishBurst(8);
  assert.deepEqual(burst.faults, []);
  assert.deepEqual(burst.order, ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  assert.deepEqual(burst.atEveryBoard, [29, 30, 31, 32, 33, 34, 35, 36]);
  // From the hub input to dispatch takes 7 cycles alone; the eighth waited 7 more.
  assert.deepEqual([burst.hub.maxWait, burst.hub.peakWaiting, burst.word], [14, 8, 0xff]);
});

test("simultaneous barrier arrivals are counted three cycles apart and release every core with one time", async () => {
  // PutHub.scala: an arrival for a barrier waits at s2 while the previous one is at arb or write-back.
  const pair = await limits.barrierFanIn(2);
  assert.deepEqual([pair.counted, pair.releasedAtHub, pair.atEveryCore, pair.sameTime], [[14, 17], 17, 32, true]);
  const eight = await limits.barrierFanIn(8);
  assert.deepEqual(eight.faults, []);
  assert.deepEqual(eight.counted, [14, 17, 20, 23, 26, 29, 32, 35]);
  assert.equal(eight.atEveryCore, 32 + 3 * 6);
  assert.ok(eight.sameTime);
});

test("a core publishes once per 6 cycles: four cores fit the hub and eight overflow its queues", async () => {
  // Posted stores drain one per 6 cycles (PostedStoreShim, one data-bus transaction at a time).
  const four = await limits.publishFlood(4, 40);
  assert.equal(Math.round(four.putIntervalBatches), 6);
  assert.deepEqual([four.dropped, four.served], [0, 160]);
  const eight = await limits.publishFlood(8, 40);
  assert.ok(eight.dropped > 0 && eight.dropped === eight.faults);
  assert.equal(eight.served + eight.dropped, eight.issued);
  // The hub holds at most 8 FIFO entries and one source register per source, and its 3 pipe registers.
  assert.ok(eight.peakWaiting <= 8 * (8 + 1) + 3);
});
