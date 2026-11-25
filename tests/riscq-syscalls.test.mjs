// System-call measurements taken from controller runs: transport latency per route, issue
// rate and burst cost of the control cores, and the feedback path of a measured bit.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../riscq/examples.mjs";
import { report, reservedRate, ionJourneys } from "../riscq/syscalls.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const integration = { skip: existsSync(resolve(process.env.QCCD_STUDIO_ROOT || join(root, "..", "QCCD"))) ? false : "QCCD Studio checkout not found" };

test("the reserved rate follows the virtual machine's rule", () => {
  // The paper's decoder example: 19,656 syndrome bits in 9.45 µs reserve 2,080 bits/µs.
  assert.equal(reservedRate(19656, 9450), 2080);
  assert.equal(reservedRate(1, 550), 2);
  assert.equal(reservedRate(2, 145050), 1);
});

test("superconducting feedback: a measured bit reaches another core 116 ns after its window closes", async () => {
  const r = report(await run({ example: "superconducting-feedforward", outcomes: { c: 1 } }));
  assert.equal(r.route.samples, 0);
  // Every instruction of this run commits on the cycle RISC-Q's RTL commits it
  // (validation/riscq/rtl/readout-rtl.mjs). The decoder (9 batches) and the result's path to a read
  // (11 at link depth 2) bring the result to the measuring core; its store, the hub and the link
  // back make it readable at every core 38 batches later. The conditioned pulse then waits for the
  // next barrier, the segment setup and its schedule lead.
  assert.deepEqual(r.feedback, [{ bit: "c", measure: "h19",
    resultAtCoreNs: 40, publishedAtHubNs: 94, atOtherCoresNs: 116, firstConditionedPulseNs: 514 }]);
  assert.equal(r.control.periodNs, 2);
  assert.equal(r.control.widestBurst, 2);
});

test("neutral atoms: one declared route latency overcharges the median rearrangement by 43%", async () => {
  const bundle = await run({ example: "neutral-bv14" });
  const r = report(bundle);
  assert.equal(r.route.samples, 26);
  assert.ok(r.route.allDelivered);
  // Pickup and drop take 15 µs each. The move time grows with distance.
  assert.deepEqual(r.route.latencyNs, { count: 26, min: 90450, median: 101170, p95: 140410, max: 145050 });
  assert.deepEqual(r.route.declared.latencyNs, 145050);
  assert.equal(r.route.declared.reservedQubitsPerUs, 1);
  assert.ok(Math.abs(r.route.declared.overchargeOfMedianRoute - 1.4337) < 1e-4);
  // 189 pulses and 1505 carrier updates, issued by table loops at no more than 30 puts/µs per core.
  assert.equal(r.control.timedWrites, 1948);
  assert.ok(r.control.cores.every((c) => c.peakPutsPerUs <= 30 && c.minGapNs >= 20));
  assert.deepEqual(r.control.prerollNs, [0]);
});

test("QCCD: a 24-channel transport cycle delays its segment by the time the cores need to issue it", integration, async () => {
  const bundle = await run({ example: "qccd-rotation" });
  const r = report(bundle);
  assert.equal(r.route.samples, 4);
  assert.ok(r.route.allDelivered);
  assert.equal(r.route.latencyNs.max, 5000);
  assert.equal(r.control.widestBurst, 24);
  // Three cores each issue eight simultaneous waveforms. At 63 core cycles per timed write
  // (riscq/firmware.mjs TABLE_COST) the burst costs 4.53 µs of preroll.
  assert.deepEqual(r.control.prerollNs, [4530]);
  // Each ion makes one journey of four hops, 20 µs in all.
  assert.deepEqual(ionJourneys(bundle).map((j) => [j.ion, j.from, j.to, j.hops, j.latencyNs]),
    [["ion-a", "S0", "S2", 4, 20000], ["ion-b", "S4", "S6", 4, 20000]]);
});
