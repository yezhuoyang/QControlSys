// Optics of the RISC-Q workspace: Gaussian beams through each platform's optical bench
// (studio/riscq-optics.js, studio/riscq-benches.js). The first tests check the beam
// propagation against closed-form textbook results. The rest check that the light a run shows
// follows from its trace: a beam is on only while the DAC window that drives it is open, an AOD
// tweezer lands where the run's tone calibration puts it, and a detection beam hits its site.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as O from "../studio/riscq-optics.js";
import * as B from "../studio/riscq-benches.js";
import * as model from "../studio/riscq-model.js";
import { run } from "../riscq/examples.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = resolve(process.env.QCCD_STUDIO_ROOT || join(root, "..", "QCCD"));
const integration = { skip: existsSync(upstream) ? false : "QCCD Studio checkout not found" };
const close = (a, b, rel, what) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), what + ": " + a + " vs " + b);
const beam = (o = {}) => O.gaussian({ lambdaNm: 810, w0Um: 2000, powerW: 1, ...o });

test("a lens focuses a collimated beam to M² λ f / (π w), with the Rayleigh range π w0² / λ", () => {
  for (const [nm, w, f] of [[810, 2000, 100], [420, 1000, 75], [369.5, 1000, 250]]) {
    const t = O.traceTrain({ source: beam({ lambdaNm: nm, w0Um: w }), start: [0, 0, 0], dir: [1, 0, 0], elements: [{ ...O.lens(f), at: 10, label: "L" }] });
    close(t.focus.wxUm, O.waistAfterLensUm(w, f, nm), 0.01, "waist at " + nm + " nm");
    close(t.focus.distanceXmm, f, 0.01, "focus distance");
    close(t.focus.zRxUm, (Math.PI * t.focus.wxUm ** 2) / (nm * 1e-3), 1e-9, "Rayleigh range");
  }
  // M² multiplies the divergence: the same lens makes an M² times larger waist.
  const m = O.traceTrain({ source: beam({ m2: 1.5 }), start: [0, 0, 0], dir: [1, 0, 0], elements: [{ ...O.lens(100), at: 10, label: "L" }] });
  close(m.focus.wxUm, O.waistAfterLensUm(2000, 100, 810, 1.5), 0.01, "M² waist");
});

test("a telescope magnifies by f2/f1, a cylindrical lens makes a sheet, a mirror folds without changing the beam", () => {
  const tel = O.traceTrain({ source: beam(), start: [0, 0, 0], dir: [1, 0, 0], elements: [{ ...O.lens(50), at: 10, label: "a" }, { ...O.lens(200), at: 250, label: "b" }], endMm: 20 });
  close(tel.segments.at(-1).samples.at(-1).wxUm, 2000 * (200 / 50), 0.001, "expanded radius");
  const sheet = O.traceTrain({ source: beam({ w0Um: 1000 }), start: [0, 0, 0], dir: [1, 0, 0], xAxis: [0, 0, 1], elements: [{ ...O.cylLens(100, "x"), at: 10, label: "c" }] });
  close(sheet.focus.wxUm, O.waistAfterLensUm(1000, 100, 810), 0.01, "focused axis");
  assert.ok(sheet.focus.wyUm > 999, "the other axis stays collimated");
  const m = O.traceTrain({ source: beam(), start: [0, 0, 0], dir: [1, 0, 0], elements: [{ ...O.mirror({ normal: [1, 0, 1] }), at: 100, label: "m" }], endMm: 50 });
  assert.deepEqual(m.segments.at(-1).b.map((v) => Math.round(v * 1e6) / 1e6), [100, 0, -50]);
  close(m.segments.at(-1).samples.at(-1).wxUm, O.traceTrain({ source: beam(), start: [0, 0, 0], dir: [1, 0, 0], elements: [], endMm: 150 }).segments[0].samples.at(-1).wxUm, 1e-9, "radius after a fold");
});

test("a fiber relaunches its mode, an AOD deflects by λΔf/v and shifts the frequency, an AOM shifts it", () => {
  const f = O.traceTrain({ source: beam(), start: [0, 0, 0], dir: [1, 0, 0], elements: [{ ...O.fiber({ mfdUm: 5, couplingEfficiency: 0.5 }), at: 10, label: "fiber" }] });
  close(f.elements[0].wxUm, 2.5, 1e-9, "mode radius at the tip");
  close(f.powerW, 0.5, 1e-12, "coupled power");
  const a = O.traceTrain({ source: beam(), start: [0, 0, 0], dir: [1, 0, 0], xAxis: [0, 1, 0], endMm: 1000,
    elements: [{ ...O.aod({ vAcousticMPerS: 650, centreHz: 80e6, axis: "x", efficiency: 0.8 }), at: 0, label: "A" }] }, { rfHz: { A: 90e6 } });
  close(a.segments.at(-1).b[1], (1000 * 810e-9 * 10e6) / 650, 1e-9, "lateral shift after 1 m");
  close(a.opticalHz - O.opticalFrequencyHz(810), 90e6, 1e-6, "first-order frequency shift");
  close(a.powerW, 0.8, 1e-12, "diffraction efficiency");
  const m = O.traceTrain({ source: beam(), start: [0, 0, 0], dir: [1, 0, 0], elements: [{ ...O.aom({ centreHz: 80e6 }), at: 10, label: "M" }] }, { rfHz: { M: 81e6 } });
  close(m.opticalHz - O.opticalFrequencyHz(810), 81e6, 1e-6, "AOM shift");
  // An objective flags a beam that overfills its pupil.
  const over = O.traceTrain({ source: beam({ w0Um: 9000 }), start: [0, 0, 0], dir: [1, 0, 0], elements: [{ ...O.objective({ fMm: 10, na: 0.5 }), at: 5, label: "obj" }] });
  assert.match(over.warnings[0], /overfills the pupil/);
});

test("wavelengths take their spectral colour, and invisible ones are marked false colour", () => {
  const dominant = (nm) => O.wavelengthRgb(nm).rgb.indexOf(Math.max(...O.wavelengthRgb(nm).rgb));
  assert.equal(dominant(450), 2);
  assert.equal(dominant(532), 1);
  assert.equal(dominant(650), 0);
  for (const nm of [369.5, 810, 1013]) assert.equal(O.wavelengthRgb(nm).falseColour, true);
  assert.equal(O.wavelengthRgb(493.5).falseColour, false);
});

test("the neutral-atom AOD bench puts a tone where the run's calibration does, from the raw DAC codes", async () => {
  const bundle = await run({ example: "neutral-bv14" });
  const bench = B.benchFor(bundle);
  const step = (16 * (1e12 / bundle.machine.dspPeriodPs)) / 65536 / bench.calibration.hzPerUm;
  let checked = 0;
  for (const tone of bundle.summary.tones.filter((t) => /^aod\d+\.[xy]\d+$/.test(t.part))) {
    const [aod, axis] = [tone.part.split(".")[0], tone.part.split(".")[1][0]];
    const train = bench.trains.find((t) => t.id === aod).train;
    const code = tone.freq > 32767 ? tone.freq - 65536 : tone.freq;
    const hz = (code * 16 * (1e12 / bundle.machine.dspPeriodPs)) / 65536;
    const traced = O.traceTrain(train, { rfHz: { [aod + " " + axis]: hz } });
    const um = bench.toSample(traced.plane.at)[axis === "x" ? 0 : 1];
    const expected = model.tonesAt(bundle, tone.opens).find((t) => t.part === tone.part).um;
    assert.ok(Math.abs(um - expected) < step, tone.part + " at batch " + tone.opens + ": " + um + " µm, the run says " + expected);
    assert.deepEqual(traced.warnings, []);
    checked++;
  }
  assert.ok(checked > 50);
  // The tweezer is diffraction-limited by the objective: about λ f / (π w) at the pupil.
  const spot = O.traceTrain(bench.trains.find((t) => t.id === "aod0").train).focus;
  assert.ok(spot.wxUm > 0.4 && spot.wxUm < 1.2, "tweezer waist " + spot.wxUm + " µm");
});

/** Every beam of a step comes from a window open at that step, and every open window of a lit part has its beams. */
function checkBeamsFollowWindows(bundle, bench, count) {
  const bindings = new Map(bundle.program.bindings.map((b) => [b.core + "/" + b.channel + "/" + b.slot, b]));
  const lit = new Set(bench.trains.map((t) => t.device));
  let on = 0, off = 0;
  for (let k = 0; k < count; k++) {
    const i = Math.floor((k * (bundle.frames.length - 1)) / (count - 1));
    const state = model.stateAt(bundle, i);
    const tones = new Map(model.tonesAt(bundle, state.atBatch).map((t) => [t.part, t.um]));
    const beams = B.beamsAt(bundle, bench, state, { tones });
    for (const b of beams) {
      assert.ok(b.window.opens <= state.atBatch && state.atBatch < b.window.closes, b.id + " is on outside its window at batch " + state.atBatch);
      assert.ok(state.openWindows.some((w) => w.id === b.window.id), b.id + " has no open window");
    }
    const expected = state.openWindows.filter((w) => lit.has(bindings.get(w.core + "/" + w.channel + "/" + w.slot)?.part));
    for (const w of expected) assert.ok(beams.some((b) => b.window.id === w.id), "window " + w.id + " is open and drives light, but no beam is on");
    if (beams.length) on++;
    else off++;
  }
  return { on, off };
}

test("neutral-atom beams are on exactly while their windows are open, and tweezers sit at tone crossings", async () => {
  const bundle = await run({ example: "neutral-bv14" });
  const bench = B.benchFor(bundle);
  const { on, off } = checkBeamsFollowWindows(bundle, bench, 160);
  assert.ok(on > 0 && off > 0);
  // Before the first frame nothing is lit.
  assert.deepEqual(B.beamsAt(bundle, bench, model.stateAt(bundle, -1), {}), []);
  // Every tweezer focuses at the crossing of its column and row tones; Rydberg and Raman light appear.
  const roles = new Set();
  for (let i = 0; i < bundle.frames.length; i += 25) {
    const state = model.stateAt(bundle, i);
    const tones = new Map(model.tonesAt(bundle, state.atBatch).map((t) => [t.part, t.um]));
    for (const b of B.beamsAt(bundle, bench, state, { tones })) {
      roles.add(b.role);
      if (b.role === "tweezer") {
        assert.ok(Math.abs(b.focusUm[0] - tones.get(b.tones[0])) < 1e-6 && Math.abs(b.focusUm[1] - tones.get(b.tones[1])) < 1e-6, b.id);
        assert.ok(b.hover.some(([k]) => k === "Optical frequency"));
      }
      if (b.role === "rydberg") {
        // The sheet is 10 µm high and 60 µm wide at the centre of the entanglement zone.
        close(b.geometry.plane.wxUm, 10, 0.02, b.id + " height");
        close(b.geometry.plane.wyUm, 60, 0.02, b.id + " width");
      }
    }
  }
  for (const role of ["tweezer", "rydberg", "raman"]) assert.ok(roles.has(role), "no " + role + " beam during the run");
});

test("a QCCD detection window lights 369.5 nm light on its own site and a fluorescence cone to its PMT", integration, async () => {
  const bundle = await run({ example: "qccd-ghz3" });
  const bench = B.benchFor(bundle);
  checkBeamsFollowWindows(bundle, bench, 120);
  const detect = bundle.summary.pulses.find((p) => /\.detect$/.test(p.part));
  const index = model.indexAtBatch(bundle, detect.opens + 1);
  const state = model.stateAt(bundle, index);
  const beams = B.beamsAt(bundle, bench, state, {});
  const site = detect.part.split(".")[1];
  const light = beams.find((b) => b.kind === "detect" && b.window.id === detect.id);
  assert.ok(light, "no detection beam in window " + detect.id);
  assert.equal(light.lambdaNm, 369.5);
  assert.equal(light.device, "site:" + site);
  const at = bench.toTable(bundle.machine.geometry.sites.find((s) => s.id === site).position);
  assert.ok(Math.hypot(...light.geometry.plane.at.map((v, k) => v - at[k])) < 1e-9, "the beam crosses its target plane at the site");
  assert.ok(light.geometry.plane.wxUm < 40, "it is focused on the site");
  const glow = beams.find((b) => b.kind === "fluorescence" && b.window.id === detect.id);
  assert.equal(glow.pmt, "zone." + site + ".pmt");
});

test("superconducting microwaves carry the qubit's frequency and the wire's delay", async () => {
  const bundle = await run({ example: "superconducting-feedforward", outcomes: { c: 1 } });
  assert.deepEqual(B.benchFor(bundle).trains, []);
  const freq = new Map(bundle.machine.geometry.qubits.map((q) => [q.id, q.frequencyHz]));
  const step = (16 * (1e12 / bundle.machine.dspPeriodPs)) / 65536;
  let checked = 0;
  for (let i = 0; i < bundle.frames.length; i += 3) {
    const state = model.stateAt(bundle, i);
    for (const m of B.microwaveAt(bundle, state)) {
      const w = state.openWindows.find((x) => x.id === m.window.id);
      const binding = bundle.program.bindings.find((b) => b.core === w.core && b.channel === w.channel && b.slot === w.slot);
      assert.ok(m.window.opens <= state.atBatch && state.atBatch < m.window.closes);
      if (m.kind === "drive") {
        const q = Number(m.part.replace("qubit", ""));
        assert.ok(Math.abs(m.carrierHz - freq.get(q)) <= step, m.id + " carrier " + m.carrierHz + " vs qubit " + freq.get(q));
        checked++;
      }
      if (binding) assert.equal(m.delayPs, binding.delayPs);
    }
  }
  assert.ok(checked > 0);
});
