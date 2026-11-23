import { readFileSync } from "node:fs";
import { referenceDevice } from "./reference-devices.mjs";
import { defineBoardWire, sourceSignal } from "./wiring.mjs";
// Illustrative electronics and cable placements. Waveforms are command examples, in signed PCM.
// These profiles deliberately carry no claim about the fidelity of a physical quantum gate.
const source =
  'OPENQASM 3.0;\ninclude "stdgates.inc";\ngate flip_pair a,b { x a; x b; }\nqubit[2] q;\nflip_pair q[0], q[1];';
const kind = (id, label, model, x, z, sizeMm) => ({
  id,
  label,
  model,
  centerMm: [x, sizeMm[1] / 2, z],
  sizeMm,
});
const wire = (id, a, out, b, input, delayPs) => ({
  id,
  src: { part: a, port: out },
  dst: { part: b, port: input },
  delayPs,
});

function example(platform, title, clockPs, widthBits, samples) {
  const parts = [
    kind(
      "sequencer",
      "Control FPGA",
      { fpga: { clockPs } },
      -100,
      0,
      [54, 10, 46],
    ),
    kind(
      "memory",
      "Waveform RAM",
      { ram: { words: [0], accessPs: 1200 } },
      -37,
      0,
      [32, 7, 26],
    ),
    kind(
      "bus",
      "Waveform bus",
      { bus: { widthBits, beatPs: 1000 } },
      16,
      0,
      [36, 5, 18],
    ),
    kind(
      "converter",
      "Drive DAC",
      { dac: { bits: 14, fullScaleUv: 1000000 } },
      74,
      0,
      [40, 10, 32],
    ),
  ];
  const wires = [
    wire("addr", "sequencer", "address", "memory", "address", 350),
    wire("data", "memory", "out", "bus", "a", 250),
    wire("payload", "bus", "out", "converter", "in", 300),
  ];
  const calibrations = [];
  for (const [n, id] of ["A", "B"].entries()) {
    const lane = n ? 1 : -1;
    parts.push(
      kind(
        "select" + id,
        "Channel " + id + " switch",
        { switch: { signal: "voltageUv" } },
        135,
        lane * 42,
        [28, 12, 23],
      ),
      kind(
        "drive" + id,
        platform + " drive " + id,
        { probe: { signal: "voltageUv" } },
        228,
        lane * 42,
        [24, 8, 20],
      ),
    );
    wires.push(
      wire("rf" + id, "converter", "out", "select" + id, "in", 750),
      wire("drive-line" + id, "select" + id, "out", "drive" + id, "in", 1200),
    );
    // A single digital address line drives complementary analog switches through a logic inverter.
    calibrations.push({
      role: "control",
      call: "x",
      targets: ["q[" + n + "]"],
      body: [
        { write: { port: "flag", value: n } },
        { stream: { ram: "memory", words: samples, periodTicks: 2 } },
        { wait: 4 },
      ],
    });
    calibrations.push({
      role: "control",
      call: "rx",
      targets: ["q[" + n + "]"],
      paramRanges: [[-Math.PI, Math.PI]],
      body: [
        { write: { port: "flag", value: n } },
        {
          stream: {
            ram: "memory",
            words: samples.map((w) => ({
              parameter: 0,
              scale: w / Math.PI,
              round: true,
            })),
            periodTicks: 2,
          },
        },
        { wait: 4 },
      ],
    });
  }
  parts.push(
    kind(
      "invert",
      "Address inverter",
      {
        affine: {
          input: "bit",
          output: "bit",
          numerator: -1,
          denominator: 1,
          offset: 1,
        },
      },
      27,
      -63,
      [17, 5, 12],
    ),
  );
  wires.push(
    wire("line-select", "sequencer", "flag", "selectB", "enable", 650),
    wire("line-invert", "sequencer", "flag", "invert", "in", 400),
    wire("complement", "invert", "out", "selectA", "enable", 450),
  );
  if (platform === "QCCD") {
    parts.push(
      kind(
        "monitor",
        "Broadcast monitor",
        { probe: { signal: "voltageUv" } },
        231,
        0,
        [28, 9, 14],
      ),
    );
    wires.push(wire("monitor-tap", "converter", "out", "monitor", "in", 1600));
  }
  if (platform === "Neutral atom") {
    parts.push(
      kind(
        "rfMonitor",
        "RF threshold detector",
        { threshold: { levelUv: 200000 } },
        137,
        91,
        [27, 12, 22],
      ),
    );
    wires.push(
      wire("detector-tap", "converter", "out", "rfMonitor", "in", 800),
      wire("detector-return", "rfMonitor", "out", "sequencer", "sense", 1200),
    );
  }
  return {
    id: platform,
    title,
    design: {
      kind: "machine-design",
      version: 1,
      parts,
      wires,
      maxEvents: 4000,
      roles: { control: "sequencer" },
      calibrations,
    },
    source,
  };
}
export const examples = [
  example(
    "Superconducting",
    "Multiplexed microwave drive",
    4000,
    32,
    [0, 2400, 9200, 18000, 9200, 2400, 0],
  ),
  example(
    "Neutral atom",
    "Optical modulator drive",
    5000,
    16,
    [0, 16000, 16000, 16000, 0],
  ),
  example(
    "QCCD",
    "Addressed ion drive",
    6000,
    8,
    [0, 6000, 12000, 12000, 6000, 0],
  ),
];
const feedback = structuredClone(examples[1]);
feedback.id = "Feedback";
feedback.title = "Electrical feedback loop";
feedback.source =
  'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nbit result;\nresult = measure q[0];\nif (result) x q[1];';
feedback.design.calibrations.push({
  role: "control",
  call: "measure",
  targets: ["q[0]"],
  body: [
    { stream: { ram: "memory", words: [16384], periodTicks: 1 } },
    { wait: 4 },
  ],
});
examples.push(feedback);
const profile = JSON.parse(
  readFileSync(
    new URL("../examples/waveform-controller.json", import.meta.url),
    "utf8",
  ),
);
const pairDriveLabels = [
  "Joint microwave drive",
  "Rydberg pair control",
  "Two-ion gate control",
];
for (const [i, e] of examples.slice(0, 3).entries()) {
  const d = e.design,
    clockPs = d.parts[0].model.fpga.clockPs;
  d.device = referenceDevice(e.id);
  e.source += "\ncz q[0], q[1];";
  d.parts.push(
    kind(
      "pair-board",
      "Two-qubit waveform board",
      { waveformBoard: { profile: structuredClone(profile) } },
      0,
      -120,
      [67, 13, 42],
    ),
    kind(
      "pair-drive",
      pairDriveLabels[i],
      { probe: { signal: "voltageUv" } },
      75,
      -120,
      [28, 9, 20],
    ),
  );
  d.wires.push(
    wire("pair-trigger", "sequencer", "tx", "pair-board", "start", 500),
    wire("pair-cable", "pair-board", "out", "pair-drive", "in", 800),
  );
  const shelf = {
    sequencer: [0, 0],
    memory: [-55, 0],
    bus: [-55, 42],
    converter: [0, 42],
    selectA: [55, 25],
    selectB: [55, 62],
    driveA: [101, 25],
    driveB: [101, 62],
    invert: [55, -5],
    monitor: [108, -4],
    rfMonitor: [108, -4],
    "pair-board": [0, -62],
    "pair-drive": [75, -62],
  };
  for (const p of d.parts) [p.centerMm[0], p.centerMm[2]] = shelf[p.id];
  for (const w of d.wires) {
    const src = d.parts.find((p) => p.id === w.src.part);
    w.interconnect = defineBoardWire(w, sourceSignal(src, w.src.port));
  }
  // Reserve the full acquisition budget including trigger and output propagation.
  const reserve = Math.ceil(
    (profile.maxCycles * profile.clockNs * 1000 + 1300) / clockPs,
  );
  for (const targets of [
    ["q[0]", "q[1]"],
    ["q[1]", "q[0]"],
  ]) {
    d.calibrations.push({
      role: "control",
      call: "cz",
      targets,
      body: [{ write: { port: "tx", value: 0 } }, { wait: reserve }],
    });
  }
}
examples.push({
  id: "Waveform board",
  title: "Triggered native waveform board",
  design: {
    kind: "machine-design",
    version: 1,
    roles: { control: "trigger" },
    maxEvents: 4000,
    parts: [
      kind(
        "trigger",
        "Trigger FPGA",
        { fpga: { clockPs: 4000 } },
        -100,
        0,
        [40, 12, 30],
      ),
      kind(
        "awg",
        "Buffered waveform board",
        { waveformBoard: { profile } },
        0,
        0,
        [85, 16, 52],
      ),
      kind(
        "scope",
        "Output scope",
        { probe: { signal: "voltageUv" } },
        120,
        0,
        [42, 20, 35],
      ),
    ],
    wires: [
      wire("trigger-link", "trigger", "tx", "awg", "start", 1500),
      wire("coax", "awg", "out", "scope", "in", 2500),
    ],
    calibrations: [
      {
        role: "control",
        call: "excite",
        targets: ["line-1"],
        body: [{ write: { port: "tx", value: 0 } }],
      },
    ],
  },
  source: {
    language: "control-ir",
    version: 1,
    tracks: [
      {
        role: "control",
        body: [{ call: { name: "excite", targets: ["line-1"] } }],
      },
    ],
  },
});
