// The logical-qubit reproductions (riscq/ftqvm/logical.mjs): a paper's circuit on its twin with the
// compiled decoder in the same Lean run and a pulse conditioned on its result. These use the stored
// noise and bench of each circuit (validation/ftqvm/papers/<dir>/graph-*.json), so no Python is
// needed; the decoder image comes from the image cache, or from clang when it is missing there.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { PAPERS_LOGICAL, LOGICAL_DESIGNS, logicalRow } from "../riscq/ftqvm/logical.mjs";
import { LOGICAL_REPRODUCTIONS } from "../riscq/ftqvm/logical-reproductions.mjs";

const cache = (dir, file) => new URL("../validation/ftqvm/papers/" + dir + "/graph-" + file.replace(/\.stim$/, "") + ".json", import.meta.url);

test("every logical paper has a page entry, a design and stored circuits", () => {
  for (const r of LOGICAL_REPRODUCTIONS) {
    const p = PAPERS_LOGICAL[r.id];
    assert.ok(p, r.id + " has a twin");
    const params = LOGICAL_DESIGNS[r.id].params();
    assert.equal(params[0].key, "circuit");
    assert.deepEqual(params[0].options.map((o) => o.value), p.circuits.map((c) => c.file));
    for (const x of params.slice(1)) assert.ok(x.source, r.id + ": " + x.key + " says where its value comes from");
  }
});

const luthra = PAPERS_LOGICAL["luthra-2026"], xr1 = luthra.circuits[0];
test("qLDPC surgery on the H2 twin: every operation in its window, the decoder's result drives the pulse", { skip: !existsSync(cache(luthra.dir, xr1.file)) && "no stored run", timeout: 600_000 }, async () => {
  const { row, run } = await logicalRow(luthra, xr1, { cached: true });
  assert.equal(row.conforms, true, JSON.stringify(row.byKind));
  assert.equal(row.track.device.kind, "ions-ring");
  assert.ok(row.track.moves.length > 0, "ions are moved to their partners");
  // Each measurement is its own exposure of its gate zone's camera, inside its window.
  assert.equal(row.byKind.measure.ok, row.byKind.measure.count);
  const i = row.decoder.inRun;
  // The compiled decoder's correction is PyMatching's on this shot, and a 1 fires the pulse.
  assert.equal(i.mask, i.pymatching);
  assert.equal(i.fired, i.mask & 1 ? 1 : 0);
  assert.ok(i.toDecoderNs > 0 && i.computeNs > 0 && i.toPulseNs > i.computeNs, JSON.stringify(i));
  assert.ok(run.latency.afterDecodeNs < 2000, "the conditioned pulse follows the result within 2 µs");
});

const caune = PAPERS_LOGICAL["caune-2024"], ff = caune.circuits[2];
test("on a paper's timeline a gate longer than its layer is late", { skip: !existsSync(cache(caune.dir, ff.file)) && "no stored run", timeout: 600_000 }, async () => {
  const paper = await LOGICAL_DESIGNS["caune-2024"].run({ circuit: ff.file });
  assert.equal(paper.rows[0].conforms, true, JSON.stringify(paper.rows[0].byKind));
  // The executed programs' CZ layers last 68–176 ns: a 200 ns CZ runs into the next layer.
  const slow = await LOGICAL_DESIGNS["caune-2024"].run({ circuit: ff.file, czNs: 200 });
  assert.equal(slow.rows[0].conforms, false);
  assert.ok(slow.rows[0].byKind.CZ.ok < slow.rows[0].byKind.CZ.count);
});

test("an edit reruns on the edited machine: slower MS gates lengthen the shot", { skip: !existsSync(cache(luthra.dir, xr1.file)) && "no stored run", timeout: 600_000 }, async () => {
  const base = await LOGICAL_DESIGNS["luthra-2026"].run({ circuit: xr1.file });
  const slow = await LOGICAL_DESIGNS["luthra-2026"].run({ circuit: xr1.file, twoQubitNs: 50000 });
  assert.equal(slow.rows[0].conforms, true);
  assert.ok(slow.rows[0].circuitNs > base.rows[0].circuitNs);
});
