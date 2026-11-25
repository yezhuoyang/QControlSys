// What one ZCU216 holds (riscq/board.mjs): RISC-Q's own builds fit, and the limits come from its records.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { socSpec } from "../riscq/soc.mjs";
import { boardUse, boardsNeeded, ZCU216 } from "../riscq/board.mjs";

const config = (name) => socSpec(JSON.parse(readFileSync(new URL("../validation/riscq/" + name, import.meta.url), "utf8")));

test("RISC-Q's 8- and 14-core builds fit one board with their recorded DSP use", () => {
  // Vivado results of record (vivado-scripts/riscvsoc-bd/README.md, docs/dsp/DSP48.md).
  const x6y3 = boardUse(config("x6y3.json"));
  assert.deepEqual(x6y3.violations, []);
  assert.equal(x6y3.use.dsp, 1623);
  assert.equal(x6y3.use.uram, 8);
  const big = boardUse(config("zcu216-14q.json"));
  assert.deepEqual(big.violations, []);
  assert.equal(big.use.dsp, ZCU216.dspCeiling.value);
});

test("a fifteenth core, a second demod channel or a seventeenth DAC does not fit", () => {
  const core = (i, extra = []) => ({ name: "q" + i, channels: [
    { name: "gate", kind: "pulse", dac: i % 16, slots: 4, env_depth: 1024, interp: 4 },
    { name: "demod", kind: "demod", adc: i % 16, slots: 1, env_depth: 1024, interp: 4 }, ...extra] });
  const spec = (cores) => socSpec({ name: "b", dsp_freq_hz: 5e8, cores });
  assert.ok(boardUse(spec(Array.from({ length: 15 }, (_, i) => core(i)))).violations.some((v) => v.rule === "cores"));
  assert.ok(boardUse(spec([core(0, [{ name: "demod2", kind: "demod", adc: 1, slots: 1, env_depth: 1024, interp: 4 }])])).violations.some((v) => v.rule === "demod"));
  assert.ok(boardUse(spec([core(0, [{ name: "x", kind: "pulse", dac: 16, slots: 1, env_depth: 1024, interp: 4 }])])).violations.some((v) => v.rule === "dacs"));
  // 54 cores of a transmon, two readout-capable pulse channels each: DSP binds before the core count.
  const willowLike = spec(Array.from({ length: 54 }, (_, i) => core(i, [{ name: "ro", kind: "pulse", dac: (i + 8) % 16, slots: 1, env_depth: 1024, interp: 16 }])));
  const n = boardsNeeded(willowLike);
  assert.ok(n.boards >= 4 && n.binding.length > 0);
});
