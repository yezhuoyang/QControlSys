// Hardware designs for pulse-controlled qubits: a machine given as a document of parts, their
// positions, the channels of the control cores and the wires between parts. Nothing here names
// a platform. A design is checked against rules, and the machine the simulator runs is derived
// from it: cores and channels become the RISC-Q build, calibrated pulses become pulse tables,
// and every wire's routed length becomes a propagation delay.
//
// Document (kind "riscq-design", version 1). Lengths are mm, times ns, frequencies Hz,
// amplitudes a fraction of DAC full scale, phases rad.
//   board     { dspHz, linkStages, memWords, queueDepth, envDepth }
//   parts     [{ id, type, centerMm: [x, y, z], index?, board? }]   type: see COMPONENTS; `board` places a
//               core, DAC or ADC on a control board (the first one when left out)
//   channels  [{ id, core, name, kind: "pulse" | "demod" | "dio", converter?, slots?, interp? }]
//   wires     [{ id, from, to, medium, routeMm: [[x, y, z], …] }]   medium: see MEDIA
//   qubits    [{ part, resonator, gate, ro, demod, freqHz, x90, x, readout }]
//               x90, x: { amp, phaseRad, durNs, envelope, virtualZ?: [rad before, rad after] }
//               reset?: { amp, durNs, envelope } an unconditional reset pulse on the gate channel
//                       (its slot after x90 and x); the gate channel then needs 3 slots
//               readout: { freqHz, amp, durNs, envelope, demodDelayNs, demodNs, demodPhaseRad }
//   couplings [{ qubits: [i, j], freqHz, durNs, pulses: [{ qubit, channel, amp, phaseRad, envelope }], virtualZ: [{ qubit, phaseRad }] }]
//   decoder   id of a core that decodes and keeps the Pauli frame (optional)
// A qubit is addressed in programs by its index in `qubits`.
//
// Timing rule: a signal crosses a wire in routed length ÷ the signal speed of its medium
// (machine/interconnect.mjs: coax 200 mm/ns, fibre 204, free space 299.79, planar 125),
// rounded up to a picosecond. A route is the centreline the wire follows, so a longer or
// more winding route is a later arrival. Loss, dispersion and crosstalk are not modeled.
import { readFileSync } from "node:fs";
import { defineInterconnect, transportTiming } from "../machine/interconnect.mjs";
import { pathLengthMm } from "../machine/wiring.mjs";
import { socSpec, freqCode, phaseCode, ampCode, BATCH_SIZE, ADC_BATCH, AMP_SCALE, MAP } from "./soc.mjs";
import { ZCU216, boardUse } from "./board.mjs";

/** The parts a design may contain, and what each is. */
export const COMPONENTS = Object.freeze({
  "control-board": "A RISC-Q board (AMD ZCU216): the hub, the clock, and the cores and converters placed on it. The first is board 0, the barrier root; several are joined by RISC-Q's PutLane.",
  core: "One RV32I control core with up to 16 channels.",
  dac: "One DAC output. `index` is its number on the board. Pulse channels that name it are summed.",
  adc: "One ADC input. `index` is its number on the board.",
  stage: "A passive point a wire passes through: a feedthrough, an attenuator stage, a filter. No delay of its own.",
  qubit: "A qubit. Drive and coupler pulses end here.",
  resonator: "A readout resonator. The readout tone ends here and the returning signal starts here.",
});
/** Wire media, with their signal speeds in mm/ns from machine/interconnect.mjs. */
export const MEDIA = Object.freeze(Object.fromEntries(["coax", "planar", "fiber", "beam"].map((kind) =>
  [kind, defineInterconnect("medium", kind).speedMmPerNs])));

const TOLERANCE_MM = 0.5;

/** Routed length in mm and delay in ps of one wire. */
export function wireTiming(wire) {
  const lengthMm = pathLengthMm(wire.routeMm);
  return { lengthMm, delayPs: transportTiming(defineInterconnect(wire.id, wire.medium), lengthMm).totalPs };
}

/**
 * Check a design against the rules. Returns { errors, warnings }: an error stops the design
 * from running, a warning describes a consequence the designer should see.
 */
export function check(design) {
  const errors = [], warnings = [];
  const fail = (message) => errors.push(message);
  if (design?.kind !== "riscq-design" || design.version !== 1) return { errors: ["A hardware design is { kind: \"riscq-design\", version: 1, … }."], warnings };
  const parts = new Map();
  for (const part of design.parts ?? []) {
    if (parts.has(part.id)) fail("Part id " + part.id + " is used twice.");
    if (!COMPONENTS[part.type]) fail("Part " + part.id + " has the unknown type " + part.type + ". Allowed: " + Object.keys(COMPONENTS).join(", ") + ".");
    if (!Array.isArray(part.centerMm) || part.centerMm.length !== 3 || part.centerMm.some((v) => !Number.isFinite(v))) fail("Part " + part.id + " needs centerMm: [x, y, z].");
    parts.set(part.id, part);
  }
  const ofType = (type) => [...parts.values()].filter((part) => part.type === type);
  const boards = ofType("control-board");
  if (!boards.length) fail("A design has at least one control-board.");
  const boardOf = (part) => part.board ?? boards[0]?.id;
  for (const part of parts.values())
    if (["core", "dac", "adc"].includes(part.type) && part.board !== undefined && parts.get(part.board)?.type !== "control-board")
      fail("Part " + part.id + " is placed on " + part.board + ", which is not a control-board.");
  const cores = ofType("core");
  if (!cores.length || cores.length > 1024) fail("A design has 1 to 1,024 cores.");
  // Per board: what one ZCU216 holds (riscq/board.mjs, from RISC-Q's floorplan and its converters).
  for (const board of boards) {
    const mine = cores.filter((core) => boardOf(core) === board.id);
    if (mine.length > ZCU216.cores.value) fail("Board " + board.id + " carries " + mine.length + " cores; a ZCU216 holds " + ZCU216.cores.value + " (" + ZCU216.cores.source + ").");
    for (const type of ["dac", "adc"]) {
      const limit = type === "dac" ? ZCU216.dacs.value : ZCU216.adcs.value;
      const indices = ofType(type).filter((part) => boardOf(part) === board.id).map((part) => part.index);
      if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= limit) || new Set(indices).size !== indices.length)
        fail("Every " + type + " of board " + board.id + " has its own index from 0 to " + (limit - 1) + " (a ZCU216 has " + limit + ").");
    }
  }
  const channels = new Map();
  for (const channel of design.channels ?? []) {
    if (channels.has(channel.id)) fail("Channel id " + channel.id + " is used twice.");
    channels.set(channel.id, channel);
    if (parts.get(channel.core)?.type !== "core") fail("Channel " + channel.id + " names " + channel.core + ", which is not a core.");
    const want = { pulse: "dac", demod: "adc" }[channel.kind];
    if (!["pulse", "demod", "dio"].includes(channel.kind)) fail("Channel " + channel.id + " has the unknown kind " + channel.kind + ".");
    else if (want && parts.get(channel.converter)?.type !== want) fail("Channel " + channel.id + " of kind " + channel.kind + " needs a " + want + " as its converter.");
    else if (want && parts.get(channel.core) && boardOf(parts.get(channel.converter)) !== boardOf(parts.get(channel.core)))
      fail("Channel " + channel.id + " drives " + channel.converter + " on another board than its core " + channel.core + ".");
  }
  for (const core of cores) {
    const mine = [...channels.values()].filter((channel) => channel.core === core.id);
    if (mine.length < 1 || mine.length > MAP.LOCAL_NODES) fail("Core " + core.id + " has " + mine.length + " channels. A core has 1 to 16.");
    if (new Set(mine.map((channel) => channel.name)).size !== mine.length) fail("Core " + core.id + " has two channels of one name.");
    const demods = mine.filter((channel) => channel.kind === "demod").length;
    if (demods !== 1) fail("Core " + core.id + " has " + demods + " demod channels; RISC-Q builds exactly one (decoder + ADC) into every core.");
  }
  // DSP slices per board, against the ceiling where RISC-Q's builds collapse (riscq/board.mjs).
  for (const board of boards) {
    const mine = cores.filter((core) => boardOf(core) === board.id);
    const spec = { cores: mine.map((core) => ({ name: core.id, memWords: design.board?.memWords ?? 4096,
      channels: [...channels.values()].filter((channel) => channel.core === core.id).map((channel) => ({ kind: channel.kind })) })) };
    const { use } = boardUse(spec);
    if (use.dsp > ZCU216.dspCeiling.value)
      fail("Board " + board.id + " needs about " + use.dsp + " DSP48E2; past " + ZCU216.dspCeiling.value + " RISC-Q's builds collapse (" + ZCU216.dspCeiling.source + ").");
  }
  for (const wire of design.wires ?? []) {
    const from = parts.get(wire.from), to = parts.get(wire.to);
    if (!from || !to) {
      fail("Wire " + wire.id + " joins " + wire.from + " and " + wire.to + ", and one of them is not a part.");
      continue;
    }
    if (!(wire.medium in MEDIA)) fail("Wire " + wire.id + " has the unknown medium " + wire.medium + ". Allowed: " + Object.keys(MEDIA).join(", ") + ".");
    const route = wire.routeMm;
    if (!Array.isArray(route) || route.length < 2 || route.some((p) => !Array.isArray(p) || p.length !== 3 || p.some((v) => !Number.isFinite(v)))) {
      fail("Wire " + wire.id + " needs routeMm with at least two points [x, y, z].");
      continue;
    }
    const gap = (point, part) => Math.hypot(...point.map((v, k) => v - part.centerMm[k]));
    if (gap(route[0], from) > TOLERANCE_MM || gap(route.at(-1), to) > TOLERANCE_MM)
      fail("Wire " + wire.id + " must start at " + wire.from + " and end at " + wire.to + ": its route ends are more than " + TOLERANCE_MM + " mm from them.");
  }
  if (errors.length) return { errors, warnings };
  // Every calibrated pulse needs a wired path from its converter to the part it acts on.
  const reach = (from, to) => pathDelay(design, from, to);
  (design.qubits ?? []).forEach((qubit, index) => {
    const label = "Qubit " + index;
    if (parts.get(qubit.part)?.type !== "qubit" || parts.get(qubit.resonator)?.type !== "resonator") return fail(label + " names a qubit part and a resonator part.");
    for (const role of ["gate", "ro", "demod"]) if (!channels.has(qubit[role])) return fail(label + " names no " + role + " channel.");
    if (channels.get(qubit.gate).kind !== "pulse" || channels.get(qubit.ro).kind !== "pulse" || channels.get(qubit.demod).kind !== "demod")
      return fail(label + " drives and reads out through pulse channels and acquires through a demod channel.");
    const out = reach(channels.get(qubit.gate).converter, qubit.part);
    if (out === undefined) fail(label + ": no wire leads from " + channels.get(qubit.gate).converter + " to " + qubit.part + ".");
    const tone = reach(channels.get(qubit.ro).converter, qubit.resonator), back = reach(qubit.resonator, channels.get(qubit.demod).converter);
    if (tone === undefined) fail(label + ": no wire leads from " + channels.get(qubit.ro).converter + " to " + qubit.resonator + ".");
    if (back === undefined) fail(label + ": no wire leads from " + qubit.resonator + " back to " + channels.get(qubit.demod).converter + ".");
    else if (tone !== undefined && qubit.readout.demodDelayNs * 1000 < tone + back)
      warnings.push(label + ": the acquisition window opens " + qubit.readout.demodDelayNs + " ns after the readout tone starts, but the tone needs " +
        (tone + back) / 1000 + " ns to reach the resonator and return. The first " + ((tone + back) / 1000 - qubit.readout.demodDelayNs).toFixed(3) + " ns of the window hold no signal.");
  });
  for (const coupling of design.couplings ?? [])
    for (const pulse of coupling.pulses) {
      const channel = channels.get(pulse.channel), qubit = design.qubits?.[pulse.qubit];
      if (!channel || channel.kind !== "pulse" || !qubit) fail("A coupling pulse names a pulse channel and a qubit index.");
      else if (reach(channel.converter, qubit.part) === undefined) fail("Coupling pulse on " + pulse.channel + ": no wire leads to " + qubit.part + ".");
    }
  if (design.decoder !== undefined && parts.get(design.decoder)?.type !== "core") fail("The decoder is one of the cores.");
  // A channel has one carrier. Every pulse calibrated on it must use the same frequency.
  const carriers = new Map();
  const carrier = (channel, hz, what) => {
    if (!carriers.has(channel)) carriers.set(channel, { hz, what });
    else if (carriers.get(channel).hz !== hz)
      fail("Channel " + channel + " is given two carrier frequencies: " + Math.round(carriers.get(channel).hz) + " Hz for " + carriers.get(channel).what +
        " and " + Math.round(hz) + " Hz for " + what + ". A channel has one carrier.");
  };
  (design.qubits ?? []).forEach((q, i) => {
    carrier(q.gate, q.freqHz, "qubit " + i + " drive");
    carrier(q.ro, q.readout?.freqHz, "qubit " + i + " readout");
  });
  for (const c of design.couplings ?? []) for (const p of c.pulses) carrier(p.channel, c.freqHz, "coupling " + c.qubits.join("-"));
  return { errors, warnings };
}

/** Delay in ps along the wires from one part to another, through stages. Undefined when no path exists. */
export function pathDelay(design, from, to) {
  const best = new Map([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift();
    for (const wire of design.wires.filter((w) => w.from === at)) {
      const delay = best.get(at) + wireTiming(wire).delayPs;
      if (!best.has(wire.to) || delay < best.get(wire.to)) {
        best.set(wire.to, delay);
        queue.push(wire.to);
      }
    }
  }
  return best.get(to);
}

/**
 * The machine a design describes, in the form the transmon scheduling and lowering use
 * (riscq/platforms/superconducting.mjs `schedule`, `scheduleCalls`, `lower`).
 * Throws with every rule the design breaks.
 */
export function machine(design) {
  const { errors, warnings } = check(design);
  if (errors.length) throw Error("The hardware design breaks " + errors.length + (errors.length === 1 ? " rule:\n" : " rules:\n") + errors.map((e) => "  " + e).join("\n"));
  const parts = new Map(design.parts.map((part) => [part.id, part]));
  const coreParts = design.parts.filter((part) => part.type === "core");
  const board = design.board;
  const boardIds = design.parts.filter((part) => part.type === "control-board").map((part) => part.id);
  const boardIndex = (part) => Math.max(0, boardIds.indexOf(part.board ?? boardIds[0]));
  const channelsOf = (core) => design.channels.filter((channel) => channel.core === core.id);
  const spec = socSpec({
    name: design.name ?? "design", dsp_freq_hz: board.dspHz, link_pipe: board.linkStages ?? 4,
    core_defaults: { mem_depth: board.memWords ?? 4096, with_mul: true, queue_depth: board.queueDepth ?? 4 },
    cores: coreParts.map((core) => ({ name: core.id, board: boardIndex(core), channels: channelsOf(core).map((channel) => ({
      name: channel.name, kind: channel.kind, slots: channel.slots ?? 2, env_depth: board.envDepth ?? 1024, interp: channel.interp ?? 4,
      ...(channel.kind === "pulse" ? { dac: parts.get(channel.converter).index } : {}),
      ...(channel.kind === "demod" ? { adc: parts.get(channel.converter).index } : {}),
    })) })),
  });
  const period = spec.dspPeriodPs;
  const span = (ns) => Math.ceil((ns * 1000) / period - 1e-9);
  const where = (channelId) => {
    const channel = design.channels.find((c) => c.id === channelId);
    const core = coreParts.findIndex((c) => c.id === channel.core);
    return { core, channel: channel.name, index: channelsOf(coreParts[core]).indexOf(channel), converter: channel.converter };
  };
  // Pulse tables: the entries of one channel share its carrier, and their envelopes follow one another.
  const tableOf = new Map(), bindings = [];
  const entry = (channelId, freq, slot) => {
    const at = where(channelId);
    if (!tableOf.has(channelId)) tableOf.set(channelId, { core: at.core, channel: at.channel, freq, slots: [], lines: 0 });
    const table = tableOf.get(channelId);
    if (table.freq !== freq) throw Error("Channel " + channelId + " is given two carrier frequencies. A channel has one carrier.");
    const index = table.slots.length;
    table.slots.push({ slot: index, ...slot, env: table.lines });
    table.lines += slot.dur;
    return { at, index };
  };
  const bind = ({ at, index }, id, part, delayPs, detail) => bindings.push({ core: at.core, channel: at.index, slot: index, id, part, delayPs, detail });
  const calibration = { source: "hardware design " + (design.name ?? ""), qubits: [], pairs: [] };
  design.qubits.forEach((q, i) => {
    const drive = pathDelay(design, where(q.gate).converter, q.part);
    for (const gate of ["x90", "x"])
      bind(entry(q.gate, freqCode(q.freqHz, spec), { amp: ampCode(q[gate].amp), phase: phaseCode(q[gate].phaseRad ?? 0), dur: span(q[gate].durNs) }),
        q.part + "." + gate, q.part, drive, { kind: "drive", gate, qubit: i });
    // An unconditional reset pulse, when the design calibrates one, is the gate channel's next slot.
    if (q.reset)
      bind(entry(q.gate, freqCode(q.freqHz, spec), { amp: ampCode(q.reset.amp), phase: phaseCode(q.reset.phaseRad ?? 0), dur: span(q.reset.durNs) }),
        q.part + ".reset", q.part, drive, { kind: "reset", qubit: i });
    const r = q.readout;
    bind(entry(q.ro, freqCode(r.freqHz, spec), { amp: ampCode(r.amp), dur: span(r.durNs) }),
      q.part + ".readout", q.resonator, pathDelay(design, where(q.ro).converter, q.resonator), { kind: "readout-tone", qubit: i });
    // The demodulation carrier advances per ADC sample: four times the DAC code (units.py _demod_code).
    const demodFreq = (((BATCH_SIZE / ADC_BATCH) * freqCode(r.freqHz, spec) + 32768) & 0xffff) - 32768;
    bind(entry(q.demod, demodFreq, { amp: AMP_SCALE, phase: phaseCode(r.demodPhaseRad ?? 0), dur: span(r.demodNs) }),
      q.part + ".acquire", q.resonator, 0, { kind: "acquire", qubit: i });
    const seconds = (gate) => ({ time: q[gate].durNs * 1e-9, virtualZ: q[gate].virtualZ ?? [] });
    calibration.qubits.push({ qubit: i, freq: q.freqHz, X90: seconds("x90"), X: seconds("x"),
      ...(q.reset ? { reset: { time: q.reset.durNs * 1e-9 } } : {}),
      readout: { freq: r.freqHz, time: r.durNs * 1e-9, demod: { delay: r.demodDelayNs * 1e-9, time: r.demodNs * 1e-9 } } });
  });
  const czChannels = new Map();
  for (const c of design.couplings ?? []) {
    const pair = { pair: c.qubits, freq: c.freqHz, sandwich: [], pulses: c.pulses.map((p) => ({ qubit: p.qubit, time: c.durNs * 1e-9 })),
      virtualZ: (c.virtualZ ?? []).map((z) => ({ qubit: z.qubit, phase: z.phaseRad })) };
    calibration.pairs.push(pair);
    for (const p of c.pulses) {
      const q = design.qubits[p.qubit];
      bind(entry(p.channel, freqCode(c.freqHz, spec), { amp: ampCode(p.amp), phase: phaseCode(p.phaseRad ?? 0), dur: span(c.durNs) }),
        q.part + ".cz" + c.qubits.join("-"), q.part, pathDelay(design, where(p.channel).converter, q.part), { kind: "cz-drive", pair: c.qubits, qubit: p.qubit });
      czChannels.set(p.qubit + "/" + c.qubits.join("-"), where(p.channel));
    }
  }
  const locate = (qubit, role, pair) => {
    const at = role === "cz" ? czChannels.get(qubit + "/" + pair.pair.join("-")) : where(design.qubits[qubit][role]);
    return { core: at.core, channel: at.channel };
  };
  return {
    platform: "superconducting", name: design.name ?? "hardware design", spec, calibration, pairs: calibration.pairs,
    tables: [...tableOf.values()].map(({ lines: _lines, ...table }) => table), bindings, span: (seconds) => span(seconds * 1e9), period,
    decoderCore: design.decoder === undefined ? -1 : coreParts.findIndex((c) => c.id === design.decoder),
    locate, design, warnings,
    provenance: {
      design: "hardware design document '" + (design.name ?? "") + "': " + design.parts.length + " parts, " + design.channels.length + " channels, " + design.wires.length + " wires",
      delay: "routed wire length over the signal speed of its medium (machine/interconnect.mjs)",
      ...(warnings.length ? { warnings: warnings.join(" ") } : {}),
    },
  };
}

/** Physical layout of a design for display: the parts and the wires with their lengths and delays. */
export function layout(design) {
  return {
    kind: "hardware-design", version: 1, name: design.name,
    units: { position: "mm", micrometresPerUnit: 1000 },
    basis: "Positions and wire routes are the hardware design's own values in mm. A wire's delay is its routed length over the signal speed of its medium.",
    schematic: "Part sizes and shapes.",
    parts: design.parts.map((part) => ({ id: part.id, type: part.type, centerMm: part.centerMm })),
    channels: design.channels.map((channel) => ({ id: channel.id, core: channel.core, kind: channel.kind, converter: channel.converter })),
    wires: design.wires.map((wire) => ({ id: wire.id, from: wire.from, to: wire.to, medium: wire.medium, routeMm: wire.routeMm, ...wireTiming(wire) })),
  };
}

/**
 * The eight-transmon ring of RISC-Q's example calibration, written as a hardware design that
 * can be edited: one core per qubit on a board at `boardMm`, the chip `chipMm` away, and one
 * coax per drive line, readout line and return line, routed with a right-angle bend.
 * Positions are this project's choice. The calibration gives no geometry.
 */
export function ringDesign({ boardMm = [0, 0, 0], chipMm = [700, 0, -350], decoder = false } = {}) {
  const calibration = JSON.parse(readFileSync(new URL("../validation/riscq/x6y3-calibration.json", import.meta.url), "utf8"));
  const build = JSON.parse(readFileSync(new URL("../validation/riscq/x6y3.json", import.meta.url), "utf8"));
  const pairs = calibration.pairs.filter((p) => !p.sandwich.length);
  const add = (a, b) => a.map((v, k) => v + b[k]);
  const parts = [{ id: "board", type: "control-board", centerMm: boardMm }], channels = [], wires = [], qubits = [], couplings = [];
  const converters = new Map();
  const converter = (type, index) => {
    const id = type + index;
    if (!converters.has(id)) {
      converters.set(id, { id, type, index, centerMm: add(boardMm, [60, 12 * index - 90, type === "adc" ? -20 : 0]) });
      parts.push(converters.get(id));
    }
    return converters.get(id);
  };
  // A coax from a converter runs along x at the board's height, then drops to the chip.
  const coax = (id, from, to) => wires.push({ id, from: from.id, to: to.id, medium: "coax",
    routeMm: [from.centerMm, [to.centerMm[0], from.centerMm[1], from.centerMm[2]], [to.centerMm[0], to.centerMm[1], from.centerMm[2]], to.centerMm] });
  const n = calibration.qubits.length;
  for (const q of calibration.qubits) {
    const i = q.qubit, angle = (2 * Math.PI * i) / n;
    const core = { id: "q" + i, type: "core", centerMm: add(boardMm, [0, 12 * i - 42, 0]) };
    const qubit = { id: "qubit" + i, type: "qubit", centerMm: add(chipMm, [3 * Math.cos(angle), 3 * Math.sin(angle), 0].map((v) => Number(v.toFixed(3)))) };
    const resonator = { id: "resonator" + i, type: "resonator", centerMm: add(chipMm, [4.5 * Math.cos(angle), 4.5 * Math.sin(angle), 0].map((v) => Number(v.toFixed(3)))) };
    parts.push(core, qubit, resonator);
    const gateDac = converter("dac", build.dac_map[i][0]), roDac = converter("dac", build.dac_map[i][1]), adc = converter("adc", build.adc_map[i]);
    channels.push({ id: core.id + ".gate", core: core.id, name: "gate", kind: "pulse", converter: gateDac.id, slots: 2, interp: build.gate_interp });
    pairs.filter((p) => p.pair.includes(i)).forEach((p, k) =>
      channels.push({ id: core.id + ".cz" + k, core: core.id, name: "cz" + k, kind: "pulse", converter: gateDac.id, slots: 1, interp: build.gate_interp, pair: p.pair }));
    channels.push({ id: core.id + ".ro", core: core.id, name: "ro", kind: "pulse", converter: roDac.id, slots: 1, interp: build.readout_interp },
      { id: core.id + ".demod", core: core.id, name: "demod", kind: "demod", converter: adc.id, slots: 1, interp: build.demod_interp ?? 4 });
    coax("drive" + i, gateDac, qubit);
    coax("tone" + i, roDac, resonator);
    wires.push({ id: "return" + i, from: resonator.id, to: adc.id, medium: "coax",
      routeMm: [resonator.centerMm, [resonator.centerMm[0], resonator.centerMm[1], adc.centerMm[2]], [resonator.centerMm[0], adc.centerMm[1], adc.centerMm[2]], adc.centerMm] });
    const gate = (g) => ({ amp: g.amp, phaseRad: g.phase, durNs: g.time * 1e9, envelope: g.env, virtualZ: g.virtualZ });
    qubits.push({ part: qubit.id, resonator: resonator.id, gate: core.id + ".gate", ro: core.id + ".ro", demod: core.id + ".demod", freqHz: q.freq,
      x90: gate(q.X90), x: gate(q.X),
      readout: { freqHz: q.readout.freq, amp: q.readout.amp, durNs: q.readout.time * 1e9, envelope: q.readout.env,
        demodDelayNs: q.readout.demod.delay * 1e9, demodNs: q.readout.demod.time * 1e9, demodPhaseRad: q.readout.demod.phase } });
  }
  for (const p of pairs)
    couplings.push({ qubits: p.pair, freqHz: p.freq, durNs: p.pulses[0].time * 1e9,
      pulses: p.pulses.map((pulse) => ({ qubit: pulse.qubit, amp: pulse.amp, phaseRad: pulse.phase, envelope: pulse.env,
        channel: channels.find((c) => c.core === "q" + pulse.qubit && c.pair === p.pair).id })),
      virtualZ: p.virtualZ.map((z) => ({ qubit: z.qubit, phaseRad: z.phase })) });
  if (decoder) {
    parts.push({ id: "decoder", type: "core", centerMm: add(boardMm, [0, 12 * n - 42, 0]) });
    channels.push({ id: "decoder.status", core: "decoder", name: "status", kind: "dio", slots: 1 },
      // RISC-Q builds a demod channel into every core; the decoder's shares the readout ADC and is unused.
      { id: "decoder.demod", core: "decoder", name: "demod", kind: "demod", converter: converter("adc", build.adc_map[0]).id, slots: 1, interp: build.demod_interp ?? 4 });
  }
  // A plain document: no part and route share an array.
  return JSON.parse(JSON.stringify({
    kind: "riscq-design", version: 1, name: "x6y3 ring as a hardware design",
    board: { dspHz: build.dsp_freq_hz, linkStages: build.link_pipe, memWords: build.mem_depth, queueDepth: build.queue_depth, envDepth: build.env_depth },
    parts, channels: channels.map(({ pair: _pair, ...channel }) => channel), wires, qubits, couplings, ...(decoder ? { decoder: "decoder" } : {}),
  }));
}
