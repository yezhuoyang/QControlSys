// The programs QuantumOS runs FormalRV's system calls with, from small to large.
//
// Every program is compiled by FormalRV, unchanged, from a .qppm source: FormalRV's own examples
// where one fits, and a few written here (validation/ftqvm/programs) with FormalRV's syntax.
// `calls` lists the system calls the compiled listing contains (checked by tests).
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formalrvRoot } from "./formalrv.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const own = (name) => join(here, "..", "..", "validation", "ftqvm", "programs", name + ".qppm");
const frv = (...parts) => join(formalrvRoot(), ...parts);

const BASE = ["H", "CNOT", "measure", "request_ancilla", "release_ancilla", "route", "decode_syndrome"];

/** [{ id, title, qppm, specialize, distance, scale, calls }] */
export function programs() {
  return [
    { id: "memory-d3", title: "One logical qubit, read out in Z", qppm: frv("compiler", "examples", "memory.qppm"), specialize: {}, distance: 3, scale: "S", calls: BASE },
    { id: "dj-d3", title: "Deutsch-Jozsa on one logical qubit (FormalRV DJ)", qppm: frv("FormalRV", "Examples", "QParamPPM", "DJ.qppm"), specialize: {}, distance: 3, scale: "S", calls: [...BASE, "pauli_frame_update"] },
    { id: "bell-d3", title: "Logical Bell pair: Z⊗Z, X⊗X and Z readouts", qppm: own("bell"), specialize: {}, distance: 3, scale: "M", calls: [...BASE, "CZ"] },
    { id: "zzmerge-d3", title: "Z⊗Z merge of two blocks by lattice surgery", qppm: frv("FormalRV", "Examples", "QParamPPM", "ZZmerge.qppm"), specialize: { a: 0, b: 1 }, distance: 3, scale: "M", calls: [...BASE, "CZ", "pauli_frame_update"] },
    { id: "ghz3-d3", title: "Logical GHZ state on three blocks", qppm: own("ghz3"), specialize: {}, distance: 3, scale: "L", calls: [...BASE, "CZ"] },
    { id: "measurement-d3", title: "Three-block measurement program (FormalRV checked_measurement)", qppm: frv("compiler", "examples", "checked_measurement.qppm"), specialize: {}, distance: 3, scale: "L", calls: [...BASE, "CY", "pauli_frame_update"] },
    { id: "tinject-d3", title: "Two T gates by magic-state injection (FormalRV tinject)", qppm: frv("compiler", "examples", "tinject.qppm"), specialize: {}, distance: 3, scale: "L", calls: [...BASE, "CZ", "request_magic", "pauli_frame_update"] },
    { id: "loop-d3", title: "Repeated merges in a loop (FormalRV checked_loop)", qppm: frv("compiler", "examples", "checked_loop.qppm"), specialize: {}, distance: 3, scale: "XL", calls: [...BASE, "pauli_frame_update"] },
    { id: "memory-d5", title: "One logical qubit at distance 5", qppm: own("memory-d5"), specialize: {}, distance: 5, scale: "M", calls: BASE },
    { id: "bell-d5", title: "Logical Bell pair at distance 5", qppm: own("bell-d5"), specialize: {}, distance: 5, scale: "XL", calls: [...BASE, "CZ"] },
    { id: "zzmerge-d5", title: "Z⊗Z merge at distance 5", qppm: frv("FormalRV", "Examples", "QParamPPM", "ZZmerge.qppm"), specialize: { a: 0, b: 1 }, distance: 5, scale: "XL", calls: [...BASE, "CZ", "pauli_frame_update"] },
  ];
}

/** The design points each platform is run on: two per platform. */
export const DESIGNS = Object.freeze({
  superconducting: [
    { id: "sc-A", title: "2 transmons per control core, one single-core decoder", options: { qubitsPerCore: 2, decoders: 1, coresPerDecoder: 1 } },
    { id: "sc-B", title: "4 transmons per control core, two 4-core decoders", options: { qubitsPerCore: 4, decoders: 2, coresPerDecoder: 4 } },
  ],
  neutral: [
    { id: "atoms-moving", title: "atoms on a 10 µm lattice; every route moves atoms into gate sites", options: { id: "atoms-moving" } },
    { id: "atoms-static", title: "atoms on a 2.5 µm interaction lattice; only long-range routes move", options: { id: "atoms-static" } },
  ],
  qccd: [
    { id: "ions-qccd", title: "QCCD grid, one ion per zone; routes shuttle ions into the hub's zone", options: { id: "ions-qccd" } },
    { id: "ions-modules", title: "one ion chain per code block; only merges shuttle", options: { id: "ions-modules" } },
  ],
});
