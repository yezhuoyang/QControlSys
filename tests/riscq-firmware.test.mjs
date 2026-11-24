// Conformance: unmodified RISC-Q firmware binaries run on the Lean model and produce the
// outcomes that RISC-Q's own RTL simulations assert (PulseTableSocCpuSim, XcoreCpuSim,
// HostWindowCpuSim). The binaries are vendored from RISC-Q at commit 243d814.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadElf } from "../riscq/rv32.mjs";
import { socSpec, program, execute } from "../riscq/soc.mjs";

const fixture = (name) => readFile(new URL("../validation/riscq/" + name, import.meta.url));
const elf = async (name) => loadElf(new Uint8Array(await fixture("firmware/" + name)));
// The RISC-Q CPU-in-the-loop simulations map core 0 to DAC 8 and core 1 to DAC 1.
const twoQubits = async () =>
  socSpec({ ...JSON.parse(await fixture("sim-2q.json")), dac_map: [[8, 8], [1, 1]] });
const parked = { words: [0x0000006f], sourceMap: [] };
/** Place a testbench parameter in the last word of a core's RAM. */
function withParameter(words, index, value) {
  const image = words.slice();
  while (image.length <= index) image.push(0);
  image[index] = value;
  return { words: image, sourceMap: [] };
}

/** Every frame has a unique ID, known parents that precede it, and a nondecreasing time. */
function checkCausality(run) {
  const seen = new Set();
  const parts = new Set(run.system.parts.map((p) => p.id));
  let time = 0;
  for (const f of run.frames) {
    assert.ok(!seen.has(f.id), "duplicate frame " + f.id);
    assert.ok(f.atBatch >= time, "time went backwards at " + f.id);
    assert.equal(f.atPs, f.atBatch * run.program.dspPeriodPs);
    for (const parent of f.parents) assert.ok(seen.has(parent), f.id + " names unknown parent " + parent);
    assert.ok(parts.has(f.part), f.id + " acts on unknown part " + f.part);
    for (const target of f.targets) assert.ok(parts.has(target), f.id + " targets unknown part " + target);
    seen.add(f.id);
    time = f.atBatch;
  }
}

test("pulse_sched.elf schedules one gate pulse that opens exactly at its start time", async () => {
  const spec = await twoQubits();
  const run = await execute(program(spec, [{ words: await elf("pulse_sched.elf"), sourceMap: [] }, parked], { trace: "full" }));
  checkCausality(run);
  assert.equal(run.summary.status, "quiescent");
  assert.deepEqual(run.summary.faults, []);
  // The firmware reads the batch time and schedules 1024 batches ahead.
  const read = run.frames.find((f) => f.op === "read" && f.state.register === "time");
  const startTime = read.state.value + 1024;
  assert.equal(run.summary.pulses.length, 1);
  const pulse = run.summary.pulses[0];
  // Parameters of sw/pulse_sched.S: freq 1800, phase 2000, amp 9000, envelope 10, 6 batches.
  assert.deepEqual(
    { converter: pulse.converter, startTime: pulse.startTime, opens: pulse.opens, closes: pulse.closes,
      freq: pulse.freq, phase: pulse.phase, amp: pulse.amp, env: pulse.env, dur: pulse.dur },
    { converter: "dac8", startTime, opens: startTime, closes: startTime + 6,
      freq: 1800, phase: 2000, amp: 9000, env: 10, dur: 6 });
  assert.ok(pulse.aligned && pulse.onTime && !pulse.overlap);
  // Two channels share DAC 8, so the adder tree and edge stages add four cycles (map.py dac_pipe).
  assert.equal(pulse.atConverter, pulse.opens + 4);
  // The fire advanced the buffer's start time by the fired duration.
  assert.equal(run.summary.cores[0].channels[0].buffer.startTime, startTime + 6);
  // The pulse frame descends from the firmware's fire instruction through the link.
  const byId = new Map(run.frames.map((f) => [f.id, f]));
  const pulseFrame = run.frames.find((f) => f.op === "pulse");
  const fire = byId.get(pulseFrame.parents[0]);
  assert.equal(fire.op, "fire");
  const store = byId.get(fire.parents[0]);
  assert.equal(store.op, "put");
  assert.equal(store.state.text, "sw x0, 0(x6)");
  assert.equal(fire.atBatch - store.atBatch, 1 + spec.linkPipe);
  assert.equal(run.summary.cores[0].stopped, "parked in a self jump");
});

test("pulse timing does not depend on the link depth while the lead margin holds", async () => {
  const spec = await twoQubits();
  const words = await elf("pulse_sched.elf");
  const opens = [];
  for (const linkPipe of [0, 4, 32]) {
    const deep = { ...spec, linkPipe };
    const run = await execute(program(deep, [{ words, sourceMap: [] }, parked]));
    const [pulse] = run.summary.pulses;
    assert.ok(pulse.aligned && pulse.onTime);
    // The firmware reads a core-local time that lags by the link, so the absolute cycle moves
    // with it. The batch-time register at which the pulse opens is exactly the scheduled one.
    assert.equal(pulse.opens, pulse.startTime);
    const read = run.frames.find((f) => f.state.register === "time").state.value;
    opens.push((pulse.opens - read + 2 ** 32) % 2 ** 32);
  }
  assert.deepEqual(opens, [1024, 1024, 1024]);
});

test("xcore.elf: two cores publish, signal, rendezvous and schedule from one barrier time", async () => {
  const spec = await twoQubits();
  const words = await elf("xcore.elf");
  const run = await execute(program(spec,
    [withParameter(words, 4095, 0), withParameter(words, 4095, 1)], { trace: "io" }));
  checkCausality(run);
  assert.equal(run.summary.status, "quiescent");
  assert.deepEqual(run.summary.faults, []);
  const [q0, q1] = run.summary.cores;
  // a0 holds t0 + 1024 on both cores, so both read the same barrier time.
  assert.equal(q0.regs[10], q1.regs[10]);
  const release = run.frames.find((f) => f.op === "release");
  const t0 = release.state.t0;
  assert.equal(q0.regs[10], t0 + 1024);
  // Core 1's mailbox carried 0x77 and the read consumed it.
  assert.equal(q1.regs[12], 0x77);
  const mail = run.frames.find((f) => f.op === "mail");
  assert.deepEqual([mail.part, mail.state.word], ["q1.inbox", 0x77]);
  // Core 1 sees core 0's published bit and fires. Core 0 sees a zero and stays silent.
  assert.deepEqual([q0.regs[11], q1.regs[11]], [0, 1]);
  assert.equal(run.summary.pulses.length, 1);
  const [pulse] = run.summary.pulses;
  assert.deepEqual([pulse.converter, pulse.opens, pulse.dur], ["dac1", t0 + 1024, 6]);
  assert.equal(run.summary.hub.countMismatch, false);
  // PutHub.md: a publish reaches every core's board 23 cycles after the store.
  const publish = run.frames.find((f) => f.op === "put" && f.state.node === 16);
  const board = run.frames.find((f) => f.op === "board");
  assert.equal(board.atBatch - publish.atBatch, 23);
  // RISC-Q reports about 46 cycles from reset release to the scheduled barrier (XcoreCpuSim).
  const resumed = run.frames.find((f) => f.op === "resume" && f.state.register === "release");
  assert.ok(resumed.atBatch >= 36 && resumed.atBatch <= 56, "barrier released at " + resumed.atBatch);
});

test("host_window.elf writes its ramp, byte lanes and sentinel, then reports completion", async () => {
  const spec = await twoQubits();
  const words = await elf("host_window.elf");
  const run = await execute(program(spec,
    [withParameter(words, 1023, 0), withParameter(words, 1023, 1 << 16)], { trace: "io", maxEvents: 20000 }));
  checkCausality(run);
  assert.deepEqual(run.summary.faults, []);
  assert.deepEqual(run.summary.cores.map((c) => [c.done, c.stopped]), [[true, "done"], [true, "done"]]);
  for (const core of [0, 1]) {
    const writes = run.summary.host.filter((h) => h.core === core);
    const ramp = writes.slice(0, 1024);
    assert.ok(ramp.every((h, i) => h.offset === 4 * i && h.value === ((core << 16) | i) && h.bytes === 4));
    assert.deepEqual(writes.slice(1024).map((h) => [h.offset, h.bytes, h.value]),
      [[0x1001, 1, 0xa5], [0x1006, 2, 0x1234], [0x2000, 4, 0xda7a]]);
  }
});

test("an exported trace re-executes to the same frames and a tampered one is located", async () => {
  const spec = await twoQubits();
  const run = await execute(program(spec, [{ words: await elf("pulse_sched.elf"), sourceMap: [] }, parked], { trace: "full" }));
  assert.deepEqual(await execute(run, { checkTrace: true }), { verified: true, events: run.frames.length });
  const tampered = structuredClone(run);
  const index = tampered.frames.findIndex((f) => f.op === "pulse");
  tampered.frames[index].state.opens += 1;
  await assert.rejects(execute(tampered, { checkTrace: true }), new RegExp("Trace mismatch at step " + (index + 1)));
});
