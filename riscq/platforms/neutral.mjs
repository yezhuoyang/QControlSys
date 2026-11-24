// Neutral-atom platform: a ZAC compiled program → hardware instructions → RISC-Q actions.
//
// ZAC emits timed instructions for a zoned tweezer array: global one-qubit gates, Rydberg
// pulses, and rearrangement jobs that pick atoms up with a crossed AOD, move them and drop
// them. This module adds the controller underneath:
//   pickup, drop   each active AOD tone ramps its RF amplitude up or down
//   move           each tone holds its amplitude while its RF frequency steps along the path
//   raman, rydberg one laser modulator pulse for the instruction's duration
// Machine: one RISC-Q core per AOD with one pulse channel per row tone and column tone, and a
// laser core. Each tone's position follows its RF frequency through a linear calibration.
// Boundaries: a frequency step is not phase continuous on the RISC-Q pulse generator. The
// 16-bit frequency code at 1.6 GS/s moves a tone in steps of 24.4 kHz, which is 244 nm at the
// 10 nm/kHz design slope used elsewhere in this project. The path inside a move is an assumed
// constant-acceleration profile that matches ZAC's square-root duration law. ZAC does not say
// which beams address single atoms, so a one-qubit instruction is one global pulse. Atoms are
// assumed to follow their tones. Loss, heating and imaging are not modeled.
import { socSpec, freqCode, AMP_SCALE } from "../soc.mjs";
import { STANDARD } from "../standards.mjs";

/** DSP clock of the atom controller: 100 MHz, so one batch is 10 ns. */
const DSP_HZ = 100e6;
/** RF calibration of an AOD axis: design slope 10 nm/kHz (machine/neutral-installation.mjs). */
export const HZ_PER_UM = STANDARD.neutral.hzPerUm.value, BASE_HZ = 80e6;
/** Acoustic transit from the transducer to the beam, as in machine/neutral-installation.mjs. */
const ACOUSTIC_PS = STANDARD.neutral.acousticNs.value * 1000;
/** Batches between frequency steps of a move: 2 µs. */
export const STEP_BATCHES = 200;

/** Control machine for a ZAC program: tone channels sized to the widest rearrangement job. */
export function machine(code, architecture) {
  const jobs = code.instructions.filter((i) => i.type === "rearrangeJob");
  const tones = (axis) => Math.max(1, ...jobs.flatMap((j) => j.insts.map((i) => (i[axis + "_id"] ?? []).length)));
  const rows = tones("row"), cols = tones("col");
  const aods = [...new Set(jobs.map((j) => j.aod_id))].sort();
  let dac = 0;
  const cores = aods.map((id) => {
    const x = dac++, y = dac++;
    return {
      name: "aod" + id,
      channels: [
        ...Array.from({ length: cols }, (_, c) => ({ name: "x" + c, kind: "pulse", dac: x, slots: 48, env_depth: 4096, interp: 16 })),
        ...Array.from({ length: rows }, (_, r) => ({ name: "y" + r, kind: "pulse", dac: y, slots: 48, env_depth: 4096, interp: 16 })),
      ],
    };
  });
  cores.push({ name: "laser", channels: [
    { name: "raman", kind: "pulse", dac: dac++, slots: 8, env_depth: 1024, interp: 4 },
    { name: "rydberg", kind: "pulse", dac: dac++, slots: 8, env_depth: 1024, interp: 4 },
  ] });
  const spec = socSpec({
    name: "zac-" + (architecture?.name ?? "array"), dsp_freq_hz: DSP_HZ, link_pipe: 4,
    core_defaults: { mem_depth: 16384, with_mul: true, queue_depth: 4 }, cores,
  });
  return {
    platform: "neutral", name: architecture?.name ?? "zoned array", spec, code, architecture, period: spec.dspPeriodPs,
    coreOf: (name) => spec.cores.findIndex((c) => c.name === name),
    /** Frequency code of a tone that places its spot at a coordinate in µm, and the position a code gives. */
    codeAt: (um) => freqCode(BASE_HZ + HZ_PER_UM * um, spec),
    umOf: (codeValue) => ((codeValue * 16 * DSP_HZ) / 65536 - BASE_HZ) / HZ_PER_UM,
    provenance: {
      schedule: "ZAC compiled program " + code.name,
      calibration: "linear AOD map, 10 nm/kHz design slope and 120 ns acoustic transit (machine/neutral-installation.mjs)",
      path: "assumed constant-acceleration profile inside each move",
    },
  };
}

/** Hardware instructions from the ZAC program. Times are picoseconds rounded to the batch grid. */
export function schedule(m) {
  const grid = (us) => Math.round((us * 1e6) / m.period) * m.period;
  const ops = [];
  for (const inst of m.code.instructions) {
    const source = "ZAC instruction " + inst.id + " (" + inst.type + ")";
    const span = (x) => ({ t: grid(x.begin_time), dur: grid(x.end_time) - grid(x.begin_time) });
    if (inst.type === "init") continue;
    if (inst.type === "1qGate")
      ops.push({ id: "z" + inst.id, op: "raman", ...span(inst), qubits: inst.gates.map((g) => g.q), params: { gates: inst.gates }, source });
    else if (inst.type === "rydberg")
      ops.push({ id: "z" + inst.id, op: "rydberg", ...span(inst), qubits: inst.gates.flatMap((g) => [g.q0, g.q1]),
        params: { zone: inst.zone_id, pairs: inst.gates.map((g) => [g.q0, g.q1]) }, source });
    else if (inst.type === "rearrangeJob")
      for (const step of inst.insts) {
        const base = { id: "z" + inst.id + "." + step.id, ...span(step), aod: inst.aod_id, qubits: inst.aod_qubits, source };
        if (step.type === "activate")
          ops.push({ ...base, op: "pickup",
            rows: step.row_id.map((id, k) => ({ id, at: step.row_y[k] })), cols: step.col_id.map((id, k) => ({ id, at: step.col_x[k] })) });
        else if (step.type.startsWith("move"))
          ops.push({ ...base, op: "move",
            rows: step.row_id.map((id, k) => ({ id, from: step.row_y_begin[k], to: step.row_y_end[k] })),
            cols: step.col_id.map((id, k) => ({ id, from: step.col_x_begin[k], to: step.col_x_end[k] })),
            atoms: (step.begin_coord?.[0] ?? []).map((b, k) => ({ atom: b.id, from: [b.x, b.y], to: [step.end_coord[0][k].x, step.end_coord[0][k].y] })) });
        else if (step.type === "deactivate")
          ops.push({ ...base, op: "drop", rows: step.row_id.map((id) => ({ id })), cols: step.col_id.map((id) => ({ id })) });
        else throw Error(source + " has an unsupported step " + step.type + ".");
      }
    else throw Error(source + " is not supported.");
  }
  const span = Math.max(0, ...ops.map((op) => op.t + op.dur));
  return { kind: "hardware-program", version: 1, platform: "neutral", machine: m.name, timeUnit: "ps", segments: [{ ops, span }] };
}

/** Fraction of the distance covered at fraction `s` of a move: accelerate to the midpoint, then decelerate. */
export const profile = (s) => (s < 0.5 ? 2 * s * s : 1 - 2 * (1 - s) * (1 - s));

/** Lower the hardware instructions to timed channel actions, pulse tables and bindings. */
export function lower(hardware, m) {
  const period = m.period;
  const batch = (ps) => Math.round(ps / period);
  const tables = new Map(), bindings = [], actions = [];
  const slot = (core, channel, key, entry, binding) => {
    const id = core + "/" + channel;
    if (!tables.has(id)) tables.set(id, { core, channel, freq: m.codeAt(0), slots: [], keys: new Map() });
    const t = tables.get(id);
    if (!t.keys.has(key)) {
      const index = t.slots.length;
      const spec = m.spec.cores[core].channels.find((ch) => ch.name === channel);
      if (index >= spec.slots) throw Error("Channel " + m.spec.cores[core].name + "." + channel + " needs more pulse-table entries than it has.");
      if (entry.dur < 1 || entry.dur > 65535) throw Error("A " + key + " pulse of " + entry.dur + " batches does not fit one pulse-table entry.");
      t.keys.set(key, index);
      t.slots.push({ slot: index, phase: 0, amp: AMP_SCALE, env: 0, ...entry });
      bindings.push({ core, channel: m.spec.cores[core].channels.indexOf(spec), slot: index,
        id: m.spec.cores[core].name + "." + channel + "#" + index, ...binding });
    }
    return t.keys.get(key);
  };
  for (const op of hardware.segments[0].ops) {
    const at = batch(op.t), dur = batch(op.dur);
    if (op.op === "raman" || op.op === "rydberg") {
      const core = m.coreOf("laser");
      const index = slot(core, op.op, op.op + "/" + dur, { dur }, { part: "beam:" + op.op, delayPs: 0, detail: { kind: op.op } });
      actions.push({ segment: 0, core, at, fire: { channel: op.op, slot: index }, source: op.id });
      continue;
    }
    const core = m.coreOf("aod" + op.aod);
    const tones = [...op.cols.map((c) => ({ ...c, channel: "x" + c.id, axis: "x" })), ...op.rows.map((r) => ({ ...r, channel: "y" + r.id, axis: "y" }))];
    for (const tone of tones) {
      const part = "aod" + op.aod + ":" + tone.channel;
      const fire = (kind) => actions.push({ segment: 0, core, at, source: op.id,
        fire: { channel: tone.channel, slot: slot(core, tone.channel, kind + "/" + dur, { dur }, { part, delayPs: ACOUSTIC_PS, detail: { kind, axis: tone.axis } }) } });
      if (op.op === "pickup") {
        actions.push({ segment: 0, core, at, freq: { channel: tone.channel, code: m.codeAt(tone.at) }, source: op.id });
        fire("ramp-up");
      } else if (op.op === "drop") fire("ramp-down");
      else {
        fire("hold");
        // The tone's frequency steps along the path. The last step lands on the destination.
        const steps = Math.max(1, Math.floor(dur / STEP_BATCHES));
        let previous = m.codeAt(tone.from);
        for (let k = 1; k <= steps; k++) {
          const code = m.codeAt(tone.from + (tone.to - tone.from) * profile(k / steps));
          if (code !== previous)
            actions.push({ segment: 0, core, at: at + Math.round((k * dur) / steps) - (k === steps ? 1 : 0),
              freq: { channel: tone.channel, code }, source: op.id });
          previous = code;
        }
      }
    }
  }
  return {
    tables: [...tables.values()].map(({ keys: _k, ...t }) => t),
    segments: [{ span: batch(hardware.segments[0].span) }],
    actions, bindings,
  };
}

/**
 * Tone positions over time, read back from the run: every carrier update that reached a tone
 * channel, converted to micrometres with the same calibration that produced its code.
 */
export function toneTimeline(result, m) {
  return result.summary.tones.map((tone) => ({
    part: tone.part, atBatch: tone.opens, um: m.umOf(tone.freq > 32767 ? tone.freq - 65536 : tone.freq), source: tone.source,
  }));
}
