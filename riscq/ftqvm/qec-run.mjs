// A QEC circuit on a transmon twin with its decoder in the same run, and feedback.
//
// The circuit is any Stim circuit with detectors and observables (a paper's, or one of Stim's
// generated ones). It runs on the twin as the magic-state circuits do (riscq/ftqvm/magic.mjs:
// moments on the controller's grid, the paper's durations, one RISC-Q core per transmon), and the
// control program has two more segments:
//   decode      the decoder core (dec0.0) runs the compiled union-find decoder on the bits the
//               measuring cores published (riscq/decoders/inrun.mjs) and publishes the corrected
//               observables and a "detector fired" flag
//   feedback    pulses conditioned on a decoded bit (`when`): they play only if it is 1
// The run reports, from the Lean trace: when the last readout window closed, when the decoder
// started and finished, and when each conditioned pulse opened, so the latency of the feedback
// loop is measured end to end, not assumed.
import { execute, phaseCode } from "../soc.mjs";
import { measuredBits } from "../compile.mjs";
import * as superconducting from "../platforms/superconducting.mjs";
import { conformance } from "./sc-run.mjs";
import { willowTwin, willowDesign, willowMachine, transmonSchedule, lowerTransmon, willowTrack, bitLatency } from "./magic.mjs";
import { controllerTrack } from "./track.mjs";
import { captured, nativeOp } from "./studio-capture.mjs";
import { assembleWithDecoder, decodeRecord } from "../decoders/inrun.mjs";

/** A flattened Stim circuit in the circuit form of riscq/ftqvm/magic-circuits.mjs. */
export function parseStim(text, name = "circuit") {
  const qubits = [], moments = [{ ops: [], detectors: [], observables: [] }];
  let measured = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z_]+)(?:\[([^\]]*)\])?(?:\(([^)]*)\))?\s*(.*)$/.exec(line);
    if (!m) throw Error(name + ": cannot read `" + line + "`");
    const [, gate, tag, args, rest] = m;
    const targets = rest.split(/\s+/).filter(Boolean);
    if (gate === "QUBIT_COORDS") { const [x, y] = args.split(",").map(Number); qubits[Number(targets[0])] = { x, y }; continue; }
    if (gate === "TICK") { moments.push({ ops: [], detectors: [], observables: [] }); continue; }
    if (gate === "SHIFT_COORDS" || /ERROR|DEPOLARIZE|PAULI_CHANNEL/.test(gate)) continue;
    const recs = () => targets.map((t) => measured + Number(/rec\[(-\d+)\]/.exec(t)[1]));
    if (gate === "DETECTOR") { moments.at(-1).detectors.push({ coords: (args ?? "").split(",").filter(Boolean).map(Number), recs: recs() }); continue; }
    if (gate === "OBSERVABLE_INCLUDE") { moments.at(-1).observables.push({ index: Number(args), recs: recs() }); continue; }
    // A gate controlled by a sweep bit or a measurement record (rec[-k], sweep[k]) is a
    // classically chosen Pauli: with the sweep bits at 0 it plays nothing; record-controlled ones
    // are Pauli-frame corrections, applied by the frame, not by a pulse. Their pairs are dropped.
    let qs = targets.map((t) => (/^\d+$/.test(t) ? Number(t) : null));
    if (["CX", "CNOT", "CZ", "CY", "XCZ", "ZCX"].includes(gate)) {
      const keep = [];
      for (let i = 0; i < qs.length; i += 2) if (qs[i] !== null && qs[i + 1] !== null) keep.push(qs[i], qs[i + 1]);
      qs = keep;
    } else qs = qs.filter((x) => x !== null);
    if (/^M/.test(gate)) measured += targets.filter((t) => /^!?\d+$/.test(t)).length;
    if (!qs.length) continue;
    moments.at(-1).ops.push({ gate, ...(tag ? { tag } : {}), targets: qs });
  }
  // A circuit without QUBIT_COORDS (some papers publish none): every qubit it uses sits on a line
  // by its index; the platform places it (e.g. from the paper's own layout).
  if (!qubits.some(Boolean)) for (const mo of moments) for (const op of mo.ops) for (const q of op.targets) qubits[q] ??= { x: q, y: 0, placed: false };
  // Stim numbers qubits sparsely (its generated circuits skip indices): number them densely.
  const used = [...qubits.keys()].filter((q) => qubits[q]);
  const index = new Map(used.map((q, i) => [q, i]));
  for (const mo of moments) for (const op of mo.ops) op.targets = op.targets.map((q) => {
    if (!index.has(q)) throw Error(name + ": qubit " + q + " has no coordinates");
    return index.get(q);
  });
  return { name, qubits: used.map((q) => qubits[q]), stimIndex: used, moments: moments.filter((mo) => mo.ops.length || mo.detectors.length || mo.observables.length), measurements: measured };
}

/**
 * The circuit in the twin's native gates: a CNOT is H(target) · CZ · H(target) in three moments,
 * a measure-and-reset (MR) a measurement moment then a reset moment. Detectors and observables
 * stay with the moment that completes their measurements.
 */
export function czNative(circuit) {
  const out = [];
  for (const raw of circuit.moments) {
    // An X-basis reset is a reset then H; an X-basis measurement is H then a measurement.
    // A moment the conversion adds is marked `added`; the others keep `from`, their index in
    // the original circuit, so a paper's timeline (one duration per original moment) still maps.
    let mo = { ...raw };
    const at = circuit.moments.indexOf(raw);
    const rx = mo.ops.filter((o) => o.gate === "RX"), mx = mo.ops.filter((o) => o.gate === "MX" || o.gate === "MY");
    if (rx.length) {
      out.push({ ops: [...mo.ops.filter((o) => o.gate !== "RX"), ...rx.map((o) => ({ gate: "R", targets: o.targets }))], detectors: [], observables: [], from: at });
      mo = { ops: rx.map((o) => ({ gate: "H", targets: o.targets })), detectors: mo.detectors, observables: mo.observables, added: true };
    }
    if (mx.length) {
      // X basis: H then measure; Y basis: H_YZ (Y ↔ Z, one pulse) then measure.
      out.push({ ops: mx.map((o) => ({ gate: o.gate === "MX" ? "H" : "H_YZ", targets: o.targets })), detectors: [], observables: [], added: true });
      mo = { ...mo, ops: mo.ops.map((o) => (o.gate === "MX" || o.gate === "MY" ? { gate: "M", targets: o.targets } : o)) };
    }
    if (!mo.added) mo.from = at;
    const cx = mo.ops.filter((o) => o.gate === "CX" || o.gate === "CNOT");
    const mr = mo.ops.filter((o) => o.gate === "MR");
    const rest = mo.ops.filter((o) => !cx.includes(o) && !mr.includes(o));
    if (cx.length) {
      const t = cx.flatMap((o) => o.targets.filter((_, i) => i % 2 === 1));
      out.push({ ops: [...rest, { gate: "H", targets: t }], detectors: [], observables: [], added: true });
      out.push({ ops: [{ gate: "CZ", targets: cx.flatMap((o) => o.targets) }], detectors: [], observables: [], from: mo.from });
      out.push({ ops: [{ gate: "H", targets: t }], detectors: mo.detectors, observables: mo.observables, added: true });
    } else if (mr.length) {
      out.push({ ops: [...rest, ...mr.map((o) => ({ gate: "M", targets: o.targets }))], detectors: mo.detectors, observables: mo.observables, from: mo.from });
      out.push({ ops: mr.map((o) => ({ gate: "R", targets: o.targets })), detectors: [], observables: [], added: true });
    } else out.push(mo);
  }
  return { ...circuit, moments: out };
}

/** The twin of a QEC circuit: its qubits at its coordinates, a coupler for every pair it gates. */
export function qecTwin(circuit, edits = {}, { durations, title, published, basis } = {}) {
  // A paper's own durations ({ x90Ns, xNs, czNs, readoutNs, resetNs }, each { value, source })
  // replace the Willow ones; the edits of a design page apply on top.
  const t = willowTwin(circuit, edits);
  if (durations) t.durations = { ...t.durations, ...Object.fromEntries(Object.entries(durations).map(([k, v]) => [k, edits[k] !== undefined && edits[k] !== v.value ? { value: Number(edits[k]), source: "edited", note: "the paper's twin has " + v.value } : v])) };
  if (published) t.published = published;
  if (basis) t.basis = basis;
  const pairs = new Set();
  for (const mo of circuit.moments) for (const op of mo.ops) if (op.gate === "CZ")
    for (let k = 0; k < op.targets.length; k += 2) pairs.add([op.targets[k], op.targets[k + 1]].sort((a, b) => a - b).join("-"));
  return { ...t, id: "qec-" + circuit.name, title: title ?? circuit.name + " on " + circuit.qubits.length + " transmons", couplers: [...pairs].map((p) => p.split("-").map(Number)) };
}

/**
 * Run a QEC circuit on its twin with the decoder in the run and feedback after it.
 *   graph      the circuit's decoding graph (bridge/magic_sim.py "graph" on the same circuit)
 *   shot       the measurement bits the readout returns (a string of 0/1 in record order)
 *   feedback   [{ qubit, when }]: X pulses conditioned on a decoded bit, "uf.obs0" (the corrected
 *              observable 0, the default) or "uf.flag" (a detector fired)
 */
export async function runWithDecoder(circuit, graph, { shot, feedback = [{ qubit: 0 }], edits = {}, qubitsPerCore = 1, twin = {}, momentNs, publishMask = false } = {}) {
  const device = qecTwin(circuit, edits, twin);
  const design = willowDesign(device, { qubitsPerCore });
  const m = willowMachine(design);
  const s = transmonSchedule(circuit, m, { momentNs });
  const lowered = lowerTransmon(s.natives, m, s.makespanNs);
  const decoderCore = m.spec.cores.findIndex((c) => c.name === "dec0.0");
  if (decoderCore < 0) throw Error("the design has no decoder core dec0.0");
  const period = m.period, pulseBatches = m.span(m.calibration.qubits[0].X.time);
  // Segment 1: the decode (no span: it ends when the decoder is done). Segment 2: the feedback.
  lowered.segments.push({ span: undefined }, { span: pulseBatches + 8 });
  const fbIds = [];
  feedback.forEach((f, k) => {
    const g = m.locate(f.qubit, "gate"), id = "fb" + k;
    fbIds.push(id);
    lowered.actions.push({ segment: 2, core: g.core, at: 0, fire: { channel: g.channel, slot: 1 }, phaseOffset: phaseCode(0), when: f.when ?? "uf.obs0", source: id });
  });
  const inputs = Array.from({ length: circuit.measurements }, (_, i) => "m[" + i + "]");
  const bits = Object.fromEntries(inputs.map((b, i) => [b, Number(shot[i])]));
  const { document, built, map, decoder } = assembleWithDecoder(m.spec, lowered, {
    decoderCore, segment: 1, graph, inputs, outputs: ["uf.obs0"], flag: "uf.flag", publishMask,
    options: { trace: "io", maxEvents: 400_000, maxSteps: 20_000_000, bindings: m.bindings, readouts: superconducting.readoutOracle(lowered, m, bits) },
  });
  const result = await execute(document);
  // For the RISC-Q studio (riscq/ftqvm/studio-capture.mjs): the natives, the decode, the conditioned pulses.
  captured({ spec: m.spec, period, built, result, design, listing: s.listing, segments: [{ span: s.makespanNs * 1000, ops: s.natives.map((n) => nativeOp(n)) },
    { classical: true, ops: [] }, { ops: fbIds.map((id, k) => ({ id, op: "x", qubits: [feedback[k].qubit], t: 0, dur: 0, source: "X on qubit " + feedback[k].qubit + ", conditioned on the decoded bit uf.obs0" })) }] });
  const hardware = { segments: [{ ops: s.natives.map((n) => ({ id: n.id, t: n.t })), span: s.makespanNs * 1000 }] };
  const report = conformance(s.listing, { hardware, lowered, origin: s.origin, unrealized: [], classical: [], quantization: { maxSlipPs: 0, gridPs: period } }, result, built, m);
  // A measured bit is needed only by the decode, which reads it after the next barrier: its
  // lateness after the readout window is reported (bitAfterWindowNs), not a violation.
  bitLatency(report);
  const ns = (batches) => (batches * period) / 1000;
  const rec = decodeRecord(result, decoderCore, period / 1000);
  // The last readout window of the circuit (segment 0), in absolute batches of the trace.
  const readPulses = result.summary.pulses.filter((p) => s.natives.some((n) => n.id === p.source && n.op === "measure"));
  const lastWindowClose = Math.max(...readPulses.map((p) => p.closes));
  const fbPulses = result.summary.pulses.filter((p) => fbIds.includes(p.source));
  const stored = measuredBits(result, built);
  // The track for the 3D view: the circuit's pulses, the decode on the decoder core, the
  // conditioned pulses, and every core's pulses for the controller (riscq/ftqvm/track.mjs).
  const track = willowTrack({ device, schedule: s, report });
  // The track's times are the circuit's (from the trace's time base, as conformance gives them).
  const rel = (batch) => ns(batch - report.baseBatch);
  if (rec) track.events.push({ k: "decode", t0: rel(rec.startBatch), t1: rel(rec.endBatch), s: [], line: "decode_syndrome on dec0.0: " + rec.defects + " detectors fired" });
  for (const p of fbPulses) track.events.push({ k: "1q", t0: rel(p.opens), t1: rel(p.closes), s: feedback.map((f) => f.qubit), line: "conditioned X (feedback)" });
  track.endNs = Math.max(track.endNs, ...track.events.map((e) => e.t1));
  const nativeQubits = new Map(s.natives.map((n) => [n.id, n.qubits]));
  feedback.forEach((f, k) => nativeQubits.set("fb" + k, [f.qubit]));
  const coreSites = m.spec.cores.map(() => []);
  design.qubits.forEach((_, q) => coreSites[m.locate(q, "gate").core]?.push(q));
  track.controller = controllerTrack({ spec: m.spec, result, baseBatch: report.baseBatch, periodPs: period, name: "RISC-Q board, " + Math.round(1e6 / period) + " MHz",
    sitesOfOp: (id) => nativeQubits.get(id) ?? [], coreSites });
  return {
    device, design, schedule: s, report, map, decoder, status: result.summary.status, result, track,
    decode: rec, observable: stored["uf.obs0"], flag: stored["uf.flag"],
    feedback: fbPulses.map((p) => ({ source: p.source, opensNs: ns(p.opens), closesNs: ns(p.closes) })),
    latency: rec && {
      lastReadoutCloseNs: ns(lastWindowClose),
      decoderStartNs: ns(rec.startBatch), decoderEndNs: ns(rec.endBatch), computeNs: rec.computeNs,
      toDecoderNs: ns(rec.startBatch - lastWindowClose),
      toPulseNs: fbPulses.length ? ns(fbPulses[0].opens - lastWindowClose) : null,
      afterDecodeNs: fbPulses.length ? ns(fbPulses[0].opens - rec.endBatch) : null,
    },
  };
}
