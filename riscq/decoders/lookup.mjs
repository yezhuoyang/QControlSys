// The lookup decoder of the controller firmware (riscq/firmware.mjs `decode`), measured at every
// size it supports (1 to 10 syndrome bits), in the Lean model.
//
// riscq/limits.mjs `decodeFanIn` measures it on RISC-Q's eight-transmon ring, so at most 8 bits.
// Here the chip is generated with as many transmons as the decode reads (riscq/ftqvm/sc-chip.mjs:
// one RISC-Q core per transmon, the frame core that runs the decode), so every size is a run.
// The decode time is taken as decodeSamples (riscq/syscalls.mjs) takes it: from the decoder
// core's read of the board word to its last store of a decoded bit.
import { execute } from "../soc.mjs";
import { assemble } from "../compile.mjs";
import * as superconducting from "../platforms/superconducting.mjs";
import * as hardwareDesign from "../design.mjs";
import { chipDesign } from "../ftqvm/sc-chip.mjs";

/** One lookup decode of k bits: k transmons measured, then the decode on the frame core. */
export async function lookupDecode(k) {
  if (!Number.isInteger(k) || k < 1 || k > 10) throw Error("A lookup decode takes 1 to 10 syndrome bits.");
  const placement = { sites: Array.from({ length: k }, (_, i) => ({ id: "s" + i, rc: [0, i], kind: "ancilla" })) };
  const { design } = chipDesign({ ops: [] }, placement, { name: "lookup-" + k, qubitsPerCore: 1, decoders: 1, coresPerDecoder: 1 });
  const m = hardwareDesign.machine(design);
  const bits = Array.from({ length: k }, (_, i) => "s" + i);
  const measureOps = bits.map((bit, q) => {
    const ro = m.calibration.qubits[q].readout;
    const tone = m.span(ro.time), delay = m.span(ro.demod.delay), window = m.span(ro.demod.time);
    return { id: "h" + q, op: "measure", qubits: [q], t: 0, dur: Math.max(tone, delay + window) * m.period,
      params: { tonePs: tone * m.period, delayPs: delay * m.period, windowPs: window * m.period }, result: bit };
  });
  const span = Math.max(...measureOps.map((o) => o.dur));
  const hardware = { kind: "hardware-program", version: 1, platform: "superconducting", machine: m.name, timeUnit: "ps", segments: [
    { ops: measureOps, span },
    { classical: true, ops: [{ id: "dec", op: "decode", qubits: [], inputs: bits, outputs: bits.map((b) => "d" + b), table: Array.from({ length: 2 ** k }, (_, s) => s), t: 0, dur: 0 }] },
  ] };
  const lowered = superconducting.lower(hardware, m);
  const outcomes = Object.fromEntries(bits.map((b, i) => [b, i % 2]));
  const built = assemble(m.spec, lowered, { trace: "io", maxEvents: 400_000, maxSteps: 20_000_000, bindings: m.bindings, readouts: superconducting.readoutOracle(lowered, m, outcomes) });
  const result = await execute(built.document);
  const decoder = m.spec.cores[m.decoderCore].name;
  const read = result.frames.find((f) => f.part === decoder && f.source === "dec" && f.state?.register === "board");
  const stored = result.frames.filter((f) => f.part === decoder && f.op === "host" && f.source === "dec");
  if (!read || !stored.length) throw Error("the lookup decode of " + k + " bits left no trace");
  const periodNs = m.period / 1000;
  const values = stored.map((f) => f.state.store);
  return {
    bits: k, decodeNs: (Math.max(...stored.map((f) => f.atBatch)) - read.atBatch) * periodNs,
    correct: bits.every((b, i) => values[i] === outcomes[b]), cores: m.spec.cores.length, periodNs,
  };
}

/** Every size, 1 to 10 bits. */
export async function lookupTable() {
  const out = [];
  for (let k = 1; k <= 10; k++) out.push(await lookupDecode(k));
  return out;
}
