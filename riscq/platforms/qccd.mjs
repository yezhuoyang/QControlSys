// Trapped-ion QCCD platform: a QCCD Studio program → hardware instructions → RISC-Q actions.
//
// An OpenQASM circuit is compiled to TSIR by QCCD Studio's compiler (bridge/qccd_compile.py).
// The hardware instructions are the cycles of QCCD Studio's own replay of a TSIR program
// (bridge/qccd_studio.py). Each cycle already states which ions move over which edges, which
// electrode control channels act, and when. This module adds the controller underneath:
//   transport   every engaged electrode control channel plays its waveform from a DAC
//   rotate, ms  a gate-zone core fires a laser modulator pulse with the gate's angle and phase
//   measure     a detection pulse, then the core counts photon edges on a digital input
//   cool        one broadcast cooling pulse
//   frame       a virtual Z, no hardware
// Machine: one RISC-Q core per gate zone (modulators and a photon counter), transport cores
// with one DAC channel per Studio control channel, and one core for broadcast light.
// Boundaries: electrode waveforms are baseband pulses on RISC-Q pulse channels. Studio's
// control channels are the wiring. Electrode voltages, ion motion and heating are Studio's
// models and are not recomputed here. Durations are Studio's cycle times scaled by `unitNs`,
// which is an input when Studio reports unit times. Photon counts are supplied by the caller.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { socSpec, phaseCode, AMP_SCALE } from "../soc.mjs";
import { STANDARD, values } from "../standards.mjs";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/**
 * Replay an architecture and TSIR program with QCCD Studio. Needs Python and the Studio checkout.
 * With `["--demo"]` and an empty input it returns Studio's H2 architecture and GHZ program.
 */
export function studioReplay(input, flags = []) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.QCONTROL_PYTHON || "python",
      ["-B", "-X", "utf8", path.join(root, "bridge", "qccd_studio.py"), ...flags],
      { windowsHide: true, timeout: 180000, maxBuffer: 1 << 28 },
      (error, stdout, stderr) => {
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {}
        if (error || parsed?.error) return reject(Error(parsed?.error || stderr.trim() || error.message));
        resolve(parsed);
      });
    child.stdin.on("error", () => {});
    child.stdin.end(flags.includes("--demo") ? "" : JSON.stringify(input));
  });
}

/**
 * Compile an OpenQASM circuit to TSIR with the QCCD Studio compiler (bridge/qccd_compile.py).
 * `architecture` is a path inside the Studio checkout. The default is Studio's H2 machine.
 * The result is the input of `studioReplay`.
 */
export function compileQasm(qasm, architecture) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.QCONTROL_PYTHON || "python",
      ["-B", "-X", "utf8", path.join(root, "bridge", "qccd_compile.py")],
      { windowsHide: true, timeout: 240000, maxBuffer: 1 << 28 },
      (error, stdout, stderr) => {
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {}
        if (error || !parsed || parsed.error) return reject(Error(parsed?.error || stderr.trim() || error?.message || "The Studio compiler returned no program."));
        resolve(parsed);
      });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ qasm, ...(architecture ? { architecture } : {}) }));
  });
}

/** DSP clock of the ion controller: 100 MHz, so one batch is 10 ns and a pulse lasts up to 655 µs. */
const DSP_HZ = 100e6;
/** Photons a bright ion yields in one detection window, and the count that reads as bright (riscq/standards.mjs). */
export const BRIGHT_PHOTONS = STANDARD.qccd.brightPhotons.value, THRESHOLD = STANDARD.qccd.brightThreshold.value;

/**
 * Derive the control machine and the hardware instructions from a Studio replay.
 * Times: when Studio reports model µs they are used as they are. When Studio reports unit
 * times and its cycles follow one another, each cycle takes the standard duration of its
 * kind (riscq/standards.mjs, overridable through `timing`): a shuttle takes one shift per
 * Studio unit. `unitNs` instead scales every Studio unit by one number.
 * `channelsPerCore` is the number of electrode control channels one transport core drives.
 */
export function machine(replay, { unitNs, timing, frames = replay.frames.length, channelsPerCore = 8 } = {}) {
  if (replay.schema !== "qcontrol.qccd-studio.v1") throw Error("Expected a QCCD Studio replay.");
  const micro = /µs/.test(replay.timing.unit);
  const scaleNs = unitNs ?? (micro ? 1000 : 100000);
  const used = replay.frames.slice(0, frames);
  const sequential = used.every((f, i) => i === 0 || f.start === used[i - 1].end);
  const standard = !micro && unitNs === undefined && sequential;
  const std = values("qccd", timing);
  const shift = Math.round(std.shiftNs * (1 + std.transportOverhead));
  const standardNs = (f) => f.control.driver === "transport" ? (f.end - f.start) * shift
    : f.op === "cool" ? std.coolNs : f.op === "measure" ? std.measureNs
    : f.op === "gate" && f.label === "MS" ? std.twoQubitNs : f.op === "gate" && f.label === "VZ" ? 0
    : f.op === "gate" ? std.rotationNs : 0;
  // Start and duration of every cycle in picoseconds.
  let clock = 0;
  const times = used.map((f) => {
    const dur = Math.round((standard ? standardNs(f) : (f.end - f.start) * scaleNs) * 1000);
    const t = standard ? clock : Math.round(f.start * scaleNs * 1000);
    clock = t + dur;
    return { t, dur };
  });
  const controlChannels = [...new Set(used.flatMap((f) => f.control.banks.flatMap((b) => b.channels)))].sort();
  const gateSites = [...new Set(used.filter((f) => f.control.driver === "optical" && f.op !== "cool").flatMap((f) => f.targets))].sort();
  const cool = used.some((f) => f.op === "cool");
  const cores = [];
  let dac = 0;
  // A transport core issues every waveform of its channels from its own RAM, so the channels
  // per core bound both its program size and its burst of simultaneous writes.
  for (let i = 0; i < controlChannels.length; i += channelsPerCore)
    cores.push({
      name: "tr" + i / channelsPerCore,
      channels: controlChannels.slice(i, i + channelsPerCore).map((name) =>
        ({ name, kind: "pulse", dac: dac++, slots: 16, env_depth: 4096, interp: 16 })),
    });
  for (const site of gateSites)
    cores.push({
      name: "zone." + site,
      channels: [
        { name: "rotate", kind: "pulse", dac: dac++, slots: 1, env_depth: 1024, interp: 4 },
        { name: "ms", kind: "pulse", dac: dac++, slots: 1, env_depth: 1024, interp: 4 },
        { name: "detect", kind: "pulse", dac: dac++, slots: 1, env_depth: 1024, interp: 4 },
        { name: "pmt", kind: "dio", slots: 1 },
      ],
    });
  if (cool) cores.push({ name: "light", channels: [{ name: "cool", kind: "pulse", dac: dac++, slots: 1, env_depth: 1024, interp: 4 }] });
  if (!cores.length) throw Error("The replay has no hardware action.");
  const spec = socSpec({
    name: "qccd-" + replay.machine.name, dsp_freq_hz: DSP_HZ, link_pipe: 4,
    core_defaults: { mem_depth: 16384, with_mul: true, queue_depth: 4 }, cores,
  });
  return {
    platform: "qccd", name: replay.machine.name, spec, replay, frames: used, times, scaleNs: standard ? undefined : scaleNs, controlChannels, gateSites,
    period: spec.dspPeriodPs,
    coreOf: (name) => spec.cores.findIndex((c) => c.name === name),
    provenance: {
      schedule: "QCCD Studio replay, engine " + replay.engine.name + " revision " + replay.engine.revision,
      time: micro ? "Studio model µs"
        : standard ? "standard durations per cycle kind: shuttle " + shift / 1000 + " µs per Studio unit, rotation " + std.rotationNs / 1000 +
          " µs, two-qubit gate " + std.twoQubitNs / 1000 + " µs, detection " + std.measureNs / 1000 + " µs, cooling " + std.coolNs / 1000 +
          " µs (" + STANDARD.qccd.shiftNs.source + " and Table III)"
        : "Studio unit times scaled by " + scaleNs + " ns per unit",
      detection: "bright ion " + BRIGHT_PHOTONS + " photons per window, bright when at least " + THRESHOLD + " are counted (composite, riscq/standards.mjs)",
      wiring: "Studio control channels, one DAC channel each",
    },
  };
}

/** Hardware instructions: one per Studio cycle, in picoseconds, with the ion placement before it. */
export function schedule(m) {
  const position = new Map();
  const ops = [];
  for (const [k, frame] of m.frames.entries()) {
    const instruction = m.replay.sourceInstructions[frame.sourceIndex];
    const before = Object.fromEntries(frame.ions.map((ion) => [ion, position.get(ion)]));
    for (const [ion, site] of Object.entries(frame.positions)) position.set(ion, site);
    const base = {
      id: frame.id, t: m.times[k].t, dur: m.times[k].dur,
      ions: frame.ions, sites: frame.targets, source: "TSIR instruction " + frame.sourceId,
    };
    if (frame.control.driver === "transport")
      ops.push({ ...base, op: "transport", moves: frame.moves,
        banks: frame.control.banks.map((b) => ({ channels: b.channels, action: b.action, role: b.role })) });
    else if (frame.op === "cool") ops.push({ ...base, op: "cool" });
    else if (frame.op === "measure")
      ops.push({ ...base, op: "measure", at: Object.fromEntries(frame.ions.map((ion) => [ion, position.get(ion)])) });
    else if (frame.op === "gate" && frame.label === "VZ")
      ops.push({ ...base, op: "frame", params: instruction.params });
    else if (frame.op === "gate" && frame.label === "MS")
      ops.push({ ...base, op: "ms", pairs: instruction.pairs, params: instruction.params, sites: instruction.sites });
    else if (frame.op === "gate")
      ops.push({ ...base, op: "rotate", ions: instruction.ions, sites: instruction.sites, params: instruction.params });
    else if (frame.op !== "init" && frame.op !== "barrier")
      throw Error("Studio cycle " + frame.id + " has an unsupported operation " + frame.op + ".");
    void before;
  }
  const span = Math.max(0, ...ops.map((op) => op.t + op.dur));
  return { kind: "hardware-program", version: 1, platform: "qccd", machine: m.name, timeUnit: "ps", segments: [{ ops, span }] };
}

/** Lower the hardware instructions to timed channel actions, pulse tables and bindings. */
export function lower(hardware, m) {
  const period = m.period;
  const batch = (ps) => Math.round(ps / period);
  const duration = (op) => {
    const d = batch(op.dur);
    if (d < 1 || d > 65535)
      throw Error(op.id + " lasts " + d + " batches. One pulse-table entry holds 1 to 65535 batches of " + period / 1000 + " ns.");
    return d;
  };
  const tables = new Map(), bindings = [], actions = [], measures = [];
  const table = (core, channel) => {
    const key = core + "/" + channel;
    if (!tables.has(key)) tables.set(key, { core, channel, freq: 0, slots: [], keys: new Map() });
    return tables.get(key);
  };
  /** Allocate a pulse-table entry for a waveform of a given duration on a channel. */
  const slot = (core, channel, key, entry, binding) => {
    const t = table(core, channel);
    if (!t.keys.has(key)) {
      const index = t.slots.length;
      if (index >= m.spec.cores[core].channels.find((ch) => ch.name === channel).slots)
        throw Error("Channel " + m.spec.cores[core].name + "." + channel + " needs more pulse-table entries than it has.");
      t.keys.set(key, index);
      t.slots.push({ slot: index, phase: 0, amp: AMP_SCALE, env: 0, ...entry });
      bindings.push({
        core, channel: m.spec.cores[core].channels.findIndex((ch) => ch.name === channel), slot: index,
        id: m.spec.cores[core].name + "." + channel + "#" + index, delayPs: 0, ...binding });
    }
    return t.keys.get(key);
  };
  for (const op of hardware.segments[0].ops) {
    const at = batch(op.t);
    if (op.op === "frame") continue;
    const dur = duration(op);
    if (op.op === "transport") {
      for (const bank of op.banks)
        for (const channel of bank.channels) {
          const core = m.spec.cores.findIndex((c) => c.channels.some((ch) => ch.name === channel));
          const index = slot(core, channel, bank.action + "/" + dur, { dur },
            { part: "electrodes:" + channel, detail: { kind: "transport", action: bank.action, channel, role: bank.role } });
          actions.push({ segment: 0, core, at, fire: { channel, slot: index }, source: op.id });
        }
    } else if (op.op === "cool") {
      const core = m.coreOf("light");
      const index = slot(core, "cool", "cool/" + dur, { dur }, { part: "light:cooling", detail: { kind: "cool", broadcast: true } });
      actions.push({ segment: 0, core, at, fire: { channel: "cool", slot: index }, source: op.id });
    } else if (op.op === "rotate") {
      op.ions.forEach((ion, i) => {
        const core = m.coreOf("zone." + op.sites[i]);
        const [theta, phi] = op.params[i];
        const index = slot(core, "rotate", "rotate/" + dur, { dur }, { part: "site:" + op.sites[i], detail: { kind: "rotate", site: op.sites[i] } });
        // The pulse area sets the rotation angle and the modulator phase sets its axis.
        actions.push({ segment: 0, core, at, fire: { channel: "rotate", slot: index }, source: op.id,
          set: [{ field: "amp", code: Math.round((AMP_SCALE * Math.min(Math.abs(theta), Math.PI)) / Math.PI) },
            { field: "phase", code: phaseCode(phi + (theta < 0 ? Math.PI : 0)) }] });
      });
    } else if (op.op === "ms") {
      op.pairs.forEach((pair, i) => {
        const core = m.coreOf("zone." + op.sites[i]);
        const [theta] = op.params[i];
        const index = slot(core, "ms", "ms/" + dur, { dur }, { part: "site:" + op.sites[i], detail: { kind: "ms", site: op.sites[i] } });
        actions.push({ segment: 0, core, at, fire: { channel: "ms", slot: index }, source: op.id,
          set: [{ field: "amp", code: Math.round((AMP_SCALE * Math.min(Math.abs(theta), Math.PI / 2)) / (Math.PI / 2)) }] });
        void pair;
      });
    } else if (op.op === "measure") {
      // One detection pulse per zone. The ions of a zone are imaged onto separate counter
      // lines, in the order Studio lists them, and counted in the same window.
      const bySite = new Map();
      for (const [ion, site] of Object.entries(op.at)) bySite.set(site, [...(bySite.get(site) ?? []), ion]);
      for (const [site, ions] of bySite) {
        const core = m.coreOf("zone." + site);
        if (core < 0) throw Error(op.id + " measures " + ions.join(", ") + " at " + site + ", which has no detection hardware.");
        const index = slot(core, "detect", "detect/" + dur, { dur }, { part: "site:" + site, detail: { kind: "detect", site } });
        const bits = ions.map((ion) => ion + "@" + op.id);
        actions.push({ segment: 0, core, at, fire: { channel: "detect", slot: index }, source: op.id });
        actions.push({ segment: 0, core, at, bits, source: op.id,
          count: { channel: "pmt", lines: ions.map((_, line) => line), until: at + dur, threshold: THRESHOLD } });
        measures.push({ site, core, op: op.id, dur, ions: ions.map((ion, line) => ({ ion, line, bit: bits[line] })) });
      }
    }
  }
  return {
    tables: [...tables.values()].map(({ keys: _k, ...t }) => t),
    segments: [{ span: batch(hardware.segments[0].span) }],
    actions, bindings, measures,
  };
}

/**
 * Photon clicks for the Lean model. Each detection pulse of a zone causes `BRIGHT_PHOTONS`
 * pulses on the counter line of every bright ion in that zone. `outcomes` maps a measured
 * bit (or an ion name) to 0 or 1.
 */
export function photonResponses(lowered, m, outcomes = {}) {
  const seen = new Map();
  return lowered.measures.map((measure) => {
    const occurrence = seen.get(measure.core) ?? 0;
    seen.set(measure.core, occurrence + 1);
    const channels = m.spec.cores[measure.core].channels;
    const gap = Math.max(40, Math.floor(measure.dur / (2 * BRIGHT_PHOTONS + 2)));
    // Each bright ion pulses its own line. Lines are offset so that no two edges coincide.
    const changes = [];
    for (const { ion, line, bit } of measure.ions)
      for (let k = 0; (outcomes[bit] ?? outcomes[ion] ?? 0) && k < BRIGHT_PHOTONS; k++)
        changes.push({ after: gap * (2 * k + 1) + 11 * line, line, level: 1 }, { after: gap * (2 * k + 1) + 11 * line + 5, line, level: 0 });
    changes.sort((x, y) => x.after - y.after);
    let levels = 0;
    const edges = changes.map(({ after, line, level }) => {
      levels = level ? levels | (1 << line) : levels & ~(1 << line);
      return { after, levels };
    });
    return {
      core: measure.core, channel: channels.findIndex((ch) => ch.name === "detect"), occurrence,
      toCore: measure.core, toChannel: channels.findIndex((ch) => ch.name === "pmt"), edges,
    };
  });
}

/** Ion moves confirmed by the run: a move happened if every waveform of its cycle played on time. */
export function ionTimeline(result, hardware) {
  const bySource = new Map();
  for (const pulse of result.summary.pulses) {
    if (!bySource.has(pulse.source)) bySource.set(pulse.source, []);
    bySource.get(pulse.source).push(pulse);
  }
  return hardware.segments[0].ops.filter((op) => op.op === "transport").map((op) => {
    const pulses = bySource.get(op.id) ?? [];
    const expected = op.banks.reduce((n, b) => n + b.channels.length, 0);
    return {
      op: op.id, moves: op.moves,
      opens: Math.min(...pulses.map((p) => p.opens)), closes: Math.max(...pulses.map((p) => p.closes)),
      delivered: pulses.length === expected && pulses.every((p) => p.onTime && p.aligned && p.opens === pulses[0].opens),
    };
  });
}
