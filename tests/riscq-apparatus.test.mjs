// The apparatus view of the debugger places ions, atoms and light in space at a batch time
// (studio/riscq-model.js) on the layout of riscq/geometry.mjs. These tests replay runs and
// check those placements against the run's own records: the transport cycles of
// `derived.ionMoves`, the hardware instructions, the carrier updates and the effect frames.
// They test the reconstruction that the page draws. They do not test the drawing.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../riscq/examples.mjs";
import { HZ_PER_UM } from "../riscq/platforms/neutral.mjs";
import { BATCH_SIZE } from "../riscq/soc.mjs";
import * as model from "../studio/riscq-model.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = resolve(process.env.QCCD_STUDIO_ROOT || join(root, "..", "QCCD"));
const integration = { skip: existsSync(upstream) ? false : "QCCD Studio checkout not found" };

const distance = (a, b) => Math.hypot(...a.map((v, k) => v - b[k]));
const near = (a, b, tolerance, message) => assert.ok(distance(a, b) <= tolerance, message + ": " + JSON.stringify(a) + " is not within " + tolerance + " of " + JSON.stringify(b));

/** The geometry says what its positions are, and every apparatus part of the controller scene has an entry. */
function geometryIsExplicit(bundle, kind) {
  const geometry = bundle.machine.geometry;
  assert.equal(geometry.kind, kind);
  assert.ok(typeof geometry.units?.position === "string" && geometry.units.position.length > 0, "geometry states its position unit");
  for (const field of [geometry.basis, geometry.schematic])
    assert.ok(typeof field === "string" && field.length > 10, "geometry states its basis and what is schematic");
  for (const part of bundle.system.parts.filter((p) => p.kind === "device"))
    assert.ok(Array.isArray(geometry.parts[part.id]), "apparatus part " + part.id + " has no entry in geometry.parts");
  const elements = new Set(model.apparatusElements(bundle).map((element) => element.id));
  for (const [part, list] of Object.entries(geometry.parts))
    for (const id of list) assert.ok(elements.has(id), part + " maps to " + id + ", which the apparatus scene does not have");
}

/** Every hardware instruction that reaches the apparatus acts on elements of the apparatus scene. */
function instructionsReachTheScene(bundle) {
  const elements = new Set(model.apparatusElements(bundle).map((element) => element.id));
  const reaching = new Set(bundle.frames.filter((frame) => frame.op === "effect").map((frame) => frame.source));
  assert.ok(reaching.size > 0, "the run has effect frames");
  for (const { op } of model.hardwareOps(bundle)) {
    const targets = model.apparatusTargets(bundle, op.id);
    for (const id of targets) assert.ok(elements.has(id), op.id + " (" + op.op + ") acts on " + id + ", which the apparatus scene does not have");
    if (reaching.has(op.id)) assert.ok(targets.length > 0, op.id + " (" + op.op + ") reaches the apparatus but maps to no element of the scene");
  }
  // Each effect is lit for the batches of the window that caused it, on elements of the scene,
  // from the moment its signal arrives: the effect frame stands at the converter, and the
  // signal reaches the apparatus `arrivesPs` later, after its cable or transducer.
  const period = bundle.machine.dspPeriodPs;
  for (const frame of bundle.frames.filter((f) => f.op === "effect")) {
    const arrives = frame.state.arrivesPs === undefined ? frame.atBatch : Math.ceil(frame.state.arrivesPs / period);
    assert.ok(!model.litBetween(bundle, arrives - 1).some((item) => item.id === frame.id) || arrives === frame.atBatch,
      "effect " + frame.id + " is not lit before its signal arrives");
    const lit = model.litBetween(bundle, arrives).find((item) => item.id === frame.id);
    assert.ok(lit, "effect " + frame.id + " is lit when its signal arrives");
    assert.ok(lit.end > lit.start);
    assert.ok(lit.elements.length + lit.targets.length > 0, "effect " + frame.id + " lights nothing");
    for (const id of [...lit.elements, ...lit.targets]) assert.ok(elements.has(id), frame.id + " lights " + id);
    assert.ok(!model.litBetween(bundle, lit.end).some((item) => item.id === frame.id), "effect " + frame.id + " ends with its window");
  }
  assert.ok(model.runEnd(bundle) >= bundle.summary.elapsedBatches);
}

/** Ions rest on sites, end where their last delivered move names, and cross a segment in a straight line. */
function ionsFollowTheirMoves(bundle) {
  const geometry = bundle.machine.geometry, site = new Map(geometry.sites.map((s) => [s.id, s.position]));
  const moves = bundle.derived.ionMoves;
  assert.ok(moves.length > 0 && moves.every((record) => record.delivered));
  // Before the first cycle every ion rests where Studio's init cycle placed it.
  const start = model.ionPositionsAt(bundle, 0);
  assert.equal(start.length, geometry.ions.length);
  for (const placed of geometry.ions) {
    const ion = start.find((entry) => entry.ion === placed.id);
    assert.equal(ion.site, placed.site);
    assert.deepEqual(ion.position, site.get(placed.site), placed.id + " starts on " + placed.site);
    assert.equal(ion.moving, null);
  }
  // At the end every ion is at the position of the site its last delivered move names.
  const last = new Map();
  for (const record of moves) for (const move of record.moves) last.set(move.ion, move.to);
  const end = model.ionPositionsAt(bundle, model.runEnd(bundle));
  for (const [name, to] of last) {
    const ion = end.find((entry) => entry.ion === name);
    assert.equal(ion.site, to, name);
    assert.deepEqual(ion.position, site.get(to), name + " ends on " + to);
    assert.equal(ion.moving, null);
  }
  // Ions that share a site are told apart for drawing.
  const bySite = new Map();
  for (const ion of end) bySite.set(ion.site, [...(bySite.get(ion.site) ?? []), ion]);
  for (const group of bySite.values()) {
    assert.deepEqual(group.map((ion) => ion.slot).sort(), group.map((_, k) => k));
    assert.ok(group.every((ion) => ion.of === group.length));
  }
  // Inside each cycle the ion lies between its two sites, further along as the cycle passes.
  for (const record of moves)
    for (const move of record.moves) {
      const from = site.get(move.from), to = site.get(move.to), span = distance(from, to);
      let travelled = -1;
      for (const share of [0.25, 0.5, 0.75]) {
        const at = record.opens + (record.closes - record.opens) * share;
        const ion = model.ionPositionsAt(bundle, at).find((entry) => entry.ion === move.ion);
        assert.ok(Math.abs(ion.moving.fraction - share) < 1e-9, record.op + " is " + share + " through");
        assert.equal(ion.site, move.from);
        // On the path: the two legs add up to the segment, and the first leg grows with time.
        assert.ok(Math.abs(distance(from, ion.position) + distance(ion.position, to) - span) < 1e-9, move.ion + " is on the segment during " + record.op);
        assert.ok(Math.abs(distance(from, ion.position) - share * span) < 1e-9);
        assert.ok(distance(from, ion.position) > travelled);
        travelled = distance(from, ion.position);
      }
      near(model.ionPositionsAt(bundle, record.opens).find((entry) => entry.ion === move.ion).position, from, 1e-9, move.ion + " at the start of " + record.op);
      near(model.ionPositionsAt(bundle, record.closes).find((entry) => entry.ion === move.ion).position, to, 1e-9, move.ion + " at the end of " + record.op);
    }
  // A beam on a gate site is lit while its gate window lasts.
  for (const { op } of model.hardwareOps(bundle).filter((entry) => ["rotate", "ms", "measure"].includes(entry.op.op))) {
    const window = model.instructionWindow(bundle, op.id);
    const lit = model.litBetween(bundle, window.opens, window.closes).filter((item) => item.source === op.id);
    assert.ok(lit.some((item) => item.elements.some((id) => id.startsWith("site:"))), op.id + " lights a site");
  }
}

test("the transmon ring is schematic, and each pulse lights the qubit, coupler or resonator it reaches", async () => {
  for (const request of [{ example: "superconducting-feedforward", outcomes: { c: 1 } }, { example: "superconducting-repetition", outcomes: { s0: 1 } }]) {
    const bundle = await run(request);
    geometryIsExplicit(bundle, "transmon-ring");
    assert.match(bundle.machine.geometry.basis, /^Schematic/);
    instructionsReachTheScene(bundle);
    for (const { op } of model.hardwareOps(bundle)) {
      const window = model.instructionWindow(bundle, op.id);
      if (!window) continue;
      const lit = model.litBetween(bundle, window.opens, window.closes).filter((item) => item.source === op.id).flatMap((item) => item.elements);
      if (op.op === "cz") {
        const coupler = model.apparatusTargets(bundle, op.id).find((id) => id.startsWith("coupler:"));
        assert.ok(coupler && lit.includes(coupler), op.id + " lights the coupler of its pair");
        for (const qubit of op.qubits) assert.ok(lit.includes("qubit:" + qubit));
      } else if (op.op === "measure") assert.ok(lit.includes("resonator:" + op.qubits[0]), op.id + " lights the resonator");
      else assert.ok(lit.includes("qubit:" + op.qubits[0]), op.id + " lights its qubit");
    }
    // Virtual-Z and classical instructions play no pulse and act on no element.
    for (const { op, segment } of model.hardwareOps(bundle))
      if (op.op === "frame" || bundle.hardware.segments[segment].classical) assert.deepEqual(model.apparatusTargets(bundle, op.id), []);
    // Nothing of this platform moves.
    assert.deepEqual(model.ionPositionsAt(bundle, 100), []);
    assert.deepEqual(model.atomsAt(bundle, 100), []);
  }
});

test("each atom waits at its trap, travels with its tweezer and ends at the destination of its last move", async () => {
  const bundle = await run({ example: "neutral-bv14" });
  geometryIsExplicit(bundle, "atom-array");
  instructionsReachTheScene(bundle);
  const geometry = bundle.machine.geometry, ops = model.hardwareOps(bundle).map((entry) => entry.op);
  const moves = ops.filter((op) => op.op === "move");
  assert.ok(moves.length > 0);
  // Before anything plays, every atom is at the trap of the init instruction.
  const start = model.atomsAt(bundle, 0);
  assert.equal(start.length, geometry.atoms.length);
  for (const atom of geometry.atoms) assert.deepEqual(start.find((a) => a.atom === atom.id), { atom: atom.id, position: atom.position, held: null });
  assert.deepEqual(model.tweezersAt(bundle, 0).flatMap((aod) => aod.spots), []);
  // At the end every atom rests, released, at the `to` of its last move.
  const last = new Map(geometry.atoms.map((atom) => [atom.id, atom.position]));
  for (const move of moves) for (const entry of move.atoms) last.set(entry.atom, entry.to);
  const end = model.atomsAt(bundle, model.runEnd(bundle));
  for (const [atom, to] of last) assert.deepEqual(end.find((a) => a.atom === atom), { atom, position: to, held: null });
  // One code of the 16-bit carrier in µm, through the AOD calibration of the run.
  const step = (BATCH_SIZE * 1e12) / bundle.machine.dspPeriodPs / 65536 / HZ_PER_UM;
  assert.equal(geometry.calibration.hertzPerMicrometre, HZ_PER_UM);
  // A tone reaches the AOD later than its channel plays it: the lag of the effect frames.
  for (const aod of geometry.aods)
    for (const channel of [...aod.columns, ...aod.rows]) {
      const effect = bundle.frames.find((f) => f.op === "effect" && bundle.frames.find((p) => p.id === f.parents[0]).part === channel);
      const cause = bundle.frames.find((p) => p.id === effect.parents[0]);
      assert.equal(model.apparatusLag(bundle, channel), effect.state.arrivesPs / bundle.machine.dspPeriodPs - cause.state.opens, "lag of " + channel);
      assert.ok(model.apparatusLag(bundle, channel) > 0);
    }
  /** Position of a tone at the AOD at a batch: the carrier update its channel made one lag earlier. */
  const toneAt = (channel, at) => model.tonesAt(bundle, at - model.apparatusLag(bundle, channel)).find((tone) => tone.part === channel).um;
  let pickup = null;
  for (const op of ops) {
    if (op.op === "pickup") pickup = op;
    if (op.op !== "move") continue;
    const window = model.instructionWindow(bundle, op.id), lift = model.instructionWindow(bundle, pickup.id);
    assert.ok(lift.closes <= window.opens, "the pickup of " + op.id + " ends before the move begins");
    for (const entry of op.atoms) {
      // Until its pickup opens the atom rests at the move's `from`.
      const before = model.atomsAt(bundle, lift.opens - 1).find((a) => a.atom === entry.atom);
      assert.deepEqual(before.position, entry.from, "atom " + entry.atom + " before " + pickup.id);
      assert.equal(before.held, null);
      // During the pickup it is held at `from` while the tweezer ramps up.
      const lifting = model.atomsAt(bundle, (lift.opens + lift.closes) / 2).find((a) => a.atom === entry.atom);
      assert.deepEqual(lifting.position, entry.from);
      assert.equal(lifting.held.phase, "pickup");
      const ramp = model.tweezersAt(bundle, (lift.opens + lift.closes) / 2).find((aod) => aod.aod === op.aod).spots.find((spot) => spot.atom === entry.atom);
      assert.ok(Math.abs(ramp.level - 0.5) < 0.01, "the tweezer of atom " + entry.atom + " is half up halfway through " + pickup.id);
      // During the move it is where its two tones are, between `from` and `to`, moving on.
      let travelled = -1;
      for (const share of [0.3, 0.5, 0.7]) {
        const at = window.opens + (window.closes - window.opens) * share;
        const atom = model.atomsAt(bundle, at).find((a) => a.atom === entry.atom);
        assert.equal(atom.held.phase, "move");
        assert.equal(atom.held.op, op.id);
        assert.deepEqual(atom.position, [toneAt(atom.held.column, at), toneAt(atom.held.row, at)], "atom " + entry.atom + " is at its tones during " + op.id);
        const spot = model.tweezersAt(bundle, at).find((aod) => aod.aod === op.aod).spots.find((s) => s.atom === entry.atom);
        assert.deepEqual([spot.x, spot.y], atom.position, "the tweezer carries atom " + entry.atom);
        assert.equal(spot.level, 1);
        for (const axis of [0, 1]) {
          const low = Math.min(entry.from[axis], entry.to[axis]) - step, high = Math.max(entry.from[axis], entry.to[axis]) + step;
          assert.ok(atom.position[axis] >= low && atom.position[axis] <= high, "atom " + entry.atom + " stays between from and to on axis " + axis);
        }
        assert.ok(distance(atom.position, entry.from) >= travelled, "atom " + entry.atom + " moves away from its start during " + op.id);
        travelled = distance(atom.position, entry.from);
      }
      assert.ok(travelled > 0 || distance(entry.from, entry.to) === 0);
      // At the last batch of the move the tones have reached the destination within one code.
      near(model.atomsAt(bundle, window.closes - 1).find((a) => a.atom === entry.atom).position, entry.to, step * Math.SQRT2, "atom " + entry.atom + " at the end of " + op.id);
    }
  }
  // A Rydberg pulse lights its beam and names the zone and the atoms it addresses.
  const rydberg = ops.find((op) => op.op === "rydberg"), window = model.instructionWindow(bundle, rydberg.id);
  const lit = model.litBetween(bundle, window.opens, window.closes).find((item) => item.source === rydberg.id);
  assert.deepEqual(lit.elements, ["beam:rydberg"]);
  assert.ok(lit.targets.includes("zone:entanglement" + rydberg.params.zone));
  for (const atom of rydberg.qubits) assert.ok(lit.targets.includes("atom:" + atom));
});

test("each ion of the compiled GHZ program rests on its site and crosses each segment between its two sites", integration, async () => {
  const bundle = await run({ example: "qccd-ghz3", outcomes: { q0: 1, q2: 1 } });
  geometryIsExplicit(bundle, "ion-trap");
  assert.equal(bundle.machine.geometry.units.micrometresPerUnit, 750);
  instructionsReachTheScene(bundle);
  ionsFollowTheirMoves(bundle);
});

test("both ions of the Studio rotation travel their loop segment by segment", integration, async () => {
  const bundle = await run({ example: "qccd-rotation" });
  geometryIsExplicit(bundle, "ion-trap");
  instructionsReachTheScene(bundle);
  ionsFollowTheirMoves(bundle);
  // Two ions move in each cycle, and neither jumps: a small step in time is a small step in space.
  const record = bundle.derived.ionMoves[0], span = record.closes - record.opens;
  assert.equal(record.moves.length, 2);
  for (const move of record.moves) {
    const a = model.ionPositionsAt(bundle, record.opens + span * 0.5).find((ion) => ion.ion === move.ion).position;
    const b = model.ionPositionsAt(bundle, record.opens + span * 0.5 + 1).find((ion) => ion.ion === move.ion).position;
    assert.ok(distance(a, b) > 0 && distance(a, b) < 2 / span, move.ion + " moves by one batch of its cycle");
  }
});

test("a decoder run has no apparatus, and its lattice shows each syndrome and the roots as they are reported", async () => {
  const bundle = await run({ example: "decoder-helios-d3" });
  assert.equal(bundle.machine.geometry, undefined);
  assert.deepEqual(model.apparatusElements(bundle), []);
  assert.deepEqual(model.litBetween(bundle, 0, model.runEnd(bundle)), []);
  for (const { op } of model.hardwareOps(bundle)) assert.deepEqual(model.apparatusTargets(bundle, op.id), []);
  const lattice = model.decodeLattice(bundle);
  assert.deepEqual(lattice, { distance: 3, rounds: 3, rows: 4, columns: 1, nodes: 12 });
  const decodes = bundle.derived.decodes;
  assert.ok(decodes.length > 1);
  assert.equal(model.decodeAt(bundle, 0).read, false);
  decodes.forEach((decode, k) => {
    // Once its input is read, the lattice shows this syndrome's defects and no root yet.
    const read = model.decodeAt(bundle, decode.inputAtBatch);
    assert.equal(read.index, k);
    assert.equal(read.read, true);
    assert.equal(read.reported, 0);
    assert.equal(read.nodes.filter((node) => node.defect).length, decode.weight);
    assert.ok(read.nodes.every((node, n) => node.index === n && node.root === null));
    // After the last output every node has the root the firmware stored, decoded from 0x00KKIIJJ.
    const done = model.decodeAt(bundle, decode.lastOutputAtBatch);
    assert.equal(done.reported, lattice.nodes);
    done.nodes.forEach((node, n) => {
      const word = decode.roots[n], target = done.nodes[node.root];
      assert.deepEqual([target.round, target.row, target.column], [(word >>> 16) & 255, (word >>> 8) & 255, word & 255]);
    });
    assert.equal(new Set(done.nodes.map((node) => node.root)).size, decode.clusters);
    // Roots appear one by one between the first and the last output.
    const half = model.decodeAt(bundle, (decode.firstOutputAtBatch + decode.lastOutputAtBatch) / 2).reported;
    assert.ok(half > 0 && half < lattice.nodes);
  });
  // A syndrome with no defect leaves every node its own root.
  const quiet = decodes.findIndex((decode) => decode.weight === 0);
  assert.ok(model.decodeAt(bundle, decodes[quiet].lastOutputAtBatch).nodes.every((node) => node.root === node.index));
});
