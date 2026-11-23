// INO/LENS Figure 10. All reconstruction times below are microseconds relative
// to the first paired scope row. Figure 6 observations are in picoseconds.
import { defineInterconnect } from "../../machine/interconnect.mjs";
import { wireExecution } from "../../machine/wiring.mjs";
import pins from "./cora-pinout.json" with { type: "json" };

const tickUs = 4;
const clockPs = 20000;
const preRollPs = 1000000;
const fullScaleUv = 10000000;
export const calibrationLengths = [10000, 11000, 30000, 31000];
export const calibrationId = "free-1";
export const trainingBurst = 4096;
export const recordBytes = 12;

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const triangle = (age, period) =>
  4 * Math.abs(((age / period + 0.25) % 1) - 0.5) - 1;
const shape = (us, onset, period) =>
  us < onset ? 0 : triangle(tickUs * Math.floor((us - onset) / tickUs), period);

// Least-squares measured scale and centre for one candidate firmware period/epoch.
function fitRamp(capture, onsetUs, periodUs) {
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0,
    syy = 0;
  const n = capture.outputMv.length;
  for (let i = 0; i < n; i++) {
    const x = shape(i * capture.stepUs, onsetUs, periodUs),
      y = capture.outputMv[i];
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  const amplitudeMv = (sxy - (sx * sy) / n) / (sxx - (sx * sx) / n);
  const centerMv = (sy - amplitudeMv * sx) / n;
  return {
    periodUs,
    onsetUs,
    amplitudeMv,
    centerMv,
    sse: syy - amplitudeMv * sxy - centerMv * sy,
  };
}

export function calibrate(data) {
  const training = data.captures.find((c) => c.id === calibrationId);
  // The Fig. 10a time axis spans 1 s with roughly 2.5 triangular cycles.
  // The search bounds and threshold are fixed for every scored repetition.
  let best = fitRamp(training, 20000, 400000);
  for (const [epochStep, periodStep] of [
    [4000, 10000],
    [800, 2000],
    [160, 400],
    [32, 80],
    [8, 16],
    [4, 4],
  ]) {
    const { onsetUs, periodUs } = best;
    for (let i = -5; i <= 5; i++)
      for (let j = -5; j <= 5; j++) {
        const fit = fitRamp(
          training,
          onsetUs + i * epochStep,
          periodUs + j * periodStep,
        );
        if (fit.sse < best.sse) best = fit;
      }
  }
  const records = data.cables.filter(
    (c) => c.phaseDeg === 0 && calibrationLengths.includes(c.lengthMm),
  );
  // The board already subtracted its electronic turnaround. Fit flight through
  // the origin with equal weight per cable length, independent of repeat count.
  const psPerMm =
    records.reduce((s, c) => s + c.lengthMm * mean(c.estimatesPs), 0) /
    records.reduce((s, c) => s + c.lengthMm ** 2, 0);
  const { sse, ...ramp } = best;
  const trainingCycles = mean(
    data.dma.groups.find((g) => g.records === trainingBurst).cycles,
  );
  const steadySamplePs = Math.round(
    (clockPs * (trainingCycles - 4)) / (trainingBurst - 4),
  );
  return { ramp, speedMmPerNs: 1000 / psPerMm, steadySamplePs };
}

export function part(id, label, model, x, z, sizeMm) {
  return { id, label, model, centerMm: [x, sizeMm[1] / 2, z], sizeMm };
}
export function net(id, from, out, to, input, kind, options = {}) {
  const interconnect = defineInterconnect(id, kind, {
    fromPort: out,
    toPort: input,
    ...options,
  });
  return {
    id,
    src: { part: from, port: out },
    dst: { part: to, port: input },
    delayPs: 1,
    interconnect,
  };
}
export function bundle(label, parts, wires, body) {
  return {
    sourceName: label,
    design: {
      kind: "machine-design",
      version: 1,
      parts,
      wires,
      roles: { control: "fpga" },
      calibrations: [],
      maxEvents: 20000,
    },
    source: {
      language: "control-ir",
      version: 1,
      tracks: [{ role: "control", body }],
    },
  };
}
const issue = (ps, port, value) => ({
  at: {
    ps,
    body: [{ origin: port + " @ " + ps + " ps", write: { port, value } }],
  },
});

// Rev. 1.2 source directory, schematic sheets 2 and 4. J17 names are
// the rack-bus connector contacts. DAC-card socket pins are unpublished here.
function bufferLeg(channel, upstream) {
  const data = channel === "data",
    address = channel === "address";
  const width = data ? 16 : address ? 7 : 1;
  const input = upstream ? "fpga" : "buffer",
    output = upstream ? "buffer" : "dac";
  const id =
    (upstream ? "pin-" : "") +
    (data ? "sample-bus" : address ? "address-bus" : "ldac");
  const out = data
    ? upstream
      ? "tx"
      : "out"
    : address
      ? "address"
      : upstream
        ? "flag"
        : "strobe";
  const into = data ? "in" : address ? "address" : "strobe";
  const options =
    width === 1
      ? {}
      : {
          transferWidthBits: width,
          beatNs: 20,
          strobeLink: (upstream ? "pin-" : "") + "ldac",
        };
  const w = net(
    id,
    input,
    out,
    output,
    into,
    width === 1 ? "logic" : "parallel",
    options,
  );
  const z = data ? 0 : address ? -13 : 13;
  w.fromOffsetMm = [upstream ? 35 : 15, 0, z];
  w.toOffsetMm = [upstream ? -15 : -21, 0, z];
  if (address) w.addressBits = 7;
  const signals = w.interconnect.conductors.filter((c) => c.role !== "return");
  for (const c of signals) {
    const i = c.bitIndex ?? 0,
      chip = data ? (i < 8 ? "U6" : "U5") : "U4";
    const lane = data ? i % 8 : address ? i + 1 : 0;
    const rack = (lane, top) =>
      "J17." + (lane % 2 ? "a" : "b") + (top - Math.floor(lane / 2));
    c.fromPin = upstream
      ? data
        ? pins.data[i]
        : address
          ? pins.address[i]
          : pins.strobe
      : chip + "." + (18 - lane);
    c.toPin = upstream
      ? chip + "." + (2 + lane)
      : rack(data ? i : lane, data ? 25 : 8);
  }
  const grounds = upstream
    ? ["GND plane"]
    : data
      ? ["J17.a17", "J17.b17", "J17.a26", "J17.b26"]
      : address
        ? ["J17.a3", "J17.b3", "J17.a4", "J17.b4", "J17.a13"]
        : ["J17.b13"];
  // J17 digital grounds are one electrical net. Allocate contacts once across
  // the three selectable bundles. Centreline and ground-plane shapes are schematic.
  const returns = grounds.map((g, i) => ({
    id: "G" + i,
    role: "return",
    offsetMm: signals.at(-1).offsetMm + 1 + i,
    diameterMm: 0.2,
    fromPin: upstream ? "FPGA ground" : g,
    toPin: upstream ? "Buffer ground" : g + " rack return",
  }));
  w.interconnect.conductors = [...signals, ...returns];
  w.interconnect.provenance =
    "Cora Z7 Rev B package constraints and INO v1.2 buffer schematic, U4/U5/U6 and rack J17. Routing, widths, delays and return geometry are schematic.";
  return w;
}

export function cableDesign(lengthMm, profile) {
  const parts = [
    part(
      "fpga",
      "Cora Z7 primary FPGA",
      { fpga: { clockPs } },
      0,
      0,
      [70, 12, 60],
    ),
    part(
      "receiver",
      "Secondary trigger connector",
      { probe: { signal: "bit" } },
      lengthMm + 45,
      0,
      [20, 10, 20],
    ),
  ];
  const cable = net("trigger-coax", "fpga", "flag", "receiver", "in", "coax", {
    encoding: "logic-level",
    lengthMm,
    speedMmPerNs: profile.speedMmPerNs,
    provenance:
      "Effective velocity from the four calibration lengths in the INO primary board records. Connector cross-section and straight placement are schematic.",
  });
  return bundle(
    "INO one-way trigger · " + lengthMm + " mm",
    parts,
    [cable],
    [issue(0, "flag", 1)],
  );
}

// The TX FIFO counter measures transmitted records in programmable logic.
// These connections represent internal observation points within the board.
export function dmaDesign(records, profile, observe = records) {
  if (!Number.isInteger(observe) || observe < 1 || observe > records)
    throw Error("Choose a record inside the burst.");
  const parts = [
    part(
      "fpga",
      "FPGA · counter window start",
      { fpga: { clockPs } },
      0,
      0,
      [12, 2, 10],
    ),
    part(
      "fifo",
      "TX DMA and FIFO · record service",
      {
        dmaBurst: {
          samples: records,
          primed: Math.min(4, records),
          clockPs,
          steadySamplePs: profile.steadySamplePs,
          observe,
        },
      },
      16,
      0,
      [12, 2, 10],
    ),
    part(
      "counter",
      "FPGA · final record counter",
      { probe: { signal: "bit" } },
      32,
      0,
      [9, 2, 7],
    ),
    part(
      "monitor",
      "FPGA · selected record probe",
      { probe: { signal: "bit" } },
      16,
      14,
      [9, 2, 7],
    ),
  ];
  const wires = [
    net("window-start", "fpga", "flag", "fifo", "start", "logic"),
    net("window-complete", "fifo", "done", "counter", "in", "logic"),
    net("record-probe", "fifo", "sample", "monitor", "in", "logic"),
  ];
  return {
    ...bundle("INO TX counter · " + records + " records", parts, wires, [
      issue(0, "flag", 1),
    ]),
    inspectionPart: observe === records ? "counter" : "monitor",
  };
}

function edges(c) {
  // Locate the trigger edge midway between samples bracketing the 3 V threshold
  // in the unscaled CH1 file. Its timing resolution is one 400 µs scope interval.
  const events = [{ us: 0, high: c.triggerMv[0] > 3000 }];
  for (let i = 1; i < c.triggerMv.length; i++) {
    const high = c.triggerMv[i] > 3000;
    if (high !== events.at(-1).high)
      events.push({ us: (i - 0.5) * c.stepUs, high });
  }
  return events;
}
function activeIntervals(c, profile, trigger) {
  const end = c.outputMv.length * c.stepUs;
  if (c.mode === "free") return [{ start: profile.ramp.onsetUs, end, base: 0 }];
  let base = 0;
  return trigger.flatMap((edge, i) => {
    if (!edge.high) return [];
    const until = trigger[i + 1]?.us ?? end;
    const interval = { start: edge.us, end: until, base };
    base += Math.ceil((until - edge.us) / tickUs);
    return [interval];
  });
}
function word(tick, profile) {
  const mv =
    profile.centerMv +
    profile.amplitudeMv * triangle(tick * tickUs, profile.periodUs);
  return Math.max(
    -32768,
    Math.min(32767, Math.round((mv * 1000 * 32768) / fullScaleUv)),
  );
}

function outputHardware(trigger, address) {
  const parts = [
    part(
      "trigger",
      "Function generator · CH1",
      {
        stimulus: {
          signal: "bit",
          samples: trigger.map((e) => ({
            atPs: preRollPs + e.us * 1e6,
            value: Number(e.high),
          })),
        },
      },
      -130,
      0,
      [45, 18, 32],
    ),
    part(
      "trigger-buffer",
      "J19 · U1A Schmitt trigger input",
      {
        affine: {
          input: "bit",
          output: "bit",
          numerator: 1,
          denominator: 1,
          offset: 0,
        },
      },
      -68,
      0,
      [14, 6, 14],
    ),
    part(
      "fpga",
      "Cora Z7 FPGA · timed word issue",
      { fpga: { clockPs } },
      0,
      0,
      [70, 12, 60],
    ),
    part(
      "buffer",
      "U4–U6 · 74HCT541 bus buffers",
      { busBuffer: { inputRailMv: 3300, outputRailMv: 5000 } },
      67,
      0,
      [30, 6, 42],
    ),
    part(
      "dac",
      "Rack J17 → LENS 16-bit DAC",
      { clockedDac: { bits: 16, fullScaleUv, address } },
      130,
      0,
      [42, 12, 37],
    ),
    part(
      "output",
      "Oscilloscope CH2 · analog output",
      { probe: { signal: "voltageUv" } },
      225,
      0,
      [65, 32, 45],
    ),
  ];
  const wires = [
    net("trigger-in", "trigger", "out", "trigger-buffer", "in", "coax", {
      encoding: "logic-level",
    }),
    net("trigger-pin", "trigger-buffer", "out", "fpga", "sense", "logic"),
    ...[true, false].flatMap((upstream) =>
      ["data", "address", "strobe"].map((channel) =>
        bufferLeg(channel, upstream),
      ),
    ),
    net("output-lead", "dac", "out", "output", "in", "coax"),
  ];
  Object.assign(wires[0].interconnect.conductors[0], { toPin: "J19.1" });
  Object.assign(wires[1].interconnect.conductors[0], {
    fromPin: "U1A.7",
    toPin: pins.start,
  });
  return { parts, wires };
}

// Footnote 29, and the default parameters in the published dio24_timing.v.
const strobePs = 240000,
  widthPs = 500000;
function addressedWord(atPs, address, word) {
  return [
    {
      at: {
        ps: atPs,
        body: [
          { origin: "Bus word @ " + atPs + " ps", writeBus: { address, word } },
        ],
      },
    },
    issue(atPs + strobePs, "flag", 1),
    issue(atPs + strobePs + widthPs, "flag", 0),
  ];
}
export function rtlDesign(program) {
  const { parts, wires } = outputHardware([], program.address);
  const body = program.instructions.flatMap((cmd) => {
    const atPs = cmd.tick * program.timestampTickPs;
    if (cmd.nop)
      return [
        {
          at: {
            ps: atPs,
            body: [{ origin: "NOP @ " + atPs + " ps", wait: 0 }],
          },
        },
      ];
    return addressedWord(atPs, program.address, cmd.word);
  });
  return {
    ...bundle(
      "INO 50 MHz FPGA · published Verilog comparison",
      parts,
      wires,
      body,
    ),
    inspectionOp: "write address and data",
  };
}

// Scope projections retain the last visible write. Debug windows include every
// native issue in the window plus the values held across earlier pauses.
export function rampDesign(
  c,
  profile,
  { row, span = 100, first = 0, last = c.outputMv.length } = {},
) {
  const trigger = edges(c);
  const intervals = activeIntervals(c, profile, trigger);
  const { parts, wires } = outputHardware(trigger, 0);
  const index = new Map(parts.map((p) => [p.id, p]));
  const transfer = (w) => {
    const x = wireExecution(w, index);
    return x.delayPs + x.servicePs;
  };
  const pathPs =
    strobePs +
    ["pin-ldac", "ldac", "output-lead"].reduce(
      (ps, id) => ps + transfer(wires.find((w) => w.id === id)),
      0,
    );
  // Read the trigger after arrival, then issue on the next available control
  // edge. This uses the assigned 50 MHz clock and a schematic input delay.
  const decodePs = 5 * clockPs;
  const cutUs = row === undefined ? 0 : row * c.stepUs;
  if (
    row !== undefined &&
    (!Number.isInteger(row) || row < 0 || row >= c.triggerMv.length)
  )
    throw Error("Choose a valid scope row.");
  const obsTimes =
    row === undefined
      ? Array.from({ length: last - first }, (_, i) => (first + i) * c.stepUs)
      : [cutUs];
  const send = (atPs, value) => addressedWord(atPs, 0, value);
  const body = send(clockPs, word(0, profile.ramp));
  for (const interval of intervals) {
    const count = Math.ceil((interval.end - interval.start) / tickUs);
    const ticks = new Set();
    const lagUs = (decodePs + pathPs) / 1e6;
    for (const t of obsTimes) {
      if (t < interval.start + lagUs) continue;
      ticks.add(
        Math.min(count - 1, Math.floor((t - interval.start - lagUs) / tickUs)),
      );
    }
    if (row !== undefined) {
      const start = Math.max(
        0,
        Math.floor((cutUs - interval.start) / tickUs) - span,
      );
      const end = Math.min(
        count - 1,
        Math.ceil((cutUs - interval.start) / tickUs) + span,
      );
      for (let k = start; k <= end; k++) ticks.add(k);
    }
    if (!ticks.size) continue;
    const release = preRollPs + interval.start * 1e6;
    const writes = [...ticks]
      .sort((a, b) => a - b)
      .flatMap((k) =>
        send(
          release + decodePs + k * tickUs * 1e6,
          word(interval.base + k, profile.ramp),
        ),
      );
    if (c.mode === "gated") {
      body.push(
        { at: { ps: release + clockPs, body: [{ capture: "run_enable" }] } },
        { ifBit: { bit: "run_enable", then: writes } },
      );
    } else body.push(...writes);
  }
  return bundle(
    "INO Fig. 10 · " +
      c.id +
      (row === undefined ? " · scope rows" : " · row " + row),
    parts,
    wires,
    body,
  );
}

export function scopePrediction(c, trace, first = 0, last = c.outputMv.length) {
  if (trace.stop !== "completed")
    throw Error("Incomplete ramp trace: " + trace.stop);
  const samples = trace.frames.filter((f) => f.part === "output" && f.received);
  let j = 0;
  return Array.from({ length: last - first }, (_, i) => {
    const atPs = preRollPs + (first + i) * c.stepUs * 1e6;
    while (j + 1 < samples.length && samples[j + 1].atPs <= atPs) j++;
    if (!(samples[j]?.atPs <= atPs)) throw Error("Missing initial DAC sample");
    return samples[j].received[1] / 1000;
  });
}
