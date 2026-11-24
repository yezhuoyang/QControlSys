// Edits of a RISC-Q hardware design document (kind "riscq-design", riscq/design.mjs). Every
// function is pure in the sense that it changes only the document it is given, so the editor
// page, the tests and a headless agent produce the same document from the same edits.
// The rules a design must obey live in riscq/design.mjs `check`; nothing here duplicates them.
// Lengths are mm, times ns, frequencies Hz, as in the document.

/** Signal speeds in mm/ns (machine/interconnect.mjs). The editor replaces them with the server's. */
export const SPEEDS = { coax: 200, planar: 125, fiber: 204, beam: 299.792458 };

export const clone = (doc) => JSON.parse(JSON.stringify(doc));
export const part = (doc, id) => doc.parts.find((p) => p.id === id);
export const channel = (doc, id) => doc.channels.find((c) => c.id === id);
export const wire = (doc, id) => doc.wires.find((w) => w.id === id);
export const wiresAt = (doc, id) => doc.wires.filter((w) => w.from === id || w.to === id);
export const channelsOf = (doc, core) => doc.channels.filter((c) => c.core === core);
export const channelsUsing = (doc, converter) => doc.channels.filter((c) => c.converter === converter);
export const qubitOf = (doc, partId) => doc.qubits.findIndex((q) => q.part === partId || q.resonator === partId);
export const board = (doc) => doc.parts.find((p) => p.type === "control-board");

/** A fresh id `prefix<n>` that no part, channel or wire uses. */
export function freshId(doc, prefix) {
  const used = new Set([...doc.parts, ...doc.channels, ...doc.wires].map((x) => x.id));
  for (let n = 0; ; n++) if (!used.has(prefix + n)) return prefix + n;
}

/** Length in mm of a route: the sum of its straight pieces. Same as machine/wiring.mjs pathLengthMm. */
export function routeLength(route) {
  let sum = 0;
  for (let k = 1; k < route.length; k++) sum += Math.hypot(...route[k].map((v, i) => v - route[k - 1][i]));
  return sum;
}

/** Delay in ps of a wire: routed length over the signal speed of its medium, rounded up to a ps. */
export function wireDelayPs(w, speeds = SPEEDS) {
  return Math.ceil((routeLength(w.routeMm) * 1000) / speeds[w.medium]);
}

/**
 * A route with right-angle bends from a to b: along x at a's height and depth, then along y,
 * then along z. This is how riscq/design.mjs ringDesign routes its coax.
 */
export function orthogonalRoute(a, b) {
  return [a.slice(), [b[0], a[1], a[2]], [b[0], b[1], a[2]], b.slice()];
}

/** Drops repeated points of a route, except its two ends. */
function tidy(route) {
  const out = [route[0]];
  for (let k = 1; k < route.length - 1; k++) if (Math.hypot(...route[k].map((v, i) => v - out.at(-1)[i])) > 1e-9) out.push(route[k]);
  out.push(route.at(-1));
  return out;
}

/** The smallest index 0–63 no converter of this type uses. */
export function freeIndex(doc, type) {
  const used = new Set(doc.parts.filter((p) => p.type === type).map((p) => p.index));
  for (let i = 0; i < 64; i++) if (!used.has(i)) return i;
  return 64;
}

/** Adds a part of a type at a position. A DAC or ADC gets the smallest free index. Returns the part. */
export function addPart(doc, type, centerMm, id) {
  const prefix = { "control-board": "board", core: "core", dac: "dac", adc: "adc", stage: "stage", qubit: "qubit", resonator: "resonator" }[type] ?? type;
  const p = { id: id ?? freshId(doc, prefix), type, centerMm: centerMm.map(round) };
  if (type === "dac" || type === "adc") p.index = freeIndex(doc, type);
  doc.parts.push(p);
  return p;
}

const round = (v) => Math.round(v * 1000) / 1000;

/**
 * Moves a part. The wires that end at it keep their shape: along each axis, the route points next
 * to the moved end that shared its coordinate move with it, so a right-angle route stays
 * right-angled and waypoints elsewhere stay where the designer put them.
 */
export function movePart(doc, id, centerMm) {
  const p = part(doc, id);
  const from = p.centerMm.slice(), to = centerMm.map(round);
  p.centerMm = to;
  for (const w of wiresAt(doc, id)) {
    const route = w.routeMm;
    const ends = [];
    if (w.from === id) ends.push(route);
    if (w.to === id) ends.push(null);
    for (const end of ends) {
      const points = end ? route : route.slice().reverse();
      for (let axis = 0; axis < 3; axis++)
        for (let k = 1; k < points.length - 1 && Math.abs(points[k][axis] - from[axis]) < 1e-6; k++) points[k][axis] = to[axis];
      points[0] = to.slice();
      if (!end) w.routeMm = points.reverse();
    }
  }
}

/** Joins two parts with a wire on a right-angle route. Returns the wire. */
export function connect(doc, from, to, medium = "coax", id) {
  const a = part(doc, from).centerMm, b = part(doc, to).centerMm;
  const w = { id: id ?? freshId(doc, medium === "coax" ? "coax" : medium), from, to, medium, routeMm: tidy(orthogonalRoute(a, b)) };
  doc.wires.push(w);
  return w;
}

/** Replaces a wire's route by a right-angle route or a straight line between its ends. */
export function reroute(doc, id, style = "orthogonal") {
  const w = wire(doc, id), a = part(doc, w.from)?.centerMm ?? w.routeMm[0], b = part(doc, w.to)?.centerMm ?? w.routeMm.at(-1);
  w.routeMm = style === "straight" ? [a.slice(), b.slice()] : tidy(orthogonalRoute(a, b));
}

/** Inserts a waypoint after point `k` of a wire's route. */
export function insertWaypoint(doc, id, k, point) {
  wire(doc, id).routeMm.splice(k + 1, 0, point.map(round));
}

export function removeWaypoint(doc, id, k) {
  const route = wire(doc, id).routeMm;
  if (k > 0 && k < route.length - 1) route.splice(k, 1);
}

/** Renames a part and every reference to it. Returns false when the new id is taken. */
export function renamePart(doc, from, to) {
  if (!to || from === to) return from === to;
  if ([...doc.parts, ...doc.channels, ...doc.wires].some((x) => x.id === to)) return false;
  part(doc, from).id = to;
  for (const c of doc.channels) {
    if (c.core === from) c.core = to;
    if (c.converter === from) c.converter = to;
  }
  for (const w of doc.wires) {
    if (w.from === from) w.from = to;
    if (w.to === from) w.to = to;
  }
  for (const q of doc.qubits) {
    if (q.part === from) q.part = to;
    if (q.resonator === from) q.resonator = to;
  }
  if (doc.decoder === from) doc.decoder = to;
  return true;
}

/** Renames a channel or a wire. Channel references of qubits and couplings follow. */
export function renameItem(doc, kind, from, to) {
  if (!to || from === to) return from === to;
  if ([...doc.parts, ...doc.channels, ...doc.wires].some((x) => x.id === to)) return false;
  if (kind === "wire") {
    wire(doc, from).id = to;
    return true;
  }
  channel(doc, from).id = to;
  for (const q of doc.qubits) for (const role of ["gate", "ro", "demod"]) if (q[role] === from) q[role] = to;
  for (const c of doc.couplings ?? []) for (const p of c.pulses) if (p.channel === from) p.channel = to;
  return true;
}

/**
 * Removes a part and the wires that end at it. Channels, qubits and couplings that name it stay,
 * so the rule check reports what the removal broke, except that removing a core removes its
 * channels, and removing a qubit or resonator part removes its qubit (see removeQubit).
 */
export function removePart(doc, id) {
  const q = qubitOf(doc, id);
  if (q >= 0) return removeQubit(doc, q, { keepCore: true });
  doc.parts = doc.parts.filter((p) => p.id !== id);
  doc.wires = doc.wires.filter((w) => w.from !== id && w.to !== id);
  if (doc.channels.some((c) => c.core === id)) doc.channels = doc.channels.filter((c) => c.core !== id);
  if (doc.decoder === id) delete doc.decoder;
}

export function removeWire(doc, id) {
  doc.wires = doc.wires.filter((w) => w.id !== id);
}

export function removeChannel(doc, id) {
  doc.channels = doc.channels.filter((c) => c.id !== id);
}

/** Adds a channel to a core. A pulse channel takes the first DAC, a demod channel the first ADC. */
export function addChannel(doc, core, kind) {
  const names = new Set(channelsOf(doc, core).map((c) => c.name));
  let n = 0;
  while (names.has(kind + n)) n++;
  const converter = { pulse: "dac", demod: "adc" }[kind];
  const c = { id: freshId(doc, core + "." + kind), core, name: kind + n, kind, slots: 1, interp: 4,
    ...(converter ? { converter: doc.parts.find((p) => p.type === converter)?.id } : {}) };
  doc.channels.push(c);
  return c;
}

/**
 * Adds a qubit with everything it needs to run: the qubit and its readout resonator on the chip,
 * a core with drive, readout and acquisition channels, two DACs and an ADC beside that core, and
 * the three coax lines between them. Its calibration is a copy of `template` (a `qubits` entry):
 * a starting value to edit, not a measured one. Returns the new qubit's index.
 */
export function addQubit(doc, template, at) {
  const index = doc.qubits.length;
  const chip = doc.qubits.map((q) => part(doc, q.part)?.centerMm).filter(Boolean);
  const cores = doc.parts.filter((p) => p.type === "core");
  const b = board(doc)?.centerMm ?? [0, 0, 0];
  const place = at ?? (chip.length ? [Math.max(...chip.map((p) => p[0])) + 3, chip.reduce((s, p) => s + p[1], 0) / chip.length, chip[0][2]] : [b[0] + 300, b[1], b[2] - 350]);
  const qubit = addPart(doc, "qubit", place);
  const resonator = addPart(doc, "resonator", [place[0], place[1] + 1.5, place[2]], freshId(doc, "resonator"));
  const corePlace = cores.length ? cores.reduce((top, c) => (c.centerMm[1] > top.centerMm[1] ? c : top)).centerMm.map((v, k) => v + (k === 1 ? 12 : 0)) : [b[0], b[1], b[2]];
  const core = addPart(doc, "core", corePlace, freshId(doc, "q"));
  const gateDac = addPart(doc, "dac", [corePlace[0] + 60, corePlace[1], corePlace[2]]);
  const roDac = addPart(doc, "dac", [corePlace[0] + 60, corePlace[1] + 4, corePlace[2]]);
  const adc = addPart(doc, "adc", [corePlace[0] + 60, corePlace[1] + 2, corePlace[2] - 20]);
  const interp = (role, fallback) => channel(doc, template?.[role])?.interp ?? fallback;
  const ch = (name, kind, converter, slots, i) => {
    const c = { id: core.id + "." + name, core: core.id, name, kind, converter, slots, interp: i };
    doc.channels.push(c);
    return c.id;
  };
  const gate = ch("gate", "pulse", gateDac.id, 2, interp("gate", 4));
  const ro = ch("ro", "pulse", roDac.id, 1, interp("ro", 16));
  const demod = ch("demod", "demod", adc.id, 1, interp("demod", 4));
  connect(doc, gateDac.id, qubit.id, "coax", freshId(doc, "drive"));
  connect(doc, roDac.id, resonator.id, "coax", freshId(doc, "tone"));
  const back = connect(doc, resonator.id, adc.id, "coax", freshId(doc, "return"));
  // The return line drops first, then runs back at the converter's height, as in ringDesign.
  back.routeMm = tidy(orthogonalRoute(adc.centerMm, resonator.centerMm).reverse());
  const copy = template ? clone(template) : undefined;
  doc.qubits.push({ ...copy, part: qubit.id, resonator: resonator.id, gate, ro, demod });
  return index;
}

/**
 * Couples qubits i and j: a CZ channel on the core of each qubit's drive, sharing its DAC, and a
 * coupling entry whose calibration is a copy of `template` (a `couplings` entry) moved to i and j.
 */
export function addCoupling(doc, i, j, template) {
  const pulses = [i, j].map((q, k) => {
    const drive = channel(doc, doc.qubits[q].gate);
    const names = new Set(channelsOf(doc, drive.core).map((c) => c.name));
    let n = 0;
    while (names.has("cz" + n)) n++;
    const c = { id: freshId(doc, drive.core + ".cz"), core: drive.core, name: "cz" + n, kind: "pulse", converter: drive.converter, slots: 1, interp: drive.interp ?? 4 };
    doc.channels.push(c);
    const t = template?.pulses?.[k] ?? {};
    return { qubit: q, amp: t.amp ?? 0.4, phaseRad: t.phaseRad ?? 0, envelope: t.envelope ?? "cosine_square", channel: c.id };
  });
  const coupling = { qubits: [i, j], freqHz: template?.freqHz ?? doc.qubits[i].freqHz, durNs: template?.durNs ?? 400, pulses,
    virtualZ: (template?.virtualZ ?? []).map((z, k) => ({ qubit: k === 0 ? i : j, phaseRad: z.phaseRad })) };
  (doc.couplings ??= []).push(coupling);
  return coupling;
}

/** Removes coupling `k` and the CZ channels only it used. */
export function removeCoupling(doc, k) {
  const [gone] = doc.couplings.splice(k, 1);
  const still = new Set(doc.couplings.flatMap((c) => c.pulses.map((p) => p.channel)));
  doc.channels = doc.channels.filter((c) => still.has(c.id) || !gone.pulses.some((p) => p.channel === c.id));
}

/**
 * Removes qubit `i`: its qubit and resonator parts, its channels, its couplings, the wires of
 * those parts, and every converter and core left with nothing to do. Later qubits move down one
 * index, as programs address qubits by index.
 */
export function removeQubit(doc, i, { keepCore = false } = {}) {
  const q = doc.qubits[i];
  for (let k = (doc.couplings ?? []).length - 1; k >= 0; k--) if (doc.couplings[k].qubits.includes(i)) removeCoupling(doc, k);
  for (const c of doc.couplings ?? []) {
    c.qubits = c.qubits.map((x) => (x > i ? x - 1 : x));
    for (const p of c.pulses) if (p.qubit > i) p.qubit--;
    for (const z of c.virtualZ ?? []) if (z.qubit > i) z.qubit--;
  }
  doc.qubits.splice(i, 1);
  const cores = new Set([q.gate, q.ro, q.demod].map((id) => channel(doc, id)?.core).filter(Boolean));
  doc.channels = doc.channels.filter((c) => ![q.gate, q.ro, q.demod].includes(c.id));
  const gone = new Set([q.part, q.resonator]);
  for (const core of cores) if (!keepCore && !channelsOf(doc, core).length && doc.decoder !== core) gone.add(core);
  doc.parts = doc.parts.filter((p) => !gone.has(p.id));
  doc.wires = doc.wires.filter((w) => !gone.has(w.from) && !gone.has(w.to));
  // A converter no channel names and no wire leaves has nothing to do.
  const idle = doc.parts.filter((p) => (p.type === "dac" || p.type === "adc") && !channelsUsing(doc, p.id).length && !wiresAt(doc, p.id).length).map((p) => p.id);
  doc.parts = doc.parts.filter((p) => !idle.includes(p.id));
}

/** Keeps qubits 0 … n-1 of a design and what they need. */
export function firstQubits(doc, n) {
  const out = clone(doc);
  while (out.qubits.length > n) removeQubit(out, out.qubits.length - 1);
  return out;
}

/** Counts and routed lengths by medium, for the editor's header. */
export function summary(doc, speeds = SPEEDS) {
  const count = (type) => doc.parts.filter((p) => p.type === type).length;
  const byMedium = {};
  let longest = null;
  for (const w of doc.wires) {
    const length = routeLength(w.routeMm);
    byMedium[w.medium] = (byMedium[w.medium] ?? 0) + length;
    const delayPs = Math.ceil((length * 1000) / (speeds[w.medium] ?? NaN));
    if (!longest || delayPs > longest.delayPs) longest = { id: w.id, lengthMm: length, delayPs };
  }
  return { qubits: doc.qubits.length, cores: count("core"), converters: count("dac") + count("adc"), channels: doc.channels.length, wires: doc.wires.length, byMedium, longest };
}

/** The ids of parts, channels and wires a rule message names, in the order they appear. */
export function idsIn(doc, message) {
  const known = new Map([...doc.parts.map((p) => [p.id, "part"]), ...doc.channels.map((c) => [c.id, "channel"]), ...doc.wires.map((w) => [w.id, "wire"])]);
  const out = [];
  for (const token of message.match(/[A-Za-z_][\w.\-]*/g) ?? []) {
    const id = token.replace(/[.,:]+$/, "");
    if (known.has(id) && !out.some((x) => x.id === id)) out.push({ id, kind: known.get(id) });
  }
  const qubit = /^Qubit (\d+)/.exec(message);
  if (qubit && doc.qubits[Number(qubit[1])]) out.unshift({ id: doc.qubits[Number(qubit[1])].part, kind: "part" });
  return out;
}
