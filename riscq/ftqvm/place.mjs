// Placement: every qubit a FormalRV listing names is given a physical site.
//
// A listing names physical qubits by address. `data[b*n + j]` is qubit j of code block b, live for
// the whole run. `ancilla[k]` is an SSA identity, live from its `request_ancilla` to its
// `release_ancilla`. Its physical capacity is reused, so two identities whose lifetimes do not
// overlap may share one site. Placement fixes, for this machine, where each address lives. It
// is part of the compilation certificate (certify.mjs).
//
// Geometry is in lattice units (riscq/ftqvm/surface.mjs): qubit j of a distance-d block sits at
// row ⌊j/d⌋, column j mod d of the block's slot; slots stand side by side, `gap` columns apart.
//   - Data blocks take slots 0, 1, ….
//   - An ancilla block, a `request_ancilla` of d² identities at once (a logical ancilla, the
//     output of a magic-state factory), takes the first slot after the data blocks that is free
//     over its lifetime; its identity j sits where data qubit j of that slot would.
//   - A factory's workspace (`request_magic … with ancilla[…]`) takes the measure sites of its
//     output block's patch, check by check (surface.checks), where the factory runs its rounds.
//   - Any other ancilla takes the free half-integer point nearest the centroid of the qubits it
//     gates with. Points tie on a code boundary, and the tie goes to the point farther from its
//     block's centre, outside the patch. An ancilla that gates with nothing waits in a row below.
import { checks } from "./surface.mjs";

const TWO_QUBIT = new Set(["CNOT", "CZ", "CY"]);
const key = (q) => q.register + "[" + q.index + "]";

/** Lifetimes and two-qubit partners of every address, from the expanded listing. */
export function analyze(listing) {
  const live = new Map(), partners = new Map(), dataWidth = { n: 0 };
  const partnersOf = (k) => (partners.has(k) ? partners.get(k) : partners.set(k, new Map()).get(k));
  for (const op of listing.ops) {
    for (const q of [...op.qubits, ...op.work]) if (q.register === "data") dataWidth.n = Math.max(dataWidth.n, q.index + 1);
    if (op.kind === "request_ancilla" || op.kind === "request_magic")
      for (const q of op.kind === "request_ancilla" ? op.qubits : op.work)
        if (!live.has(key(q))) live.set(key(q), { address: q, from: op.start, to: Infinity, requestedBy: op.uid });
    if (op.kind === "release_ancilla")
      for (const q of op.qubits) {
        const l = live.get(key(q));
        if (!l) throw Error("listing line " + op.line + " releases " + key(q) + ", which was never requested.");
        l.to = op.start;
      }
    if (TWO_QUBIT.has(op.kind)) {
      const [a, b] = op.qubits.map(key);
      partnersOf(a).set(b, (partnersOf(a).get(b) ?? 0) + 1);
      partnersOf(b).set(a, (partnersOf(b).get(a) ?? 0) + 1);
    }
  }
  return { live, partners, dataWidth: dataWidth.n };
}

/** FormalRV's surface order: a weight-4 check is a unit square of the row-major d×d grid. */
export function checkSurfaceOrder(stabilizers, d) {
  const at = (j) => [Math.floor(j / d), j % d];
  for (const support of stabilizers) {
    if (support.length !== 4 && support.length !== 2) return false;
    const rows = support.map((j) => at(j)[0]), cols = support.map((j) => at(j)[1]);
    if (Math.max(...rows) - Math.min(...rows) > 1 || Math.max(...cols) - Math.min(...cols) > 1) return false;
  }
  return true;
}

/**
 * Place a listing. options: { d, gap } (distance of the surface blocks, empty columns between
 * slots). Returns {
 *   sites: [{ id, kind: "data" | "ancilla", rc: [row, col] }],
 *   siteOf(address) → site index,
 *   blockOf(address) → { block, slot, j } for a qubit of a data or ancilla block, else undefined,
 *   blocks: [{ id, kind: "data" | "ancilla", slot, members: [address key], from, to }],
 *   factories: [{ uid, block, workspace: [address key] }],
 *   assignment, live, d, gap, n,
 * }
 */
export function place(listing, { d = 3, gap = 2, n: blockSize } = {}) {
  const { live, partners, dataWidth } = analyze(listing);
  // n: qubits of one code block (d² for the rotated surface code, 7 for the Steane code).
  const n = blockSize ?? d * d, dataBlocks = Math.max(1, Math.ceil(dataWidth / n));
  const pitch = d + gap;
  const sites = [], siteAt = new Map(), assignment = new Map(), blockMember = new Map();
  const siteFor = (rc, kind) => {
    const k = rc.join(",");
    if (!siteAt.has(k)) {
      siteAt.set(k, sites.length);
      sites.push({ id: (kind === "data" ? "d" : "a") + sites.length, kind, rc });
    }
    return siteAt.get(k);
  };
  const blockRc = (slot, j) => [Math.floor(j / d), (j % d) + slot * pitch];
  const blocks = [];
  // Data blocks.
  for (let b = 0; b < dataBlocks; b++) {
    const members = [];
    for (let j = 0; j < n; j++) {
      const k = "data[" + (b * n + j) + "]";
      members.push(k);
      blockMember.set(k, { block: "data" + b, slot: b, j });
      const s = siteFor(blockRc(b, j), "data");
      sites[s].address = k;
      sites[s].block = b;
    }
    blocks.push({ id: "data" + b, kind: "data", slot: b, members, from: 0, to: Infinity });
  }
  // Ancilla blocks: whole-block requests, in request order, in the first free slot.
  const slotBusy = new Map();
  const slotFree = (slot, from, to) => (slotBusy.get(slot) ?? []).every(([a, b]) => to <= a || b <= from);
  // A request of a whole number of blocks is that many ancilla blocks, in order.
  const blockRequests = listing.ops.filter((o) => o.kind === "request_ancilla" && o.qubits.length >= n && o.qubits.length % n === 0)
    .flatMap((o) => Array.from({ length: o.qubits.length / n }, (_, k) => ({ ...o, uid: o.uid + (k ? "." + k : ""), qubits: o.qubits.slice(k * n, (k + 1) * n) })));
  for (const op of blockRequests) {
    const members = op.qubits.map(key);
    const from = op.start, to = Math.max(...members.map((m) => live.get(m)?.to ?? Infinity));
    let slot = dataBlocks;
    while (!slotFree(slot, from, to)) slot++;
    (slotBusy.get(slot) ?? slotBusy.set(slot, []).get(slot)).push([from, to]);
    const id = "anc" + op.uid;
    members.forEach((m, j) => {
      blockMember.set(m, { block: id, slot, j });
      assignment.set(m, siteFor(blockRc(slot, j), "ancilla"));
    });
    blocks.push({ id, kind: "ancilla", slot, members, from, to, requestedBy: op.uid });
  }
  const positionOf = (k) => (blockMember.has(k) ? blockRc(blockMember.get(k).slot, blockMember.get(k).j) : undefined);
  // Every other identity is placed one by one; a site is busy over the lifetimes placed on it.
  const busy = new Map();
  const free = (rc, from, to) => (busy.get(rc.join(",")) ?? []).every(([a, b]) => to <= a || b <= from);
  const occupy = (rc, from, to) => (busy.get(rc.join(",")) ?? busy.set(rc.join(","), []).get(rc.join(","))).push([from, to]);
  for (const b of blocks.filter((x) => x.kind === "ancilla")) b.members.forEach((m, j) => occupy(blockRc(b.slot, j), b.from, b.to));
  // Factory workspace: the measure sites of the output block's patch.
  const factories = [];
  const workspaceAt = new Map();
  for (const op of listing.ops.filter((o) => o.kind === "request_magic")) {
    const out = blockMember.get(key(op.qubits[0]));
    if (!out) throw Error("listing line " + op.line + ": the magic state's output is not a whole block of " + n + " qubits");
    const patch = checks(d);
    op.work.forEach((q, i) => workspaceAt.set(key(q), patch[i] ? [patch[i].rc[0], patch[i].rc[1] + out.slot * pitch] : undefined));
    factories.push({ uid: op.uid, block: out.block, slot: out.slot, output: op.qubits.map(key), workspace: op.work.map(key) });
  }
  // Preferred positions: the centroid of the qubits an identity gates with.
  const prefer = new Map();
  const centroid = (points) => points.reduce((s, p) => [s[0] + p[0] / points.length, s[1] + p[1] / points.length], [0, 0]);
  const known = (k) => positionOf(k) ?? prefer.get(k);
  for (let pass = 0; pass < 4; pass++)
    for (const k of live.keys()) {
      if (blockMember.has(k) || workspaceAt.has(k)) continue;
      const points = [...(partners.get(k)?.keys() ?? [])].map(known).filter(Boolean);
      if (points.length) prefer.set(k, centroid(points));
    }
  let spare = 0;
  const totalSlots = Math.max(dataBlocks, ...blocks.map((b) => b.slot + 1));
  for (const k of live.keys()) if (!blockMember.has(k) && !workspaceAt.has(k) && !prefer.has(k)) prefer.set(k, [d + 1.5, spare++ - 0.5]);
  const width = totalSlots * pitch - gap;
  const candidates = [];
  for (let r = -1.5; r <= d + 0.5 + Math.ceil(spare / Math.max(1, width)); r += 1)
    for (let c = -1.5; c <= width + 0.5 + spare; c += 1) candidates.push([r, c]);
  // Workspace first (fixed sites), then identities that gate with block qubits, then the rest.
  const touchesBlock = (k) => [...(partners.get(k)?.keys() ?? [])].some((p) => blockMember.has(p));
  const order = [...live.entries()].filter(([k]) => !blockMember.has(k)).sort(([kx, x], [ky, y]) =>
    (workspaceAt.has(ky) - workspaceAt.has(kx)) || (touchesBlock(ky) - touchesBlock(kx)) || x.from - y.from || x.address.index - y.address.index);
  // A patch's measure sites belong to checks of its own block: an ancilla whose block partners
  // lie in one slot may use that slot's sites; any other takes points outside every patch.
  const patchSlot = new Map();
  for (let slot = 0; slot < totalSlots; slot++) for (const ch of checks(d)) patchSlot.set([ch.rc[0], ch.rc[1] + slot * pitch].join(","), slot);
  // The slot of an ancilla all of whose partners are qubits of one block (a round's check).
  const localSlot = (k) => {
    const slots = [...(partners.get(k)?.keys() ?? [])].map((p) => blockMember.get(p)?.slot);
    return slots.length && slots.every((x) => x !== undefined && x === slots[0]) ? slots[0] : undefined;
  };
  const allowed = (c, k) => {
    const slot = patchSlot.get(c.join(","));
    return slot === undefined || localSlot(k) === slot;
  };
  for (const [k, l] of order) {
    let rc;
    const want = workspaceAt.get(k);
    if (want && free(want, l.from, l.to)) rc = want;
    else {
      const p = want ?? prefer.get(k);
      const slotOf = Math.max(0, Math.min(totalSlots - 1, Math.round(p[1] / pitch)));
      const centre = [(d - 1) / 2, (d - 1) / 2 + slotOf * pitch];
      let bestScore = Infinity;
      for (const c of candidates) {
        if (!free(c, l.from, l.to) || !allowed(c, k)) continue;
        const score = Math.round(Math.hypot(c[0] - p[0], c[1] - p[1]) * 1e6) - Math.hypot(c[0] - centre[0], c[1] - centre[1]) * 1e-3;
        if (score < bestScore) (bestScore = score), (rc = c);
      }
      if (!rc) throw Error("no free site for " + k);
    }
    occupy(rc, l.from, l.to);
    assignment.set(k, siteFor(rc, "ancilla"));
  }
  const siteOf = (address) => {
    const k = typeof address === "string" ? address : key(address);
    const s = k.startsWith("data[") ? siteAt.get(blockRc(blockMember.get(k)?.slot ?? -1, blockMember.get(k)?.j ?? -1).join(",")) : assignment.get(k);
    if (s === undefined) throw Error("the listing names " + k + ", which has no site");
    return s;
  };
  const blockOf = (address) => blockMember.get(typeof address === "string" ? address : key(address));
  return { sites, siteOf, blockOf, blocks, factories, assignment, live, d, gap, n, blockCount: dataBlocks };
}

/** Every pair of sites the listing gates, with how often and its length in lattice units. */
export function gatedPairs(listing, placement) {
  const pairs = new Map();
  const add = (a, b) => {
    [a, b] = [a, b].sort((x, y) => x - y);
    if (a === b) throw Error("two addresses gated together are placed on one site");
    const k = a + "-" + b;
    if (!pairs.has(k)) {
      const [p, q] = [placement.sites[a].rc, placement.sites[b].rc];
      pairs.set(k, { sites: [a, b], count: 0, length: Math.hypot(p[0] - q[0], p[1] - q[1]) });
    }
    pairs.get(k).count++;
  };
  for (const op of listing.ops) if (TWO_QUBIT.has(op.kind)) add(...op.qubits.map((q) => placement.siteOf(q)));
  // A factory's own rounds couple its workspace (measure sites) to its output block.
  for (const f of placement.factories ?? []) {
    const patch = checks(placement.d);
    f.workspace.forEach((w, i) => { if (patch[i]) for (const j of patch[i].data) add(placement.siteOf(w), placement.siteOf(f.output[j])); });
  }
  return [...pairs.values()];
}
