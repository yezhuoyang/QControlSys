// Physical layout of the apparatus of a run, for the 3D apparatus view of the debugger.
//
// `geometry(platform, m, hardware)` returns a plain JSON object that the page draws and
// animates from the trace, or undefined when a platform has none. It is display geometry:
// positions and sizes for drawing, with their units and their source stated in the object.
// Nothing in the Lean model reads it.
//
//   m          the platform machine (riscq/platforms/*.mjs `machine`)
//   hardware   the hardware program of the run (its instructions name sites, ions, atoms)
//
// Every geometry has
//   kind       "ion-trap" | "atom-array" | "transmon-ring"
//   units      what one position unit is
//   basis      where the positions come from, in a sentence shown on screen
//   schematic  what is drawn for display only
//   parts      apparatus part of the controller scene → elements of the apparatus scene.
//              An apparatus part is the `part` of a binding, for example "site:DG01".
// An element of the apparatus scene is named `<kind>:<id>`: site, segment, ion, light, zone,
// atom, tone, beam, qubit, resonator, coupler. studio/riscq-model.js places and animates them.
import { HZ_PER_UM } from "./platforms/neutral.mjs";

/**
 * Trapped ions: the sites and segments of QCCD Studio's architecture at Studio's own
 * coordinates (bridge/qccd_studio.py `machine_data`), and the ion placement of Studio's
 * zero-duration `init` cycles that precede the first hardware instruction.
 * Boundary: a placement that a later `init` changes is not followed. Ions then move only by
 * the transport cycles of `derived.ionMoves`.
 */
function ionTrap(m) {
  const { machine, system } = m.replay;
  // The bridge attaches its installation manifest only to the published H2 reconstruction,
  // whose coordinates are in 750 µm gate pitches (bridge `reference_h2`).
  const calibrated = Boolean(system);
  const placement = {};
  for (const cycle of m.frames) {
    if (!["init", "barrier", "decode"].includes(cycle.op)) break;
    Object.assign(placement, cycle.positions);
  }
  const parts = { "light:cooling": ["light:cooling"] };
  for (const node of machine.nodes) parts["site:" + node.id] = ["site:" + node.id];
  // An electrode control channel has no single place in Studio's architecture. Its pulses
  // light the sites and segments of the transport instruction that fired them.
  for (const channel of m.controlChannels) parts["electrodes:" + channel] = [];
  return {
    kind: "ion-trap", version: 1, name: machine.name,
    units: calibrated
      ? { position: "gate pitch of 750 µm", micrometresPerUnit: 750 }
      : { position: "layout unit of the Studio architecture", micrometresPerUnit: null },
    basis: "Site and segment positions are QCCD Studio's architecture coordinates. " + machine.geometryNote,
    schematic: "Ion size, electrode shapes, beam shapes and the straight path of an ion inside a segment are drawn for display. Studio states where a transport cycle starts and ends, not the path in between.",
    sites: machine.nodes.map((node) => ({ id: node.id, position: node.pos, zone: node.zone, gate: node.gate, capacity: node.capacity })),
    segments: machine.segments.map((segment) => ({ id: segment.id, a: segment.a, b: segment.b })),
    ions: Object.entries(placement).map(([id, site]) => ({ id, site })),
    parts,
  };
}

/**
 * Neutral atoms: the trap grids, zones and Rydberg range of the ZAC architecture file in µm,
 * the atoms at the traps of the program's `init` instruction, and which tone channel drives
 * which column and row of each AOD (riscq/platforms/neutral.mjs names them x<column>, y<row>).
 * An SLM trap (row, column) is at location + (column · pitch x, row · pitch y).
 */
function atomArray(m) {
  const architecture = m.architecture ?? {};
  const traps = [], zones = [];
  const add = (kind, list) => (list ?? []).forEach((zone) => {
    const id = kind + zone.zone_id;
    // The ZAC file spells the size key in two ways.
    zones.push({ id, kind, origin: zone.offset, size: zone.dimension ?? zone.dimenstion });
    for (const slm of zone.slms ?? [])
      traps.push({ id: slm.id, zone: id, origin: slm.location, pitch: slm.site_seperation, rows: slm.r, columns: slm.c });
  });
  add("storage", architecture.storage_zones);
  add("entanglement", architecture.entanglement_zones);
  const grid = new Map(traps.map((trap) => [trap.id, trap]));
  const init = m.code.instructions.find((instruction) => instruction.type === "init");
  const atoms = (init?.init_locs ?? []).flatMap(([id, slm, row, column]) => {
    const trap = grid.get(slm);
    return trap ? [{ id, trap: slm, row, column, position: [trap.origin[0] + column * trap.pitch[0], trap.origin[1] + row * trap.pitch[1]] }] : [];
  });
  const aods = [], parts = { "beam:raman": ["beam:raman"], "beam:rydberg": ["beam:rydberg"] };
  for (const core of m.spec.cores) {
    const match = /^aod(\d+)$/.exec(core.name);
    if (!match) continue;
    const channels = (axis) => core.channels.filter((channel) => channel.name.startsWith(axis))
      .sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1))).map((channel) => core.name + "." + channel.name);
    const aod = { id: Number(match[1]), core: core.name, columns: channels("x"), rows: channels("y") };
    aods.push(aod);
    // The apparatus part of a tone is `aod<id>:<channel>` (neutral.mjs `lower`).
    for (const channel of [...aod.columns, ...aod.rows]) parts[core.name + ":" + channel.slice(core.name.length + 1)] = ["tone:" + channel];
  }
  return {
    kind: "atom-array", version: 1, name: architecture.name ?? m.name,
    units: { position: "µm", micrometresPerUnit: 1 },
    // The tone scale is the run's own calibration (riscq/platforms/neutral.mjs HZ_PER_UM).
    calibration: { hertzPerMicrometre: HZ_PER_UM },
    basis: "Trap grids, zone outlines and the Rydberg range are the ZAC architecture file's values in µm. Atoms start at the traps of the program's init instruction. Tone positions come from the carrier updates of the trace through the AOD calibration of the run, " + Number((HZ_PER_UM / 1000).toFixed(3)) + " kHz per µm.",
    schematic: "Atom, trap and beam sizes are drawn for display. A one-qubit instruction is one global pulse, shown on the atoms it names. Each tweezer is drawn where its row and column tones cross.",
    extent: architecture.arch_range,
    zones,
    traps,
    rydberg: (architecture.rydberg_range ?? []).map(([min, max], id) => ({ id, min, max })),
    atoms,
    aods,
    parts,
  };
}

/**
 * Superconducting: eight transmons, their readout resonators and the coupled pairs of the
 * calibration. The calibration has no chip coordinates, so every position is schematic:
 * qubits evenly on a circle of radius 1 in index order, each resonator outside its qubit, each
 * coupler between its pair.
 */
function transmonRing(m) {
  const qubits = m.calibration.qubits, n = qubits.length;
  const at = (index, radius) => {
    const angle = (2 * Math.PI * index) / n;
    return [Number((radius * Math.sin(angle)).toFixed(6)), Number((-radius * Math.cos(angle)).toFixed(6))];
  };
  const parts = {};
  for (const q of qubits) {
    parts["qubit" + q.qubit] = ["qubit:" + q.qubit];
    parts["resonator" + q.qubit] = ["resonator:" + q.qubit];
  }
  return {
    kind: "transmon-ring", version: 1, name: m.name,
    units: { position: "schematic unit, the ring radius", micrometresPerUnit: null },
    basis: "Schematic. The calibration (" + (m.calibration.source ?? "RISC-Q example calibration") + ") lists the qubits and their coupled pairs but no chip coordinates. Qubits are placed evenly on a circle in index order.",
    schematic: "Every position and shape. Only which qubit, resonator and pair exist comes from the calibration.",
    qubits: qubits.map((q, k) => ({ id: q.qubit, position: at(k, 1), frequencyHz: q.freq })),
    resonators: qubits.map((q, k) => ({ id: q.qubit, qubit: q.qubit, position: at(k, 1.5), frequencyHz: q.readout?.freq })),
    couplers: m.calibration.pairs.map((pair) => {
      const [a, b] = pair.pair.map((id) => qubits.findIndex((q) => q.qubit === id));
      const pa = at(a, 1), pb = at(b, 1);
      // A pair whose CZ needs a pulse on the second excited level is not offered (superconducting.mjs).
      return { id: pair.pair.join("-"), pair: pair.pair, position: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2], offered: !pair.sandwich?.length, frequencyHz: pair.freq };
    }),
    decoder: m.decoderCore >= 0,
    parts,
  };
}

export function geometry(platform, m, hardware) {
  void hardware;
  if (platform === "qccd" && m?.replay?.machine) return ionTrap(m);
  if (platform === "neutral" && m?.code) return atomArray(m);
  if (platform === "superconducting" && m?.calibration) return transmonRing(m);
  return undefined;
}
