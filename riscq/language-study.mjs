// The data of the Language page (/language): the languages of QuantumOS, with every claim checked.
//
//   node riscq/language-study.mjs      → validation/language/language.json
//
//   hdl      the hardware description language (riscq/design.mjs): its parts, media and assertion
//            rules. Every rule is shown with a design that breaks it: the reference ring design
//            (valid), changed in one place, and the message riscq/design.mjs check() reports.
//   riscq    the RISC-Q instruction set and memory map: every instruction assembled by
//            riscq/rv32.mjs and decoded back by the Lean decoder's mirror (studio/riscq-disasm.js),
//            the memory map of riscq/soc.mjs, and the Lean definitions and theorems of the model
//            (QControl/RiscQ/*.lean) with their file and line.
//   qsysasm  QSysASM's grammar and statement table (riscq/ftqvm/qsysasm.mjs), the services each
//            statement holds (riscq/os/des.mjs machineModel), and the parser's refusals.
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { ringDesign, check, COMPONENTS, MEDIA } from "./design.mjs";
import { ZCU216 } from "./board.mjs";
import { MAP } from "./soc.mjs";
import { encode, Assembler } from "./rv32.mjs";
import { decode } from "../studio/riscq-disasm.js";
import * as qsysasm from "./ftqvm/qsysasm.mjs";
import { machineModel } from "./os/des.mjs";

const ROOT = new URL("../", import.meta.url);
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── The hardware description language ──────────────────────────────────────────────────────────
// Each assertion rule of check(), in the order check() applies them, with a formal statement and a
// one-place change of the reference design that breaks it. `expect` is a fragment of the message.
const part = (d, id) => d.parts.find((p) => p.id === id);
const channel = (d, id) => d.channels.find((c) => c.id === id);
export const HDL_RULES = [
  { id: "H1", name: "document", formal: "D.kind = riscq-design ∧ D.version = 1", break: "kind changed to \"design\"", expect: "riscq-design", mutate: (d) => { d.kind = "design"; } },
  { id: "H2", name: "unique parts", formal: "∀ p ≠ p′ ∈ D.parts. p.id ≠ p′.id", break: "two parts named q0", expect: "used twice", mutate: (d) => { d.parts.push(clone(part(d, "q0"))); } },
  { id: "H3", name: "known part type", formal: "∀ p ∈ D.parts. p.type ∈ {control-board, core, dac, adc, stage, qubit, resonator}", break: "qubit0's type changed to \"laser\"", expect: "unknown type", mutate: (d) => { part(d, "qubit0").type = "laser"; } },
  { id: "H4", name: "position", formal: "∀ p ∈ D.parts. p.centerMm ∈ ℝ³", break: "q0's centre given as [0, 0]", expect: "needs centerMm", mutate: (d) => { part(d, "q0").centerMm = [0, 0]; } },
  { id: "H5", name: "a board", formal: "∃ p ∈ D.parts. p.type = control-board", break: "the control board removed", expect: "at least one control-board", mutate: (d) => { d.parts = d.parts.filter((p) => p.type !== "control-board"); } },
  { id: "H6", name: "placement on a board", formal: "∀ p ∈ cores ∪ dacs ∪ adcs. p.board defined ⇒ type(p.board) = control-board", break: "q0 placed on qubit0", expect: "which is not a control-board", mutate: (d) => { part(d, "q0").board = "qubit0"; } },
  { id: "H7", name: "number of cores", formal: "1 ≤ |cores| ≤ 1024", break: "every core removed", expect: "1 to 1,024 cores", mutate: (d) => { d.parts = d.parts.filter((p) => p.type !== "core"); } },
  { id: "H8", name: "cores per board", formal: "∀ b. |{c ∈ cores | board(c) = b}| ≤ " + ZCU216.cores.value + " (ZCU216)", break: "six more cores on the board", expect: "a ZCU216 holds", mutate: (d) => { for (let i = 0; i < 6; i++) d.parts.push({ ...clone(part(d, "q0")), id: "extra" + i }); } },
  { id: "H9", name: "converter indices", formal: "∀ b, kind ∈ {dac, adc}. the indices on b are distinct and in [0, " + ZCU216.dacs.value + ")", break: "dac1 given dac0's index", expect: "has its own index", mutate: (d) => { part(d, "dac1").index = part(d, "dac0").index; } },
  { id: "H10", name: "unique channels", formal: "∀ ch ≠ ch′ ∈ D.channels. ch.id ≠ ch′.id", break: "two channels named q0.gate", expect: "Channel id", mutate: (d) => { d.channels.push(clone(channel(d, "q0.gate"))); } },
  { id: "H11", name: "channel on a core", formal: "∀ ch. type(ch.core) = core", break: "q0.gate's core changed to qubit0", expect: "which is not a core", mutate: (d) => { channel(d, "q0.gate").core = "qubit0"; } },
  { id: "H12", name: "channel kind", formal: "∀ ch. ch.kind ∈ {pulse, demod, dio}", break: "q0.gate's kind changed to \"laser\"", expect: "unknown kind", mutate: (d) => { channel(d, "q0.gate").kind = "laser"; } },
  { id: "H13", name: "converter of a channel", formal: "ch.kind = pulse ⇒ type(ch.converter) = dac;  ch.kind = demod ⇒ type(ch.converter) = adc", break: "q0.gate drives the ADC", expect: "needs a dac", mutate: (d) => { channel(d, "q0.gate").converter = channel(d, "q0.demod").converter; } },
  { id: "H14", name: "same board", formal: "ch.converter defined ⇒ board(ch.converter) = board(ch.core)", break: "dac0 moved to a second board", expect: "on another board", mutate: (d) => { d.parts.push({ id: "board1", type: "control-board", centerMm: [0, 400, 0] }); part(d, "dac0").board = "board1"; } },
  { id: "H15", name: "channels per core", formal: "∀ c ∈ cores. 1 ≤ |{ch | ch.core = c}| ≤ 16", break: "q0 given 13 more channels", expect: "A core has 1 to 16", mutate: (d) => { for (let i = 0; i < 13; i++) d.channels.push({ ...clone(channel(d, "q0.cz0")), id: "q0.x" + i, name: "x" + i }); } },
  { id: "H16", name: "channel names", formal: "∀ c. the names of c's channels are distinct", break: "q0.cz0 renamed \"gate\"", expect: "two channels of one name", mutate: (d) => { channel(d, "q0.cz0").name = "gate"; } },
  { id: "H17", name: "one demodulator", formal: "∀ c ∈ cores. |{ch | ch.core = c ∧ ch.kind = demod}| = 1", break: "q0's demod channel removed", expect: "demod channels", mutate: (d) => { d.channels = d.channels.filter((c) => c.id !== "q0.demod"); } },
  { id: "H18", name: "DSP budget", formal: "∀ b. DSP48E2(b) ≤ " + ZCU216.dspCeiling.value, break: "every core given four more pulse channels", expect: "DSP48E2", mutate: (d) => { for (const core of d.parts.filter((p) => p.type === "core")) for (let i = 0; i < 4; i++) d.channels.push({ id: core.id + ".p" + i, core: core.id, name: "p" + i, kind: "pulse", converter: "dac0", slots: 1, interp: 4 }); } },
  { id: "H19", name: "wire endpoints", formal: "∀ w ∈ D.wires. w.from, w.to ∈ parts", break: "drive0 ends at a part that does not exist", expect: "is not a part", mutate: (d) => { d.wires[0].to = "nowhere"; } },
  { id: "H20", name: "wire medium", formal: "∀ w. w.medium ∈ {coax, planar, fiber, beam}", break: "drive0's medium changed to \"copper\"", expect: "unknown medium", mutate: (d) => { d.wires[0].medium = "copper"; } },
  { id: "H21", name: "route", formal: "∀ w. |w.routeMm| ≥ 2 ∧ every point ∈ ℝ³", break: "drive0's route given one point", expect: "at least two points", mutate: (d) => { d.wires[0].routeMm = [d.wires[0].routeMm[0]]; } },
  { id: "H22", name: "route ends", formal: "‖w.routeMm₀ − centre(w.from)‖ ≤ 0.5 mm ∧ ‖w.routeMmₙ − centre(w.to)‖ ≤ 0.5 mm", break: "drive0's route starts 10 mm off", expect: "route ends", mutate: (d) => { d.wires[0].routeMm[0] = d.wires[0].routeMm[0].map((v, k) => (k === 0 ? v + 10 : v)); } },
  { id: "H23", name: "qubit parts", formal: "∀ q ∈ D.qubits. type(q.part) = qubit ∧ type(q.resonator) = resonator", break: "qubit 0's resonator named as its qubit", expect: "names a qubit part and a resonator part", mutate: (d) => { d.qubits[0].resonator = d.qubits[0].part; } },
  { id: "H24", name: "qubit channels", formal: "∀ q. q.gate, q.ro, q.demod ∈ channels", break: "qubit 0's gate channel removed from it", expect: "names no gate channel", mutate: (d) => { d.qubits[0].gate = "q0.none"; } },
  { id: "H25", name: "qubit channel kinds", formal: "kind(q.gate) = kind(q.ro) = pulse ∧ kind(q.demod) = demod", break: "qubit 0 reads out through its demod channel", expect: "acquires through a demod channel", mutate: (d) => { d.qubits[0].ro = d.qubits[0].demod; } },
  { id: "H26", name: "drive path", formal: "path(converter(q.gate), q.part) exists", break: "the coax to qubit 0 removed", expect: "no wire leads from", mutate: (d) => { d.wires = d.wires.filter((w) => w.to !== d.qubits[0].part); } },
  { id: "H27", name: "readout path", formal: "path(converter(q.ro), q.resonator) ∧ path(q.resonator, converter(q.demod)) exist", break: "the readout return of qubit 0 removed", expect: "back to", mutate: (d) => { d.wires = d.wires.filter((w) => w.from !== d.qubits[0].resonator); } },
  { id: "H28", name: "coupling pulses", formal: "∀ c ∈ D.couplings, π ∈ c.pulses. kind(π.channel) = pulse ∧ π.qubit < |D.qubits|", break: "a coupling pulse names qubit 99", expect: "names a pulse channel and a qubit index", mutate: (d) => { d.couplings[0].pulses[0].qubit = 99; } },
  { id: "H29", name: "decoder", formal: "D.decoder defined ⇒ type(D.decoder) = core", break: "the decoder named as dac0", expect: "The decoder is one of the cores", mutate: (d) => { d.decoder = "dac0"; } },
  { id: "H30", name: "one carrier", formal: "∀ ch. every pulse calibrated on ch has the same frequency", break: "qubit 0's drive frequency changed on a channel its coupling also uses", expect: "two carrier frequencies", mutate: (d) => { d.couplings[0].pulses[0].channel = d.qubits[0].gate; } },
];
// A warning: allowed, but the designer should see what it costs.
export const HDL_WARNINGS = [
  { id: "W1", name: "acquisition window", formal: "q.readout.demodDelayNs ≥ delay(ro → resonator) + delay(resonator → demod)", break: "qubit 0's window opens at 0 ns", expect: "hold no signal", mutate: (d) => { d.qubits[0].readout.demodDelayNs = 0; } },
];

function hdl() {
  const reference = ringDesign({ decoder: true });
  const ok = check(reference);
  if (ok.errors.length || ok.warnings.length) throw Error("the reference design does not pass: " + ok.errors.concat(ok.warnings).join("; "));
  const verdict = (rule, kind) => {
    const d = clone(reference);
    rule.mutate(d);
    const r = check(d), list = kind === "warning" ? r.warnings : r.errors;
    const hit = list.find((m) => m.includes(rule.expect));
    if (!hit) throw Error(rule.id + ": breaking it did not report it (" + (list[0] ?? "nothing") + ")");
    return { id: rule.id, name: rule.name, formal: rule.formal, break: rule.break, message: hit, others: list.length - 1 };
  };
  const count = (type) => reference.parts.filter((p) => p.type === type).length;
  return {
    reference: { name: reference.name, parts: reference.parts.length, cores: count("core"), qubits: reference.qubits.length, channels: reference.channels.length, wires: reference.wires.length,
      couplings: reference.couplings.length, board: reference.board, sample: { part: reference.parts.find((p) => p.type === "core"), channel: reference.channels[0], wire: reference.wires[0], qubit: reference.qubits[0], coupling: reference.couplings[0] } },
    components: COMPONENTS, media: MEDIA, zcu216: Object.fromEntries(Object.entries(ZCU216).filter(([, v]) => v?.value !== undefined).map(([k, v]) => [k, v.value])),
    rules: HDL_RULES.map((r) => verdict(r, "error")), warnings: HDL_WARNINGS.map((r) => verdict(r, "warning")),
  };
}

// ── RISC-Q ──────────────────────────────────────────────────────────────────────────────────────
// The instructions the Lean model decodes (QControl/RiscQ/Rv32.lean Instr), each assembled and decoded back.
const SAMPLES = [
  ["U", "lui", "Instr.lui rd imm", () => encode.lui("t0", 0x10)], ["U", "auipc", "Instr.auipc rd imm", () => encode.auipc("a2", 0)],
  ["J", "jal", "Instr.jal rd offset", "jal"], ["I", "jalr", "Instr.jalr rd rs1 imm", () => encode.jalr("zero", "ra", 0)],
  ["B", "beq bne blt bge bltu bgeu", "Instr.branch op rs1 rs2 offset", "beq"],
  ["I", "lb lh lw lbu lhu", "Instr.load op rd rs1 imm", () => encode.lw("t2", "s1", 8)], ["S", "sb sh sw", "Instr.store op rs1 rs2 imm", () => encode.sw("t2", "s1", 0)],
  ["I", "addi slti sltiu xori ori andi slli srli srai", "Instr.opImm op rd rs1 imm", () => encode.addi("t2", "s0", -96)],
  ["R", "add sub sll slt sltu xor srl sra or and", "Instr.op op rd rs1 rs2", () => encode.add("s0", "a0", "t1")],
  ["R", "mul mulh mulhsu mulhu (Zmmul)", "Instr.mulOp op rd rs1 rs2", () => encode.mul("a0", "a1", "a2")],
  ["—", "fence", "Instr.fence", () => 0x0000000f], ["—", "ecall ebreak", "Instr.ecall, Instr.ebreak", () => 0x00000073],
];
function isa() {
  return SAMPLES.map(([format, mnemonics, lean, make]) => {
    let word;
    if (typeof make === "function") word = make() >>> 0;
    else {
      const a = new Assembler();
      a.label("top");
      if (make === "jal") a.jal("zero", "top"); else a.beq("t1", "zero", "top");
      word = a.assemble().words[0] >>> 0;
    }
    const d = decode(word);
    return { format, mnemonics, lean, word: word.toString(16).padStart(8, "0"), text: d.text, kind: d.kind };
  });
}

/** The address map of one core (riscq/soc.mjs MAP), with what each window does. */
function memoryMap() {
  const hex = (v) => "0x" + (v >>> 0).toString(16);
  return [
    [hex(MAP.MEM_BASE), "RAM", "instructions and data; the firmware's bit table sits at the top (s2)"],
    [hex(MAP.CTRL_TIME_CMP), "TIME_CMP", "write: the batch the core waits for"],
    [hex(MAP.CTRL_WAIT_TIME_CMP), "WAIT", "read: stalls the core until the batch counter reaches TIME_CMP"],
    [hex(MAP.CTRL_DONE), "DONE", "write: the core has finished"],
    [hex(MAP.CTRL_TIME), "TIME", "read: the batch counter (core-local copy, behind the converters by the link)"],
    [hex(MAP.SINK_BASE) + " + 0x20·k", "sink k", "read: the k-th reporting channel's result (a demodulated bit); stalls until it is ready"],
    [hex(MAP.INBOX_BOARD), "board inbox", "read: the bits other cores published on this board"],
    [hex(MAP.INBOX_RELEASE), "release inbox", "read: a barrier's release"],
    [hex(MAP.INBOX_MAILBOX0) + " + 4·k", "mailbox k", "read: a word another core put to this one"],
    [hex(MAP.PUT_WINDOW) + " + 0x10000·ch", "channel ch", "write: the channel's registers (posted to its timed queue)"],
    ["  + " + hex(MAP.RF_START_TIME), "  start_time", "the batch at which the next fire takes effect"],
    ["  + " + hex(MAP.RF_FIRE), "  fire", "play the pulse-table slot written here"],
    ["  + " + hex(MAP.RF_FREQ) + ", " + hex(MAP.RF_DC_OFFSET) + ", " + hex(MAP.RF_PHASE_OFFSET), "  freq, dc_offset, phase_offset", "the channel's carrier and offsets"],
    ["  + 0x10·(s+1) + {0, 4, 8, 0xc}", "  slot s: phase, amp, env, dur", "the pulse-table entry s"],
    [hex(MAP.PUT_WINDOW) + " + 0x10000·(" + MAP.LOCAL_NODES + " + g)", "hub group node g", "write: a put to a group of cores"],
    [hex(MAP.PUT_WINDOW) + " + 0x10000·(" + MAP.BARRIER_NODE0 + " + b)", "hub barrier b", "write: arrive at barrier b"],
    [hex(MAP.PUT_WINDOW) + " + 0x10000·(" + MAP.INBOX_NODE0 + " + k)", "hub inbox node k", "write: publish a word to every core of the board"],
    [hex(MAP.HOSTWIN), "host window", "write: a result for the host"],
  ];
}

/** Lean declarations of the RISC-Q model: kind, name, file, line, and the doc comment above it. */
function lean() {
  const dir = new URL("QControl/RiscQ/", ROOT), out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".lean")).sort()) {
    const lines = readFileSync(new URL(f, dir), "utf8").split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = /^(theorem|lemma|inductive|structure|def|abbrev)\s+([A-Za-z_][\w.']*)/.exec(l);
      if (!m) return;
      let doc = "";
      for (let k = i - 1; k >= 0 && k >= i - 6; k--) { const dm = /\/--\s*(.*?)(-\/)?\s*$/.exec(lines[k]); if (dm) { doc = lines.slice(k, i).join(" ").replace(/\/--|-\//g, "").replace(/\s+/g, " ").trim(); break; } if (!/^\s*(--|\S.*-\/\s*$)/.test(lines[k]) && lines[k].trim()) break; }
      const statement = m[1] === "theorem" || m[1] === "lemma" ? lines.slice(i, i + 4).join(" ").replace(/\s+/g, " ").replace(/:=.*$/, "").trim() : "";
      out.push({ kind: m[1], name: m[2], file: "QControl/RiscQ/" + f, line: i + 1, doc: doc.slice(0, 240), statement: statement.slice(0, 300) });
    });
  }
  return out;
}

// ── QSysASM ─────────────────────────────────────────────────────────────────────────────────────
function qsys() {
  const machine = { qubits: 16, decoders: 1, factories: 1, classical_data_bandwidth: 500, qubit_routing_bandwidth: 5000, ancilla_bandwidth: 1000, max_parallel_gates: 16,
    gate1q_ns: 40, gate2q_ns: 200, measure_ns: 1000, reset_ns: 160, route_latency_ns: 2, decoder_latency_ns: 400, magic_state_latency_ns: 5000, pauli_frame_update_ns: 30 };
  const model = machineModel(machine);
  const services = (text) => {
    const op = qsysasm.withDurations({ ...qsysasm.parse(text), machine }).ops[0];
    return model.needs({ ...op, qubits: [...op.qubits, ...op.work] }, Math.max(1, op.duration)).filter(([, a]) => a > 0).map(([p, a]) => p + " " + a);
  };
  const samples = { H: "H data[0]", CNOT: "CNOT data[0], data[1]", measure: "measure basis=Z ancilla[0] -> s[0]", request_ancilla: "request_ancilla count=2 ancilla[0:1]",
    release_ancilla: "release_ancilla count=2 ancilla[0:1]", route: "route ancilla[0], data[0:1]", decode_syndrome: "s[0:1] -> decode_syndrome rounds=1",
    request_magic: "request_magic state=|T> magic[0]", pauli_frame_update: "s[0:1] -> pauli_frame_update X data[0:2]", parity: "s[0:1] -> parity -> p[0]" };
  const statements = Object.entries(samples).map(([kind, text]) => ({ kind, text, field: qsysasm.DURATION_FIELD[kind] ?? null, services: services(text) }));
  const refusals = ["gadget surfaceRound[data: dbase + 9](dbase) spans 2478 ns:", "spec surfaceRound:", "call surfaceRound(0, 0, 0)", "for 0 <= i < n:", "when c[1]:", "H data[i]", "request_ancilla count=3 ancilla[0:1]", "CNOT data[0]"]
    .map((text) => { try { qsysasm.parse(text); return { text, error: null }; } catch (e) { return { text, error: e.message }; } });
  if (refusals.some((r) => !r.error)) throw Error("the parser accepted " + refusals.find((r) => !r.error).text);
  return { machineLine: qsysasm.machineLine(machine), gates: qsysasm.GATES, systemCalls: qsysasm.SYSTEM_CALLS, statements, refusals };
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const data = { generated: new Date().toISOString(), hdl: hdl(), riscq: { isa: isa(), map: memoryMap(), lean: lean() }, qsysasm: qsys() };
  mkdirSync(new URL("validation/language/", ROOT), { recursive: true });
  writeFileSync(new URL("validation/language/language.json", ROOT), JSON.stringify(data) + "\n");
  console.log("hdl rules", data.hdl.rules.length, "warnings", data.hdl.warnings.length, "| isa", data.riscq.isa.length, "| lean decls", data.riscq.lean.length,
    "theorems", data.riscq.lean.filter((d) => d.kind === "theorem").length, "| qsysasm statements", data.qsysasm.statements.length);
}
