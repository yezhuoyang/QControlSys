// A real decoder on the virtual control core: the C union-find of the Helios FPGA decoder,
// compiled with clang and RISC-Q's firmware runtime, runs as RV32I firmware in the Lean model.
// Its outputs are compared with upstream's published vectors and with the upstream program
// compiled natively (validation/decoders/helios/make-reference.mjs wrote those references).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as helios from "../riscq/decoders/helios.mjs";
import { findClang, elfSymbols } from "../riscq/toolchain.mjs";
import { run } from "../riscq/examples.mjs";
import * as model from "../studio/riscq-model.js";

const file = (name) => readFileSync(new URL("../validation/decoders/helios/" + name, import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const images = JSON.parse(file("images.json"));

test("the decoder source is Helios's union_find.c with only its distance constant changed", () => {
  // The vendored file is byte-identical to software_code/union_find.c at commit 622d85d.
  assert.equal(sha256(file("union_find.c")), "29a8af6baafdd401061e31b7f4f8c2c911733474fd445e1853bafc4dfc866abc");
  const upstream = file("union_find.c").toString("utf8").split(/\r?\n/), mine = helios.source(5).split(/\r?\n/);
  const changed = upstream.map((line, i) => [line, mine[i]]).filter(([a, b]) => a !== b);
  assert.deepEqual(changed, [["#define D 13", "#define D 5"]]);
  // Upstream ships 1000 distance-3 test cases: 959 without a defect, 19 with one and 22 with two.
  const vectors = helios.upstreamVectors();
  const weights = vectors.map((v) => v.syndrome.reduce((a, b) => a + b, 0));
  assert.deepEqual([vectors.length, weights.filter((w) => w === 0).length, weights.filter((w) => w === 1).length, weights.filter((w) => w === 2).length], [1000, 959, 19, 22]);
  // The committed images are the ones images.json describes, and each contains the decoder's functions.
  for (const image of images.images) {
    assert.equal(sha256(file(image.image)), image.sha256);
    const names = elfSymbols(new Uint8Array(file(image.image))).filter((s) => s.kind === "function").map((s) => s.name);
    for (const name of ["union_find", "grow", "merge", "get_root", "main", "fscanf", "fprintf"]) assert.ok(names.includes(name), name);
  }
});

test("at distance 3 the firmware returns the reference root of every node, including upstream's own tests", async () => {
  const c = await helios.conformance(3);
  assert.equal(c.result.summary.status, "quiescent");
  assert.deepEqual(c.result.summary.faults, []);
  assert.ok(c.result.summary.cores[0].done);
  assert.equal(c.cases.length, 14);
  assert.ok(c.cases.every((x) => x.matches), "a root differs from the reference");
  // Three of the cases are upstream test vectors, checked against upstream's published outputs.
  assert.deepEqual(c.cases.filter((x) => /^upstream test/.test(x.origin)).map((x) => [x.id, x.weight]), [[1001, 0], [1022, 1], [1051, 2]]);
  // Each syndrome is 12 values in and an id and 12 roots out, stored to the host window.
  assert.equal(c.result.summary.host.length, 14 * 13);
  // Decode time in the model: 8,579 batches (17.2 µs at 2 ns) with no defect. A defect makes
  // the clusters grow for more passes: 34 µs to 58 µs here.
  assert.equal(c.cases[0].decodeBatches, 8579);
  const withDefect = c.cases.filter((x) => x.weight > 0).map((x) => x.decodeNs);
  assert.ok(Math.min(...withDefect) > 33000 && Math.max(...withDefect) < 59000);
  // Without a defect every node is its own cluster. With defects some nodes share a root.
  assert.equal(c.cases[0].clusters, 12);
  assert.ok(c.cases.filter((x) => x.weight > 0).every((x) => x.clusters < 12));
});

test("at distance 5 the firmware agrees with the natively compiled upstream program", async () => {
  const c = await helios.conformance(5);
  assert.deepEqual(c.result.summary.faults, []);
  assert.equal(c.nodes, 60);
  assert.ok(c.cases.length === 9 && c.cases.every((x) => x.matches));
  // 94 µs without a defect and up to 285 µs with defects: the program visits every edge on every pass.
  assert.equal(Math.round(c.cases[0].decodeNs / 1000), 94);
  assert.ok(c.cases.every((x) => x.decodeNs < 290000));
});

test("at distance 7 the firmware agrees with the natively compiled upstream program", { skip: process.env.QCONTROL_SLOW ? false : "set QCONTROL_SLOW=1 (about 40 s)" }, async () => {
  const c = await helios.conformance(7);
  assert.deepEqual(c.result.summary.faults, []);
  assert.ok(c.cases.length === 7 && c.cases.every((x) => x.matches));
});

const clang = findClang();
const sameCompiler = clang && execFileSync(clang, ["--version"], { encoding: "utf8" }).split(/\r?\n/)[0] === images.compiler;
test("rebuilding the distance-3 image from source gives the committed bytes", { skip: sameCompiler ? false : "needs " + images.compiler + " with the riscv32 target" }, () => {
  const { elf } = helios.build(3, helios.reference(3).cases);
  assert.equal(sha256(elf), images.images.find((image) => image.distance === 3).sha256);
  // A syndrome of the wrong size is rejected before the compiler runs.
  assert.throws(() => helios.build(3, [{ id: 1, syndrome: [0, 1] }]), /has 12 values of 0 or 1/);
});

test("the decoder run is a debugger bundle: phases with frames, decodes with times, state that replays", async () => {
  const bundle = await run({ example: "decoder-helios-d3" });
  assert.equal(bundle.platform, "decoder");
  assert.deepEqual(bundle.hardware.segments[0].ops.map((op) => op.id), ["load", "decode", "report"]);
  assert.ok(bundle.derived.decodes.length === 14 && bundle.derived.decodes.every((d) => d.matchesReference));
  // Each decode names the frames at which its input was complete and its roots were stored.
  const byId = new Map(bundle.frames.map((f) => [f.id, f]));
  for (const d of bundle.derived.decodes) {
    assert.equal(byId.get(d.frames.input).atBatch, d.inputAtBatch);
    assert.equal(byId.get(d.frames.firstOutput).state.store, d.id);
    assert.equal((d.firstOutputAtBatch - d.inputAtBatch) * 2, d.decodeNs);
  }
  // The frames of the load and report phases carry their phase as source.
  assert.ok(bundle.frames.every((f) => [undefined, "", "load", "report"].includes(f.source)));
  assert.ok(["load", "report"].every((phase) => bundle.frames.some((f) => f.source === phase)));
  // The host words rebuilt by the debugger model equal the summary.
  const end = model.stateAt(bundle, bundle.frames.length - 1);
  assert.deepEqual(end.host.map((h) => h.value), bundle.summary.host.map((h) => h.value));
  assert.equal(end.cores[0].done, true);
});
