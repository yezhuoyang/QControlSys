// Two boards joined by RISC-Q's PutLane, in the Lean model, against what RISC-Q's RTL shows for the same
// network (validation/riscq/rtl/QosLaneTiming.scala, docs/control-fidelity-audit.md S9): a crossing from
// a hub's input to the far hub's output takes 325 to 332 dspClk cycles at L = 3, depending on the lane's
// word-clock phase; frames on one lane are 160 cycles apart; a barrier that spans both boards releases on
// the far board one crossing after the root.
import test from "node:test";
import assert from "node:assert/strict";
import { socSpec, program, execute } from "../riscq/soc.mjs";
import { Firmware } from "../riscq/firmware.mjs";

function build(boards) {
  return socSpec({
    name: "two-boards", dsp_freq_hz: 5e8, link_pipe: 4,
    core_defaults: { mem_depth: 4096, with_mul: true, queue_depth: 4 },
    cores: boards.flatMap((n, b) => Array.from({ length: n }, (_, i) => ({ name: "b" + b + "c" + i, board: b, channels: [
      { name: "ch", kind: "pulse", dac: i, slots: 1, env_depth: 16, interp: 4 },
      { name: "demod", kind: "demod", adc: i, slots: 1, env_depth: 16, interp: 4 }] }))),
  });
}
async function run(spec, write, options = {}) {
  const images = spec.cores.map((_, i) => {
    const fw = new Firmware(spec, i);
    fw.begin();
    write(fw, i);
    fw.done();
    const image = fw.asm.assemble();
    return { words: image.words, sourceMap: image.sourceMap };
  });
  return execute(program(spec, images, { trace: "io", ...options }));
}
// Hub frames by board: input (`wait`) and dispatch, per put.
const hubFrames = (r, op) => r.frames.filter((f) => f.part === "hub" && f.op === op);

test("a publish crosses to the other board in 325 to 332 cycles, as on RISC-Q's RTL", async () => {
  for (const phase of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const spec = build([2, 2]);
    const r = await run(spec, (fw, i) => {
      if (i === 2) { fw.asm.li("a1", 1); fw.publish(0, 3, "a1"); }
    }, { model: { lanePhase: phase } });
    assert.deepEqual(r.summary.faults, []);
    const input = hubFrames(r, "wait").find((f) => f.state.board === 1);
    const remote = hubFrames(r, "publish").find((f) => f.state.board === 0);
    // The far hub's output is the cycle after its dispatch.
    const crossing = remote.atBatch + 1 - input.atBatch;
    assert.ok(crossing >= 325 && crossing <= 332, "phase " + phase + ": " + crossing);
    // Both boards hold the bit.
    assert.equal(r.summary.hub.perBoard[0].groups[0], 1 << 3);
    assert.equal(r.summary.hub.perBoard[1].groups[0], 1 << 3);
  }
});

test("frames on one lane are one frame time, 160 cycles, apart", async () => {
  const spec = build([1, 3]);
  const r = await run(spec, (fw, i) => {
    if (i >= 1) { fw.asm.li("a1", 1); for (let k = 0; k < 4; k++) fw.publish(0, 4 * i + k, "a1"); }
  });
  assert.deepEqual(r.summary.faults, []);
  const remote = hubFrames(r, "publish").filter((f) => f.state.board === 0).map((f) => f.atBatch);
  assert.equal(remote.length, 12);
  const gaps = remote.slice(1).map((t, k) => t - remote[k]);
  assert.ok(gaps.every((g) => g === 160), JSON.stringify(gaps));
});

test("a barrier across two boards: the root releases, and the far board one crossing later with the root's stamp", async () => {
  const spec = build([2, 2]);
  const r = await run(spec, (fw) => {
    fw.barrier(0, 4, "a0");
    fw.asm.lui("t0", 0x40000);
    fw.asm.sw("a0", "t0", 0);
  });
  assert.deepEqual(r.summary.faults, []);
  const releases = hubFrames(r, "release");
  const root = releases.find((f) => f.state.board === 0), far = releases.find((f) => f.state.board === 1);
  assert.ok(root && far);
  // One crossing: dispatch at the root → the far hub's lane input (≥ 310, on the word-clock phase) → its dispatch (7).
  const gap = far.atBatch - root.atBatch;
  assert.ok(gap >= 317 && gap <= 325, "release gap " + gap);
  // Every core reads the same time.
  assert.equal(new Set(r.summary.host.map((h) => h.value)).size, 1);
  assert.equal(r.summary.host.length, 4);
});
