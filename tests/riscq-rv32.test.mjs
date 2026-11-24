// The RV32I + Zmmul semantics of the Lean core model, checked instruction by instruction
// against values computed independently here, and the assembler checked against the Lean decoder.
import test from "node:test";
import assert from "node:assert/strict";
import { Assembler, reg } from "../riscq/rv32.mjs";
import { socSpec, program, execute } from "../riscq/soc.mjs";

const spec = socSpec({
  name: "one-core", dsp_freq_hz: 100e6, link_pipe: 4,
  cores: [{ name: "c0", channels: [{ name: "gate", kind: "pulse", dac: 0, slots: 2, env_depth: 16, interp: 4 }] }],
});
const u32 = (x) => Number(BigInt.asUintN(32, BigInt(x)));
const s32 = (x) => Number(BigInt.asIntN(32, BigInt(x)));
async function runProgram(build, options = {}) {
  const a = new Assembler();
  build(a);
  a.park();
  const image = a.assemble();
  const result = await execute(program(spec, [image], { trace: "full", ...options }));
  return { image, result, regs: result.summary.cores[0].regs };
}

test("arithmetic, logic, shifts, comparisons and multiplies match two's-complement reference values", async () => {
  const A = 0x12345678, B = -7, C = 0x80000001;
  const cases = [
    ["add", (a, b) => a + b], ["sub", (a, b) => a - b], ["xor", (a, b) => a ^ b], ["or", (a, b) => a | b], ["and", (a, b) => a & b],
    ["sll", (a, b) => BigInt(u32(a)) << BigInt(b & 31)], ["srl", (a, b) => BigInt(u32(a)) >> BigInt(b & 31)],
    ["sra", (a, b) => BigInt(s32(a)) >> BigInt(b & 31)],
    ["slt", (a, b) => (s32(a) < s32(b) ? 1 : 0)], ["sltu", (a, b) => (u32(a) < u32(b) ? 1 : 0)],
    ["mul", (a, b) => BigInt(s32(a)) * BigInt(s32(b))],
    ["mulh", (a, b) => (BigInt(s32(a)) * BigInt(s32(b))) >> 32n],
    ["mulhsu", (a, b) => (BigInt(s32(a)) * BigInt(u32(b))) >> 32n],
    ["mulhu", (a, b) => (BigInt(u32(a)) * BigInt(u32(b))) >> 32n],
  ];
  const operands = [[A, B], [B, A], [C, 3], [3, C], [B, B], [0, C]];
  for (const [x, y] of operands) {
    const targets = ["s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6"];
    const { regs, result } = await runProgram((a) => {
      a.li("a0", x);
      a.li("a1", y);
      cases.forEach(([name], i) => a[name](targets[i], "a0", "a1"));
    });
    assert.deepEqual(result.summary.faults, []);
    cases.forEach(([name, reference], i) =>
      assert.equal(regs[reg[targets[i]]], u32(reference(x, y)), name + " " + x + ", " + y));
  }
});

test("immediate forms, loads, stores, branches and links behave as specified", async () => {
  const { regs, result, image } = await runProgram((a) => {
    a.li("a0", -1234);
    a.slti("s2", "a0", -1233); // 1
    a.sltiu("s3", "a0", 5); // 0: 0xFFFFFB2E is large unsigned
    a.srai("s4", "a0", 4); // arithmetic
    a.srli("s5", "a0", 28);
    a.slli("s6", "a0", 3);
    a.xori("s7", "a0", 0x55);
    a.andi("s8", "a0", 0x7f);
    a.ori("s9", "a0", 0x700);
    // Memory: a scratch word well above the code.
    a.li("t0", 0x80002000);
    a.li("t1", 0x8899aabb);
    a.sw("t1", "t0", 0);
    a.lb("s10", "t0", 0); // 0xbb sign-extended
    a.lbu("s11", "t0", 3); // 0x88
    a.lh("t3", "t0", 2); // 0x8899 sign-extended
    a.lhu("t4", "t0", 0); // 0xaabb
    a.li("t2", 0x5a);
    a.sb("t2", "t0", 1);
    a.li("t2", 0x1234);
    a.sh("t2", "t0", 2);
    a.lw("t5", "t0", 0); // 0x12345abb
    // A counted loop: sum 1..5, taken backward four times.
    a.li("a1", 0);
    a.li("a2", 5);
    a.label("loop");
    a.add("a1", "a1", "a2");
    a.addi("a2", "a2", -1);
    a.bne("a2", "zero", "loop");
    // Forward branches of each kind over a poison instruction.
    a.li("a3", 0);
    for (const [name, x, y] of [["beq", "zero", "zero"], ["blt", "a0", "zero"], ["bge", "zero", "a0"], ["bltu", "zero", "a0"], ["bgeu", "a0", "zero"]]) {
      const over = a.fresh("over");
      a[name](x, y, over);
      a.addi("a3", "a3", 100);
      a.label(over);
      a.addi("a3", "a3", 1);
    }
    // Call and return.
    a.jal("ra", "callee");
    a.j("end");
    a.label("callee");
    a.li("a4", 77);
    a.jalr("zero", "ra", 0);
    a.label("end");
    a.auipc("a5", 0);
    a.addi("zero", "a0", 5); // a write to x0 is discarded
  });
  assert.deepEqual(result.summary.faults, []);
  const r = (name) => regs[reg[name]];
  const x = -1234;
  assert.deepEqual([r("s2"), r("s3"), r("s4"), r("s5"), r("s6"), r("s7"), r("s8"), r("s9")],
    [1, 0, u32(x >> 4), u32(x) >>> 28, u32(x << 3), u32(x ^ 0x55), u32(x & 0x7f), u32(x | 0x700)]);
  assert.deepEqual([r("s10"), r("s11"), r("t3"), r("t4"), r("t5")], [0xffffffbb, 0x88, 0xffff8899, 0xaabb, 0x12345abb]);
  assert.equal(r("a1"), 15);
  assert.equal(r("a3"), 5);
  assert.equal(r("a4"), 77);
  assert.equal(r("zero"), 0);
  // auipc reads its own address.
  assert.equal(r("a5"), image.labels.end);
  // The timing model charges five extra cycles for each taken transfer and one for each bus access.
  const frames = result.frames.filter((f) => f.part === "c0");
  const taken = frames.filter((f, i) => i + 1 < frames.length && frames[i + 1].state.pc !== f.state.pc + 4 && f.op === "exec");
  for (const f of taken) {
    const next = frames[frames.indexOf(f) + 1];
    assert.equal(next.atBatch - f.atBatch, 6, f.state.text);
  }
  const load = frames.find((f) => f.state.text?.startsWith("lw"));
  assert.equal(frames[frames.indexOf(load) + 1].atBatch - load.atBatch, 2);
});

test("every word the assembler emits is decoded by the Lean model as the same instruction", async () => {
  const { image, result } = await runProgram((a) => {
    a.lui("a0", 0x12345);
    a.auipc("a1", 1);
    for (const name of ["addi", "slti", "sltiu", "xori", "ori", "andi"]) a[name]("a2", "a0", -5);
    for (const name of ["slli", "srli", "srai"]) a[name]("a3", "a0", 7);
    for (const name of ["add", "sub", "sll", "slt", "sltu", "xor", "srl", "sra", "or", "and", "mul", "mulh", "mulhsu", "mulhu"])
      a[name]("a4", "a0", "a2");
    a.li("t0", 0x80003000);
    for (const name of ["sb", "sh", "sw"]) a[name]("a0", "t0", 4);
    for (const name of ["lb", "lh", "lw", "lbu", "lhu"]) a[name]("a5", "t0", 4);
  });
  assert.deepEqual(result.summary.faults, []);
  const frames = result.frames.filter((f) => f.part === "c0" && f.state.text);
  // Straight-line code: frame k executed word k.
  frames.forEach((f, k) => {
    assert.equal(f.state.word, image.words[k]);
    const mnemonic = image.text[k];
    if (mnemonic && !mnemonic.startsWith(".")) assert.equal(f.state.text.split(" ")[0], mnemonic, "word " + k);
  });
  assert.equal(frames.at(-1).state.text, "lhu x15, 4(x5)");
});

test("an unsupported word, a wild jump and an unmapped store each stop the core with a fault frame", async () => {
  const cases = [
    [(a) => a.word(0x30200073), /illegal instruction 0x30200073/], // mret: no privileged instructions
    [(a) => { a.li("t0", 0x1000); a.jalr("zero", "t0", 0); }, /program counter 0x1000 is outside RAM/],
    [(a) => { a.li("t0", 0x5000); a.sw("zero", "t0", 0); }, /store to unmapped address 0x5000/],
    [(a) => { a.li("t0", 0x4001); a.lw("a0", "t0", 0); }, /control registers take aligned word loads/],
  ];
  for (const [build, reason] of cases) {
    const { result } = await runProgram(build);
    const last = result.frames.at(-1);
    assert.equal(last.op, "fault");
    assert.match(last.state.reason, reason);
    assert.match(result.summary.cores[0].stopped, reason);
  }
});
