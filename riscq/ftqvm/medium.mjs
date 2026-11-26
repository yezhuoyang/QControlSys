// Algorithms at medium scale: well-known algorithms on 10–15 logical qubits, encoded at code distance 5
// in about 500–1,000 physical qubits, run through the operating system's interface on a superconducting
// twin with its RISC-Q control system across many boards.
//
// Offline (needs the fault-tolerant compiler):   node riscq/ftqvm/medium.mjs [program id]
// Offline (no compiler, about an hour each):       node riscq/ftqvm/medium.mjs variant <id> decoders=1 coresPerDecoder=4
//   reruns a stored listing on another control system: validation/ftqvm/medium/<id>.decoders-1.cores-4.json.gz.
//   compiles each program, derives its system specification on the twin until every operation fits its
//   window (riscq/ftqvm/derive.mjs), and stores the run: validation/ftqvm/medium/<id>.json.gz.
// On the site (no compiler): the stored runs, and the design page's rerun of a stored listing on the twin
// in the Lean model of the control system (the same run the stored one is).
//
// Contract with the Examples section (riscq/calib/site.mjs, example-runs.mjs): mediumStudy(), MEDIUM_RUNS,
// mediumRow(params), MEDIUM_DESIGN, storedPrograms(), storedVariants(program).
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const programsDir = join(here, "..", "..", "validation", "ftqvm", "programs");
const storeDir = join(here, "..", "..", "validation", "ftqvm", "medium");

/** The programs. `logical`: logical qubits the program declares (its q register). */
export const MEDIUM_PROGRAMS = [
  { id: "dj-12", short: "Deutsch–Jozsa", title: "Deutsch–Jozsa on 12 inputs", logical: 13,
    what: "12 inputs in |+⟩ and a target in |−⟩; a balanced oracle f(x) = s·x (s = 101101101101₂) applied as lattice-surgery CNOTs from each input of s onto the target; the inputs read out in X give s, so f is balanced.",
    qppm: join(programsDir, "medium", "dj-d5.qppm"), specialize: { n: 12, s: 2925 } },
  { id: "grover-5", short: "Grover search", title: "Grover search over 5 qubits", logical: 13,
    what: "One Grover iteration (oracle marking s = 10110₂, then diffusion) on 5 search qubits, with the multi-controlled Z built from an AND chain on 8 work blocks; every T gate consumes a magic state.",
    qppm: join(programsDir, "medium", "Grover-d5.qppm"), specialize: { n: 5, k: 1, s: 22, anc: 5, rec: 8 } },
  { id: "adder-4", short: "a Gidney adder", title: "Gidney adder of two 4-bit numbers", logical: 12,
    what: "A 4-bit ripple-carry adder in Gidney's measured form: its AND gates computed with T states and uncomputed by measurement, on 12 blocks.",
    qppm: join(programsDir, "medium", "MeasAdder-d5.qppm"), specialize: { n: 4 } },
  { id: "ghz-12", short: "a GHZ state", title: "GHZ state on 12 logical qubits", logical: 12,
    what: "12 blocks in |+⟩ joined by a chain of Z⊗Z lattice-surgery merges into a 12-qubit GHZ state, then read out in Z.",
    qppm: join(programsDir, "medium", "ghz-d5.qppm"), specialize: { n: 12 } },
];
const DISTANCE = 5;

/** The twin: a generated transmon chip with one RISC-Q core per transmon, placed on ZCU216 boards. */
export const MEDIUM_MACHINE = { qubitsPerCore: 1, decoders: 2, coresPerDecoder: 4, memWords: 16384, trace: "summary" };
const MACHINE_TEXT = "a generated superconducting chip, one transmon per RISC-Q control core, two 4-core decoders, 16,384 words of RAM per core, placed on as many AMD ZCU216 boards as it needs";

const storeFile = (id) => join(storeDir, id + ".json.gz");
// A stored listing is hundreds of MB of JSON: read each file once, again only when it changes.
const cache = new Map();
export function storedRun(id) {
  const f = storeFile(id);
  if (!existsSync(f)) return null;
  const mtime = statSync(f).mtimeMs, hit = cache.get(f);
  if (hit?.mtime === mtime) return hit.run;
  const run = JSON.parse(gunzipSync(readFileSync(f)).toString("utf8"));
  cache.set(f, { mtime, run });
  return run;
}

const count = (it) => ({
  sites: it.sites, ops: it.listing?.ops?.length,
  cores: it.design?.parts?.filter((p) => p.type === "core").length,
  boards: it.design?.control?.boards,
});

/** A listing without the paths of this machine: the compiler's checkout and the derivation's temporary files. */
export function publishable(listing) {
  if (!listing?.source) return listing;
  const { path, compiler, ...source } = listing.source;
  return { ...listing, source: { ...source, ...(path ? { file: path.split(/[\\/]/).at(-1) } : {}) } };
}

/** Compile, derive and run one program; store what the site needs. Needs the compiler. */
export async function compileMedium(id, { log = console.log } = {}) {
  const p = MEDIUM_PROGRAMS.find((x) => x.id === id);
  if (!p) throw Error("no medium program " + id);
  const { deriveSpec } = await import("./derive.mjs");
  const { transmon } = await import("./platforms.mjs");
  const t0 = Date.now();
  const { iterations } = await deriveSpec({ platform: transmon(MEDIUM_MACHINE), qppm: p.qppm, specialize: p.specialize, distance: DISTANCE,
    baseMachine: join(here, "..", "..", "validation", "ftqvm", "base.machine"), maxIterations: 6 });
  const last = iterations.at(-1);
  const machine = Object.fromEntries(Object.entries(last.spec.machine).map(([k, v]) => [k, v.value]));
  const run = {
    id, title: p.title, logical: p.logical, distance: DISTANCE, ...count(last), conforms: last.report.conforms, verdict: last.verdict,
    iterations: iterations.map((it) => ({ conforms: it.report.conforms, makespanNs: it.makespanNs,
      late: (it.report.rows ?? []).filter((r) => !r.ok).length })),
    makespanNs: last.makespanNs, byKind: last.report.byKind, machine,
    failures: (last.report.rows ?? []).filter((r) => !r.ok).slice(0, 12),
    listing: publishable(last.listing), spec: last.spec, track: last.report.track,
    seconds: (Date.now() - t0) / 1000, generated: new Date().toISOString(),
  };
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(storeFile(id), gzipSync(JSON.stringify(run)));
  log(id, run.conforms ? "conforms" : "does not conform", "| logical", p.logical, "| physical", run.sites, "| cores", run.cores, "| boards", run.boards,
    "| ops", run.ops, "| machine time", (run.makespanNs / 1000).toFixed(1), "µs |", run.seconds, "s");
  return run;
}

/** Rerun a stored listing on the twin (no compiler): the Lean model of the control system, every op checked. */
async function rerun(stored, machine) {
  const { transmon } = await import("./platforms.mjs");
  const platform = transmon(machine);
  const placement = platform.place(stored.listing, { distance: DISTANCE });
  const design = platform.design(stored.listing, placement);
  const { report } = await platform.run(stored.listing, placement, design, { outcomes: {}, distance: DISTANCE });
  return { report, design, placement };
}

const µs = (ns) => (ns / 1000).toFixed(1);

/** The study machine with a design form's control-system choices. */
const machineOf = (params = {}) => ({ ...MEDIUM_MACHINE,
  ...(params.decoders ? { decoders: Number(params.decoders) } : {}),
  ...(params.coresPerDecoder ? { coresPerDecoder: Number(params.coresPerDecoder) } : {}) });

// A variant: a stored listing rerun offline on another control system. A rerun of a medium listing takes
// about an hour of the Lean model (GHZ-12 with one decoder unit: 4,572 s), too long for a page request.
const variantFile = (id, m) => join(storeDir, id + ".decoders-" + m.decoders + ".cores-" + m.coresPerDecoder + ".json.gz");
const VARIANT = /^(.+)\.decoders-(\d+)\.cores-(\d+)\.json\.gz$/;

/** The control systems a program's listing was rerun on offline, as design-form keys. */
export function storedVariants(program) {
  if (!existsSync(storeDir)) return [];
  return readdirSync(storeDir).map((f) => f.match(VARIANT)).filter((m) => m && m[1] === program)
    .map((m) => ({ program, decoders: m[2], coresPerDecoder: m[3] }))
    .sort((a, b) => a.decoders - b.decoders || a.coresPerDecoder - b.coresPerDecoder);
}

function storedVariant(id, m) {
  const f = variantFile(id, m);
  return existsSync(f) ? JSON.parse(gunzipSync(readFileSync(f)).toString("utf8")) : null;
}

/** Rerun a stored program on another control system and store the result. Needs no compiler. */
export async function storeVariant(id, params, { log = console.log } = {}) {
  const stored = storedRun(id);
  if (!stored) throw Error("no stored run of " + id);
  const machine = machineOf(params), t0 = Date.now();
  const { report, design } = await rerun(stored, machine);
  const variant = {
    id, machine: { decoders: machine.decoders, coresPerDecoder: machine.coresPerDecoder },
    conforms: report.conforms, byKind: report.byKind, track: report.track, makespanNs: report.makespanNs ?? stored.makespanNs,
    failures: (report.rows ?? []).filter((r) => !r.ok).slice(0, 12),
    cores: design.parts.filter((x) => x.type === "core").length, boards: design.control?.boards,
    seconds: (Date.now() - t0) / 1000, generated: new Date().toISOString(),
  };
  writeFileSync(variantFile(id, machine), gzipSync(JSON.stringify(variant)));
  log(id, "decoders", machine.decoders, "cores per decoder", machine.coresPerDecoder, variant.conforms ? "conforms" : "does not conform",
    "| cores", variant.cores, "| boards", variant.boards, "|", variant.seconds, "s");
  return variant;
}

/** One run as an Examples row. params: { program, decoders?, coresPerDecoder? }. */
export async function mediumRow(params = {}) {
  const first = storedPrograms()[0] ?? MEDIUM_PROGRAMS[0];
  const p = MEDIUM_PROGRAMS.find((x) => x.id === (params.program ?? first.id)) ?? first;
  const stored = storedRun(p.id);
  if (!stored) throw Error(p.title + " has no stored run yet: it is compiled offline, where the fault-tolerant compiler is installed");
  const machine = machineOf(params);
  const same = machine.decoders === MEDIUM_MACHINE.decoders && machine.coresPerDecoder === MEDIUM_MACHINE.coresPerDecoder;
  let report = { conforms: stored.conforms, byKind: stored.byKind, track: stored.track, rows: stored.failures }, cores = stored.cores, boards = stored.boards;
  let makespanNs = stored.makespanNs;
  // Another control system: its precomputed variant if one is stored, else the rerun itself.
  const variant = same ? null : storedVariant(p.id, machine);
  if (variant) {
    report = { conforms: variant.conforms, byKind: variant.byKind, track: variant.track, rows: variant.failures };
    ({ cores, boards, makespanNs } = variant);
  } else if (!same) {
    const r = await rerun(stored, machine);
    report = r.report;
    cores = r.design.parts.filter((x) => x.type === "core").length;
    boards = r.design.control?.boards;
    makespanNs = r.report.makespanNs ?? makespanNs;
  }
  const bad = (report.rows ?? []).filter((r) => !r.ok);
  return {
    label: p.title, conforms: report.conforms, byKind: report.byKind, track: report.track, program: stored.listing.qsysasm,
    formKey: { program: p.id, decoders: String(machine.decoders), coresPerDecoder: String(machine.coresPerDecoder) },
    columns: {
      Program: p.title + ": " + p.what,
      "Logical qubits": String(p.logical),
      "Physical qubits": stored.sites + " transmons (surface code, distance " + DISTANCE + ")",
      "Control system": cores + " RISC-Q cores on " + boards + " ZCU216 boards, " + machine.decoders + " decoder unit(s) of " + machine.coresPerDecoder + " cores",
      "System calls": stored.ops + " operations of the QSysASM listing",
      "Machine time": µs(makespanNs) + " µs",
      Result: report.conforms ? "every operation ran inside its window" : bad.length + " operations ran past their windows",
    },
    failures: bad.slice(0, 12).map((r) => ({ kind: r.kind, line: r.line, start: r.start, end: r.end, hardwareNs: r.hardwareNs, reason: r.overrunNs > 0 ? "finished " + Math.round(r.overrunNs) + " ns late" : r.bitOverrunNs > 0 ? "bit stored late" : "outside its window" })),
  };
}

export const MEDIUM_RUNS = MEDIUM_PROGRAMS.map((p) => ({ label: p.title, params: { program: p.id } }));

/** The programs with a stored run, in MEDIUM_PROGRAMS order. */
export function storedPrograms() {
  return MEDIUM_PROGRAMS.filter((p) => existsSync(storeFile(p.id)));
}

/** "A, B and C". */
const listed = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs.at(-1));
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** The Examples study page. Its text names only the programs that have a stored run. */
export function mediumStudy() {
  const runs = MEDIUM_PROGRAMS.map((p) => ({ p, r: storedRun(p.id) })).filter((x) => x.r);
  const rows = runs.map(({ p, r }) => [p.title, String(p.logical), String(r.sites), String(r.cores), String(r.boards), String(r.ops), µs(r.makespanNs), r.conforms ? "yes" : "no"]);
  const biggest = runs.reduce((m, x) => (x.r.sites > (m?.r.sites ?? 0) ? x : m), null);
  return {
    id: "medium", title: "Algorithms at medium scale", kicker: "Scale · well-known algorithms",
    summary: runs.length
      ? capital(listed(runs.map(({ p }) => p.short + " on " + p.logical + " logical qubits")) + ", encoded at distance 5 in " + listed(runs.map(({ r }) => String(r.sites))) + " physical qubits and run through the operating system's interface on a superconducting machine whose control system spans " + listed(runs.map(({ r }) => String(r.boards))) + " boards.")
      : "Well-known algorithms on 10–15 logical qubits, encoded at distance 5 in hundreds of physical qubits. No run is stored yet.",
    method: [
      "Each algorithm is a logical program. The fault-tolerant compiler lowers it to a QSysASM listing of system calls against the machine's system specification, and its resource VM admits the listing. The OS then executes every system call at its listed time on the control system, and durations the hardware needed enter the next specification until every call fits its window.",
      "The machine is " + MACHINE_TEXT + ". Every core runs firmware compiled from the listing in the cycle-exact model of RISC-Q; boards exchange measured bits and barriers over their PutLanes.",
    ],
    sections: [
      { heading: "The programs", text: runs.map(({ p }) => p.title + ": " + p.what).join(" ") },
      { heading: "The runs", table: { head: ["Program", "Logical qubits", "Physical qubits", "Control cores", "Boards", "System calls", "Machine time (µs)", "Every call in its window"], rows } },
    ],
    findings: runs.length
      ? [biggest ? "The largest run, " + biggest.p.title + ", uses " + biggest.r.sites + " physical qubits and " + biggest.r.cores + " control cores on " + biggest.r.boards + " boards." : "",
        runs.every((x) => x.r.conforms) ? "Every system call of every program ran inside its window." : runs.filter((x) => !x.r.conforms).map((x) => x.p.title + " did not keep every window.").join(" ")].filter(Boolean)
      : ["No run is stored yet."],
    command: "node riscq/calib/site.mjs",
  };
}

/** The design page: a program, and the decoders of its control system. */
export const MEDIUM_DESIGN = {
  intro: "Choose an algorithm and the decoders of the control system, then run the compiled listing again on the cycle-exact model of the RISC-Q control system. Every system call is checked against its window.",
  params() {
    return [
      { key: "program", label: "Algorithm", value: (storedPrograms()[0] ?? MEDIUM_PROGRAMS[0]).id, group: "Program", source: "logical programs compiled at distance 5 by the fault-tolerant compiler", options: storedPrograms().map((p) => ({ value: p.id, label: p.title })) },
      { key: "decoders", label: "Decoder units", value: String(MEDIUM_MACHINE.decoders), group: "Control system", source: "the study's machine", options: ["1", "2", "4"].map((v) => ({ value: v, label: v })) },
      { key: "coresPerDecoder", label: "Cores per decoder unit", value: String(MEDIUM_MACHINE.coresPerDecoder), group: "Control system", source: "the study's machine", options: ["1", "2", "4", "8"].map((v) => ({ value: v, label: v })) },
    ];
  },
  async run(params = {}) {
    return { rows: [await mediumRow(params)] };
  },
};

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const only = process.argv[2];
  if (only === "variant") {
    // node medium.mjs variant <program> decoders=<n> coresPerDecoder=<n>
    const params = Object.fromEntries(process.argv.slice(4).map((a) => a.split("=")));
    await storeVariant(process.argv[3], params);
    process.exit(0);
  }
  for (const p of MEDIUM_PROGRAMS.filter((x) => !only || x.id === only)) {
    try {
      await compileMedium(p.id);
    } catch (error) {
      console.log(p.id, "ERROR", error.message.slice(0, 400));
    }
  }
}
