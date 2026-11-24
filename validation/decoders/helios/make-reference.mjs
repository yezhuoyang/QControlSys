// Regenerates the reference files and firmware images in this directory.
//
//   node validation/decoders/helios/make-reference.mjs
//
// For each distance it samples syndromes, obtains the expected roots by compiling the upstream
// union_find.c natively with the host gcc and running it as upstream's README describes, and
// writes reference-d<D>.json. It then compiles the same source for a RISC-Q core with the
// reference syndromes in RAM and writes uf-d<D>.elf. Needs gcc and a clang with the riscv32
// target. Distance 3 also takes cases from upstream's own test vectors.
//
// Syndromes are sampled on upstream's decoding graph: every edge (a data-qubit error between
// two checks or at a boundary, or a measurement error between two rounds) flips with
// probability p and toggles the nodes at its ends. The generator is mulberry32 with a fixed
// seed, so the files are reproducible.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as helios from "../../../riscq/decoders/helios.mjs";
import { findClang } from "../../../riscq/toolchain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Edges of upstream's decoding graph: [{ a: [k, i, j], b: [k, i, j] | null }], as union_find() builds them. */
export function edges(d) {
  const out = [], half = (j) => Math.floor(j / 2);
  for (let k = 0; k < d; k++)
    for (let i = 0; i < d; i++)
      for (let j = 0; j < d; j++) {
        if (j === 0 || j === d - 1) {
          const a = i % 2 === 0 && j === 0 ? [k, i, 0] : i % 2 === 1 && j === 0 ? [k, i + 1, 0]
            : i % 2 === 0 ? [k, i + 1, half(j) - 1] : [k, i, half(j) - 1];
          out.push({ a, b: null });
        } else {
          const [a, b] = i % 2 === 0 && j % 2 === 0 ? [[k, i, half(j)], [k, i + 1, half(j) - 1]]
            : i % 2 === 0 ? [[k, i, half(j)], [k, i + 1, half(j)]]
            : j % 2 === 0 ? [[k, i, half(j) - 1], [k, i + 1, half(j)]] : [[k, i, half(j)], [k, i + 1, half(j)]];
          out.push({ a, b });
        }
      }
  for (let k = 0; k < d; k++)
    for (let i = 0; i < d + 1; i++)
      for (let j = 0; j < (d - 1) / 2; j++) out.push(k === 0 ? { a: [0, i, j], b: null } : { a: [k - 1, i, j], b: [k, i, j] });
  return out;
}

/** One syndrome: flip each edge with probability p. Returns 0/1 per node in k, i, j order. */
function sample(d, p, random) {
  const columns = (d - 1) / 2, index = ([k, i, j]) => (k * (d + 1) + i) * columns + j;
  const syndrome = new Array(helios.nodes(d)).fill(0);
  for (const edge of edges(d))
    if (random() < p) {
      syndrome[index(edge.a)] ^= 1;
      if (edge.b) syndrome[index(edge.b)] ^= 1;
    }
  return syndrome;
}

/** Expected roots from the upstream program compiled natively, run in the layout its paths assume. */
function nativeRoots(d, cases) {
  const work = path.join(os.tmpdir(), "qcontrol-helios-native-" + d);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(path.join(work, "software_code"), { recursive: true });
  mkdirSync(path.join(work, "test_benches", "test_data"), { recursive: true });
  const hex = (v) => (v >>> 0).toString(16).toUpperCase().padStart(8, "0");
  writeFileSync(path.join(work, "test_benches", "test_data", "input_data_" + d + "_rsc.txt"),
    cases.flatMap((c) => [c.id, ...c.syndrome]).map(hex).join("\n") + "\n");
  writeFileSync(path.join(work, "software_code", "union_find.c"), helios.source(d));
  const cwd = path.join(work, "software_code");
  execFileSync("gcc", ["union_find.c", "-o", "uf", "-lm"], { cwd, stdio: ["ignore", "ignore", "pipe"] });
  execFileSync(path.join(cwd, process.platform === "win32" ? "uf.exe" : "uf"), [], { cwd, stdio: "ignore" });
  const words = readFileSync(path.join(work, "test_benches", "test_data", "output_data_" + d + "_rsc.txt"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((line) => parseInt(line, 16));
  rmSync(work, { recursive: true, force: true });
  const record = 1 + helios.nodes(d);
  return cases.map((c, k) => {
    if (words[k * record] !== c.id) throw Error("The native run returned test " + words[k * record] + " where " + c.id + " was expected.");
    return words.slice(k * record + 1, (k + 1) * record);
  });
}

const weight = (syndrome) => syndrome.reduce((a, b) => a + b, 0);
const clang = findClang();
if (!clang) throw Error("A clang with the riscv32 target is needed to build the firmware images.");
const clangVersion = execFileSync(clang, ["--version"], { encoding: "utf8" }).split(/\r?\n/)[0];
const manifest = [];
for (const [d, counts] of [[3, { sparse: 4, dense: 6 }], [5, { sparse: 3, dense: 5 }], [7, { sparse: 2, dense: 4 }]]) {
  const random = mulberry32(0x48454c49 + d);
  const cases = [];
  let id = 1;
  const add = (syndrome, origin) => cases.push({ id: id++, origin, syndrome });
  add(new Array(helios.nodes(d)).fill(0), "no defect");
  // Draw until the wanted number of syndromes with a defect has been found at each rate.
  for (const [p, wanted, origin] of [[0.001, counts.sparse, "p = 0.001"], [0.01, counts.dense, "p = 0.01"]])
    for (let found = 0, tries = 0; found < wanted && tries < 100000; tries++) {
      const syndrome = sample(d, p, random);
      if (weight(syndrome) === 0) continue;
      add(syndrome, origin);
      found++;
    }
  const native = nativeRoots(d, cases);
  cases.forEach((c, k) => (c.roots = native[k]));
  if (d === 3) {
    // Upstream's own vectors: the first case of each syndrome weight, with upstream's roots.
    const upstream = helios.upstreamVectors();
    for (const w of [0, 1, 2]) {
      const v = upstream.find((x) => weight(x.syndrome) === w);
      cases.push({ id: 1000 + v.id, origin: "upstream test " + v.id, syndrome: v.syndrome, roots: v.roots });
    }
    // The native program agrees with upstream's published outputs on those cases.
    const again = nativeRoots(3, cases.slice(-3));
    again.forEach((roots, k) => {
      if (roots.join() !== cases[cases.length - 3 + k].roots.join()) throw Error("The native build disagrees with upstream's output vectors.");
    });
  }
  const { elf, command } = helios.build(d, cases);
  const name = "uf-d" + d + ".elf";
  writeFileSync(path.join(here, name), elf);
  writeFileSync(path.join(here, "reference-d" + d + ".json"), JSON.stringify({
    distance: d, nodes: helios.nodes(d), source: "union_find.c with D = " + d,
    expected: "roots from the upstream program compiled with the host gcc" + (d === 3 ? ", and upstream's output vectors for the upstream tests" : ""),
    sampling: "edge flips on upstream's decoding graph, mulberry32 seed 0x" + (0x48454c49 + d).toString(16),
    cases: cases.map((c) => ({ id: c.id, origin: c.origin, weight: weight(c.syndrome), syndrome: c.syndrome.join(""), roots: c.roots })),
  }, null, 1) + "\n");
  manifest.push({ distance: d, image: name, bytes: elf.length, sha256: createHash("sha256").update(elf).digest("hex"), cases: cases.length, command });
  console.log("distance " + d + ": " + cases.length + " cases, weights " + cases.map((c) => weight(c.syndrome)).join(" ") + ", " + name + " " + elf.length + " bytes");
}
writeFileSync(path.join(here, "images.json"), JSON.stringify({ compiler: clangVersion, images: manifest }, null, 1) + "\n");
