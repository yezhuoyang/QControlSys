// Small logical programs, written as flat QSysASM for the operating system to schedule.
//
// Every program here is a logical circuit on rotated surface-code blocks of distance 3, written out
// at the physical level, statement by statement, with no times: the operating system
// (riscq/os/schedule.mjs) decides when each statement runs, and the result is compiled to RISC-Q
// firmware and run on a hardware design in the cycle-exact model (riscq/os/program-runs.mjs).
//
// A block a holds data[9a .. 9a+8] on a 3 × 3 grid (data j at row ⌊j/3⌋, column j mod 3). Each
// syndrome round measures the block's 8 stabilizers (4 X, 4 Z, rotated layout: weight-4 faces inside,
// weight-2 faces on the boundary) through 8 ancillas it requests and releases. An X stabilizer is
// H · CNOT(ancilla → data)… · H on its ancilla, a Z stabilizer CNOT(data → ancilla)…; each is preceded
// by a route of its ancilla and data. The rounds' bits are decoded (decode_syndrome) and the
// correction applied to the Pauli frame (pauli_frame_update). A logical operation is transversal
// (CNOT data[9a+j] → data[9b+j] for every j, after a route of each pair), a logical readout measures
// every data qubit of a block and decodes the result. A magic state arrives by request_magic.
//
// What the programs do not claim: no quantum state is simulated; outcomes are inputs, and the
// programs are the logical circuits' physical operations and system calls in a valid order.

export const D = 3, N = D * D;

/** The 8 stabilizers of the rotated d = 3 surface code: { type: "X" | "Z", data: [j…] } (block-local). */
export const STABILIZERS = (() => {
  const at = (r, c) => (r >= 0 && r < D && c >= 0 && c < D ? r * D + c : null);
  const out = [];
  for (let r = -1; r < D; r++) for (let c = -1; c < D; c++) {
    const data = [at(r, c), at(r, c + 1), at(r + 1, c), at(r + 1, c + 1)].filter((x) => x !== null);
    const type = (r + c) % 2 === 0 ? "X" : "Z";
    const inside = r >= 0 && r < D - 1 && c >= 0 && c < D - 1;
    // Boundary faces: X on the top and bottom edges, Z on the left and right, every other one.
    const top = r === -1 && c >= 0 && c < D - 1 && type === "X", bottom = r === D - 1 && c >= 0 && c < D - 1 && type === "X";
    const left = c === -1 && r >= 0 && r < D - 1 && type === "Z", right = c === D - 1 && r >= 0 && r < D - 1 && type === "Z";
    if (data.length === 4 && inside || data.length === 2 && (top || bottom || left || right)) out.push({ type, data });
  }
  return out;
})();

/** A program under construction: statements as text, records numbered per register. */
class Program {
  constructor(title) { this.title = title; this.lines = []; this.counts = {}; }
  comment(text) { this.lines.push("# " + text); return this; }
  op(text) { this.lines.push(text); return this; }
  records(register, n) {
    const first = this.counts[register] ?? 0;
    this.counts[register] = first + n;
    return { register, first, last: first + n - 1, text: register + "[" + first + (n > 1 ? ":" + (first + n - 1) : "") + "]" };
  }
  /** One syndrome round of block a: 8 ancillas (ancilla[8a .. 8a+7]), every stabilizer. Returns its records. */
  round(a) {
    const anc = (i) => "ancilla[" + (8 * a + i) + "]", dat = (j) => "data[" + (N * a + j) + "]";
    this.op("request_ancilla  count=8  ancilla[" + 8 * a + ":" + (8 * a + 7) + "]");
    STABILIZERS.forEach((s, i) => {
      this.op("route  " + anc(i) + ", " + s.data.map(dat).join(", "));
      if (s.type === "X") {
        this.op("H  " + anc(i));
        for (const j of s.data) this.op("CNOT  " + anc(i) + ", " + dat(j));
        this.op("H  " + anc(i));
      } else for (const j of s.data) this.op("CNOT  " + dat(j) + ", " + anc(i));
    });
    const s = this.records("s", 8);
    STABILIZERS.forEach((_, i) => this.op("measure  basis=Z  " + anc(i) + " -> s[" + (s.first + i) + "]"));
    this.op("release_ancilla  count=8  ancilla[" + 8 * a + ":" + (8 * a + 7) + "]");
    return s;
  }
  /**
   * Decode the given rounds' records into one correction bit and apply it to block a's frame: the
   * frame update reads the decoder's result, not the raw syndrome (16 raw bits in a frame update's
   * few ns would ask more classical bandwidth than a board has).
   */
  decode(a, rounds, pauli = "X") {
    const regs = rounds.map((r) => r.text).join(", ");
    const c = this.records("c", 1);
    this.op(regs + " -> decode_syndrome  rounds=" + rounds.length + " -> " + c.text);
    this.op(c.text + " -> pauli_frame_update  " + pauli + " data[" + N * a + ":" + (N * a + N - 1) + "]");
    return this;
  }
  /** Prepare block a in |0⟩_L (reset is implicit at allocation) or |+⟩_L (H on every data qubit). */
  prepare(a, state = "0") {
    if (state === "+") for (let j = 0; j < N; j++) this.op("H  data[" + (N * a + j) + "]");
    return this;
  }
  /** Transversal CNOT from block a to block b. */
  cnot(a, b) {
    for (let j = 0; j < N; j++) {
      this.op("route  data[" + (N * a + j) + "], data[" + (N * b + j) + "]");
      this.op("CNOT  data[" + (N * a + j) + "], data[" + (N * b + j) + "]");
    }
    return this;
  }
  /**
   * A magic state |T⟩ from the factory, as the compiler writes the call: N ancillas requested for
   * the output block (ancilla[at .. at+N-1]), request_magic into them with the factory's workspace
   * (the next 8 ancillas, the output patch's measure sites), the workspace released. Returns the
   * output block's qubit names, for cnot and readout.
   */
  magic(at) {
    const out = (j) => "ancilla[" + (at + j) + "]", ws = "ancilla[" + (at + N) + ":" + (at + N + 7) + "]";
    this.op("request_ancilla  count=" + N + "  ancilla[" + at + ":" + (at + N - 1) + "]");
    this.op("request_magic  state=|T>  ancilla[" + at + ":" + (at + N - 1) + "]  with  " + ws);
    this.op("release_ancilla  count=8  " + ws);
    return { name: out, text: "ancilla[" + at + ":" + (at + N - 1) + "]" };
  }
  /** Transversal CNOT from block a into a block given by its qubit names (a magic block). */
  cnotInto(a, block) {
    for (let j = 0; j < N; j++) {
      this.op("route  data[" + (N * a + j) + "], " + block.name(j));
      this.op("CNOT  data[" + (N * a + j) + "], " + block.name(j));
    }
    return this;
  }
  /** Read block a out in a basis: every data qubit measured, the result decoded. Returns its records. */
  readout(a, basis = "Z", block = { name: (j) => "data[" + (N * a + j) + "]" }) {
    if (basis === "X") for (let j = 0; j < N; j++) this.op("H  " + block.name(j));
    const m = this.records("m", N);
    for (let j = 0; j < N; j++) this.op("measure  basis=Z  " + block.name(j) + " -> m[" + (m.first + j) + "]");
    // The logical outcome: the readout decoded into one bit.
    const l = this.records("l", 1);
    this.op(m.text + " -> decode_syndrome  rounds=1 -> " + l.text);
    return l;
  }
  text(machine) {
    return ["# " + this.title, machineText(machine), ...this.lines].join("\n") + "\n";
  }
}

/** The machine line of a program: what the operating system is first told (provisional). */
export function machineText(m) {
  return "machine { " + Object.entries(m).map(([k, v]) => k + ": " + v + (/_ns$/.test(k) ? " ns" : /bandwidth$/.test(k) ? (k === "classical_data_bandwidth" ? " bits/us" : " qubits/us") : " total")).join(", ") + " }";
}

/** The programs: { id, title, blocks, summary, build(): Program }. */
export const PROGRAMS = [
  { id: "memory", title: "One logical qubit, two syndrome rounds", blocks: 1,
    summary: "A distance-3 surface-code block holds |0⟩ for two rounds of all eight stabilizers; the syndromes are decoded, the correction goes to the Pauli frame, and the block is read out.",
    build() { const p = new Program(this.title); const r1 = p.round(0), r2 = p.round(0); p.decode(0, [r1, r2]); p.readout(0); return p; } },
  { id: "bell", title: "Logical Bell pair", blocks: 2,
    summary: "Block 0 in |+⟩_L, block 1 in |0⟩_L, a round on each, a transversal CNOT, a round on each, then both read out in Z: the two logical outcomes agree.",
    build() { const p = new Program(this.title); p.prepare(0, "+").prepare(1, "0"); const a = p.round(0), b = p.round(1); p.cnot(0, 1); const a2 = p.round(0), b2 = p.round(1);
      p.decode(0, [a, a2], "Z").decode(1, [b, b2]); p.readout(0); p.readout(1); return p; } },
  { id: "ghz3", title: "Logical GHZ state of three blocks", blocks: 3,
    summary: "Block 0 in |+⟩_L, two transversal CNOTs to blocks 1 and 2, a round on each block between and after, then all three read out in Z.",
    build() { const p = new Program(this.title); p.prepare(0, "+").prepare(1, "0").prepare(2, "0"); const r = [0, 1, 2].map((a) => p.round(a));
      p.cnot(0, 1).cnot(1, 2); const s = [0, 1, 2].map((a) => p.round(a)); [0, 1, 2].forEach((a) => p.decode(a, [r[a], s[a]])); [0, 1, 2].forEach((a) => p.readout(a)); return p; } },
  { id: "teleport", title: "Logical teleportation", blocks: 3,
    summary: "A Bell pair between blocks 1 and 2, a transversal CNOT from block 0 into block 1, block 0 read out in X and block 1 in Z, and the two outcomes corrected on block 2 through the Pauli frame.",
    build() { const p = new Program(this.title); p.prepare(1, "+").prepare(2, "0"); const b1 = p.round(1), b2 = p.round(2); p.cnot(1, 2); const a0 = p.round(0);
      p.cnot(0, 1); const c1 = p.round(1); p.decode(1, [b1, c1]); p.decode(2, [b2]); p.decode(0, [a0], "Z");
      const mx = p.readout(0, "X"), mz = p.readout(1, "Z");
      p.op(mx.text + " -> pauli_frame_update  Z data[18:26]"); p.op(mz.text + " -> pauli_frame_update  X data[18:26]"); return p; } },
  { id: "cnot", title: "Logical CNOT between two logical qubits", blocks: 2,
    summary: "Two blocks prepared in |+⟩_L and |0⟩_L, a round on each, a transversal CNOT, a round on each, then block 0 read out in X and block 1 in Z.",
    build() { const p = new Program(this.title); p.prepare(0, "+").prepare(1, "0"); const a = p.round(0), b = p.round(1); p.cnot(0, 1); const a2 = p.round(0), b2 = p.round(1);
      p.decode(0, [a, a2], "Z").decode(1, [b, b2]); p.readout(0, "X"); p.readout(1, "Z"); return p; } },
  { id: "t-injection", title: "A T gate by magic-state injection", blocks: 2,
    summary: "A magic state |T⟩ requested from the factory into an ancilla block, a transversal CNOT from the data block into it, the magic block read out and released, and the outcome applied to the data block's frame.",
    build() { const p = new Program(this.title); const a = p.round(0); const t = p.magic(16);
      p.cnotInto(0, t); const b = p.round(0); p.decode(0, [a, b]); const m = p.readout(null, "Z", t);
      p.op("release_ancilla  count=" + N + "  " + t.text);
      p.op(m.text + " -> pauli_frame_update  Z data[0:8]"); p.readout(0); return p; } },
  { id: "two-memories", title: "Two logical qubits held side by side", blocks: 2,
    summary: "Two independent blocks, each through two syndrome rounds, decoded and read out: the operating system interleaves them on shared services.",
    build() { const p = new Program(this.title); const r = [0, 1].map((a) => [p.round(a), p.round(a)]); [0, 1].forEach((a) => p.decode(a, r[a])); [0, 1].forEach((a) => p.readout(a)); return p; } },
  { id: "swap", title: "Logical SWAP from three transversal CNOTs", blocks: 2,
    summary: "Block 0 in |+⟩_L and block 1 in |0⟩_L exchanged by CNOT 0→1, 1→0, 0→1, with a syndrome round on each block before and after; block 0 read out in Z and block 1 in X.",
    build() { const p = new Program(this.title); p.prepare(0, "+"); const a = p.round(0), b = p.round(1);
      p.cnot(0, 1).cnot(1, 0).cnot(0, 1); const a2 = p.round(0), b2 = p.round(1);
      p.decode(0, [a, a2]).decode(1, [b, b2], "Z"); p.readout(0, "Z"); p.readout(1, "X"); return p; } },
  { id: "parity", title: "A logical Z⊗Z parity check through a third block", blocks: 3,
    summary: "Blocks 0 and 1 in |+⟩_L, block 2 in |0⟩_L; transversal CNOTs from each into block 2 copy their Z⊗Z parity onto it, block 2 is read out, and its outcome is applied to block 1's frame.",
    build() { const p = new Program(this.title); p.prepare(0, "+").prepare(1, "+"); const r = [0, 1, 2].map((a) => p.round(a));
      p.cnot(0, 2).cnot(1, 2); const r2 = [0, 1, 2].map((a) => p.round(a)); [0, 1, 2].forEach((a) => p.decode(a, [r[a], r2[a]]));
      const z = p.readout(2, "Z"); p.op(z.text + " -> pauli_frame_update  X data[9:17]"); p.readout(0, "X"); p.readout(1, "X"); return p; } },
  { id: "four-memories", title: "Four logical qubits sharing one decoder", blocks: 4,
    summary: "Four independent blocks, two syndrome rounds each, decoded and read out: every decode queues for the machine's decoders and every round for its ancillas.",
    build() { const p = new Program(this.title); const blocks = [0, 1, 2, 3]; const r = blocks.map((a) => [p.round(a), p.round(a)]);
      blocks.forEach((a) => p.decode(a, r[a])); blocks.forEach((a) => p.readout(a)); return p; } },
  { id: "two-t", title: "Two T gates competing for one factory", blocks: 3,
    summary: "Two magic states requested back to back for two data blocks; with one factory the second request waits for the first. Each is consumed by a transversal CNOT, read out, and applied to its block's frame.",
    build() { const p = new Program(this.title); const r = [0, 1].map((a) => p.round(a)); const t = [p.magic(32), p.magic(49)];
      [0, 1].forEach((a) => p.cnotInto(a, t[a])); const r2 = [0, 1].map((a) => p.round(a)); [0, 1].forEach((a) => p.decode(a, [r[a], r2[a]]));
      [0, 1].forEach((a) => { const m = p.readout(null, "Z", t[a]); p.op("release_ancilla  count=" + N + "  " + t[a].text); p.op(m.text + " -> pauli_frame_update  Z data[" + N * a + ":" + (N * a + N - 1) + "]"); });
      [0, 1].forEach((a) => p.readout(a)); return p; } },
];

/** A provisional machine line for a program on a platform: typical figures the OS is first told. */
export function provisionalMachine(program, platform) {
  const sites = program.blocks * (N + 8) + 8;
  const base = { qubits: sites, decoders: 1, factories: 1, classical_data_bandwidth: 500, qubit_routing_bandwidth: 1000 * sites, ancilla_bandwidth: 1000 * sites, max_parallel_gates: sites };
  const lat = {
    superconducting: { gate1q_ns: 40, gate2q_ns: 200, measure_ns: 1000, reset_ns: 160, route_latency_ns: 2, decoder_latency_ns: 1000, magic_state_latency_ns: 10000, pauli_frame_update_ns: 30 },
    neutral: { gate1q_ns: 10000, gate2q_ns: 10000, measure_ns: 500000, reset_ns: 100000, route_latency_ns: 100000, decoder_latency_ns: 1000, magic_state_latency_ns: 1000000, pauli_frame_update_ns: 30 },
    qccd: { gate1q_ns: 10000, gate2q_ns: 30000, measure_ns: 120000, reset_ns: 10000, route_latency_ns: 500000, decoder_latency_ns: 1000, magic_state_latency_ns: 1000000, pauli_frame_update_ns: 30 },
  }[platform];
  return { ...base, ...lat };
}

/** The program's QSysASM text for a platform's provisional machine. */
export function programText(id, platform) {
  const p = PROGRAMS.find((x) => x.id === id);
  if (!p) throw Error("no program " + id);
  return p.build().text(provisionalMachine(p, platform));
}
