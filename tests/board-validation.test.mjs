import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  compareRtl,
  debugDesign,
  replayCapture,
} from "../validation/board/bench.mjs";
import { wireSample } from "../studio/wire-inspector.js";
import {
  calibrate,
  calibrationLengths,
  scopePrediction,
  trainingBurst,
} from "../validation/board/model.mjs";
import { runMachine, simulate } from "../server.mjs";
import { comparePathCapture } from "../studio/controller.js";
const data = JSON.parse(
  readFileSync(
    new URL("../validation/board/observations.json", import.meta.url),
  ),
);
const report = JSON.parse(
  readFileSync(new URL("../validation/board/results.json", import.meta.url)),
);

test("the same address, data and strobe levels appear at the exact registered RTL pin offsets", async () => {
  const comparison = await compareRtl(runMachine);
  assert.equal(comparison.transitions, 9);
  const doc = debugDesign("rtl-bus");
  const { trace } = await runMachine(doc);
  const issue = trace.frames.find((f) => f.outputs);
  const sourceWire = doc.design.wires.find((w) => w.id === "pin-address-bus");
  assert.equal(
    wireSample(
      {
        id: sourceWire.id,
        from: sourceWire.src.part,
        interconnect: sourceWire.interconnect,
        payloadBits: 7,
      },
      issue,
    ).value,
    21,
  );
  const destinations = trace.frames.filter(
    (f) => f.part === "buffer" && f.parents.includes(issue.id),
  );
  assert.ok(
    destinations.some((f) => f.wire === "pin-sample-bus") &&
      destinations.some((f) => f.wire === "pin-address-bus"),
  );
  assert.deepEqual(
    trace.frames
      .filter((f) => f.op === "latch DAC word")
      .map((f) => f.state.rx),
    [10922, -21846, 32767],
  );
});

test("calibration uses only the declared ramp, cable lengths/phase and burst size", () => {
  const changed = structuredClone(data);
  for (const c of changed.captures)
    if (c.id !== "free-1") c.outputMv.fill(-125);
  for (const c of changed.cables)
    if (c.phaseDeg || !calibrationLengths.includes(c.lengthMm))
      c.estimatesPs.fill(1);
  for (const g of changed.dma.groups)
    if (g.records !== trainingBurst) g.cycles.fill(1);
  assert.deepEqual(calibrate(changed), report.profile);
  assert.deepEqual(
    [
      report.holdout.voltageMv.count,
      report.holdout.oneWayPs.count,
      report.holdout.txMBps.count,
    ],
    [22500, 162, 555],
  );
});

test("scope and native-window replay agree through trigger edges, pauses, resume and chunk boundaries", async () => {
  const c = await replayCapture("gated-1", runMachine);
  const transitions = c.triggerMv.flatMap((v, i) =>
    i > 0 && v > 3000 !== c.triggerMv[i - 1] > 3000 ? [i] : [],
  );
  for (const row of new Set([
    0,
    660,
    999,
    1000,
    1999,
    2000,
    2499,
    ...transitions.slice(0, 4),
  ])) {
    const d = debugDesign(c.id, row);
    const { trace } = await runMachine(d);
    assert.equal(
      scopePrediction(c, trace, row, row + 1)[0],
      c.predictedMv[row],
    );
    const latches = trace.frames.filter((f) => f.op === "latch DAC word");
    assert.ok(latches.length);
    for (const f of latches) {
      const causes = f.parents.map((i) => trace.frames[i]);
      assert.ok(causes.some((g) => g.wire === "sample-bus"));
      assert.ok(causes.some((g) => g.wire === "address-bus"));
      assert.ok(
        causes.some((g) => g.part === "buffer" && g.emitted?.[0] === "strobe"),
      );
    }
  }
  assert.throws(() => debugDesign("free-1", 2500), /scope row/);
});

test("physical pin assignment, address selection and independent strobe control the converter", async () => {
  const d = debugDesign("free-1", 0);
  const w = (id) => d.design.wires.find((w) => w.id === id);
  const pin = (id, role, i = 0) =>
    w(id).interconnect.conductors.filter((c) => c.role === role)[i];
  assert.deepEqual(
    [
      pin("pin-sample-bus", "data").fromPin,
      pin("pin-sample-bus", "data").toPin,
      pin("sample-bus", "data").fromPin,
      pin("sample-bus", "data").toPin,
    ],
    ["R14", "U6.2", "U6.18", "J17.b25"],
  );
  assert.equal(pin("pin-ldac", "signal").fromPin, "B19");
  assert.equal(pin("ldac", "signal").toPin, "J17.b8");
  assert.equal(pin("address-bus", "data", 6).toPin, "J17.a5");
  const write = (tick, port, value) => ({
    at: { ps: tick * 20000, body: [{ write: { port, value } }] },
  });
  d.source.tracks[0].body = [
    write(0, "address", 1),
    write(1, "tx", 1234),
    write(5, "flag", 1),
    write(6, "flag", 0),
    write(7, "address", 128),
    write(12, "flag", 1),
    write(13, "flag", 1),
    write(14, "tx", -4000),
    write(18, "flag", 0),
  ];
  const { trace } = await runMachine(d);
  const latches = trace.frames.filter((f) => f.op === "latch DAC word");
  assert.equal(latches.length, 1);
  assert.equal(latches[0].state.rx, 1234);
  const state = trace.frames.findLast((f) => f.part === "dac").state;
  assert.equal(state.rx, -4000);
  assert.equal(state.value, latches[0].state.value);
  w("sample-bus").interconnect.strobeLink = "pin-ldac";
  await assert.rejects(runMachine(d), /physical strobe/);
});

test("DMA inspection can address any record without changing burst duration or serializing millions of frames", async () => {
  for (const [records, ordinal] of [
    [4, 4],
    [8, 5],
    [10000000, 9433917],
  ]) {
    const d = debugDesign("dma-" + records, ordinal);
    const { trace } = await runMachine(d);
    const start = trace.frames.find((f) => f.part === "fifo" && f.received);
    const selected = trace.frames.find(
      (f) => f.part === "fifo" && f.state.acc === ordinal,
    );
    const end = trace.frames.find(
      (f) => f.part === "fifo" && f.emitted?.[0] === "done",
    );
    assert.ok(trace.frames.length < 10 && selected.parents.includes(start.id));
    assert.equal(
      (selected.atPs - start.atPs) / 20000,
      Math.min(ordinal, 4) + Math.ceil(Math.max(0, ordinal - 4) * 1.75),
    );
    assert.equal(
      (end.atPs - start.atPs) / 20000,
      report.dma.find((g) => g.records === records).predictedCycles,
    );
    assert.ok(
      trace.frames.some(
        (f) => f.part === d.inspectionPart && f.parents.includes(selected.id),
      ),
    );
  }
  assert.throws(() => debugDesign("dma-8", 9), /record inside/);
});

test("common-trigger capture comparison detects digital errors, missing events, real time offsets and independently sampled voltage", async () => {
  const run = await simulate(
    readFileSync(
      new URL("../examples/waveform-controller.json", import.meta.url),
      "utf8",
    ),
  );
  const capture = {
    kind: "controller-path-capture",
    version: 1,
    board: "fixture",
    firmware: "reference",
    trigger: "start",
    connector: "DAC output",
    observations: {
      issue: [],
      bus: [],
      strobe: [],
      output: [{ atPs: 0, uv: 0 }],
    },
  };
  const obs = capture.observations;
  for (const f of run.frames) {
    const atPs = f.atNs * 1000;
    if (f.part === "controller" && f.sourcePc != null)
      obs.issue.push({ atPs, pc: f.sourcePc, op: f.op });
    if (f.op === "beat") {
      const words = f.state.fifo.filter((w) => w.producer === f.id);
      obs.bus.push({
        atPs,
        address: words[0].address,
        words: words.map((w) => w.pcm),
      });
    }
    if (f.op === "convert") {
      obs.strobe.push({ atPs: atPs + 250, code: f.state.dacCode });
      obs.output.push({ atPs: atPs + 900, uv: f.state.outputUv });
    }
  }
  const clean = comparePathCapture(run, capture);
  assert.equal(clean.output.rmsUv, 0);
  assert.equal(clean.channels.bus.mismatched, 0);
  assert.equal(clean.channels.strobe.maxOffsetPs, 250);
  obs.bus[1].words.reverse();
  obs.issue.pop();
  obs.output[1].uv += 100;
  const bad = comparePathCapture(run, capture);
  assert.equal(bad.channels.bus.firstDifference.row, 2);
  assert.ok(bad.channels.bus.firstDifference.eventId);
  assert.equal(bad.channels.issue.mismatched, 1);
  assert.equal(bad.output.peakUv, 100);
  obs.strobe[1].atPs = obs.strobe[0].atPs;
  assert.throws(() => comparePathCapture(run, capture), /increasing integer/);
});
