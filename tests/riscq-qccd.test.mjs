// QCCD Studio cycles → RISC-Q firmware → Lean execution. These tests need Python and the QCCD
// Studio checkout, like the Studio bridge tests.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "../riscq/soc.mjs";
import { assemble, measuredBits } from "../riscq/compile.mjs";
import * as qccd from "../riscq/platforms/qccd.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = resolve(process.env.QCCD_STUDIO_ROOT || join(root, "..", "QCCD"));
const integration = { skip: existsSync(upstream) ? false : "QCCD Studio checkout not found" };

async function run(replay, machineOptions = {}, outcomes = {}) {
  const m = qccd.machine(replay, machineOptions);
  const hardware = qccd.schedule(m);
  const lowered = qccd.lower(hardware, m);
  const built = assemble(m.spec, lowered, {
    bindings: lowered.bindings, responses: qccd.photonResponses(lowered, m, outcomes),
    maxEvents: 400000, maxSteps: 20000000 });
  return { m, hardware, lowered, built, result: await execute(built.document) };
}

test("a Studio loop rotation plays every engaged electrode channel on the same batch", integration, async () => {
  const design = readFileSync(join(root, "bridge", "fixtures", "three-hop.studio.json"), "utf8");
  const replay = await qccd.studioReplay({ architecture: design });
  const { m, hardware, built, result } = await run(replay);
  assert.equal(result.summary.status, "quiescent");
  assert.deepEqual(result.summary.faults, []);
  // Studio reports model µs, so one hop of 5 µs is 500 batches of 10 ns.
  assert.equal(m.scaleNs, 1000);
  const timeline = qccd.ionTimeline(result, hardware);
  assert.equal(timeline.length, 4);
  assert.ok(timeline.every((step) => step.delivered && step.closes - step.opens === 500));
  // Consecutive hops are contiguous, and the ions end where Studio says they do.
  assert.equal(timeline[1].opens, timeline[0].closes);
  const position = new Map();
  for (const step of timeline) for (const move of step.moves) position.set(move.ion, move.to);
  assert.deepEqual(Object.fromEntries(position), replay.final.positions);
  // Each cycle engages 24 control channels. The core issues them one at a time, so the
  // compiler delays the segment until the last of the burst can still leave on time.
  const first = hardware.segments[0].ops[0];
  const engaged = first.banks.reduce((n, bank) => n + bank.channels.length, 0);
  assert.equal(engaged, 24);
  const pulses = result.summary.pulses.filter((p) => p.source === first.id);
  assert.equal(pulses.length, engaged);
  assert.equal(new Set(pulses.map((p) => p.opens)).size, 1);
  assert.equal(new Set(pulses.map((p) => p.converter)).size, engaged);
  const preroll = built.plans.find((plan) => plan.segments.length).segments[0].preroll;
  assert.ok(preroll > 0 && preroll % 1 === 0);
  // Every waveform is attributed to its Studio cycle through the table entry that issued it.
  const cycles = new Set(hardware.segments[0].ops.map((op) => op.id));
  assert.ok(result.summary.pulses.every((p) => cycles.has(p.source)));
});

test("the H2 GHZ program runs on eight cores with every waveform, gate and measurement on time", integration, async () => {
  const pair = await qccd.studioReplay(null, ["--demo"]);
  const replay = await qccd.studioReplay(pair);
  assert.equal(replay.frames.length, 947);
  const m0 = qccd.machine(replay);
  const measured = qccd.lower(qccd.schedule(m0), m0).measures.flatMap((x) => x.ions);
  const outcomes = Object.fromEntries(measured.map((x, i) => [x.bit, i % 3 === 0 ? 1 : 0]));
  const { m, hardware, lowered, built, result } = await run(replay, {}, outcomes);
  assert.equal(result.summary.status, "quiescent");
  assert.deepEqual(result.summary.faults, []);
  assert.deepEqual(m.spec.cores.map((c) => c.name),
    ["tr0", "tr1", "tr2", "zone.DG01", "zone.DG02", "zone.DG03", "zone.DG04", "light"]);
  assert.ok(result.summary.cores.every((c) => c.done));
  // Every Studio transport cycle was delivered, and the gates fired with their angles.
  const timeline = qccd.ionTimeline(result, hardware);
  assert.equal(timeline.length, 890);
  assert.ok(timeline.every((step) => step.delivered));
  const ops = hardware.segments[0].ops;
  assert.equal(ops.filter((op) => op.op === "ms").length, 9);
  const pulses = result.summary.pulses;
  assert.ok(pulses.every((p) => p.onTime && p.aligned !== false));
  // A batched MS cycle drives one modulator pulse per gate zone: 31 pairs in all.
  assert.equal(pulses.filter((p) => p.part.endsWith(".ms")).length, replay.summary.gatePairs);
  assert.equal(replay.summary.gatePairs, 31);
  // Studio gives unit times here, so every cycle takes the standard duration of its kind
  // (Pino et al. 2021): 63.8 µs per shuttle unit, 5 µs rotations, 25 µs gates, 120 µs detection.
  assert.equal(m.scaleNs, undefined);
  const durations = (kind) => [...new Set(ops.filter((x) => x.op === kind).map((x) => x.dur / 1e6))].sort((a, b) => a - b);
  assert.deepEqual(durations("transport"), [63.8, 127.6]);
  assert.deepEqual([durations("rotate"), durations("ms"), durations("measure"), durations("cool")], [[5], [25], [120], [550]]);
  // Cycles follow one another, and every pulse opens at its cycle's start from one barrier time base.
  assert.ok(ops.every((op, i) => i === 0 || op.t === ops[i - 1].t + ops[i - 1].dur));
  const origin = pulses[0].opens - (ops[0].t / m.period);
  for (const op of ops.filter((x) => x.op !== "frame").slice(0, 200)) {
    const mine = pulses.filter((p) => p.source === op.id);
    assert.ok(mine.length > 0, op.id);
    assert.ok(mine.every((p) => p.opens === origin + op.t / m.period), op.id);
  }
  // All 32 measurements counted photons and reported the supplied outcomes to the host.
  assert.equal(lowered.measures.flatMap((x) => x.ions).length, 32);
  assert.deepEqual(measuredBits(result, built), outcomes);
  // A bright ion yields ten photons, each a rising and a falling edge on the counter line.
  const edges = result.frames.filter((f) => f.op === "edge");
  const bright = Object.values(outcomes).filter(Boolean).length;
  assert.equal(edges.length, bright * 2 * qccd.BRIGHT_PHOTONS);
  // The transport cores' programs fit the 64 KiB RAM only because the channels are split over three
  // cores. With sixteen channels on one core, tr0's does not, even folded: its transport schedule has no
  // repeating rounds to fold (riscq/firmware.mjs foldRuns), so the assembler still refuses it.
  const m16 = qccd.machine(replay, { channelsPerCore: 16 });
  assert.throws(() => assemble(m16.spec, qccd.lower(qccd.schedule(m16), m16), {}),
    /Core tr0: the program needs \d+ words and the RAM has 16064/);
});

test("an OpenQASM GHZ circuit compiles through QCCD Studio and reads three ions, two of them in one zone", integration, async () => {
  const { run: runExample } = await import("../riscq/examples.mjs");
  const bundle = await runExample({ example: "qccd-ghz3", outcomes: { q0: 1, q2: 1 } });
  assert.equal(bundle.summary.status, "quiescent");
  assert.deepEqual(bundle.summary.faults, []);
  assert.match(bundle.source.compiler, /^QCCD Studio revision [0-9a-f]{40}$/);
  const ops = bundle.hardware.segments[0].ops;
  // The compiler brings each pair together for a Mølmer–Sørensen gate.
  assert.equal(ops.filter((op) => op.op === "ms").length, 2);
  assert.ok(bundle.derived.ionMoves.length > 0 && bundle.derived.ionMoves.every((move) => move.delivered));
  // The last cycle measures two ions that share a gate zone: one detection pulse, two counter lines.
  const last = ops.at(-1);
  assert.equal(last.op, "measure");
  assert.equal(new Set(Object.values(last.at)).size, 1);
  assert.equal(bundle.summary.pulses.filter((p) => p.source === last.id).length, 1);
  assert.deepEqual(Object.entries(bundle.derived.bits).map(([bit, value]) => [bit.split("@")[0], value]).sort(),
    [["q0", 1], ["q1", 0], ["q2", 1]]);
});
