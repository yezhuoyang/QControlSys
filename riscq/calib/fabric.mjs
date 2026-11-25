// Calibration microbenchmarks of the classical fabric every platform shares: RISC-Q cores, a hub
// per board, and the lanes between boards (riscq/soc.mjs, the multi-board Lean model whose core,
// hub and lane timing is checked against RISC-Q's RTL).
//
// What each probe measures, in dspClk cycles (batches) at 500 MHz, from the trace of one run:
//   publish     a bit published by one core: when it reaches its own board's inbox and every
//               other board's (the `measure` result's way to other cores; classical bandwidth)
//   barrier     every core arrives; the release at each core after the last arrival, with the
//               last arrival on board 0 (the root) or on another board
//   flood       sustained publishing: bits per µs a hub serves, and across a lane
//   opCost      the core cycles of a Pauli-frame update, a parity of k bits and a lookup decode
//               of k bits (stamped before and after on the core's clock)
// The lane's word-clock phase is fixed at power-up and arbitrary, so the publish and barrier
// probes are swept over all eight phases: their spread is the run-to-run spread of a real build.
import { socSpec, execute, program, MAP } from "../soc.mjs";
import { Firmware } from "../firmware.mjs";

const HZ = 500e6, NS = 1e9 / HZ;
const STAMP = 1024; // host-window byte offset of the probe's own stamps (bit reports use the low words)

/** A build with `perBoard[b]` cores on board b, one dio channel each. */
export function fabricSpec(perBoard, { queueDepth = 4, laneWords = 3 } = {}) {
  const cores = perBoard.flatMap((n, b) => Array.from({ length: n }, (_, i) => ({ name: "b" + b + "c" + i, board: b, channels: [{ name: "io" + b + "_" + i, kind: "dio", slots: 1 }] })));
  const spec = socSpec({ name: "fabric", dsp_freq_hz: HZ, link_pipe: 4, core_defaults: { mem_depth: 4096, with_mul: true, queue_depth: queueDepth }, cores });
  // The lane delay L (GTY TX + RX and cable, in 16 ns word clocks): the firmware's lead and the
  // model must agree on it.
  spec.laneModel = { laneWords };
  return spec;
}

/** Run firmware written per core by `write(fw, index, core)`. */
async function runFirmware(spec, write, { phase = 0, maxEvents = 400_000, trace = "io", allowDrops = false } = {}) {
  const laneWords = spec.laneModel?.laneWords ?? 3;
  const images = spec.cores.map((core, i) => {
    const fw = new Firmware(spec, i);
    fw.begin();
    write(fw, i, core);
    fw.done();
    const im = fw.asm.assemble();
    return { words: im.words, sourceMap: im.sourceMap };
  });
  const result = await execute(program(spec, images, { trace, maxEvents, maxSteps: 200_000_000, model: { lanePhase: phase, laneWords } }));
  const faults = result.summary.faults.filter((f) => !(allowDrops && /queue .* is full: .* dropped/.test(f.reason)));
  if (result.summary.status !== "quiescent" || faults.length) throw Error("probe run: " + result.summary.status + " " + JSON.stringify(result.summary.faults).slice(0, 300));
  return result;
}

/** Store the core's batch time to stamp slot k of the host window. Uses t0, a3. */
function stamp(fw, k) {
  fw.now("a3");
  fw.asm.lui("t0", MAP.HOSTWIN >>> 12);
  fw.asm.sw("a3", "t0", STAMP + 4 * k);
}
const stamps = (result, core) => new Map(result.summary.host.filter((h) => h.core === core && h.offset >= STAMP).map((h) => [(h.offset - STAMP) / 4, h.value >>> 0]));
const boardOf = (spec, part) => spec.cores[spec.cores.findIndex((c) => part.startsWith(c.name + "."))]?.board ?? null;

/**
 * One bit published by the first core of board `from`, with one core on each of `boards` boards.
 * Returns the cycles from its put to the arrival at each board's inbox.
 */
export async function publish({ boards = 2, from = boards - 1, phase = 0, laneWords = 3 } = {}) {
  const spec = fabricSpec(Array(boards).fill(1), { laneWords });
  const src = spec.cores.findIndex((c) => c.board === from);
  const result = await runFirmware(spec, (fw, i) => {
    if (i === src) { fw.asm.li("a1", 1); fw.publish(0, 0, "a1"); }
  }, { phase });
  const put = result.frames.find((f) => f.op === "put" && f.part === spec.cores[src].name && f.state?.node !== undefined && f.targets?.includes("hub")).atBatch;
  const arrivals = result.frames.filter((f) => f.op === "board");
  const at = Array.from({ length: boards }, (_, b) => {
    const a = arrivals.find((f) => boardOf(spec, f.part) === b);
    return a ? a.atBatch - put : null;
  });
  return { boards, from, phase, laneWords, cycles: at, ns: at.map((c) => c * NS) };
}

/**
 * Every core of `perBoard` meets at one barrier. The cores of board `last` arrive `lateBy` cycles
 * after the others, so their arrival is the last one. Returns, per core, the cycles from that last
 * arrival to the release value reaching the core.
 */
export async function barrier({ perBoard = [1, 1], last = perBoard.length - 1, lateBy = 400, phase = 0, laneWords = 3 } = {}) {
  const spec = fabricSpec(perBoard, { laneWords });
  const n = spec.cores.length;
  const result = await runFirmware(spec, (fw, i, core) => {
    if (core.board === last) {
      // Spin until `lateBy` cycles after the start, so this board's arrivals come last.
      fw.now("a4");
      fw.asm.li("a5", lateBy);
      fw.asm.add("a4", "a4", "a5");
      fw.waitUntil("a4");
    }
    fw.barrier(0, n, "a0");
  }, { phase });
  const arrivals = result.frames.filter((f) => f.op === "put" && f.state?.node !== undefined && f.targets?.includes("hub") && f.state.text?.startsWith("sw"));
  const lastArrival = Math.max(...arrivals.map((f) => f.atBatch));
  const released = result.frames.filter((f) => f.op === "released");
  const perCore = spec.cores.map((c) => {
    const r = released.find((f) => f.part.startsWith(c.name + "."));
    return r ? r.atBatch - lastArrival : null;
  });
  return { perBoard, last, phase, cycles: perCore, worst: Math.max(...perCore), worstNs: Math.max(...perCore) * NS };
}

/**
 * Sustained publishing. `senders` cores on board `from` each publish `count` bits back to back;
 * arrivals are counted at board 0's inbox (from = 0: the local hub; from = 1: across the lane).
 * Returns the delivered rate in bits/µs and the latency of the first and last bit.
 */
export async function flood({ senders = 4, count = 64, from = 1, phase = 0 } = {}) {
  const perBoard = from === 0 ? [senders + 1] : [1, senders];
  const spec = fabricSpec(perBoard);
  const sending = spec.cores.map((c, i) => (c.board === from && (from === 1 || i > 0) ? i : -1)).filter((i) => i >= 0);
  const result = await runFirmware(spec, (fw, i) => {
    if (!sending.includes(i)) return;
    fw.asm.li("a1", 1);
    const k = sending.indexOf(i);
    for (let j = 0; j < count; j++) fw.publish((k + j) % 4, (j + 8 * k) % 32, "a1");
  }, { allowDrops: true });
  const puts = result.frames.filter((f) => f.op === "put" && sending.some((i) => f.part === spec.cores[i].name) && f.targets?.includes("hub")).map((f) => f.atBatch).sort((a, b) => a - b);
  const reader = spec.cores.find((c) => c.board === 0 && !sending.includes(spec.cores.indexOf(c)));
  const got = result.frames.filter((f) => f.op === "board" && f.part.startsWith(reader.name + ".")).map((f) => f.atBatch).sort((a, b) => a - b);
  const bits = got.length, span = got.at(-1) - got[0];
  return {
    senders, count, from, sent: puts.length, delivered: bits,
    dropped: result.summary.faults.filter((f) => /dropped/.test(f.reason)).length,
    bitsPerUs: bits > 1 ? (bits - 1) / (span * NS / 1000) : null,
    firstLatency: got[0] - puts[0], lastLatency: got.at(-1) - puts.at(-1),
    hub: result.summary.hub,
  };
}

/**
 * Core cycles of one operation, stamped before and after on the core's clock, less the cost of
 * an empty stamp pair. `op`: "frame" (Pauli-frame update), "parity" (k bits), "decode" (lookup
 * decode of k shared bits, one output), "publish" (one bit).
 */
export async function opCost(op, k = 1) {
  const spec = fabricSpec([1]);
  const result = await runFirmware(spec, (fw) => {
    const inputs = Array.from({ length: Math.max(1, k) }, (_, j) => "in" + j);
    for (const name of inputs) { fw.asm.li("a1", 1); fw.storeBit(name, "a1"); }
    const table = fw.asm.fresh("lut");
    stamp(fw, 0); stamp(fw, 1); // the empty pair
    stamp(fw, 2);
    if (op === "frame") fw.frameUpdate("frame", 1);
    else if (op === "parity") fw.parity(inputs, "p");
    else if (op === "decode") fw.decode(0, 0, k, table, ["d0"]);
    else if (op === "publish") { fw.asm.li("a1", 1); fw.publish(0, 0, "a1"); }
    else throw Error("unknown op " + op);
    stamp(fw, 3);
    if (op === "decode") {
      const skip = fw.asm.fresh("after");
      fw.asm.j(skip);
      fw.asm.label(table);
      for (let s = 0; s < 2 ** k; s++) fw.asm.word(s & 1);
      fw.asm.label(skip);
    }
  });
  const s = stamps(result, 0);
  const empty = s.get(1) - s.get(0), raw = s.get(3) - s.get(2);
  return { op, k, cycles: raw - empty, ns: (raw - empty) * NS, emptyStamp: empty };
}

const summary = (xs) => {
  const v = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return { n: v.length, min: v[0], median: v[v.length >> 1], max: v.at(-1) };
};

/** The whole fabric suite: every probe, the lane-dependent ones over all eight phases. */
export async function fabricSuite({ phases = [0, 1, 2, 3, 4, 5, 6, 7], boards = [2, 4, 8], log = () => {} } = {}) {
  const out = { generated: new Date().toISOString(), clockHz: HZ, model: "riscq/soc.mjs multi-board Lean model (core, hub and two-board lane checked against RISC-Q's RTL; more than two boards forward through board 0, a QuantumOS extension)" };
  out.publish = {};
  for (const B of boards) {
    const runs = [];
    for (const phase of phases) runs.push(await publish({ boards: B, from: B - 1, phase }));
    out.publish[B] = { local: summary(runs.map((r) => r.cycles[B - 1])), toRoot: summary(runs.map((r) => r.cycles[0])), toOther: B > 2 ? summary(runs.map((r) => r.cycles[1])) : null, runs: runs.map((r) => r.cycles) };
    log("publish", B, JSON.stringify(out.publish[B].toRoot), JSON.stringify(out.publish[B].toOther));
  }
  out.barrier = {};
  for (const B of [1, ...boards]) {
    const per = Array(B).fill(2);
    const rootLast = [], remoteLast = [];
    for (const phase of phases) {
      rootLast.push((await barrier({ perBoard: per, last: 0, phase })).worst);
      if (B > 1) remoteLast.push((await barrier({ perBoard: per, last: B - 1, phase })).worst);
    }
    out.barrier[B] = { lastOnRoot: summary(rootLast), lastOnOther: B > 1 ? summary(remoteLast) : null };
    log("barrier", B, JSON.stringify(out.barrier[B]));
  }
  // The lane delay L in 16 ns word clocks: 3 is RISC-Q's simulation stand-in; a GTY transceiver pair
  // with a short cable is several word clocks more, and fiber adds about 5 ns per metre (0.3 per metre).
  out.laneDelay = [];
  for (const L of [3, 6, 12, 24]) {
    const p = await publish({ boards: 2, laneWords: L }), b = await barrier({ perBoard: [2, 2], last: 1, laneWords: L });
    out.laneDelay.push({ laneWords: L, publishCycles: p.cycles[0], barrierWorstCycles: b.worst });
  }
  log("laneDelay", JSON.stringify(out.laneDelay));
  out.flood = { hub: await flood({ senders: 8, count: 48, from: 0 }), lane: await flood({ senders: 8, count: 48, from: 1 }) };
  for (const x of Object.values(out.flood)) delete x.hub;
  log("flood", JSON.stringify(out.flood));
  out.ops = [];
  for (const [op, ks] of [["frame", [1]], ["publish", [1]], ["parity", [1, 2, 4, 8, 16, 32]], ["decode", [1, 2, 4, 8, 10]]]) for (const k of ks) out.ops.push(await opCost(op, k));
  log("ops", JSON.stringify(out.ops.map((o) => o.op + "(" + o.k + ")=" + o.cycles)));
  return out;
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const out = await fabricSuite({ log: (...a) => console.log(...a) });
  const dir = new URL("../../validation/calib/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("fabric.json", dir), JSON.stringify(out, null, 1) + "\n");
  console.log("wrote validation/calib/fabric.json");
}
