// A transmon chip for a placed FormalRV listing, written as a hardware design document
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
// - One RISC-Q core per transmon, plus a decoder core. Each core has a drive channel (x90, x and
//   reset in slots 0–2), one CZ channel per coupler, a readout channel and a demodulation
//   channel. Drive and CZ channels of a qubit share its drive DAC; readout tones of eight
//   qubits share one DAC and their returns one ADC, frequency-multiplexed as in RISC-Q's x6y3
//   build (all eight readouts on DAC 8 and ADC 12).
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

const calibrationUrl = new URL("../../validation/riscq/x6y3-calibration.json", import.meta.url);
const buildUrl = new URL("../../validation/riscq/x6y3.json", import.meta.url);

/**
 * The chip design for a placement. options: { pitchMm, boardMm, chipMm, name }.
 * Returns { design, sites: [{ site, qubit, part }], pairs } where `qubit` is the design's qubit index.
 */
export function chipDesign(listing, placement, { pitchMm = 2, boardMm = [0, 0, 0], chipMm = [700, 0, -350], name = "FormalRV listing chip",
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
  // Sites fill cores in order: at most `qubitsPerCore` transmons and 16 channels per core
  // (a transmon takes its drive, readout and demodulation channels and one per coupler).
  const coreOfSite = [];
  {
    let core = 0, used = 0, count = 0;
    sites.forEach((_, k) => {
      const need = 3 + pairs.filter((p) => p.sites.includes(k)).length;
      if (count && (count >= qubitsPerCore || used + need > 16)) (core++, (used = 0), (count = 0));
      coreOfSite.push(core);
      used += need;
      count++;
    });
  }
  const qubitCores = (coreOfSite.at(-1) ?? -1) + 1, decoderCores = decoders * coresPerDecoder;
  if (qubitCores + 1 + decoderCores > 64)
    throw Error("A RISC-Q board carries 64 cores; this design needs " + qubitCores + " qubit cores, a frame core and " + decoderCores + " decoder cores.");
  const groups = Math.ceil(sites.length / 8);
  // Drive lines: one DAC per transmon when the board has enough; otherwise `drivesPerDac`
  // transmons share one DAC, their drive tones summed (frequency-multiplexed drive).
  const perDac = drivesPerDac ?? Math.max(1, Math.ceil(sites.length / (64 - groups)));
  if (Math.ceil(sites.length / perDac) + groups > 64 || groups > 64) throw Error("The chip needs more than 64 DACs or ADCs.");
  const driveDacs = new Map();
  const dac = (index, row) => { const p = { id: "dac" + index, type: "dac", index, centerMm: add(boardMm, [60, 6 * row - 200, 0]) }; parts.push(p); return p; };
  const adc = (index, row) => { const p = { id: "adc" + index, type: "adc", index, centerMm: add(boardMm, [60, 6 * row - 200, -20]) }; parts.push(p); return p; };
  const roDacs = [], adcs = [];
  for (let g = 0; g < groups; g++) {
    roDacs.push(dac(64 - groups + g, 64 - groups + g));
    adcs.push(adc(g, g));
  }
  const partnersOf = (s) => pairs.filter((p) => p.sites.includes(s));
  const out = [];
  const coreParts = [];
  sites.forEach((site, k) => {
    const cal = calibration.qubits[k % 8];
    // With `qubitsPerCore` > 1 one core drives several transmons: its channel names carry the site.
    const c = coreOfSite[k];
    if (!coreParts[c]) {
      coreParts[c] = { id: qubitsPerCore === 1 ? "c" + site.id : "core" + c, type: "core", centerMm: add(boardMm, [0, 6 * c - 200, 0]) };
      parts.push(coreParts[c]);
    }
    const core = coreParts[c];
    const ch = (role) => (qubitsPerCore === 1 ? role : site.id + "." + role);
    const at = add(chipMm, [site.rc[1] * pitchMm, -site.rc[0] * pitchMm, 0]);
    const qubit = { id: "q" + site.id, type: "qubit", centerMm: at };
    const resonator = { id: "r" + site.id, type: "resonator", centerMm: add(at, [0.6, 0.6, 0]) };
    parts.push(qubit, resonator);
    const di = Math.floor(k / perDac);
    const drive = driveDacs.get(di) ?? driveDacs.set(di, dac(di, di)).get(di), ro = roDacs[Math.floor(k / 8)], back = adcs[Math.floor(k / 8)];
    const id = (role) => core.id + "." + ch(role);
    channels.push({ id: id("gate"), core: core.id, name: ch("gate"), kind: "pulse", converter: drive.id, slots: 3, interp: build.gate_interp, site: k });
    partnersOf(k).forEach((p, j) => channels.push({ id: id("cz" + j), core: core.id, name: ch("cz" + j), kind: "pulse", converter: drive.id, slots: 1, interp: build.gate_interp, pairKey: p.sites.join("-"), site: k }));
    channels.push({ id: id("ro"), core: core.id, name: ch("ro"), kind: "pulse", converter: ro.id, slots: 1, interp: build.readout_interp, site: k },
      { id: id("demod"), core: core.id, name: ch("demod"), kind: "demod", converter: back.id, slots: 1, interp: build.demod_interp ?? 4, site: k });
    coax("drive-" + site.id, drive, qubit);
    coax("tone-" + site.id, ro, resonator);
    wires.push({ id: "return-" + site.id, from: resonator.id, to: back.id, medium: "coax",
      routeMm: [resonator.centerMm, [resonator.centerMm[0], resonator.centerMm[1], back.centerMm[2]], [resonator.centerMm[0], back.centerMm[1], back.centerMm[2]], back.centerMm] });
    const gate = (g) => ({ amp: g.amp, phaseRad: g.phase, durNs: g.time * 1e9, envelope: g.env, virtualZ: g.virtualZ });
    qubits.push({ part: qubit.id, resonator: resonator.id, gate: id("gate"), ro: id("ro"), demod: id("demod"), freqHz: cal.freq,
      x90: dur ? { ...gate(cal.X90), durNs: dur.x90Ns.value } : gate(cal.X90), x: dur ? { ...gate(cal.X), durNs: dur.xNs.value } : gate(cal.X),
      reset: { amp: cal.X.amp, durNs: dur ? dur.resetNs.value : STANDARD.superconducting.resetNs.value, envelope: "cosine_square" },
      // A twin's readout: the tone over the published duration, integrated over the same window.
      readout: dur
        ? { freqHz: cal.readout.freq, amp: cal.readout.amp, durNs: dur.readoutNs.value, envelope: cal.readout.env, demodDelayNs: 0, demodNs: dur.readoutNs.value, demodPhaseRad: cal.readout.demod.phase }
        : { freqHz: cal.readout.freq, amp: cal.readout.amp, durNs: cal.readout.time * 1e9, envelope: cal.readout.env,
          demodDelayNs: cal.readout.demod.delay * 1e9, demodNs: cal.readout.demod.time * 1e9, demodPhaseRad: cal.readout.demod.phase } });
    out.push({ site: k, qubit: k, part: qubit.id, address: site.address, rc: site.rc });
  });
  pairs.forEach((p, i) => {
    const ref = czPairs[i % czPairs.length];
    const key = p.sites.join("-");
    couplings.push({
      qubits: p.sites, freqHz: ref.freq, durNs: dur ? dur.czNs.value : ref.pulses[0].time * 1e9, lengthLattice: p.length,
      pulses: ref.pulses.map((pulse, j) => ({ qubit: p.sites[j], amp: pulse.amp, phaseRad: pulse.phase, envelope: pulse.env,
        channel: channels.find((c) => c.site === p.sites[j] && c.pairKey === key).id })),
      // The reference pair's frame corrections on its own two qubits; spectator corrections are dropped.
      virtualZ: ref.virtualZ.filter((z) => ref.pair.includes(z.qubit)).map((z) => ({ qubit: p.sites[ref.pair.indexOf(z.qubit)], phaseRad: z.phase })),
    });
  });
  // The frame core keeps the Pauli frame and computes parities; the decoder cores run the
  // compiled decoder (riscq/ftqvm/decoder.mjs), `coresPerDecoder` of them per decoder unit.
  parts.push({ id: "decoder", type: "core", centerMm: add(boardMm, [0, 6 * qubitCores - 200, 0]) });
  channels.push({ id: "decoder.status", core: "decoder", name: "status", kind: "dio", slots: 1 });
  for (let u = 0; u < decoders; u++)
    for (let c = 0; c < coresPerDecoder; c++) {
      const id = "dec" + u + "." + c;
      parts.push({ id, type: "core", centerMm: add(boardMm, [30, 6 * (u * coresPerDecoder + c) - 200, 0]) });
      channels.push({ id: id + ".status", core: id, name: "status", kind: "dio", slots: 1 });
    }
  const design = JSON.parse(JSON.stringify({
    kind: "riscq-design", version: 1, name,
    board: { dspHz: build.dsp_freq_hz, linkStages: build.link_pipe, memWords: build.mem_depth, queueDepth: build.queue_depth, envDepth: build.env_depth },
    parts, channels: channels.map(({ pairKey: _k, site: _s, ...c }) => c), wires, qubits, couplings: couplings.map(({ lengthLattice: _l, ...c }) => c), decoder: "decoder",
    control: { qubitsPerCore, decoders, coresPerDecoder, drivesPerDac: perDac },
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
