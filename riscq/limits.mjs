// Where the controller stops keeping a schedule. Each function builds a small synthetic plan,
// compiles it and, where the compiler accepts it, runs it in the Lean model. The results are
// limits of the modeled RISC-Q build, stated in batches, for use as capacities of a service.
import { socSpec, execute, program, MAP } from "./soc.mjs";
import { assemble } from "./compile.mjs";
import { Firmware } from "./firmware.mjs";

function build({ channels = 1, queueDepth = 4, linkPipe = 4 } = {}) {
  return socSpec({
    name: "limits", dsp_freq_hz: 100e6, link_pipe: linkPipe,
    core_defaults: { mem_depth: 16384, with_mul: true, queue_depth: queueDepth },
    cores: [{ name: "c0", channels: Array.from({ length: channels }, (_, i) =>
      ({ name: "ch" + i, kind: "pulse", dac: i, slots: 2, env_depth: 16, interp: 4 })) }],
  });
}
const tables = (channels, dur) => Array.from({ length: channels }, (_, i) =>
  ({ core: 0, channel: "ch" + i, freq: 1000, slots: [{ slot: 0, amp: 9000, dur }] }));
const clean = (run) => run.summary.status === "quiescent" && !run.summary.faults.length &&
  run.summary.pulses.every((p) => p.onTime && p.aligned && !p.overlap);

/**
 * Gate concurrency of one core: `n` pulses that open on the same batch on `n` channels.
 * Returns the batches the segment had to be delayed and whether every pulse was on time.
 */
export async function concurrency(n) {
  const spec = build({ channels: n });
  const built = assemble(spec, {
    tables: tables(n, 10), segments: [{ span: 60 }],
    actions: Array.from({ length: n }, (_, i) => ({ segment: 0, core: 0, at: 0, fire: { channel: "ch" + i, slot: 0 }, source: "p" + i })),
  });
  const run = await execute(built.document);
  return { pulses: n, prerollBatches: built.plans[0].segments[0].preroll, onTime: clean(run),
    sameBatch: new Set(run.summary.pulses.map((p) => p.opens)).size === 1 };
}

/**
 * Pulse rate of one channel: the shortest pulse for which a long back-to-back train still
 * compiles at a given queue depth. A fire is issued one lead ahead and the queues hold
 * `depth + 1` entries, so the train needs `(depth + 1) · duration ≥ lead`.
 */
export function shortestTrainPulse(queueDepth, pulses = 60) {
  const spec = build({ queueDepth });
  for (let dur = 2; dur <= 200; dur++) {
    try {
      assemble(spec, {
        tables: tables(1, dur), segments: [{ span: pulses * dur + 10 }],
        actions: Array.from({ length: pulses }, (_, k) => ({ segment: 0, core: 0, at: k * dur, fire: { channel: "ch0", slot: 0 }, source: "p" + k })),
      });
      return dur;
    } catch (error) {
      if (!/cannot take this write on time/.test(error.message)) throw error;
    }
  }
  return undefined;
}

/** Run a back-to-back train at a queue depth and report whether the model kept it. */
export async function train(queueDepth, dur, pulses = 60) {
  const spec = build({ queueDepth });
  const built = assemble(spec, {
    tables: tables(1, dur), segments: [{ span: pulses * dur + 10 }],
    actions: Array.from({ length: pulses }, (_, k) => ({ segment: 0, core: 0, at: k * dur, fire: { channel: "ch0", slot: 0 }, source: "p" + k })),
  });
  const run = await execute(built.document);
  const opens = run.summary.pulses.map((p) => p.opens);
  return { onTime: clean(run), pulses: opens.length, contiguous: opens.every((t, i) => i === 0 || t === opens[i - 1] + dur) };
}

/**
 * Link depth: the deepest posted link at which a pulse issued one lead ahead still opens on
 * time. The core's time copy lags by the link and the write crosses it once more, so each
 * stage costs two batches of the lead.
 */
export async function deepestLink(limit = 64) {
  let deepest;
  for (let linkPipe = 0; linkPipe <= limit; linkPipe++) {
    const spec = build({ linkPipe });
    const built = assemble(spec, {
      tables: tables(1, 10), segments: [{ span: 40 }],
      actions: [{ segment: 0, core: 0, at: 0, fire: { channel: "ch0", slot: 0 }, source: "p0" }],
    });
    const run = await execute(built.document);
    if (!clean(run)) return { deepest, firstFault: { linkPipe, reason: run.summary.faults[0]?.reason } };
    deepest = linkPipe;
  }
  return { deepest };
}

// ---- The board hub: shared bits and barriers pass one arbiter, one system put per cycle ----

function hubBuild(cores, dspHz = 500e6) {
  return socSpec({
    name: "hub-limits", dsp_freq_hz: dspHz, link_pipe: 4,
    core_defaults: { mem_depth: 4096, with_mul: true, queue_depth: 4 },
    cores: Array.from({ length: cores }, (_, i) => ({ name: "c" + i, channels: [
      { name: "ch", kind: "pulse", dac: i, slots: 1, env_depth: 16, interp: 4 }] })),
  });
}
/** Run one hand-written firmware per core. `write(fw, coreIndex)` emits the body. */
async function hubRun(cores, write, options = {}) {
  const spec = hubBuild(cores, options.dspHz);
  const images = spec.cores.map((_, i) => {
    const fw = new Firmware(spec, i);
    fw.begin();
    write(fw, i);
    fw.done();
    const image = fw.asm.assemble();
    return { words: image.words, sourceMap: image.sourceMap };
  });
  return execute(program(spec, images, { trace: "io", ...options.program }));
}

/**
 * Classical bandwidth of the hub: `n` cores publish one bit each on the same batch.
 * Returns, in batches after the stores: when each bit was dispatched and when it had reached
 * every core's board register, and the order in which the arbiter granted the cores.
 */
export async function publishBurst(n) {
  const run = await hubRun(n, (fw, i) => {
    fw.asm.li("a1", 1);
    fw.publish(0, i, "a1");
  });
  const stores = run.frames.filter((f) => f.op === "put" && f.state.address !== undefined && f.targets.includes("hub"));
  const store = Math.min(...run.frames.filter((f) => f.op === "put").map((f) => f.atBatch));
  const publishes = run.frames.filter((f) => f.op === "publish");
  const boards = publishes.map((p) => Math.max(...run.frames.filter((f) => f.op === "board" && f.parents.includes(p.id)).map((f) => f.atBatch)));
  void stores;
  return {
    cores: n, faults: run.summary.faults, order: publishes.map((p) => p.state.from),
    dispatched: publishes.map((p) => p.atBatch - store), atEveryBoard: boards.map((t) => t - store),
    waits: run.frames.filter((f) => f.op === "wait").length, hub: run.summary.hub,
    word: run.summary.hub.groups[0],
  };
}

/**
 * Barrier fan-in: `n` cores arrive at one barrier on the same batch. Returns the batches from
 * the arrival stores to the release at the hub and to the release value at every core, and
 * whether every core read the same time.
 */
export async function barrierFanIn(n) {
  const run = await hubRun(n, (fw) => {
    fw.barrier(0, n, "a0");
    fw.asm.lui("t0", MAP.HOSTWIN >>> 12);
    fw.asm.sw("a0", "t0", 0);
  });
  const store = Math.min(...run.frames.filter((f) => f.op === "put").map((f) => f.atBatch));
  const arrivals = run.frames.filter((f) => f.op === "arrive" || f.op === "release");
  const release = run.frames.find((f) => f.op === "release");
  const delivered = run.frames.filter((f) => f.op === "released");
  return {
    cores: n, faults: run.summary.faults, counted: arrivals.map((f) => f.atBatch - store),
    releasedAtHub: release.atBatch - store, atEveryCore: Math.max(...delivered.map((f) => f.atBatch)) - store,
    sameTime: new Set(run.summary.host.map((h) => h.value)).size === 1 && run.summary.host.length === n,
  };
}

/**
 * Sustained publishing: `n` cores each publish `count` bits back to back. A core issues one
 * put every few cycles, the arbiter passes one per cycle for the whole board, and each source
 * queue holds eight. Returns the puts dropped and the longest wait at the arbiter.
 */
export async function publishFlood(n, count) {
  const run = await hubRun(n, (fw, i) => {
    fw.asm.li("a1", 1);
    for (let k = 0; k < count; k++) fw.publish(i % 4, k % 32, "a1");
  }, { program: { maxEvents: 200000 } });
  const puts = run.frames.filter((f) => f.op === "put").map((f) => f.atBatch);
  const perCore = puts.length / n;
  return {
    cores: n, perCore: count, issued: puts.length, served: run.summary.hub.served,
    dropped: run.frames.filter((f) => f.op === "drop" && f.part === "hub").length,
    faults: run.summary.faults.length, maxWait: run.summary.hub.maxWait, peakWaiting: run.summary.hub.peakWaiting,
    // Batches between two puts of one core, from the trace.
    putIntervalBatches: (Math.max(...puts) - Math.min(...puts)) / (perCore - 1),
  };
}

/**
 * Decoder input: `k` qubits of the transmon ring are measured on the same batch and one
 * lookup decode takes the `k` bits. Returns the decode sample of the run (riscq/syscalls.mjs
 * `decodeSamples`): the bits share the hub, so the last one reaches the decoder later as `k`
 * grows. The table is the identity, one decoded bit per syndrome bit.
 */
export async function decodeFanIn(k) {
  const { run } = await import("./examples.mjs");
  const { decodeSamples } = await import("./syscalls.mjs");
  const bits = Array.from({ length: k }, (_, i) => "s" + i);
  const calls = {
    kind: "system-calls", version: 1,
    calls: [
      ...bits.map((bit, q) => ({ call: "measure", qubit: q, bit })),
      { call: "decode_syndrome", bits, lut: Array.from({ length: 2 ** k }, (_, s) => s), into: bits.map((bit) => "d" + bit) },
    ],
  };
  const outcomes = Object.fromEntries(bits.map((bit, i) => [bit, i % 2]));
  const result = await run({ platform: "superconducting", calls, outcomes });
  const [sample] = decodeSamples(result);
  const decoded = Object.fromEntries(bits.map((bit) => [bit, result.derived.bits["d" + bit]]));
  return { ...sample, faults: result.summary.faults, correct: bits.every((bit) => decoded[bit] === outcomes[bit]),
    longestHubWaitBatches: result.summary.hub.maxWait };
}
