// System calls on the transmon ring: measure, decode_syndrome, pauli_frame_update and a gate
// conditioned on a decoded bit. The decoder is one more RISC-Q core that runs a lookup table.
import test from "node:test";
import assert from "node:assert/strict";
import { run, examples } from "../riscq/examples.mjs";
import { decodeSamples, report } from "../riscq/syscalls.mjs";
import * as superconducting from "../riscq/platforms/superconducting.mjs";
import * as limits from "../riscq/limits.mjs";
import * as model from "../studio/riscq-model.js";

const repetition = examples.find((e) => e.id === "superconducting-repetition").calls;

test("a repetition-code round decodes each syndrome, flips the frame without a pulse and corrects by a conditioned pulse", async () => {
  // Syndrome s0 + 2·s1 → the data qubit to correct: none, qubit 0, qubit 4, qubit 2.
  const expected = [
    [{ s0: 0, s1: 0 }, { e0: 0, e1: 0, e2: 0 }, {}],
    [{ s0: 1, s1: 0 }, { e0: 1, e1: 0, e2: 0 }, { "frame:q0": 1 }],
    [{ s0: 0, s1: 1 }, { e0: 0, e1: 0, e2: 1 }, { "frame:q4": 1 }],
    [{ s0: 1, s1: 1 }, { e0: 0, e1: 1, e2: 0 }, {}],
  ];
  for (const [outcomes, decoded, frame] of expected) {
    const bundle = await run({ example: "superconducting-repetition", outcomes });
    assert.equal(bundle.summary.status, "quiescent");
    assert.deepEqual(bundle.summary.faults, []);
    assert.deepEqual(bundle.derived.bits, { ...outcomes, ...decoded, ...frame });
    const ops = bundle.hardware.segments.flatMap((s) => s.ops);
    // Pulses, then classical work on the decoder, then the conditioned correction.
    assert.deepEqual(bundle.hardware.segments.map((s) => Boolean(s.classical)), [false, true, false]);
    const classical = ops.filter((op) => op.op === "decode" || op.op === "pauli-frame");
    assert.equal(classical.length, 3);
    // Classical instructions run on the decoder core and play no pulse.
    for (const op of classical) {
      assert.equal(bundle.summary.pulses.filter((p) => p.source === op.id).length, 0);
      assert.ok(bundle.frames.filter((f) => f.source === op.id && f.op !== "wait").every((f) => f.part.startsWith("decoder") || f.part === "hub" || f.part.endsWith(".inbox")));
    }
    // The correction of qubit 2 is a pulse, played only when its decoded bit is set.
    const correction = ops.find((op) => op.when === "e1");
    assert.equal(bundle.summary.pulses.filter((p) => p.source === correction.id).length, decoded.e1);
    assert.ok(bundle.summary.pulses.every((p) => p.onTime && p.aligned !== false));
    // The decoder core issues no timed write.
    assert.equal(bundle.firmware.find((f) => f.core === "decoder").writes, 0);
  }
});

test("the decode path reports when the syndrome arrived, how long the lookup took and when the correction opened", async () => {
  const bundle = await run({ example: "superconducting-repetition", outcomes: { s0: 1, s1: 1 } });
  const [sample] = decodeSamples(bundle);
  // ns after the last syndrome window closed, at 2 ns per batch. Every instruction of every core of
  // this run commits on the cycle RISC-Q's RTL commits it (validation/riscq/rtl/readout-rtl.mjs
  // superconducting-repetition): the bit is readable at the decoder after 58 batches, the decoder has
  // met the other cores and reads it after 90, the three decoded bits are stored 52 batches later,
  // and the conditioned pulse opens after 393.
  assert.deepEqual(
    { input: sample.inputAtDecoderNs, start: sample.decodeStartNs, decode: sample.decodeNs, decoded: sample.decodedNs,
      everywhere: sample.decodedAtEveryCoreNs, pulse: sample.firstConditionedPulseNs },
    { input: 116, start: 180, decode: 104, decoded: 284, everywhere: 320, pulse: 786 });
  assert.deepEqual([sample.syndromeBits, sample.decodedBits], [2, 3]);
  // A frame update whose bit is set stores its word to the host window 356 ns or 390 ns after the
  // last syndrome window.
  const first = decodeSamples(await run({ example: "superconducting-repetition", outcomes: { s0: 1 } }))[0];
  assert.deepEqual(first.frameUpdates.map((u) => [u.qubit, u.applied, u.frame, u.storedNs]), [[0, true, 1, 356], [4, false, undefined, undefined]]);
  const second = decodeSamples(await run({ example: "superconducting-repetition", outcomes: { s1: 1 } }))[0];
  assert.deepEqual(second.frameUpdates.map((u) => [u.qubit, u.applied, u.storedNs]), [[0, false, undefined], [4, true, 390]]);
  // The barrier arrivals of six cores pass the hub three cycles apart (same-barrier hazard); every put
  // is held 7 cycles from the hub input to dispatch even alone.
  assert.deepEqual(report(bundle).hub, { served: 21, longestWaitNs: 38, peakWaiting: 5 });
});

test("two rounds decode from separate fields of the shared word", async () => {
  const round = (tag) => [
    { call: "measure", qubit: 1, bit: tag + "0" }, { call: "measure", qubit: 3, bit: tag + "1" },
    { call: "decode_syndrome", bits: [tag + "0", tag + "1"], lut: [0, 1, 4, 2], into: [tag + "e0", tag + "e1", tag + "e2"] },
    { call: "pauli_frame_update", when: tag + "e0", pauli: "X", qubit: 0 },
    { call: "pauli_frame_update", when: tag + "e2", pauli: "Z", qubit: 0 },
  ];
  const bundle = await run({ platform: "superconducting", calls: { kind: "system-calls", version: 1, calls: [...round("a"), ...round("b")] },
    outcomes: { a0: 1, b1: 1 } });
  assert.deepEqual(bundle.summary.faults, []);
  const bits = bundle.derived.bits;
  assert.deepEqual([bits.ae0, bits.ae1, bits.ae2, bits.be0, bits.be1, bits.be2], [1, 0, 0, 0, 0, 1]);
  // Round a flipped X of qubit 0 (1), round b flipped Z (2): the frame word is 3.
  assert.equal(bits["frame:q0"], 3);
  assert.deepEqual(bundle.hardware.segments.map((s) => Boolean(s.classical)), [false, true, false, true]);
  // The second decode reads slots 2 and 3 of the group word.
  const reads = bundle.frames.filter((f) => f.part === "decoder" && f.state.register === "board").map((f) => f.state.value);
  assert.deepEqual(reads, [0b0001, 0b1001]);
});

test("the decoder takes up to eight simultaneous syndrome bits, and each decoded bit costs 20 ns", async () => {
  for (const k of [1, 4, 8]) {
    const sample = await limits.decodeFanIn(k);
    assert.deepEqual(sample.faults, []);
    assert.ok(sample.correct);
    // This ring's readout windows end at different times, so the syndrome bits do not meet
    // at the hub and the last one is readable at the decoder after the same 116 ns.
    assert.equal(sample.inputAtDecoderNs, 116);
    // The lookup on RISC-Q's core: a load, the table lookup, and per decoded bit a shift, mask and
    // store (riscq/firmware.mjs decode); 17 + 10·k cycles at 2 ns.
    assert.equal(sample.decodeNs, 20 * k + 34);
  }
});

test("a system-call program is rejected where the machine has no realization", () => {
  const m = superconducting.machine({ decoder: true });
  const program = (calls) => ({ kind: "system-calls", version: 1, calls });
  assert.throws(() => superconducting.scheduleCalls(program([{ call: "route", qubits: [0, 1] }]), m), /realizes gate, measure, decode_syndrome and pauli_frame_update/);
  assert.throws(() => superconducting.scheduleCalls(program([{ call: "decode_syndrome", bits: ["s"], lut: [0, 1], into: ["e"] }]), m), /decode takes measured bits/);
  const measure = { call: "measure", qubit: 1, bit: "s" };
  assert.throws(() => superconducting.scheduleCalls(program([measure, { call: "decode_syndrome", bits: ["s"], lut: [0, 1, 0], into: ["e"] }]), m), /one correction word of 1 bits for each of the 2 syndromes/);
  assert.throws(() => superconducting.scheduleCalls(program([measure, { call: "pauli_frame_update", when: "e", pauli: "X", qubit: 0 }]), m), /not measured or decoded yet/);
  assert.throws(() => superconducting.scheduleCalls(program([measure, { call: "decode_syndrome", bits: ["s"], lut: [0, 1], into: ["e"] }]), superconducting.machine()), /no decoder core/);
  assert.throws(() => superconducting.scheduleCalls({ calls: [] }, m), /system-calls/);
});

test("the debugger rebuilds the decoder run: frame words, shared bits and every cause", async () => {
  const bundle = await run({ example: "superconducting-repetition", outcomes: { s0: 1 }, trace: "full" });
  const end = model.stateAt(bundle, bundle.frames.length - 1);
  bundle.summary.cores.forEach((core, i) => assert.deepEqual(end.cores[i].regs, core.regs, core.name));
  assert.deepEqual(end.hub.groups, bundle.summary.hub.groups);
  assert.deepEqual(end.host.map((h) => [h.frame, h.offset, h.value]), bundle.summary.host.map((h) => [h.frame, h.offset, h.value]));
  const parts = new Set(bundle.system.parts.map((part) => part.id));
  const cores = new Set(bundle.machine.cores.map((core) => core.name));
  for (const frame of bundle.frames) {
    assert.ok(parts.has(frame.part), frame.id);
    assert.ok(cores.has(model.causalChain(bundle, frame.id)[0].part), frame.id);
  }
  // The decode and the frame update each have frames to step to.
  for (const entry of model.hardwareOps(bundle).filter((e) => e.op.op === "decode" || (e.op.op === "pauli-frame" && e.op.when === "e0")))
    assert.ok(entry.first >= 0, entry.op.id);
});
