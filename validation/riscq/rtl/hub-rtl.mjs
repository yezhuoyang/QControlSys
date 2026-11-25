// The board hub under contention, on RISC-Q's RTL and in the Lean model: four cores publish bursts of
// shared bits, signal each other's mailboxes and meet at two barriers; each stores its release times and
// the shared word it reads to the host window. Every commit, host write and pulse must agree.
//   node validation/riscq/rtl/hub-rtl.mjs
import { Assembler, reg } from "../../../riscq/rv32.mjs";
import { socSpec, program, execute } from "../../../riscq/soc.mjs";
import { runRtlBatch, compareCommits } from "../../../riscq/rtl.mjs";

const { t0, t1, t2, t3, s0, s1, a0, a1 } = reg;
const N = 4;
const spec = socSpec({
  name: "hub4", dsp_freq_hz: 5e8, link_pipe: 2,
  core_defaults: { mem_depth: 4096, with_mul: true, queue_depth: 8 },
  cores: Array.from({ length: N }, (_, i) => ({ name: "q" + i, channels: [
    { name: "gate", kind: "pulse", dac: i, slots: 4, env_depth: 1024, interp: 4 },
    { name: "ro", kind: "pulse", dac: 8 + i, slots: 1, env_depth: 1024, interp: 16 },
    { name: "demod", kind: "demod", adc: i, slots: 1, env_depth: 1024, interp: 4 },
  ] })),
});
const node = (n) => 0x10000 + n * 0x10000;
const GROUP0 = node(16), BARRIER0 = node(20), INBOX0 = (core) => node(36 + core) + 0x140;
function core(i) {
  const a = new Assembler();
  a.li(a0, 0x40000000);
  a.li(s0, GROUP0); a.li(s1, BARRIER0);
  // A burst of four publishes (slot 4i + k, bit 1), back to back.
  for (let k = 0; k < 4; k++) { a.li(t0, ((4 * i + k) << 1) | 1); a.sw(t0, s0, 0); }
  // Signal the next core's mailbox 0 with my index.
  a.li(t1, INBOX0((i + 1) % N)); a.li(t0, 0x100 + i); a.sw(t0, t1, 0);
  // Barrier 0 with all four, read the release, the shared word and the mailbox, store them.
  a.li(t0, N); a.sw(t0, s1, 0);
  a.li(t2, 0x4320); a.lw(t3, t2, 0); a.sw(t3, a0, 0);
  a.li(t2, 0x4300); a.lw(t3, t2, 0); a.sw(t3, a0, 4);
  a.li(t2, 0x4340); a.lw(t3, t2, 0); a.sw(t3, a0, 8);
  // A second barrier right away (same id: the hub's same-barrier hazard).
  a.li(t0, N); a.sw(t0, s1, 0);
  a.li(t2, 0x4320); a.lw(t3, t2, 0); a.sw(t3, a0, 12);
  a.park();
  return a.assemble();
}
const doc = program(spec, Array.from({ length: N }, (_, i) => core(i)), { name: "hub4", trace: "full" });
const lean = await execute(doc);
console.log("lean", lean.summary.status, "faults", JSON.stringify(lean.summary.faults));
const [rtl] = runRtlBatch([doc], { cycles: 600, dir: "output/rtl/hub4" });
for (const c of compareCommits({ ...lean, cores: doc.cores }, rtl)) console.log("core", c.core, "compared", c.compared, "same cycle", c.sameCycle, "pc mismatch", c.pcMismatch, JSON.stringify(c.diffs.slice(0, 3)));
const l0 = lean.frames.find((f) => f.op === "exec").atBatch, r0 = Math.min(...rtl.commits.map((c) => c[1]));
const lh = lean.summary.host.map((h) => [h.core, h.atBatch - l0, h.offset, h.value]).sort((x, y) => x[1] - y[1] || x[0] - y[0]);
const rh = rtl.host.map((h) => [h[0], h[1] - r0, h[3], h[4]]).sort((x, y) => x[1] - y[1] || x[0] - y[0]);
console.log("host writes lean", lh.length, "rtl", rh.length);
// Release times are batch times: compare them as differences from the first release.
const rel = (rows) => { const r = rows.filter((x) => x[2] === 0 || x[2] === 12); const base = r[0]?.[3] ?? 0; return rows.map((x) => (x[2] === 0 || x[2] === 12) ? [x[0], x[1], x[2], x[3] - base] : x); };
const L = rel(lh), R = rel(rh);
let same = 0;
for (let i = 0; i < Math.min(L.length, R.length); i++) if (JSON.stringify(L[i]) === JSON.stringify(R[i])) same++; else if (i < 40) console.log("differs", JSON.stringify(L[i]), JSON.stringify(R[i]));
console.log("host writes identical (core, cycle, offset, value):", same + "/" + Math.max(L.length, R.length));
