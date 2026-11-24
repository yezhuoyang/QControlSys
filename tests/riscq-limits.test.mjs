// Limits of the modeled controller: gate concurrency of one core, pulse rate of one channel
// and the deepest posted link that the software lead of 96 batches still covers.
import test from "node:test";
import assert from "node:assert/strict";
import * as limits from "../riscq/limits.mjs";

test("n simultaneous pulses from one core open on one batch after (n − 1) · 32 batches of preroll", async () => {
  for (const n of [1, 2, 4, 8, 16]) {
    const r = await limits.concurrency(n);
    // The table loop issues one timed write every 32 core cycles.
    assert.deepEqual(r, { pulses: n, prerollBatches: 32 * (n - 1), onTime: true, sameBatch: true });
  }
});

test("a deeper timed queue admits shorter pulses in a long back-to-back train", async () => {
  const shortest = Object.fromEntries([1, 4, 8, 32].map((depth) => [depth, limits.shortestTrainPulse(depth)]));
  assert.deepEqual(shortest, { 1: 48, 4: 31, 8: 29, 32: 16 });
  // At the limit the model plays the whole train contiguously and on time.
  for (const [depth, dur] of Object.entries(shortest))
    assert.deepEqual(await limits.train(Number(depth), dur), { onTime: true, pulses: 60, contiguous: true });
});

test("the lead of 96 batches covers a posted link of at most 13 stages in this model", async () => {
  const r = await limits.deepestLink();
  assert.equal(r.deepest, 13);
  // One stage deeper, the slowest parameter (phase, lead 35) misses while the window still opens.
  assert.deepEqual(r.firstFault, { linkPipe: 14, reason: "pulse parameters did not land on the same batch" });
});

test("simultaneous shared bits pass the hub one per cycle in round-robin order", async () => {
  // PutHub.md: one arbiter for the board, and a publish reaches every board after 23 cycles.
  const alone = await limits.publishBurst(1);
  assert.deepEqual([alone.dispatched, alone.atEveryBoard, alone.waits], [[11], [23], 0]);
  const burst = await limits.publishBurst(8);
  assert.deepEqual(burst.faults, []);
  assert.deepEqual(burst.order, ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  assert.deepEqual(burst.atEveryBoard, [23, 24, 25, 26, 27, 28, 29, 30]);
  // Seven of the eight bits waited, the last for seven cycles, and all eight arrived.
  assert.deepEqual([burst.waits, burst.hub.maxWait, burst.hub.peakWaiting, burst.word], [7, 7, 7, 0xff]);
});

test("simultaneous barrier arrivals are counted two cycles apart and release every core with one time", async () => {
  // PutHub.md: a barrier put directly behind one for the same barrier waits one cycle.
  const pair = await limits.barrierFanIn(2);
  assert.deepEqual([pair.counted, pair.releasedAtHub, pair.atEveryCore, pair.sameTime], [[11, 13], 13, 25, true]);
  const eight = await limits.barrierFanIn(8);
  assert.deepEqual(eight.faults, []);
  assert.deepEqual(eight.counted, [11, 13, 15, 17, 19, 21, 23, 25]);
  assert.equal(eight.atEveryCore, 23 + 2 * 7);
  assert.ok(eight.sameTime);
});

test("four cores publishing back to back fill the hub and eight overflow its queues", async () => {
  // A core issues one publish every four cycles, so four cores offer one per cycle.
  const four = await limits.publishFlood(4, 40);
  assert.deepEqual([four.putIntervalBatches, four.dropped, four.served, four.maxWait], [4, 0, 160, 3]);
  const eight = await limits.publishFlood(8, 40);
  assert.ok(eight.dropped > 0 && eight.dropped === eight.faults);
  assert.equal(eight.served + eight.dropped, eight.issued);
  // A put waits behind at most the eight entries of each of the eight queues.
  assert.ok(eight.maxWait <= 64 && eight.peakWaiting <= 64);
});
