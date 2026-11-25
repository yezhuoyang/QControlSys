// Reference programs for the three platforms and one entry point that compiles and runs them.
// The browser debugger, the command line and agents all call `run`, so they see the same
// source, hardware instructions, firmware and trace.
import { readFileSync } from "node:fs";
import { execute } from "./soc.mjs";
import { assemble, measuredBits } from "./compile.mjs";
import * as superconducting from "./platforms/superconducting.mjs";
import * as qccd from "./platforms/qccd.mjs";
import * as neutral from "./platforms/neutral.mjs";
import * as helios from "./decoders/helios.mjs";
import { geometry } from "./geometry.mjs";
import * as hardwareDesign from "./design.mjs";

const file = (relative) => readFileSync(new URL("../" + relative, import.meta.url), "utf8");

const bell = `OPENQASM 3.0;
include "stdgates.inc";
qubit[3] q;
bit c;
h q[0];
cx q[0], q[1];
c = measure q[0];
if (c) x q[2];
`;

const ghz = `OPENQASM 2.0;
include "qelib1.inc";
qreg q[3];
creg c[3];
h q[0];
cx q[0],q[1];
cx q[1],q[2];
measure q -> c;
`;

// Three data qubits (0, 2, 4) and two ancillas (1, 3) of the ring: one round of the two parity
// checks of a bit-flip repetition code. The syndrome s0 + 2·s1 selects the qubit to correct.
const repetition = {
  kind: "system-calls", version: 1,
  calls: [
    { call: "gate", name: "cx", qubits: [0, 1] },
    { call: "gate", name: "cx", qubits: [2, 1] },
    { call: "gate", name: "cx", qubits: [2, 3] },
    { call: "gate", name: "cx", qubits: [4, 3] },
    { call: "measure", qubit: 1, bit: "s0" },
    { call: "measure", qubit: 3, bit: "s1" },
    { call: "decode_syndrome", bits: ["s0", "s1"], lut: [0b000, 0b001, 0b100, 0b010], into: ["e0", "e1", "e2"] },
    { call: "pauli_frame_update", when: "e0", pauli: "X", qubit: 0 },
    { call: "pauli_frame_update", when: "e2", pauli: "X", qubit: 4 },
    { call: "gate", name: "x", qubits: [2], when: "e1" },
  ],
};

export const examples = [
  { id: "superconducting-feedforward", platform: "superconducting", title: "Bell pair with feed-forward on a transmon ring",
    description: "OpenQASM on three cores of the RISC-Q x6y3 calibration: drive pulses, a two-tone CZ, readout, and an X conditioned on the measured bit.",
    source: { language: "OpenQASM 3", text: bell } },
  { id: "superconducting-design", platform: "superconducting", title: "The transmon ring as an editable hardware design",
    description: "The same Bell program on a machine that is a document: a control board, cores, converters, qubits and coax routes with positions in mm. Each wire's delay follows from its routed length. Edit the design and run it again.",
    source: { language: "OpenQASM 3", text: bell }, design: () => hardwareDesign.ringDesign() },
  { id: "superconducting-repetition", platform: "superconducting", title: "Repetition-code round with a decoder core and a Pauli frame",
    description: "System calls on the transmon ring: two parity checks, a lookup decode on a decoder core, two Pauli-frame updates that play no pulse, and one correction pulse conditioned on a decoded bit.",
    source: { language: "System calls", text: JSON.stringify(repetition, null, 1) }, calls: repetition },
  { id: "qccd-ghz3", platform: "qccd", title: "GHZ state of three ions, compiled from OpenQASM by QCCD Studio",
    description: "OpenQASM → TSIR on the Studio H2 machine → shuttles, rotations, Mølmer–Sørensen gates and photon-counted detection on RISC-Q cores.",
    source: { language: "OpenQASM 2", text: ghz }, qasm: ghz },
  { id: "qccd-rotation", platform: "qccd", title: "Loop rotation on a QCCD Studio design",
    description: "Four Studio transport cycles. Each engages 24 electrode control channels, issued by three transport cores.",
    source: { language: "QCCD Studio design", text: file("bridge/fixtures/three-hop.studio.json") } },
  { id: "qccd-h2", platform: "qccd", title: "H2 GHZ program, first 230 Studio cycles",
    description: "Cooling, shuttles, single-ion rotations, Mølmer–Sørensen gates and photon-counted detection on the Studio H2 machine.",
    source: { language: "QCCD Studio H2 demo", text: "" }, frames: 230 },
  { id: "quantinuum-h2-theta1", platform: "qccd", title: "Quantinuum H2 · first entangling gate of the published GHZ32 phase scan",
    description: "The opening 12 Studio cycles of the compiled theta1 hardware circuit. Inspect the q0–q1 interaction at DG01. Controller electronics and cycle costs are QuantumOS reconstructions.",
    source: {language: "Compiled H2 theta1 program", text: file("validation/qccd/h2-theta1.tsir.json")}, frames: 12,
    async studioInput() {
      const {architecture} = await qccd.studioReplay(null, ["--demo"]);
      return {architecture, program:this.source.text};
    },
    provenance: {
      circuit: "Quantinuum GHZ_N32.json, nonadaptive theta1, revision d422a716977899d7d6603c9efadb44e89e495125",
      compiledProgram: "validation/qccd/h2-theta1.tsir.json; compilation, certificate and hashes in validation/qccd/h2-design.json",
      extent: "Opening 12 Studio cycles by default. Electronics and delivery times use the QuantumOS controller model."
    } },
  { id: "decoder-helios-d3", platform: "decoder", distance: 3, title: "Helios union-find decoder, compiled C on a RISC-Q core, distance 3",
    description: "The C union-find of the Helios FPGA decoder, compiled with clang and RISC-Q's firmware runtime, decodes 14 syndromes of a distance-3 surface code over 3 rounds. Every root is compared with the reference.",
    source: { language: "C (Helios union_find.c, D = 3)", text: helios.source(3) } },
  { id: "decoder-helios-d5", platform: "decoder", distance: 5, title: "Helios union-find decoder, compiled C on a RISC-Q core, distance 5",
    description: "The same decoder for a distance-5 surface code over 5 rounds: 60 nodes per syndrome, 9 syndromes.",
    source: { language: "C (Helios union_find.c, D = 5)", text: helios.source(5) } },
  { id: "neutral-bv14", platform: "neutral", title: "ZAC 14-qubit program on a zoned atom array",
    description: "26 AOD rearrangement jobs with stepped tone frequencies, 13 Rydberg pulses and 14 one-qubit instructions.",
    source: { language: "ZAC compiled program", text: file("validation/neutral/zac/bv_n14_transpiled_code.json") } },
];

/**
 * Compile and run a program.
 * request = { example } | { platform: "superconducting" | "qccd", qasm } | { platform: "superconducting", calls } with optional
 *   design    superconducting: a hardware design document (riscq/design.mjs) to run on
 *             instead of the built-in ring
 *   outcomes  measured bit or ion name → 0 or 1 (default 0)
 *   frames    QCCD: number of Studio cycles to take
 *   trace     "io" (default) or "full" for every instruction
 */
export async function run(request) {
  // A reproduced paper's run on its digital twin (riscq/ftqvm/studio-runs.mjs).
  if (typeof request.example === "string" && request.example.startsWith("reproduction:")) {
    const { studioRun } = await import("./ftqvm/studio-runs.mjs");
    return studioRun(request.example, { trace: request.trace ?? "io", design: request.design });
  }
  const example = examples.find((e) => e.id === request.example);
  if (request.example !== undefined && !example) throw Error("Unknown example " + request.example + ".");
  const platform = example?.platform ?? request.platform;
  const outcomes = request.outcomes ?? {};
  const options = { trace: request.trace ?? "io", maxEvents: 400000, maxSteps: 20000000 };
  if (platform === "decoder") return decoderRun(example, request.distance ?? example?.distance ?? 3, options);
  let m, hardware, lowered, built, derived = {}, source;
  if (platform === "superconducting") {
    const calls = request.calls ?? (request.qasm === undefined ? example?.calls : undefined);
    const document = request.design ?? example?.design?.();
    m = document ? hardwareDesign.machine(document) : superconducting.machine({ decoder: calls !== undefined });
    source = calls ? { language: "System calls", text: JSON.stringify(calls, null, 1) }
      : { language: "OpenQASM 3", text: request.qasm ?? example.source.text };
    hardware = calls ? superconducting.scheduleCalls(calls, m) : superconducting.schedule(source.text, m, { layout: request.layout });
    lowered = superconducting.lower(hardware, m);
    built = assemble(m.spec, lowered, { ...options, bindings: m.bindings, readouts: superconducting.readoutOracle(lowered, m, outcomes) });
  } else if (platform === "qccd") {
    const qasm = request.qasm ?? example?.qasm;
    const input = qasm ? await qccd.compileQasm(qasm, request.architecture)
      : request.example === "qccd-rotation" ? { architecture: example.source.text }
      : request.studio ?? (example?.studioInput ? await example.studioInput() : await qccd.studioReplay(null, ["--demo"]));
    const replay = await qccd.studioReplay(input);
    m = qccd.machine(replay, { frames: request.frames ?? example?.frames, unitNs: request.unitNs });
    if (example?.provenance && !request.studio && !qasm) Object.assign(m.provenance, example.provenance);
    source = qasm ? { language: "OpenQASM 2", text: qasm, tsir: input.program, compiler: "QCCD Studio revision " + input.revision }
      : { language: example?.source.language ?? "QCCD Studio program", text: example?.source.text ?? "" };
    hardware = qccd.schedule(m);
    lowered = qccd.lower(hardware, m);
    built = assemble(m.spec, lowered, { ...options, bindings: lowered.bindings, responses: qccd.photonResponses(lowered, m, outcomes) });
  } else if (platform === "neutral") {
    const code = request.zac ?? JSON.parse(example.source.text);
    m = neutral.machine(code, JSON.parse(file("validation/neutral/zac/full_architecture_2aod.json")));
    source = { language: "ZAC compiled program", text: JSON.stringify(code) };
    hardware = neutral.schedule(m);
    lowered = neutral.lower(hardware, m);
    built = assemble(m.spec, lowered, { ...options, bindings: lowered.bindings });
  } else throw Error("Choose an example or a platform: superconducting, qccd or neutral.");
  const result = await execute(built.document);
  if (platform === "qccd") derived.ionMoves = qccd.ionTimeline(result, hardware);
  if (platform === "neutral") derived.tonePositions = neutral.toneTimeline(result, m);
  derived.bits = measuredBits(result, built);
  return {
    kind: "riscq-run", version: 1,
    example: example ? { id: example.id, title: example.title, description: example.description } : undefined,
    platform,
    machine: { name: m.name, provenance: m.provenance, dspPeriodPs: m.period,
      cores: m.spec.cores.map((c) => ({ name: c.name, channels: c.channels.map((ch) => ({ name: ch.name, kind: ch.kind, dac: ch.dac, adc: ch.adc })) })),
      // Physical layout of the apparatus for the 3D view (riscq/geometry.mjs). Display geometry only.
      geometry: geometry(platform, m, hardware),
      // A machine built from a hardware design carries the design and its layout with wire lengths and delays.
      ...(m.design ? { design: m.design, layout: hardwareDesign.layout(m.design) } : {}) },
    source,
    hardware,
    firmware: built.images,
    // Batches each segment starts later so that its widest burst of writes leaves on time.
    preroll: (built.plans.find((plan) => plan.segments.length)?.segments ?? []).map((segment) => segment.preroll),
    derived,
    ...result,
  };
}

/**
 * Run the compiled Helios union-find decoder on the reference syndromes of a distance.
 * The bundle has the shape of the other runs. Its hardware instructions are the three phases
 * of the program, which the frames name as their source, and `derived.decodes` lists every
 * decoded syndrome with its measured times and whether its roots equal the reference.
 */
async function decoderRun(example, distance, options) {
  const spec = helios.decoderSpec();
  const elf = helios.prebuilt(distance);
  const { result, cases, decodes } = await helios.conformance(distance, { trace: options.trace });
  const period = spec.dspPeriodPs;
  const reference = helios.reference(distance);
  return {
    kind: "riscq-run", version: 1,
    example: example ? { id: example.id, title: example.title, description: example.description } : undefined,
    platform: "decoder",
    machine: {
      name: "RISC-Q decoder core, distance " + distance, dspPeriodPs: period,
      provenance: {
        decoder: helios.provenance.repository + " " + helios.provenance.file + " at " + helios.provenance.commit + " (" + helios.provenance.license + "); " + helios.provenance.change,
        build: "clang for rv32i_zmmul with RISC-Q's start.S, muldiv.c and riscq.h (validation/decoders/helios/images.json)",
        cost: "one batch per instruction plus the branch and bus penalties of the core model, an assumed cost",
      },
      cores: spec.cores.map((c) => ({ name: c.name, channels: c.channels.map((ch) => ({ name: ch.name, kind: ch.kind })) })),
    },
    source: { language: "C (Helios union_find.c, D = " + distance + ")", text: helios.source(distance) },
    hardware: {
      kind: "hardware-program", version: 1, platform: "decoder", machine: spec.name, timeUnit: "ps",
      segments: [{ classical: true, span: result.summary.elapsedPs, ops: Object.entries(helios.phases).map(([id, phase]) =>
        ({ id, op: phase.title, qubits: [], t: 0, dur: 0, source: "C functions " + phase.functions.join(", ") })) }],
    },
    firmware: [{ core: "decoder", instructions: helios.image(elf).words.length, writes: 0, bits: {} }],
    preroll: [0],
    derived: {
      bits: {},
      // One entry per syndrome: times in batches and ns, and the comparison with the reference roots.
      decodes: cases.map((c, k) => ({
        id: c.id, origin: c.origin, weight: c.weight, syndrome: reference.cases[k].syndrome.join(""), roots: decodes[k]?.roots,
        matchesReference: c.matches, clusters: c.clusters,
        inputAtBatch: decodes[k]?.inputAt, firstOutputAtBatch: decodes[k]?.firstOutputAt, lastOutputAtBatch: decodes[k]?.lastOutputAt,
        decodeNs: c.decodeNs, reportNs: c.reportNs, frames: c.frames,
      })),
    },
    ...result,
  };
}
