// The hardware document: one description of a quantum computer that the design page edits and every
// page that shows or runs a machine draws (Reproduce, Examples, the Workspace, the debugger).
//
// Document (kind "riscq-design", version 2). Lengths mm, times ns, frequencies Hz.
//   platform   "superconducting" | "neutral" | "qccd"
//   device     the qubit register in the shape machine/apparatus.mjs builds an installation around:
//              { kind: "transmon" | "atom" | "ion", label, centerMm, qubits: [{ id, site, positionMm }],
//                layout (transmon: chip + metal polygons; atom: SLM grids; ion: trap sites + edges),
//                mounting, drives: [{ probe, targets }], propagation, basis }
//   parts      the control electronics placed in the room: RISC-Q boards (AMD ZCU216, form "zcu216")
//              with the cores they carry: [{ id, label, form, model, centerMm, sizeMm, board }]
//   wires      cables between electronics parts (the device's own lines are built by the installation)
//   control    the RISC-Q controller: { dspMHz, boards: [{ id, index, cores: [{ name, role, channels, sites }] }] }
//   install    positions the designer moved, by installation part id: { [id]: { centerMm } }
//   source     where the document came from: { kind: "reproduction" | "example", id, row }
// The installation (cryostat, optical table, vacuum chamber, their lines) is derived from `device` by
// machine/apparatus.mjs, so a document stays small; `install` keeps what the designer changed.
//
// Version 1 documents (riscq/design.mjs) are the control and wiring of a superconducting machine;
// version 2 keeps them under `design` when a run compiled one (`chipDesign`).
//
// This module runs in Node and in the browser (served at /hw/doc-core.mjs): the device templates (the
// reference devices of machine/examples.mjs, whose installations /machines draws) are given to it by
// setTemplates, from riscq/hw/document.mjs in Node and from /api/hw/templates in a page.

const PLATFORM_OF = { transmon: "superconducting", atoms: "neutral", ions: "qccd", "ions-ring": "qccd" };
const DEVICE_KIND = { superconducting: "transmon", neutral: "atom", qccd: "ion" };
let TEMPLATE = null;
/** The reference device of each kind ({ transmon, atom, ion }) a document's installation follows. */
export function setTemplates(templates) {
  TEMPLATE = templates;
}

/** Transmon pitch on the generated chips (riscq/ftqvm/sc-chip.mjs pitchMm). */
export const TRANSMON_PITCH_MM = 2;
/** One race-track or grid zone of a trap (Pino et al., one shift is 110 µm). */
export const ZONE_MM = 0.11;
/** The envelope a ZCU216 board is drawn with: illustrative, not a CAD outline. */
export const ZCU216_MM = [180, 14, 130];

const round = (v) => Math.round(v * 1e6) / 1e6;
const bounds = (points) => points.reduce(([a, b, c, d], [x, y]) => [Math.min(a, x), Math.min(b, y), Math.max(c, x), Math.max(d, y)], [Infinity, Infinity, -Infinity, -Infinity]);

/** A transmon chip: one pocket per qubit on a ground plane, at the chip pitch. */
function transmonDevice(sites, couplers, label) {
  const pts = sites.map((s) => [s.at[0] * TRANSMON_PITCH_MM, s.at[1] * TRANSMON_PITCH_MM]);
  const [x0, y0, x1, y1] = bounds(pts);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const at = pts.map(([x, y]) => [round(x - cx), round(y - cy)]);
  const margin = TRANSMON_PITCH_MM;
  const box = [round(x0 - cx - margin), round(y0 - cy - margin), round(x1 - cx + margin), round(y1 - cy + margin)];
  const pocket = 0.65, pad = [0.455, 0.09];
  const rect = (x, y, w, h) => [[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]].map((p) => p.map(round));
  // One transmon's pocket, pads and junction, relative to its qubit: studio/device-scene.js buildRegister
  // repeats them at every qubit, as the reference chip's layout does.
  const metalPolygons = [{ name: "ground", role: "ground", layer: 1, points: [[box[0], box[1]], [box[0], box[3]], [box[2], box[3]], [box[2], box[1]]], holes: [rect(0, 0, pocket, pocket)] },
    { name: "pad_top", role: "electrode", layer: 1, points: rect(0, 0.06, ...pad), holes: [] },
    { name: "pad_bot", role: "electrode", layer: 1, points: rect(0, -0.06, ...pad), holes: [] }];
  const junctions = [{ name: "rect_jj", layer: 1, subtract: false, points: [[0, -0.015], [0, 0.015]], widthMm: 0.02 }];
  const t = TEMPLATE.transmon;
  return {
    kind: "transmon", label, centerMm: t.centerMm,
    qubits: at.map(([x, y], i) => ({ id: "q[" + i + "]", site: (sites[i].kind ?? "qubit") + " " + i, positionMm: [x, 0, y] })),
    couplers: couplers ?? [],
    // How the run's track places a site (lattice units) on this chip: positionMm = at × pitch − offset.
    trackFrame: { kind: "lattice", pitchMm: TRANSMON_PITCH_MM, offsetMm: [round(cx), round(cy)] },
    layout: { chip: { ...t.layout.chip, name: "main", boundsMm: box }, drivePinMm: [box[0], 0], metalPolygons, junctions },
    mounting: t.mounting, propagation: t.propagation, reference: t.reference,
    basis: "Transmons on a " + TRANSMON_PITCH_MM + " mm lattice, each in a schematic pocket (two pads and a junction) on a ground plane: the generated chip of the run. " +
      "Cryostat, wiring and package follow the reference installation (" + t.label + ").",
  };
}

/** A tweezer array: atoms at their run positions, on SLM grids of the run's pitch. */
function atomDevice(sites, device, label) {
  const pts = sites.map((s) => [s.at[0] / 1000, s.at[1] / 1000]);
  const [x0, y0, x1, y1] = bounds(pts);
  const pitch = (device.gateSiteUm ?? 10) / 1000;
  const cols = Math.max(1, Math.round((x1 - x0) / pitch) + 1), rows = Math.max(1, Math.round((y1 - y0) / pitch) + 1);
  const t = TEMPLATE.atom;
  return {
    kind: "atom", label, centerMm: t.centerMm,
    qubits: pts.map(([x, y], i) => ({ id: "q[" + i + "]", site: (sites[i].kind ?? "atom") + " " + i, positionMm: [round(x - x0), 0, round(y - y0)] })),
    // How the run's track places an atom (µm): positionMm = at / 1000 − origin.
    trackFrame: { kind: "um", originMm: [round(x0), round(y0)], heightMm: 0 },
    layout: { slms: [{ id: 0, zone: "storage", originMm: [0, 0], pitchMm: [round(pitch), round(pitch)], rows, cols }],
      interactMm: (device.interactUm ?? 2.5) / 1000 },
    mounting: t.mounting, propagation: t.propagation, reference: t.reference,
    basis: "Atoms at the run's positions (" + rows + " × " + cols + " sites, " + pitch * 1000 + " µm pitch). Trapping, Raman and Rydberg optics follow the reference installation (" + t.label + ").",
  };
}

/** A trap: a race track of zones (H2-like), or a grid of zones; ions at their zones. */
function ionDevice(sites, device, label) {
  const t = TEMPLATE.ion;
  let zones, edges, ionAt;
  if (device.ring) {
    const n = device.ring.zones, half = n / 2;
    zones = Array.from({ length: n }, (_, i) => {
      const top = i < half, k = top ? i : n - 1 - i;
      return { id: "Z" + i, x: round((k - (half - 1) / 2) * ZONE_MM * 1.5), z: top ? 0.2 : -0.2, zone: "gate" };
    });
    edges = zones.map((z, i) => [z.id, zones[(i + 1) % n].id]);
    ionAt = (s) => {
      const z = zones[s.at[0] % n];
      return [round(z.x + (s.at[1] - 0.5) * 0.005), 0.07, z.z];
    };
  } else {
    const pts = sites.map((s) => [s.at[0] / 1000, s.at[1] / 1000]);
    const [x0, y0] = bounds(pts);
    const key = (p) => p.map((v) => v.toFixed(4)).join(",");
    const unique = [...new Map(pts.map((p) => [key(p), p])).values()];
    zones = unique.map(([x, y], i) => ({ id: "Z" + i, x: round(x - x0), z: round(y - y0), zone: "gate" }));
    const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) <= ZONE_MM * 1.05;
    edges = [];
    zones.forEach((a, i) => zones.slice(i + 1).forEach((b) => near(a, b) && edges.push([a.id, b.id])));
    ionAt = (s) => {
      const z = zones[unique.findIndex((p) => key(p) === key([s.at[0] / 1000, s.at[1] / 1000]))];
      return [z.x, 0.07, z.z];
    };
  }
  const xs = zones.map((z) => z.x), zs = zones.map((z) => z.z);
  // How the run's track places an ion: a race-track zone index (one of layout.sites), or a position in µm.
  const trackFrame = device.ring ? { kind: "ring", zones: zones.map((z) => z.id), heightMm: 0.07 }
    : { kind: "um", originMm: bounds(sites.map((s) => [s.at[0] / 1000, s.at[1] / 1000])).slice(0, 2).map(round), heightMm: 0.07 };
  return {
    kind: "ion", label, centerMm: t.centerMm,
    qubits: sites.map((s, i) => ({ id: "q[" + i + "]", site: (s.kind ?? "ion") + " " + i, positionMm: ionAt(s) })),
    trackFrame,
    layout: { sites: zones, edges, spanMm: round(Math.max(...xs) - Math.min(...xs) + 2 * ZONE_MM), widthMm: round(Math.max(...zs) - Math.min(...zs) + 2 * ZONE_MM) },
    mounting: t.mounting, propagation: t.propagation, reference: t.reference,
    basis: (device.ring ? "A race track of " + device.ring.zones + " trap zones" : zones.length + " trap zones") + " with the run's ions. The chip faces down; vacuum chamber, " +
      "electrodes, lasers and detection follow the reference installation (" + t.label + ").",
  };
}

/** The RISC-Q control system of a run: ZCU216 boards in a rack row, each with the cores it carries. */
function controlParts(controller) {
  const byBoard = new Map();
  for (const core of controller?.cores ?? []) {
    const b = core.board ?? 0;
    if (!byBoard.has(b)) byBoard.set(b, []);
    byBoard.get(b).push({ name: core.name, role: core.role, channels: core.channels, sites: core.sites ?? [] });
  }
  if (!byBoard.size) byBoard.set(0, []);
  const perRow = 8, [w, h, d] = ZCU216_MM;
  const boards = [...byBoard.keys()].sort((a, b) => a - b).map((index, k) => ({
    id: "board" + index, index, cores: byBoard.get(index),
    centerMm: [round(-((Math.min(perRow, byBoard.size) - 1) / 2) * (w + 40) + (k % perRow) * (w + 40)), h / 2, round(420 + Math.floor(k / perRow) * (d + 60))],
  }));
  const parts = boards.map((b) => ({
    id: b.id, label: "RISC-Q board " + b.index + " (AMD ZCU216) · " + b.cores.length + " cores", form: "zcu216",
    model: { zcu216: { board: b.index, cores: b.cores.length } }, centerMm: b.centerMm, sizeMm: [...ZCU216_MM], board: b.index,
    basis: "An AMD ZCU216 evaluation board running RISC-Q: " + b.cores.length + " RV32I cores and their RF-DAC/ADC channels. The envelope is illustrative.",
  }));
  return { parts, boards: boards.map(({ centerMm: _c, ...b }) => b) };
}

/**
 * The hardware document of a run, from its 3D track (riscq/ftqvm/track.mjs: device + controller).
 * `design` is the run's version-1 control document when it compiled one (superconducting).
 */
export function documentFromTrack(track, { id, name, source, design } = {}) {
  if (!TEMPLATE) throw Error("hardware document: setTemplates() first (the reference devices)");
  const dev = track.device, platform = PLATFORM_OF[dev.kind];
  if (!platform) throw Error("no hardware document for a device of kind " + dev.kind);
  const label = name ?? track.controller?.board?.name ?? id;
  const device = platform === "superconducting" ? transmonDevice(dev.sites, dev.couplers, label)
    : platform === "neutral" ? atomDevice(dev.sites, dev, label) : ionDevice(dev.sites, dev, label);
  const { parts, boards } = controlParts(track.controller);
  // Each board's drive lines reach the qubits its cores serve; a board serving none (beams, movers,
  // decoders of an optical machine) drives the whole register through its optics.
  device.drives = boards.map((b) => {
    const served = [...new Set(b.cores.flatMap((c) => c.sites))].filter((s) => s < device.qubits.length);
    return { probe: "board" + b.index, targets: (served.length ? served : device.qubits.map((_, i) => i)).map((s) => device.qubits[s].id) };
  });
  return {
    kind: "riscq-design", version: 2, id, name: label, platform, device, parts, wires: [],
    control: { dspMHz: track.controller?.board?.dspMHz ?? 500, boards },
    install: {}, source: source ?? null, ...(design ? { design } : {}),
  };
}

/** The machine design the /machines installation builder reads (machine-scene.js installation). */
export function machineView(doc) {
  return { kind: "machine-design", version: 1, parts: doc.parts, wires: doc.wires, device: { ...doc.device, kind: DEVICE_KIND[doc.platform] } };
}
