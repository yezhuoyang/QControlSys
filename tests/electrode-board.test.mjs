import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runMachine } from "../server.mjs";
import { electrodeDesign } from "../validation/board/peaks.mjs";
import { debugDesign, replayCapture } from "../validation/board/bench.mjs";
import { deadlineCounts } from "../validation/board/deadlines.mjs";

const results = JSON.parse(
  readFileSync(new URL("../validation/board/results.json", import.meta.url)),
);
// Independent pin stimulus, including frames the normal compiler would never emit.
function rawFrame(ps, word, count) {
  const pins = [["csN", 0]];
  const bits = word
    .toString(2)
    .padStart(24, "0")
    .padEnd(count, "0")
    .slice(0, count);
  for (const bit of bits)
    pins.push(["sclk", 1], ["sdi", Number(bit)], ["sclk", 0]);
  pins.push(["csN", 1]);
  return pins.map(([port, value], i) => ({
    at: { ps: ps + 20000 * i, body: [{ write: { port, value } }] },
  }));
}
test("DAC81416 samples 24 falling edges, ignores short/read/other frames and keeps the first 24 bits", async () => {
  const doc = electrodeDesign("rising");
  const frames = [
    [0x10a55a, 23],
    [0x90a55a, 24],
    [0x11a55a, 24],
    [0x50a55a, 26],
    [0x100000, 24],
    [0x10ffff, 24],
  ];
  doc.source.tracks[0].body = frames.flatMap(([word, n], i) =>
    rawFrame(i * 3000000, word, n),
  );
  const { trace } = await runMachine(doc);
  assert.equal(trace.stop, "completed");
  const commits = trace.frames.filter((f) => f.op === "commit SPI DAC word");
  assert.deepEqual(
    commits.map((f) => f.state.spi.shift),
    [0x50a55a, 0x100000, 0x10ffff],
  );
  assert.deepEqual(
    commits.map((f) => f.state.rx),
    [Math.floor((0xa55a * 20000000) / 65536) - 10000000, -10000000, 9999694],
  );
  assert.equal(
    trace.frames.filter((f) => f.op === "ignore SPI frame").length,
    3,
  );
  const shifted = trace.frames.filter((f) => f.op === "shift SDI bit");
  assert.equal(shifted.length, 23 + 24 * 5);
  for (const f of shifted) {
    assert.deepEqual(f.received, ["sclk", 0]);
    assert.ok(f.parents.some((p) => trace.frames[p].wire === "spi-sdi"));
  }
  const stages = trace.frames.filter(
    (f) => f.op === "slew DAC output" || f.op === "advance RC output",
  );
  assert.ok(stages.length && stages.every((f) => f.atPs % 100000 === 0));
  for (const f of stages) {
    const input = trace.frames[f.state.rxEvent];
    assert.ok(f.parents.includes(input.id));
    assert.equal(f.source, input.source);
    const previous = trace.frames
      .slice(0, f.id)
      .findLast((g) => g.part === f.part).state.value;
    const target = f.state.rx,
      value = f.state.value;
    assert.ok(
      Math.min(previous, target) <= value &&
        value <= Math.max(previous, target),
    );
    if (f.part === "dac") assert.ok(Math.abs(value - previous) <= 400000);
  }
  assert.equal(
    trace.frames.findLast((f) => f.part === "output").received[1],
    9999694,
  );
});

test("a Figure 8 column opens exactly its traced probe voltage across calibration, transitions and plateaus", async () => {
  for (const direction of ["rising", "falling"]) {
    const id = "peaks-" + direction,
      capture = await replayCapture(id, runMachine);
    const { trace } = await runMachine(debugDesign(id, 385));
    for (const i of [0, 300, 385, 422, 771]) {
      const doc = debugDesign(id, i);
      const f = trace.frames.findLast(
        (f) => f.part === "output" && f.atPs <= doc.inspectionPs,
      );
      assert.equal(f.received[1] / 1000, capture.predictedMv[i]);
      assert.ok(
        capture.lowMv[i] <= capture.outputMv[i] &&
          capture.outputMv[i] <= capture.highMv[i],
      );
    }
    assert.throws(() => debugDesign(id, 772), /column/);
    const shifted = trace.frames.filter((f) => f.op === "shift SDI bit");
    assert.equal(shifted.length, 48);
    for (const f of trace.frames)
      assert.ok(f.parents.every((p) => Number.isInteger(p) && p < f.id));
  }
  const h = results.electrode.edges.find((e) => e.direction === "falling");
  assert.equal(h.split, "holdout");
  assert.ok(h.measured.widthUs > 9.6 && h.measured.widthUs < 9.9);
  assert.ok(Math.abs(h.replay.widthUs - h.measured.widthUs) < 0.25);
  assert.ok(h.measured.midToBandUs > h.replay.midToBandUs);
});

test("a parameterized electrode command compiles a mixed-bit code and checks the 16-bit operand", async () => {
  const doc = electrodeDesign("falling");
  const params = doc.source.tracks[0].body[1].at.body[0].call.params;
  params[0] = 0x963a;
  const { trace } = await runMachine(doc);
  const commit = trace.frames.findLast(f => f.op === "commit SPI DAC word");
  assert.equal(commit.state.spi.shift, 0x10963a);
  const pins = trace.frames.filter(f => f.op === "shift SDI bit").slice(-24);
  assert.equal(pins.map(f => f.state.spi.dataBit).join(""), "000100001001011000111010");
  params[0] = 12.5;
  await assert.rejects(runMachine(doc), /integer/);
  params[0] = 65536;
  await assert.rejects(runMachine(doc), /missing calibration/);
});

test("FIFO completion deadlines use each hardware counter and count equality as on time", () => {
  const burst = results.dma.find((x) => x.records === 8388608);
  assert.deepEqual(deadlineCounts(burst, burst.predictedCycles), {
    missed: 2,
    count: 25,
    replayMet: true,
    latestCycles: 14992566,
    largestLateCycles: 312505,
  });
  assert.equal(deadlineCounts(burst, 14992566).missed, 0);
  assert.equal(deadlineCounts(burst, 0).missed, 25);
  assert.equal(deadlineCounts(burst, 0).replayMet, false);
  for (const x of [-1, 0.5, NaN, Infinity, 2 ** 53])
    assert.throws(() => deadlineCounts(burst, x));
});
