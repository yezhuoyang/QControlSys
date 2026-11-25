// A transmon chip for a placed QSysASM listing, written as a hardware design document
// (riscq/design.mjs) that the simulator runs and the design editor opens.
//
// What the chip has, and why:
// - One transmon per placed site (riscq/ftqvm/place.mjs), at its lattice position × `pitchMm`.
// - One tunable coupler, with a calibrated CZ, for every pair of sites the listing gates
//   (place.gatedPairs). Nearest-neighbour pairs of the surface code are 0.71 pitch long; the
//   merge's check qubit needs longer couplers to the logical representatives of both blocks.
//   With a coupler for every gated pair, `route` needs no SWAP: it is realized by couplers that
//   already exist. This is one design point; a nearest-neighbour chip that realizes `route` with
//   SWAP chains is the other (not built yet).
// - One RISC-Q core per transmon (RISC-Q builds exactly one demod channel into every core, so a core
//   reads out one transmon), plus a frame core and the decoder cores. Each transmon's core has a drive
//   channel (x90, x and reset in slots 0–2), one CZ channel per coupler, a readout channel and a
//   demodulation channel. Drive and CZ channels of a qubit share its drive DAC; readout tones of eight
//   qubits share one DAC and their returns one ADC, frequency-multiplexed as in RISC-Q's x6y3 build.
// - Cores are placed on boards (AMD ZCU216, riscq/board.mjs): a board takes transmons in site order
//   while it holds at most 14 cores and its DSP48E2 estimate stays under the ceiling where RISC-Q's
//   builds collapse; every board has its own 16 DACs and 16 ADCs. Boards are joined by RISC-Q's PutLane.
//
// Calibration (assumption, stated in `provenance`): site k reuses the measured calibration of
// qubit k mod 8 of RISC-Q's x6y3 example (validation/riscq/x6y3-calibration.json), and every
// coupler reuses the CZ of one of its non-sandwich pairs (400 ns). A long coupler gets the same
// CZ as a short one: no published calibration of long couplers is used. The reset pulse is
// unconditional, 160 ns (Google Quantum AI, Nature 614, 676 (2023), Fig. 1, riscq/standards.mjs);
// its amplitude is illustrative. Crosstalk, frequency collisions and loss are not modeled.
import { readFileSync } from "node:fs";
import { gatedPairs } from "./place.mjs";
import { STANDARD } from "../standards.mjs";
import { ZCU216, DSP_PER, SHARED_DSP } from "../board.mjs";

const calibrationUrl = new URL("../../validation/riscq/x6y3-calibration.json", import.meta.url);
const buildUrl = new URL("../../validation/riscq/x6y3.json", import.meta.url);

/**
 * The chip design for a placement. options: { pitchMm, boardMm, chipMm, name }.
 * Returns { design, sites: [{ site, qubit, part }], pairs } where `qubit` is the design's qubit index.
 */
export function chipDesign(listing, placement, { pitchMm = 2, boardMm = [0, 0, 0], chipMm = [700, 0, -350], name = "QSysASM listing chip",
  qubitsPerCore = 1, decoders = 1, coresPerDecoder = 1, drivesPerDac, device } = {}) {
  const calibration = JSON.parse(readFileSync(calibrationUrl, "utf8"));
  const build = JSON.parse(readFileSync(buildUrl, "utf8"));
  const czPairs = calibration.pairs.filter((p) => !p.sandwich.length);
  // On a twin (riscq/ftqvm/twins.mjs) the couplers are the device's; otherwise one per gated pair.
  const pairs = device
    ? device.couplers.map(([a, b]) => ({ sites: [a, b], count: 0, length: Math.hypot(device.sites[a].rc[0] - device.sites[b].rc[0], device.sites[a].rc[1] - device.sites[b].rc[1]) }))
    : gatedPairs(listing, placement);
  const dur = device?.durations;
  const add = (a, b) => a.map((v, k) => Number((v + b[k]).toFixed(3)));
  const parts = [{ id: "board", type: "control-board", centerMm: boardMm }], channels = [], wires = [], qubits = [], couplings = [];
  const coax = (id, from, to) => wires.push({ id, from: from.id, to: to.id, medium: "coax",
    routeMm: [from.centerMm, [to.centerMm[0], from.centerMm[1], from.centerMm[2]], [to.centerMm[0], to.centerMm[1], from.centerMm[2]], to.centerMm] });
  const sites = placement.sites;
  if (qubitsPerCore !== 1)
    throw Error("RISC-Q builds exactly one demod channel (decoder + ADC) into every core, so a core reads out one transmon: qubitsPerCore must be 1.");
  const partnersOf = (s) => pairs.filter((p) => p.sites.includes(s));
  // CZ channels of a transmon: one per coupler while the core has put-window nodes for them (16 per
  // core, less gate, readout and demod). Past that, couplers whose CZ shares a carrier share a channel,
  // one pulse-table entry each (a channel has one carrier; its pulses play one after another, as a
  // transmon's CZs do).
  const CZ_NODES = 16 - 3;
  const czFreq = (p) => czPairs[pairs.indexOf(p) % czPairs.length].freq;
  const czChannelsOf = (s) => {
    const mine = partnersOf(s);
    if (mine.length <= CZ_NODES) return mine.map((p) => [p]);
    const byFreq = new Map();
    for (const p of mine) (byFreq.get(czFreq(p)) ?? byFreq.set(czFreq(p), []).get(czFreq(p))).push(p);
    if (byFreq.size > CZ_NODES)
      throw Error("Site " + s + " has couplers at " + byFreq.size + " CZ carriers; a RISC-Q core has room for " + CZ_NODES + " CZ channels.");
    // Each carrier's couplers over its share of the channels, largest groups split first.
    const groups = [...byFreq.values()];
    let spare = CZ_NODES - groups.length;
    const split = groups.map((g) => [g]);
    for (let moved = true; moved && spare > 0; ) {
      moved = false;
      const widest = split.map((parts, i) => [Math.max(...parts.map((x) => x.length)), i]).sort((x, y) => y[0] - x[0])[0];
      if (widest[0] > 1) {
        const parts = split[widest[1]], big = parts.findIndex((x) => x.length === widest[0]);
        const half = Math.ceil(parts[big].length / 2);
        parts.splice(big, 1, parts[big].slice(0, half), parts[big].slice(half));
        spare--;
        moved = true;
      }
    }
    return split.flat();
  };
  // Boards: transmons in site order while a board holds ≤ 14 cores and stays under the DSP ceiling.
  const coreDsp = (k) => DSP_PER.core + (2 + czChannelsOf(k).length) * DSP_PER.pulse + DSP_PER.demod;
  const classicalDsp = DSP_PER.core + DSP_PER.demod; // a status line and the demod channel RISC-Q requires
  const boardSites = [[]];
  let dsp = SHARED_DSP;
  sites.forEach((_, k) => {
    if (boardSites.at(-1).length + 1 > ZCU216.cores.value || dsp + coreDsp(k) > ZCU216.dspCeiling.value) {
      boardSites.push([]);
      dsp = SHARED_DSP;
    }
    boardSites.at(-1).push(k);
    dsp += coreDsp(k);
  });
  // The frame core and the decoder cores, where a board has room, else on a board of their own.
  const classical = ["decoder", ...Array.from({ length: decoders * coresPerDecoder }, (_, i) => "dec" + Math.floor(i / coresPerDecoder) + "." + (i % coresPerDecoder))];
  const boardClassical = boardSites.map(() => []);
  const boardDsp = boardSites.map((list) => SHARED_DSP + list.reduce((n, k) => n + coreDsp(k), 0));
  for (const id of classical) {
    let b = boardSites.findIndex((list, i) => list.length + boardClassical[i].length < ZCU216.cores.value && boardDsp[i] + classicalDsp <= ZCU216.dspCeiling.value);
    if (b < 0) {
      boardSites.push([]);
      boardClassical.push([]);
      boardDsp.push(SHARED_DSP);
      b = boardSites.length - 1;
    }
    boardClassical[b].push(id);
    boardDsp[b] += classicalDsp;
  }
  const boardPart = boardSites.map((_, b) => {
    const part = { id: b === 0 ? "board" : "board" + b, type: "control-board", centerMm: add(boardMm, [0, 450 * b, 0]) };
    if (b > 0) parts.push(part);
    return part;
  });
  parts[0].centerMm = boardPart[0].centerMm;
  const at = (b, off) => add(boardPart[b].centerMm, off);
  const out = [];
  const perDacOf = [];
  boardSites.forEach((list, b) => {
    const board = boardPart[b].id;
    // Readout: eight tones share one DAC and their returns one ADC. Drive: the remaining DACs, one per
    // transmon while enough, else `perDac` transmons summed on one DAC (frequency-multiplexed drive).
    const groups = Math.ceil(list.length / 8);
    const driveSlots = ZCU216.dacs.value - groups;
    const perDac = Math.max(drivesPerDac ?? 1, Math.ceil(list.length / Math.max(1, driveSlots)));
    perDacOf.push(perDac);
    const conv = (type, index) => {
      const id = board + "." + type + index;
      if (!parts.some((p) => p.id === id)) parts.push({ id, type, index, board, centerMm: at(b, [60, 6 * index - 48, type === "adc" ? -20 : 0]) });
      return parts.find((p) => p.id === id);
    };
    list.forEach((k, i) => {
      const site = sites[k];
      const cal = calibration.qubits[k % 8];
      const core = { id: "c" + site.id, type: "core", board, centerMm: at(b, [0, 6 * i - 48, 0]) };
      parts.push(core);
      const pos = add(chipMm, [site.rc[1] * pitchMm, -site.rc[0] * pitchMm, 0]);
      const qubit = { id: "q" + site.id, type: "qubit", centerMm: pos };
      const resonator = { id: "r" + site.id, type: "resonator", centerMm: add(pos, [0.6, 0.6, 0]) };
      parts.push(qubit, resonator);
      const drive = conv("dac", Math.floor(i / perDac)), ro = conv("dac", ZCU216.dacs.value - 1 - Math.floor(i / 8)), back = conv("adc", Math.floor(i / 8));
      const id = (role) => core.id + "." + role;
      channels.push({ id: id("gate"), core: core.id, name: "gate", kind: "pulse", converter: drive.id, slots: 3, interp: build.gate_interp, site: k });
      czChannelsOf(k).forEach((list, j) => channels.push({ id: id("cz" + j), core: core.id, name: "cz" + j, kind: "pulse", converter: drive.id, slots: list.length, interp: build.gate_interp, pairKeys: list.map((p) => p.sites.join("-")), site: k }));
      channels.push({ id: id("ro"), core: core.id, name: "ro", kind: "pulse", converter: ro.id, slots: 1, interp: build.readout_interp, site: k },
        { id: id("demod"), core: core.id, name: "demod", kind: "demod", converter: back.id, slots: 1, interp: build.demod_interp ?? 4, site: k });
      coax("drive-" + site.id, drive, qubit);
      coax("tone-" + site.id, ro, resonator);
      wires.push({ id: "return-" + site.id, from: resonator.id, to: back.id, medium: "coax",
        routeMm: [resonator.centerMm, [resonator.centerMm[0], resonator.centerMm[1], back.centerMm[2]], [resonator.centerMm[0], back.centerMm[1], back.centerMm[2]], back.centerMm] });
      const gate = (g) => ({ amp: g.amp, phaseRad: g.phase, durNs: g.time * 1e9, envelope: g.env, virtualZ: g.virtualZ });
      qubits[k] = { part: qubit.id, resonator: resonator.id, gate: id("gate"), ro: id("ro"), demod: id("demod"), freqHz: cal.freq,
        x90: dur ? { ...gate(cal.X90), durNs: dur.x90Ns.value } : gate(cal.X90), x: dur ? { ...gate(cal.X), durNs: dur.xNs.value } : gate(cal.X),
        reset: { amp: cal.X.amp, durNs: dur ? dur.resetNs.value : STANDARD.superconducting.resetNs.value, envelope: "cosine_square" },
        // A twin's readout: the tone over the published duration, integrated over the same window.
        readout: dur
          ? { freqHz: cal.readout.freq, amp: cal.readout.amp, durNs: dur.readoutNs.value, envelope: cal.readout.env, demodDelayNs: 0, demodNs: dur.readoutNs.value, demodPhaseRad: cal.readout.demod.phase }
          : { freqHz: cal.readout.freq, amp: cal.readout.amp, durNs: cal.readout.time * 1e9, envelope: cal.readout.env,
            demodDelayNs: cal.readout.demod.delay * 1e9, demodNs: cal.readout.demod.time * 1e9, demodPhaseRad: cal.readout.demod.phase } };
      out[k] = { site: k, qubit: k, part: qubit.id, address: site.address, rc: site.rc, board: b };
    });
    // The frame core keeps the Pauli frame and computes parities; the decoder cores run the compiled
    // decoder (riscq/ftqvm/decoder.mjs). Each has the demod channel RISC-Q requires, on this board's ADC 0.
    boardClassical[b].forEach((cid, i) => {
      parts.push({ id: cid, type: "core", board, centerMm: at(b, [30, 6 * i - 48, 0]) });
      channels.push({ id: cid + ".status", core: cid, name: "status", kind: "dio", slots: 1 },
        { id: cid + ".demod", core: cid, name: "demod", kind: "demod", converter: conv("adc", 0).id, slots: 1, interp: build.demod_interp ?? 4 });
    });
  });
  pairs.forEach((p, i) => {
    const ref = czPairs[i % czPairs.length];
    const key = p.sites.join("-");
    couplings.push({
      qubits: p.sites, freqHz: ref.freq, durNs: dur ? dur.czNs.value : ref.pulses[0].time * 1e9, lengthLattice: p.length,
      pulses: ref.pulses.map((pulse, j) => ({ qubit: p.sites[j], amp: pulse.amp, phaseRad: pulse.phase, envelope: pulse.env,
        channel: channels.find((c) => c.site === p.sites[j] && c.pairKeys?.includes(key)).id })),
      // The reference pair's frame corrections on its own two qubits; spectator corrections are dropped.
      virtualZ: ref.virtualZ.filter((z) => ref.pair.includes(z.qubit)).map((z) => ({ qubit: p.sites[ref.pair.indexOf(z.qubit)], phaseRad: z.phase })),
    });
  });
  const perDac = Math.max(...perDacOf);
  const design = JSON.parse(JSON.stringify({
    kind: "riscq-design", version: 1, name,
    board: { dspHz: build.dsp_freq_hz, linkStages: build.link_pipe, memWords: build.mem_depth, queueDepth: build.queue_depth, envDepth: build.env_depth },
    parts, channels: channels.map(({ pairKeys: _k, site: _s, ...c }) => c), wires, qubits, couplings: couplings.map(({ lengthLattice: _l, ...c }) => c), decoder: "decoder",
    control: { qubitsPerCore, decoders, coresPerDecoder, drivesPerDac: perDac, boards: boardSites.length,
      boardsOf: "riscq/board.mjs ZCU216: ≤ " + ZCU216.cores.value + " cores and ≤ " + ZCU216.dspCeiling.value + " DSP48E2 per board" },
    provenance: {
      placement: "riscq/ftqvm/place.mjs: data at row-major lattice points, ancillas at the nearest free half-integer point",
      calibration: "site k reuses qubit k mod 8 of " + calibration.source + "; every coupler reuses a non-sandwich CZ of that file (400 ns)",
      reset: STANDARD.superconducting.resetNs.source + ", 160 ns, unconditional; amplitude illustrative",
      couplers: pairs.length + " couplers, one per gated pair; lengths in lattice units " + JSON.stringify(summarizeLengths(pairs)),
    },
  }));
  return { design, sites: out, pairs };
}

function summarizeLengths(pairs) {
  const by = {};
  for (const p of pairs) by[p.length.toFixed(2)] = (by[p.length.toFixed(2)] ?? 0) + 1;
  return by;
}
