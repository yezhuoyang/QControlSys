// Published experiments as logical programs, compiled with system calls onto digital twins of
// the machines they ran on (riscq/ftqvm/twins.mjs).
//
// A program is written at the compiler's encoded level (.qec) when the experiment is defined by its
// rounds, as a memory experiment is; the code declarations come from the compiler itself
// (prepare_qec on a one-line program of that code and distance), so the code is the compiler's.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ftc from "./ftcompiler.mjs";
import * as specText from "./spec.mjs";
import * as qsysasm from "./qsysasm.mjs";
import { byId } from "./reproductions.mjs";

/** What a reader of /reproduce sees of one run: program, listing, spec with sources, conformance. */
export function details(last, qec) {
  // The listing as flat QSysASM (riscq/ftqvm/qsysasm.mjs): its machine and factory headers, then one
  // statement per operation. The compiler's gadget contracts are its own input and are not shown.
  const text = last.listing?.qsysasm ?? qsysasm.canonical(last.listing ?? { ops: [] }).text;
  return {
    programText: readFileSync(qec, "utf8"),
    listingHead: qsysasm.head(text, 40),
    listingLines: last.listing?.ops.length ?? 0,
    machineText: qsysasm.headerOf(specText.machineText(last.spec)),
    spec: last.spec.machine, factories: last.spec.factories,
    byKind: last.report.byKind, slack: last.slack,
    track: last.report.track,
  };
}

/**
 * What a design page needs to run a row again on an edited twin (riscq/ftqvm/designs.mjs): the
 * compiled listing (the compiler's output, fixed), its distance and the twin it ran on. The CLI writes
 * it to validation/ftqvm/twins/<id>/<key>.json, not into the page's data.
 */
const twinSource = (key, label, platform, distance, listing) => ({ key, label, platform, distance, listing: { ops: listing.ops.map(({ stack, ...o }) => o) } });

/** Split each row's twin source off into its own file; record any newly measured decode times. */
async function writeTwins(id, rows) {
  const dir = join("validation", "ftqvm", "twins", id);
  mkdirSync(dir, { recursive: true });
  for (const row of rows) {
    if (!row._twin) continue;
    writeFileSync(join(dir, row._twin.key + ".json"), JSON.stringify({ id, generated: new Date().toISOString(), ...row._twin }) + "\n");
    row.twinKey = row._twin.key;
    delete row._twin;
  }
  const { saveDecoderTimes } = await import("./decoder.mjs");
  saveDecoderTimes();
}

/** The compiler's declaration of the distance-d surface code, as prepare_qec writes it. */
export async function surfaceCodes(d, dir) {
  mkdirSync(dir, { recursive: true });
  const qppm = join(dir, "memory-d" + d + ".qppm"), qec = join(dir, "memory-d" + d + ".qec");
  writeFileSync(qppm, "\ncode surface d=" + d + "\n\nparams  n\n\nprogram[q: 1, c: 1]:\n  measure Z data[0] -> c[0]\n");
  await ftc.prepareQec(qppm, qec, { code: "surface", distance: d, specialize: { n: 1 } });
  const text = readFileSync(qec, "utf8");
  return text.slice(0, text.indexOf("program["));
}

/**
 * Google Quantum AI, Nature 638, 920 (2025): a surface-code memory of distance d over R cycles.
 * One logical qubit; R rounds of every check; the syndrome decoded. (The paper reads the data
 * qubits out at the end and decodes with the final round; the readout here is not part of the
 * listing, because the compiler's .qec has no transversal data readout in this form.)
 */
export async function googleMemory(d, rounds, dir) {
  const checks = d * d - 1;
  const codes = await surfaceCodes(d, dir);
  const body = `program[LogicData: 1, c: 0, ancilla: ${checks * rounds}] (Surface[1] LogicData):\n` +
    `  extract LogicData[0][0] rounds=${rounds} using ancilla[0,${checks * rounds}) -> syndrome[0,${checks * rounds})\n` +
    `  decode rounds=${rounds} syndrome[0,${checks * rounds})\n`;
  const path = join(dir, `google-memory-d${d}-r${rounds}.qec`);
  writeFileSync(path, codes + body);
  return path;
}

/**
 * Run Google's memory on the Willow twin for each distance: the compiler lowers it with system
 * calls against the spec the twin's trace derives, and the run must conform. Returns rows that
 * put the twin's numbers beside the paper's.
 */
export async function googleExperiment({ distances = [3, 5, 7], rounds = 10, dir, baseMachine } = {}) {
  const { deriveSpec } = await import("./derive.mjs");
  const { transmonTwin } = await import("./platforms.mjs");
  const { willow } = await import("./twins.mjs");
  const device = willow();
  const rows = [];
  for (const d of distances) {
    const sub = join(dir, "d" + d);
    const qec = await googleMemory(d, rounds, sub);
    const { iterations } = await deriveSpec({ platform: transmonTwin(device), qec, distance: d, baseMachine, dir: sub });
    const last = iterations.at(-1), round = last.contracts?.surfaceRound;
    const m = Object.fromEntries(Object.entries(last.spec.machine).map(([k, v]) => [k, v.value]));
    rows.push({
      distance: d, rounds, qubits: last.sites, ops: last.listing.ops.length, conforms: last.report.conforms, verdict: last.verdict,
      gate1qNs: m.gate1q_ns, gate2qNs: m.gate2q_ns, measureNs: m.measure_ns, resetNs: m.reset_ns,
      roundNs: round?.runtime, roundHardwareNs: round?.hardware.runtime, roundGates: round?.gates,
      decoderNs: m.decoder_latency_ns, makespanNs: last.makespanNs,
      paper: { cycleNs: device.published.cycleNs.value, decoderLatencyNsAtD5: device.published.decoderLatencyNs.value },
      ...details(last, qec),
      _twin: twinSource("d" + d, "d = " + d + ", " + rounds + " rounds", { kind: "transmonTwin", device: "willow", options: { qubitsPerCore: 1, decoders: 1, coresPerDecoder: 4 } }, d, last.listing),
    });
  }
  return { device: { id: device.id, title: device.title, basis: device.basis, durations: device.durations, published: device.published }, rows };
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const which = process.argv[2] ?? "google";
  const out = join("validation", "ftqvm", "papers");
  mkdirSync(out, { recursive: true });
  if (which === "google") {
    const { tmpdir } = await import("node:os");
    const result = await googleExperiment({ dir: join(tmpdir(), "quantumos-google-" + process.pid), baseMachine: join("validation", "ftqvm", "base.machine"), rounds: Number(process.argv[3] ?? 10) });
    await writeTwins("google-2025", result.rows);
    writeFileSync(join(out, "google-2025.json"), JSON.stringify({ meta: byId("google-2025"), generated: new Date().toISOString(), ...result }, null, 1));
    const md = ["| d | Rounds | Qubits | Ops | Conforms | Compiled round (µs) | Paper cycle (µs) | Gates per round | Decoder (µs) |", "|---|---|---|---|---|---|---|---|---|",
      ...result.rows.map((r) => `| ${r.distance} | ${r.rounds} | ${r.qubits} | ${r.ops} | ${r.conforms ? "yes" : "no"} | ${(r.roundNs / 1000).toFixed(2)} | ${(r.paper.cycleNs / 1000).toFixed(1)} | ${r.roundGates} | ${(r.decoderNs / 1000).toFixed(1)} |`)].join("\n") + "\n";
    writeFileSync(join(out, "google-2025.md"), md);
    console.log(md);
  }
  if (which === "quantinuum") {
    const { tmpdir } = await import("node:os");
    const result = await quantinuumExperiment({ dir: join(tmpdir(), "quantumos-quantinuum-" + process.pid), baseMachine: join("validation", "ftqvm", "base.machine") });
    await writeTwins("ryan-anderson-2024", result.rows);
    writeFileSync(join(out, "ryan-anderson-2024.json"), JSON.stringify({ meta: byId("ryan-anderson-2024"), generated: new Date().toISOString(), ...result }, null, 1));
    console.log(JSON.stringify(result.rows.map(({ programText, listingHead, machineText, sysspecText, spec, byKind, slack, ...r }) => r), null, 1));
  }
  if (which === "bluvstein") {
    const { tmpdir } = await import("node:os");
    const distances = (process.argv[3] ?? "3,5,7").split(",").map(Number);
    const result = await bluvsteinExperiment({ distances, dir: join(tmpdir(), "quantumos-bluvstein-" + process.pid), baseMachine: join("validation", "ftqvm", "base.machine") });
    await writeTwins("bluvstein-2024", result.rows);
    writeFileSync(join(out, "bluvstein-2024.json"), JSON.stringify({ meta: byId("bluvstein-2024"), generated: new Date().toISOString(), ...result }, null, 1));
    const md = ["| d | Basis | Atoms placed | Ops | Conforms | Transversal CNOTs spread over (µs) | Route (µs) | CNOT (µs) | Measure (µs) | Decoder (µs) | Makespan (ms) |", "|---|---|---|---|---|---|---|---|---|---|---|",
      ...result.rows.map((r) => r.error ? `| ${r.distance} | ${r.basis} | | | error: ${r.error.replace(/\|/g, "/").slice(0, 160)} | | | | | | |` : `| ${r.distance} | ${r.basis} | ${r.qubits} | ${r.ops} | ${r.conforms ? "yes" : "no"} | ${(r.transversalSpreadNs / 1000).toFixed(1)} | ${(r.routeNs / 1000).toFixed(1)} | ${(r.gate2qNs / 1000).toFixed(2)} | ${(r.measureNs / 1000).toFixed(0)} | ${(r.decoderNs / 1000).toFixed(1)} | ${(r.makespanNs / 1e6).toFixed(2)} |`)].join("\n") + "\n";
    writeFileSync(join(out, "bluvstein-2024.md"), md);
    console.log(md);
  }
}

/**
 * The compiler's declaration of the distance-d surface code with its transversal gates (the H̄ row
 * the transversal passes add), from prepare_qec with `fuse-cx`, `fuse-h` and `transversal-gates`
 * on a two-qubit CX program.
 */
export async function transversalSurfaceCodes(d, dir, code = "surface") {
  mkdirSync(dir, { recursive: true });
  const prog = join(dir, "cx-" + code + d + ".prog"), qppm = join(dir, "cx-" + code + d + ".qppm"), qec = join(dir, "cx-" + code + d + ".qec");
  writeFileSync(prog, "code " + code + " d=" + d + "\n\nprogram cx[q: 2, c: 2]:\n  H(0)\n  CX(0, 1)\n  measure 0 ↦ c[0]\n  measure 1 ↦ c[1]\n");
  await ftc.prepareQppm(prog, qppm);
  const args = { code, distance: d, specialize: {} };
  await ftc.prepareQecWith(qppm, qec, args, ["--opt", "fuse-cx", "--opt", "fuse-h", "--opt", "transversal-gates"]);
  const text = readFileSync(qec, "utf8");
  return text.slice(0, text.indexOf("program["));
}

/**
 * Bluvstein et al., Nature 626, 58 (2024), Fig. 2: two distance-d surface codes, one in |+⟩_L
 * and one in |0⟩_L, a transversal CNOT, and the logical Bell stabilizer read in `basis` (Z: Z⊗Z,
 * X: X⊗X), with one round of stabilizers on each block before the readout. |+⟩_L is prepared in
 * a logical ancilla block (the compiler's staged back end does not expand a transversal H on one
 * block). Compiled by the compiler's staged back end, whose `pipeline-loops` option runs the
 * transversal CNOT's trips together.
 */
export async function bluvsteinBell(d, basis, dir) {
  const n = d * d, checks = n - 1;
  const codes = await transversalSurfaceCodes(d, dir);
  const body = [
    `program[LogicData: 1, c: ${2 * d}, ancilla: ${4 * checks + 2 * n}] (Surface[1] LogicData, Surface[1] LogicalAncilla):`,
    "  alloc LogicalAncilla[0,1)",
    "  prepare |+> -> LogicalAncilla[0,1)",
    "  transversal CX LogicalAncilla[0] LogicData[0]",
    `  extract LogicalAncilla[0][0] rounds=1 using ancilla[0,${checks}) -> syndrome[0,${checks})`,
    `  extract LogicData[0][0] rounds=1 using ancilla[${checks},${2 * checks}) -> syndrome[${checks},${2 * checks})`,
    `  decode rounds=1 syndrome[0,${2 * checks})`,
    `  measure ${basis}[LogicalAncilla[0][0]] -> c[0,${d})`,
    `  measure ${basis}[LogicData[0][0]] -> c[${d},${2 * d})`,
    `  decode rounds=1 c[0,${2 * d})`,
  ].join("\n") + "\n";
  const path = join(dir, `bluvstein-bell-${basis}-d${d}.qec`);
  writeFileSync(path, codes + body);
  return path;
}

/** Run Bluvstein's Bell pair on the twin of their array, per distance and basis. */
export async function bluvsteinExperiment({ distances = [3, 5, 7], bases = ["Z", "X"], dir, baseMachine } = {}) {
  const { deriveSpec } = await import("./derive.mjs");
  const { optical } = await import("./platforms.mjs");
  const { PROFILES, OPTICAL_DESIGNS } = await import("./optical.mjs");
  const rows = [];
  for (const d of distances)
    for (const basis of bases) {
      const sub = join(dir, "d" + d + basis);
      const qec = await bluvsteinBell(d, basis, sub);
      let iterations;
      try {
        ({ iterations } = await deriveSpec({ platform: optical("bluvstein-2024"), qec, distance: d, baseMachine, dir: sub, staged: true, compileOptions: ["--opt", "pipeline-loops"] }));
      } catch (error) {
        rows.push({ distance: d, basis, error: error.message.split("\n")[0].slice(0, 400) });
        continue;
      }
      const last = iterations.at(-1);
      const m = Object.fromEntries(Object.entries(last.spec.machine).map(([k, v]) => [k, v.value]));
      const ops = last.listing.ops;
      // A transversal CNOT pairs qubits of two code blocks; a stabilizer's CNOT always involves a
      // check ancilla, which the listing requests one at a time (count=1).
      const checkAncillas = new Set(ops.filter((o) => o.kind === "request_ancilla" && o.qubits.length === 1).map((o) => o.qubits[0].register + "[" + o.qubits[0].index + "]"));
      const tx = ops.filter((o) => o.kind === "CNOT" && o.qubits.every((q) => !checkAncillas.has(q.register + "[" + q.index + "]")));
      rows.push({
        distance: d, basis, qubits: last.sites, ops: ops.length, conforms: last.report.conforms, verdict: last.verdict,
        transversalCnots: tx.length, transversalSpreadNs: tx.length ? Math.max(...tx.map((o) => o.start)) - Math.min(...tx.map((o) => o.start)) : 0,
        routeNs: m.route_latency_ns, gate2qNs: m.gate2q_ns, measureNs: m.measure_ns, decoderNs: m.decoder_latency_ns, makespanNs: last.makespanNs,
        pools: last.report.pools, stripped: last.listing.source.stripped, iterations: iterations.length,
        failing: Object.fromEntries(Object.entries(last.report.byKind).filter(([, v]) => v.ok < v.count).map(([k, v]) => [k, { ok: v.ok, count: v.count, maxOverrunNs: v.maxOverrunNs }])),
        firstFailing: last.report.rows.filter((r) => !r.ok).slice(0, 3).map((r) => ({ kind: r.kind, line: r.line, start: r.start, end: r.end, hardwareNs: r.hardwareNs, lent: r.lentChannel })),
        ...details(last, qec),
        _twin: twinSource("d" + d + basis, "d = " + d + ", " + basis + " basis", { kind: "optical", id: "bluvstein-2024", overrides: {} }, d, last.listing),
      });
    }
  return { design: { id: "bluvstein-2024", ...OPTICAL_DESIGNS["bluvstein-2024"], profile: PROFILES.bluvstein }, rows };
}

/**
 * Ryan-Anderson et al., arXiv:2404.16728 (2024): teleportation of a Steane-code logical qubit by
 * transversal gates. Three [[7,1,3]] blocks: a Bell pair between two logical ancilla blocks
 * (|+⟩_L, |0⟩_L and a transversal CX), one stabilizer round on each, a transversal CX from the
 * source block, the source read in X and the first ancilla in Z, then the Pauli-frame
 * corrections on the target. The compiler's own Steane declaration; its staged back end.
 */
export async function quantinuumTeleport(dir) {
  const codes = await transversalSurfaceCodes(3, dir, "steane");
  const body = [
    "program[LogicData: 1, c: 12, ancilla: 60] (Steane[1] LogicData, Steane[2] LogicalAncilla):",
    "  alloc LogicalAncilla[0,2)",
    "  prepare |+> -> LogicalAncilla[0,1)",
    "  prepare |0> -> LogicalAncilla[1,2)",
    "  transversal CX LogicalAncilla[0] LogicalAncilla[1]",
    "  extract LogicalAncilla[0][0] rounds=1 using ancilla[0,6) -> syndrome[0,6)",
    "  extract LogicalAncilla[1][0] rounds=1 using ancilla[6,12) -> syndrome[6,12)",
    "  decode rounds=1 syndrome[0,12)",
    "  transversal CX LogicData[0] LogicalAncilla[0]",
    "  measure X[LogicData[0][0]] -> c[0,3)",
    "  measure Z[LogicalAncilla[0][0]] -> c[3,6)",
    "  decode rounds=1 c[0,6)",
    "  frame on c[0,3) Z[LogicalAncilla[1][0]]",
    "  frame on c[3,6) X[LogicalAncilla[1][0]]",
  ].join("\n") + "\n";
  const path = join(dir, "quantinuum-teleport-steane.qec");
  writeFileSync(path, codes + body);
  return path;
}

/** Run the teleportation on the H2 twin. */
export async function quantinuumExperiment({ dir, baseMachine } = {}) {
  const { deriveSpec } = await import("./derive.mjs");
  const { optical } = await import("./platforms.mjs");
  const { PROFILES, OPTICAL_DESIGNS } = await import("./optical.mjs");
  const rows = [];
  const qec = await quantinuumTeleport(dir);
  // Two sizes of H2: the 32 qubits of QCCD Studio's model (H2 in 2023), and 56 (H2 from 2024).
  const sizes = [
    { label: "H2, 32 qubits" },
    { label: "H2, 56 qubits", qubits: { value: 56, source: "DeCross et al., arXiv:2406.02501 (2024): the 56-qubit H2" } },
  ];
  for (const size of sizes) try {
    const sub = join(dir, size.qubits ? "q" + size.qubits.value : "q32");
    const overrides = { blockSize: 7, ...(size.qubits ? { qubits: size.qubits } : {}) };
    const { iterations } = await deriveSpec({ platform: optical("quantinuum-h2", overrides), qec, distance: 3, baseMachine, dir: sub, staged: true, compileOptions: ["--opt", "pipeline-loops"] });
    const last = iterations.at(-1);
    const m = Object.fromEntries(Object.entries(last.spec.machine).map(([k, v]) => [k, v.value]));
    const moves = last.report.rows.filter((r) => ["CNOT", "CZ", "CY"].includes(r.kind));
    rows.push({
      distance: 3, basis: size.label, qubits: last.sites, ops: last.listing.ops.length, conforms: last.report.conforms, verdict: last.verdict,
      gate2qNs: m.gate2q_ns, routeNs: m.route_latency_ns, measureNs: m.measure_ns, decoderNs: m.decoder_latency_ns, makespanNs: last.makespanNs,
      twoQubitGates: moves.length, iterations: iterations.length, stripped: last.listing.source.stripped,
      failing: Object.fromEntries(Object.entries(last.report.byKind).filter(([, v]) => v.ok < v.count).map(([k, v]) => [k, { ok: v.ok, count: v.count, maxOverrunNs: v.maxOverrunNs }])),
      ...details(last, qec),
      _twin: twinSource(size.qubits ? "q" + size.qubits.value : "q32", size.label, { kind: "optical", id: "quantinuum-h2", overrides }, 3, last.listing),
    });
  } catch (error) {
    // The line that says why (the compiler's refusal or the VM's verdict), not the compiler's progress lines.
    const lines = error.message.split("\n");
    rows.push({ distance: 3, basis: size.label, error: (lines.find((l) => /refused|did not admit|exceeds/.test(l)) ?? lines[0]).trim().slice(0, 400) });
  }
  return { design: { id: "quantinuum-h2", ...OPTICAL_DESIGNS["quantinuum-h2"], profile: PROFILES.h2 }, rows };
}
