// The hardware design editor (studio/riscq-design.html) edits a riscq-design document through
// studio/riscq-design-doc.js and asks riscq/design-service.mjs to check it. These tests apply the
// editor's edits without a browser and run the result, so a headless agent and a person on the
// page reach the same design and the same run.
import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../riscq/examples.mjs";
import * as design from "../riscq/design.mjs";
import { designService } from "../riscq/design-service.mjs";
import * as D from "../studio/riscq-design-doc.js";
import * as layers from "../studio/riscq-layers.js";

const { design: ring, qasm } = designService("/");
const check = (doc) => designService("/check", {}, doc);
const rightAngled = (route) => route.slice(1).every((p, k) => p.filter((v, a) => Math.abs(v - route[k][a]) > 1e-9).length <= 1);

test("the editor's wire timing equals the server's for every wire of the ring", () => {
  const { media } = designService("/rules");
  for (const w of ring.wires) {
    const server = design.wireTiming(w);
    assert.equal(D.routeLength(w.routeMm), server.lengthMm, w.id);
    assert.equal(D.wireDelayPs(w, media), server.delayPs, w.id);
  }
  assert.deepEqual(check(ring).errors, []);
});

test("moving a part drags its wire ends and keeps right-angled routes right-angled", () => {
  const doc = D.clone(ring);
  D.movePart(doc, "dac0", [-90, -90, 0]);
  D.movePart(doc, "qubit0", [710, 4, -350]);
  for (const w of D.wiresAt(doc, "dac0").concat(D.wiresAt(doc, "qubit0"))) {
    assert.ok(rightAngled(w.routeMm), w.id + " " + JSON.stringify(w.routeMm));
    assert.deepEqual(w.routeMm[0], D.part(doc, w.from).centerMm);
    assert.deepEqual(w.routeMm.at(-1), D.part(doc, w.to).centerMm);
  }
  assert.deepEqual(check(doc).errors, []);
  // 150 mm more coax at 200 mm/ns is 750 ps later.
  const before = check(ring).pulses.find((p) => p.id === "qubit0.x90").delayPs, after = check(doc).pulses.find((p) => p.id === "qubit0.x90").delayPs;
  assert.equal(after - before, design.wireTiming(D.wire(doc, "drive0")).delayPs - design.wireTiming(D.wire(ring, "drive0")).delayPs);
  assert.ok(after - before >= 750);
});

test("a qubit added and coupled in the editor runs a program, and its pulses reach its own parts", async () => {
  const doc = D.firstQubits(ring, 3);
  assert.deepEqual(check(doc).errors, []);
  const q = D.addQubit(doc, doc.qubits[0]);
  D.addCoupling(doc, 2, q, doc.couplings[0]);
  const verdict = check(doc);
  assert.deepEqual(verdict.errors, []);
  assert.deepEqual(verdict.warnings, []);
  const program = 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[4] q;\nbit c;\nh q[2];\ncx q[2], q[3];\nc = measure q[3];\n';
  const bundle = await run({ platform: "superconducting", qasm: program, design: doc, outcomes: { c: 1 } });
  assert.equal(bundle.summary.status, "quiescent");
  assert.deepEqual(bundle.summary.faults, []);
  assert.deepEqual(bundle.derived.bits, { c: 1 });
  // Every effect on the new qubit arrives after the delay of its own drive line.
  const drive = D.wiresAt(doc, doc.qubits[q].part).find((w) => w.to === doc.qubits[q].part);
  const effects = bundle.frames.filter((f) => f.op === "effect" && f.part === doc.qubits[q].part);
  assert.ok(effects.length > 0);
  for (const f of effects) if (f.state.detail.kind === "drive") assert.equal(f.state.arrivesPs - f.atPs, design.wireTiming(drive).delayPs);
  // The debugger's chip view places the qubits where the design puts them.
  const chip = layers.chipLayout(bundle);
  for (const entry of doc.qubits) assert.deepEqual(chip.devices.get(entry.part), D.part(doc, entry.part).centerMm.slice(0, 2));
  assert.deepEqual(chip.qubitParts, doc.qubits.map((e) => e.part));
});

test("removing a qubit removes what only it needed and renumbers the couplers", () => {
  const doc = D.clone(ring);
  D.removeQubit(doc, 1);
  assert.equal(doc.qubits.length, 7);
  assert.ok(!D.part(doc, "qubit1") && !D.part(doc, "q1"));
  assert.ok(doc.couplings.every((c) => c.qubits.every((i) => i < 7)));
  assert.deepEqual(check(doc).errors, []);
});

test("three qubits of the ring cut out in the editor play the Bell program as the full ring does", async () => {
  const full = await run({ platform: "superconducting", qasm, design: ring, outcomes: { c: 1 } });
  const cut = await run({ platform: "superconducting", qasm, design: D.firstQubits(ring, 3), outcomes: { c: 1 } });
  const windows = (b) => b.summary.pulses.map((p) => [p.part, p.kind, p.opens - b.summary.pulses[0].opens, p.dur, p.freq, p.amp, p.phase]);
  assert.deepEqual(windows(cut), windows(full));
  assert.deepEqual(cut.derived.bits, full.derived.bits);
});

test("renaming keeps every reference, and a broken rule names the parts it concerns", async () => {
  const doc = D.firstQubits(ring, 3);
  assert.ok(D.renamePart(doc, "qubit0", "Q_A"));
  assert.ok(D.renamePart(doc, "q0", "ctrl_A"));
  assert.ok(!D.renamePart(doc, "dac8", "Q_A"), "an id in use is refused");
  assert.deepEqual(check(doc).errors, []);
  const bundle = await run({ platform: "superconducting", qasm, design: doc, outcomes: { c: 1 } });
  assert.deepEqual(bundle.summary.faults, []);
  assert.ok(bundle.system.parts.some((p) => p.id === "Q_A"));
  assert.equal(layers.chipLayout(bundle).types.get("Q_A"), "qubit");
  D.removeWire(doc, "return0");
  const [message] = check(doc).errors;
  assert.match(message, /no wire leads from resonator0 back to adc12/);
  assert.deepEqual(D.idsIn(doc, message).map((x) => x.id), ["Q_A", "resonator0", "adc12"]);
  // Drawing it again with the wire tool satisfies the rule.
  D.connect(doc, "resonator0", "adc12");
  assert.deepEqual(check(doc).errors, []);
});
