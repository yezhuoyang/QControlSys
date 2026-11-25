// The circuits of two magic-state experiments, as published, in one form that the twins run,
// the noise simulation reads (bridge/magic_sim.py) and the tests check.
//
// Google Quantum AI, "Magic state cultivation on a superconducting quantum processor",
// arXiv:2512.13908 (2025): the supplementary section "Explicit circuits" links every circuit the
// paper ran as a Crumble URL. The URLs are copied verbatim into validation/ftqvm/papers/rosenfeld2025/
// and parsed here. In them a non-Clifford gate is an identity with a tag (`I[T_gate]`), so that
// Stim can simulate the circuit; the tag says what the hardware played.
//
// Sales Rodriguez et al. (QuEra, Harvard, MIT), "Experimental demonstration of logical magic
// state distillation", Nature 645, 620 (2025), arXiv:2412.15165: the injection circuits are the
// Methods' row-operation lists (R_ops) for the d = 3 and d = 5 color codes; the distillation
// circuit is Fig. 3a. Both are rebuilt here from those lists, and the encoders are checked against
// the code they must produce.
//
// A circuit is { name, qubits: [{ x, y }], moments: [{ ops: [{ gate, tag?, targets, arg? }],
// detectors: [{ coords, recs }], observables: [{ index, recs }] }] }. Gate names are Stim's.
// `recs` are absolute measurement indices.
import { readFileSync } from "node:fs";

const PAPERS = new URL("../../validation/ftqvm/papers/", import.meta.url);

/* ------------------------------------------------------------------ Crumble and Stim text */

const NAMES = ["SQRT_X_DAG", "SQRT_Y_DAG", "SQRT_Z_DAG", "SQRT_XX", "SQRT_X", "SQRT_Y", "SQRT_Z", "H_YZ", "H_XY", "H_XZ", "S_DAG", "C_XYZ", "C_ZYX",
  "MPP", "CX", "CY", "CZ", "MX", "MY", "MZ", "RX", "RY", "RZ", "H", "S", "I", "M", "R", "X", "Y", "Z"];

/** Parse a Crumble circuit (the text after `#circuit=`). */
export function parseCrumble(text, name = "circuit") {
  const qubits = [], moments = [{ ops: [], detectors: [], observables: [] }];
  let measured = 0;
  const recs = (s) => [...s.matchAll(/rec\[(-\d+)\]/g)].map((m) => measured + Number(m[1]));
  for (const item of text.split(";")) {
    if (!item) continue;
    const q = /^Q\(([-\d.]+),([-\d.]+)\)(\d+)$/.exec(item);
    if (q) { qubits[Number(q[3])] = { x: Number(q[1]), y: Number(q[2]) }; continue; }
    if (item === "TICK") { moments.push({ ops: [], detectors: [], observables: [] }); continue; }
    if (/^(MARK|POLYGON)/.test(item)) continue; // display annotations of Crumble
    const dt = /^DT\(([^)]*)\)(.*)$/.exec(item);
    if (dt) { moments.at(-1).detectors.push({ coords: dt[1].split(",").map(Number), recs: recs(dt[2]) }); continue; }
    const oi = /^OI\((\d+)\)(.*)$/.exec(item);
    if (oi) { moments.at(-1).observables.push({ index: Number(oi[1]), recs: recs(oi[2]) }); continue; }
    const gate = NAMES.find((g) => item.startsWith(g) && /^(\[|_|$)/.test(item.slice(g.length)));
    if (!gate) throw Error(name + ": cannot read `" + item.slice(0, 40) + "`");
    let rest = item.slice(gate.length), tag;
    const t = /^\[([^\]]*)\]/.exec(rest);
    if (t) { tag = t[1]; rest = rest.slice(t[0].length); }
    if (gate === "MPP") throw Error(name + ": MPP is not used by the circuits the paper ran");
    const targets = rest.split("_").filter(Boolean).map(Number);
    moments.at(-1).ops.push({ gate, ...(tag ? { tag } : {}), targets });
    if (/^M/.test(gate)) measured += targets.length;
  }
  return { name, qubits, moments: moments.filter((m, i) => i < moments.length - 1 || m.ops.length || m.detectors.length || m.observables.length), measurements: measured };
}

/**
 * A circuit as Stim text: what bridge/magic_sim.py simulates. With `drives`, an operation's tag
 * is its drive (global, local, rydberg, …), which the QuEra noise model reads.
 */
export function stimText(circuit, { drives = false } = {}) {
  const lines = circuit.qubits.map((q, i) => `QUBIT_COORDS(${q.x}, ${q.y}) ${i}`);
  let measured = 0;
  circuit.moments.forEach((m, k) => {
    if (k) lines.push("TICK");
    for (const op of m.ops) {
      const tag = drives ? op.drive : op.tag;
      lines.push(`${op.gate}${tag ? "[" + tag + "]" : ""}${op.arg !== undefined ? "(" + op.arg + ")" : ""} ${op.targets.join(" ")}`);
      if (/^M/.test(op.gate)) measured += op.targets.length;
    }
    for (const d of m.detectors) lines.push(`DETECTOR(${d.coords.join(", ")}) ${d.recs.map((r) => "rec[" + (r - measured) + "]").join(" ")}`);
    for (const o of m.observables) lines.push(`OBSERVABLE_INCLUDE(${o.index}) ${o.recs.map((r) => "rec[" + (r - measured) + "]").join(" ")}`);
  });
  return lines.join("\n") + "\n";
}

/** Operation counts of a circuit: two-qubit gates, measurements, resets, tagged gates. */
export function counts(circuit) {
  const c = { qubits: circuit.qubits.length, moments: circuit.moments.length, twoQubit: 0, measurements: 0, resets: 0, detectors: 0, observables: 0, tagged: {} };
  for (const m of circuit.moments) {
    c.detectors += m.detectors.length;
    c.observables += m.observables.length;
    for (const op of m.ops) {
      if (["CZ", "CX", "CY"].includes(op.gate)) c.twoQubit += op.targets.length / 2;
      else if (/^M/.test(op.gate)) c.measurements += op.targets.length;
      else if (/^R/.test(op.gate)) c.resets += op.targets.length;
      if (op.tag) c.tagged[op.gate + "[" + op.tag + "]"] = (c.tagged[op.gate + "[" + op.tag + "]"] ?? 0) + op.targets.length;
    }
  }
  return c;
}

/* ------------------------------------------------------------------ Google: the paper's circuits */

export const GOOGLE_SOURCE = "Rosenfeld et al. (Google Quantum AI), arXiv:2512.13908, Supplementary Material, \"Explicit circuits\"";

/** The circuits the paper links, by the names of validation/ftqvm/papers/rosenfeld2025/*.crumble. */
export const GOOGLE_CIRCUITS = Object.freeze({
  "fig2-cultivation": "Figure 2: cultivation, cyan curve",
  "fig3-kickback": "Figure 3: kickback tomography, cyan curve",
  "fig4-graft-N2": "Figure 4: grafting, N = 2, with cultivation, cyan curve",
  injection: "State injection circuit",
  cultivation: "Cultivation circuit",
});

export function googleCircuit(name) {
  if (!GOOGLE_CIRCUITS[name]) throw Error("no published circuit named " + name);
  return parseCrumble(readFileSync(new URL("rosenfeld2025/" + name + ".crumble", PAPERS), "utf8").trim(), name);
}

/**
 * What the hardware plays for each operation of the paper's circuits (transmons: one 35 ns XY
 * pulse of angle `angle` about the axis at `axis` rad in the XY plane, framed by virtual Z
 * rotations `before` and `after`; or a virtual Z only). Tags name the non-Clifford and echo
 * gates the Stim circuits carry as identities:
 *   I[T_gate], I[T_dagger_gate]   T = exp(-iπσy/8) and T† on the data qubits (SI, "Cultivation")
 *   S[injection]                  the injected angle as a virtual Z between two H_YZ: the state
 *                                 exp(-iθσy/2)|0⟩ of the main text; S is θ = π/2 in Stim
 *   I[echo]                       an X pulse of the low-frequency-noise echo (SI, Sec. "Effects of coherent noise")
 *   I[conjugate]                  a Pauli pulse that restores the frame before a T layer (same section); taken as X
 *   I[injection], I               nothing is played
 * The decompositions are checked by the state-vector run in tests/ftqvm-magic.test.mjs.
 */
export function transmonPlay(op, { theta = Math.PI / 4 } = {}) {
  const PI = Math.PI;
  const tag = op.tag ?? "";
  switch (op.gate + (tag ? "[" + tag + "]" : "")) {
    case "I": case "I[injection]": return { kind: "idle" };
    case "I[echo]": case "I[conjugate]": return { kind: "pulse", angle: PI, axis: 0 };
    case "I[T_gate]": return { kind: "pulse", angle: PI / 4, axis: PI / 2 };
    case "I[T_dagger_gate]": return { kind: "pulse", angle: PI / 4, axis: -PI / 2 };
    case "S[injection]": return { kind: "frame", angle: theta };
    default: break;
  }
  switch (op.gate) {
    case "H": return { kind: "pulse", before: PI, angle: PI / 2, axis: PI / 2 }; // H = Ry(π/2)·Z
    case "H_YZ": return { kind: "pulse", before: PI, angle: PI / 2, axis: PI }; // H_YZ = Rx(-π/2)·Z
    case "S": return { kind: "frame", angle: PI / 2 };
    case "S_DAG": return { kind: "frame", angle: -PI / 2 };
    case "Z": return { kind: "frame", angle: PI };
    case "X": return { kind: "pulse", angle: PI, axis: 0 };
    case "Y": return { kind: "pulse", angle: PI, axis: PI / 2 };
    case "SQRT_X": return { kind: "pulse", angle: PI / 2, axis: 0 };
    case "SQRT_X_DAG": return { kind: "pulse", angle: PI / 2, axis: PI };
    case "SQRT_Y": return { kind: "pulse", angle: PI / 2, axis: PI / 2 };
    case "SQRT_Y_DAG": return { kind: "pulse", angle: PI / 2, axis: -PI / 2 };
    case "CZ": return { kind: "cz" };
    case "M": return { kind: "measure" };
    case "R": return { kind: "reset" };
    default: throw Error("no transmon realization for " + op.gate + (tag ? "[" + tag + "]" : ""));
  }
}

/* ------------------------------------------------------------------ QuEra: encoders and the factory */

export const QUERA_SOURCE = "Sales Rodriguez et al., Nature 645, 620 (2025), arXiv:2412.15165";

/**
 * The color codes and the paper's row operations. A row operation s → t is CNOT(control s,
 * target t); the circuit applies them in reverse order. `plus` start in |+⟩, `injected` holds the
 * state, the rest start in |0⟩ (Methods, "Design and optimization of state injection circuits").
 * d = 3: the checks are the Methods' S0–S2 and the logical L0. For d = 5 the Methods give only
 * R_ops; `plus` and `injected` are the one assignment for which those operations encode a
 * distance-5 self-dual CSS code (found by search, re-checked by `encoderCode`).
 */
export const QUERA_CODES = Object.freeze({
  3: {
    n: 7, name: "[[7,1,3]] color code",
    rops: [[0, 1], [3, 2], [5, 4], [0, 3], [2, 5], [4, 6], [2, 1], [4, 3], [6, 5]],
    layers: 3, plus: [0, 2, 4], injected: 6,
    checks: [[0, 1, 2, 3], [1, 2, 4, 5], [2, 3, 4, 6]], logical: [0, 1, 5],
  },
  5: {
    n: 17, name: "[[17,1,5]] color code",
    rops: [[1, 0], [3, 2], [4, 5], [7, 6], [9, 8], [15, 12], [2, 0], [6, 3], [8, 5], [12, 10], [13, 11], [2, 4], [8, 6], [9, 7], [10, 13], [16, 14],
      [4, 7], [8, 10], [14, 11], [15, 16], [3, 1], [7, 10], [14, 12], [16, 13]],
    layers: 5, plus: [2, 3, 4, 8, 9, 14, 15, 16], injected: 7,
  },
});

/** Split a row-operation list into the paper's layers: a layer ends where a qubit would repeat. */
function ropLayers(rops) {
  const layers = [[]];
  for (const [s, t] of rops) {
    const used = new Set(layers.at(-1).flat());
    if (used.has(s) || used.has(t)) layers.push([]);
    layers.at(-1).push([s, t]);
  }
  return layers;
}

/**
 * The code an encoder produces: X checks are the images of X on the |+⟩ qubits, Z checks the
 * images of Z on the |0⟩ qubits, the logicals the images of the injected qubit's X and Z
 * (Pauli propagation through the CNOTs, as bit masks over the data qubits).
 */
export function encoderCode(d) {
  const c = QUERA_CODES[d], n = c.n;
  const X = Array.from({ length: n }, (_, q) => 1n << BigInt(q)), Z = X.slice();
  for (const [s, t] of [...c.rops].reverse()) {
    for (let q = 0; q < n; q++) {
      if ((X[q] >> BigInt(s)) & 1n) X[q] ^= 1n << BigInt(t);
      if ((Z[q] >> BigInt(t)) & 1n) Z[q] ^= 1n << BigInt(s);
    }
  }
  const bits = (m) => [...Array(n).keys()].filter((q) => (m >> BigInt(q)) & 1n);
  const zero = [...Array(n).keys()].filter((q) => !c.plus.includes(q) && q !== c.injected);
  return { n, xChecks: c.plus.map((q) => bits(X[q])), zChecks: zero.map((q) => bits(Z[q])), logicalX: bits(X[c.injected]), logicalZ: bits(Z[c.injected]) };
}

/** Rank and span tests over GF(2) on bit masks. */
const mask = (support) => support.reduce((m, q) => m | (1n << BigInt(q)), 0n);
function basis(vectors) {
  const out = [];
  for (let v of vectors) {
    for (const b of out) if ((v ^ b) < v) v ^= b;
    if (v) out.push(v), out.sort((a, b) => (a > b ? -1 : 1));
  }
  return out;
}
const inSpan = (v, b) => { for (const x of b) if ((v ^ x) < v) v ^= x; return v === 0n; };

/** Properties of an encoder's code: self-dual, k = 1, its distance (by enumeration). */
export function checkEncoder(d) {
  const code = encoderCode(d);
  const bx = basis(code.xChecks.map(mask)), bz = basis(code.zChecks.map(mask));
  const selfDual = bx.length === bz.length && bz.every((v) => inSpan(v, bx));
  let distance = Infinity;
  const lx = mask(code.logicalX);
  for (let k = 0; k < 1 << bx.length; k++) {
    let v = lx;
    bx.forEach((b, i) => { if ((k >> i) & 1) v ^= b; });
    distance = Math.min(distance, v.toString(2).split("").filter((x) => x === "1").length);
  }
  return { ...code, selfDual, checks: bx.length, k: code.n - bx.length - bz.length, distance };
}

/**
 * The physical circuit of the QuEra factory: five logical qubits, one per row of atoms, each
 * injected and encoded at the same time, then the distillation circuit of Fig. 3a on whole rows.
 * Rows are physical (Extended Data Fig. 1: the output is the second row, LQ1 and LQ2 of Fig. 3a
 * swapped). Atom (row r, column c) sits at x = c, y = r of the 17 × 5 SLM grid.
 *
 * Operations carry what the hardware does: `drive` is "global" (Raman beam on the whole array),
 * "local" (Raman beam steered by the addressing AODs), "rydberg" (global Rydberg pulse on every
 * gate pair), "aod" (a move) or "image". The encoder follows the Methods recipe: a |+⟩ is |0⟩
 * then √Y; CNOT(s, t) = √Y†(t) · CZ(s, t) · √Y(t); adjacent √Y and √Y† cancel; the first √Y layer
 * is one global pulse (Methods, "Circuit details": the paper plays it as √Y† on every atom and
 * tracks the sign). The first √X layer of Fig. 3a is pre-applied to the injected states.
 * `basis` is the tomography basis of the output row.
 */
export function queraFactory(d, { basis = "Z", stage = "factory" } = {}) {
  const c = QUERA_CODES[d], n = c.n;
  // Fig. 3a order of logical qubits → physical rows (Extended Data Fig. 1).
  const rowOf = { 1: 1, 2: 0, 3: 2, 4: 3, 5: 4 };
  const atom = (row, q) => row * n + q;
  const rows = [0, 1, 2, 3, 4];
  const qubits = [];
  for (const r of rows) for (let q = 0; q < n; q++) qubits.push({ x: q, y: r });
  const moments = [];
  const moment = (ops, label) => moments.push({ ops, detectors: [], observables: [], label });
  const all = (fn) => rows.flatMap((r) => fn(r));
  // The dynamical-decoupling π pulse that accompanies every move (Methods): a global Pauli whose
  // sign the paper tracks classically; Stim sees an identity that carries the pulse's error.
  const echo = () => ({ gate: "I", tag: "echo", targets: all((r) => [...Array(n).keys()].map((q) => atom(r, q))), drive: "global" });
  moment([{ gate: "R", targets: all((r) => [...Array(n).keys()].map((q) => atom(r, q))), drive: "pump" }], "initialize every atom in |0⟩");
  moment([{ gate: "I", tag: "injection", targets: all((r) => [atom(r, c.injected)]), drive: "local" }], "rotate the injection atom of each row into the magic state");
  // The encoder: pending √Y per qubit between CZ layers, cancelled pairwise.
  const pending = new Map(); // qubit → net quarter-turns about Y (+1 √Y, -1 √Y†)
  for (const q of c.plus) pending.set(q, 1);
  const layers = ropLayers([...c.rops].reverse());
  layers.forEach((layer, k) => {
    for (const [, t] of layer) pending.set(t, (pending.get(t) ?? 0) - 1);
    const turns = [...pending.entries()].filter(([, v]) => v % 4 !== 0);
    // The paper plays the first √Y layer as one global pulse (√Y† on every atom, signs tracked).
    // That is only the encoder when every atom but the injected one turns in that layer: true
    // for d = 3; for d = 5 four atoms of the Methods' R_ops do not, so the twin drives it locally.
    const global = k === 0 && turns.length === n - 1 && !pending.has(c.injected);
    if (global) {
      moment([{ gate: "SQRT_Y_DAG", targets: all((r) => [...Array(n).keys()].filter((q) => q !== c.injected).map((q) => atom(r, q))), drive: "global" }], "first √Y layer as one global pulse");
    } else if (turns.length) {
      moment(turns.map(([q, v]) => ({ gate: v > 0 ? "SQRT_Y" : "SQRT_Y_DAG", targets: all((r) => [atom(r, q)]), drive: "local" })), "local √Y before encoding layer " + (k + 1));
    }
    pending.clear();
    moment([{ gate: "CZ", targets: all((r) => layer.flatMap(([s, t]) => [atom(r, s), atom(r, t)])), drive: "rydberg",
      move: { axis: "x", pairs: layer.map(([s, t]) => [s, t]) } }, echo()], "encoding layer " + (k + 1) + ": move, CZ, echo, move back");
    for (const [, t] of layer) pending.set(t, 1);
  });
  const last = [...pending.entries()].filter(([, v]) => v % 4 !== 0);
  if (last.length) moment(last.map(([q, v]) => ({ gate: v > 0 ? "SQRT_Y" : "SQRT_Y_DAG", targets: all((r) => [atom(r, q)]), drive: "local" })), "local √Y after the last encoding layer");
  const everyAtom = rows.flatMap((r) => [...Array(n).keys()].map((q) => atom(r, q)));
  if (stage === "injection") {
    // Injected-state tomography: one global pulse into the basis, then every atom imaged (Methods).
    if (basis !== "Z") moment([{ gate: basis === "X" ? "H" : "H_YZ", targets: everyAtom, drive: "global" }], "global tomography pulse (" + basis + ")");
    moment([{ gate: "M", targets: everyAtom, drive: "image" }], "image every atom");
    return { name: "quera-injection-d" + d + "-" + basis, qubits, moments, measurements: qubits.length, rows: rowOf, n, d, basis, code: c, stage };
  }
  // Fig. 3a, on whole rows (transversal gates). Its first √X layer is in the injected states.
  const row = (lq) => [...Array(n).keys()].map((q) => atom(rowOf[lq], q));
  const transversalCz = (pairs, label) => moment([{ gate: "CZ", targets: pairs.flatMap(([a, b]) => row(a).flatMap((x, i) => [x, row(b)[i]])), drive: "rydberg",
    move: { axis: "y", pairs: pairs.map(([a, b]) => [rowOf[a], rowOf[b]]) } }, echo()], label);
  transversalCz([[1, 2], [3, 4]], "distillation CZ round 1: LQ1–LQ2, LQ3–LQ4");
  moment([{ gate: "SQRT_Y", targets: [...row(1), ...row(4)], drive: "local" }], "√Y on LQ1 and LQ4");
  transversalCz([[1, 3], [4, 5]], "distillation CZ round 2: LQ1–LQ3, LQ4–LQ5");
  moment([{ gate: "SQRT_X_DAG", targets: row(1), drive: "local" }], "√X† on LQ1");
  transversalCz([[2, 4], [1, 5]], "distillation CZ round 3: LQ2–LQ4, LQ1–LQ5");
  moment([{ gate: "SQRT_X_DAG", targets: rows.flatMap((r) => [...Array(n).keys()].map((q) => atom(r, q))), drive: "global" }], "√X† on every logical qubit");
  if (basis !== "Z") moment([{ gate: basis === "X" ? "H" : "H_YZ", targets: row(1), drive: "local" }], "tomography rotation of the output row (" + basis + ")");
  moment([{ gate: "M", targets: everyAtom, drive: "image" }], "image every atom");
  return { name: "quera-factory-d" + d + "-" + basis, qubits, moments, measurements: qubits.length, rows: rowOf, n, d, basis, code: c, stage };
}

/* ------------------------------------------------------------------ a small state-vector simulator */

/** Complex 2×2 gates [a, b, c, d] as [re, im] pairs; Stim's conventions. */
const S2 = Math.SQRT1_2;
const C = (re, im = 0) => [re, im];
export const GATE = {
  I: [C(1), C(0), C(0), C(1)],
  X: [C(0), C(1), C(1), C(0)],
  Y: [C(0), C(0, -1), C(0, 1), C(0)],
  Z: [C(1), C(0), C(0), C(-1)],
  H: [C(S2), C(S2), C(S2), C(-S2)],
  H_YZ: [C(S2), C(0, -S2), C(0, S2), C(-S2)],
  S: [C(1), C(0), C(0), C(0, 1)],
  S_DAG: [C(1), C(0), C(0), C(0, -1)],
  SQRT_X: [C(0.5, 0.5), C(0.5, -0.5), C(0.5, -0.5), C(0.5, 0.5)],
  SQRT_X_DAG: [C(0.5, -0.5), C(0.5, 0.5), C(0.5, 0.5), C(0.5, -0.5)],
  SQRT_Y: [C(0.5, 0.5), C(-0.5, -0.5), C(0.5, 0.5), C(0.5, 0.5)],
  SQRT_Y_DAG: [C(0.5, -0.5), C(0.5, -0.5), C(-0.5, 0.5), C(0.5, -0.5)],
};
export const ry = (a) => [C(Math.cos(a / 2)), C(-Math.sin(a / 2)), C(Math.sin(a / 2)), C(Math.cos(a / 2))];
export const rz = (a) => [C(Math.cos(a / 2), -Math.sin(a / 2)), C(0), C(0), C(Math.cos(a / 2), Math.sin(a / 2))];

/** A state vector of n qubits with one- and two-qubit gates, measurement and reset. */
export class StateVector {
  constructor(n, rng = Math.random) {
    this.n = n; this.rng = rng;
    this.re = new Float64Array(1 << n); this.im = new Float64Array(1 << n); this.re[0] = 1;
  }
  apply(q, [a, b, c, d]) {
    const bit = 1 << q, { re, im } = this;
    for (let i = 0; i < re.length; i++) {
      if (i & bit) continue;
      const j = i | bit, r0 = re[i], i0 = im[i], r1 = re[j], i1 = im[j];
      re[i] = a[0] * r0 - a[1] * i0 + b[0] * r1 - b[1] * i1; im[i] = a[0] * i0 + a[1] * r0 + b[0] * i1 + b[1] * r1;
      re[j] = c[0] * r0 - c[1] * i0 + d[0] * r1 - d[1] * i1; im[j] = c[0] * i0 + c[1] * r0 + d[0] * i1 + d[1] * r1;
    }
  }
  cz(a, b) {
    const m = (1 << a) | (1 << b);
    for (let i = 0; i < this.re.length; i++) if ((i & m) === m) { this.re[i] = -this.re[i]; this.im[i] = -this.im[i]; }
  }
  cx(c, t) { this.apply(t, GATE.H); this.cz(c, t); this.apply(t, GATE.H); }
  /** Probability that qubit q is 1. */
  p1(q) {
    let p = 0;
    for (let i = 0; i < this.re.length; i++) if (i & (1 << q)) p += this.re[i] ** 2 + this.im[i] ** 2;
    return p;
  }
  /** Project qubit q on `bit` (sampled when undefined); returns the bit and its probability. */
  measure(q, bit) {
    const p = this.p1(q);
    if (bit === undefined) bit = this.rng() < p ? 1 : 0;
    const prob = bit ? p : 1 - p, norm = Math.sqrt(prob);
    for (let i = 0; i < this.re.length; i++) {
      if (((i >> q) & 1) === bit) { this.re[i] /= norm; this.im[i] /= norm; } else { this.re[i] = 0; this.im[i] = 0; }
    }
    return { bit, prob };
  }
  reset(q) { if (this.measure(q).bit) this.apply(q, GATE.X); }
  expect(q, pauli) {
    // ⟨P_q⟩ for P in X, Y, Z
    const bit = 1 << q;
    let v = 0;
    for (let i = 0; i < this.re.length; i++) {
      if (i & bit) continue;
      const j = i | bit, a = [this.re[i], this.im[i]], b = [this.re[j], this.im[j]];
      if (pauli === "Z") v += a[0] ** 2 + a[1] ** 2 - b[0] ** 2 - b[1] ** 2;
      else if (pauli === "X") v += 2 * (a[0] * b[0] + a[1] * b[1]);
      else v += 2 * (a[0] * b[1] - a[1] * b[0]);
    }
    return v;
  }
}

/**
 * Run one of the paper's transmon circuits noiselessly with its real non-Clifford gates (the
 * tags) and return its measurement record, detectors and observables. `theta` is the injected
 * polar angle (π/4 is |T⟩). Feasible for the 12- and 14-qubit circuits.
 */
export function runTransmonCircuit(circuit, { theta = Math.PI / 4, rng = Math.random, trace = false } = {}) {
  const sv = new StateVector(circuit.qubits.length, rng);
  const record = [], detectors = [], observables = {}, steps = [];
  const r3 = (x) => Math.round(x * 1000) / 1000;
  for (const m of circuit.moments) {
    const firstRecord = record.length, firstDetector = detectors.length;
    for (const op of m.ops) {
      const tag = op.tag ?? "";
      for (let k = 0; k < op.targets.length; k += op.gate === "CZ" ? 2 : 1) {
        const q = op.targets[k];
        if (op.gate === "CZ") sv.cz(q, op.targets[k + 1]);
        else if (op.gate === "M") record.push(sv.measure(q).bit);
        else if (op.gate === "R") sv.reset(q);
        else if (op.gate === "I") {
          if (tag === "T_gate") sv.apply(q, ry(Math.PI / 4));
          else if (tag === "T_dagger_gate") sv.apply(q, ry(-Math.PI / 4));
          // echo and conjugate pulses cancel in pairs in the paper's circuit: identities here
        } else if (op.gate === "S" && tag === "injection") sv.apply(q, rz(theta));
        else if (GATE[op.gate]) sv.apply(q, GATE[op.gate]);
        else throw Error("no state-vector gate for " + op.gate);
      }
    }
    for (const d of m.detectors) detectors.push(d.recs.reduce((p, r) => p ^ record[r], 0));
    for (const o of m.observables) observables[o.index] = (observables[o.index] ?? 0) ^ o.recs.reduce((p, r) => p ^ record[r], 0);
    // The state after this moment, for the debugger: ⟨X⟩ and ⟨Z⟩ of every qubit, the bits it
    // measured and the detectors it completed.
    if (trace) steps.push({
      x: circuit.qubits.map((_, q) => r3(sv.expect(q, "X"))), z: circuit.qubits.map((_, q) => r3(sv.expect(q, "Z"))),
      bits: record.slice(firstRecord), detectors: detectors.slice(firstDetector),
    });
  }
  return { record, detectors, observables, ...(trace ? { steps } : {}) };
}

/**
 * The five logical qubits through Fig. 3a, step by step: the Bloch vector of each after each
 * gate layer, for perfect magic-state inputs. Layers are named as the factory's moments are.
 */
export function distillationSteps() {
  const sv = new StateVector(5);
  const th = Math.acos(1 / Math.sqrt(3));
  for (let q = 0; q < 5; q++) { sv.apply(q, ry(th)); sv.apply(q, rz(Math.PI / 4)); }
  const bloch = () => [0, 1, 2, 3, 4].map((q) => ["X", "Y", "Z"].map((P) => Math.round(sv.expect(q, P) * 1000) / 1000));
  const layers = [
    ["injected, with the first √X of Fig. 3a pre-applied to LQ1, LQ2, LQ5", 0, 3],
    ["distillation CZ round 1", 3, 5], ["√Y on LQ1 and LQ4", 5, 7], ["distillation CZ round 2", 7, 9],
    ["√X† on LQ1", 9, 10], ["distillation CZ round 3", 10, 12], ["√X† on every logical qubit", 12, 17],
  ];
  return layers.map(([label, from, to]) => {
    for (const [g, qs] of DISTILLATION.slice(from, to)) g === "CZ" ? sv.cz(qs[0], qs[1]) : sv.apply(qs[0], GATE[g]);
    return { label, bloch: bloch() };
  });
}

/* ------------------------------------------------------------------ the logical 5-to-1 circuit */

/** Fig. 3a as logical gates on LQ1–LQ5 (qubit 0 is LQ1, the output). */
export const DISTILLATION = Object.freeze([
  ["SQRT_X", [0]], ["SQRT_X", [1]], ["SQRT_X", [4]],
  ["CZ", [0, 1]], ["CZ", [2, 3]],
  ["SQRT_Y", [0]], ["SQRT_Y", [3]],
  ["CZ", [0, 2]], ["CZ", [3, 4]],
  ["SQRT_X_DAG", [0]],
  ["CZ", [1, 3]], ["CZ", [0, 4]],
  ["SQRT_X_DAG", [0]], ["SQRT_X_DAG", [1]], ["SQRT_X_DAG", [2]], ["SQRT_X_DAG", [3]], ["SQRT_X_DAG", [4]],
]);

/** The magic state of the paper's inputs: Bloch vector (1, 1, 1)/√3 (Methods, Eq. 2). */
export const MAGIC = Object.freeze([1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]);

/** One qubit's density matrix from a Bloch vector: [[re, im] × 4]. */
const rho1 = ([x, y, z]) => [[(1 + z) / 2, 0], [x / 2, -y / 2], [x / 2, y / 2], [(1 - z) / 2, 0]];

/**
 * Distill five input states (Bloch vectors) with Fig. 3a: for every outcome s of LQ2–LQ5 its
 * probability and the output's Bloch vector, by exact density-matrix evolution. The output
 * bits are ordered LQ2, LQ3, LQ4, LQ5 (s = "1011" is LQ2 = 1, LQ3 = 0, ...).
 */
export function distill(inputs = Array(5).fill(MAGIC)) {
  // Pure-state trajectories over the inputs' eigen-decomposition: each input is a mixture of its
  // two Bloch eigenstates; 32 branches, each a 5-qubit state vector.
  const branches = [[1, []]];
  for (const v of inputs) {
    const r = Math.hypot(...v), u = r ? v.map((x) => x / r) : [0, 0, 1];
    const next = [];
    for (const [w, list] of branches) next.push([w * (1 + r) / 2, [...list, u]], [w * (1 - r) / 2, [...list, u.map((x) => -x)]]);
    branches.splice(0, branches.length, ...next.filter(([w]) => w > 1e-15));
  }
  const out = {};
  for (const [w, dirs] of branches) {
    const sv = new StateVector(5);
    dirs.forEach(([x, y, z], q) => {
      const th = Math.acos(Math.max(-1, Math.min(1, z))), ph = Math.atan2(y, x);
      sv.apply(q, ry(th)); sv.apply(q, rz(ph));
    });
    for (const [g, qs] of DISTILLATION) g === "CZ" ? sv.cz(qs[0], qs[1]) : sv.apply(qs[0], GATE[g]);
    for (let s = 0; s < 16; s++) {
      const bits = [1, 2, 3, 4].map((q, i) => (s >> (3 - i)) & 1);
      const copy = Object.assign(new StateVector(5), { re: sv.re.slice(), im: sv.im.slice() });
      let p = 1;
      bits.forEach((b, i) => { const r = copy.p1(i + 1); const pb = b ? r : 1 - r; p *= pb; if (pb > 1e-15) copy.measure(i + 1, b); });
      if (p < 1e-15) continue;
      const key = bits.join("");
      const o = (out[key] ??= { p: 0, bloch: [0, 0, 0] });
      o.p += w * p;
      ["X", "Y", "Z"].forEach((P, i) => (o.bloch[i] += w * p * copy.expect(0, P)));
    }
  }
  for (const o of Object.values(out)) o.bloch = o.bloch.map((v) => v / o.p);
  return out;
}

/** The fidelity of a Bloch vector with a pure target. */
export const fidelity = (bloch, target) => (1 + bloch.reduce((s, v, i) => s + v * target[i], 0)) / 2;
