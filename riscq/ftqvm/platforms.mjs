// Platform adapters for spec derivation (riscq/ftqvm/derive.mjs): how a listing is placed, which
// design realizes it, how it runs, and which capacities the design offers.
import { place, gatedPairs } from "./place.mjs";
import { onDevice } from "./twins.mjs";
import { chipDesign } from "./sc-chip.mjs";
import { runListing } from "./sc-run.mjs";
import { opticalDesign, runOptical, OPTICAL_DESIGNS, PROFILES } from "./optical.mjs";

const v = (value, source, note) => ({ value, source, ...(note ? { note } : {}) });

/**
 * Transmons on a generated chip (riscq/ftqvm/sc-chip.mjs). Design options:
 *   qubitsPerCore    transmons one control core drives (1: a core per qubit)
 *   decoders         decoder units; coresPerDecoder  cores of one unit
 *   gap              empty lattice columns between code blocks
 */
export function transmon({ qubitsPerCore = 1, decoders = 1, coresPerDecoder = 1, gap = 2, name } = {}) {
  const options = { qubitsPerCore, decoders, coresPerDecoder };
  return {
    name: name ?? "transmon " + JSON.stringify(options),
    options,
    gridNs: 2, // 500 MHz RISC-Q board
    place: (listing, { distance }) => place(listing, { d: distance, gap }),
    design: (listing, placement) => chipDesign(listing, placement, options).design,
    run: (listing, placement, design, { outcomes, distance }) => runListing(listing, placement, design, { outcomes, distance }),
    capacities: (design, placement, durations) => {
      const sites = placement.sites.length;
      const route = Math.max(2, durations.route_latency_ns?.value ?? 2), reset = Math.max(2, durations.reset_ns?.value ?? 160);
      return {
        qubits: v(sites, "derived", "one transmon per placed site"),
        factories: v(1, "provisional", "no factory realized yet"),
        max_parallel_gates: v(sites, "derived", "every transmon has its own drive and coupler channels"),
        decoders: v(decoders, "derived", decoders + " decoder unit(s) of " + coresPerDecoder + " core(s)"),
        classical_data_bandwidth: v(500, "derived", "the board hub carries one put of one bit per batch at 500 MHz (riscq/limits.mjs)"),
        // A route on this chip needs no action, so any number of sites can be in routes at once.
        qubit_routing_bandwidth: v(Math.ceil((1000 * sites) / route), "derived", "every site in a route at once"),
        ancilla_bandwidth: v(Math.ceil((1000 * sites) / reset), "derived", "every site reset at once"),
      };
    },
  };
}

/**
 * Atoms or ions on an optical design point (riscq/ftqvm/optical.mjs OPTICAL_DESIGNS): the
 * controller runs at 100 MHz (10 ns batches); gate slots are the addressing beams; a route
 * moves at most `movers` qubits at once; resets have their own pumping beams.
 */
export function optical(id, overrides = {}) {
  return {
    name: id, options: { id, ...overrides },
    gridNs: 10,
    // `blockSize`: qubits of one code block when it is not d² (7 for the Steane code).
    place: (listing, { distance }) => place(listing, { d: distance, gap: 2, n: overrides.blockSize }),
    design: (listing, placement) => opticalDesign(listing, placement, id, overrides),
    // The profile's durations, to start the derivation near the hardware (provisional until measured).
    initialDurations: () => {
      const point = { ...OPTICAL_DESIGNS[id], ...overrides }, p = PROFILES[point.profile];
      const one = point.globalOneQubit ? p.globalOneQubitNs.value : p.oneQubitNs.value;
      // On a race track a gate may first carry an ion half way round the loop.
      const transport = p.ringZones ? p.splitNs.value + (p.ringZones.value / 2) * p.shuttleNs.value + p.mergeNs.value : 0;
      const g = (value) => ({ value: Math.ceil(value / 10) * 10, source: "provisional", note: "from the platform profile" });
      return {
        gate1q_ns: g(one), gate2q_ns: g(2 * one + p.twoQubitNs.value + transport), measure_ns: g(p.measureNs.value + (p.readoutMoveNs?.value ?? 0)),
        reset_ns: g(p.resetNs.value), route_latency_ns: g(p.moveNs?.value ?? 10),
      };
    },
    run: (listing, placement, design, { outcomes, distance }) => runOptical(listing, placement, design, { outcomes, distance }),
    capacities: (design, placement, durations) => {
      const route = Math.max(10, durations.route_latency_ns?.value ?? 10), reset = Math.max(10, durations.reset_ns?.value ?? 10);
      return {
        qubits: design.point.qubits
          ? v(design.point.qubits.value, "derived", "the device's qubits (" + design.point.qubits.source + ")")
          : design.prof.atoms ?? design.prof.qubits
          ? v((design.prof.atoms ?? design.prof.qubits).value, "derived", "the device's qubits (" + (design.prof.atoms ?? design.prof.qubits).source + ")")
          : v(placement.sites.length, "derived", "one trapped " + (design.prof.platform === "neutral" ? "atom" : "ion") + " per placed site"),
        factories: v(1, "derived", "one factory region"),
        max_parallel_gates: design.point.globalEntangle
          ? v(design.prof.gateSites.value, "derived", "global pulses serve every gate site (" + design.prof.gateSites.source + ")")
          : v(design.point.beams, "derived", design.point.beams + " locally addressed beams"),
        decoders: v(design.decoders, "derived", design.decoders + " decoder unit(s) of " + design.coresPerDecoder + " cores"),
        classical_data_bandwidth: v(100, "derived", "the board hub carries one put of one bit per batch at 100 MHz (riscq/limits.mjs)"),
        // FormalRV charges a request ⌈1000·N/D⌉ items/µs, at least 1 however slow it is. With
        // routes and resets of 100 µs and more, a physical rate (a few qubits/µs) would refuse
        // listings the hardware runs; the capacity is stated as the number of such requests the
        // hardware serves at once (at least the physical rate). Recorded as a finding.
        // On the twin a route is an AOD job and the device has `movers` AODs. Routes that start in
        // the same batch share a job, but FormalRV cannot state that, so the capacity is the AODs:
        // FormalRV then runs a transversal gate's per-pair routes a few at a time (a finding).
        qubit_routing_bandwidth: v(Math.max(Math.ceil((1000 * design.point.movers) / route), design.point.movers), "derived",
          design.point.movers + (design.prof.platform === "neutral" ? " AOD jobs" : " electrode lanes") + " at once; FormalRV's ceiling charges each at least 1 qubit/µs"),
        ancilla_bandwidth: design.point.globalPump
          ? v(design.prof.atoms.value, "derived", "global optical pumping serves every one of " + design.prof.atoms.value + " atoms at once; FormalRV's ceiling charges each request at least 1 qubit/µs")
          : v(Math.max(Math.ceil((1000 * (design.point.pumps ?? 64)) / reset), design.point.pumps ?? 64), "derived", (design.point.pumps ?? 64) + " pumping beams at once"),
      };
    },
  };
}

/**
 * Transmons on a digital twin (riscq/ftqvm/twins.mjs): the listing is placed, then checked
 * against the device's qubits and couplers; the chip is the device with its published durations.
 */
export function transmonTwin(device, { qubitsPerCore = 2, decoders = 1, coresPerDecoder = 4 } = {}) {
  const base = transmon({ qubitsPerCore, decoders, coresPerDecoder });
  return {
    ...base, name: device.id, options: { device: device.id, qubitsPerCore, decoders, coresPerDecoder },
    place: (listing, { distance }) => {
      const p = place(listing, { d: distance, gap: 2 });
      return onDevice(p, device, gatedPairs(listing, p));
    },
    design: (listing, placement) => chipDesign(listing, placement, { qubitsPerCore, decoders, coresPerDecoder, device, name: device.title }).design,
  };
}
