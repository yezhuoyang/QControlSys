// Micro-benchmarks for the RISC-Q core's timing: each program isolates one rule of the pipeline
// (independent and dependent ALU ops, loads, load-use, stores to RAM, to the put window and to the
// host window, taken and mispredicted branches, calls, multiplies). Each runs once in the Lean model
// and once on RISC-Q's RTL (riscq/rtl.mjs); the commit cycles of every instruction are compared.
//
//   node validation/riscq/rtl/microbench.mjs [name ...]   # prints the comparison, writes output/rtl/
import { Assembler, reg } from "../../../riscq/rv32.mjs";
import { socSpec, program, execute } from "../../../riscq/soc.mjs";
import { runRtlBatch, compareCommits } from "../../../riscq/rtl.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const { t0, t1, t2, t3, t4, t5, t6, s0, s1, a0, a1, a2 } = reg;

/** One core as RISC-Q's x6y3 build makes it: 500 MHz, link depth 2, 8192-word RAM, multiplier, queue depth 32. */
export const SPEC = socSpec({
  name: "microbench", dsp_freq_hz: 5e8, link_pipe: 2,
  core_defaults: { mem_depth: 8192, with_mul: true, queue_depth: 32 },
  cores: [{ name: "q0", channels: [
    { name: "gate", kind: "pulse", dac: 0, slots: 4, env_depth: 1024, interp: 4 },
    { name: "ro", kind: "pulse", dac: 1, slots: 1, env_depth: 1024, interp: 16 },
    { name: "demod", kind: "demod", adc: 0, slots: 1, env_depth: 1024, interp: 4 },
  ] }],
});

const PUT_FREQ = 0x10004; // channel 0 (gate), carrier register
const HOST = 0x40000000;

/** The programs: each a function filling an assembler, ending in a park. */
export const BENCHES = {
  "alu-independent": (a) => { for (let i = 0; i < 24; i++) a.addi(5 + (i % 3), 0, i); },
  "alu-dependent": (a) => { a.li(t0, 0); for (let i = 0; i < 24; i++) a.addi(t0, t0, 1); },
  "alu-dependent-2apart": (a) => { a.li(t0, 0); a.li(t1, 0); for (let i = 0; i < 16; i++) { a.addi(t0, t0, 1); a.addi(t1, t1, 1); } },
  "shift-logic": (a) => { a.li(t0, 1); for (let i = 0; i < 8; i++) { a.slli(t0, t0, 1); a.xori(t1, t0, 3); a.or(t2, t1, t0); } },
  "load-independent": (a) => { a.la(s0, "data"); for (let i = 0; i < 12; i++) a.lw(5 + (i % 3), s0, 4 * (i % 4)); },
  "load-use": (a) => { a.la(s0, "data"); for (let i = 0; i < 8; i++) { a.lw(t0, s0, 0); a.addi(t1, t0, 1); } },
  "store-ram": (a) => { a.la(s0, "data"); a.li(t0, 7); for (let i = 0; i < 12; i++) a.sw(t0, s0, 4 * (i % 4)); },
  "store-put": (a) => { a.li(s0, PUT_FREQ); a.li(t0, 0x1000); for (let i = 0; i < 12; i++) a.sw(t0, s0, 0); },
  "store-host": (a) => { a.li(s0, HOST); for (let i = 0; i < 12; i++) a.sw(s0, s0, 4 * i); },
  "loop-taken": (a) => { a.li(t0, 20); a.label("top"); a.addi(t0, t0, -1); a.bne(t0, 0, "top"); },
  "loop-long-body": (a) => { a.li(t0, 12); a.label("top"); a.addi(t1, t1, 1); a.addi(t2, t2, 1); a.addi(t3, t3, 1); a.addi(t4, t4, 1); a.addi(t0, t0, -1); a.bne(t0, 0, "top"); },
  "branch-alternate": (a) => {
    a.li(t0, 16); a.li(t1, 0);
    a.label("top"); a.xori(t1, t1, 1); a.beq(t1, 0, "skip"); a.addi(t2, t2, 1); a.label("skip"); a.addi(t0, t0, -1); a.bne(t0, 0, "top");
  },
  "call-return": (a) => { for (let i = 0; i < 6; i++) a.jal(reg.ra, "fn"); a.j("end"); a.label("fn"); a.addi(t0, t0, 1); a.jalr(0, reg.ra, 0); a.label("end"); },
  // One access of each kind, 10 no-ops apart, for the data-bus probe: RAM load, RAM store, put-window
  // store, batch-time read, timeCmp write, host-window store, store then load (RAW through the store
  // buffer), hub publish then a read of the shared word.
  "io-each": (a) => {
    const gap = () => { for (let i = 0; i < 10; i++) a.nop(); };
    a.la(s0, "data"); a.li(s1, PUT_FREQ); a.li(a0, HOST); a.li(a1, 0x110000); a.li(a2, 3); a.li(t5, 0xbff8); a.li(t6, 0x4300); a.li(t4, 0x4000); gap();
    a.lw(t0, s0, 0); gap();
    a.sw(a2, s0, 4); gap();
    a.sw(a2, s1, 0); gap();
    a.lw(t1, t5, 0); gap();
    a.sw(a2, t4, 0); gap();
    a.sw(a2, a0, 0); gap();
    a.sw(a2, s0, 8); a.lw(t2, s0, 8); gap();
    a.sw(a2, a1, 0); gap();
    a.lw(t3, t6, 0); gap();
  },
  // The batch time a load of the time register returns, stored to the host window, three times.
  "time-read": (a) => {
    a.li(t5, 0xbff8); a.li(a0, HOST);
    for (let i = 0; i < 3; i++) { a.lw(t0, t5, 0); a.sw(t0, a0, 4 * i); for (let k = 0; k < 6; k++) a.nop(); }
  },
  "mul": (a) => { a.li(t0, 3); a.li(t1, 5); for (let i = 0; i < 6; i++) a.mul(5 + (i % 2) * 2, t0, t1); for (let i = 0; i < 6; i++) a.mul(t0, t0, t1); },
};

export function buildBench(name) {
  const a = new Assembler();
  BENCHES[name](a);
  a.park();
  a.label("data");
  for (let i = 0; i < 8; i++) a.word(i + 1);
  return a.assemble();
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(BENCHES);
  mkdirSync("output/rtl", { recursive: true });
  const report = {};
  const docs = names.map((name) => program(SPEC, [buildBench(name)], { name: "mb-" + name, trace: "full" }));
  const leans = [];
  for (const doc of docs) leans.push(await execute(doc));
  const rtls = runRtlBatch(docs, { cycles: 1500, dir: "output/rtl/microbench" });
  names.forEach((name, i) => {
    const cmp = compareCommits({ ...leans[i], cores: docs[i].cores }, rtls[i]);
    report[name] = { cmp, rtl: rtls[i].commits.slice(0, 80) };
    const c = cmp[0];
    console.log(name.padEnd(22), "rtl", c.rtlCommits, "lean", c.leanCommits, "same-cycle", c.sameCycle + "/" + c.compared, c.pcMismatch ? "PC MISMATCH " + c.pcMismatch : "", JSON.stringify(c.diffs.slice(0, 4)));
  });
  writeFileSync("output/rtl/microbench.json", JSON.stringify(report, null, 1));
}
