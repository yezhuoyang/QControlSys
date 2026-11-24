// The RISC-Q workspace (studio/riscq-studio.html) shows a run at four layers at once: the
// source, the intermediate program, the hardware instructions and the RV32I firmware of each
// core, beside a 3D view of the apparatus. These tests check the pure functions it reads, so
// that a headless agent calling them inspects the same result as a person on the page.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../riscq/examples.mjs";
import * as model from "../studio/riscq-model.js";
import * as layers from "../studio/riscq-layers.js";
import { decode, RAM_BASE } from "../studio/riscq-disasm.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = resolve(process.env.QCCD_STUDIO_ROOT || join(root, "..", "QCCD"));
const integration = { skip: existsSync(upstream) ? false : "QCCD Studio checkout not found" };

/** Every traced core instruction prints in the firmware column as Lean printed it in the frame. */
function listingAgreesWithLean(bundle) {
  const cores = new Map(bundle.machine.cores.map((c, k) => [c.name, k]));
  let checked = 0;
  bundle.frames.forEach((frame, i) => {
    if (!cores.has(frame.part) || frame.pc === undefined || frame.state?.text === undefined) return;
    const k = cores.get(frame.part), row = layers.firmwareRow(bundle, k, frame.pc);
    assert.ok(row >= 0, frame.id + " executes " + frame.pc.toString(16) + ", outside the image of " + frame.part);
    assert.equal(layers.firmware(bundle, k)[row].text, frame.state.text, frame.id);
    // The step's focus names the same core and word.
    const focus = layers.focusAt(bundle, i);
    assert.equal(focus.core, k);
    assert.equal(focus.row, row);
    checked++;
  });
  return checked;
}

test("the disassembler reproduces Lean's Instr.text on every instruction of a full trace", async () => {
  const bundle = await run({ example: "superconducting-repetition", outcomes: { s0: 1 }, trace: "full" });
  assert.ok(listingAgreesWithLean(bundle) > 1000);
  // Words that are not instructions print as Lean prints them.
  assert.equal(decode(0xffffffff).text, ".word 0xffffffff");
  assert.equal(decode(0x02000033, false).text, ".word 0x2000033");
  assert.equal(decode(0x02000033, true).text, "mul x0, x0, x0");
  assert.equal(decode(0x0000006f).text, "jal x0, 0");
});

test("compiled C on a decoder core lists as Lean executed it", async () => {
  const bundle = await run({ example: "decoder-helios-d3" });
  assert.ok(listingAgreesWithLean(bundle) > 100);
  // Each phase of the program names the C functions it runs, and those are definitions in the source.
  const { source } = layers.programLayers(bundle);
  for (const { op } of model.hardwareOps(bundle)) {
    const lines = layers.originOf(bundle, op).source;
    assert.ok(lines.length, op.id + " has no source line");
    for (const k of lines) assert.match(source.lines[k].text, /\(/);
  }
});

test("OpenQASM lines, hardware instructions and firmware regions are linked both ways", async () => {
  const bundle = await run({ example: "superconducting-feedforward", outcomes: { c: 1 } });
  const { source } = layers.programLayers(bundle);
  for (const { op } of model.hardwareOps(bundle)) {
    const [line] = layers.originOf(bundle, op).source;
    assert.equal(source.lines[line].key, Number(/line (\d+)/.exec(op.source)[1]));
  }
  // The measurement comes from `c = measure q[0];` and the conditioned X from `if (c) x q[2];`.
  const measure = model.hardwareOps(bundle).find((e) => e.op.op === "measure").op;
  assert.match(source.lines[layers.originOf(bundle, measure).source[0]].text, /measure q\[0\]/);
  const x = model.hardwareOps(bundle).find((e) => e.op.op === "x").op;
  assert.match(source.lines[layers.originOf(bundle, x).source[0]].text, /if \(c\) x q\[2\]/);
  // A firmware region named after a hardware instruction holds the words that issue it.
  const region = layers.firmwareRowsOf(bundle, 0, "h2");
  assert.ok(region.length > 0);
  assert.ok(region.every((r) => layers.firmware(bundle, 0)[r].region === "h2"));
  listingAgreesWithLean(bundle);
});

test("system calls are one source line each", async () => {
  const bundle = await run({ example: "superconducting-repetition", outcomes: { s0: 1 } });
  const { source } = layers.programLayers(bundle);
  const decodeOp = model.hardwareOps(bundle).find((e) => e.op.op === "decode").op;
  assert.match(source.lines[layers.originOf(bundle, decodeOp).source[0]].text, /decode_syndrome/);
});

test("statements expand per qubit of a register operand, as compilers number operations", () => {
  const text = 'OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[3];\ncreg c[3];\nh q[0];\ncx q[0],q[1];\nbarrier q;\nmeasure q -> c;\nh q;';
  assert.deepEqual(layers.qasmStatements(text).map((s) => [s.line, s.ops]), [[4, 1], [5, 1], [6, 0], [7, 3], [8, 3]]);
  assert.deepEqual(layers.parseLoose('{"a": Infinity, "b": [-Infinity, NaN], "s": "Infinity"}'), { a: null, b: [null, null], s: "Infinity" });
});

test("TSIR instructions lead back to the OpenQASM statements QCCD Studio compiled them from", integration, async () => {
  const bundle = await run({ example: "qccd-ghz3" });
  const { source, ir } = layers.programLayers(bundle);
  assert.ok(ir, "the run carries its TSIR program");
  const text = (op) => layers.originOf(bundle, op).source.map((k) => source.lines[k].text.trim());
  const ops = model.hardwareOps(bundle).map((e) => e.op);
  // Both MS gates come from the two CNOTs, in order, and every measurement from `measure q -> c;`.
  assert.deepEqual(ops.filter((op) => op.op === "ms").map(text), [["cx q[0],q[1];"], ["cx q[1],q[2];"]]);
  for (const op of ops.filter((o) => o.op === "measure")) assert.deepEqual(text(op), ["measure q -> c;"]);
  for (const op of ops) assert.equal(layers.originOf(bundle, op).ir.length, 1, op.id + " names one TSIR instruction");
  // Ions end where the reconstruction puts them, and each sits on a site of the chip layout.
  const end = bundle.frames.at(-1).atBatch, chip = layers.chipLayout(bundle);
  const placed = layers.ionPositions(bundle, end);
  for (const ion of model.ionsAt(bundle, end).ions) {
    const seen = placed.find((p) => p.ion === ion.ion);
    assert.equal(seen.site, ion.site);
    assert.deepEqual(seen.at, chip.sites.get(ion.site));
  }
  listingAgreesWithLean(bundle);
});

test("an atom carried by an AOD sits at the crossing of its tones, and ends at its drop site", async () => {
  const bundle = await run({ example: "neutral-bv14" });
  const ops = model.hardwareOps(bundle).map((e) => e.op);
  const move = ops.find((o) => o.op === "move");
  // In the middle of the first move, each carried atom is at the positions of its column and row tones.
  const windows = (bundle.summary.pulses ?? []).filter((r) => r.source === move.id);
  const mid = Math.round((Math.min(...windows.map((w) => w.opens)) + Math.max(...windows.map((w) => w.closes))) / 2);
  const tones = new Map(model.tonesAt(bundle, mid).map((t) => [t.part, t.um]));
  const atoms = layers.atomPositions(bundle, mid);
  for (const a of move.atoms) {
    const seen = atoms.find((x) => x.atom === a.atom);
    assert.ok(seen.carried, "atom " + a.atom + " is carried at batch " + mid);
    const col = move.cols.find((c) => c.from === a.from[0]), row = move.rows.find((r) => r.from === a.from[1]);
    assert.deepEqual(seen.at, [tones.get("aod" + move.aod + ".x" + col.id), tones.get("aod" + move.aod + ".y" + row.id)]);
  }
  // After the run every atom that moved is at the `to` of its last move.
  const last = new Map();
  for (const op of ops.filter((o) => o.op === "move")) for (const a of op.atoms) last.set(a.atom, a.to);
  const end = layers.atomPositions(bundle, Infinity);
  for (const [atom, to] of last) assert.deepEqual(end.find((x) => x.atom === atom).at, to);
  // The tones start where the geometry places the atoms they pick up, within one 16-bit frequency step.
  const pickup = layers.atomPositions(bundle, Math.min(...windows.map((w) => w.opens)));
  for (const a of move.atoms) {
    const seen = pickup.find((x) => x.atom === a.atom);
    assert.ok(Math.hypot(seen.at[0] - a.from[0], seen.at[1] - a.from[1]) < 0.5, "atom " + a.atom + " is picked up at its trap");
  }
});

test("each view draws a part set that together covers the machine, and every frame acts on a drawn or named part", async () => {
  for (const example of ["superconducting-feedforward", "neutral-bv14", "decoder-helios-d3"]) {
    const bundle = await run({ example });
    const all = new Set(bundle.system.parts.map((p) => p.id));
    const chip = layers.viewParts(bundle, "chip"), control = layers.viewParts(bundle, "control"), machine = layers.viewParts(bundle, "machine");
    assert.deepEqual(machine, all);
    assert.deepEqual(new Set([...chip, ...control]), all, example + ": a part is in neither the chip nor the control view");
    for (const p of bundle.system.parts) if (p.kind === "device") assert.ok(chip.has(p.id), p.id + " is missing from the chip view");
    // Off view is never unknown: every acting part is in the machine view.
    for (const f of bundle.frames) assert.ok(machine.has(f.part));
    // The apparatus driven at a step is bound to an open window of that step.
    const state = model.stateAt(bundle, Math.floor(bundle.frames.length / 2));
    for (const [device, list] of layers.activeDevices(bundle, state))
      for (const { window, binding } of list) {
        assert.equal(binding.part, device);
        assert.ok(window.opens <= state.atBatch && state.atBatch < window.closes);
      }
  }
});
