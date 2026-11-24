// Standard physical parameters used where a source program or a calibration file does not
// state one. Each entry is a published value with its source. They are defaults: every
// platform takes overrides, and a run reports which values it used in `machine.provenance`.
// A value marked "derived" is arithmetic on published numbers. A value marked "composite"
// combines numbers from different machines.
const entry = (value, unit, source, note) => Object.freeze({ value, unit, source, ...(note ? { note } : {}) });

const pino = "Pino et al., Nature 592, 209 (2021), arXiv:2003.01293";

export const STANDARD = Object.freeze({
  qccd: Object.freeze({
    // Transport: Pino Table II. Its caption adds about 10% to every operation for interpolation
    // and electronics delays.
    shiftNs: entry(58000, "ns", pino + ", Table II", "intrazone shift of 110 µm"),
    interzoneShiftNs: entry(283000, "ns", pino + ", Table II"),
    splitNs: entry(128000, "ns", pino + ", Table II", "split or combine"),
    swapNs: entry(200000, "ns", pino + ", Table II"),
    transportOverhead: entry(0.1, "fraction", pino + ", Table II caption"),
    junctionNs: entry(120000, "ns", "Murali et al., ISCA 2020, arXiv:2004.04706, Table I", "X junction, as QCCD compilers use"),
    // Operations: Pino Table III.
    rotationNs: entry(5000, "ns", pino + ", Table III", "single-qubit π/2"),
    twoQubitNs: entry(25000, "ns", pino + ", Table III"),
    initNs: entry(10000, "ns", pino + ", Table III"),
    measureNs: entry(120000, "ns", pino + ", Table III"),
    coolNs: entry(550000, "ns", pino + ", Table III", "Doppler cooling stage"),
    // Detection: composite across machines, since no H-series paper states photon statistics.
    brightPhotons: entry(10, "photons", "Wright et al., Nat. Commun. 10, 5464 (2019), arXiv:1903.08181", "composite: mean of a bright 171Yb+ ion"),
    brightThreshold: entry(2, "photons", "Egan et al., Nature 598, 281 (2021), arXiv:2009.11482", "bright when more than 1 photon is counted"),
  }),
  neutral: Object.freeze({
    hzPerUm: entry(188462, "Hz/µm", "Endres et al., Science 354, 1024 (2016), arXiv:1607.03044, Fig. 1D", "derived: 0.49 MHz between tones for 2.6 µm"),
    acousticNs: entry(6154, "ns", "Lu et al., arXiv:2510.11451, supplement (650 m/s) and the 4 mm beam of Endres et al.", "derived: beam width over acoustic velocity"),
    // The ZAC program supplies these itself. They are listed for reference.
    moveAcceleration: entry(2750, "m/s²", "Lin, Tan, Cong, HPCA 2025, arXiv:2411.11784, Sec. VII-B", "d/t² after Bluvstein et al. 2022"),
    transferNs: entry(15000, "ns", "Lin, Tan, Cong, arXiv:2411.11784, Sec. VII-B"),
    rydbergNs: entry(360, "ns", "Lin, Tan, Cong, arXiv:2411.11784, Sec. VII-B"),
  }),
  superconducting: Object.freeze({
    // The transmon ring takes its durations from RISC-Q's calibration file. For reference:
    readoutNs: entry(500, "ns", "Google Quantum AI, Nature 614, 676 (2023), arXiv:2207.06431, Fig. 1"),
    resetNs: entry(160, "ns", "Google Quantum AI, arXiv:2207.06431, Fig. 1"),
    cycleNs: entry(1100, "ns", "Google Quantum AI, Nature 638, 920 (2025), arXiv:2408.13687"),
    coaxMmPerNs: entry(200, "mm/ns", "machine/interconnect.mjs coax entry (velocity factor about 0.67)"),
  }),
  // Published decoder latencies, for comparison with a decoder run in this model.
  decoders: Object.freeze({
    heliosD3Ns: entry(56, "ns", "Liu et al., arXiv:2603.16203, Sec. V-B", "Helios in FPGA logic, worst-case distance-3 pattern, per decode"),
    heliosD5Ns: entry(65, "ns", "Liu et al., arXiv:2603.16203, Sec. V-C", "per decode, p = 0.001"),
    heliosD7Ns: entry(90, "ns", "Liu et al., arXiv:2603.16203, Sec. V-C", "per decode, p = 0.001"),
    heliosPerRoundD21Ns: entry(11.5, "ns", "Liyanage et al., IEEE TQE 2024, arXiv:2406.08491", "per round, phenomenological 0.1%"),
    googleD5Ns: entry(63000, "ns", "Google Quantum AI, arXiv:2408.13687", "software Sparse Blossom, per decode"),
    feedbackD3Ns: entry(446, "ns", "Liu et al., arXiv:2603.16203", "syndrome at the leaves to error data back at the leaves, RISC-Q with Helios"),
  }),
});

/** `{ name: value }` of one group, with overrides applied. */
export function values(group, overrides = {}) {
  return { ...Object.fromEntries(Object.entries(STANDARD[group]).map(([name, e]) => [name, e.value])), ...overrides };
}
