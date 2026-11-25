// What FormalRV's superconducting audit machines would need from a RISC-Q control system, at the
// rates this tree measured. Arithmetic on measured rates, not a simulation: every input is either an
// audit's declared value (FormalRV/Audit/*, riscq/calib/table.mjs AUDITS) or a measurement here, and
// the result says which.
//
// Measured (cycle-exact model, RTL-checked core and hub):
//   cores per board        14 (riscq/board.mjs ZCU216 sizing; one transmon per core: one demod each)
//   hub, per board         500 bits/µs (riscq/calib/fabric.mjs)
//   lane, per board pair   3.1 bits/µs: one published bit per lane frame, 160 cycles a frame
//   decoder, per core      the compiled union-find's cost per syndrome bit on noisy surface-code
//                          syndromes (validation/ftqvm/decoder-calibration.json workloads at the
//                          lowest noise, d = 5, 4 rounds: median and worst); its latency model
//                          (a + b·n above every workload) is the bound
// Declared by each audit: qubits, code distance, the latencies that set a syndrome round, decoders,
// decoder_latency_ns, classical_data_bandwidth.
import { readFileSync, writeFileSync } from "node:fs";
import { AUDITS } from "./table.mjs";

const CAL = JSON.parse(readFileSync(new URL("../../validation/ftqvm/decoder-calibration.json", import.meta.url), "utf8"));
const FABRIC = JSON.parse(readFileSync(new URL("../../validation/calib/fabric.json", import.meta.url), "utf8"));

/** Code distance of each superconducting audit's main code ([[n,k,d]] from its .qec). */
export const DISTANCE = { GE2021: 27, Gidney2025: 25, Beverland2022: 13, Pinnacle: 16, Jacinto2026: 35 };

export function scaleRows() {
  const coresPerBoard = 14;
  const hub = FABRIC.flood.hub.bitsPerUs, lane = FABRIC.flood.lane.bitsPerUs;
  // Decoder cost per syndrome bit, ns: the d = 5, 4-round workload at p = 0.001 (96 detectors).
  const wl = CAL.workloads.find((w) => w.d === 5 && w.rounds === 4 && w.p === 0.001);
  const perBit = { median: wl.ns.median / wl.detectors, worst: wl.ns.max / wl.detectors, model: CAL.model.b };
  const rows = [];
  for (const [name, m] of Object.entries(AUDITS.superconducting)) {
    const d = DISTANCE[name];
    // One rotated-surface-code round: 4 two-qubit layers, 2 one-qubit layers, measurement, reset.
    const roundNs = m.measure_ns + 4 * m.gate2q_ns + 2 * m.gate1q_ns + m.reset_ns;
    const patchQubits = 2 * d * d - 1, syndromeBitsPerRound = d * d - 1;
    const bitsPerUsPerPatch = (1000 * syndromeBitsPerRound) / roundNs;
    const qubits = { GE2021: 19248768, Gidney2025: 1000000, Beverland2022: 8720000, Pinnacle: 86031, Jacinto2026: 32040090 }[name];
    const boards = Math.ceil(qubits / coresPerBoard);
    const coresPerPatchDecoder = (x) => Math.ceil((bitsPerUsPerPatch * x) / 1000);
    rows.push({
      audit: name, distance: d, qubits, roundNs, patchQubits, boardsPerPatch: Math.ceil(patchQubits / coresPerBoard),
      controlCores: qubits, boards,
      classical: { declaredBitsPerUs: m.classical_data_bandwidth, hubBitsPerUs: boards * hub, hubOverDeclared: (boards * hub) / m.classical_data_bandwidth },
      syndrome: { bitsPerUsPerPatch, laneBitsPerUs: lane, lanesNeededPerPatch: Math.ceil(bitsPerUsPerPatch / lane) },
      decoder: {
        declaredLatencyNs: m.decoder_latency_ns, declaredDecoders: m.decoders,
        firmwareCoresPerPatch: { median: coresPerPatchDecoder(perBit.median), worst: coresPerPatchDecoder(perBit.worst), model: coresPerPatchDecoder(perBit.model) },
        firmwareWindowLatencyNs: { median: perBit.median * syndromeBitsPerRound * 10, model: perBit.model * syndromeBitsPerRound * 10 },
      },
    });
  }
  return { perBitNs: perBit, coresPerBoard, hubBitsPerUs: hub, laneBitsPerUs: lane, rows };
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const out = scaleRows();
  writeFileSync(new URL("../../validation/calib/scale.json", import.meta.url), JSON.stringify({ generated: new Date().toISOString(), ...out }, null, 1) + "\n");
  console.log("decoder ns per syndrome bit: median", out.perBitNs.median.toFixed(0), "worst", out.perBitNs.worst.toFixed(0), "model", out.perBitNs.model);
  for (const r of out.rows) console.log(r.audit.padEnd(14), "d=" + r.distance, "| boards", r.boards.toLocaleString("en"), "(" + r.boardsPerPatch + " per patch)", "| hub/declared", r.classical.hubOverDeclared.toFixed(1) + "×",
    "| syndrome", r.syndrome.bitsPerUsPerPatch.toFixed(0), "bits/µs per patch =", r.syndrome.lanesNeededPerPatch, "lanes", "| firmware decoder cores per patch: median", r.decoder.firmwareCoresPerPatch.median, "worst", r.decoder.firmwareCoresPerPatch.worst,
    "| 10-round window decode: median", (r.decoder.firmwareWindowLatencyNs.median / 1e6).toFixed(2), "ms vs declared", r.decoder.declaredLatencyNs / 1000, "µs");
}
