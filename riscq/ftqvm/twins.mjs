// Digital twins of published machines: the device each experiment ran on, as a fixed set of
// qubits, couplers and calibrated durations, with the source of every number. A QSysASM listing
// is compiled onto a twin by placing it (riscq/ftqvm/place.mjs) and checking that every placed
// qubit is a qubit of the device and every gated pair one of its couplers (`onDevice`).
//
// What "exact" covers, per twin, is stated in its `basis`: geometry and durations the paper
// gives are taken from it; anything it does not give is named, with the source used instead.
import { STANDARD } from "../standards.mjs";
import { checks } from "./surface.mjs";

const willowPaper = "Google Quantum AI, Nature 638, 920 (2025), arXiv:2408.13687";

/**
 * Google's 105-qubit processor (Willow) of "Quantum error correction below the surface code
 * threshold": a square grid of transmons with tunable couplers. In the lattice coordinates of
 * riscq/ftqvm/surface.mjs the grid is turned 45°: data qubits at integer points, measure qubits
 * at half-integer points, a coupler between points √2/2 apart.
 * Geometry: the paper's distance-7 patch (49 data and 48 measure qubits, 97 of the 105). The
 * remaining 8 qubits (the paper uses some for leakage removal) are not placed: the published
 * text gives no coordinates for them, and no experiment here uses them.
 */
export function willow() {
  const d = 7, sites = [];
  for (let j = 0; j < d * d; j++) sites.push({ rc: [Math.floor(j / d), j % d], kind: "data" });
  for (const ch of checks(d)) sites.push({ rc: ch.rc, kind: "measure" });
  const couplers = [];
  sites.forEach((a, i) => sites.forEach((b, k) => {
    if (k > i && Math.abs(Math.hypot(a.rc[0] - b.rc[0], a.rc[1] - b.rc[1]) - Math.SQRT1_2) < 1e-9) couplers.push([i, k]);
  }));
  return {
    id: "google-willow", title: "Google 105-qubit processor (Willow), distance-7 patch", platform: "superconducting",
    sites, couplers,
    durations: {
      x90Ns: { value: 25, source: willowPaper + ", Methods: \"all XY rotations have 25 ns duration\"" },
      xNs: { value: 25, source: willowPaper + ", Methods: \"all XY rotations have 25 ns duration\"" },
      czNs: { value: 42, source: willowPaper + ", Methods: \"Our CZ gates are performed in 42 ns on the 105-qubit processor\"" },
      readoutNs: { value: STANDARD.superconducting.readoutNs.value, source: STANDARD.superconducting.readoutNs.source + " (the 2025 paper gives no readout duration)" },
      resetNs: { value: STANDARD.superconducting.resetNs.value, source: STANDARD.superconducting.resetNs.source + " (the 2025 paper gives no reset duration)" },
    },
    published: {
      cycleNs: { value: 1100, source: willowPaper + ": \"the fast error correcting cycle time of 1.1 µs\"" },
      decoderLatencyNs: { value: 63000, source: willowPaper + ": \"average decoder latency of 63 µs at distance-5\" (software decoder)" },
      distances: [3, 5, 7], cycles: { value: 250, source: willowPaper + ": logical error per cycle fit \"up to 250 cycles\"" },
    },
    basis: "Durations of gates from the paper; readout and reset from the group's 2023 paper. Geometry: the distance-7 patch on the square grid. " +
      "Frequencies, pulse shapes and readout multiplexing are not published; the chip reuses RISC-Q's x6y3 pulse shapes with these durations. " +
      "The control electronics are QuantumOS's RISC-Q model, not Google's.",
  };
}

/**
 * A placement on a device: every placed site must be one of the device's qubits (matched by
 * lattice position), and every pair the listing gates one of its couplers. Returns a placement
 * whose sites are the device's, in device order, or throws with what does not fit.
 */
export function onDevice(placement, device, pairs) {
  const at = new Map(device.sites.map((s, i) => [s.rc.join(","), i]));
  const map = placement.sites.map((s) => at.get(s.rc.join(",")));
  const missing = placement.sites.filter((_, k) => map[k] === undefined);
  if (missing.length) throw Error("the program does not fit " + device.id + ": " + missing.length + " placed qubits are not device qubits (e.g. at " + JSON.stringify(missing[0].rc) + ")");
  const coupled = new Set(device.couplers.map(([a, b]) => a + "-" + b));
  const uncoupled = pairs.filter((p) => { const [a, b] = p.sites.map((s) => map[s]).sort((x, y) => x - y); return !coupled.has(a + "-" + b); });
  if (uncoupled.length) throw Error("the program does not fit " + device.id + ": " + uncoupled.length + " gated pairs have no coupler (e.g. between " +
    JSON.stringify(placement.sites[uncoupled[0].sites[0]].rc) + " and " + JSON.stringify(placement.sites[uncoupled[0].sites[1]].rc) + ")");
  const sites = device.sites.map((s, i) => ({ id: (s.kind === "data" ? "d" : "m") + i, kind: s.kind === "data" ? "data" : "ancilla", rc: s.rc }));
  return { ...placement, sites, siteOf: (a) => map[placement.siteOf(a)], device: device.id };
}
