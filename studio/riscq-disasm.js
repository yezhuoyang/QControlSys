// RV32I + Zmmul disassembler for the firmware column of the RISC-Q workspace.
//
// It reproduces `QControl.RiscQ.decode` and `Instr.text` of QControl/RiscQ/Rv32.lean word for
// word, so that a firmware listing drawn in the browser reads the same as the `text` field Lean
// writes into core frames. tests/riscq-studio.test.mjs checks that agreement on every traced
// instruction of the reference runs. It is display code: nothing executes from it.

export const RAM_BASE = 0x80000000;

const bits = (w, lo, width) => (w >>> lo) & (width === 32 ? 0xffffffff : (1 << width) - 1);
/** Sign-extend the low `width` bits to a JavaScript integer. */
const sext = (v, width) => (v & (1 << (width - 1)) ? v - 2 ** width : v);
const immI = (w) => sext(bits(w, 20, 12), 12);
const immS = (w) => sext((bits(w, 25, 7) << 5) | bits(w, 7, 5), 12);
const immB = (w) => sext((bits(w, 31, 1) << 12) | (bits(w, 7, 1) << 11) | (bits(w, 25, 6) << 5) | (bits(w, 8, 4) << 1), 13);
const immJ = (w) => sext((bits(w, 31, 1) << 20) | (bits(w, 12, 8) << 12) | (bits(w, 20, 1) << 11) | (bits(w, 21, 10) << 1), 21);
// Lean prints `Nat.toDigits 16`, lower case and unpadded.
const hex = (v) => "0x" + (v >>> 0).toString(16);
const x = (r) => "x" + r;

/**
 * Decode one word: { op, text, kind, target? }. `kind` is "branch", "jump", "load", "store",
 * "alu", "system" or "illegal". `target` is the byte offset of a direct branch or jump.
 */
export function decode(word, withMul = true) {
  const w = word >>> 0;
  const rd = bits(w, 7, 5), rs1 = bits(w, 15, 5), rs2 = bits(w, 20, 5), f3 = bits(w, 12, 3), f7 = bits(w, 25, 7);
  const illegal = { op: "illegal", kind: "illegal", text: ".word " + hex(w) };
  switch (bits(w, 0, 7)) {
    case 0x37: return { op: "lui", kind: "alu", text: "lui " + x(rd) + ", " + hex(w >>> 12) };
    case 0x17: return { op: "auipc", kind: "alu", text: "auipc " + x(rd) + ", " + hex(w >>> 12) };
    case 0x6f: return { op: "jal", kind: "jump", target: immJ(w), text: "jal " + x(rd) + ", " + immJ(w) };
    case 0x67: return f3 === 0 ? { op: "jalr", kind: "jump", text: "jalr " + x(rd) + ", " + immI(w) + "(" + x(rs1) + ")" } : illegal;
    case 0x63: {
      const name = { 0: "beq", 1: "bne", 4: "blt", 5: "bge", 6: "bltu", 7: "bgeu" }[f3];
      return name ? { op: name, kind: "branch", target: immB(w), text: name + " " + x(rs1) + ", " + x(rs2) + ", " + immB(w) } : illegal;
    }
    case 0x03: {
      const name = { 0: "lb", 1: "lh", 2: "lw", 4: "lbu", 5: "lhu" }[f3];
      return name ? { op: name, kind: "load", text: name + " " + x(rd) + ", " + immI(w) + "(" + x(rs1) + ")" } : illegal;
    }
    case 0x23: {
      const name = { 0: "sb", 1: "sh", 2: "sw" }[f3];
      return name ? { op: name, kind: "store", text: name + " " + x(rs2) + ", " + immS(w) + "(" + x(rs1) + ")" } : illegal;
    }
    case 0x13: {
      const imm = { 0: "addi", 2: "slti", 3: "sltiu", 4: "xori", 6: "ori", 7: "andi" }[f3];
      if (imm) return { op: imm, kind: "alu", text: imm + " " + x(rd) + ", " + x(rs1) + ", " + immI(w) };
      const shamt = bits(w, 20, 5);
      const name = f3 === 1 ? (f7 === 0 ? "slli" : null) : f3 === 5 ? (f7 === 0 ? "srli" : f7 === 0x20 ? "srai" : null) : null;
      return name ? { op: name, kind: "alu", text: name + " " + x(rd) + ", " + x(rs1) + ", " + shamt } : illegal;
    }
    case 0x33: {
      const name = f7 === 0 ? ["add", "sll", "slt", "sltu", "xor", "srl", "or", "and"][f3]
        : f7 === 0x20 ? { 0: "sub", 5: "sra" }[f3]
        : f7 === 1 && withMul ? { 0: "mul", 1: "mulh", 2: "mulhsu", 3: "mulhu" }[f3]
        : null;
      return name ? { op: name, kind: "alu", text: name + " " + x(rd) + ", " + x(rs1) + ", " + x(rs2) } : illegal;
    }
    case 0x0f: return { op: "fence", kind: "system", text: "fence" };
    case 0x73:
      return w === 0x73 ? { op: "ecall", kind: "system", text: "ecall" } : w === 0x00100073 ? { op: "ebreak", kind: "system", text: "ebreak" } : illegal;
    default: return illegal;
  }
}

/**
 * The firmware listing of one core of a run bundle:
 * [{ pc, offset, word, text, kind, target, region }]. `pc` is the absolute address the frames
 * name (RAM_BASE + offset). `region` is the source-map entry the word falls under: a hardware
 * instruction ID or a firmware phase such as "init" or "segment0/sync". Words after the last
 * code region can be data (issue tables), which still print as the instruction they decode to.
 */
export function listing(programCore) {
  const map = [...(programCore.sourceMap ?? [])].sort((a, b) => a.pc - b.pc);
  const out = [];
  let k = -1;
  programCore.image.forEach((word, i) => {
    const offset = i * 4;
    while (k + 1 < map.length && map[k + 1].pc <= offset) k++;
    const d = decode(word, programCore.withMul !== false);
    out.push({ pc: RAM_BASE + offset, offset, word: word >>> 0, text: d.text, kind: d.kind,
      target: d.target === undefined ? undefined : RAM_BASE + offset + d.target, region: k >= 0 ? map[k].source : null });
  });
  return out;
}
