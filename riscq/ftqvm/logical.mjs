// Logical-qubit experiments reproduced on digital twins with the decoder in the control system.
//
// Each paper's circuits are exact Stim circuits (validation/ftqvm/papers/<dir>/, with how each
// was obtained in its meta.json and README.md). A circuit runs on its twin as one control
// program: the circuit on the paper's timeline, then the decode_syndrome system call on a RISC-Q
// decoder core (the compiled union-find decoder, riscq/decoders/uf_decoder.c) reading the bits
// the measuring cores published, then feed-forward: pulses conditioned on the decoded bit.
// Around the run:
//   noise      the paper's own error model, simulated with Stim on many shots (raw, PyMatching,
//              postselected), and the decoding graph of the circuit
//   decoder    the compiled decoder on hundreds of noisy shots in the Lean model: its corrections
//              against PyMatching's and its decode times (riscq/decoders/uf.mjs bench)
// Every time a page shows comes from a Lean run; every number of the paper it is set against is
// quoted with its source in the paper's meta.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stim, debugSteps } from "./magic.mjs";
import { parseStim, czNative, runWithDecoder } from "./qec-run.mjs";
import * as uf from "../decoders/uf.mjs";
import { PROFILES } from "./optical.mjs";

const H2 = PROFILES.h2;

const HERE = dirname(fileURLToPath(import.meta.url));
const PAPERS = join(HERE, "..", "..", "validation", "ftqvm", "papers");
const v = (value, source, note) => ({ value, source, ...(note ? { note } : {}) });
const pct = (x, d = 1) => (100 * x).toFixed(d) + "%";
/** Error per cycle from a logical error over r cycles: 1 − 2ε = (1 − 2P)^(1/r). */
const perCycle = (P, r) => (1 - Math.pow(Math.max(0, 1 - 2 * P), 1 / r)) / 2;
const sgn = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(3);

const read = (dir, file) => readFileSync(join(PAPERS, dir, file), "utf8");
const metaOf = (dir) => JSON.parse(read(dir, "meta.json"));
/** A paper's timings as a list of { name, value, quote, … } (meta.json keeps them as a list or by name). */
const timingsOf = (meta) => (Array.isArray(meta.timings) ? meta.timings : Object.entries(meta.timings).map(([name, t]) => ({ name, ...t })));
const timing = (meta, name) => timingsOf(meta).find((t) => t.name === name);

/* ================================================================== Besedin et al. 2026 */

const besedin = {
  id: "besedin-2026", dir: "besedin2026",
  circuits: [
    { file: "circuit.stim", distance: 3, label: "split, then Z_L1·Z_L2", observable: "Z_L1 Z_L2", paper: { raw: 0.189, decoded: 0.730, postselected: 0.998, kept: 0.055 } },
    { file: "circuit-bell-XX.stim", distance: 3, label: "split, then X_L1·X_L2", observable: "X_L1 X_L2", paper: { raw: 0.255, postselected: 0.56, kept: 0.063 } },
  ],
  /** The twin: the paper's 17 transmons at their chip positions, its gate and readout times. */
  twin(meta) {
    const one = timing(meta, "single-qubit gate (DRAG pulse)"), cz = timing(meta, "CZ gate (average)"), ro = timing(meta, "readout pulse duration");
    const src = (t) => "Besedin et al., arXiv:2501.04612, " + t.section + ": \"" + t.quote + "\"";
    return {
      title: "ETH Zurich 17-transmon surface-code device",
      durations: {
        x90Ns: v(one.value, src(one)), xNs: v(one.value, src(one)),
        czNs: v(cz.value, src(cz) + "; the 20 ns buffers on each side are in the layer time, not the pulse"),
        readoutNs: v(ro.value[1], src(ro) + "; the longest of the range, for every qubit"),
        resetNs: v(0, "the paper: \"We do not reset qubits after their readout\" (no reset is played)"),
      },
      basis: "The circuit is the paper's gate sequence (Methods, its gate-sequence figure), qubit for qubit, on the chip positions of its micrograph. Single-qubit and CZ times are the paper's; the layer timeline is derived from its 1.66 µs period between same-type cycles and its eight steps per stabilizer measurement (meta.json derived_schedule). Readout lengths per qubit are not published (175–300 ns): every readout takes 300 ns. The control electronics are not stated in the paper: the controller is QuantumOS's RISC-Q model, one core per transmon, with a decoder core.",
    };
  },
  // One duration per moment of the circuit. A layer with no operation (the state-preparation slot,
  // empty for |0⟩) has no moment in the Stim circuit: its time is idle time after the layer before.
  timeline: (meta) => meta.derived_schedule.layers.reduce((out, l) => (l.ops.length || !out.length ? [...out, l.duration_ns] : [...out.slice(0, -1), out.at(-1) + l.duration_ns]), []),
  noise: () => ({ model: "uniform", p1: 0.0009, p2: 0.022, pm: 0.015, t1_s: 51e-6, tphi_s: 1 / (1 / 50e-6 - 1 / (2 * 51e-6)) }),
  noiseNote: "The paper's simulation model (its appendix): depolarizing 0.09% after one-qubit gates, 2.2% after CZ, 1.5% readout flips, and the idle Pauli channel 1 − exp(−t/T) with T_X = T_Y = 4·T1 and T_Z = T_φ over each layer's time, T1 = 51 µs (midpoint of 24–78 µs) and T2E = 50 µs (representative; per-qubit values are not published).",
  // Feed-forward the paper does in software: the decoded Z_L1·Z_L2 conditions X on L2's data (D3, D6, D9).
  feedback: [{ qubit: 6 }, { qubit: 9 }, { qubit: 12 }],
  // The compiler's counterpart: a Bell pair of two d = 3 surface-code blocks by an X⊗X merge (the
  // operation the paper's split runs backwards), on the twin's durations.
  call: (twin, meta) => {
    const d = twin.durations;
    return {
      program: "program[q: 2, c: 2]:\n  measure X data[0] X data[1] -> c[0]\n  measure Z data[0] Z data[1] -> c[1]\n",
      durations: {
        gate1q_ns: v(d.x90Ns.value, d.x90Ns.source), gate2q_ns: v(2 * d.x90Ns.value + 141.5, "derived", "CNOT = H·CZ·H; the CZ with its two 20 ns buffers"),
        measure_ns: v(d.readoutNs.value, d.readoutNs.source),
        reset_ns: v(d.readoutNs.value + 486 + d.x90Ns.value, "derived", "the device never resets: readout, feed-forward of the bit to the qubit's core (measured, 486 ns), X"),
        route_latency_ns: v(2, "derived", "a coupler for every gated pair: a route needs no action"),
      },
    };
  },
};

/* ================================================================== Caune et al. 2024 */

// Pulse times from the programs the authors ran (Zenodo doi:10.5281/zenodo.13961129, quoted in
// caune2024/meta.json `timings`): CZ per pair, readout pulse and ring-down per qubit, all in ns.
const CAUNE = {
  cz: { "36-37": 104, "38-45": 108, "51-52": 176, "43-50": 104, "37-38": 112, "45-52": 68, "50-51": 84, "36-43": 104 },
  readout: { 36: 984, 38: 976, 52: 952, 50: 948, 37: 500, 43: 500, 45: 500, 51: 500 },
  ringdown: { 36: 192, 37: 192, 38: 336, 43: 624, 45: 384, 50: 144, 51: 144, 52: 168 },
  rx: 40,
};
const caune = {
  id: "caune-2024", dir: "caune2024", metric: "lep",
  circuits: [
    { file: "circuit-stability-r5.stim", distance: "–", label: "stability-8, 5 decoding rounds", observable: "stability parity", paper: { lep: 0.281 } },
    { file: "circuit-stability-r25.stim", distance: "–", label: "stability-8, 25 decoding rounds", observable: "stability parity", paper: { lep: 0.205 } },
    { file: "circuit-feedback-n9.stim", distance: "–", label: "fast feedback, 9 measurement rounds", observable: "stability parity", paper: { responseNs: 9600, decodeNs: 6500, commNs: 3100, readoutToDecoderNs: 1400 }, feedback: true },
  ],
  twin(meta) {
    const T = meta.timings, q = (t) => "Caune et al., arXiv:2410.05202, " + t.section + ": \"" + t.quote + "\"";
    return {
      title: "Rigetti Ankaa-2, the 8 qubits of the stability-8 patch",
      durations: {
        x90Ns: v(CAUNE.rx, q(T.layer_e_f_i_single_qubit)), xNs: v(CAUNE.rx, q(T.layer_e_f_i_single_qubit) + "; RX(π) also 40 ns in the programs"),
        czNs: v(T.cz_median.value, q(T.cz_median) + "; each layer lasts its longest pair (68–176 ns, from the programs)"),
        readoutNs: v(984, "the longest ancilla readout pulse in the programs (Q36); each measurement layer lasts its longest pulse + ring-down (1312 ns, Q38)"),
        resetNs: v(0, "no reset: \"Resets were not available\"; a 250 µs wait between shots (programs)"),
      },
      basis: "The circuits are the authors' own (Zenodo, the executed programs and their Stim circuits), qubit for qubit, on the Ankaa-2 lattice positions. Every layer lasts its longest pulse as the programs give it: CZ per pair, readout and ring-down per qubit. Rigetti's control system (Kintex-7 card cage, a Collision Clustering decoder on a sequencer FPGA at 156.25 MHz) is replaced by QuantumOS's RISC-Q model: one core per qubit and a decoder core running the compiled union-find decoder (the paper's decoder \"achieves the same logical fidelities as the Union Find algorithm\").",
    };
  },
  timeline(meta, text) {
    const map = Object.fromEntries([.../(\d+)->Q(\d+)/g[Symbol.matchAll](text)].map((m) => [Number(m[1]), Number(m[2])]));
    const c = parseStim(text);
    return c.moments.map((mo) => Math.max(0, ...mo.ops.map((op) => {
      const dev = op.targets.map((t) => map[c.stimIndex[t]]);
      if (op.gate === "CZ") return Math.max(...dev.filter((_, i) => i % 2 === 0).map((a, i) => CAUNE.cz[[a, dev[2 * i + 1]].sort((x, y) => x - y).join("-")]));
      if (op.gate === "M") return Math.max(...dev.map((d) => CAUNE.readout[d] + CAUNE.ringdown[d]));
      if (/^SQRT_X|^X$|^H$/.test(op.gate)) return CAUNE.rx;
      return 0;
    })));
  },
  noise: () => ({ model: "uniform", p1: 1.5 * (1 - 0.9986), p2: 1.25 * (1 - 0.973), pm: 1 - 0.933, classical_readout: true, idle: "twirl", t1_s: 13.2e-6, t2_s: 10.6e-6 }),
  noiseNote: "Device-informed (the agent's model from the medians in the paper's Methods, arXiv v1): depolarizing CZ 5/4·(1 − 97.3%), RX(π/2) 3/2·(1 − 99.86%), readout as a classical flip of the reported bit with 1 − 93.3% (no reset, so not an X error), and T1 = 13.2 µs, T2 = 10.6 µs Pauli-twirled damping of every idle qubit over each layer's time.",
  // The fast-feedback test: RX(π) on Q50 (Stim qubit 5) when the decoder's logical-flip bit is 1.
  feedback: [{ qubit: 5 }], publishMask: true,
};

/* ================================================================== Lacroix et al. 2025 */

const lacroix = {
  id: "lacroix-2025", dir: "lacroix2025", metric: "lep",
  circuits: [
    { file: "memory-d3-east-Z-r03.stim", distance: 3, label: "colour-code memory d = 3, 3 cycles", observable: "Z_L", rounds: 3, paper: { epsPerCycle: 0.0171 } },
    { file: "memory-d5-Z-r03.stim", distance: 5, label: "colour-code memory d = 5, 3 cycles", observable: "Z_L", rounds: 3, paper: { epsPerCycle: 0.0110 } },
    { file: "circuit-teleport.stim", distance: 3, label: "logical teleportation by lattice surgery (|1⟩)", observable: "Z_L of the teleported state", paper: { fidelity: [0.865, 0.907] }, feedback: true },
  ],
  twin(meta) {
    const T = Object.fromEntries(timingsOf(meta).map((t) => [t.name, t])), q = (t) => "Lacroix et al., arXiv:2412.14256, " + t.section + ": \"" + t.quote + "\"";
    return {
      title: "Google Willow, the colour-code patches",
      durations: {
        x90Ns: v(T.single_qubit_pi_over_2.value, q(T.single_qubit_pi_over_2)), xNs: v(T.single_qubit_pi.value, q(T.single_qubit_pi)),
        czNs: v(T.cz.value, q(T.cz)), readoutNs: v(T.readout.value, q(T.readout)), resetNs: v(T.reset.value, q(T.reset)),
      },
      basis: "The memory circuits are the authors' own (Zenodo doi:10.5281/zenodo.14238944, copied verbatim); the teleportation circuit is rebuilt CNOT by CNOT from the paper's Fig. 15, its detectors found by Stim's flow solver. Gate, readout and reset times are the paper's App. B. A CNOT is played as H·CZ·H; the paper's superdense compilation merges some of those H layers, so the twin's cycle is longer than the paper's 1.3 µs (a stated difference). The electronics are \"custom room-temperature electronics\" in the paper: the controller is QuantumOS's RISC-Q model.",
    };
  },
  noise: () => ({ model: "si1000", p: 1e-3 }),
  noiseNote: "SI1000 at p = 10⁻³, the model of the authors' own noisy circuits on Zenodo (their noisy files are the ideal ones plus this model, instruction for instruction).",
  // Teleportation: the frame update the paper applies in post-processing, as a real X on the target patch's logical support (L2).
  feedback: [{ qubit: 0 }], publishMask: true,
};

/* ================================================================== Bluvstein et al. 2025 */

const bluvstein = {
  id: "bluvstein-2025", dir: "bluvstein2025", platform: "optical", metric: "lep",
  circuits: [
    { file: "circuit-qec.stim", distance: 5, noisyFile: "original-noisy.stim", label: "d = 5 surface code, 4 rounds", observable: "X_L", rounds: 4, paper: { epsPerCycle: 0.0062 } },
  ],
  twin(meta) {
    return {
      title: "Harvard/QuEra neutral-atom processor (448 Rb-87 atoms, zoned)",
      durations: Object.fromEntries(timingsOf(meta).filter((t) => typeof t.value === "number").slice(0, 12).map((t) => [t.name, v(t.value, "Bluvstein et al., arXiv:2506.20661, " + (t.section ?? "") + ": \"" + (t.quote ?? "") + "\"")])),
      basis: "The circuit is the authors' own (arXiv ancillary Stim file, without its noise lines), and the hardware timeline is their own: the 238 steps of the annotated AWG command strings (RawExperimentalCommands_SurfaceCodeQEC.pdf), every AOD move, ramp and hold, Rydberg pulse and local or global Raman pulse at its time, on the four AWG streams aligned to one clock (the 16 CZ anchors agree within 2.6 µs). Each round lasts 4.45 ms as the paper states. The camera exposure is not stated: 500 µs (the group's 2024 imaging) is assumed. The paper's controller is five Spectrum AWGs and a PC; here every stream is a channel of a RISC-Q board at 500 MHz, with a decoder core.",
    };
  },
  /** The AWG timeline as channel actions, the listing and the measurements. */
  optical(meta, circuit, edits = {}) {
    const sch = JSON.parse(read("bluvstein2025", "schedule-qec.json"));
    const timed = sch.steps.filter((x) => x.t_start_us !== null);
    const t0 = Math.min(...timed.map((x) => x.t_start_us));
    const channelOf = (x) => ({ moving: "aod", raman_aod: "ramanAod", raman: x.kind === "raman_global" ? "ramanGlobal" : "ramanLocal", rydberg: "rydberg" })[x.awg];
    const channels = [
      { name: "aod", core: "movers-aod" }, { name: "ramanAod", core: "beams-raman-aod" }, { name: "ramanLocal", core: "beams-raman" },
      { name: "ramanGlobal", core: "global-raman" }, { name: "rydberg", core: "global-rydberg" },
    ];
    const ops = [], natives = [], moments = [];
    const all = circuit.qubits.map((_, i) => i);
    timed.filter((x) => x.duration_us > 0 && x.kind !== "image").forEach((x) => {
      const ch = channelOf(x);
      if (!ch) return;
      const k = ops.length, at = (x.t_start_us - t0) * 1000, dur = x.duration_us * 1000;
      ops.push({ uid: k, kind: x.kind, line: k + 1, moment: k, text: x.details.slice(0, 80), qubits: [], start: at, duration: dur, end: at + dur });
      natives.push({ channel: ch, at, dur, uid: k, sites: x.kind === "move" || x.kind === "ramp" || x.kind === "wait" ? [] : all });
      moments.push({ index: k, start: at, dur, label: x.kind + ": " + x.details.slice(0, 60), kind: x.kind });
    });
    const img = sch.steps.find((x) => x.kind === "image");
    const at = (img.t_start_us - t0) * 1000, dur = Number(edits.imageNs ?? 500000);
    const measures = [];
    for (let i = 0; i < circuit.measurements; i++) {
      const uid = ops.length;
      ops.push({ uid, kind: "measure", line: uid + 1, moment: moments.length, text: "image bit " + i, qubits: [i % circuit.qubits.length], start: at, duration: dur, end: at + dur, writes: [{ register: "m", index: i }] });
      measures.push({ uid, bit: "m[" + i + "]", qubit: i % circuit.qubits.length, at, dur });
    }
    moments.push({ index: moments.length, start: at, dur, label: "image every atom (exposure " + (edits.imageNs !== undefined ? "edited: " : "assumed ") + dur / 1000 + " µs)", kind: "image" });
    const pos = (q) => (q.entangling_um ? q.entangling_um : [4.6 * q.entangling_home_slm[0], 4.9 * q.entangling_home_slm[1]]);
    const sites = [...sch.qubits].sort((a, b) => a.stim_index - b.stim_index).map((q) => ({ kind: q.role === "data" ? "data" : "ancilla", at: pos(q) }));
    return { channels, natives, listing: { ops, calls: [] }, measures, moments, sites, perRound: sch.totals.per_round };
  },
  noise: () => ({ model: "given" }),
  noiseNote: "The authors' own error model: the noise lines of their published Stim circuit (gates, and idling over the hardware's timing: 4450 µs per round), used as published. Atom loss, about half of the paper's errors, is not in a Stim model.",
  feedback: [{ channel: "ramanLocal", qubit: 5, dur: 5818 }], publishMask: true,
};

/* ================================================================== Luthra and Owens 2026 */

/**
 * Quantinuum H2 as QCCD Studio models it (arch/h2_racetrack.arch.json, the profile
 * riscq/ftqvm/optical.mjs PROFILES.h2 cites): a race track of 40 trap zones in one loop, two ions
 * per zone, one-qubit gates 5 µs, MS gates 25 µs, measurement 120 µs, reset 50 µs, split and merge
 * 80 µs, 5 µs per zone shifted. No per-operation H2 durations are public (the paper and
 * Quantinuum's data sheets give none); these are QCCD Studio's, labelled as such. The paper's
 * own constraint is kept: 4 gate zones, so at most 4 gates, measurements or resets at once.
 * Schedule: in program order, each operation as soon as its ions and a gate zone are free; before
 * a two-qubit gate the second ion is split from its zone, shifted round the loop to its partner's
 * zone and merged (the shorter way round). Rz is a frame update and takes no time.
 */
function h2Schedule(circuit, prof) {
  const Z = prof.ringZones.value, n = circuit.qubits.length;
  const zone = Array.from({ length: n }, (_, q) => Math.floor(q / 2) % Z);
  const freeIon = Array(n).fill(0), gateZones = Array(4).fill(0), lanes = Array(4).fill(0);
  const ops = [], natives = [], moves = [], moments = [], measures = [];
  const take = (pool, t) => { let i = 0; for (let k = 1; k < pool.length; k++) if (pool[k] < pool[i]) i = k; return [i, Math.max(t, pool[i])]; };
  const dur = { one: prof.oneQubitNs.value, two: prof.twoQubitNs.value, measure: prof.measureNs.value, reset: prof.resetNs.value };
  let uid = 0, rec = 0;
  circuit.moments.forEach((mo, k) => {
    for (const op of mo.ops) {
      const two = op.gate === "SQRT_ZZ" || op.gate === "CZ" || op.gate === "CX";
      for (let i = 0; i < op.targets.length; i += two ? 2 : 1) {
        const qs = op.targets.slice(i, i + (two ? 2 : 1));
        if (op.gate === "S" || op.gate === "S_DAG" || op.gate === "Z") { ops.push({ uid: uid++, kind: "Rz (frame)", line: uid, moment: k, text: op.gate + " " + qs.join(" "), qubits: qs, start: freeIon[qs[0]], duration: 0, end: freeIon[qs[0]] }); continue; }
        let t = Math.max(...qs.map((q) => freeIon[q]));
        const row = { uid: uid++, line: uid, moment: k, text: op.gate + " " + qs.join(" "), qubits: qs };
        if (two && zone[qs[0]] !== zone[qs[1]]) {
          const d = Math.abs(zone[qs[0]] - zone[qs[1]]), hops = Math.min(d, Z - d);
          const tr = prof.splitNs.value + hops * prof.shuttleNs.value + prof.mergeNs.value;
          const [lane, at] = take(lanes, t);
          natives.push({ channel: "lane" + lane, at, dur: tr, uid: row.uid, sites: [qs[1]] });
          moves.push({ t0: at, t1: at + tr, s: qs[1], from: zone[qs[1]], to: zone[qs[0]] });
          lanes[lane] = at + tr;
          zone[qs[1]] = zone[qs[0]];
          t = at + tr;
        }
        const kind = two ? "two" : /^M/.test(op.gate) ? "measure" : /^R/.test(op.gate) ? "reset" : "one";
        const [gz, at] = take(gateZones, t);
        const start0 = Math.min(row.start ?? Infinity, Math.max(...qs.map((q) => freeIon[q])));
        natives.push({ channel: kind === "reset" ? "cool" + gz : "zone" + gz, at, dur: dur[kind], uid: row.uid, sites: qs });
        gateZones[gz] = at + dur[kind];
        for (const q of qs) freeIon[q] = at + dur[kind];
        Object.assign(row, { kind: { two: "MS gate", one: "one-qubit gate", measure: "measure", reset: "reset" }[kind], start: start0, end: at + dur[kind] });
        row.duration = row.end - row.start;
        if (kind === "measure") {
          row.writes = [{ register: "m", index: rec }];
          measures.push({ uid: row.uid, bit: "m[" + rec + "]", qubit: qs[0], at, dur: dur.measure, camera: gz });
          rec++;
          natives.pop(); // the readout is the camera core's exposure, not a laser native
        }
        ops.push(row);
      }
    }
    const mine = ops.filter((o) => o.moment === k);
    if (mine.length) moments.push({ index: k, start: Math.min(...mine.map((o) => o.start)), dur: Math.max(...mine.map((o) => o.end)) - Math.min(...mine.map((o) => o.start)), label: [...new Set(mo.ops.map((o) => o.gate))].join(", ") });
  });
  return { ops, natives, moves, moments, measures, zone };
}

const luthra = {
  id: "luthra-2026", dir: "luthra2026", platform: "optical", metric: "lep",
  circuits: [
    { file: "circuit-XR1.stim", distance: 3, label: "X̄1 by QLDPC surgery, 1 round (XR1)", observable: "X̄1 (gadget)", paper: { lep: 0.0072 } },
    { file: "circuit-XR3.stim", distance: 3, label: "X̄1 by QLDPC surgery, 3 rounds (XR3)", observable: "X̄1 (gadget)", paper: { lepBelow: 0.0026 } },
    { file: "circuit-SEQ.stim", distance: 3, label: "X̄1 then Z̄2 (SEQ)", observable: "Z̄2 (gadget)", paper: { lep: 0.0112, simulated: 0.01 } },
  ],
  twin() {
    return {
      title: "Quantinuum H2 (QCCD race track), the 27 ions of the program",
      durations: Object.fromEntries(Object.entries(H2).filter(([, x]) => x && x.value !== undefined).map(([k, x]) => [k, v(x.value, x.source)])),
      basis: "The circuits are the programs the authors submitted (Zenodo doi:10.5281/zenodo.23165109), translated gate for gate (Rz as S/S†, Rxy as √X/X, ZZMax as √ZZ); read back against the published shot data they reproduce the paper's counts and detector rates exactly. H2's per-operation durations are not public: the twin takes QCCD Studio's H2 model (the profile riscq/ftqvm/optical.mjs uses) and keeps the paper's four gate zones; ions are moved round the race track to their partner before each MS gate. Not scheduled, because H2 publishes no duration for them: sideband cooling before two-qubit gates, leakage repump (about 1 ms a cycle, the paper does not give the number of cycles) and the initial cooling (about 17 ms a shot on H2). That is why a twin shot (about 11.5 ms for XR3) is far shorter than the authors' estimate of about 500 ms. The paper decodes offline (it notes real-time decoding on H2 as future work); the twin adds the decoder and one conditioned pulse in the run, to show what that would take. The controller is a RISC-Q board at 500 MHz: four gate-zone laser channels, four transport lanes, cooling, and readout cores, with a decoder core.",
    };
  },
  optical(meta, circuit, edits = {}) {
    const prof = Object.fromEntries(Object.entries(H2).map(([k, x]) => [k, x && x.value !== undefined && edits[k] !== undefined ? { value: Number(edits[k]), source: "edited on the design page" } : x]));
    const sch = h2Schedule(circuit, prof);
    const channels = [0, 1, 2, 3].flatMap((z) => [{ name: "zone" + z, core: "beams-zones" }, { name: "cool" + z, core: "pumps-cooling" }, { name: "lane" + z, core: "movers-electrodes" }]);
    const sites = circuit.qubits.map((_, q) => ({ kind: "data", at: [Math.floor(q / 2), 0] }));
    return { channels, natives: sch.natives, listing: { ops: sch.ops, calls: [] }, measures: sch.measures, moments: sch.moments, sites, moves: sch.moves, ring: H2.ringZones.value };
  },
  noise: () => ({ model: "uniform", p1: 3.4e-5, p2: 1.0e-3, pm: 4.7e-4, pr: 4.7e-4, pi: 1.2e-4 / 7 }),
  noiseNote: "The paper's own simulation model (as its verification script states it): one-qubit 3.4×10⁻⁵, two-qubit 1.0×10⁻³, preparation and measurement 4.7×10⁻⁴ each, and 1.7×10⁻⁵ idling per layer.",
  feedback: [{ channel: "zone0", qubit: 0, dur: 5000 }], publishMask: true,
  // The gadget's measurement is observable 0: a shot whose correction flips it, so the pulse plays.
  shotOf: (g) => g.pymatching.findIndex((x) => (x & 1) === 1),
};

export const PAPERS_LOGICAL = { [besedin.id]: besedin, [caune.id]: caune, [lacroix.id]: lacroix, [bluvstein.id]: bluvstein, [luthra.id]: luthra };

/* ================================================================== one circuit */

/**
 * One circuit of a paper on its twin: noise statistics, the compiled decoder over noisy shots,
 * and one shot run with the decoder and feed-forward in the control program.
 */
export async function logicalRow(paper, c, { shots = 400, statsShots = 200_000, edits = {}, qubitsPerCore = 1, schedule = "paper", cached = false } = {}) {
  const meta = metaOf(paper.dir), text = read(paper.dir, c.file);
  const timeline = schedule === "paper" ? paper.timeline?.(meta, text) : undefined;
  // The noise (Stim) and the compiled decoder's bench (the Lean model) depend on the circuit and
  // its error model only, not on a hardware edit: a full run stores them beside the circuit, and
  // a design page's rerun reads them (the web server has no Stim).
  const cacheFile = join(PAPERS, paper.dir, "graph-" + c.file.replace(/\.stim$/, "") + ".json");
  let g, bench;
  if (cached && existsSync(cacheFile)) ({ graph: g, bench } = JSON.parse(readFileSync(cacheFile, "utf8")));
  else {
    // A paper's own noisy circuit, when it publishes one, is its error model.
    g = await stim({ mode: "graph", stim: c.noisyFile ? read(paper.dir, c.noisyFile) : text, noise: paper.noise(meta), moments_ns: paper.timeline?.(meta, text), shots, stats_shots: statsShots, seed: 3 });
    // The compiled decoder over the noisy shots (one bench run in the Lean model).
    bench = await uf.bench(g, g.shots);
    bench = { decodes: bench.decodes.map(({ mask, defects, ns }) => ({ mask, defects, ns })), bytes: bench.bytes, pruned: bench.pruned ?? null };
    if (!cached) writeFileSync(cacheFile, JSON.stringify({ circuit: c.file, noise: paper.noise(meta), graph: g, bench }));
  }
  let ufWrong = 0, pmAgree = 0, keptShots = 0;
  const decodeNs = [];
  bench.decodes.forEach((x, i) => {
    ufWrong += x.mask !== g.actual[i];
    pmAgree += x.mask === g.pymatching[i];
    keptShots += x.defects === 0;
    decodeNs.push(x.ns);
  });
  decodeNs.sort((a, b) => a - b);
  const st = g.stats, refName = st.reference === "chromobius" ? "Chromobius" : st.reference === "pymatching" ? "PyMatching" : "none";
  const expect = (flips, n) => 1 - (2 * flips) / n;
  const stats = {
    shots: st.shots, raw: expect(st.raw[0], st.shots), pymatching: st.pymatching ? expect(st.pymatching[0], st.shots) : null,
    postselected: st.kept ? expect(st.keptFlips[0], st.kept) : null, kept: st.kept / st.shots,
    compiled: { shots: g.shots.length, decoded: expect(ufWrong, g.shots.length), agreesWithPyMatching: pmAgree / g.shots.length },
  };
  // One shot in a control program: pick a shot where a detector fired, so the decoder works.
  const circuit = czNative(parseStim(text, paper.id + "/" + c.file));
  if (paper.platform === "optical") return opticalRow(paper, c, meta, circuit, g, bench, stats, refName, decodeNs, edits);
  const momentNs = timeline ? circuit.moments.map((mo) => (mo.from !== undefined && !mo.added ? timeline[mo.from] : null)) : undefined;
  // A decoder publishing its correction gets a shot whose correction is 1, so its pulse plays.
  const shot = Math.max(0, paper.publishMask ? g.pymatching.findIndex((x) => x !== 0) : g.defects.findIndex((d, i) => d > 0 && g.actual[i] === 0));
  const fb = c.feedback === false || (paper.metric === "lep" && !c.feedback) ? [] : paper.feedback;
  const run = await runWithDecoder(circuit, g, { shot: g.shots[shot], feedback: fb.map((f) => ({ ...f, when: "uf.obs0" })), twin: paper.twin(meta), momentNs, edits, qubitsPerCore, publishMask: !!paper.publishMask });
  const l = run.latency;
  return {
    row: {
      label: c.label, distance: c.distance ?? "–", basis: c.label, view: "circuit", circuit: c.file, observable: c.observable,
      qubits: circuit.qubits.length, ops: run.schedule.listing.ops.length, circuitNs: run.schedule.makespanNs, conforms: run.report.conforms,
      byKind: run.report.byKind, measurements: circuit.measurements, detectors: g.detectors.length, edges: g.edges.length,
      decoder: { inRun: { ...l, defects: run.decode.defects, mask: run.decode.mask, pymatching: g.pymatching[shot], observable: run.observable, conditioned: fb.length, fired: run.feedback.length }, bench: { median: decodeNs[decodeNs.length >> 1], max: decodeNs.at(-1), bytes: bench.bytes } },
      stats, paper: c.paper,
      columns: paper.metric === "lep" ? {
        "On the twin (µs)": (run.schedule.makespanNs / 1000).toFixed(2),
        "Decoder in the run (µs)": (l.computeNs / 1000).toFixed(1),
        "Readout → decoder (µs): twin / paper": (l.toDecoderNs / 1000).toFixed(2) + " / " + (c.paper.readoutToDecoderNs ? (c.paper.readoutToDecoderNs / 1000).toFixed(1) : "–"),
        "Response, readout → conditioned pulse (µs): twin / paper": (l.toPulseNs ? (l.toPulseNs / 1000).toFixed(2) : run.feedback.length === 0 && fb.length ? "bit 0, no pulse" : "–") + " / " + (c.paper.responseNs ? (c.paper.responseNs / 1000).toFixed(1) : "–"),
        ["Logical error: twin (" + refName + ", compiled) / paper"]: (stats.pymatching !== null ? pct((1 - stats.pymatching) / 2) : "–") + ", " + pct((1 - stats.compiled.decoded) / 2) + " / " + (c.paper.lep !== undefined ? pct(c.paper.lep) : c.paper.fidelity ? "fidelity " + c.paper.fidelity.map((x) => pct(x)).join("–") : "–"),
        ...(c.paper.epsPerCycle !== undefined ? { ["Error per cycle: twin (" + refName + ") / paper"]: (stats.pymatching !== null ? pct(perCycle((1 - stats.pymatching) / 2, c.rounds), 2) : "–") + " / " + pct(c.paper.epsPerCycle, 2) } : {}),
      } : {
        "On the twin (µs)": (run.schedule.makespanNs / 1000).toFixed(2),
        "Decoder in the run (µs)": (l.computeNs / 1000).toFixed(1),
        "Readout → feed-forward pulse (µs)": l.toPulseNs ? (l.toPulseNs / 1000).toFixed(2) : "no pulse (bit 0)",
        ["⟨" + c.observable + "⟩ raw: twin / paper"]: sgn(stats.raw) + " / " + (c.paper.raw !== undefined ? sgn(c.paper.raw) : "–"),
        "decoded: twin (PyMatching, compiled) / paper": (stats.pymatching !== null ? sgn(stats.pymatching) : "–") + ", " + sgn(stats.compiled.decoded) + " / " + (c.paper.decoded !== undefined ? sgn(c.paper.decoded) : "–"),
        "postselected (kept): twin / paper": (stats.postselected !== null ? sgn(stats.postselected) : "–") + " (" + pct(stats.kept) + ") / " + (c.paper.postselected !== undefined ? sgn(c.paper.postselected) + " (" + pct(c.paper.kept) + ")" : "–"),
      },
      track: run.track,
      steps: debugSteps(run),
    },
    run, graph: g, bench,
  };
}

/** One circuit on an optical twin (riscq/ftqvm/optical-twin.mjs), with the decoder and feedback. */
async function opticalRow(paper, c, meta, circuit, g, bench, stats, refName, decodeNs, edits = {}) {
  const { runOpticalTwin } = await import("./optical-twin.mjs");
  const tl = paper.optical(meta, circuit, edits);
  const shot = Math.max(0, paper.shotOf ? paper.shotOf(g) : paper.publishMask ? g.pymatching.findIndex((x) => x !== 0) : g.defects.findIndex((d) => d > 0));
  const run = await runOpticalTwin({ name: paper.id, channels: tl.channels, natives: tl.natives, listing: tl.listing, measures: tl.measures, graph: g, shot: g.shots[shot],
    feedback: paper.feedback, publishMask: !!paper.publishMask, sites: tl.sites });
  const l = run.latency, us = (ns) => (ns / 1000).toFixed(1);
  const rows = new Map(run.report.rows.map((r) => [r.uid, r]));
  const events = tl.listing.ops.map((op) => {
    const r = rows.get(op.uid), k = op.kind === "measure" ? "measure" : op.kind === "rydberg" || op.kind === "MS gate" ? "2q" : /raman|one-qubit/.test(op.kind) ? "1q" : op.kind === "reset" ? "reset" : null;
    if (!k) return null;
    return { k, t0: r?.hardwareNs?.[0] ?? op.start, t1: Math.max(r?.hardwareNs?.[1] ?? op.end, op.start + 1), s: op.qubits.length ? op.qubits : tl.sites.map((_, i) => i), line: op.text };
  }).filter(Boolean);
  if (l) events.push({ k: "decode", t0: l.decoderStartNs, t1: l.decoderEndNs, s: [], line: "decode_syndrome on dec0.0: " + run.decode.defects + " detectors fired" });
  for (const p of run.feedback) events.push({ k: "1q", t0: p.opensNs, t1: p.closesNs, s: paper.feedback.map((f) => f.qubit), line: "conditioned pulse (feedback)" });
  events.sort((a, b) => a.t0 - b.t0);
  const steps = tl.moments.map((m) => ({ k: m.index, t0: m.start, t1: m.start + m.dur, label: m.label, kind: m.kind, ops: [m.label], count: 1, inWindow: rows.get(m.index)?.ok === false ? 0 : 1, hardware: rows.get(m.index)?.hardwareNs ?? null }));
  const round = tl.perRound?.[1]?.window_us;
  return {
    row: {
      label: c.label, distance: c.distance ?? "–", basis: c.label, view: "circuit", circuit: c.file, observable: c.observable,
      qubits: circuit.qubits.length, ops: tl.listing.ops.length, circuitNs: run.makespanNs, conforms: run.report.conforms, byKind: run.report.byKind,
      measurements: circuit.measurements, detectors: g.detectors.length, edges: g.edges.length, cores: run.cores, pulses: run.pulses,
      decoder: { inRun: { ...l, defects: run.decode?.defects, mask: run.decode?.mask, pymatching: g.pymatching[shot], observable: run.observable, conditioned: paper.feedback.length, fired: run.feedback.length }, bench: { median: decodeNs[decodeNs.length >> 1], max: decodeNs.at(-1), bytes: bench.bytes, pruned: bench.pruned } },
      stats, paper: c.paper,
      columns: {
        "On the twin (ms)": (run.makespanNs / 1e6).toFixed(2), ...(round ? { "Round 2 (ms): twin / paper": ((round[1] - round[0]) / 1000).toFixed(2) + " / 4.45" } : {}),
        "Decoder in the run (µs)": l ? us(l.computeNs) : "–", "Readout → conditioned pulse (µs)": l && l.toPulseNs ? us(l.toPulseNs) : "–",
        ...(tl.ring ? { "Ion transports": String((tl.moves ?? []).length) } : {}),
        ...(c.paper.epsPerCycle !== undefined ? { ["Error per round: twin (" + refName + ", compiled) / paper"]: (stats.pymatching !== null ? pct(perCycle((1 - stats.pymatching) / 2, c.rounds), 2) : "–") + ", " + pct(perCycle((1 - stats.compiled.decoded) / 2, c.rounds), 2) + " / " + pct(c.paper.epsPerCycle, 2) + " (with atom loss)" } : {
          ["Logical error: twin (" + refName + ", compiled) / paper"]: (stats.pymatching !== null ? pct((1 - stats.pymatching) / 2, 2) : "–") + ", " + pct((1 - stats.compiled.decoded) / 2, 2) + " / " + (c.paper.lep !== undefined ? pct(c.paper.lep, 2) : c.paper.lepBelow !== undefined ? "< " + pct(c.paper.lepBelow, 2) : "–") + " on hardware" + (c.paper.simulated !== undefined ? " (" + pct(c.paper.simulated, 2) + " simulated)" : ""),
        }),
      },
      track: { device: tl.ring ? { kind: "ions-ring", ring: { zones: tl.ring }, sites: tl.sites } : { kind: "atoms", unit: "µm", sites: tl.sites }, endNs: Math.max(...events.map((e) => e.t1), ...(tl.moves ?? []).map((m) => m.t1)), events, moves: tl.moves ?? [], controller: run.controller },
      steps,
    },
    run, graph: g, bench,
  };
}

/* ================================================================== the system call */

/**
 * The paper's logical operation as a logical program, compiled against the twin: its durations,
 * the decoder as calibrated (riscq/decoders/calibrate.mjs; the worst decode measured at the
 * program's distance, plus the measured time for the bits to reach the decoder), the frame update
 * as measured in the run. First on the paper's device; if the resource VM refuses it, again on the
 * smallest machine the refusal names, so the page shows both.
 */
export async function paperCall({ program, code = "surface", distance = 3, qubits, durations, gridNs = 2, dir, inRun }) {
  const { systemCall } = await import("./magic.mjs");
  const cal = JSON.parse(readFileSync(join(PAPERS, "..", "decoder-calibration.json"), "utf8"));
  const mine = cal.workloads.filter((w) => w.d === distance);
  const worst = Math.ceil(cal.inRun.bitsInNs + Math.max(...mine.map((w) => w.ns.max)));
  const all = {
    ...durations,
    decoder_latency_ns: v(worst, "measured", "the longest compiled decode at d = " + distance + " over " + mine.length + " calibration workloads (" + mine.reduce((s, w) => s + w.shots, 0) + " noisy shots), bits in " + cal.inRun.bitsInNs + " ns + compute"),
    pauli_frame_update_ns: v(inRun.afterDecodeNs, "measured", "from the decoder's result to a conditioned pulse on another core, in this paper's run"),
  };
  const caps = (n) => ({
    qubits: v(n, n === qubits ? "published" : "derived", n === qubits ? "the device's qubits" : "the least the resource VM admits"),
    factories: v(1, "provisional"), max_parallel_gates: v(n, "derived", "one RISC-Q core per qubit"), decoders: v(1, "derived", "one decoder core"),
    classical_data_bandwidth: v(500, "derived", "the board hub: one bit per batch at 500 MHz"),
    qubit_routing_bandwidth: v(1000 * n, "derived", "a coupler for every gated pair"), ancilla_bandwidth: v(1000 * n, "derived", "every qubit at once"),
  });
  const compile = (n) => systemCall({ code, distance, gridNs, dir: join(dir, "q" + n), program, durations: all, capacities: caps(n) });
  const onDevice = await compile(qubits);
  let admitted = null;
  if (onDevice.verdict !== "RESOURCE_VALIDATED") {
    const need = Number(/reservation (\d+) exceeds limit/.exec(onDevice.verdictDetail?.message ?? "")?.[1]);
    if (need) for (let n = need; n <= need + 64 && !admitted; n += 4) { const r = await compile(n); if (r.verdict === "RESOURCE_VALIDATED") admitted = { qubits: n, ...r }; }
  }
  const brief = (r) => r && { verdict: r.verdict, message: r.verdictDetail?.message, code: r.verdictDetail?.code, ops: r.ops, kinds: r.kinds, makespanNs: r.makespanNs, listingHead: r.listingHead, listingLines: r.listingLines, machineText: r.machineText, spec: r.spec };
  return { programText: onDevice.programText, onDevice: { qubits, ...brief(onDevice) }, admitted: admitted && { qubits: admitted.qubits, ...brief(admitted) },
    decoder: { latencyModel: cal.fields.decoder_latency_model, bandwidth: cal.fields.decoder_bandwidth, windowRounds: cal.fields.decoder_window_rounds, memory: cal.fields.classical_memory,
      note: "The installed compiler predates decoder_latency_model, and its VM refuses decoder_bandwidth: the decoder is declared to it as decoder_latency_ns (the measured worst case). The model and bandwidth are the calibration's, for a compiler built from its current source (it needs OCaml 5)." } };
}

/** The decoder's calibration (riscq/decoders/calibrate.mjs), without the per-shot lists. */
export function calibrationSummary() {
  const file = join(PAPERS, "..", "decoder-calibration.json");
  if (!existsSync(file)) return null;
  const cal = JSON.parse(readFileSync(file, "utf8"));
  return { generated: cal.generated, decoder: cal.decoder, fields: cal.fields, model: cal.model, inRun: cal.inRun,
    workloads: cal.workloads.map(({ perDefect: _p, ...w }) => w) };
}

/* ================================================================== the design pages */

const EDITED = "edited on the design page";
const field = (key, label, x, unit, min, max, step, group) => ({ key, label, value: x.value, unit, min, max, step, source: x.source, group });

/**
 * What /reproduce/<id>/design shows and reruns for these papers (contract of riscq/ftqvm/designs.mjs):
 *   params()      which circuit, the twin's durations with the paper's values and their sources,
 *                 the controller, and for the transmon papers whether the paper's layer timeline
 *                 or the edited durations set each moment's window
 *   run(params)   the circuit again on the edited twin: its timing, the compiled decoder in the
 *                 same Lean run and the conditioned pulse, checked against the windows. The noise
 *                 statistics and the decoder's bench are those of the stored run (they do not
 *                 depend on the hardware's durations).
 */
function designOf(paper) {
  return {
    intro: "The program is the paper's own circuit, then the decode_syndrome system call on the decoder core and a pulse conditioned on its result. Change the hardware's durations or the controller and run it again: every pulse is timed on the edited machine, played in the Lean model of the RISC-Q board together with the compiled decoder, and checked against its window. The page reports when the decoder's result reaches the conditioned pulse.",
    params() {
      const meta = metaOf(paper.dir), twin = paper.twin(meta), d = twin.durations;
      const circuit = { key: "circuit", label: "Circuit", value: paper.circuits[0].file, group: "Program", source: "the paper's circuits (validation/ftqvm/papers/" + paper.dir + ")",
        options: paper.circuits.map((c) => ({ value: c.file, label: c.label })) };
      if (paper.id === "luthra-2026") {
        const g = "Device: H2 (QCCD Studio's model)";
        return [circuit, field("oneQubitNs", "One-qubit gate", H2.oneQubitNs, "ns", 1000, 50000, 100, g), field("twoQubitNs", "MS gate", H2.twoQubitNs, "ns", 5000, 500000, 1000, g),
          field("measureNs", "Measurement", H2.measureNs, "ns", 10000, 1000000, 1000, g), field("resetNs", "Reset", H2.resetNs, "ns", 1000, 500000, 1000, g),
          field("splitNs", "Split", H2.splitNs, "ns", 1000, 500000, 1000, g), field("mergeNs", "Merge", H2.mergeNs, "ns", 1000, 500000, 1000, g),
          field("shuttleNs", "Shift by one zone", H2.shuttleNs, "ns", 100, 100000, 100, g)];
      }
      if (paper.id === "bluvstein-2025") return [circuit, field("imageNs", "Camera exposure", v(500000, "assumed: the group's 2024 imaging (the paper does not state it)"), "ns", 10000, 5000000, 10000, "Readout")];
      const g = "Device", out = [circuit,
        field("x90Ns", "Single-qubit gate (π/2)", d.x90Ns, "ns", 4, 400, 2, g), field("czNs", "CZ gate", d.czNs, "ns", 4, 600, 2, g),
        field("readoutNs", "Readout", d.readoutNs, "ns", 50, 5000, 2, g)];
      if (d.resetNs.value > 0) out.push(field("resetNs", "Reset", d.resetNs, "ns", 20, 5000, 2, g));
      if (paper.timeline) out.push({ key: "schedule", label: "Moment windows", value: "paper", group: "Program", source: "the paper's layer timeline (" + paper.dir + "/meta.json)",
        options: [{ value: "paper", label: "the paper's timeline" }, { value: "durations", label: "from the (edited) durations" }] });
      return out;
    },
    async run(params = {}) {
      const c = paper.circuits.find((x) => x.file === params.circuit) ?? paper.circuits[0];
      const keys = ["x90Ns", "czNs", "readoutNs", "resetNs", "imageNs", "oneQubitNs", "twoQubitNs", "measureNs", "splitNs", "mergeNs", "shuttleNs"];
      const edits = Object.fromEntries(keys.filter((k) => params[k] !== undefined && params[k] !== "").map((k) => [k, Number(params[k])]));
      if (edits.x90Ns !== undefined) edits.xNs = edits.x90Ns;
      const { row, run } = await logicalRow(paper, c, { edits, cached: true, schedule: params.schedule === "durations" ? "durations" : "paper" });
      return { rows: [row], design: run.design };
    },
  };
}

export const LOGICAL_DESIGNS = Object.fromEntries(Object.values(PAPERS_LOGICAL).map((p) => [p.id, designOf(p)]));

/* ================================================================== experiments */

/** Every circuit of a paper, the system call, and the twin's description, as the page's data. */
export async function logicalExperiment(id, { shots = 400, statsShots = 200_000, dir, cached = false } = {}) {
  const paper = PAPERS_LOGICAL[id], meta = metaOf(paper.dir);
  const rows = [];
  let firstRun;
  for (const c of paper.circuits) {
    // `cached`: the noise and the bench of the last full run (they do not depend on the schedule).
    const { row, run } = await logicalRow(paper, c, { shots, statsShots, cached });
    rows.push(row);
    firstRun ??= run;
  }
  const twin = paper.twin(meta);
  const call = paper.call ? await paperCall({ ...paper.call(twin, meta), qubits: firstRun.device.sites.length, dir: dir ?? join(PAPERS, "..", "..", "..", "output", "logical-" + id), inRun: firstRun.latency }) : null;
  return {
    device: { id: paper.id, title: twin.title, basis: twin.basis, durations: twin.durations, published: Object.fromEntries((Array.isArray(meta.results) ? meta.results.map((r, i) => [r.name ?? "result" + i, r]) : Object.entries(meta.results ?? {})).filter(([, r]) => r && r.quote).map(([k, r]) => [k, v(r.value ?? null, "\"" + r.quote + "\"" + (r.source ? " (" + r.source + ")" : ""))])) },
    noise: { model: paper.noise(meta), note: paper.noiseNote },
    rows, call, exactness: meta.exactness, decoding: meta.decoding, calibration: calibrationSummary(),
  };
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const { writeFileSync } = await import("node:fs");
  const { byId } = await import("./logical-reproductions.mjs");
  const id = process.argv[2];
  const result = await logicalExperiment(id, { shots: Number(process.argv[3] ?? 400), statsShots: Number(process.argv[4] ?? 200_000), cached: process.argv[5] === "cached" });
  writeFileSync(join(PAPERS, id + ".json"), JSON.stringify({ meta: byId(id), generated: new Date().toISOString(), ...result }, null, 1));
  console.log("wrote", id, result.rows.map((r) => r.label + ": " + JSON.stringify(r.columns)).join("\n"));
  if (result.call) console.log("call on device", result.call.onDevice.verdict, result.call.onDevice.code ?? "", result.call.onDevice.message ?? "", "| admitted at", result.call.admitted?.qubits);
}
