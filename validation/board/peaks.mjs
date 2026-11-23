import { readFileSync } from "node:fs";
import { bundle, net, part } from "./model.mjs";

const figure = JSON.parse(
  readFileSync(new URL("peaks-figure8.json", import.meta.url)),
);
const directions = ["rising", "falling"];
const clockPs = 20000,
  stepPs = 100000;
const cutoffHz = 48220,
  slewVPerUs = 4;
const nominalSlewStepUv = slewVPerUs * stepPs;
const alphaPpm = Math.round(
  -Math.expm1(-2 * Math.PI * cutoffHz * stepPs * 1e-12) * 1e6,
);
const timeUs = (i) =>
  ((figure.firstPixel + i - figure.zeroPixel) * 80) / figure.pixelsPer80Us;

export function electrodeDesign(
  direction,
  row = 0,
  figureOriginPs,
  slewStepUv = nominalSlewStepUv,
) {
  if (!directions.includes(direction))
    throw Error("Unknown electrode transition.");
  if (
    !Number.isInteger(row) ||
    row < 0 ||
    row >= figure.edges[direction].lowMv.length
  )
    throw Error("Choose a column inside Figure 8.");
  const parts = [
    part(
      "fpga",
      "U8 · Spartan-7 SPI controller",
      { fpga: { clockPs } },
      0,
      0,
      [15, 2, 15],
    ),
    part(
      "dac",
      "U10 · DAC81416 channel 0",
      { spiDac81416: { channel: 0, stepPs, slewStepUv } },
      22,
      0,
      [6, 1, 6],
    ),
    part(
      "filter",
      "Output resistor and shunt capacitor",
      { rcFilter: { stepPs, alphaPpm } },
      34,
      0,
      [6, 1.5, 4],
    ),
    part(
      "output",
      "Oscilloscope · module output",
      { probe: { signal: "voltageUv" } },
      45,
      -106,
      [176, 90, 60],
    ),
  ];
  const wires = ["csN", "sclk", "sdi"].map((p, i) => {
    const w = net("spi-" + p, "fpga", p, "dac", p, "logic");
    w.fromOffsetMm = [7.5, -0.85, (i - 1) * 2];
    w.toOffsetMm = [-3, -0.35, (i - 1) * 1.4];
    w.viaMm = [
      [12, 0.15, (i - 1) * 2],
      [17, 0.15, (i - 1) * 1.4],
    ];
    Object.assign(w.interconnect.conductors[0], {
      fromPin: "U8." + p,
      toPin: "U10." + [14, 12, 13][i],
    });
    return w;
  });
  const drive = net("dac-pin-to-filter", "dac", "out", "filter", "in", "dc");
  drive.viaMm = [[28, 0.15, 0]];
  Object.assign(drive.interconnect.conductors[0], {
    fromPin: "U10.1 OUT0",
    toPin: "R input",
  });
  const probeLead = net(
    "output-probe",
    "filter",
    "out",
    "output",
    "in",
    "coax",
  );
  probeLead.toOffsetMm = [176 * 0.24, -90 * 0.3, 60 * 0.5 + 3];
  probeLead.viaMm = [
    [51, 2, 4],
    [89, 3, -18],
    [88, 15, -65],
  ];
  wires.push(drive, probeLead);
  parts[3].displayForm = "oscilloscope";
  for (const w of wires)
    w.interconnect.provenance =
      "Figure 8 output-channel reconstruction. U10 pins from TI Table 4-1. U8 logical ports, ground-plane paths, probe wiring and placement are schematic.";
  const up = direction === "rising";
  const setCode = (ps, code, origin) => ({
    at: {
      ps,
      body: [
        {
          origin,
          call: { name: "setElectrodeCode", targets: ["dac"], params: [code] },
        },
      ],
    },
  });
  const body = [
    setCode(0, up ? 0 : 65535, "Precondition channel"),
    setCode(100000000, up ? 65535 : 0, "Full-range " + direction + " edge"),
  ];
  const doc = bundle(
    "Peaks · " + direction + " electrode DAC transition",
    parts,
    wires,
    body,
  );
  for (const p of parts.slice(0, 3))
    p.pcbGroup = "Duke prototype · schematic board outline";
  doc.design.calibrations.push({
    role: "control",
    call: "setElectrodeCode",
    targets: ["dac"],
    paramRanges: [[0, 65535]],
    body: [{ spiWrite24: { command: 0x10, data: { parameter: 0 } } }],
  });
  return {
    ...doc,
    inspectionPart: "output",
    ...(figureOriginPs === undefined
      ? {}
      : { inspectionPs: Math.round(figureOriginPs + timeUs(row) * 1e6) }),
  };
}

function crossings(xs, ys, level, rising, start = 0) {
  for (let i = Math.max(1, start); i < ys.length; i++) {
    const a = ys[i - 1],
      b = ys[i];
    if (
      (rising && a < level && b >= level) ||
      (!rising && a > level && b <= level)
    )
      return xs[i - 1] + ((xs[i] - xs[i - 1]) * (level - a)) / (b - a);
  }
  throw Error("Missing threshold crossing in the electrode transition.");
}
function landmarks(xs, mv, rising) {
  const sign = rising ? 1 : -1,
    midpoint = crossings(xs, mv, 0, rising);
  const widthUs =
    crossings(xs, mv, sign * 8000, rising) -
    crossings(xs, mv, -sign * 8000, rising);
  const lastOutside = mv.findLastIndex(
    (v) => Math.abs(v - sign * 10000) > 1000,
  );
  if (lastOutside < 0 || lastOutside >= mv.length - 1)
    throw Error("Missing final 1 V band.");
  return {
    midpointUs: midpoint,
    widthUs,
    midToBandUs: xs[lastOutside + 1] - midpoint,
  };
}
async function nativeEdge(direction, runMachine, slewStepUv) {
  const { trace } = await runMachine(
    electrodeDesign(direction, 0, undefined, slewStepUv),
  );
  if (
    trace.stop !== "completed" ||
    trace.frames.filter((f) => f.op === "commit SPI DAC word").length !== 2
  )
    throw Error("Incomplete electrode DAC replay.");
  return trace.frames.filter((f) => f.part === "output" && f.received);
}
function observed(direction) {
  const { lowMv, highMv } = figure.edges[direction];
  return {
    lowMv,
    highMv,
    outputMv: lowMv.map((v, i) => (v + highMv[i]) / 2),
    timeUs: lowMv.map((_, i) => timeUs(i)),
  };
}
async function risingTiming(runMachine, slewStepUv) {
  const points = (await nativeEdge("rising", runMachine, slewStepUv)).filter(
    (f) => f.atPs >= 100000000,
  );
  const times = points.map((f) => f.atPs),
    values = points.map((f) => f.received[1]);
  return {
    zeroPs: crossings(times, values, 0, true),
    widthUs:
      (crossings(times, values, 8000000, true) -
        crossings(times, values, -8000000, true)) /
      1e6,
  };
}
export async function fitRisingEdge(runMachine) {
  const rising = observed("rising");
  const measured = landmarks(rising.timeUs, rising.outputMv, true);
  // Binary search on 0.01 V/µs increments, using only rising 10–90% width.
  // Preserve the nominal unfitted prediction as a second, independent baseline.
  let slow = 50,
    fast = 800;
  const resolution = stepPs / 100;
  for (; slow + 1 < fast; ) {
    const mid = Math.floor((slow + fast) / 2);
    const r = await risingTiming(runMachine, mid * resolution);
    if (r.widthUs > measured.widthUs) slow = mid;
    else fast = mid;
  }
  const candidates = [];
  for (const rate of [slow, fast, nominalSlewStepUv / resolution]) {
    const slewStepUv = rate * resolution;
    const r = await risingTiming(runMachine, slewStepUv);
    candidates.push({
      slewStepUv,
      widthUs: r.widthUs,
      originPs: Math.round(r.zeroPs - measured.midpointUs * 1e6),
    });
  }
  const [a, b, nominal] = candidates;
  const fitted =
    Math.abs(a.widthUs - measured.widthUs) <
    Math.abs(b.widthUs - measured.widthUs)
      ? a
      : b;
  return { fitted, nominal };
}
export async function replayEdge(
  direction,
  { originPs, slewStepUv },
  runMachine,
) {
  const points = await nativeEdge(direction, runMachine, slewStepUv);
  const measured = observed(direction);
  let k = 0;
  const predictedMv = measured.timeUs.map((us) => {
    const ps = Math.round(originPs + us * 1e6);
    while (k + 1 < points.length && points[k + 1].atPs <= ps) k++;
    if (points[k].atPs > ps)
      throw Error("Missing preconditioned output sample.");
    return points[k].received[1] / 1000;
  });
  return { id: "peaks-" + direction, ...measured, predictedMv, originPs };
}
export async function evaluateEdges(runMachine) {
  const { fitted, nominal } = await fitRisingEdge(runMachine);
  const edges = [];
  for (const direction of directions) {
    const e = await replayEdge(direction, fitted, runMachine);
    const baseline = await replayEdge(direction, nominal, runMachine);
    const measured = landmarks(e.timeUs, e.outputMv, direction === "rising");
    const replay = landmarks(e.timeUs, e.predictedMv, direction === "rising");
    const active = e.timeUs.flatMap((us, i) =>
      Math.abs(us) <= 12 ? [e.predictedMv[i] - e.outputMv[i]] : [],
    );
    edges.push({
      direction,
      split: direction === "rising" ? "calibration" : "holdout",
      columns: e.timeUs.length,
      activeColumns: active.length,
      transitionRmsMv: Math.sqrt(
        active.reduce((n, v) => n + v * v, 0) / active.length,
      ),
      measured,
      replay,
      nominal: landmarks(
        e.timeUs,
        baseline.predictedMv,
        direction === "rising",
      ),
    });
  }
  return {
    source: figure.figure,
    sha256: figure.sha256,
    fitted,
    nominal,
    cutoffHz,
    nominalSlewVPerUs: slewVPerUs,
    stepPs,
    alphaPpm,
    edges,
  };
}
