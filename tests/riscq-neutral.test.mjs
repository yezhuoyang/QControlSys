// ZAC compiled program → RISC-Q firmware → Lean execution. The program and architecture are the
// pinned ZAC artifacts already used by the neutral-atom validation study.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execute } from "../riscq/soc.mjs";
import { assemble } from "../riscq/compile.mjs";
import * as neutral from "../riscq/platforms/neutral.mjs";

const artifact = (name) => JSON.parse(readFileSync(new URL("../validation/neutral/zac/" + name, import.meta.url), "utf8"));
const code = artifact("bv_n14_transpiled_code.json");
const m = neutral.machine(code, artifact("full_architecture_2aod.json"));
const hardware = neutral.schedule(m);
const lowered = neutral.lower(hardware, m);
const built = assemble(m.spec, lowered, { bindings: lowered.bindings, maxEvents: 400000, maxSteps: 20000000 });
const result = await execute(built.document);
const ops = hardware.segments[0].ops;
const pulsesOf = (op) => result.summary.pulses.filter((p) => p.source === op.id);

test("the ZAC program maps to pickup, move, drop, raman and rydberg instructions on the batch grid", () => {
  const count = (kind) => ops.filter((op) => op.op === kind).length;
  assert.deepEqual([count("pickup"), count("move"), count("drop"), count("rydberg"), count("raman")], [26, 26, 26, 13, 14]);
  assert.ok(ops.every((op) => op.t % m.period === 0 && op.dur % m.period === 0));
  // ZAC's 0.36 µs Rydberg pulse is 36 batches of 10 ns, and atom transfer takes 15 µs.
  assert.equal(ops.find((op) => op.op === "rydberg").dur, 360000);
  assert.ok(ops.filter((op) => op.op === "pickup").every((op) => op.dur === 15000000));
  // One core per AOD drives its column and row tones. A third core drives the lasers.
  assert.deepEqual(m.spec.cores.map((c) => [c.name, c.channels.map((ch) => ch.name).join(" ")]),
    [["aod0", "x0 x1 y0"], ["aod1", "x0 x1 y0"], ["laser", "raman rydberg"]]);
});

test("every pulse and every frequency step of the program lands on time", () => {
  assert.equal(result.summary.status, "quiescent");
  assert.deepEqual(result.summary.faults, []);
  assert.ok(result.summary.pulses.every((p) => p.onTime && p.aligned && !p.overlap));
  assert.ok(result.summary.cores.every((c) => c.done));
  // The schedule keeps ZAC's timing: each instruction's first pulse opens at its ZAC time.
  const origin = pulsesOf(ops[0])[0].opens - ops[0].t / m.period;
  for (const op of ops) {
    const mine = pulsesOf(op);
    assert.ok(mine.length > 0, op.id);
    assert.ok(mine.every((p) => p.opens === origin + op.t / m.period && p.dur === op.dur / m.period), op.id);
  }
  // A Rydberg pulse opens exactly when the drop that precedes it has closed.
  const rydberg = ops.find((op) => op.op === "rydberg"), drop = ops[ops.indexOf(rydberg) - 1];
  assert.equal(drop.op, "drop");
  assert.equal(pulsesOf(rydberg)[0].opens, pulsesOf(drop)[0].closes);
});

test("tone positions read back from the run follow each move to its destination", () => {
  const timeline = neutral.toneTimeline(result, m);
  // The 16-bit frequency code moves a tone in steps of 24.4 kHz, which is 0.13 µm at 188 kHz per µm.
  const quantum = (16 * 100e6) / 65536 / neutral.HZ_PER_UM;
  assert.ok(Math.abs(quantum - 0.1295) < 1e-4);
  for (const move of ops.filter((op) => op.op === "move")) {
    const pickup = ops[ops.indexOf(move) - 1];
    const window = pulsesOf(move)[0];
    for (const tone of [...move.cols.map((c) => ({ ...c, name: "x" + c.id })), ...move.rows.map((r) => ({ ...r, name: "y" + r.id }))]) {
      const part = "aod" + move.aod + "." + tone.name;
      const start = timeline.filter((x) => x.part === part && x.source === pickup.id).at(-1);
      const steps = timeline.filter((x) => x.part === part && x.source === move.id);
      // The tone sits at the pickup site when its amplitude ramps up.
      assert.ok(Math.abs(start.um - tone.from) <= quantum / 2 + 1e-9, part + " pickup");
      const path = [start, ...steps];
      // It moves monotonically, inside the hold window, and ends on the destination.
      const direction = Math.sign(tone.to - tone.from);
      for (let i = 1; i < path.length; i++) {
        assert.ok((path[i].um - path[i - 1].um) * direction > 0, part + " monotone");
        assert.ok(path[i].atBatch >= window.opens && path[i].atBatch < window.closes, part + " inside the move");
        assert.ok(path[i].atBatch - path[i - 1].atBatch >= 37 || i === 1, part + " step spacing");
      }
      assert.ok(Math.abs(path.at(-1).um - tone.to) <= quantum / 2 + 1e-9, part + " destination");
    }
  }
  // The first job carries atoms 0 and 13 from storage to the entangling zone, as ZAC states.
  const first = ops.find((op) => op.op === "move");
  assert.deepEqual(first.atoms, [{ atom: 0, from: [3, 297], to: [35, 307] }, { atom: 13, from: [39, 297], to: [37, 307] }]);
});

test("the move profile accelerates to the midpoint and decelerates to rest", () => {
  assert.equal(neutral.profile(0), 0);
  assert.equal(neutral.profile(0.5), 0.5);
  assert.equal(neutral.profile(1), 1);
  assert.ok(neutral.profile(0.25) < 0.25 && neutral.profile(0.75) > 0.75);
});

test("frequency steps closer than one phasor regeneration are reported by the model", async () => {
  // Two carrier updates 20 batches apart on one tone: the second restarts the regeneration.
  const actions = [
    { segment: 0, core: 0, at: 200, fire: { channel: "x0", slot: 0 }, source: "hold" },
    { segment: 0, core: 0, at: 300, freq: { channel: "x0", code: 5000 }, source: "step1" },
    { segment: 0, core: 0, at: 320, freq: { channel: "x0", code: 5100 }, source: "step2" },
  ];
  const tight = assemble(m.spec, {
    tables: [{ core: 0, channel: "x0", freq: 4000, slots: [{ slot: 0, amp: 19896, dur: 400 }] }],
    segments: [{ span: 700 }], actions }, {});
  const run = await execute(tight.document);
  assert.deepEqual(run.summary.faults.map((f) => f.reason),
    ["carrier update lands before the previous phasor regeneration finished"]);
});
