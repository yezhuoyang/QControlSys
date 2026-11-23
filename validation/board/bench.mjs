import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { electrodeDesign, evaluateEdges, replayEdge } from "./peaks.mjs";
import {
  calibrate,
  calibrationId,
  calibrationLengths,
  cableDesign,
  rampDesign,
  scopePrediction,
  dmaDesign,
  trainingBurst,
  recordBytes,
  rtlDesign,
} from "./model.mjs";

const file = (name) => new URL(name, import.meta.url);
const data = JSON.parse(readFileSync(file("observations.json")));
const profile = calibrate(data);
const lengths = [...new Set(data.cables.map((c) => c.lengthMm))].sort(
  (a, b) => a - b,
);
const captures = new Map(data.captures.map((c) => [c.id, c]));

function errors(residuals) {
  if (!residuals.length || !residuals.every(Number.isFinite))
    throw Error("Missing or invalid observations.");
  const sum = residuals.reduce((n, x) => n + x, 0),
    squares = residuals.reduce((n, x) => n + x * x, 0);
  return {
    count: residuals.length,
    bias: sum / residuals.length,
    rms: Math.sqrt(squares / residuals.length),
    peak: residuals.reduce((n, x) => Math.max(n, Math.abs(x)), 0),
  };
}
function checkedCable(id) {
  if (!/^cable-\d+$/.test(id) || !lengths.includes(Number(id.slice(6))))
    throw Error("Unknown measured cable.");
  return Number(id.slice(6));
}
export function debugDesign(id, row = 0) {
  if (id === "peaks-rising" || id === "peaks-falling") {
    const { originPs, slewStepUv } = JSON.parse(readFileSync(file("results.json"))).electrode.fitted;
    return electrodeDesign(id.slice(6), row, originPs, slewStepUv);
  }
  if (id === "rtl-bus")
    return rtlDesign(JSON.parse(readFileSync(file("rtl/program.json"))));
  if (captures.has(id)) {
    const c = captures.get(id);
    return {
      ...rampDesign(c, profile, { row }),
      inspectionPs: 1000000 + row * c.stepUs * 1e6,
    };
  }
  if (/^dma-\d+$/.test(id)) {
    const n = Number(id.slice(4));
    if (!data.dma.groups.some((g) => g.records === n))
      throw Error("Unknown measured DMA burst.");
    return dmaDesign(n, profile, row === 0 ? n : row);
  }
  return cableDesign(checkedCable(id), profile);
}
export async function compareRtl(runMachine) {
  const oracle = JSON.parse(readFileSync(file("rtl/pins.json")));
  const { trace } = await runMachine(debugDesign("rtl-bus"));
  const pins = [];
  const state = { address: 0, word: 0, strobe: 0 };
  let origin = null;
  for (const f of trace.frames.filter((f) => f.part === "fpga" && f.emitted)) {
    const previous = { ...state };
    for (const [port, value] of f.outputs ?? [f.emitted]) {
      state[{ address: "address", tx: "word", flag: "strobe" }[port]] = value;
    }
    if (!isDeepStrictEqual(previous, state)) {
      origin ??= f.atPs;
      pins.push({ atPs: f.atPs - origin, ...state });
    }
  }
  if (trace.stop !== "completed" || !isDeepStrictEqual(pins, oracle.pins))
    throw Error(
      "Native FPGA pin transitions differ from the published timing RTL.",
    );
  return {
    member: oracle.member,
    sha256: oracle.sha256,
    clockPs: oracle.timeGridPs,
    origin: oracle.origin,
    transitions: pins.length,
    matched: true,
  };
}
export async function replayCapture(id, runMachine) {
  if (id === "peaks-rising" || id === "peaks-falling")
    return replayEdge(id.slice(6), JSON.parse(readFileSync(file("results.json"))).electrode.fitted, runMachine);
  const c = captures.get(id);
  if (!c) throw Error("Unknown measured ramp.");
  const predictedMv = [];
  // Bound each Lean replay and keep every retained issue, data, strobe and
  // analog event. The last required state of each previous interval is restored.
  for (let first = 0; first < c.outputMv.length; first += 1000) {
    const last = Math.min(first + 1000, c.outputMv.length);
    const { trace } = await runMachine(rampDesign(c, profile, { first, last }));
    predictedMv.push(...scopePrediction(c, trace, first, last));
  }
  return { ...c, predictedMv };
}
export async function evaluate(runMachine) {
  const ramp = [],
    cables = [];
  const holdoutRamp = [],
    holdoutCable = [],
    holdoutLengths = [];
  for (const c of data.captures) {
    const { predictedMv } = await replayCapture(c.id, runMachine);
    const residuals = predictedMv.map((v, i) => v - c.outputMv[i]);
    const split = c.id === calibrationId ? "calibration" : "holdout";
    ramp.push({ id: c.id, split, ...errors(residuals) });
    if (split === "holdout") holdoutRamp.push(...residuals);
  }
  for (const lengthMm of lengths) {
    const { trace } = await runMachine(cableDesign(lengthMm, profile));
    const sent = trace.frames.find((f) => f.part === "fpga" && f.emitted);
    const received = trace.frames.find(
      (f) => f.part === "receiver" && f.received,
    );
    if (!received || trace.stop !== "completed")
      throw Error("Incomplete cable replay.");
    const predictedPs = received.atPs - sent.atPs;
    const rows = data.cables.filter((c) => c.lengthMm === lengthMm);
    const seen = calibrationLengths.includes(lengthMm);
    const target = seen ? rows.filter((c) => c.phaseDeg === 0) : rows;
    const values = target.flatMap((c) => c.estimatesPs);
    const residuals = values.map((v) => predictedPs - v),
      stats = errors(residuals);
    cables.push({
      lengthMm,
      predictedPs,
      measuredMeanPs: predictedPs - stats.bias,
      phasesDeg: target.map((c) => c.phaseDeg),
      split: seen ? "calibration" : "holdout",
      ...stats,
    });
    if (!seen) {
      holdoutCable.push(...residuals);
      holdoutLengths.push(stats.bias);
    }
  }
  const dma = [],
    cycleErrors = [],
    rateErrors = [];
  for (const { records, cycles } of data.dma.groups) {
    const doc = dmaDesign(records, profile);
    const { trace } = await runMachine(doc);
    const frames = trace.frames.filter((f) => f.part === "fifo");
    const start = frames.find((f) => f.received?.[0] === "start"),
      end = frames.find((f) => f.emitted?.[0] === "done");
    if (!start || !end || trace.stop !== "completed")
      throw Error("Incomplete DMA counter replay.");
    const periodPs = doc.design.parts.find((p) => p.id === "fifo").model
      .dmaBurst.clockPs;
    const predictedCycles = (end.atPs - start.atPs) / periodPs;
    const rate = (clocks) =>
      (records * recordBytes * 1e6) / (clocks * periodPs);
    const diffs = cycles.map((c) => predictedCycles - c),
      rates = cycles.map((c) => rate(predictedCycles) - rate(c));
    const stats = errors(diffs);
    const calibration = records === trainingBurst;
    dma.push({
      records,
      clockPs: periodPs,
      counterCycles: cycles,
      predictedCycles,
      measuredMeanCycles: predictedCycles - stats.bias,
      predictedMBps: rate(predictedCycles),
      measuredMeanMBps: rate(predictedCycles) - errors(rates).bias,
      split: calibration ? "calibration" : "holdout",
      ...stats,
    });
    if (!calibration) {
      cycleErrors.push(...diffs);
      rateErrors.push(...rates);
    }
  }
  return {
    version: 1,
    revision: data.revision,
    archives: data.archiveSHA256,
    calibration: {
      rampCapture: calibrationId,
      cableLengthsMm: calibrationLengths,
      cablePhaseDeg: 0,
      dmaRecords: trainingBurst,
    },
    dmaSource: {
      member: data.dma.member,
      excludedAuthorMarkedLines: data.dma.excludedAuthorMarkedLines,
    },
    rtl: await compareRtl(runMachine),
    electrode: await evaluateEdges(runMachine),
    profile,
    ramp,
    cables,
    dma,
    holdout: {
      voltageMv: errors(holdoutRamp),
      oneWayPs: errors(holdoutCable),
      lengthMeanPs: errors(holdoutLengths),
      txCycles: errors(cycleErrors),
      txMBps: errors(rateErrors),
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { runMachine } = await import("../../server.mjs");
    const report = await evaluate(runMachine);
    const flag = process.argv[2];
    if (flag === "--write")
      writeFileSync(
        file("results.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
    else if (flag === "--check") {
      if (
        !isDeepStrictEqual(
          report,
          JSON.parse(readFileSync(file("results.json"))),
        )
      )
        throw Error("Archived validation differs on replay.");
    } else if (flag)
      throw Error("Use --write or --check, or omit flags to print the scores.");
    console.log(JSON.stringify(report.holdout, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
