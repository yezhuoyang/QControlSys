// Algorithms at medium scale: well-known algorithms on up to 17 logical qubits, encoded in more physical
// qubits than any reproduced paper's (at most 98), run through the operating system's interface on the
// three platforms, two designs each (MEDIUM_HARDWARE): transmons, neutral atoms and trapped ions, each with
// its RISC-Q control system across one or many boards. A program is compiled for each design it runs on
// (the design's capacities and durations shape its listing). Each is sized so that its whole derivation
// (compile, run on the twin, derive the specification, until every call fits its window) takes under an
// hour on one workstation; the stored run records how long it took. Ion and atom gates are slow (µs to ms),
// so their programs are smaller: one Lean run covers at most 2·10⁹ batches, 4 s of machine time at 500 MHz.
//
// Offline (needs the fault-tolerant compiler):   node riscq/ftqvm/medium.mjs [program id] [hardware id]
// Offline (no compiler, about an hour each):       node riscq/ftqvm/medium.mjs variant <id> decoders=1 coresPerDecoder=4
//   reruns a stored listing on another control system: validation/ftqvm/medium/<id>.decoders-1.cores-4.json.gz.
//   compiles each program, derives its system specification on the twin until every operation fits its
//   window (riscq/ftqvm/derive.mjs), and stores the run: validation/ftqvm/medium/<run id>.json.gz, where the
//   run id is the program id on the first design ("sc") and <program>@<hardware> on any other.
// On the site (no compiler): the stored runs, and the design page's rerun of a stored listing on the twin
// in the Lean model of the control system (the same run the stored one is).
//
// Contract with the Examples section (riscq/calib/site.mjs, example-runs.mjs): mediumStudy(), MEDIUM_RUNS,
// MEDIUM_HARDWARE, mediumRow(params = { program, hardware }), MEDIUM_DESIGN, storedPrograms(), storedRuns(),
// storedVariants(program), runId(program, hardware).
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const programsDir = join(here, "..", "..", "validation", "ftqvm", "programs");
const storeDir = join(here, "..", "..", "validation", "ftqvm", "medium");

/** The programs. `logical`: logical qubits the program declares (its q register); `hardware`: the
 *  MEDIUM_HARDWARE designs it is compiled and run on (default: the first). */
export const MEDIUM_PROGRAMS = [
  { id: "ghz-12", short: "a GHZ state", title: "GHZ state on 12 logical qubits", logical: 12, distance: 3,
    what: "12 blocks in |+⟩ joined by a chain of Z⊗Z lattice-surgery merges into a 12-qubit GHZ state, then read out in Z.",
    qppm: join(programsDir, "medium", "ghz-d3.qppm"), specialize: { n: 12 } },
  { id: "dj-12", short: "Deutsch–Jozsa", title: "Deutsch–Jozsa on 12 inputs", logical: 13, distance: 3,
    what: "12 inputs in |+⟩ and a target in |−⟩; a balanced oracle f(x) = s·x (s = 101101101101₂) applied as lattice-surgery CNOTs from each input of s onto the target; the inputs read out in X give s, so f is balanced.",
    qppm: join(programsDir, "medium", "dj.qppm"), specialize: { n: 12, s: 2925 } },
  { id: "ghz-6-d5", short: "a GHZ state", title: "GHZ state on 6 logical qubits at distance 5", logical: 6, distance: 5,
    what: "6 blocks of the distance-5 surface code in |+⟩ joined by Z⊗Z lattice-surgery merges into a GHZ state, then read out in Z.",
    qppm: join(programsDir, "medium", "ghz-d5.qppm"), specialize: { n: 6 } },
  { id: "bv-16", short: "Bernstein–Vazirani", title: "Bernstein–Vazirani on 16 inputs", logical: 17, distance: 3,
    what: "The hidden string s = 1011001110001101₂ of the oracle f(x) = s·x, found with one query: 16 inputs in |+⟩ and a target in |−⟩, a lattice-surgery CNOT from each input where s has a 1, then the inputs read out in X, which give s. It is the Deutsch–Jozsa circuit with a linear oracle; Bernstein–Vazirani asks for s itself.",
    qppm: join(programsDir, "medium", "dj.qppm"), specialize: { n: 16, s: 45965 }, hardware: ["sc", "sc-dense"] },
  { id: "teleport-16", short: "teleportation", title: "Teleportation along 16 logical qubits", logical: 16, distance: 3,
    what: "A logical |+⟩ teleported block to block along a chain of 16: each step prepares the next block in |+⟩, merges the two by Z⊗Z lattice surgery and measures the old block in X; the two outcomes set the next block's X and Z frame corrections. The last block, read out in X, gives +.",
    qppm: join(programsDir, "medium", "teleport.qppm"), specialize: { n: 16 }, hardware: ["sc", "sc-dense"] },
  { id: "dj-8-d5", short: "Deutsch–Jozsa", title: "Deutsch–Jozsa on 8 inputs at distance 5", logical: 9, distance: 5,
    what: "8 inputs and a target in blocks of the distance-5 surface code; the balanced oracle f(x) = s·x (s = 10110101₂) as lattice-surgery CNOTs onto the target; the inputs read out in X give s, so f is balanced.",
    qppm: join(programsDir, "medium", "dj-d5.qppm"), specialize: { n: 8, s: 181 } },
  { id: "ghz-10-d5", short: "a GHZ state", title: "GHZ state on 10 logical qubits at distance 5", logical: 10, distance: 5,
    what: "10 blocks of the distance-5 surface code in |+⟩ joined by Z⊗Z lattice-surgery merges into a GHZ state, then read out in Z.",
    qppm: join(programsDir, "medium", "ghz-d5.qppm"), specialize: { n: 10 } },
  { id: "simon-8", short: "Simon's algorithm", title: "Simon's algorithm on 8 inputs", logical: 16, distance: 3,
    what: "A 2-to-1 oracle f(x) = f(x ⊕ s) with hidden s = 11010010₂: 8 inputs in |+⟩ and 8 outputs in |0⟩; the oracle copies x onto the outputs and, from input 1 (the lowest bit of s), adds s, all as lattice-surgery CNOTs. The inputs read out in X give a string y with y·s = 0; repeating the query recovers s.",
    qppm: join(programsDir, "medium", "simon.qppm"), specialize: { n: 8, s: 210, j: 1 } },
  { id: "teleport-10-d5", short: "teleportation", title: "Teleportation along 10 logical qubits at distance 5", logical: 10, distance: 5,
    what: "A logical |+⟩ teleported block to block along a chain of 10 blocks of the distance-5 surface code, each step a Z⊗Z lattice-surgery merge and an X measurement whose outcomes set the next block's frame corrections; the last block, read out in X, gives +.",
    qppm: join(programsDir, "medium", "teleport-d5.qppm"), specialize: { n: 10 } },
  // Smaller programs that run on every platform: atom and ion operations take µs to ms, and one Lean run
  // covers at most 4 s of machine time. Each is still larger than every reproduced paper.
  { id: "ghz-4", short: "a GHZ state", title: "GHZ state on 4 logical qubits", logical: 4, distance: 3,
    what: "4 blocks in |+⟩ joined by a chain of Z⊗Z lattice-surgery merges into a 4-qubit GHZ state, then read out in Z.",
    qppm: join(programsDir, "medium", "ghz-d3.qppm"), specialize: { n: 4 }, hardware: ["sc", "sc-dense", "atoms-moving", "atoms-static", "ions-qccd", "ions-modules"] },
  { id: "bv-4", short: "Bernstein–Vazirani", title: "Bernstein–Vazirani on 4 inputs", logical: 5, distance: 3,
    what: "The hidden string s = 1011₂ of f(x) = s·x found with one query: 4 inputs in |+⟩ and a target in |−⟩, a lattice-surgery CNOT from each input where s has a 1, then the inputs read out in X, which give s.",
    qppm: join(programsDir, "medium", "dj.qppm"), specialize: { n: 4, s: 11 }, hardware: ["sc", "atoms-moving"] },
  { id: "teleport-5", short: "teleportation", title: "Teleportation along 5 logical qubits", logical: 5, distance: 3,
    what: "A logical |+⟩ teleported block to block along a chain of 5, each step a Z⊗Z lattice-surgery merge and an X measurement whose outcomes set the next block's frame corrections; the last block, read out in X, gives +.",
    qppm: join(programsDir, "medium", "teleport.qppm"), specialize: { n: 5 }, hardware: ["sc-dense", "ions-qccd", "ions-modules"] },
  { id: "ghz-8", short: "a GHZ state", title: "GHZ state on 8 logical qubits", logical: 8, distance: 3,
    what: "8 blocks in |+⟩ joined by a chain of Z⊗Z lattice-surgery merges into an 8-qubit GHZ state, then read out in Z.",
    qppm: join(programsDir, "medium", "ghz-d3.qppm"), specialize: { n: 8 }, hardware: ["sc", "atoms-moving", "atoms-static"] },
  { id: "bv-8", short: "Bernstein–Vazirani", title: "Bernstein–Vazirani on 8 inputs", logical: 9, distance: 3,
    what: "The hidden string s = 10110011₂ of f(x) = s·x found with one query: 8 inputs in |+⟩ and a target in |−⟩, a lattice-surgery CNOT from each input where s has a 1, then the inputs read out in X, which give s.",
    qppm: join(programsDir, "medium", "dj.qppm"), specialize: { n: 8, s: 179 }, hardware: ["sc", "atoms-static"] },
];
/** The whole derivation of one program must finish within this many seconds (the module's header). */
export const MEDIUM_BUDGET_S = 3600;

/** The first twin: a generated transmon chip with one RISC-Q core per transmon, placed on ZCU216 boards. */
export const MEDIUM_MACHINE = { qubitsPerCore: 1, decoders: 2, coresPerDecoder: 4, memWords: 16384, trace: "summary" };

/**
 * The hardware: three platforms, two designs each. `machine`: a generated transmon chip's options
 * (riscq/ftqvm/platforms.mjs transmon); `optical`: a design point of riscq/ftqvm/optical.mjs
 * OPTICAL_DESIGNS. `runtimeNs`: the longest program the compiler may schedule on it (its resource VM's
 * runtime bound): a run must fit one Lean run, 2·10⁹ batches at 500 MHz less the 20% margin of
 * riscq/ftqvm/sc-run.mjs batchBudget.
 */
export const MEDIUM_HARDWARE = [
  { id: "sc", platform: "Superconducting", qubits: "transmons", title: "Transmons, two decoder units", machine: MEDIUM_MACHINE,
    text: "a generated superconducting chip: one RISC-Q control core per transmon, each drive on its own RF-DAC, code blocks two lattice columns apart, two decoder units of 4 cores, 16,384 words of RAM per core, on as many AMD ZCU216 boards as it needs" },
  { id: "sc-dense", platform: "Superconducting", qubits: "transmons", title: "Transmons, multiplexed drives, one decoder unit",
    machine: { ...MEDIUM_MACHINE, decoders: 1, coresPerDecoder: 8, drivesPerDac: 4, gap: 1 },
    text: "a denser superconducting chip: code blocks one lattice column apart, four transmon drives frequency-multiplexed on each RF-DAC, one RISC-Q core per transmon (RISC-Q builds one readout channel into every core), and one decoder unit of 8 cores" },
  { id: "atoms-moving", platform: "Neutral atoms", qubits: "atoms", title: "Atoms on a 10 µm lattice, moved into gate sites", optical: "atoms-moving", runtimeNs: 3_300_000_000,
    text: "neutral atoms in tweezers on a 10 µm lattice, 16 addressed beams and 4 AODs: every route moves atoms next to their partners (ZAC's move law), one RISC-Q decoder unit" },
  { id: "atoms-static", platform: "Neutral atoms", qubits: "atoms", title: "Atoms on a 2.5 µm interaction lattice", optical: "atoms-static", runtimeNs: 3_300_000_000,
    text: "neutral atoms on a 2.5 µm lattice, where neighbours interact in place, 16 addressed beams and 4 AODs: only long-range routes move atoms" },
  { id: "ions-qccd", platform: "Trapped ions", qubits: "ions", title: "QCCD grid, one ion per zone", optical: "ions-qccd", runtimeNs: 3_300_000_000,
    text: "trapped ions in a QCCD grid, one ion per zone, 16 gate beams and 32 electrode lanes: a route shuttles ions into its hub's zone (Pino et al. 2021 transport times)" },
  { id: "ions-modules", platform: "Trapped ions", qubits: "ions", title: "One ion chain per code block", optical: "ions-modules", runtimeNs: 3_300_000_000,
    text: "trapped ions with one chain of up to 64 ions per code block, 16 gate beams and 32 electrode lanes: only a merge between blocks shuttles ions" },
];
const hardwareOf = (id) => {
  const h = MEDIUM_HARDWARE.find((x) => x.id === (id ?? MEDIUM_HARDWARE[0].id));
  if (!h) throw Error("no medium hardware " + id);
  return h;
};
/** The platform adapter of a hardware design (riscq/ftqvm/platforms.mjs). */
async function platformOf(h) {
  const { transmon, optical } = await import("./platforms.mjs");
  return h.machine ? transmon(h.machine) : optical(h.optical, {}, { trace: "summary" });
}
/** The designs a program runs on. */
export const hardwareOfProgram = (p) => (p.hardware ?? [MEDIUM_HARDWARE[0].id]).map(hardwareOf);
/** A stored run's id: the program's on the first design, <program>@<hardware> on any other. */
export const runId = (program, hardware = MEDIUM_HARDWARE[0].id) => (hardware === MEDIUM_HARDWARE[0].id ? program : program + "@" + hardware);

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

// A transmon design lists its parts; an optical run reports its controller's boards.
const count = (it) => ({
  sites: it.sites, ops: it.listing?.ops?.length,
  cores: it.design?.parts ? it.design.parts.filter((p) => p.type === "core").length : it.report?.boards?.cores?.length,
  boards: it.design?.control?.boards ?? it.report?.boards?.count,
});

/** A listing without the paths of this machine: the compiler's checkout and the derivation's temporary files. */
export function publishable(listing) {
  if (!listing?.source) return listing;
  const { path, compiler, ...source } = listing.source;
  return { ...listing, source: { ...source, ...(path ? { file: path.split(/[\\/]/).at(-1) } : {}) } };
}

// A run of more operations than this is stored without its operations, and its track without the
// events past the first STORE_EVENTS: one JSON text holds at most about 500 MB. Such a run is not
// rerun from its file (the design page serves its stored variants); it is compiled again instead.
const STORE_OPS = 1_000_000;
const STORE_EVENTS = 300_000;

/** A listing as the store keeps it: all of it, or past STORE_OPS its headers and first statements. */
function storable(listing) {
  if (listing.ops.length <= STORE_OPS) return listing;
  const { ops, calls: _c, qsysasmFile: _f, ...rest } = listing;
  const text = listing.qsysasm.length > 50_000_000 ? listing.qsysasm.split("\n").slice(0, 2000).join("\n") + "\n# … more statements\n" : listing.qsysasm;
  return { ...rest, qsysasm: text, opCount: ops.length, opsStored: false };
}

/** A track as the store keeps it: past STORE_EVENTS events, the first ones by start. */
function storableTrack(track) {
  if (!track || track.events.length <= STORE_EVENTS) return track;
  return { ...track, events: track.events.slice(0, STORE_EVENTS), eventsDropped: track.events.length - STORE_EVENTS };
}

/** Compile, derive and run one program on one hardware design; store what the site needs. Needs the compiler. */
export async function compileMedium(programId, hardwareId = MEDIUM_HARDWARE[0].id, { log = console.log } = {}) {
  const p = MEDIUM_PROGRAMS.find((x) => x.id === programId);
  if (!p) throw Error("no medium program " + programId);
  const h = hardwareOf(hardwareId), id = runId(p.id, h.id);
  const { deriveSpec } = await import("./derive.mjs");
  const t0 = Date.now();
  const { iterations } = await deriveSpec({ platform: await platformOf(h), qppm: p.qppm, specialize: p.specialize, distance: p.distance,
    baseMachine: join(here, "..", "..", "validation", "ftqvm", "base.machine"), maxIterations: 6, slim: true, ...(h.runtimeNs ? { runtimeNs: h.runtimeNs } : {}) });
  const last = iterations.at(-1);
  const machine = Object.fromEntries(Object.entries(last.spec.machine).map(([k, v]) => [k, v.value]));
  const run = {
    id, program: p.id, hardware: h.id, title: p.title, logical: p.logical, distance: p.distance, ...count(last), conforms: last.report.conforms, verdict: last.verdict,
    decoders: last.design?.decoders ?? h.machine?.decoders, coresPerDecoder: last.design?.coresPerDecoder ?? h.machine?.coresPerDecoder,
    iterations: iterations.map((it) => ({ conforms: it.report.conforms, makespanNs: it.makespanNs,
      late: it.report.late ?? (it.report.rows ?? []).filter((r) => !r.ok).length })),
    makespanNs: last.makespanNs, byKind: last.report.byKind, machine,
    failures: (last.report.rows ?? []).filter((r) => !r.ok).slice(0, 12),
    listing: storable(publishable(last.listing)), spec: last.spec, track: storableTrack(last.report.track),
    seconds: (Date.now() - t0) / 1000, generated: new Date().toISOString(),
  };
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(storeFile(id), gzipSync(JSON.stringify(run)));
  if (run.seconds > MEDIUM_BUDGET_S) log(id, "took", Math.round(run.seconds / 60), "min, past the", MEDIUM_BUDGET_S / 60, "min budget");
  log(id, run.conforms ? "conforms" : "does not conform", "| logical", p.logical, "| physical", run.sites, h.qubits, "| cores", run.cores, "| boards", run.boards,
    "| ops", run.ops, "| machine time", (run.makespanNs / 1000).toFixed(1), "µs |", run.seconds, "s");
  return run;
}

/** Rerun a stored listing on the twin (no compiler): the Lean model of the control system, every op checked. */
async function rerun(stored, machine) {
  if (stored.listing.opsStored === false)
    throw Error(stored.title + " has " + stored.listing.opCount + " operations, too many to rerun from its stored run: its other control systems are precomputed variants");
  const { transmon } = await import("./platforms.mjs");
  const platform = transmon(machine);
  const placement = platform.place(stored.listing, { distance: stored.distance });
  const design = platform.design(stored.listing, placement);
  const { report } = await platform.run(stored.listing, placement, design, { outcomes: {}, distance: stored.distance });
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

/** One run as an Examples row. params: { program, hardware?, decoders?, coresPerDecoder? }; the decoder
 *  choices apply to the first design only (its stored variants). */
export async function mediumRow(params = {}) {
  const first = storedPrograms()[0] ?? MEDIUM_PROGRAMS[0];
  const p = MEDIUM_PROGRAMS.find((x) => x.id === (params.program ?? first.id)) ?? first;
  const h = hardwareOf(params.hardware);
  const stored = storedRun(runId(p.id, h.id));
  if (!stored) throw Error(p.title + " has no stored run on " + h.title + " yet: it is compiled offline, where the fault-tolerant compiler is installed");
  if (h !== MEDIUM_HARDWARE[0] && (params.decoders || params.coresPerDecoder)) throw Error("decoder variants are stored for " + MEDIUM_HARDWARE[0].title + " only");
  const machine = h === MEDIUM_HARDWARE[0] ? machineOf(params) : { decoders: stored.decoders, coresPerDecoder: stored.coresPerDecoder };
  const same = h !== MEDIUM_HARDWARE[0] || (machine.decoders === MEDIUM_MACHINE.decoders && machine.coresPerDecoder === MEDIUM_MACHINE.coresPerDecoder);
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
    formKey: { program: p.id, hardware: h.id, decoders: String(machine.decoders), coresPerDecoder: String(machine.coresPerDecoder) },
    columns: {
      Program: p.title + ": " + p.what,
      Hardware: h.platform + ": " + h.text,
      "Logical qubits": String(p.logical),
      "Physical qubits": stored.sites + " " + h.qubits + " (surface code, distance " + stored.distance + ")",
      "Control system": cores + " RISC-Q cores on " + boards + " ZCU216 board" + (boards === 1 ? "" : "s") + ", " + machine.decoders + " decoder unit(s) of " + machine.coresPerDecoder + " cores",
      "System calls": stored.ops + " operations of the QSysASM listing",
      "Machine time": µs(makespanNs) + " µs",
      Result: report.conforms ? "every operation ran inside its window" : bad.length + " operations ran past their windows",
    },
    failures: bad.slice(0, 12).map((r) => ({ kind: r.kind, line: r.line, start: r.start, end: r.end, hardwareNs: r.hardwareNs, reason: r.overrunNs > 0 ? "finished " + Math.round(r.overrunNs) + " ns late" : r.bitOverrunNs > 0 ? "bit stored late" : "outside its window" })),
  };
}

/** Every program on every design it runs on. */
export const MEDIUM_RUNS = MEDIUM_PROGRAMS.flatMap((p) => hardwareOfProgram(p).map((h) => ({ label: p.title + " · " + h.title, params: { program: p.id, hardware: h.id } })));

/** The (program, hardware) pairs with a stored run, in MEDIUM_PROGRAMS then MEDIUM_HARDWARE order. */
export function storedRuns() {
  return MEDIUM_PROGRAMS.flatMap((p) => hardwareOfProgram(p).filter((h) => existsSync(storeFile(runId(p.id, h.id)))).map((h) => ({ p, h, id: runId(p.id, h.id) })));
}

/** The programs with a stored run on any design, in MEDIUM_PROGRAMS order. */
export function storedPrograms() {
  const ids = new Set(storedRuns().map((x) => x.p.id));
  return MEDIUM_PROGRAMS.filter((p) => ids.has(p.id));
}

/** "A, B and C". */
const listed = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs.at(-1));
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** The Examples study page. Its text names only the programs that have a stored run. */
export function mediumStudy() {
  const runs = storedRuns().map(({ p, h, id }) => ({ p, h, r: storedRun(id) }));
  const rows = runs.map(({ p, h, r }) => [p.title, h.platform + " · " + h.title, String(p.logical), String(r.distance), r.sites + " " + h.qubits, String(r.cores), String(r.boards), String(r.ops), µs(r.makespanNs), (r.seconds / 60).toFixed(0), r.conforms ? "yes" : "no"]);
  const platforms = [...new Set(runs.map((x) => x.h.platform))], designs = MEDIUM_HARDWARE.filter((h) => runs.some((x) => x.h === h));
  const biggest = runs.reduce((m, x) => (x.r.sites > (m?.r.sites ?? 0) ? x : m), null);
  return {
    id: "medium", title: "Algorithms at medium scale", kicker: "Scale · well-known algorithms",
    summary: runs.length
      ? runs.length + " runs of " + storedPrograms().length + " programs of well-known algorithms on up to " + Math.max(...runs.map((x) => x.p.logical)) + " logical qubits, encoded in " + Math.min(...runs.map((x) => x.r.sites)) + " to " + Math.max(...runs.map((x) => x.r.sites)) + " physical qubits, on " + designs.length + " hardware design" + (designs.length === 1 ? "" : "s") + " of " + listed(platforms.map((x) => x.toLowerCase())) + ". Each is run through the operating system's interface on its machine's RISC-Q control system."
      : "Well-known algorithms on up to 17 logical qubits, encoded in hundreds of physical qubits, on three platforms. No run is stored yet.",
    method: [
      "Each algorithm is a logical program. The fault-tolerant compiler lowers it to a QSysASM listing of system calls against the machine's system specification, and its resource VM admits the listing. The OS then executes every system call at its listed time on the control system, and durations the hardware needed enter the next specification until every call fits its window.",
      "A program is compiled for each design it runs on: the design's capacities and its measured durations enter the system specification, so the same algorithm has a different listing on each. Every core runs firmware compiled from the listing in the cycle-exact model of RISC-Q; boards exchange measured bits and barriers over their PutLanes.",
      "Atom and ion operations take microseconds to milliseconds, so their programs are smaller: one run of the Lean model covers at most 4 s of machine time, and the compiler schedules each listing within 3.3 s. Bernstein–Vazirani on 4 inputs needs 5.2 s on the QCCD grid and 5.1 s on the ion modules, and on 8 inputs 4.2 s on the moving-atom lattice (the compiler's runtime bounds), so those pairs are not run.",
    ],
    sections: [
      { heading: "The hardware", text: designs.map((h) => h.platform + ", " + h.title + ": " + h.text + ".").join(" ") },
      { heading: "The programs", text: storedPrograms().map((p) => p.title + ": " + p.what).join(" ") },
      { heading: "The runs", table: { head: ["Program", "Hardware", "Logical qubits", "Distance", "Physical qubits", "Control cores", "Boards", "System calls", "Machine time (µs)", "Derivation (min)", "Every call in its window"], rows } },
    ],
    findings: runs.length
      ? [biggest ? "The largest run, " + biggest.p.title + " on " + biggest.h.title.toLowerCase() + ", uses " + biggest.r.sites + " physical qubits and " + biggest.r.cores + " control cores on " + biggest.r.boards + " boards." : "",
        runs.every((x) => x.r.conforms) ? "Every system call of every run ran inside its window." : runs.filter((x) => !x.r.conforms).map((x) => x.p.title + " on " + x.h.title + " did not keep every window.").join(" "),
        "The longest derivation, from compile to a specification every call fits, took " + Math.round(Math.max(...runs.map((x) => x.r.seconds)) / 60) + " minutes on one workstation."].filter(Boolean)
      : ["No run is stored yet."],
    command: "node riscq/calib/site.mjs",
  };
}

/** The design page: a program, and the decoders of its control system. */
export const MEDIUM_DESIGN = {
  intro: "Choose an algorithm, the hardware it was compiled for and, on the first design, the decoders of the control system, then run the compiled listing again on the cycle-exact model of the RISC-Q control system. Every system call is checked against its window.",
  params() {
    return [
      { key: "program", label: "Algorithm", value: (storedPrograms()[0] ?? MEDIUM_PROGRAMS[0]).id, group: "Program", source: "logical programs compiled by the fault-tolerant compiler", options: storedPrograms().map((p) => ({ value: p.id, label: p.title })) },
      { key: "hardware", label: "Hardware", value: MEDIUM_HARDWARE[0].id, group: "Hardware", source: "the study's designs, two per platform", options: MEDIUM_HARDWARE.filter((h) => storedRuns().some((x) => x.h === h)).map((h) => ({ value: h.id, label: h.platform + " · " + h.title })) },
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
  const onlyHardware = process.argv[3];
  for (const [p, h] of MEDIUM_PROGRAMS.filter((x) => !only || x.id === only).flatMap((x) => hardwareOfProgram(x).filter((y) => !onlyHardware || y.id === onlyHardware).map((y) => [x, y]))) {
    const id = runId(p.id, h.id);
    try {
      await compileMedium(p.id, h.id);
    } catch (error) {
      console.log(id, "ERROR", error.message.slice(0, 4000));
      // The listing the twin failed on, kept outside the repository to study without the compiler.
      if (error.listing) {
        const file = join(tmpdir(), "quantumos-medium-" + id + "-failed.json.gz");
        writeFileSync(file, gzipSync(JSON.stringify({ id, iteration: error.iteration, error: error.message, spec: error.spec, listing: publishable(error.listing) })));
        console.log(id, "failed listing kept in", file);
      }
    }
  }
}
