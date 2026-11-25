// /language: the languages of QuantumOS as a programming-language definition. The grammars are the
// ones the code parses; every assertion rule is shown with a design that breaks it; the RISC-Q
// semantics is the Lean model's. Data: validation/language/language.json (riscq/language-study.mjs).
// The QSysASM examples are parsed and scheduled here, in the browser, by the OS's own code.
import * as qsysasm from "/riscq/ftqvm/qsysasm.mjs";
import { schedule } from "/riscq/os/schedule.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const code = (s) => `<code>${esc(s)}</code>`;
const num = (x) => Number(x).toLocaleString("en");
const tns = (t) => (t >= 1000 ? (t / 1000).toLocaleString("en", { maximumFractionDigits: 2 }) + " µs" : num(t) + " ns");
const strip = (s) => String(s ?? "").replace(/^@\d+\s*ns\s+/, "").replace(/\s{2,}/g, " ");
const KIND_COLOR = (k) => (["H", "S", "Sdg", "X", "Z", "CNOT", "CZ", "CY"].includes(k) ? "#4338ca" : k === "request_ancilla" ? "#1baf7a" : k === "measure" ? "#c4622d"
  : k === "decode_syndrome" ? "#c62828" : k === "pauli_frame_update" || k === "parity" ? "#0e7490" : k === "request_magic" ? "#b45309" : "#8a9a9c");

/** BNF with non-terminals, terminals and comments coloured. */
const bnf = (text) => `<pre class="bnf">${esc(text).replace(/(#.*)$/gm, '<span class="cm">$1</span>').replace(/(&quot;[^&]*?&quot;)/g, '<span class="kw">$1</span>')
  .replace(/^(\s*)([a-z][\w]*)(\s+::=)/gm, '$1<span class="nt">$2</span>$3')}</pre>`;
/** An inference rule: premises over a conclusion, with its name. */
const rule = (name, premises, conclusion) => `<div class="ir"><div class="cell top">${premises.map(esc).join("&nbsp;&nbsp;&nbsp;&nbsp;") || "&nbsp;"}</div><div class="name">${esc(name)}</div><div class="cell bot">${esc(conclusion)}</div></div>`;
function table(head, rows, cls = "") {
  return `<div class="tbl ${cls}"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => "<tr>" + r.map((c, i) => `<td${typeof c === "object" ? ` class="${c.cls}"` : ""}>${typeof c === "object" ? c.html : c}</td>`).join("") + "</tr>").join("")}</tbody></table></div>`;
}

const QSYSASM_BNF = `program    ::= header* line*
header     ::= "machine" "{" field ("," field)* "}"          # the machine's declared services
            |  "factory" "{" field ("," field)* "}"          # the request_magic service contract
field      ::= name ":" nat unit
unit       ::= "ns" | "total" | "bits/us" | "qubits/us"
line       ::= statement | "#" text
statement  ::= time? (records "->")? op arg* operands? ("with" operands)? ("->" records)?
time       ::= "@" nat "ns"                                  # absolute start; none: the OS assigns it
op         ::= gate | "measure" | syscall
gate       ::= "H" | "S" | "Sdg" | "X" | "Z" | "CNOT" | "CZ" | "CY"
syscall    ::= "request_ancilla" | "release_ancilla" | "request_magic" | "route"
            |  "decode_syndrome" | "pauli_frame_update" | "parity"
arg        ::= name "=" (nat | pauli | "|" name ">")         # count=, basis=, rounds=, input_ns=, state=
operands   ::= operand ("," operand)*
operand    ::= pauli? register "[" nat (":" nat)? "]"        # a:b is inclusive
records    ::= register "[" nat (":" nat)? "]" ("," register "[" nat (":" nat)? "]")*
pauli      ::= "X" | "Y" | "Z"
nat        ::= digit+                                        # every index is a literal`;

const MACHINE_FIELDS = [
  ["qubits", "total", "the qubit pool request_ancilla draws from"], ["max_parallel_gates", "total", "gate slots"], ["decoders", "total", "decoder units"], ["factories", "total", "magic-state factories"],
  ["classical_data_bandwidth", "bits/us", "measured bits and frame updates in flight"], ["qubit_routing_bandwidth", "qubits/us", "qubits being routed"], ["ancilla_bandwidth", "qubits/us", "qubits being prepared"],
  ["gate1q_ns, gate2q_ns", "ns", "one- and two-qubit gate latency"], ["measure_ns", "ns", "measurement latency: start to the bit in memory"], ["reset_ns", "ns", "preparation latency of request_ancilla"],
  ["route_latency_ns", "ns", "latency of route"], ["decoder_latency_ns", "ns", "latency of decode_syndrome (plus input_ns)"], ["magic_state_latency_ns", "ns", "latency of request_magic"], ["pauli_frame_update_ns", "ns", "latency of pauli_frame_update and parity"],
];

const HDL_BNF = `design    ::= { kind: "riscq-design", version: 1, name?: string, board: board,
                parts: [part*], channels: [channel*], wires: [wire*],
                qubits: [qubit*], couplings: [coupling*], decoder?: id }
board     ::= { dspHz: nat, linkStages: nat, memWords: nat, queueDepth: nat, envDepth: nat }
part      ::= { id: id, type: ptype, centerMm: vec3, index?: nat, board?: id }
ptype     ::= "control-board" | "core" | "dac" | "adc" | "stage" | "qubit" | "resonator"
channel   ::= { id: id, core: id, name: string, kind: ckind, converter?: id, slots?: nat, interp?: nat }
ckind     ::= "pulse" | "demod" | "dio"
wire      ::= { id: id, from: id, to: id, medium: medium, routeMm: [vec3, vec3, vec3*] }
medium    ::= "coax" | "planar" | "fiber" | "beam"
qubit     ::= { part: id, resonator: id, gate: id, ro: id, demod: id, freqHz: real,
                x90: pulse, x: pulse, reset?: pulse, readout: readout }
pulse     ::= { amp: real, phaseRad: real, durNs: real, envelope: string, virtualZ?: [real, real] }
readout   ::= { freqHz: real, amp: real, durNs: real, envelope: string,
                demodDelayNs: real, demodNs: real, demodPhaseRad: real }
coupling  ::= { qubits: [nat, nat], freqHz: real, durNs: real, pulses: [cpulse*],
                virtualZ: [{ qubit: nat, phaseRad: real }*] }
cpulse    ::= { qubit: nat, channel: id, amp: real, phaseRad: real, envelope: string }
vec3      ::= [real, real, real]                             # mm`;

const RISCQ_BNF = `instr   ::= "lui" reg "," imm20         | "auipc" reg "," imm20
         |  "jal" reg "," off21         | "jalr" reg "," imm12 "(" reg ")"
         |  brop reg "," reg "," off13
         |  ldop reg "," imm12 "(" reg ")" | stop reg "," imm12 "(" reg ")"
         |  immop reg "," reg "," imm12 | aluop reg "," reg "," reg
         |  mulop reg "," reg "," reg   # Zmmul: multiply without divide
         |  "fence" | "ecall" | "ebreak"
brop    ::= "beq" | "bne" | "blt" | "bge" | "bltu" | "bgeu"
ldop    ::= "lb" | "lh" | "lw" | "lbu" | "lhu"
stop    ::= "sb" | "sh" | "sw"
immop   ::= "addi" | "slti" | "sltiu" | "xori" | "ori" | "andi" | "slli" | "srli" | "srai"
aluop   ::= "add" | "sub" | "sll" | "slt" | "sltu" | "xor" | "srl" | "sra" | "or" | "and"
mulop   ::= "mul" | "mulh" | "mulhsu" | "mulhu"
reg     ::= "x0" | "x1" | … | "x31"                            # x0 reads as 0`;

// A small program around each statement, so that its example means something.
const CONTEXT = {
  H: ["H data[0]", "CNOT data[0], data[1]"],
  CNOT: ["H data[0]", "CNOT data[0], data[1]", "CNOT data[1], data[2]"],
  measure: ["H data[0]", "measure basis=Z data[0] -> c[0]", "measure basis=X data[1] -> c[1]"],
  request_ancilla: ["request_ancilla count=2 ancilla[0:1]", "CNOT data[0], ancilla[0]", "measure basis=Z ancilla[0] -> s[0]", "release_ancilla count=2 ancilla[0:1]"],
  release_ancilla: ["request_ancilla count=1 ancilla[0]", "measure basis=Z ancilla[0] -> s[0]", "release_ancilla count=1 ancilla[0]", "request_ancilla count=1 ancilla[1]"],
  route: ["route ancilla[0], data[0:1]", "CNOT data[0], ancilla[0]", "CNOT data[1], ancilla[0]"],
  decode_syndrome: ["measure basis=Z ancilla[0] -> s[0]", "measure basis=Z ancilla[1] -> s[1]", "s[0:1] -> decode_syndrome rounds=1"],
  request_magic: ["request_magic state=|T> magic[0]", "CNOT data[0], magic[0]", "measure basis=Z magic[0] -> m[0]", "m[0] -> pauli_frame_update Z data[0]"],
  pauli_frame_update: ["measure basis=Z ancilla[0] -> s[0]", "measure basis=Z ancilla[1] -> s[1]", "s[0:1] -> decode_syndrome rounds=1", "s[0:1] -> pauli_frame_update X data[0:2]"],
  parity: ["measure basis=Z data[0] -> c[0]", "measure basis=Z data[1] -> c[1]", "c[0:1] -> parity -> p[0]"],
};
const ABOUT = {
  H: { sig: "H q · S q · Sdg q · X q · Z q", what: "A one-qubit Clifford gate on a physical qubit.", state: "the qubit's next statement waits for it (qubit order)", lower: "transmon: a drive pulse (Z rotations are free: they shift the phase of later pulses); ions: a Raman or single-ion laser pulse in a gate zone; atoms: a Raman pulse" },
  CNOT: { sig: "CNOT q, q′ · CZ q, q′ · CY q, q′", what: "A two-qubit Clifford gate; a Pauli may tag an operand (CZ q, Z q′). The two qubits must be able to interact: a coupler, a shared gate zone, or atoms brought together by route.", state: "both qubits' next statements wait for it", lower: "transmon: CNOT = H(t)·CZ·H(t), CZ a flux pulse on the coupler; CY = S†·CNOT·S; ions: a Mølmer–Sørensen gate; atoms: a Rydberg pulse" },
  measure: { sig: "measure basis=Z|X q -> r[i]", what: "Measures a physical qubit and writes the outcome to a classical record. basis=X adds an H before a Z measurement.", state: "the record r[i] becomes written; its readers may start", lower: "transmon: a readout tone and a demodulation window; the bit is stored in the core's memory and published through the board hub; ions and atoms: fluorescence imaging" },
  request_ancilla: { sig: "request_ancilla count=N a[i:j]", what: "Asks the OS for N fresh qubits in |0⟩, named a[i..j]. The names are new (single assignment): a released name is never requested again.", state: "N qubits of the pool are held until their release; the named qubits are prepared", lower: "transmon: a reset pulse on every requested transmon, in parallel; ions: re-cooling and optical pumping; atoms: optical pumping, or atoms reloaded from a reservoir" },
  release_ancilla: { sig: "release_ancilla count=N a[i:j]", what: "Returns qubits to the pool. Takes no time.", state: "the pool gains N qubits; the names are retired", lower: "nothing is played: the site is free for the next name placed on it" },
  route: { sig: "route q₁, …, qₙ", what: "Brings qubits together so that two-qubit gates among them are possible. A program's two-qubit gate needs a completed route.", state: "the qubits' next statements wait for it", lower: "transmon: nothing (a coupler joins every pair the program gates); ions: electrode-voltage shuttles; atoms: AOD tweezer moves" },
  decode_syndrome: { sig: "r[i:j] -> decode_syndrome rounds=R input_ns=D", what: "Decodes the syndrome in the records r[i..j] on a decoder unit. The corrections it finds are applied through the Pauli frame.", state: "the records become decoded; their consumers (frame updates) may start", lower: "a decoder core reads the bits from the hub and runs a decoder compiled for RISC-Q: a lookup table for a few bits, Helios union-find for a surface code" },
  request_magic: { sig: "request_magic state=|T> q with w[i:j]", what: "Asks a magic-state factory for a state on the output qubits q; w are its workspace qubits.", state: "the output qubits hold the state; the factory is held for its whole latency", lower: "the factory's own circuit (injection, cultivation or distillation) on its qubits, and the factory's decode" },
  pauli_frame_update: { sig: "r[i:j] -> pauli_frame_update P q, …", what: "Records a Pauli correction for the named qubits in the Pauli frame, as the decoded records say. No pulse is played: later measurement results are corrected in software.", state: "the frame words of the named qubits change", lower: "the frame core flips the X or Z bit of each named qubit's frame word, at the statement's time" },
  parity: { sig: "r[i:j] -> parity -> p[k]", what: "The parity (XOR) of records, written to a new record.", state: "p[k] becomes written", lower: "the frame core XORs the records into the output record" },
};
const SERVICE_NAME = { gates: "gate slots", qubits: "qubits", ancillaRate: "ancilla bandwidth", classical: "classical bandwidth", routing: "routing bandwidth", decoders: "decoders", factories: "factories" };

export async function render(root, toc) {
  let D;
  try { D = await (await fetch("/lang/language.json")).json(); } catch (error) { root.innerHTML = `<p class="no">Could not load /lang/language.json: ${esc(error.message)}</p>`; return; }
  const sections = [];
  const h2 = (id, n, t) => { sections.push([id, n + " " + t, 2]); return `<h2 id="${id}"><span class="num">${n}</span>${t}</h2>`; };
  const h3 = (id, t) => { sections.push([id, t, 3]); return `<h3 id="${id}">${t}</h3>`; };
  const Q = D.qsysasm, H = D.hdl, R = D.riscq;
  const theorems = R.lean.filter((d) => d.kind === "theorem");

  let html = `<p class="kicker">The languages of QuantumOS</p><h1>Language</h1>
  <p class="lead">Three languages meet in QuantumOS. A program is written in <b>QSysASM</b>: physical instructions and system calls. The machine it
  runs on is written in the <b>hardware description language</b>, checked by its assertion rules. The control cores run <b>RISC-Q</b>: RV32I
  machine code whose loads and stores drive timed queues, converters and the board hub. This page defines each one the way a programming
  language is defined: its syntax, its well-formedness rules and its semantics, so that each can be stated in Lean.</p>
  <div class="stack">
    <div><b>QSysASM</b>the program: what to do to which qubits, and which shared services to ask for. <a href="#qsysasm">§ 1</a></div>
    <div><b>The OS</b>schedules it into a timetable, itself a QSysASM program. <a href="/schedule">Schedule</a></div>
    <div><b>RISC-Q</b>the timetable becomes RV32I firmware for every control core. <a href="#riscq">§ 3</a></div>
    <div><b>The HDL</b>the machine the firmware drives: boards, cores, converters, wires, qubits. <a href="#hdl">§ 2</a></div>
  </div>
  <p class="muted">Every grammar below is the one the code parses. Every assertion rule is shown with a design that breaks it, and the
  message the checker gives. The RISC-Q semantics is the Lean model's (<code>QControl/RiscQ</code>), with file and line. Generated
  ${esc(D.generated?.slice(0, 10))} by <code>riscq/language-study.mjs</code> (<a href="/lang/language.json">data</a>).</p>`;

  html += h2("judgments", "0", "Judgments");
  html += `<p>The rules on this page conclude one of five judgments:</p><div class="judg">
    <code>⊢ D ok</code><span>the hardware design D is well formed (§ 2, rules H1–H30)</span>
    <code>M ⊢ P wf</code><span>the QSysASM program P is well formed against the machine line M (§ 1.2)</span>
    <code>M ⊢ P ⇓ T</code><span>the OS schedules P into the timetable T: every statement gets a start (§ 1.3)</span>
    <code>D ⊢ T conforms</code><span>run on D, every statement of T finishes inside its window, as the trace shows</span>
    <code>⟨c, w⟩ → ⟨c′, w′⟩</code><span>one step of a RISC-Q core c in the world w of timed queues, hub and converters (§ 3.2, Lean)</span></div>`;

  // 1 ── QSysASM ──
  html += h2("qsysasm", "1", "QSysASM: physical instructions and system calls");
  html += `<p>A program is flat: one statement per operation, on concrete qubits and records, with an absolute start or none. There are no
  gadgets, no loops and no parameters. A repeated round is written out once per round. The parser is <code>riscq/ftqvm/qsysasm.mjs</code>.</p>`;
  html += h3("q-syntax", "1.1 Syntax");
  html += bnf(QSYSASM_BNF);
  html += `<p>The machine line declares the services. Every duration is an integer number of ns; every capacity is a count or a rate.</p>`;
  html += table(["Field", "Unit", "Meaning"], MACHINE_FIELDS.map(([f, u, m]) => [code(f), u, m]));
  html += h3("q-wf", "1.2 Well-formedness");
  html += `<p>A program is well formed when every statement parses and the rules below hold. Each rule says who enforces it.</p><div class="rules">
    ${rule("Q-Lit", ["every index in P is a literal"], "M ⊢ P wf")}
    ${rule("Q-Arity", ["op ∈ {CNOT, CZ, CY}", "|qs| = 2"], "M ⊢ op qs wf")}
    ${rule("Q-Count", ["|a[i:j]| = N"], "M ⊢ request_ancilla count=N a[i:j] wf")}
    ${rule("Q-Fresh", ["a ∉ requested(P before k)"], "M ⊢ request_ancilla … a … wf at k")}
    ${rule("Q-Held", ["a ∈ held(P before k)"], "M ⊢ release_ancilla … a … wf at k")}
    ${rule("Q-Read", ["r ∈ written(P before k)"], "M ⊢ (r -> stmt) wf at k")}
    ${rule("Q-Field", ["kind(s) ∈ dom(DURATION)", "DURATION(kind(s)) ∈ dom(M)"], "M ⊢ s wf")}
    ${rule("Q-Done", ["held(P) = ∅", "undecoded(P) = ∅"], "M ⊢ P complete")}</div>`;
  html += table(["Rule", "Enforced by"], [
    ["Q-Lit, Q-Arity, Q-Count, and the grammar itself", "the parser, before anything runs " + '<span class="tag js">JS</span>'],
    ["Q-Fresh, Q-Held, Q-Read, Q-Done", "the resource VM, which admits or refuses a timetable and names the rule it breaks " + '<span class="tag js">VM</span>'],
    ["Q-Field", "the machine line: every kind is charged one field (the table in § 1.4)"],
  ]);
  html += `<p>What the parser refuses, with its message:</p>` + table(["Text", "Refused because"], Q.refusals.map((r) => [{ cls: "f", html: esc(r.text) }, { cls: "msg", html: esc(r.error) }]));
  html += h3("q-sem", "1.3 Semantics");
  html += `<p>A program runs on a state σ = ⟨t, run, held, W, K, U⟩: the time; the statements running; the ancillas held; the records
  written (W) and decoded (K); and the use U<sub>r</sub> of every service r. A statement s has a duration p(s) = M[DURATION(kind s)] and a
  demand d(s, r) on each service, with rates reserved as r(N, D) = ⌈1000·N / D⌉ per µs. It is <b>ready</b> when its predecessors are done:</p>
  <div class="rules">
    ${rule("Pred-Qubit", ["j < k", "qubits(j) ∩ qubits(k) ≠ ∅", "j the last such"], "j ≺ k")}
    ${rule("Pred-Record", ["r ∈ reads(k)", "j the last writer of r before k"], "j ≺ k")}
    ${rule("Pred-Decoded", ["r ∈ reads(k)", "kind k ≠ decode_syndrome", "j the last decode reading r"], "j ≺ k")}
  </div><div class="rules">
    ${rule("Start", ["∀ j ≺ k. j done", "∀ r. U_r + d(k, r) ≤ M_r", "(@t_k ≤ t)"], "σ → σ[run += k, U += d(k), start(k) = t]")}
    ${rule("Finish", ["k ∈ run", "t = start(k) + p(k)"], "σ → σ[run −= k, U −= d(k), W ∪= writes(k), K ∪= decoded(k)]")}
    ${rule("Hold", ["kind k = request_ancilla"], "U_qubits keeps count(k) until the release of its names")}
  </div>
  <p>Among the statements that may start at the same moment, the OS's <b>policy</b> chooses the order: program order, first ready, or
  listed time; with or without backfill. That choice, and why it is hard, is the subject of <a href="/schedule#problem">Schedule and
  Compilation</a>. A timetable T assigns every statement its start. The resource VM's admission is this semantics with every start
  fixed by T (<code>@t</code>): no rule may fail.</p>`;
  html += h3("q-stmts", "1.4 Statements");
  html += `<div class="stmts">${Q.statements.map((s) => `<a href="#s-${s.kind}">${esc(s.kind)}</a>`).join("")}</div>`;
  for (const s of Q.statements) {
    const a = ABOUT[s.kind];
    if (!a) continue;
    const services = s.services.length ? s.services.map((x) => { const [p, n] = x.split(" "); return esc(SERVICE_NAME[p] ?? p) + " " + esc(n); }).join(", ") : "none";
    html += `<section class="card"><h3 id="s-${s.kind}">${esc(a.sig)}</h3>
      <div><p style="margin:0 0 6px">${esc(a.what)}</p><dl>
        <dt>State</dt><dd>${esc(a.state)}</dd>
        <dt>Holds</dt><dd>${services} <span class="muted">(${code(Q.statements.find((x) => x.kind === s.kind).text)} on the example machine)</span></dd>
        <dt>Latency</dt><dd>${s.field ? code(s.field) : "0"}</dd>
        <dt>Rules</dt><dd>${esc({ request_ancilla: "Q-Count, Q-Fresh, Hold", release_ancilla: "Q-Held", decode_syndrome: "Q-Read, Pred-Record", pauli_frame_update: "Q-Read, Pred-Decoded", parity: "Q-Read", CNOT: "Q-Arity, Pred-Qubit", measure: "Pred-Qubit; writes its record" }[s.kind] ?? "Pred-Qubit")}</dd>
        <dt>Lowering</dt><dd>${esc(a.lower)}</dd></dl></div>
      <div class="live" data-kind="${s.kind}"></div></section>`;
  }

  // 2 ── HDL ──
  html += h2("hdl", "2", "The hardware description language");
  html += `<p>A machine is a document: the parts with their positions in mm, the channels of the control cores, the wires with their routed
  paths, the calibrated pulses of every qubit and coupler. Nothing in it names a platform. <code>riscq/design.mjs</code> checks it and
  derives the RISC-Q build from it. The <a href="/riscq-design">design editor</a> writes it.</p>`;
  html += h3("h-syntax", "2.1 Syntax");
  html += bnf(HDL_BNF);
  html += `<p>Units: lengths mm, times ns, frequencies Hz, amplitudes a fraction of the DAC's full scale, phases rad. A qubit is addressed in
  programs by its index in <code>qubits</code>. The reference design used below is <i>${esc(H.reference.name)}</i>: ${H.reference.parts} parts,
  ${H.reference.cores} cores, ${H.reference.qubits} qubits, ${H.reference.channels} channels, ${H.reference.wires} wires, ${H.reference.couplings} couplings.</p>`;
  html += `<details class="block"><summary>One part, channel, wire, qubit and coupling of the reference design</summary><pre class="bnf">${esc(JSON.stringify(H.reference.sample, null, 1))}</pre></details>`;
  html += table(["Part type", "What it is"], Object.entries(H.components).map(([k, v]) => [code(k), esc(v)]));
  html += table(["Medium", "Signal speed (mm/ns)"], Object.entries(H.media).map(([k, v]) => [code(k), num(v)]));
  html += h3("h-timing", "2.2 Derived quantities");
  html += `<div class="rules">${rule("Delay", ["w ∈ D.wires", "L = Σ ‖routeMm[i+1] − routeMm[i]‖", "v = speed(w.medium)"], "delay(w) = ⌈L / v⌉ ps")}
    ${rule("Path", ["path w₁ … wₙ from a to b through stages"], "delay(a, b) = Σ delay(wᵢ)")}
    ${rule("Build", ["⊢ D ok"], "machine(D) = cores, channels, pulse tables, bindings with delays")}</div>
  <p>A longer or more winding route is a later arrival. Loss, dispersion and crosstalk are not modeled. Board limits (one ZCU216):
  ${Object.entries(H.zcu216).map(([k, v]) => esc(k) + " " + num(v)).join(", ")}.</p>`;
  html += h3("h-rules", "2.3 Assertion rules");
  html += `<p><code>⊢ D ok</code> holds when no rule below fails. Each rule is shown with the reference design changed in one place, and the
  message <code>check()</code> reports for it. The reference design itself passes every rule. A failed rule stops the design from running;
  a warning (W) describes a consequence the designer should see.</p>`;
  html += table(["Rule", "Statement", "Broken by", "The checker says"], [...H.rules, ...H.warnings].map((r) => [`<b>${esc(r.id)}</b><br><span class="muted">${esc(r.name)}</span>`, { cls: "f", html: esc(r.formal) }, esc(r.break), { cls: "msg", html: esc(r.message) + (r.others ? ` <span class="muted">(+${r.others} more)</span>` : "") }]), "scroll");

  // 3 ── RISC-Q ──
  html += h2("riscq", "3", "RISC-Q: the control instruction set");
  html += `<p>Every control core is an RV32I processor with the Zmmul multiplier. It controls the machine only through loads and stores: to
  its timer, to the registers of its channels (whose writes enter timed queues), to the board hub, and to the host. The Lean model
  (<code>QControl/RiscQ/Rv32.lean</code>, <code>Soc.lean</code>, <code>Timing.lean</code>, <code>Pipe.lean</code>) executes the firmware
  instruction by instruction and is checked against RISC-Q's RTL cycle for cycle.</p>`;
  html += h3("r-syntax", "3.1 Syntax");
  html += bnf(RISCQ_BNF);
  html += `<p>Each row below is assembled by <code>riscq/rv32.mjs</code> and decoded back by the Lean decoder (<code>decode</code> in
  <code>Rv32.lean</code>, mirrored for the browser by <code>riscq-disasm.js</code>).</p>`;
  html += table(["Format", "Instructions", "Lean constructor", "Example word", "Decodes to"], R.isa.map((i) => [i.format, esc(i.mnemonics), code(i.lean), code(i.word), code(i.text)]));
  html += `<div class="decoder"><label>Decode a word: <input id="word" value="0074a023" spellcheck="false" aria-label="A 32-bit word in hex"></label> <output id="decoded"></output></div>`;
  html += h3("r-sem", "3.2 Semantics");
  html += `<p>A core's state is <code>Cpu = ⟨pc, x₀…x₃₁⟩</code> with x₀ always 0. One step decodes the word at pc and executes it
  (<code>exec : Cpu → Instr → Step</code>). A step that touches memory returns an access, and the SoC (<code>Soc.lean</code>) resolves it:
  RAM, or a device register at that address.</p><div class="rules">
    ${rule("Op", ["decode M[pc] = op o rd rs1 rs2"], "⟨pc, x⟩ → ⟨pc+4, x[rd ↦ alu o x(rs1) x(rs2)]⟩")}
    ${rule("Branch", ["decode M[pc] = branch o rs1 rs2 off", "taken o x(rs1) x(rs2)"], "⟨pc, x⟩ → ⟨pc+off, x⟩")}
    ${rule("Zero", [], "reg c 0 = 0     (Cpu.reg_zero)")}
    ${rule("Store-RAM", ["a ≥ 0x80000000", "store sw a v"], "M′ = M[a ↦ v]; read a = v     (readRam_writeRam_word)")}
    ${rule("Wait", ["load WAIT", "TIME < TIME_CMP"], "the core stalls; it reads when TIME = TIME_CMP")}
    ${rule("Post", ["store to channel ch, register r, at batch b"], "the write enters ch's timed queue; it lands no sooner than 3 cycles later     (popCycle_ge_push)")}
    ${rule("Fire", ["store fire s", "start_time = T"], "slot s plays at T; the next fire plays at T + dur     (fire_captures_start, fire_fire_contiguous)")}
    ${rule("Publish", ["store to hub inbox node k"], "every core of the board reads it in its board inbox; the arbiter grants one put per cycle     (nextSource_isSome)")}
  </div>`;
  html += h3("r-map", "3.3 The memory map");
  html += `<p>Every device is an address. The firmware the OS generates uses <code>s0</code> for the segment's time base, <code>s1</code> for
  the timer block, <code>s2</code> for the bit table (<a href="/schedule#firmware">annotated firmware</a>).</p>`;
  html += table(["Address", "Register", "Meaning"], R.map.map(([a, n, m]) => [code(a), esc(n), esc(m)]));
  html += h3("r-proved", "3.4 What is proved");
  html += `<p>The Lean model states ${R.lean.length} definitions; ${theorems.length} theorems are proved about it:</p>`;
  html += table(["Theorem", "Where", "It says"], theorems.map((t) => [code(t.name), code(t.file.split("/").pop() + ":" + t.line), esc(t.doc || t.statement)]), "scroll");
  html += `<details class="block"><summary>Every definition of the RISC-Q model (${R.lean.length})</summary>${table(["Kind", "Name", "Where", "Doc"], R.lean.map((d) => [esc(d.kind), code(d.name), code(d.file.split("/").pop() + ":" + d.line), esc(d.doc)]), "scroll")}</details>`;

  // 4 ── Toward Lean ──
  html += h2("lean", "4", "Toward Lean");
  html += `<p>Where each piece is defined today, and what its Lean statement will be.</p>`;
  html += table(["Piece", "Defined in", "Lean"], [
    ["RISC-Q syntax and decoding", code("Rv32.lean") + " <code>Instr</code>, <code>decode</code>", '<span class="tag lean">in Lean</span>'],
    ["RISC-Q core step", code("Rv32.lean") + " <code>exec</code>", '<span class="tag lean">in Lean</span> ' + theorems.filter((t) => t.file.endsWith("Rv32.lean")).length + " theorems"],
    ["Timed queues, converters, hub, barriers", code("Soc.lean") + ", " + code("Timing.lean") + ", " + code("Pipe.lean"), '<span class="tag lean">in Lean</span> ' + theorems.filter((t) => !t.file.endsWith("Rv32.lean")).length + " theorems"],
    ["QSysASM syntax (§ 1.1)", code("riscq/ftqvm/qsysasm.mjs") + " parse, format", '<span class="tag todo">to state</span> an inductive <code>Stmt</code>; the printer and parser as inverse functions (checked on 13,000 operations today)'],
    ["QSysASM well-formedness (§ 1.2)", "the parser and the resource VM", '<span class="tag todo">to state</span> <code>M ⊢ P wf</code> as an inductive predicate, decidable'],
    ["QSysASM semantics and scheduling (§ 1.3)", code("riscq/os/schedule.mjs") + ", " + code("riscq/os/des.mjs"), '<span class="tag todo">to state</span> the Start / Finish relation; a timetable is admitted iff every Start premise holds at its time'],
    ["HDL syntax and assertion rules (§ 2)", code("riscq/design.mjs") + " check", '<span class="tag todo">to state</span> <code>⊢ D ok</code>; each of H1–H30 a conjunct, each counterexample above a test'],
    ["Lowering and conformance", code("riscq/ftqvm/sc-run.mjs"), '<span class="tag todo">to state</span> <code>D ⊢ T conforms</code> over the trace of the Lean SoC'],
  ]);

  root.innerHTML = html;
  toc.innerHTML = sections.map(([id, t, l]) => `<li><a href="#${id}" style="${l === 3 ? "padding-left:20px;font-size:12.5px" : ""}">${esc(t)}</a></li>`).join("");
  const links = [...toc.querySelectorAll("a")];
  const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id)); }, { rootMargin: "0px 0px -70% 0px" });
  sections.forEach(([id]) => io.observe(document.getElementById(id)));

  // Live examples: each statement in a small program, parsed and scheduled by the OS's code, its timeline played.
  for (const box of root.querySelectorAll(".live")) liveExample(box, Q.machineLine, CONTEXT[box.dataset.kind] ?? []);
  // The decoder box.
  try {
    const { decode } = await import("/riscq-disasm.js");
    const input = root.querySelector("#word"), out = root.querySelector("#decoded");
    const show = () => { const w = parseInt(input.value.replace(/^0x/i, ""), 16); out.textContent = Number.isFinite(w) && /^[0-9a-f]{1,8}$/i.test(input.value.replace(/^0x/i, "")) ? decode(w).text + "   (" + decode(w).kind + ")" : "a 32-bit word in hex, e.g. 0074a023"; };
    input.addEventListener("input", show); show();
  } catch { /* the table above still shows the decoding */ }
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

function liveExample(box, machineLine, lines) {
  const text = [machineLine, ...lines].join("\n");
  let s, err = null;
  try { s = schedule(qsysasm.parse(text), { policy: "order" }); } catch (e) { err = e.message; }
  if (err || !s.text) {
    box.innerHTML = `<pre>${esc(lines.join("\n"))}</pre><p class="verdict no">✗ ${esc(err ?? "the program cannot be scheduled")}</p>`;
    return;
  }
  const ops = s.ops, sim = s.sim.ops, end = Math.max(1, s.makespanNs);
  const W = 360, lab = 18, rowH = 15, h = ops.length * rowH + 18, x = (v) => lab + (v / end) * (W - lab - 6);
  box.innerHTML = `<pre>${esc(lines.join("\n"))}</pre><p class="verdict ok">✓ parses, well formed, scheduled by the OS: ${esc(tns(s.makespanNs))}</p>
    <svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Timeline"></svg>
    <div class="bar"><button type="button">Play</button><input type="range" min="0" max="${end}" value="${end}"><span class="t"></span></div>`;
  const svg = box.querySelector("svg"), range = box.querySelector("input"), label = box.querySelector(".t");
  const draw = (t) => {
    let g = "";
    sim.forEach((o, i) => {
      const y = i * rowH + 2;
      g += `<text x="${lab - 4}" y="${y + 10}" text-anchor="end">${i + 1}</text>`;
      if (o.start !== null && o.start <= t) g += `<rect x="${x(o.start)}" y="${y}" width="${Math.max(2, x(Math.min(o.end, t)) - x(o.start))}" height="${rowH - 4}" rx="2" fill="${KIND_COLOR(ops[i].kind)}"><title>${esc(strip(ops[i].text))}: ${o.start}–${o.end} ns</title></rect>`;
    });
    g += `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${h - 14}" stroke="#111827"/><text x="${W - 4}" y="${h - 3}" text-anchor="end">${tns(end)}</text><text x="${lab}" y="${h - 3}">0</text>`;
    svg.innerHTML = g;
    label.textContent = tns(t);
    range.value = String(t);
  };
  let timer = null;
  box.querySelector("button").addEventListener("click", (e) => {
    if (timer) { cancelAnimationFrame(timer); timer = null; e.target.textContent = "Play"; return; }
    e.target.textContent = "Pause";
    const t0 = performance.now();
    const step = (now) => { const t = Math.min(end, ((now - t0) / 2500) * end); draw(Math.round(t)); if (t < end) timer = requestAnimationFrame(step); else { timer = null; e.target.textContent = "Play"; } };
    timer = requestAnimationFrame(step);
  });
  range.addEventListener("input", () => draw(Number(range.value)));
  draw(end);
}
