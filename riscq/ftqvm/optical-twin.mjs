// A QEC circuit on an optically controlled twin (neutral atoms, trapped ions) with the decoder in
// the control program, and feedback.
//
// The platform gives a timeline: what each optical or transport system does and when, as native
// actions on named channels ({ channel, at, dur } in ns, each owned by one listing operation),
// the listing (one row per circuit moment or operation, with its window) and the measurements
// (which qubit, which bit, when). This module turns it into a RISC-Q program:
//   one core per optical system (named so the 3D view knows its role: global-*, beams-*,
//   movers-*, pumps-*), readout cores that each count up to four qubits' photon lines, a frame
//   core, and the decoder core dec0.0 running the compiled union-find decoder in the same run
//   (riscq/decoders/inrun.mjs); after the decode, pulses conditioned on the decoded bit.
// The board runs at 500 MHz (RISC-Q's dspClk); a pulse longer than one table entry (65535
// batches) is played as consecutive entries. Every native is checked against its operation's
// window, as on the transmon twins.
import { execute, socSpec, AMP_SCALE } from "../soc.mjs";
import { placeOnBoards } from "../board.mjs";
import { measuredBits } from "../compile.mjs";
import { conformance } from "./sc-run.mjs";
import { bitLatency } from "./magic.mjs";
import { controllerTrack } from "./track.mjs";
import { assembleWithDecoder, decodeRecord } from "../decoders/inrun.mjs";

const PER_CORE = 4;

/**
 * Run a timeline. options:
 *   name, channels: [{ name, core }] (core: a role-bearing core name), natives: [{ channel, at, dur, uid, op }],
 *   listing: { ops }, measures: [{ uid, bit, qubit, at, dur }], graph, shot (0/1 string, record order),
 *   feedback: [{ channel, dur, qubit }], publishMask, dspHz
 */
export async function runOpticalTwin({ name, channels, natives, listing, measures, graph, shot, feedback = [], publishMask = false, dspHz = 500e6, sites = [] }) {
  const period = Math.round(1e12 / dspHz);
  const b = (ns) => Math.round((ns * 1000) / period);
  // Everything on the controller's grid: a native starts on a batch and lasts whole batches, and
  // its operation's window is widened to the batches it covers.
  const gridNs = period / 1000, down = (ns) => Math.floor(ns / gridNs + 1e-9) * gridNs, upNs = (ns) => Math.ceil(ns / gridNs - 1e-9) * gridNs;
  natives = natives.map((n) => ({ ...n, at: down(n.at), dur: Math.max(gridNs, upNs(n.at + n.dur) - down(n.at)) }));
  measures = measures.map((m) => ({ ...m, at: down(m.at), dur: upNs(m.dur) }));
  listing = { ...listing, ops: listing.ops.map((o) => ({ ...o, start: down(o.start), end: upNs(o.end), duration: upNs(o.end) - down(o.start) })) };
  const coreNames = [...new Set(channels.map((c) => c.core))];
  // Each channel names its own logical DAC; placeOnBoards gives it one of its board's 16.
  const pulse = (n) => ({ name: n, kind: "pulse", dac: n, slots: 32, env_depth: 1024, interp: 4 });
  // Exposures: the measurements a camera core takes at once (up to four lines). A measurement may
  // name its camera; by default every four measurements in order share one. A camera takes its
  // exposures one after another.
  const exposures = [];
  measures.forEach((m, i) => {
    const camera = m.camera ?? Math.floor(i / 4);
    const open = exposures.find((e) => e.camera === camera && e.at === m.at && e.measures.length < 4);
    if (open) open.measures.push(m);
    else exposures.push({ camera, at: m.at, measures: [m] });
  });
  const cameras = Math.max(0, ...exposures.map((e) => e.camera + 1));
  const cores = [
    ...coreNames.map((core) => ({ name: core, channels: channels.filter((c) => c.core === core).map((c) => pulse(c.name)) })),
    ...Array.from({ length: cameras }, (_, c) => ({ name: "readout" + c, channels: [pulse("image" + c), { name: "pmt" + c, kind: "dio", slots: 1 }] })),
    { name: "frame", channels: [{ name: "status", kind: "dio", slots: 1 }] },
    { name: "dec0.0", channels: [{ name: "dstatus", kind: "dio", slots: 1 }] },
  ];
  // The cores on as many ZCU216 boards as they need (riscq/board.mjs), joined by RISC-Q's PutLane.
  const onBoards = placeOnBoards(cores);
  const spec = socSpec({ name, dsp_freq_hz: dspHz, link_pipe: 4, core_defaults: { mem_depth: 16384, with_mul: true, queue_depth: 32 }, cores: onBoards.cores });
  const coreOf = (n) => spec.cores.findIndex((c) => c.name === n);
  const coreOfChannel = (ch) => spec.cores.findIndex((c) => c.channels.some((x) => x.name === ch));
  const tables = new Map(), actions = [], bindings = [], hardwareOps = [], origin = new Map();
  const slotOf = (core, channel, dur) => {
    const key = core + "/" + channel;
    if (!tables.has(key)) tables.set(key, { core, channel, freq: 0, slots: [], keys: new Map() });
    const tb = tables.get(key);
    if (!tb.keys.has(dur)) {
      const index = tb.slots.length;
      if (index >= 32) throw Error(name + ": channel " + channel + " needs more than 32 pulse-table entries");
      tb.keys.set(dur, index);
      tb.slots.push({ slot: index, phase: 0, amp: AMP_SCALE, env: 0, dur });
      bindings.push({ core, channel: spec.cores[core].channels.findIndex((c) => c.name === channel), slot: index, id: spec.cores[core].name + "." + channel + "#" + index, part: channel, delayPs: 0, detail: { kind: channel } });
    }
    return tb.keys.get(dur);
  };
  const fire = (core, channel, at, dur, source, extra = {}) => {
    let left = b(dur), t = b(at);
    while (left > 0) {
      const part = Math.min(left, 65535);
      actions.push({ segment: extra.segment ?? 0, core, at: t, fire: { channel, slot: slotOf(core, channel, part) }, source, ...extra });
      t += part; left -= part;
    }
  };
  natives.forEach((n, k) => {
    const id = "n" + k;
    origin.set(id, n.uid);
    fire(coreOfChannel(n.channel), n.channel, n.at, n.dur, id);
    hardwareOps.push({ id, t: n.at * 1000 });
  });
  // The camera: core c exposes for its four qubits and counts their lines.
  const responses = [], gap = 40;
  const bitsOf = Object.fromEntries(measures.map((m) => [m.bit, Number(shot[Number(/\[(\d+)\]/.exec(m.bit)[1])])]));
  const occurrences = new Map();
  exposures.forEach((ex, e) => {
    const c = ex.camera, mine = ex.measures;
    const core = coreOf("readout" + c), at = b(Math.min(...mine.map((m) => m.at))), dur = b(Math.max(...mine.map((m) => m.at + m.dur))) - at;
    const id = "cam" + e;
    const occurrence = occurrences.get(c) ?? 0;
    origin.set(id, mine[0].uid);
    // The exposure, as consecutive table entries when it is longer than one (65535 batches).
    let parts = 0;
    for (let t = at, left = dur; left > 0; parts++) {
      const part = Math.min(left, 65535);
      actions.push({ segment: 0, core, at: t, fire: { channel: "image" + c, slot: slotOf(core, "image" + c, part) }, source: id });
      t += part; left -= part;
    }
    occurrences.set(c, occurrence + parts);
    actions.push({ segment: 0, core, at, bits: mine.map((m) => m.bit), source: id, count: { channel: "pmt" + c, lines: mine.map((_, i) => i), until: at + dur, threshold: 1, atEnd: true } });
    hardwareOps.push({ id, t: Math.min(...mine.map((m) => m.at)) * 1000 });
    const edges = [];
    mine.forEach((m, i) => { if (bitsOf[m.bit]) edges.push({ after: gap * (2 * i + 1), levels: 1 << i }, { after: gap * (2 * i + 1) + 5, levels: 0 }); });
    const chs = spec.cores[core].channels;
    responses.push({ core, channel: chs.findIndex((x) => x.name === "image" + c), occurrence, toCore: core, toChannel: chs.findIndex((x) => x.name === "pmt" + c), edges });
  });
  const makespan = Math.max(...natives.map((n) => n.at + n.dur), ...measures.map((m) => m.at + m.dur));
  const lowered = { tables: [...tables.values()].map(({ keys: _k, ...t }) => t), segments: [{ span: b(makespan) }, { span: undefined }, { span: Math.max(1, ...feedback.map((f) => b(f.dur))) + 8 }], actions, bindings };
  feedback.forEach((f, k) => {
    const core = coreOfChannel(f.channel);
    lowered.actions.push({ segment: 2, core, at: 0, fire: { channel: f.channel, slot: slotOf(core, f.channel, b(f.dur)) }, when: "uf.obs0", source: "fb" + k });
  });
  lowered.tables = [...tables.values()].map(({ keys: _k, ...t }) => t);
  const decoderCore = coreOf("dec0.0");
  const inputs = measures.map((m) => m.bit);
  const { document, built, map, decoder } = assembleWithDecoder(spec, lowered, {
    decoderCore, segment: 1, graph, inputs, outputs: ["uf.obs0"], flag: "uf.flag", publishMask,
    // The run's budget: its span twice over, plus 20 ms for the decode and feedback (the model's cap is 2·10⁹ cycles).
    options: { trace: "io", maxEvents: 400_000, maxSteps: 20_000_000, maxBatches: Math.min(2_000_000_000, 2 * b(makespan) + 10_000_000), bindings, responses },
  });
  const result = await execute(document);
  const m = { period, decoderCore: coreOf("frame") };
  const report = conformance(listing, { hardware: { segments: [{ ops: hardwareOps, span: makespan * 1000 }] }, lowered, origin, unrealized: [], classical: [], quantization: { gridPs: period } }, result, built, m);
  bitLatency(report);
  const ns = (batch) => (batch * period) / 1000;
  const rec = decodeRecord(result, decoderCore, period / 1000);
  const camPulses = result.summary.pulses.filter((p) => /^cam/.test(p.source));
  const lastClose = Math.max(...camPulses.map((p) => p.closes));
  const fbPulses = result.summary.pulses.filter((p) => /^fb/.test(p.source));
  const stored = measuredBits(result, built);
  const controller = controllerTrack({ spec, result, baseBatch: report.baseBatch, periodPs: period, name: "RISC-Q board, " + Math.round(dspHz / 1e6) + " MHz",
    sitesOfOp: (id) => (/^n\d+$/.test(id) ? natives[Number(id.slice(1))].sites ?? [] : /^cam/.test(id) ? exposures[Number(id.slice(3))].measures.map((x) => x.qubit) : /^fb/.test(id) ? [feedback[Number(id.slice(2))].qubit] : []),
    coreSites: spec.cores.map((c) => (/^readout(\d+)$/.test(c.name) ? [...new Set(exposures.filter((e) => e.camera === Number(c.name.slice(7))).flatMap((e) => e.measures.map((x) => x.qubit)))] : [])) });
  return {
    spec, report, map, decoder, status: result.summary.status, decode: rec, observable: stored["uf.obs0"], flag: stored["uf.flag"], controller, makespanNs: makespan,
    cores: spec.cores.length, pulses: result.summary.pulses.length,
    feedback: fbPulses.map((p) => ({ source: p.source, opensNs: ns(p.opens - report.baseBatch), closesNs: ns(p.closes - report.baseBatch) })),
    latency: rec && {
      lastReadoutCloseNs: ns(lastClose - report.baseBatch), decoderStartNs: ns(rec.startBatch - report.baseBatch), decoderEndNs: ns(rec.endBatch - report.baseBatch), computeNs: rec.computeNs,
      toDecoderNs: ns(rec.startBatch - lastClose), toPulseNs: fbPulses.length ? ns(fbPulses[0].opens - lastClose) : null, afterDecodeNs: fbPulses.length ? ns(fbPulses[0].opens - rec.endBatch) : null,
    },
  };
}
