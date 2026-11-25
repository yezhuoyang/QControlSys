// QSysASM: the text form of a program at the Fault-Tolerant Quantum Execution Interface.
//
// A QSysASM program is flat. It names concrete physical qubits and classical records, and every
// statement is one physical instruction or one system call. There are no gadgets, no contracts
// for gadgets, no calls, no loops, no guards and no parameters: a repeated round is written out
// once per round. The instruction set, the system calls and the `machine { … }` fields are the
// interface's; what a compiler may use to produce a listing (gadgets, loops) is expanded before
// a program reaches the operating system.
//
// Grammar (one statement per line; `#` starts a comment):
//   program    := header* statement*
//   header     := "machine {" fields "}"                       the machine's declared services
//               | "factory {" fields "}"                       the request_magic service contract
//   statement  := time? (records "->")? op arg* operands? ("with" operands)? ("->" records)?
//                                                                "with": request_magic's workspace
//   time       := "@" integer "ns"                              absolute start; omitted = not yet
//                                                                scheduled (the OS assigns it)
//   op         := H | S | Sdg | X | Z | CNOT | CZ | CY | measure
//               | request_ancilla | release_ancilla | request_magic | route
//               | decode_syndrome | pauli_frame_update | parity
//   arg        := name "=" (integer | X | Y | Z | "|" name ">")  count=, basis=, rounds=, input_ns=, state=
//   operands   := operand ("," operand)*
//   operand    := pauli? register "[" integer (":" integer)? "]"   a:b is inclusive
//   records    := register "[" integer (":" integer)? "]" ("," …)*
// Units: times in integer nanoseconds. An index is a literal integer; a name inside brackets
// is a parameter and is refused.

export const GATES = Object.freeze(["H", "S", "Sdg", "X", "Z", "CNOT", "CZ", "CY"]);
export const SYSTEM_CALLS = Object.freeze(["request_ancilla", "release_ancilla", "request_magic", "route", "decode_syndrome", "pauli_frame_update", "parity"]);
export const INSTRUCTIONS = Object.freeze([...GATES, "measure"]);
const OPS = new Set([...INSTRUCTIONS, ...SYSTEM_CALLS]);

// Constructs a compiler's listing may contain and a QSysASM program may not.
const REFUSED = [
  [/^gadget\b/, "a gadget definition: write its operations out where it is used"],
  [/^spec\b/, "a contract for a gadget or program: the machine line declares every service"],
  [/^call\b|\bcall\s+\w+\s*\(/, "a gadget call: write the gadget's operations out"],
  [/^(for|repeat|loop)\b/, "a loop: write each iteration out"],
  [/^(when|if)\b/, "a guard: a conditional correction is a pauli_frame_update"],
  [/^(params|program\[|codes:|code\s)/, "a logical-program declaration, not an instruction"],
  [/^maintenance\b/, "background maintenance is the operating system's, not the program's"],
  [/^resource\s*\{/, "a resource summary: the operating system derives it"],
];

const key = (s) => s.register + "[" + s.index + "]";

/** Sites as operand text, consecutive indices of one register merged into an inclusive range. */
export function sitesText(sites, paulis) {
  const out = [];
  for (let i = 0; i < sites.length; ) {
    const p = paulis?.[i] ?? "";
    let j = i;
    while (j + 1 < sites.length && sites[j + 1].register === sites[i].register && sites[j + 1].index === sites[j].index + 1 && (paulis?.[j + 1] ?? "") === p) j++;
    const range = j > i ? sites[i].index + ":" + sites[j].index : String(sites[i].index);
    out.push((p ? p + " " : "") + sites[i].register + "[" + range + "]");
    i = j + 1;
  }
  return out.join(", ");
}

/** The Pauli written before each operand of a statement (`CZ a[0], Z d[1]`), if any. */
function paulisFrom(text, count) {
  const body = text.replace(/^@\S+\s+ns\s+/, "").replace(/^.*?->\s*(?=[A-Za-z_]+\s)/, "");
  // Operand groups `P reg[i]`, `P reg[a:b]` or `reg[…]`; a parametric range's length is not in the
  // text, so it is what the other groups leave of `count`.
  const groups = [...body.matchAll(/(?:^|,|\s)(?:([XYZ])\s+)?[A-Za-z_]\w*\[([^\]]+)\]/g)].map((g) => {
    const r = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(g[2]);
    return { pauli: g[1] ?? "", n: r ? Number(r[2]) - Number(r[1]) + 1 : /:/.test(g[2]) ? null : 1 };
  });
  if (!groups.some((g) => g.pauli)) return null;
  const unknown = groups.filter((g) => g.n === null);
  if (unknown.length > 1) {
    // Several ranges of unknown length: only a single Pauli over every operand is certain.
    const ps = new Set(groups.map((g) => g.pauli));
    if (ps.size === 1) return Array(count).fill(groups[0].pauli);
    throw Error("cannot assign the Paulis of \"" + text + "\" to its " + count + " operands");
  }
  if (unknown.length === 1) unknown[0].n = count - groups.reduce((s, g) => s + (g.n ?? 0), 0);
  const letters = groups.flatMap((g) => Array(Math.max(0, g.n)).fill(g.pauli));
  if (letters.length !== count) throw Error("cannot assign the Paulis of \"" + text + "\" to its " + count + " operands");
  return letters;
}

/** One expanded operation as a QSysASM statement. */
export function statement(op, { timed = true } = {}) {
  const parts = [];
  if (op.reads?.length && op.kind !== "measure") parts.push(sitesText(op.reads), "->");
  parts.push(op.kind);
  if (op.kind === "measure" && op.arg) parts.push("basis=" + op.arg);
  if ((op.kind === "request_ancilla" || op.kind === "release_ancilla") && op.arg !== null && op.arg !== undefined) parts.push("count=" + op.arg);
  if (op.kind === "decode_syndrome") {
    const rounds = /\brounds=(\d+)/.exec(op.text ?? "")?.[1];
    if (rounds) parts.push("rounds=" + rounds);
    if (op.inputNs) parts.push("input_ns=" + op.inputNs);
  }
  if (op.kind === "request_magic" && op.arg) parts.push("state=" + op.arg);
  if (op.qubits.length) {
    const paulis = op.kind === "pauli_frame_update" || GATES.includes(op.kind) ? paulisFrom(op.text ?? "", op.qubits.length) : null;
    parts.push(sitesText(op.qubits, paulis));
  }
  if (op.kind === "request_magic" && op.work?.length) parts.push("with", sitesText(op.work));
  if (op.writes?.length) parts.push("->", sitesText(op.writes));
  const body = parts.join("  ").replace(/ {2}-> {2}/g, " -> ");
  return timed ? ("@" + op.start + " ns").padEnd(14) + body : body;
}

const MACHINE_ORDER = ["qubits", "decoders", "factories", "classical_data_bandwidth", "qubit_routing_bandwidth", "ancilla_bandwidth", "max_parallel_gates",
  "gate1q_ns", "gate2q_ns", "measure_ns", "reset_ns", "route_latency_ns", "decoder_latency_ns", "magic_state_latency_ns", "pauli_frame_update_ns"];
const unitOf = (k) => (k.endsWith("_ns") ? " ns" : k === "classical_data_bandwidth" ? " bits/us" : k.endsWith("bandwidth") ? " qubits/us" : " total");

/** The `machine { … }` line of a machine given as { field: number } (the expansion's `machine`). */
export function machineLine(machine) {
  if (!machine) return null;
  const names = [...MACHINE_ORDER.filter((k) => machine[k] !== undefined), ...Object.keys(machine).filter((k) => !MACHINE_ORDER.includes(k) && typeof machine[k] === "number")];
  return "machine { " + names.map((k) => k + ": " + machine[k] + unitOf(k)).join(", ") + " }";
}

/** Factory contracts among an expansion's `specs` (the request_magic services). */
export function factoriesIn(specs) {
  return Object.fromEntries(Object.entries(specs ?? {}).filter(([name, s]) => /^factory/.test(name) && s && typeof s === "object"));
}

/**
 * The canonical flat program of an expansion ({ machine, specs, ops }): its machine and factory
 * headers, then one statement per operation. Ops get the `line` and `text` of their statement.
 */
export function canonical(expansion, { title } = {}) {
  return flatten(expansion, { title, machineLine: machineLine(expansion.machine), factories: factoriesIn(expansion.specs) });
}

/** The first `count` lines of a program's text (the headers and the first statements). */
export const head = (text, count = 40) => text.split("\n").slice(0, count).join("\n");

/** A `factory { … }` header from a factory contract ({ field: value }). */
function factoryLine(contract) {
  const unit = (k) => (k.endsWith("_qubits") || ["gates", "decoders"].includes(k) ? " total" : k === "latency" ? " ns" : k.endsWith("bandwidth") ? (k.startsWith("classical") ? " bits/us" : " qubits/us") : "");
  return "factory { " + Object.entries(contract).map(([k, v]) => k + ": " + (typeof v === "object" ? v.value : v) + unit(k)).join(", ") + " }";
}

/**
 * A listing (the compiler's expansion: { ops, machine? }) as QSysASM text.
 * options: { title, machineLine (the `machine { … }` text), factories ({ name: contract }), limit }.
 * Returns { text, lines, lineOf: Map(uid → line number) }.
 */
export function format(listing, { title, machineLine, factories, limit = Infinity } = {}) {
  const lines = [];
  if (title) lines.push("# " + title);
  if (machineLine) lines.push(machineLine.trim());
  for (const c of Object.values(factories ?? {})) lines.push(factoryLine(c));
  if (lines.length) lines.push("");
  const ops = [...listing.ops].sort((a, b) => a.start - b.start || a.order - b.order);
  const lineOf = new Map();
  for (const op of ops.slice(0, limit)) {
    lines.push(statement(op));
    lineOf.set(op.uid, lines.length);
  }
  if (ops.length > limit) lines.push("# … " + (ops.length - limit) + " more statements");
  return { text: lines.join("\n") + "\n", lines: ops.length, lineOf };
}

/**
 * A listing restated as flat QSysASM: the same operations, each with `line` and `text` of its
 * statement in the flat program, so hardware instructions that cite "listing line N" cite the
 * flat text. Returns { listing, text }.
 */
export function flatten(listing, options = {}) {
  const { text, lineOf } = format(listing, options);
  const lines = text.split("\n");
  const ops = listing.ops.map((op) => ({ ...op, line: lineOf.get(op.uid), text: lines[lineOf.get(op.uid) - 1].trim() }));
  return { listing: { ...listing, ops }, text };
}

/** The `machine { … }` line of a machine text (the line only, without factory contracts). */
export function machineLineOf(machineText) {
  return /^machine\s*\{.*\}\s*$/m.exec(machineText ?? "")?.[0] ?? null;
}

/** Factory contracts in a machine text, `spec factory:` blocks of a compiler machine file. */
export function factoriesOf(machineText) {
  const out = {};
  for (const m of (machineText ?? "").matchAll(/^spec\s+(factory\w*)\s*:\s*\n\s*resource\s*\{([^}]*)\}/gm))
    out[m[1]] = Object.fromEntries(m[2].split(",").map((f) => f.trim().split(/\s*:\s*/)).filter((f) => f.length === 2).map(([k, v]) => [k, Number(v.split(/\s+/)[0])]));
  return out;
}

/** The interface's machine and factory headers, from a compiler machine text. */
export function headerOf(machineText) {
  const lines = [machineLineOf(machineText), ...Object.values(factoriesOf(machineText)).map(factoryLine)].filter(Boolean);
  return lines.join("\n");
}

/** Parse `reg[a]` / `reg[a:b]` lists into sites; refuses a non-literal index. */
function sitesOf(text, line) {
  const sites = [], paulis = [];
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(?:([XYZ])\s+)?([A-Za-z_]\w*)\[([^\]]*)\]$/.exec(part);
    if (!m) throw new SyntaxError(`line ${line}: "${part}" is not an operand (register[index] or register[a:b])`);
    const r = /^\s*(\d+)\s*(?::\s*(\d+)\s*)?$/.exec(m[3]);
    if (!r) throw new SyntaxError(`line ${line}: "${part}" has a parameter in its index; QSysASM names concrete qubits only`);
    const lo = Number(r[1]), hi = r[2] === undefined ? lo : Number(r[2]);
    if (hi < lo) throw new SyntaxError(`line ${line}: empty range ${part}`);
    for (let i = lo; i <= hi; i++) { sites.push({ register: m[2], index: i }); paulis.push(m[1] ?? ""); }
  }
  return { sites, paulis };
}

/** Parse a `{ name: number unit, … }` field list. */
function fieldsOf(body) {
  return Object.fromEntries(body.split(",").map((f) => f.trim()).filter(Boolean).map((f) => {
    const m = /^(\w+)\s*:\s*(\d+)(?:\s+(\S+))?$/.exec(f);
    if (!m) throw new SyntaxError(`field "${f}" is not name: number unit`);
    return [m[1], Number(m[2])];
  }));
}

/**
 * Parse QSysASM text. Returns { machine, factories, ops } with ops in the shape the compiler's
 * expansion gives (uid, order, kind, start|null, duration|null, qubits, work, reads, writes, arg,
 * inputNs, line, text, paulis). A statement without `@` has start null: the operating system
 * schedules it. Throws SyntaxError on anything that is not flat QSysASM.
 */
export function parse(text) {
  let machine = null;
  const factories = {}, ops = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1, s = raw.replace(/#.*/, "").trim();
    if (!s) return;
    for (const [rx, why] of REFUSED) if (rx.test(s)) throw new SyntaxError(`line ${line}: ${why} ("${s.slice(0, 60)}")`);
    const header = /^(machine|factory\w*)\s*\{(.*)\}$/.exec(s);
    if (header) {
      if (header[1] === "machine") machine = fieldsOf(header[2]);
      else factories[header[1]] = fieldsOf(header[2]);
      return;
    }
    const m = /^(?:@(\d+)\s*ns\s+)?(?:((?:[A-Za-z_]\w*\[[^\]]*\]\s*,?\s*)+)->\s*)?([A-Za-z_]\w*)\b(.*)$/.exec(s);
    if (!m || !OPS.has(m[3])) throw new SyntaxError(`line ${line}: "${s.slice(0, 60)}" is not a QSysASM instruction or system call`);
    const [, at, before, kind, restRaw] = m;
    let rest = restRaw.trim(), writes = [];
    const arrow = rest.indexOf("->");
    if (arrow >= 0) { writes = sitesOf(rest.slice(arrow + 2), line).sites; rest = rest.slice(0, arrow).trim(); }
    const args = {};
    rest = rest.replace(/(?:^|\s)(\w+)=(\S+)/g, (_, k, v) => {
      if (!/^(\d+|[XYZ]|\|\w+>)$/.test(v)) throw new SyntaxError(`line ${line}: ${k}=${v} is not a literal`);
      args[k] = /^\d+$/.test(v) ? Number(v) : v;
      return " ";
    }).trim();
    // request_magic names its output qubits, then `with` its factory's workspace.
    let work = [];
    const w = /\swith\s/.exec(" " + rest + " ");
    if (w) {
      if (kind !== "request_magic") throw new SyntaxError(`line ${line}: only request_magic names a workspace with "with"`);
      work = sitesOf(rest.slice(w.index + w[0].length - 1), line).sites;
      rest = rest.slice(0, w.index).trim();
    }
    const { sites, paulis } = sitesOf(rest, line);
    const reads = before ? sitesOf(before, line).sites : [];
    const arg = kind === "measure" ? args.basis ?? "Z" : kind === "request_magic" ? args.state ?? null : args.count ?? null;
    const op = { uid: ops.length, order: ops.length, kind, start: at === undefined ? null : Number(at), duration: null,
      qubits: sites, work, reads, writes, arg, inputNs: args.input_ns ?? null, line, text: s, paulis: paulis.some(Boolean) ? paulis : null };
    if ((kind === "request_ancilla" || kind === "release_ancilla") && op.arg !== null && op.arg !== sites.length)
      throw new SyntaxError(`line ${line}: count=${op.arg} but ${sites.length} qubits are named`);
    if (GATES.includes(kind) && sites.length !== (["CNOT", "CZ", "CY"].includes(kind) ? 2 : 1))
      throw new SyntaxError(`line ${line}: ${kind} takes ${["CNOT", "CZ", "CY"].includes(kind) ? 2 : 1} qubit(s)`);
    ops.push(op);
  });
  return { machine, factories, ops };
}

/** Machine field each operation kind is charged (the interface's timing table). */
export const DURATION_FIELD = Object.freeze({
  H: "gate1q_ns", S: "gate1q_ns", Sdg: "gate1q_ns", X: "gate1q_ns", Z: "gate1q_ns",
  CNOT: "gate2q_ns", CZ: "gate2q_ns", CY: "gate2q_ns", measure: "measure_ns", request_ancilla: "reset_ns",
  route: "route_latency_ns", decode_syndrome: "decoder_latency_ns", request_magic: "magic_state_latency_ns",
  pauli_frame_update: "pauli_frame_update_ns", parity: "pauli_frame_update_ns", release_ancilla: null,
});

/** Durations from the machine line: each op lasts its kind's declared latency. */
export function withDurations(program) {
  const m = program.machine ?? {};
  for (const op of program.ops) {
    const f = DURATION_FIELD[op.kind];
    op.duration = f ? (op.kind === "decode_syndrome" && op.inputNs ? op.inputNs : 0) + (m[f] ?? 0) : 0;
    if (op.start !== null) op.end = op.start + op.duration;
  }
  return program;
}

export { key as siteKey };
