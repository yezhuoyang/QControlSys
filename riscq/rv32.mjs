// RV32I + Zmmul assembler for RISC-Q control cores. It emits the machine words that the
// Lean model in QControl/RiscQ/Rv32.lean decodes and executes. Labels resolve at assemble().
export const RAM_BASE = 0x80000000;

const abi = [
  "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
  "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6",
];
/** Register numbers by ABI name. */
export const reg = Object.fromEntries(abi.map((name, i) => [name, i]));

function register(r) {
  const n = typeof r === "string" ? (reg[r] ?? (/^x\d+$/.test(r) ? Number(r.slice(1)) : NaN)) : r;
  if (!Number.isInteger(n) || n < 0 || n > 31) throw Error("Unknown register " + r + ".");
  return n;
}
function signed(value, bits, what) {
  if (!Number.isInteger(value) || value < -(2 ** (bits - 1)) || value >= 2 ** (bits - 1))
    throw Error(what + " " + value + " does not fit " + bits + " signed bits.");
  return value;
}
const u32 = (x) => x >>> 0;

const R = (f7, f3, opcode) => (rd, rs1, rs2) =>
  u32((f7 << 25) | (register(rs2) << 20) | (register(rs1) << 15) | (f3 << 12) | (register(rd) << 7) | opcode);
const I = (f3, opcode) => (rd, rs1, imm) =>
  u32(((signed(imm, 12, "Immediate") & 0xfff) << 20) | (register(rs1) << 15) | (f3 << 12) | (register(rd) << 7) | opcode);
const S = (f3) => (rs2, rs1, imm) => {
  const v = signed(imm, 12, "Store offset") & 0xfff;
  return u32(((v >> 5) << 25) | (register(rs2) << 20) | (register(rs1) << 15) | (f3 << 12) | ((v & 31) << 7) | 0x23);
};
const shift = (f7, f3) => (rd, rs1, amount) => {
  if (!Number.isInteger(amount) || amount < 0 || amount > 31) throw Error("Shift amount is 0–31.");
  return u32((f7 << 25) | (amount << 20) | (register(rs1) << 15) | (f3 << 12) | (register(rd) << 7) | 0x13);
};
function branchWord(f3, rs1, rs2, offset) {
  if (offset & 1) throw Error("Branch target is not word aligned.");
  const v = signed(offset, 13, "Branch offset") & 0x1fff;
  return u32(((v >> 12) << 31) | (((v >> 5) & 0x3f) << 25) | (register(rs2) << 20) | (register(rs1) << 15) |
    (f3 << 12) | (((v >> 1) & 0xf) << 8) | (((v >> 11) & 1) << 7) | 0x63);
}
function jalWord(rd, offset) {
  if (offset & 1) throw Error("Jump target is not word aligned.");
  const v = signed(offset, 21, "Jump offset") & 0x1fffff;
  return u32(((v >> 20) << 31) | (((v >> 1) & 0x3ff) << 21) | (((v >> 11) & 1) << 20) |
    (((v >> 12) & 0xff) << 12) | (register(rd) << 7) | 0x6f);
}

/** Encoders for single words. Each returns an unsigned 32-bit integer. */
export const encode = {
  lui: (rd, imm20) => u32(((imm20 & 0xfffff) << 12) | (register(rd) << 7) | 0x37),
  auipc: (rd, imm20) => u32(((imm20 & 0xfffff) << 12) | (register(rd) << 7) | 0x17),
  jalr: I(0, 0x67),
  lb: I(0, 0x03), lh: I(1, 0x03), lw: I(2, 0x03), lbu: I(4, 0x03), lhu: I(5, 0x03),
  sb: S(0), sh: S(1), sw: S(2),
  addi: I(0, 0x13), slti: I(2, 0x13), sltiu: I(3, 0x13), xori: I(4, 0x13), ori: I(6, 0x13), andi: I(7, 0x13),
  slli: shift(0, 1), srli: shift(0, 5), srai: shift(0x20, 5),
  add: R(0, 0, 0x33), sub: R(0x20, 0, 0x33), sll: R(0, 1, 0x33), slt: R(0, 2, 0x33), sltu: R(0, 3, 0x33),
  xor: R(0, 4, 0x33), srl: R(0, 5, 0x33), sra: R(0x20, 5, 0x33), or: R(0, 6, 0x33), and: R(0, 7, 0x33),
  mul: R(1, 0, 0x33), mulh: R(1, 1, 0x33), mulhsu: R(1, 2, 0x33), mulhu: R(1, 3, 0x33),
};
const branches = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 };

/** Build one core's image. Every emitter returns the address of the word it wrote. */
export class Assembler {
  constructor({ base = RAM_BASE } = {}) {
    this.base = base;
    this.items = [];
    this.labels = new Map();
    this.sources = [];
    this.auto = 0;
  }
  get pc() {
    return this.base + 4 * this.items.length;
  }
  /** Bind a label to the next word. */
  label(name) {
    if (this.labels.has(name)) throw Error("Duplicate label " + name + ".");
    this.labels.set(name, this.items.length);
    return name;
  }
  fresh(prefix = "L") {
    return prefix + "$" + this.auto++;
  }
  /** Instructions from here on belong to the given source operation. */
  source(id) {
    const index = this.items.length;
    const last = this.sources.at(-1);
    if (last && last.index === index) last.source = id;
    else if (!last || last.source !== id) this.sources.push({ index, source: id });
  }
  push(item) {
    this.items.push(item);
    return this.base + 4 * (this.items.length - 1);
  }
  word(value) {
    if (!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 32) throw Error("Data word out of range.");
    return this.push({ word: u32(value), text: ".word 0x" + u32(value).toString(16) });
  }
  jal(rd, label) {
    return this.push({ jal: register(rd), label });
  }
  j(label) {
    return this.jal(0, label);
  }
  /** rd = address of a label, as `auipc` followed by `addi`. */
  la(rd, label) {
    const first = this.push({ la: register(rd), label, part: 0 });
    this.push({ la: register(rd), label, part: 1 });
    return first;
  }
  nop() {
    return this.addi(0, 0, 0);
  }
  mv(rd, rs) {
    return this.addi(rd, rs, 0);
  }
  /** Load a 32-bit constant: one `addi`, one `lui`, or `lui` followed by `addi`. */
  li(rd, value) {
    if (!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 32) throw Error("Constant out of range.");
    const v = value | 0;
    if (v >= -2048 && v < 2048) return this.addi(rd, 0, v);
    const low = (v << 20) >> 20;
    const high = ((v - low) >>> 12) & 0xfffff;
    const first = this.lui(rd, high);
    if (low) this.addi(rd, rd, low);
    return first;
  }
  /** Park the core: a jump to itself. */
  park() {
    const here = this.fresh("park");
    this.label(here);
    return this.j(here);
  }
  assemble() {
    const words = this.items.map((item, index) => {
      if (item.word !== undefined) return item.word;
      const target = this.labels.get(item.label);
      if (target === undefined) throw Error("Undefined label " + item.label + ".");
      if (item.la !== undefined) {
        // The offset is taken from the `auipc`, which is the word before the `addi`.
        const offset = 4 * (target - (index - item.part));
        const low = (offset << 20) >> 20;
        return item.part === 0 ? encode.auipc(item.la, ((offset - low) >>> 12) & 0xfffff) : encode.addi(item.la, item.la, low);
      }
      const offset = 4 * (target - index);
      return item.jal !== undefined ? jalWord(item.jal, offset) : branchWord(item.f3, item.rs1, item.rs2, offset);
    });
    return {
      base: this.base,
      words,
      labels: Object.fromEntries([...this.labels].map(([name, index]) => [name, this.base + 4 * index])),
      sourceMap: this.sources.map(({ index, source }) => ({ pc: 4 * index, source })),
      text: this.items.map((item) => item.text ?? null),
    };
  }
}
for (const [name, encoder] of Object.entries(encode))
  Assembler.prototype[name] = function (...args) {
    return this.push({ word: encoder(...args), text: name });
  };
for (const [name, f3] of Object.entries(branches))
  Assembler.prototype[name] = function (rs1, rs2, label) {
    return this.push({ f3, rs1: register(rs1), rs2: register(rs2), label, text: name });
  };

/** Words of the loadable segments of a little-endian RV32 ELF, placed at RAM_BASE. */
export function loadElf(bytes, { base = RAM_BASE } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x7f454c46 || bytes[4] !== 1 || bytes[5] !== 1)
    throw Error("Expected a 32-bit little-endian ELF file.");
  if (view.getUint16(18, true) !== 243) throw Error("Expected a RISC-V ELF file.");
  const entry = view.getUint32(24, true);
  const phoff = view.getUint32(28, true), phentsize = view.getUint16(42, true), phnum = view.getUint16(44, true);
  const words = [];
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    if (view.getUint32(at, true) !== 1) continue;
    const offset = view.getUint32(at + 4, true), vaddr = view.getUint32(at + 8, true);
    const filesz = view.getUint32(at + 16, true), memsz = view.getUint32(at + 20, true);
    // A default link also maps the ELF headers below the reset vector. Only the part of a
    // segment that lies in the core RAM is loaded.
    const skip = Math.max(0, base - vaddr);
    if (memsz <= skip) continue;
    if ((vaddr + skip - base) % 4) throw Error("ELF segment is not word aligned.");
    const first = (vaddr + skip - base) / 4;
    for (let k = 0; k < Math.ceil((memsz - skip) / 4); k++) {
      let word = 0;
      for (let b = 3; b >= 0; b--) {
        const p = skip + 4 * k + b;
        word = (word * 256 + (p < filesz ? bytes[offset + p] : 0)) >>> 0;
      }
      words[first + k] = word;
    }
  }
  if (entry !== base) throw Error("ELF entry point is not the core reset vector.");
  return Array.from(words, (w) => w ?? 0);
}
