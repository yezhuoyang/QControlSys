// Superconducting platform: OpenQASM → native hardware instructions → RISC-Q channel actions.
//
// Machine: the eight-transmon ring of RISC-Q's example calibration (examples/cal-config-x6y3.yaml)
// on the RISC-Q `x6y3` build (500 MHz dspClk, 8 GS/s DAC, 2 GS/s ADC). One RV32I core per qubit.
// Native instructions and their calibrated realization:
//   x90, x     one shaped drive pulse on the qubit's drive line (35 ns and 70 ns)
//   frame      a virtual Z: later drive pulses of that qubit are fired with a phase offset
//   cz         two simultaneous 400 ns drive tones, one on each qubit's line, then frame updates
//   measure    a readout tone, then a demodulation window on the shared ADC that yields one bit
// With `machine({ decoder: true })` the build has one more core that plays no pulse:
//   decode       a lookup decoder: measured bits index a table of correction words
//   pauli-frame  flips bits of a qubit's Pauli-frame word in that core's memory
// Boundaries: the two pairs whose CZ needs a pulse on the second excited level, (5,6) and (6,7),
// are not offered. Each qubit core carries one extra drive channel per CZ partner so that no
// carrier is retuned between gates. That channel list is this project's build choice. Pulse
// windows are whole batches of 2 ns. The envelope carries the shape inside the window.
import { readFileSync } from "node:fs";
import { parseQasm } from "../../machine/qasm.mjs";
import { socSpec, freqCode, phaseCode, ampCode, BATCH_SIZE, ADC_BATCH, AMP_SCALE } from "../soc.mjs";

const calibrationUrl = new URL("../../validation/riscq/x6y3-calibration.json", import.meta.url);
const buildUrl = new URL("../../validation/riscq/x6y3.json", import.meta.url);

/** Coax from the room-temperature flange to the chip: Krinner et al. Table 1, 200+290+250+170+140 mm. */
const CRYOSTAT_COAX_MM = 1050;
/** Assumed velocity factor of the coax, 0.7 c. */
const COAX_MM_PER_NS = 0.7 * 299.792458;

/**
 * The reference machine: build description, calibration, pulse tables and apparatus bindings.
 * `decoder` adds a core that decodes measured bits and keeps the Pauli frame. RISC-Q requires
 * every core to have a channel, so it carries one digital channel, which it does not use.
 */
export function machine({ decoder = false } = {}) {
  const calibration = JSON.parse(readFileSync(calibrationUrl, "utf8"));
  const build = JSON.parse(readFileSync(buildUrl, "utf8"));
  const pairs = calibration.pairs.filter((p) => !p.sandwich.length);
  const partners = (q) => pairs.filter((p) => p.pair.includes(q));
  const czChannel = (q, pair) => "cz" + partners(q).indexOf(pair);
  const cores = calibration.qubits.map((q) => ({
    name: "q" + q.qubit,
    channels: [
      { name: "gate", kind: "pulse", dac: build.dac_map[q.qubit][0], slots: 2, env_depth: build.env_depth, interp: build.gate_interp },
      ...partners(q.qubit).map((pair) => ({
        name: czChannel(q.qubit, pair), kind: "pulse", dac: build.dac_map[q.qubit][0], slots: 1,
        env_depth: build.env_depth, interp: build.gate_interp })),
      { name: "ro", kind: "pulse", dac: build.dac_map[q.qubit][1], slots: 1, env_depth: build.env_depth, interp: build.readout_interp },
      { name: "demod", kind: "demod", adc: build.adc_map[q.qubit], slots: 1, env_depth: build.env_depth, interp: build.demod_interp ?? 4 },
    ],
  }));
  if (decoder) cores.push({ name: "decoder", channels: [{ name: "status", kind: "dio", slots: 1 }] });
  const spec = socSpec({
    name: "x6y3-ring", dsp_freq_hz: build.dsp_freq_hz, link_pipe: build.link_pipe,
    core_defaults: { mem_depth: build.mem_depth, with_mul: build.with_mul, queue_depth: build.queue_depth },
    cores,
  });
  const period = spec.dspPeriodPs;
  const span = (seconds) => Math.ceil((seconds * 1e12) / period - 1e-9);
  const delayPs = Math.round((1000 * CRYOSTAT_COAX_MM) / COAX_MM_PER_NS);
  const tables = [], bindings = [], envelopes = [];
  let line = 0;
  const envelope = (core, channel, kind, batches) => {
    const base = line;
    line += batches;
    envelopes.push({ core, channel, base, lines: batches, shape: kind });
    return base;
  };
  for (const q of calibration.qubits) {
    const core = q.qubit;
    line = 0;
    tables.push({
      core, channel: "gate", freq: freqCode(q.freq, spec),
      slots: [
        { slot: 0, amp: ampCode(q.X90.amp), phase: phaseCode(q.X90.phase), dur: span(q.X90.time), env: envelope(core, "gate", q.X90.env, span(q.X90.time)) },
        { slot: 1, amp: ampCode(q.X.amp), phase: phaseCode(q.X.phase), dur: span(q.X.time), env: envelope(core, "gate", q.X.env, span(q.X.time)) },
      ],
    });
    bindings.push(
      { core, channel: 0, slot: 0, id: "q" + core + ".x90", part: "qubit" + core, delayPs, detail: { kind: "drive", gate: "x90", qubit: core } },
      { core, channel: 0, slot: 1, id: "q" + core + ".x", part: "qubit" + core, delayPs, detail: { kind: "drive", gate: "x", qubit: core } });
    for (const pair of partners(core)) {
      const pulse = pair.pulses.find((p) => p.qubit === core);
      const channel = czChannel(core, pair);
      line = 0;
      tables.push({
        core, channel, freq: freqCode(pair.freq, spec),
        slots: [{ slot: 0, amp: ampCode(pulse.amp), phase: phaseCode(pulse.phase), dur: span(pulse.time), env: envelope(core, channel, pulse.env, span(pulse.time)) }],
      });
      bindings.push({
        core, channel: spec.cores[core].channels.findIndex((ch) => ch.name === channel), slot: 0,
        id: "q" + core + ".cz" + pair.pair.join("-"), part: "qubit" + core, delayPs,
        detail: { kind: "cz-drive", pair: pair.pair, qubit: core } });
    }
    const ro = q.readout;
    const demodIndex = spec.cores[core].channels.findIndex((ch) => ch.name === "demod");
    line = 0;
    tables.push({ core, channel: "ro", freq: freqCode(ro.freq, spec),
      slots: [{ slot: 0, amp: ampCode(ro.amp), dur: span(ro.time), env: envelope(core, "ro", ro.env, span(ro.time)) }] });
    line = 0;
    // The demodulation carrier advances per ADC sample: four times the DAC code (units.py _demod_code).
    const demodFreq = (((BATCH_SIZE / ADC_BATCH) * freqCode(ro.freq, spec) + 32768) & 0xffff) - 32768;
    tables.push({ core, channel: "demod", freq: demodFreq,
      slots: [{ slot: 0, amp: AMP_SCALE, phase: phaseCode(ro.demod.phase), dur: span(ro.demod.time), env: envelope(core, "demod", "cosine_square", span(ro.demod.time)) }] });
    bindings.push(
      { core, channel: demodIndex - 1, slot: 0, id: "q" + core + ".readout", part: "resonator" + core, delayPs, detail: { kind: "readout-tone", qubit: core } },
      { core, channel: demodIndex, slot: 0, id: "q" + core + ".acquire", part: "resonator" + core, delayPs: 0, detail: { kind: "acquire", qubit: core } });
  }
  return {
    platform: "superconducting", name: "RISC-Q x6y3 ring", spec, calibration, pairs, tables, bindings, envelopes,
    czChannel, span, period, decoderCore: decoder ? cores.length - 1 : -1,
    provenance: {
      calibration: calibration.source,
      build: "RISC-Q software/configs/x6y3.json with one added drive channel per CZ partner" +
        (decoder ? " and one decoder core" : ""),
      delay: CRYOSTAT_COAX_MM + " mm of coax (Krinner et al. 2019, Table 1) at an assumed 0.7 c",
    },
  };
}

const PI = Math.PI;
/** Standard gates as native instructions, in circuit order. `u` is ZSXZSXZ up to a global phase. */
function nativeGate(name, params, fail) {
  const vz = (angle) => ({ op: "frame", angle });
  const u = (theta, phi, lambda) => [vz(lambda), { op: "x90" }, vz(theta + PI), { op: "x90" }, vz(phi + PI)];
  switch (name) {
    case "id": return [];
    case "x": return [{ op: "x" }];
    case "sx": return [{ op: "x90" }];
    case "z": return [vz(PI)];
    case "s": return [vz(PI / 2)];
    case "sdg": return [vz(-PI / 2)];
    case "t": return [vz(PI / 4)];
    case "tdg": return [vz(-PI / 4)];
    case "rz": case "p": return [vz(params[0])];
    case "h": return [vz(PI / 2), { op: "x90" }, vz(PI / 2)];
    case "y": return [vz(PI), { op: "x" }];
    case "rx": return u(params[0], -PI / 2, PI / 2);
    case "ry": return u(params[0], 0, 0);
    case "U": return u(params[0], params[1], params[2]);
    default: return fail("no native decomposition for " + name + ".");
  }
}
/** One- and two-qubit calls as native instructions on named operands. */
export function decompose(call, fail) {
  const { name, targets, params = [] } = call;
  const on = (ops, q) => ops.map((o) => ({ ...o, qubits: [q] }));
  const one = (gate, q, p = []) => on(nativeGate(gate, p, fail), q);
  const cz = (a, b) => [{ op: "cz", qubits: [a, b] }];
  const cx = (c, t) => [...one("h", t), ...cz(c, t), ...one("h", t)];
  switch (name) {
    case "cz": return cz(targets[0], targets[1]);
    case "cx": return cx(targets[0], targets[1]);
    case "cy": return [...one("sdg", targets[1]), ...cx(targets[0], targets[1]), ...one("s", targets[1])];
    case "swap": return [...cx(targets[0], targets[1]), ...cx(targets[1], targets[0]), ...cx(targets[0], targets[1])];
    case "ch": case "ccx": return fail("lower " + name + " to one- and two-qubit gates before this back end.");
    default: return one(name, targets[0], params);
  }
}

/**
 * Schedule an OpenQASM program on the machine as native hardware instructions.
 * Times are picoseconds on the batch grid. Each instruction starts as soon as its qubits are
 * free. A measurement whose bit conditions a later gate ends a segment: the conditioned gate
 * runs in the next segment, after the cores have exchanged the bit.
 * `layout` maps an OpenQASM operand such as "q[2]" to a physical qubit.
 */
export function schedule(qasm, m, options = {}) {
  return scheduleBody(parseQasm(qasm).tracks[0].body, m, options);
}

const PAULI = { X: 1, Z: 2, Y: 3 };

/**
 * Schedule a program of system calls. The calls are those of the fault-tolerant virtual
 * machine that this machine realizes on physical qubits:
 *   { call: "gate", name, qubits: [physical], params?, when? }
 *   { call: "measure", qubit, bit }
 *   { call: "decode_syndrome", bits: [measured bits], lut: [correction word per syndrome], into: [decoded bits] }
 *   { call: "pauli_frame_update", when: bit, pauli: "X" | "Y" | "Z", qubit }
 * `lut[s]` is the correction for the syndrome whose bit i is `bits[i]`, and bit j of it becomes
 * `into[j]`. Decoding and frame updates run on the decoder core and play no pulse. A gate
 * conditioned on a decoded bit runs after the cores have met again.
 * `request_ancilla`, `route` and `request_magic` have no realization here: the calibration
 * has no reset pulse, the couplers are fixed, and there is no factory.
 */
export function scheduleCalls(program, m) {
  // "ftqvm-calls" is the kind's older name and is still accepted.
  if (!["system-calls", "ftqvm-calls"].includes(program?.kind) || program.version !== 1 || !Array.isArray(program.calls))
    throw Error("A system-call program is { kind: \"system-calls\", version: 1, calls: [...] }.");
  const body = [];
  program.calls.forEach((c, i) => {
    const origin = "call " + i + " · " + c.call;
    const operand = (q) => "$" + q;
    if (c.call === "gate") {
      const call = { name: c.name, targets: (c.qubits ?? []).map(operand), params: c.params ?? [] };
      body.push(c.when !== undefined ? { ifBit: { bit: c.when, then: [{ call, origin }] }, origin } : { call, origin });
    } else if (c.call === "measure") {
      body.push({ call: { name: "measure", targets: [operand(c.qubit)] }, origin }, { capture: c.bit, origin });
    } else if (c.call === "decode_syndrome") body.push({ decode: { inputs: c.bits, outputs: c.into, table: c.lut }, origin });
    else if (c.call === "pauli_frame_update") body.push({ frameUpdate: { when: c.when, pauli: c.pauli, qubit: c.qubit }, origin });
    else throw Error(origin + " — this machine realizes gate, measure, decode_syndrome and pauli_frame_update.");
  });
  return scheduleBody(body, m);
}

function scheduleBody(body, m, { layout } = {}) {
  const place = (operand, where) => {
    const physical = layout ? layout[operand] : /^\$(\d+)$/.exec(operand)?.[1] ?? /\[(\d+)\]$/.exec(operand)?.[1] ?? (operand.includes("[") ? undefined : 0);
    const q = Number(physical);
    if (physical === undefined || !Number.isInteger(q) || !m.calibration.qubits[q])
      throw Error(where + " — operand " + operand + " has no physical qubit on " + m.name + ".");
    return q;
  };
  const period = m.period;
  const segments = [{ ops: [] }];
  let free = new Map(), counter = 0;
  const conditioned = new Set(body.filter((n) => n.ifBit).map((n) => n.ifBit.bit));
  const pendingBits = new Set();
  const measured = new Set(), decoded = new Set();
  // Pulses and classical work alternate in segments. The cores meet at a barrier between them.
  const enter = (classical) => {
    const last = segments.at(-1);
    if (!!last.classical === classical) return;
    if (!last.ops.length && !last.classical) last.classical = classical;
    else segments.push({ ops: [], ...(classical ? { classical } : {}) });
    free = new Map();
    pendingBits.clear();
  };
  const classicalOp = (op) => {
    if (m.decoderCore < 0) throw Error(op.source + " — this build has no decoder core.");
    enter(true);
    segments.at(-1).ops.push({ id: "h" + counter++, ...op, t: 0, dur: 0 });
  };
  const emit = (op) => {
    const start = Math.max(0, ...op.qubits.map((q) => free.get(q) ?? 0));
    const end = start + op.dur;
    for (const q of op.qubits) free.set(q, end);
    segments.at(-1).ops.push({ id: "h" + counter++, ...op, t: start });
  };
  const lower = (call, origin, when) => {
    const fail = (message) => {
      throw Error(origin + " — " + message);
    };
    if (call.name === "measure") {
      const q = place(call.targets[0], origin);
      const ro = m.calibration.qubits[q].readout;
      const tone = m.span(ro.time), delay = m.span(ro.demod.delay), window = m.span(ro.demod.time);
      return emit({ op: "measure", qubits: [q], dur: Math.max(tone, delay + window) * period,
        params: { tonePs: tone * period, delayPs: delay * period, windowPs: window * period }, source: origin });
    }
    for (const native of decompose({ ...call, targets: call.targets.map((t) => place(t, origin)) }, fail)) {
      const base = { ...native, source: origin, ...(when !== undefined ? { when } : {}) };
      if (native.op === "frame") emit({ ...base, dur: 0 });
      else if (native.op === "cz") {
        const [a, b] = native.qubits;
        const pair = m.pairs.find((p) => p.pair.includes(a) && p.pair.includes(b));
        if (!pair) fail("no calibrated CZ between qubits " + a + " and " + b + ". Route the circuit onto the ring first.");
        emit({ ...base, dur: m.span(pair.pulses[0].time) * period, params: { pair: pair.pair } });
        // The calibration ends the CZ with frame corrections, including on a spectator.
        for (const z of pair.virtualZ)
          segments.at(-1).ops.push({ id: "h" + counter++, op: "frame", qubits: [z.qubit], angle: z.phase, dur: 0,
            t: free.get(a), source: origin + " · CZ frame correction", ...(when !== undefined ? { when } : {}) });
      } else {
        const cal = m.calibration.qubits[native.qubits[0]][native.op === "x" ? "X" : "X90"];
        for (const angle of cal.virtualZ.slice(0, 1)) emit({ ...base, op: "frame", angle, dur: 0 });
        emit({ ...base, dur: m.span(cal.time) * period });
        for (const angle of cal.virtualZ.slice(1)) emit({ ...base, op: "frame", angle, dur: 0 });
      }
    }
  };
  for (const node of body) {
    if (node.call) {
      enter(false);
      lower(node.call, node.origin);
    } else if (node.capture !== undefined) {
      const measure = segments.at(-1).ops.at(-1);
      measure.result = node.capture;
      measured.add(node.capture);
      if (conditioned.has(node.capture)) pendingBits.add(node.capture);
    } else if (node.decode) {
      const { inputs, outputs, table } = node.decode;
      const fail = (message) => {
        throw Error(node.origin + " — " + message);
      };
      if (!Array.isArray(inputs) || !inputs.length || inputs.some((bit) => !measured.has(bit))) fail("decode takes measured bits.");
      if (!Array.isArray(outputs) || !outputs.length || outputs.some((bit) => measured.has(bit) || decoded.has(bit)))
        fail("the decoded bits need new names.");
      if (!Array.isArray(table) || table.length !== 2 ** inputs.length ||
          table.some((word) => !Number.isInteger(word) || word < 0 || word >= 2 ** outputs.length))
        fail("the lookup table has one correction word of " + outputs.length + " bits for each of the " + 2 ** inputs.length + " syndromes.");
      classicalOp({ op: "decode", qubits: [], inputs, outputs, table, source: node.origin });
      for (const bit of outputs) decoded.add(bit);
    } else if (node.frameUpdate) {
      const { when, pauli, qubit } = node.frameUpdate;
      if (!measured.has(when) && !decoded.has(when)) throw Error(node.origin + " — bit " + when + " is not measured or decoded yet.");
      if (!PAULI[pauli] || !m.calibration.qubits[qubit]) throw Error(node.origin + " — name a Pauli X, Y or Z and a qubit of " + m.name + ".");
      classicalOp({ op: "pauli-frame", qubits: [qubit], when, pauli, source: node.origin });
    } else if (node.ifBit) {
      enter(false);
      if (pendingBits.has(node.ifBit.bit)) {
        // The bit crosses cores between segments, so the conditioned gate starts a new one.
        segments.push({ ops: [] });
        free = new Map();
        pendingBits.clear();
      }
      for (const inner of node.ifBit.then) lower(inner.call, inner.origin ?? node.origin, node.ifBit.bit);
    }
  }
  for (const segment of segments) segment.span = Math.max(0, ...segment.ops.map((op) => op.t + op.dur));
  return { kind: "hardware-program", version: 1, platform: "superconducting", machine: m.name, timeUnit: "ps", segments };
}

/** Lower native hardware instructions to timed channel actions on the machine's cores. */
export function lower(hardware, m) {
  const period = m.period;
  const batch = (ps) => {
    if (ps % period) throw Error("Hardware instruction time " + ps + " ps is off the " + period + " ps batch grid.");
    return ps / period;
  };
  const actions = [];
  const frame = new Map();
  const readouts = [];
  // Which core and channel plays a role for a qubit. The built-in ring has one core per qubit
  // with fixed channel names. A machine built from a hardware design supplies `locate`.
  const locate = m.locate ?? ((q, role, pair) => ({ core: q, channel: role === "cz" ? m.czChannel(q, pair) : role }));
  hardware.segments.forEach((segment, s) => {
    if (segment.classical) {
      // Classical work runs on the decoder core in program order, as soon as the cores have met.
      for (const op of segment.ops) {
        if (op.op === "decode")
          actions.push({ segment: s, core: m.decoderCore, at: 0, decode: { inputs: op.inputs, table: op.table, outputs: op.outputs }, source: op.id });
        else if (op.op === "pauli-frame")
          actions.push({ segment: s, core: m.decoderCore, at: 0, when: op.when, frame: { name: "frame:q" + op.qubits[0], mask: PAULI[op.pauli] }, source: op.id });
        else throw Error("Unknown classical instruction " + op.op + ".");
      }
      return;
    }
    // Frame updates apply to drive pulses that start at or after them, in time order.
    for (const op of [...segment.ops].sort((x, y) => x.t - y.t || (x.op === "frame" ? -1 : 1))) {
      const at = batch(op.t);
      const when = op.when !== undefined ? { when: op.when } : {};
      const [q] = op.qubits;
      if (op.op === "frame") {
        if (op.when !== undefined) throw Error(op.source + " — a conditioned gate that changes a frame is not supported yet.");
        frame.set(q, (frame.get(q) ?? 0) - op.angle);
      } else if (op.op === "x90" || op.op === "x") {
        const gate = locate(q, "gate");
        actions.push({ segment: s, core: gate.core, at, fire: { channel: gate.channel, slot: op.op === "x" ? 1 : 0 },
          phaseOffset: phaseCode(frame.get(q) ?? 0), source: op.id, ...when });
      } else if (op.op === "cz") {
        const pair = m.pairs.find((p) => p.pair.every((x) => op.qubits.includes(x)));
        for (const x of op.qubits) {
          const tone = locate(x, "cz", pair);
          actions.push({ segment: s, core: tone.core, at, fire: { channel: tone.channel, slot: 0 }, source: op.id, ...when });
        }
      } else if (op.op === "measure") {
        const { tonePs, delayPs, windowPs } = op.params;
        void tonePs;
        const ro = locate(q, "ro"), demod = locate(q, "demod");
        actions.push({ segment: s, core: ro.core, at, fire: { channel: ro.channel, slot: 0 }, source: op.id });
        actions.push({ segment: s, core: demod.core, at: at + batch(delayPs), fire: { channel: demod.channel, slot: 0 }, source: op.id });
        actions.push({ segment: s, core: demod.core, at: at + batch(delayPs), bit: op.result ?? op.id,
          read: { channel: demod.channel, until: at + batch(delayPs) + batch(windowPs) }, source: op.id });
        readouts.push({ qubit: q, core: demod.core, channel: demod.channel, bit: op.result ?? op.id, op: op.id });
      } else throw Error("Unknown superconducting instruction " + op.op + ".");
    }
  });
  return {
    tables: m.tables,
    // A classical segment has no span: the cores go on as soon as the decoder is done.
    segments: hardware.segments.map((segment) => ({ span: segment.classical ? undefined : batch(segment.span) })),
    actions,
    readouts,
  };
}

/** Readout results for the Lean model, in window order per qubit. `outcomes` maps a bit name to 0 or 1. */
export function readoutOracle(lowered, m, outcomes = {}) {
  return lowered.readouts.map((r) => ({
    core: r.core,
    channel: m.spec.cores[r.core].channels.findIndex((ch) => ch.name === r.channel),
    res: outcomes[r.bit] ?? 0,
    // The result bit is the sign of the real integral (ReadoutDecoder.md). Magnitudes are illustrative.
    real: outcomes[r.bit] ? -20000 : 20000,
    imag: 0,
  }));
}
