// QSysASM listings on optically controlled qubits that move: neutral atoms in tweezers and
// ions in a QCCD trap. One engine, two platform profiles, two design points each.
//
// What the controller does for each listing operation (time-triggered, as on the transmon chip):
//   one-qubit gate    a pulse on a locally addressed beam (H, X); S, Sdg and Z are frame updates
//   CZ                one entangling pulse on a beam that addresses the pair (Rydberg or MS)
//   CNOT, CY          H(t) · CZ · H(t), with frames for CY
//   measure           an imaging (atoms) or detection (ions) pulse on a readout channel, and the
//                     photon edges of its counter line counted over the exposure
//   request_ancilla   an optical-pumping pulse on a beam, per qubit
//   route             the motion planner moves the route's qubits so that every pair the route
//                     licenses can interact; each moving qubit holds a transport channel (an AOD
//                     tone, an electrode lane) for its move
//   request_magic     the injection factory of riscq/ftqvm/sc-run.mjs, on a dedicated factory
//                     region whose checks interact in place, decoded by the factory's decoder
//   decode, frame, parity   as on the transmon chip (decoder service, frame core)
// Interaction (design point):
//   atoms  two atoms interact when they are at most `interactUm` apart (a gate site; Bluvstein
//          et al. place the atoms of a gate site ≲2 µm apart). A route keeps its hub (the qubit
//          every licensed gate shares, else its first operand) and moves the others onto free
//          spots at `gateUm` around it.
//   ions   two ions interact when they are in one zone. A route shuttles the other operands into
//          the hub's zone (at most `zoneCapacity` ions).
// Timing laws (cited in PROFILES): atom move = pick-up + √(d/a) + drop (ZAC's law); ion shuttle =
// split + shift per segment + junction per turn + merge + re-cooling.
// Boundaries: AOD row/column ordering, collisions, heating and loss are not modeled; a move is
// one transport waveform of its duration (riscq/platforms/neutral.mjs models AOD frequency
// stepping, not reproduced here); photon counts come from the outcomes, as for QCCD detection.
import { execute, socSpec, AMP_SCALE } from "../soc.mjs";
import { assemble, measuredBits } from "../compile.mjs";
import { STANDARD } from "../standards.mjs";
import { placeOnBoards } from "../board.mjs";
import { gatedPairs } from "./place.mjs";
import { layers, checks } from "./surface.mjs";
import { runDecodes, runFactoryDecodes } from "./decoder.mjs";
import { conformance, addRows } from "./sc-run.mjs";
import { buildTrack, controllerTrack } from "./track.mjs";

// Every optical controller runs at RISC-Q's dspClk on the ZCU216, 500 MHz: the clock its RTL is measured
// at here (validation/riscq/rtl), and the only one the board-to-board lane is measured at.
const RISCQ_DSP_HZ = 500e6;
// How far before a gate's listed start a shared global pulse may have started (see beamPulse): the
// width of one batch of the 100 MHz controller this module first ran on, which shared within a batch.
const GLOBAL_LEAD_NS = 10;
const bluvstein = "Bluvstein et al., Nature 626, 58 (2024), arXiv:2312.03982, Methods";
const norcia = "Norcia et al., PRX 13, 041034 (2023), arXiv:2305.19119";
const zac = "Lin, Tan, Cong, HPCA 2025, arXiv:2411.11784, Sec. VII-B";
const pino = "Pino et al., Nature 592, 209 (2021), arXiv:2003.01293";
const h2 = "Moses et al., PRX 13, 041052 (2023), arXiv:2305.03828, as QCCD Studio's arch/h2_racetrack.arch.json cites it";
const jones = "arXiv:2510.23519 (QCCD Studio's qccdsim_jones table in arch/h2_racetrack.arch.json)";

/** Platform constants, each with its source. Times in ns, lengths in µm. */
export const PROFILES = Object.freeze({
  atoms: {
    platform: "neutral", dspHz: RISCQ_DSP_HZ,
    oneQubitNs: { value: 8000, source: bluvstein + ": local gates, \"the duration of each row is 5-8 μs\" (upper value)" },
    twoQubitNs: { value: 270, source: bluvstein + ": \"Entangling gates (270-ns duration)\"" },
    measureNs: { value: 500000, source: bluvstein + ": \"the 500-μs midcircuit imaging\"" },
    resetNs: { value: 100000, source: norcia + ": \"we use 100 μs for OP\" (optical pumping)" },
    transferNs: { value: STANDARD.neutral.transferNs.value, source: zac + ": atom transfer 15 µs" },
    accel: { value: STANDARD.neutral.moveAcceleration.value, source: zac + ": d/t² = 2750 m/s²" },
    gateUm: { value: 2, source: bluvstein + ": atoms of a gate site ≲2 µm apart" },
  },
  // The device of Bluvstein et al. 2024, with the paper's own numbers wherever it gives one.
  bluvstein: {
    platform: "neutral", dspHz: RISCQ_DSP_HZ,
    oneQubitNs: { value: 8000, source: bluvstein + ": local gates, \"the duration of each row is 5-8 μs\" (upper value)" },
    twoQubitNs: { value: 270, source: bluvstein + ": \"Entangling gates (270-ns duration)\", one global pulse for every gate site" },
    measureNs: { value: 500000, source: bluvstein + ": \"the 500-μs midcircuit imaging\"" },
    readoutMoveNs: { value: 200000, source: bluvstein + ": atoms move ~100 µm to the readout zone; \"characteristic free-space movement time ... roughly 200 μs\"" },
    resetNs: { value: 100000, source: norcia + ": \"we use 100 μs for OP\" (the 2024 paper gives no reset time)" },
    moveNs: { value: 200000, source: bluvstein + ": \"The characteristic free-space movement time between gates is roughly 200 μs\"" },
    gateUm: { value: 2, source: bluvstein + ": atoms of a gate site ≲2 µm apart" },
    siteUm: { value: 10, source: bluvstein + ": \"atoms in different gate sites are no closer than 10 μm during the gate\"" },
    gateSites: { value: 100, source: bluvstein + ": gate sites 5 high (surface-code experiment) × 20 wide" },
    atoms: { value: 280, source: bluvstein + ": \"up to 280 physical qubits\"" },
    globalOneQubitNs: { value: 1000, source: bluvstein + ": \"∼1 μs rotations with composite pulse techniques\" (global Raman)" },
  },
  // Quantinuum H2 as QCCD Studio describes it (arch/h2_racetrack.arch.json): a race track of 2 × 20
  // trap zones in one loop, no junctions, two ions per zone; its primitives' cited durations.
  h2: {
    platform: "qccd", dspHz: RISCQ_DSP_HZ,
    oneQubitNs: { value: 5000, source: h2 + ": one-qubit gate 5 µs" },
    twoQubitNs: { value: 25000, source: h2 + ": MS gate 25 µs" },
    measureNs: { value: 120000, source: h2 + ": measurement 120 µs" },
    resetNs: { value: 50000, source: jones + ": reset 50 µs" },
    splitNs: { value: 80000, source: jones + ": split 80 µs" },
    mergeNs: { value: 80000, source: jones + ": merge 80 µs" },
    shuttleNs: { value: 5000, source: jones + ": one segment of shuttling 5 µs" },
    ringZones: { value: 40, source: "QCCD Studio arch/h2_racetrack.arch.json: racetrack generator, straight = 20 (2 × 20 trap zones)" },
    zoneCapacity: { value: 2, source: "QCCD Studio arch/h2_racetrack.arch.json: trap zones hold 2 ions" },
    qubits: { value: 32, source: h2 + ": 32 qubits (arch provenance)" },
  },
  ions: {
    platform: "qccd", dspHz: RISCQ_DSP_HZ,
    oneQubitNs: { value: STANDARD.qccd.rotationNs.value, source: pino + ", Table III" },
    twoQubitNs: { value: STANDARD.qccd.twoQubitNs.value, source: pino + ", Table III" },
    measureNs: { value: STANDARD.qccd.measureNs.value, source: pino + ", Table III" },
    resetNs: { value: STANDARD.qccd.initNs.value, source: pino + ", Table III (state preparation)" },
    splitNs: { value: STANDARD.qccd.splitNs.value, source: pino + ", Table II (split or combine)" },
    shiftNs: { value: Math.round(STANDARD.qccd.shiftNs.value * (1 + STANDARD.qccd.transportOverhead.value)), source: pino + ", Table II, +10% (caption)" },
    junctionNs: { value: STANDARD.qccd.junctionNs.value, source: STANDARD.qccd.junctionNs.source },
    coolNs: { value: STANDARD.qccd.coolNs.value, source: pino + ", Table III (Doppler cooling)" },
    segmentUm: { value: 110, source: pino + ", Table II (one shift is 110 µm)" },
  },
});

/** The four design points. */
export const OPTICAL_DESIGNS = Object.freeze({
  "atoms-moving": { profile: "atoms", pitchUm: 10, interactUm: 2.5, beams: 16, movers: 4, title: "atoms on a 10 µm lattice; every route moves atoms into gate sites" },
  "atoms-static": { profile: "atoms", pitchUm: 2.5, interactUm: 2.5, beams: 16, movers: 4, title: "atoms on a 2.5 µm interaction lattice; only long-range routes move" },
  // A twin of the Bluvstein et al. 2024 processor: data on gate-site pitch, one AOD job moves a
  // route's atoms (200 µs), one global Rydberg pulse serves every gate site, row-addressed
  // one-qubit gates, readout after a move to the readout zone.
  "bluvstein-2024": { profile: "bluvstein", pitchUm: 10, interactUm: 2.5, beams: 20, movers: 2, globalEntangle: true, globalOneQubit: true, globalPump: true, decoders: 4, coresPerDecoder: 1,
    title: "twin of Bluvstein et al., Nature 626, 58 (2024): zoned array, global Rydberg pulses, AOD moves" },
  // A twin of Quantinuum's H2: every two-qubit gate brings its second ion to its partner's zone
  // along the race track (split, one 5 µs shift per zone, merge) before the MS gate; `route`
  // needs nothing. Every trap zone can gate (QCCD Studio's H2 model).
  "quantinuum-h2": { profile: "h2", perGateTransport: true, beams: 40, movers: 40, decoders: 4, coresPerDecoder: 1,
    title: "twin of Quantinuum H2 (QCCD Studio's racetrack): per-gate transport around a 40-zone loop" },
  "ions-qccd": { profile: "ions", zoneOf: "site", zoneCapacity: 12, beams: 16, movers: 32, title: "QCCD grid, one ion per zone; routes shuttle ions into the hub's zone" },
  "ions-modules": { profile: "ions", zoneOf: "block", zoneCapacity: 64, beams: 16, movers: 32, title: "one ion chain per code block; only merges shuttle" },
});

const TWO = new Set(["CZ", "CNOT", "CY"]);
const key = (q) => q.register + "[" + q.index + "]";
const recordName = (r) => r.register + "[" + r.index + "]";

/** The design of a listing on an optical platform: geometry, interaction and the controller's channels. */
export function opticalDesign(listing, placement, id, overrides = {}) {
  const point = { ...OPTICAL_DESIGNS[id], ...overrides };
  // `profile` overrides (an edited twin): { field: { value, source } } replace the profile's constants.
  const prof = { ...PROFILES[point.profile], ...(point.profileOverrides ?? {}) };
  const pitch = prof.platform === "neutral" ? point.pitchUm : prof.segmentUm?.value ?? 1; // a race track places by zone index
  // A designed machine (riscq/hw/compile.mjs) gives every placed site its own position (`homeUm`).
  if (point.homeUm && point.homeUm.length < placement.sites.length)
    throw Error("the program does not fit this machine: it places " + placement.sites.length + " qubits and the machine has " + point.homeUm.length);
  const home = placement.sites.map((s, k) => point.homeUm?.[k] ?? [s.rc[1] * pitch, s.rc[0] * pitch]);
  // Ions: the zone of a site is the site itself or its block's patch (non-block sites keep their own).
  const zoneOfSite = placement.sites.map((s, k) => {
    if (point.profile !== "ions" || point.zoneOf === "site") return k;
    const slot = Math.round(s.rc[1] / (placement.d + placement.gap));
    const inPatch = s.rc[0] >= -0.5 && s.rc[0] <= placement.d - 0.5 && s.rc[1] >= slot * (placement.d + placement.gap) - 0.5 && s.rc[1] <= slot * (placement.d + placement.gap) + placement.d - 0.5;
    return inPatch ? "block" + slot : k;
  });
  // The race track: sites in placement order (column, then row) around the loop, one per zone.
  if (prof.ringZones) {
    const order = placement.sites.map((s, k) => [s.rc[1], s.rc[0], k]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (order.length > prof.ringZones.value * prof.zoneCapacity.value) throw Error(id + ": " + order.length + " ions do not fit " + prof.ringZones.value + " zones of " + prof.zoneCapacity.value);
    order.forEach(([, , k], i) => (zoneOfSite[k] = i % prof.ringZones.value));
  }
  // Readout channels: as many as the listing measures at once.
  const ev = [];
  for (const o of listing.ops) if (o.kind === "measure") ev.push([o.start, 1], [o.end, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, readouts = 1;
  for (const [, d] of ev) readouts = Math.max(readouts, (cur += d));
  void readouts;
  return { kind: "optical-design", id, point, profile: point.profile, prof, pitchUm: pitch, home, zoneOfSite, readouts: point.readouts ?? 16, decoders: point.decoders ?? 1, coresPerDecoder: point.coresPerDecoder ?? 4 };
}

/** Pools of channels a native instruction may take: the lowest free over its interval. */
function pool(name, size) {
  const busy = [];
  let next = 0;
  return {
    name, size, peak: 0, lent: 0,
    /** A channel free over [t, t + dur), tried in rotation from the one after the last taken, so
     *  that work spreads over the design's channels (and their cores' memory and queues). Past
     *  the design's `size`, a channel is lent: the instruction is not run, and its listing
     *  operation does not conform (the design has no such channel). */
    /** Lengthen the interval a channel holds from `t` to end at `end`. */
    extend(i, t, end) {
      const iv = (busy[i] ?? []).find(([a]) => a === t);
      if (iv) iv[1] = Math.max(iv[1], end);
    },
    take(t, dur, prefer) {
      const free = (i) => (busy[i] ??= []).every(([a, b]) => t + dur <= a || b <= t);
      // A caller's own channel (a factory check's detector, round after round), when it is free.
      if (prefer !== undefined && prefer < size && free(prefer)) {
        busy[prefer].push([t, t + dur]);
        this.peak = Math.max(this.peak, prefer + 1);
        return prefer;
      }
      // A pulse that starts as another ends continues on that channel (a beam stays on its atom
      // for the next pulse of a sequence). Rotating instead would scatter one sequence over
      // several channels, and a pulse that spans a boundary between its steps would find every
      // channel touched although few are busy at any instant.
      for (let i = 0; i < size; i++) if (busy[i]?.some(([, b]) => b === t) && free(i)) {
        busy[i].push([t, t + dur]);
        this.peak = Math.max(this.peak, i + 1);
        return i;
      }
      for (let k = 0; k < size; k++) {
        const i = (next + k) % size;
        if (free(i)) {
          busy[i].push([t, t + dur]);
          this.peak = Math.max(this.peak, i + 1);
          next = (i + 1) % size;
          return i;
        }
      }
      for (let i = size; ; i++) if (free(i)) {
        busy[i].push([t, t + dur]);
        this.peak = Math.max(this.peak, i + 1);
        this.lent++;
        return i;
      }
    },
  };
}

/** Channels one controller core drives: few, so that each core's program and queues stay small. */
const PER_CORE = 4;

/** Duration of one atom move: the twin's characteristic move, otherwise pick-up + √(d/a) + drop (ZAC). */
function moveNs(design, from, to) {
  if (design.prof.moveNs) return design.prof.moveNs.value;
  const dUm = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return Math.ceil(2 * design.prof.transferNs.value + Math.sqrt((dUm * 1e-6) / design.prof.accel.value) * 1e9);
}

/** Plan the motion of a route: which qubits move where, and for how long (ns). */
function planRoute(op, laterGates, design, state, placement) {
  const sites = op.qubits.map((q) => placement.siteOf(q));
  // The hub: the qubit every gate this route licenses shares, else the first operand.
  const licensed = laterGates.filter((g) => g.qubits.every((q) => sites.includes(placement.siteOf(q))));
  const common = sites.find((s) => licensed.length && licensed.every((g) => g.qubits.some((q) => placement.siteOf(q) === s)));
  const hub = common ?? sites[0];
  const moves = [];
  const pairsOf = licensed.map((g) => g.qubits.map((q) => placement.siteOf(q)));
  const matching = pairsOf.length > 1 && new Set(pairsOf.flat()).size === 2 * pairsOf.length;
  if (matching && design.profile !== "ions") {
    // Each pair meets on its own: the second atom moves next to the first, all in one AOD job.
    const at = state.position;
    for (const [a, b] of pairsOf) {
      if (Math.hypot(at[a][0] - at[b][0], at[a][1] - at[b][1]) <= design.point.interactUm + 1e-9) continue;
      const spot = [at[a][0] + design.prof.gateUm.value, at[a][1]];
      moves.push({ site: b, from: at[b], to: spot, ns: moveNs(design, at[b], spot) });
      at[b] = spot;
    }
    return { hub: undefined, moves, ns: Math.max(0, ...moves.map((m) => m.ns)), matching: true };
  }
  if (design.profile !== "ions") {
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= design.point.interactUm + 1e-9;
    const at = state.position;
    const spots = Array.from({ length: 12 }, (_, k) => [at[hub][0] + design.prof.gateUm.value * Math.cos((2 * Math.PI * k) / 12), at[hub][1] + design.prof.gateUm.value * Math.sin((2 * Math.PI * k) / 12)]);
    const taken = (p) => at.some((q, s) => s !== hub && Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.5);
    // An atom an earlier route left near this hub, and that this route does not use, goes home.
    at.forEach((q, s) => {
      if (sites.includes(s) || s === hub) return;
      const home = design.home[s];
      if ((q[0] !== home[0] || q[1] !== home[1]) && Math.hypot(q[0] - at[hub][0], q[1] - at[hub][1]) <= design.prof.gateUm.value + 0.5) {
        moves.push({ site: s, from: q, to: home, ns: moveNs(design, q, home), home: true });
        at[s] = [...home];
      }
    });
    for (const s of sites) {
      if (s === hub || near(at[s], at[hub])) continue;
      const spot = spots.filter((p) => !taken(p)).sort((p, q) => Math.hypot(p[0] - at[s][0], p[1] - at[s][1]) - Math.hypot(q[0] - at[s][0], q[1] - at[s][1]))[0];
      if (!spot) throw Error("listing line " + op.line + ": no free gate spot around the route's hub");
      moves.push({ site: s, from: at[s], to: spot, ns: moveNs(design, at[s], spot) });
      at[s] = spot;
    }
  } else {
    const zone = state.zone;
    const members = (z) => zone.filter((x) => x === z).length;
    const shuttle = (s, to) => {
      const [a, b] = [state.zonePos(zone[s]), state.zonePos(to)];
      const segments = Math.max(1, Math.ceil((Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])) / design.prof.segmentUm.value));
      const junctions = a[0] !== b[0] && a[1] !== b[1] ? 1 : 0;
      const p = design.prof;
      return { segments, junctions, ns: 2 * p.splitNs.value + segments * p.shiftNs.value + junctions * p.junctionNs.value + p.coolNs.value };
    };
    for (const s of sites) {
      if (s === hub || zone[s] === zone[hub]) continue;
      // A full zone first sends home the ions an earlier route brought there and this route does not use.
      if (members(zone[hub]) >= design.point.zoneCapacity)
        zone.forEach((z, k) => {
          if (z === zone[hub] && k !== hub && !sites.includes(k) && design.zoneOfSite[k] !== z && members(zone[hub]) >= design.point.zoneCapacity) {
            const back = shuttle(k, design.zoneOfSite[k]);
            moves.push({ site: k, from: z, to: design.zoneOfSite[k], ...back, home: true });
            zone[k] = design.zoneOfSite[k];
          }
        });
      if (members(zone[hub]) >= design.point.zoneCapacity) throw Error("listing line " + op.line + ": zone of the route's hub is full (" + members(zone[hub]) + " ions, capacity " + design.point.zoneCapacity + "; the route gathers " + sites.length + "; others there: " + zone.map((z, k) => [z, k]).filter(([z, k]) => z === zone[hub] && !sites.includes(k)).map(([, k]) => k + (design.zoneOfSite[k] === z ? " (home)" : "")).join(", ") + ")");
      const [a, b] = [state.zonePos(zone[s]), state.zonePos(zone[hub])];
      const segments = Math.max(1, Math.ceil((Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])) / design.prof.segmentUm.value));
      const junctions = a[0] !== b[0] && a[1] !== b[1] ? 1 : 0;
      const p = design.prof;
      const ns = 2 * p.splitNs.value + segments * p.shiftNs.value + junctions * p.junctionNs.value + p.coolNs.value;
      moves.push({ site: s, from: zone[s], to: zone[hub], segments, junctions, ns });
      zone[s] = zone[hub];
    }
  }
  return { hub, moves, ns: Math.max(0, ...moves.map((m) => m.ns)) };
}

/** Lower and run a listing on an optical design. Returns { report, result }. */
export async function runOptical(listing, placement, design, { outcomes = {}, distance = placement.d } = {}) {
  const prof = design.prof, period = 1e12 / prof.dspHz;
  const b = (ns) => Math.ceil((ns * 1000) / period); // batches
  const beams = pool("beam", design.point.beams), readouts = pool("readout", design.readouts), movers = pool("mover", design.point.movers);
  // Optical pumping has beams of its own: the compiler charges a reset no gate slot.
  const pumps = pool("pump", design.point.pumps ?? 64);
  const state = {
    position: design.home.map((p) => [...p]),
    zone: [...design.zoneOfSite],
    zonePos: (z) => {
      const k = design.zoneOfSite.indexOf(z);
      return k >= 0 ? design.home[k] : design.home[z];
    },
  };
  const natives = [], origin = new Map(), classical = [], decodes = [], factories = [], measures = [], shared = [];
  let counter = 0;
  const push = (op, n) => {
    const id = "h" + counter++;
    origin.set(id, op.uid);
    natives.push({ ...n, id, source: "listing line " + op.line + " · " + op.text });
    return id;
  };
  const gates = listing.ops.filter((o) => TWO.has(o.kind));
  // H2: before its gate, the second ion splits from its zone, shuttles around the loop to its
  // partner's zone and merges; an ion already there beyond the zone's capacity moves to the
  // vacated zone in the same move. Returns when the pair is together.
  const ringTransport = (op, t) => {
    if (!design.point.perGateTransport) return t;
    const [a, c] = op.qubits.map((q) => placement.siteOf(q));
    const zone = state.zone, Z = prof.ringZones.value;
    if (zone[a] === zone[c]) return t;
    const d = Math.abs(zone[a] - zone[c]), hops = Math.min(d, Z - d);
    const ns = prof.splitNs.value + hops * prof.shuttleNs.value + prof.mergeNs.value;
    const from = zone[c];
    zone[c] = zone[a];
    const crowd = zone.map((z, k) => [z, k]).filter(([z, k]) => z === zone[a] && k !== a && k !== c).map(([, k]) => k);
    const ions = [{ site: c, from, to: zone[a] }];
    if (crowd.length + 2 > prof.zoneCapacity.value) {
      ions.push({ site: crowd[0], from: zone[a], to: from });
      zone[crowd[0]] = from;
    }
    const ch = movers.take(t, b(ns));
    push(op, { op: "move", pool: "mover", channel: ch, at: t, dur: b(ns), job: { ns, hops, ions } });
    return t + b(ns);
  };
  const globalByKind = {};
  const globalPulses = new Map(), globalBusy = {}, aodJobs = new Map(), sharedMoves = [], lentEnd = new Map(); // kind and batch → native of a shared global pulse
  const beamPulse = (op, kind, t, ns) => {
    const global = (kind === "entangle" && design.point.globalEntangle) || (kind === "raman" && design.point.globalOneQubit) || (kind === "pump" && design.point.globalPump);
    if (global) {
      // One global pulse acts on every atom of the zone at once. A one-qubit layer is the paper's
      // global Raman rotation, which takes its own duration.
      if (kind === "raman") ns = prof.globalOneQubitNs.value;
      // The resource VM issues the gates of one layer a nanosecond apart (its trace), and a global beam
      // cannot follow that: a gate shares the pulse of its kind that started at most GLOBAL_LEAD_NS
      // before it and ends inside its window. Its rotation then starts up to that much before its
      // listed start; each share records how much (`earlyNs`, the report's `globalEarlyNs`).
      const windowEnd = Math.floor((op.end * 1000) / period);
      const existing = [...(globalByKind[kind] ?? [])].reverse().find((g) => g.at <= t && t - g.at <= b(GLOBAL_LEAD_NS) && g.at + b(ns) <= windowEnd);
      if (existing) {
        existing.sites++;
        if (existing.sites > design.prof.gateSites.value) existing.overfull = true;
        const id = "h" + counter++;
        origin.set(id, op.uid);
        shared.push({ id, of: existing.id, earlyNs: ((t - existing.at) * period) / 1000 });
        return existing.at + b(ns);
      }
      // A pulse that would overlap the previous one of its kind has no beam: it is lent (not
      // run, and its operation does not conform). Its operation reports the end it would have
      // had on the next free pulse, so the next spec grows by at most one pulse; nothing waits
      // inside this run, so nothing compounds.
      const busy = (globalBusy[kind] ??= []);
      // Wait for the beam while the gate still ends inside its listed window.
      let w = t;
      for (let moved = true; moved; ) {
        moved = false;
        for (const [a, e] of busy) if (w < e && a < w + b(ns)) (w = e), (moved = true);
      }
      if (w > t && w + b(ns) <= windowEnd) {
        const reuse = globalPulses.get(kind + w);
        if (reuse) {
          const id2 = "h" + counter++;
          origin.set(id2, op.uid);
          shared.push({ id: id2, of: reuse.id });
          return w + b(ns);
        }
        const idw = push(op, { op: kind, pool: "global", channel: { entangle: 0, raman: 1, pump: 2 }[kind], at: w, dur: b(ns) });
        busy.push([w, w + b(ns)]);
        globalPulses.set(kind + w, { id: idw, sites: 1 });
        (globalByKind[kind] ??= []).push({ id: idw, at: w, sites: 1 });
        return w + b(ns);
      }
      const over = w > t;
      const id = push(op, { op: kind, pool: "global", channel: over ? 3 : { entangle: 0, raman: 1, pump: 2 }[kind], at: t, dur: b(ns) });
      if (over) lentEnd.set(op.uid, Math.max(lentEnd.get(op.uid) ?? 0, w + b(ns)));
      else {
        busy.push([t, t + b(ns)]);
        (globalByKind[kind] ??= []).push({ id, at: t, sites: 1 });
      }
      globalPulses.set(kind + t, { id, sites: 1 });
      return t + b(ns);
    }
    const p = kind === "pump" ? pumps : beams;
    const ch = p.take(t, b(ns));
    push(op, { op: kind, pool: p.name, channel: ch, at: t, dur: b(ns) });
    return t + b(ns);
  };
  const oneQubit = (op, name, t) => (["H", "X", "h", "x"].includes(name) ? beamPulse(op, "raman", t, prof.oneQubitNs.value) : t);
  // On a device with global pulses, a gate sequence starts as late as its listed window allows:
  // gates the listing staggers by a few ns then fall in one batch and share one global pulse.
  const oneB = () => b(design.point.globalOneQubit ? prof.globalOneQubitNs.value : prof.oneQubitNs.value), twoB = () => b(prof.twoQubitNs.value);
  const spanOf = (op) => ({ H: oneB(), X: oneB(), CZ: twoB(), CNOT: 2 * oneB() + twoB(), CY: 2 * oneB() + twoB() })[op.kind];
  const lateStart = (op) => {
    const t = b(op.start), span = spanOf(op);
    if (!(design.point.globalEntangle || design.point.globalOneQubit) || span === undefined) return t;
    return Math.max(t, Math.floor((op.end * 1000) / period) - span);
  };
  // Layers: gates of one kind whose windows allow it start together, at the latest start among
  // them, so that one global pulse serves them all (the compiler staggers a pipelined layer by 1 ns).
  const layerStart = new Map();
  if (design.point.globalEntangle || design.point.globalOneQubit) {
    const byKind = new Map();
    for (const op of listing.ops) if (spanOf(op) !== undefined) (byKind.get(op.kind) ?? byKind.set(op.kind, []).get(op.kind)).push(op);
    for (const ops of byKind.values()) {
      ops.sort((x, y) => lateStart(x) - lateStart(y));
      let group = [], start = -Infinity, end = Infinity;
      const close = () => group.forEach((o) => layerStart.set(o.uid, start));
      for (const op of ops) {
        const ls = lateStart(op), last = Math.floor((op.end * 1000) / period), span = spanOf(op);
        const nextStart = Math.max(start, ls), nextEnd = Math.min(end, last);
        if (group.length && nextStart + span <= nextEnd) (start = nextStart), (end = nextEnd), group.push(op);
        else {
          if (group.length) close();
          (group = [op]), (start = ls), (end = last);
        }
      }
      if (group.length) close();
    }
  }
  for (const op of listing.ops) {
    const t0 = layerStart.get(op.uid) ?? lateStart(op);
    switch (op.kind) {
      case "H": case "X": case "S": case "Sdg": case "Z": oneQubit(op, op.kind, t0); break;
      case "CZ": beamPulse(op, "entangle", ringTransport(op, t0), prof.twoQubitNs.value); break;
      case "CNOT": case "CY": {
        let t = oneQubit(op, "H", t0);
        t = beamPulse(op, "entangle", ringTransport(op, t), prof.twoQubitNs.value);
        oneQubit(op, "H", t);
        break;
      }
      case "measure": {
        let t = op.arg === "X" ? oneQubit(op, "H", t0) : t0;
        // The twin first carries the atom to its readout zone (part of the readout system).
        if (prof.readoutMoveNs) t += b(prof.readoutMoveNs.value);
        const ch = readouts.take(t, b(prof.measureNs.value) + 8);
        const id = push(op, { op: "detect", pool: "readout", channel: ch, at: t, dur: b(prof.measureNs.value), bit: recordName(op.writes[0]) });
        measures.push({ id, channel: ch, bit: recordName(op.writes[0]), dur: b(prof.measureNs.value) });
        break;
      }
      case "request_ancilla": for (const q of op.qubits) { void q; beamPulse(op, "pump", t0, prof.resetNs.value); } break;
      case "release_ancilla": break;
      case "route": {
        if (design.point.perGateTransport) break; // the gate carries its own transport
        const later = gates.filter((g) => g.start >= op.end && g.start < op.end + 50 * Math.max(1, op.duration) + 1e9).slice(0, 64);
        const plan = planRoute(op, later, design, state, placement);
        // Atoms: one AOD job moves every atom of the route at once, for its longest move, and
        // routes that start in the same batch share that job (a transversal gate's pairs move
        // together). Ions: each ion shuttles on its own electrode lane.
        const jobs = design.prof.platform === "neutral"
          ? (plan.moves.length ? [{ ns: Math.max(...plan.moves.map((mv) => mv.ns)), atoms: plan.moves }] : [])
          : plan.moves.map((mv) => ({ ns: mv.ns, ions: [mv] }));
        if (design.prof.platform === "neutral" && jobs.length && aodJobs.has(t0)) {
          const shared = aodJobs.get(t0), want = b(jobs[0].ns);
          if (want > shared.native.dur) {
            movers.extend(shared.native.channel, t0, t0 + want);
            shared.native.dur = want;
          }
          const id = "h" + counter++;
          origin.set(id, op.uid);
          sharedMoves.push({ id, of: shared.native.id });
          shared.native.job.atoms.push(...jobs[0].atoms);
          break;
        }
        for (const job of jobs) {
          const dur = b(job.ns);
          const ch = movers.take(t0, dur);
          const nid = push(op, { op: "move", pool: "mover", channel: ch, at: t0, dur, job });
          if (design.prof.platform === "neutral") aodJobs.set(t0, { native: natives.find((x) => x.id === nid) });
        }
        break;
      }
      case "request_magic": {
        // The factory region's checks interact in place: rounds of the conflict-free order.
        const f = placement.factories.find((x) => x.uid === op.uid);
        const patch = layers(distance);
        let t = t0 + b(prof.resetNs.value);
        for (const _w of f.workspace.slice(0, patch.length)) beamPulse(op, "pump", t0, prof.resetNs.value);
        t = oneQubit(op, "H", t);
        const records = [], detector = [];
        for (let r = 0; r < distance; r++) {
          let layerEnd = t;
          for (let layer = 0; layer < 4; layer++) {
            let end = t;
            patch.forEach((ch) => {
              if (ch.order[layer] === undefined) return;
              let u = oneQubit(op, "H", t);
              u = beamPulse(op, "entangle", u, prof.twoQubitNs.value);
              end = Math.max(end, oneQubit(op, "H", u));
            });
            t = end;
            layerEnd = end;
          }
          patch.forEach((ch, i) => {
            const name = "factory" + op.uid + ".r" + r + ".c" + i;
            records.push({ name, round: r, check: i, type: ch.type, support: ch.data });
            const c = (detector[i] = readouts.take(layerEnd, b(prof.measureNs.value) + 8, detector[i]));
            const id = push(op, { op: "detect", pool: "readout", channel: c, at: layerEnd, dur: b(prof.measureNs.value), bit: name });
            measures.push({ id, channel: c, bit: name, dur: b(prof.measureNs.value) });
          });
          t = layerEnd + b(prof.measureNs.value) + 8;
          if (r < distance - 1) for (const _w of f.workspace.slice(0, patch.length)) beamPulse(op, "pump", t, prof.resetNs.value);
          t += b(prof.resetNs.value);
        }
        factories.push({ uid: op.uid, records });
        break;
      }
      case "decode_syndrome": decodes.push(op); break;
      case "pauli_frame_update": case "parity": {
        const id = "h" + counter++;
        origin.set(id, op.uid);
        const source = "listing line " + op.line + " · " + op.text;
        if (op.kind === "parity") classical.push({ uid: op.uid, id, at: t0, source, parity: { inputs: op.reads.map(recordName), output: recordName(op.writes[0]) } });
        else op.qubits.forEach((q) => classical.push({ uid: op.uid, id, at: t0, source, frame: { name: "frame:" + key(q), mask: 1 } }));
        break;
      }
      default: throw Error("listing line " + op.line + ": " + op.kind + " has no realization on " + design.id);
    }
  }
  const sizeOf = { beam: beams.size, mover: movers.size, readout: readouts.size, pump: pumps.size, global: 3 };
  const lentOps = new Set(natives.filter((n) => n.channel >= sizeOf[n.pool]).map((n) => origin.get(n.id)));
  // An instruction on a lent channel is not run: the design has no such channel.
  for (let i = natives.length - 1; i >= 0; i--) if (natives[i].channel >= sizeOf[natives[i].pool]) natives.splice(i, 1);
  for (let i = measures.length - 1; i >= 0; i--) if (!natives.some((n) => n.id === measures[i].id)) measures.splice(i, 1);
  const used = (p) => Math.max(1, ...natives.filter((n) => n.pool === p).map((n) => n.channel + 1));
  // Global pulses: kind k's j-th pulse goes to core j mod K of that kind, all on the kind's DAC.
  const GLOBAL_KINDS = ["rydberg", "raman", "pump"], PULSES_PER_CORE = 1500;
  const globalCount = [0, 0, 0];
  for (const n of natives) if (n.pool === "global") n.globalIndex = globalCount[n.channel]++;
  const globalCoresOf = globalCount.map((c) => (c ? Math.ceil(c / PULSES_PER_CORE) : 0));
  // Each global beam is one RF-DAC (a logical converter, placed on a board with every core that drives it).
  const globalDac = GLOBAL_KINDS.map((kind) => "global-" + kind);
  const globalCores = GLOBAL_KINDS.flatMap((kind, k) => Array.from({ length: globalCoresOf[k] }, (_, i) =>
    ({ name: "global-" + kind + i, channels: [{ name: kind, kind: "pulse", dac: globalDac[k], slots: 64, env_depth: 1024, interp: 4 }] })));
  // The controller: beam, mover and readout cores of at most 16 channels, a frame core.
  const group = (prefix, count, make) => {
    const cores = [];
    for (let i = 0; i < count; i += PER_CORE) cores.push({ name: prefix + i / PER_CORE, channels: Array.from({ length: Math.min(PER_CORE, count - i) }, (_, k) => make(i + k)) });
    return cores;
  };
  // Every other channel names its own logical DAC; placeOnBoards gives it one of its board's 16.
  const pulse = (name) => ({ name, kind: "pulse", dac: name, slots: 64, env_depth: 1024, interp: 4 });
  const cores = [
    ...group("beams", used("beam"), (k) => pulse("b" + k)),
    // Each global beam (Rydberg, Raman, pumping) is one DAC driven by several cores in turn, so
    // that no core's program outgrows its memory; channels on one DAC are summed.
    ...globalCores,
    ...group("pumps", used("pump"), (k) => pulse("p" + k)),
    ...group("movers", used("mover"), (k) => pulse("m" + k)),
    // A readout core per readout channel: its pulse and its counter line; a count holds the core.
    ...Array.from({ length: used("readout") }, (_, k) => ({ name: "readout" + k, channels: [{ ...pulse("detect"), dac: "detect" + k }, { name: "pmt", kind: "dio", slots: 1 }] })),
    { name: "frame", channels: [{ name: "status", kind: "dio", slots: 1 }] },
  ];
  // The cores on as many ZCU216 boards as they need (riscq/board.mjs); boards are joined by RISC-Q's PutLane.
  const onBoards = placeOnBoards(cores);
  const spec = socSpec({ name: design.id, dsp_freq_hz: prof.dspHz, link_pipe: 4, core_defaults: { mem_depth: 16384, with_mul: true, queue_depth: 32 }, cores: onBoards.cores }); // queue depth of RISC-Q's x6y3 build
  const coreOf = (name) => spec.cores.findIndex((c) => c.name === name);
  const where = (n) => n.pool === "global" ? { core: coreOf("global-" + GLOBAL_KINDS[n.channel] + (n.globalIndex % globalCoresOf[n.channel])), channel: GLOBAL_KINDS[n.channel] }
    : n.pool === "readout" ? { core: coreOf("readout" + n.channel), channel: "detect" }
    : { core: coreOf({ beam: "beams", mover: "movers", pump: "pumps" }[n.pool] + Math.floor(n.channel / PER_CORE)), channel: { beam: "b", mover: "m", pump: "p" }[n.pool] + n.channel };
  const tables = new Map(), actions = [], bindings = [];
  const slotOf = (core, channel, dur, kind) => {
    const k = core + "/" + channel;
    if (!tables.has(k)) tables.set(k, { core, channel, freq: 0, slots: [], keys: new Map() });
    const t = tables.get(k);
    if (!t.keys.has(kind + dur)) {
      const index = t.slots.length;
      if (index >= 64) throw Error("channel " + channel + " needs more than 64 pulse-table entries");
      t.keys.set(kind + dur, index);
      t.slots.push({ slot: index, phase: 0, amp: AMP_SCALE, env: 0, dur });
      const chIndex = spec.cores[core].channels.findIndex((c) => c.name === channel);
      bindings.push({ core, channel: chIndex, slot: index, id: spec.cores[core].name + "." + channel + "#" + index, part: kind, delayPs: 0, detail: { kind } });
    }
    return t.keys.get(kind + dur);
  };
  // A native longer than one pulse-table entry (a 16-bit duration: 65,535 dspClk cycles, 131 µs at
  // 500 MHz) is played as consecutive entries. `firstPulse` is the index of a native's first pulse on its channel.
  const firstPulse = new Map(), pulsesOn = new Map();
  for (const n of natives) {
    const w = where(n), key = w.core + "/" + w.channel;
    firstPulse.set(n.id, pulsesOn.get(key) ?? 0);
    for (let t = n.at, left = n.dur; left > 0; ) {
      const part = Math.min(left, 65535);
      actions.push({ segment: 0, core: w.core, at: t, fire: { channel: w.channel, slot: slotOf(w.core, w.channel, part, n.op) }, source: n.id });
      pulsesOn.set(key, (pulsesOn.get(key) ?? 0) + 1);
      t += part;
      left -= part;
    }
    if (n.op === "detect") actions.push({ segment: 0, core: w.core, at: n.at, bits: [n.bit], source: n.id, count: { channel: "pmt", lines: [0], until: n.at + n.dur, threshold: 2, atEnd: true } });
  }
  const frameCore = coreOf("frame");
  for (const c of classical) {
    const { uid: _u, id, ...rest } = c;
    actions.push({ segment: 0, core: frameCore, timed: true, ...rest, source: id });
  }
  const span = Math.max(1, ...natives.map((n) => n.at + n.dur));
  const lowered = { tables: [...tables.values()].map(({ keys: _k, ...t }) => t), segments: [{ span }], actions, bindings };
  // Photons: a bright readout pulses its counter line 3 times inside the exposure. The counter is
  // read when the exposure ends, and RISC-Q's event queue holds 8 events (EventLink.md), so a
  // bright readout is 3 photons (6 edges), above the threshold of 2; a dark one is none.
  const responses = measures.map((mm) => {
    const core = coreOf("readout" + mm.channel), occurrence = firstPulse.get(mm.id);
    const gap = Math.max(40, Math.floor(mm.dur / 8)), edges = [];
    if (outcomes[mm.bit]) for (let k = 0; k < 3; k++) edges.push({ after: gap * (2 * k + 1), levels: 1 }, { after: gap * (2 * k + 1) + 5, levels: 0 });
    const channels = spec.cores[core].channels;
    return { core, channel: channels.findIndex((c) => c.name === "detect"), occurrence, toCore: core, toChannel: channels.findIndex((c) => c.name === "pmt"), edges };
  });
  // The run's budget: its own span twice over, plus 20 ms for the decodes after it (the model's cap is 2·10⁹ cycles).
  const built = assemble(spec, lowered, { trace: "io", maxEvents: 400_000, maxSteps: 20_000_000, maxBatches: Math.min(2_000_000_000, 2 * span + 10_000_000), bindings, responses });
  const result = await execute(built.document);
  const m = { period, decoderCore: frameCore };
  const hardware = { segments: [{ ops: natives.map((n) => ({ id: n.id, t: n.at * period })), span }] };
  // A gate served by a shared global pulse is that pulse's: attribute the pulse to its operation too.
  for (const sh of [...shared, ...sharedMoves]) {
    const host = natives.find((n) => n.id === sh.of);
    if (!host) { lentOps.add(origin.get(sh.id)); continue; } // its pulse was not run
    const pulse = result.summary.pulses.find((x) => x.source === sh.of);
    if (pulse) result.summary.pulses.push({ ...pulse, source: sh.id });
    hardware.segments[0].ops.push({ id: sh.id, t: host.at * period });
    const action = actions.find((a) => a.source === sh.of && a.fire);
    if (action) lowered.actions.push({ ...action, source: sh.id });
  }
  const report = conformance(listing, { hardware, lowered, origin, unrealized: [], classical, quantization: { gridPs: period } }, result, built, m);
  // Readout bits are stored by the counting core: the measurement row's bit is its count's end.
  const bitStoredNs = report.bitNs;
  // The readout channel stays held 8 batches past the exposure (its count is read): when that
  // channel is free again, for a scheduler that shares the channels (riscq/os/program-runs.mjs).
  for (const mm of measures) {
    const n = natives.find((x) => x.id === mm.id), row = n && report.rows.find((r) => r.uid === origin.get(mm.id));
    if (row && row.kind === "measure") row.channelNs = ((n.at + mm.dur + 8) * period) / 1000;
  }
  for (const r of report.rows) {
    if (r.kind === "measure" && r.bitNs === undefined) r.ok = false;
    if (lentOps.has(r.uid)) {
      r.ok = false;
      r.lentChannel = true;
      if (lentEnd.has(r.uid)) r.hardwareNs = [r.start, (lentEnd.get(r.uid) * period) / 1000];
    }
  }
  const decodeRows = decodes.length ? await runDecodes({ ...listing, ops: listing.ops }, placement, distance, bitStoredNs,
    { decoders: design.decoders, coresPerDecoder: design.coresPerDecoder, outcomes }) : [];
  addRows(report, decodeRows.map((r) => ({ ...r, hardwareNs: [r.start, r.doneNs] })));
  for (const f of await runFactoryDecodes(factories, bitStoredNs, distance, { outcomes })) {
    const row = report.rows.find((r) => r.uid === f.uid);
    row.factory = f;
    row.hardwareNs = [row.hardwareNs?.[0] ?? row.start, Math.max(row.hardwareNs?.[1] ?? row.start, f.doneNs)];
    row.overrunNs = Math.max(0, row.hardwareNs[1] - row.end);
    row.ok = row.ok && row.overrunNs === 0;
  }
  addRows(report, []);
  // The animation track: atoms at their positions (µm) or ions at their zones, and every move played.
  const moveList = natives.filter((n) => n.op === "move" && n.job).flatMap((n) =>
    (n.job.atoms ?? n.job.ions ?? []).map((mv) => ({ t0: (n.at * period) / 1000, t1: ((n.at + Math.max(n.dur, b(n.job.ns))) * period) / 1000, s: mv.site, from: mv.from, to: mv.to })));
  const ring = prof.ringZones?.value;
  report.track = buildTrack({ listing, placement, report, moves: moveList, device: {
    kind: prof.platform === "neutral" ? "atoms" : ring ? "ions-ring" : "ions", unit: prof.platform === "neutral" ? "µm" : ring ? "zone" : "µm",
    sites: placement.sites.map((s, k) => ({ kind: s.kind, at: prof.platform === "neutral" || !ring ? design.home[k] : [design.zoneOfSite[k], 0] })),
    ...(ring ? { ring: { zones: ring, capacity: prof.zoneCapacity.value } } : {}),
    ...(design.point.globalEntangle ? { gateSiteUm: design.prof.siteUm?.value, interactUm: design.point.interactUm } : {}) } });
  const opOf = new Map(listing.ops.map((o) => [o.uid, o]));
  report.track.controller = controllerTrack({ spec, result, baseBatch: report.baseBatch, periodPs: period, name: design.point.title ?? design.id,
    sitesOfOp: (id) => opOf.get(origin.get(id))?.qubits.map((q) => placement.siteOf(q)) });
  report.pools = { beams: beams.peak, movers: movers.peak, readouts: readouts.peak, pumps: pumps.peak, lent: beams.lent + movers.lent + readouts.lent + pumps.lent };
  report.bits = measuredBits(result, built);
  report.globalEarlyNs = Math.max(0, ...shared.map((sh) => sh.earlyNs ?? 0));
  report.boards = { count: onBoards.boards, summedDacs: onBoards.summed, cores: spec.cores.map((c) => c.board ?? 0) };
  void gatedPairs; void checks;
  // The native instructions as a hardware program (riscq/examples.mjs's shape), for the debugger.
  const qubitsOf = (id) => opOf.get(origin.get(id))?.qubits.map((q) => placement.siteOf(q)) ?? [];
  const hardwareProgram = { kind: "hardware-program", version: 1, platform: prof.platform, machine: design.id, timeUnit: "ps",
    segments: [{ span: span * period, ops: natives.map((n) => ({ id: n.id, op: n.op, qubits: qubitsOf(n.id), t: n.at * period, dur: n.dur * period,
      channel: n.pool + " " + n.channel, source: n.source })) }] };
  return { report, result, built, spec, hardware: hardwareProgram };
}
