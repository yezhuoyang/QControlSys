import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { simulate } from "../server.mjs";
import { compareCapture, sampleRows } from "../studio/controller.js";

const reference = JSON.parse(
  await readFile(
    new URL("../examples/waveform-controller.json", import.meta.url),
  ),
);
const execute = (changes) =>
  simulate(JSON.stringify({ ...reference, ...changes }));
const verify = (trace) => simulate(JSON.stringify(trace), { checkTrace: true });
const last = (r) => r.frames.at(-1).state;
const dma = (address, count) => ({ dma: { address, count } });
const wait = (ticks) => ({ wait: { ticks } });
const play = (count) => ({ play: { count } });

test("32-bit stream meets every strobe and every converted sample points to its RAM beat", async () => {
  const r = await execute({});
  assert.deepEqual(r.summary, {
    elapsedNs: 96,
    payloadBytes: 32,
    acceptedBeats: 8,
    busSlots: 12,
    samples: 16,
    underruns: 0,
    stop: "halted",
  });
  const samples = sampleRows(r);
  const parts = new Set(
    [...r.system.parts, ...r.system.links].map((p) => p.id),
  );
  const seen = new Set();
  let time = 0;
  for (const f of r.frames) {
    assert.ok(f.atNs >= time && !seen.has(f.id));
    assert.ok(f.parents.every((id) => seen.has(id)));
    assert.ok([f.part, ...f.targets].every((id) => parts.has(id)));
    assert.ok(f.state.fifo.length <= reference.fifoWords);
    seen.add(f.id);
    time = f.atNs;
  }
  for (const [i, f] of samples.entries()) {
    assert.equal(f.atNs, 32 + 4 * i);
    assert.equal(f.state.lastAddress, i);
    assert.equal(f.state.pcm, reference.memory[i]);
    assert.equal(f.sourcePc, 5);
    const producer = r.frames.find(
      (b) =>
        b.op === "beat" &&
        b.state.fifo.some((w) => w.address === i && w.producer === b.id),
    );
    assert.ok(
      producer && producer.atNs < f.atNs && f.parents.includes(producer.id),
    );
    assert.equal(producer.sourcePc, 1);
  }
  assert.deepEqual(
    samples.slice(0, 3).map((f) => f.state.outputUv),
    [0, 23437, 101562],
  );
  assert.equal((await verify(r)).verified, true);
  const noLayout = { ...r };
  delete noLayout.system;
  await assert.rejects(verify(noLayout));
  samples[1].state.outputUv++;
  await assert.rejects(verify(r), /dac-9/);
});

test("bus width and arbitration cause distinct, reproducible missed deadlines", async () => {
  for (const [patch, deadlines] of [
    [{ busBits: 16 }, [56, 64, 72, 80, 88]],
    [{ grantPattern: [true, false] }, [48, 60, 64, 76, 80, 92]],
  ]) {
    const r = await execute(patch);
    assert.deepEqual(
      r.frames.filter((f) => f.op === "underrun").map((f) => f.atNs),
      deadlines,
    );
    assert.equal(r.summary.underruns, deadlines.length);
    assert.equal(r.summary.elapsedNs, 132);
    assert.equal(r.summary.payloadBytes, 32);
    assert.equal(last(r).fifo.length, deadlines.length);
    assert.equal(last(r).denied > 0, !!patch.grantPattern);
    for (const f of sampleRows(r).filter((f) => f.op === "underrun")) {
      assert.equal(f.state.pcm, 0);
      assert.equal(f.state.lastAddress, null);
    }
  }
});

test("a strobe coinciding with the first arriving beat observes an empty FIFO", async () => {
  const r = await execute({ code: [dma(0, 2), play(2), "halt"] });
  assert.deepEqual(
    r.frames.filter((f) => f.atNs === 8).map((f) => f.op),
    ["underrun", "beat"],
  );
  assert.equal(sampleRows(r)[1].state.lastAddress, 0);
});

test("a full FIFO retries atomically and the last partial beat transfers only real words", async () => {
  const r = await execute({
    fifoWords: 2,
    code: [dma(0, 3), wait(4), play(3), "halt"],
  });
  assert.ok(last(r).backpressure > 0);
  const stall = r.frames.find((f) => f.op === "backpressure");
  assert.equal(stall.state.dmaAddress, 2);
  assert.deepEqual(
    stall.state.fifo.map((w) => w.address),
    [0, 1],
  );
  assert.equal(r.summary.acceptedBeats, 2);
  assert.equal(r.summary.payloadBytes, 6);
  assert.deepEqual(
    sampleRows(r).map((f) => f.state.lastAddress),
    [0, 1, 2],
  );
});

test("the sequencer executes branches, a wrapping accumulator, loops, and busy DMA", async () => {
  const alternate = await execute({ inputWord: 1 });
  assert.deepEqual(
    sampleRows(alternate).map((f) => f.state.pcm),
    reference.memory.slice(16),
  );
  assert.ok(sampleRows(alternate).some((f) => f.state.outputUv < 0));
  const loop = await execute({
    code: [
      { load: { value: -1 } },
      { add: { value: 3 } },
      { add: { value: -1 } },
      { jnz: { target: 2 } },
      "halt",
    ],
  });
  const cpu = loop.frames.filter((f) => f.sourcePc !== null);
  assert.deepEqual(
    cpu.map((f) => f.sourcePc),
    [0, 1, 2, 3, 2, 3, 4],
  );
  assert.deepEqual(
    cpu.map((f) => f.state.acc),
    [65535, 2, 1, 1, 0, 0, 0],
  );
  const chained = await execute({
    code: [dma(0, 4), dma(4, 1), wait(2), play(5), "halt"],
  });
  assert.ok(chained.frames.some((f) => f.op === "dmaBusy" && f.sourcePc === 1));
  assert.deepEqual(
    sampleRows(chained).map((f) => f.state.lastAddress),
    [0, 1, 2, 3, 4],
  );
});

test("signed DAC clips independently at each rail and applies FIR history and sample divider", async () => {
  const r = await execute({
    code: [dma(0, 4), wait(4), play(4), "halt"],
    sampleEvery: 2,
    memory: [32767, -32768, 0, 0],
    gainPermille: 2000,
    firQ15: [16384, 16384],
  });
  const samples = sampleRows(r);
  assert.deepEqual(
    samples.map((f) => f.atNs),
    [32, 40, 48, 56],
  );
  assert.deepEqual(
    samples.map((f) => f.state.dacCode),
    [2047, -2048, 0, 0],
  );
  assert.deepEqual(
    samples.map((f) => f.state.idealUv),
    [999511, -1000000, 0, 0],
  );
  assert.deepEqual(
    samples.map((f) => f.state.outputUv),
    [499755, -244, -500000, 0],
  );
  assert.equal(last(r).clipped, 2);
});

test("watchdog and invalid fetch stay inspectable and invalid design parameters are rejected", async () => {
  const starved = await execute({
    grantPattern: [false],
    maxCycles: 5,
    code: [dma(0, 2), "halt"],
  });
  assert.equal(starved.summary.stop, "cycle limit");
  assert.equal(last(starved).dmaLeft, 2);
  assert.equal(last(starved).denied, 2);
  const fault = await execute({ code: [wait(0)] });
  assert.equal(fault.frames.at(-2).op, "fault");
  assert.equal(fault.summary.stop, "PC outside instruction RAM");
  for (const patch of [
    { busBits: 24 },
    { grantPattern: [] },
    { fifoWords: 1 },
    { firQ15: [70000] },
    { code: [{ jump: { target: 1 } }] },
    { code: [dma(32, 1)] },
    { memory: [-32769] },
    { maxCycles: 257 },
    { unknownField: 1 },
  ])
    await assert.rejects(execute(patch));
});

test("capture comparison preserves signed voltage and measured timing error", async () => {
  const r = await execute({});
  const samples = sampleRows(r);
  const capture = (dt, dv) =>
    "timeNs,outputUv\n" +
    samples
      .map((f, i) =>
        [f.atNs + dt, f.state.outputUv + (i % 2 ? dv : -dv)].join(","),
      )
      .join("\n");
  assert.deepEqual(compareCapture(r, capture(0, 0)), {
    samples: 16,
    rmsUv: 0,
    maxUv: 0,
    maxNs: 0,
  });
  const shifted = compareCapture(r, capture(2, 5));
  assert.ok(Math.abs(shifted.rmsUv - 5) < 1e-12);
  assert.equal(shifted.maxUv, 5);
  assert.equal(shifted.maxNs, 2);
  for (const bad of [
    "timeNs,outputUv\n0,0",
    capture(0, 0).replace("32,0", "36,0"),
    capture(0, 0).replace("32,0", "32,Infinity"),
    capture(0, 0).replace("outputUv", "timeNs"),
  ]) {
    assert.throws(() => compareCapture(r, bad));
  }
});
