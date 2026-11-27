// The fault-tolerant compiler, used unchanged: it lowers a logical program to a QSysASM listing
// (.sysprog) against a system specification that QuantumOS writes (spec.mjs), its resource VM
// admits the listing, and its own expander gives the timed operations QuantumOS executes
// (bridge/ftqvm_expand.py).
//
// Nothing here re-implements the compiler's semantics. Its checkout is the directory named by
// FT_COMPILER_ROOT, or else by the first line of the git-ignored file ft-compiler.local at the
// repository root; it must be built (`dune build` in its compiler/ folder). Outputs go to a
// directory of ours, never into the checkout.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, writeSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as qsysasm from "./qsysasm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const EXE = ".exe"; // dune names executables *.exe on every OS

export function compilerRoot() {
  if (process.env.FT_COMPILER_ROOT) return resolve(process.env.FT_COMPILER_ROOT);
  const local = join(REPO, "ft-compiler.local");
  const line = existsSync(local) ? readFileSync(local, "utf8").trim().split(/\s*\n/)[0] : "";
  return resolve(REPO, line || "ft-compiler");
}

// FT_COMPILER_BUILD names a dune build directory of the compiler outside its checkout (a build
// of its current source, `dune build --root compiler --build-dir <dir>`); default: the checkout's own.
const bin = (name) => join(process.env.FT_COMPILER_BUILD || join(compilerRoot(), "compiler", "_build"), "default", "bin", name + EXE);

/** Whether a built compiler is present (tests skip without one). */
export function available() {
  return existsSync(join(compilerRoot(), "ftq_vm", "sysprog.py")) && existsSync(bin("qec_sys")) && existsSync(bin("prepare_qec"));
}

/** How long one compile of the encoded program may take, in ms (FT_COMPILE_TIMEOUT_MS; default 6 h). */
const COMPILE_TIMEOUT_MS = Number(process.env.FT_COMPILE_TIMEOUT_MS) || 6 * 3600_000;

function run(file, args, { cwd = compilerRoot(), timeoutMs = 600_000 } = {}) {
  return new Promise((ok, fail) => {
    execFile(file, args, { cwd, windowsHide: true, maxBuffer: 1 << 28, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error && !stdout) return fail(new Error(`${file.split(/[\\/]/).pop()} failed: ${(stderr || error.message).trim()}`));
      ok({ stdout, stderr, code: error ? error.code : 0 });
    });
  });
}

const python = () => process.env.QCONTROL_PYTHON || "python";

/**
 * Like `run`, but stdout goes straight to a file and is read back from it: a listing of a medium-scale
 * program is hundreds of MB, past a child process's stdout buffer (it still parses as one string, up to
 * about 500 MB).
 */
function runToFile(file, args, { cwd = compilerRoot(), timeoutMs = 3_600_000 } = {}) {
  const out = join(tmpdir(), "qos-stdout-" + process.pid + "-" + Date.now() + ".json");
  const fd = openSync(out, "w");
  return new Promise((ok, fail) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ["ignore", fd, "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); closeSync(fd); fail(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      closeSync(fd);
      const stdout = readFileSync(out, "utf8");
      rmSync(out, { force: true });
      if (code && !stdout) return fail(new Error(`${file.split(/[\\/]/).pop()} failed: ${stderr.trim()}`));
      ok({ stdout, stderr, code });
    });
  });
}

/**
 * .qppm → .qec with the compiler's prepare_qec: `code` and `distance` choose the code family,
 * `specialize` fixes program parameters ({a: 0, b: 1}).
 */
export async function prepareQec(qppm, out, { code = "surface", distance = 3, specialize = {} } = {}) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  rmSync(out, { force: true, recursive: true });
  const args = [resolve(qppm), "--code", code, "--distance", String(distance)];
  for (const [k, v] of Object.entries(specialize)) args.push("--specialize", `${k}=${v}`);
  args.push("-o", resolve(out));
  const r = await run(bin("prepare_qec"), args);
  if (!existsSync(out)) throw new Error("prepare_qec refused: " + (r.stdout + r.stderr).trim());
  return out;
}

/** prepare_qec with extra options (`--opt NAME`, …). */
export async function prepareQecWith(qppm, out, { code = "surface", distance = 3, specialize = {} } = {}, extra = []) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  rmSync(out, { force: true, recursive: true });
  const args = [resolve(qppm), "--code", code, "--distance", String(distance)];
  for (const [k, v] of Object.entries(specialize)) args.push("--specialize", `${k}=${v}`);
  args.push(...extra, "-o", resolve(out));
  const r = await run(bin("prepare_qec"), args);
  if (!existsSync(out)) throw new Error("prepare_qec refused: " + (r.stdout + r.stderr).trim());
  return out;
}

/** .prog → .qppm with the compiler's prepare_qppm. */
export async function prepareQppm(prog, out) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  rmSync(out, { force: true, recursive: true });
  const r = await run(bin("prepare_qppm"), ["--source", resolve(prog), "-o", resolve(out)]);
  if (!existsSync(out)) throw new Error("prepare_qppm refused: " + (r.stdout + r.stderr).trim());
  return out;
}

/** .qec → .sysprog with the compiler's back end, against our machine and system spec files. */
export async function compileSys(qec, { machine, sysspec, out, options = [], staged = false }) {
  rmSync(out, { force: true, recursive: true }); // a listing left by an earlier run must not pass for this one
  // `staged`: the compiler's staged back end (qec_sys_staged), which also lowers transversal gates.
  // A medium program's compile can take more than an hour (Grover over 5 qubits at d = 5).
  const r = await run(bin(staged ? "qec_sys_staged" : "qec_sys"), [resolve(qec), "--machine", resolve(machine), "--system-spec", resolve(sysspec), "-o", resolve(out), ...options],
    { timeoutMs: COMPILE_TIMEOUT_MS });
  if (!existsSync(out)) throw new Error("qec_sys refused: " + (r.stdout + r.stderr).trim());
  return out;
}

/** The compiler's OCaml VM, the evaluator of record: { status, ... } as it prints it. */
export async function admit(sysprog) {
  const r = await run(python(), ["-m", "ftq_vm", "run-symbolic", resolve(sysprog), "--json"]);
  return JSON.parse(r.stdout);
}

/**
 * The compiler's own expansion of the listing into timed operations (bridge/ftqvm_expand.py),
 * restated as flat QSysASM (riscq/ftqvm/qsysasm.mjs): every op's `text` and `line` are its
 * statement in the flat program, which has no gadgets, loops or parameters. `qsysasm` is that
 * program's text.
 */
export async function expand(sysprog, { maxOps = 50_000_000 } = {}) {
  // Every guarded body is expanded, each op with the guard around it (`op.guard`); the run decides it.
  // The bridge writes one JSON value per line (--ndjson), read here a line at a time: a medium
  // program's listing has millions of operations, more than one string can hold.
  const file = join(tmpdir(), "qos-expand-" + process.pid + "-" + Date.now() + ".ndjson");
  const { code, stderr } = await runToPath(python(), [join(REPO, "bridge", "ftqvm_expand.py"), resolve(sysprog), "--max-ops", String(maxOps), "--guards", "taken", "--ndjson"], file, { cwd: REPO });
  let header = null;
  const ops = [], calls = [];
  for await (const line of createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })) {
    if (!line) continue;
    const value = JSON.parse(line);
    if (!header) header = value;
    else if (value.op) ops.push(value.op);
    else if (value.call) calls.push(value.call);
  }
  rmSync(file, { force: true });
  if (header?.error) throw new Error(`The compiler refused the listing: ${header.error.code}: ${header.error.message}`);
  if (!header) throw new Error("The listing expansion failed: " + (stderr.trim() || "exit " + code));
  return flatListing({ ...header, ops, calls });
}

/** The flat program's text is kept in the listing up to this many characters; beyond, in a file. */
const QSYSASM_IN_MEMORY = 200_000_000;

/**
 * The expansion restated as flat QSysASM, as qsysasm.canonical does (each op's `line` and `text`
 * are its statement's), written a statement at a time: the text of a listing of millions of
 * operations goes to a file (`qsysasmFile`), and `qsysasm` keeps its first 2,000 lines.
 */
export function flatListing(expansion, { inMemory = QSYSASM_IN_MEMORY } = {}) {
  const options = { machineLine: qsysasm.machineLine(expansion.machine), factories: qsysasm.factoriesIn(expansion.specs) };
  const head = qsysasm.format({ ops: [] }, options).text; // the headers and their blank line, each ended by "\n"
  const headLines = head.split("\n").length - 1;
  const order = expansion.ops.map((op, i) => i).sort((a, b) => expansion.ops[a].start - expansion.ops[b].start || expansion.ops[a].order - expansion.ops[b].order);
  const file = join(tmpdir(), "qos-qsysasm-" + process.pid + "-" + Date.now() + ".qsysasm");
  const fd = openSync(file, "w");
  writeSync(fd, head);
  let size = head.length, kept = [head], chunk = [];
  order.forEach((i, k) => {
    const op = expansion.ops[i];
    const text = qsysasm.statement(op);
    op.line = headLines + k + 1;
    op.text = text.trim();
    chunk.push(text);
    if (chunk.length === 10_000 || k === order.length - 1) {
      const block = chunk.join("\n") + "\n";
      writeSync(fd, block);
      size += block.length;
      if (kept && size <= inMemory) kept.push(block);
      else if (kept) kept = null;
      chunk = [];
    }
  });
  closeSync(fd);
  if (kept) {
    rmSync(file, { force: true });
    return { ...expansion, qsysasm: kept.join("") };
  }
  const first = readHead(file, headLines + 2000);
  return { ...expansion, qsysasm: first + "# … " + (order.length - 2000) + " more statements\n", qsysasmFile: file };
}

/** The first `count` lines of a text file. */
function readHead(file, count) {
  const fd = openSync(file, "r"), buffer = Buffer.alloc(1 << 20);
  let text = "", n;
  while ((text.match(/\n/g)?.length ?? 0) < count && (n = readSync(fd, buffer, 0, buffer.length, null)) > 0) text += buffer.toString("utf8", 0, n);
  closeSync(fd);
  return text.split("\n").slice(0, count).join("\n") + "\n";
}

/** Run a program with its stdout written to `path`. Resolves { code, stderr }. */
function runToPath(file, args, path, { cwd = compilerRoot(), timeoutMs = 12 * 3_600_000 } = {}) {
  const fd = openSync(path, "w");
  return new Promise((ok, fail) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ["ignore", fd, "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); closeSync(fd); fail(error); });
    child.on("close", (code) => { clearTimeout(timer); closeSync(fd); ok({ code, stderr }); });
  });
}

/**
 * The round gadgets the compiler's back end will emit for a .qec, which the system spec must give
 * a contract each. Found by asking the compiler: it names a missing contract, and a contract
 * for a gadget it does not emit. `sysspecFor(names)` writes the spec text for a candidate list.
 */
export async function discoverGadgets(qec, { machine, sysspecFor, dir, name = "discover", staged = false, options = [] }) {
  mkdirSync(dir, { recursive: true });
  const machineFile = join(dir, name + ".machine"), sysspecFile = join(dir, name + ".sysspec"), out = join(dir, name + ".sysprog");
  writeFileSync(machineFile, machine);
  let names = [];
  for (let i = 0; i < 16; i++) {
    writeFileSync(sysspecFile, sysspecFor(names));
    try {
      await compileSys(qec, { machine: machineFile, sysspec: sysspecFile, out, staged, options });
      return names;
    } catch (error) {
      const missing = /missing system resource contract for (\S+?)["')\s]/.exec(error.message + " ");
      const many = /missing system resource contracts for \d+ source gadgets: ([^")]+)/.exec(error.message);
      const extra = /contract names missing gadget (\S+?)["')\s]/.exec(error.message + " ");
      if (many) names = [...names, ...many[1].split(",").map((n) => n.trim()).filter((n) => n && !names.includes(n))];
      else if (missing) names = [...names, missing[1]];
      else if (extra) names = names.filter((n) => n !== extra[1]);
      else throw error;
    }
  }
  throw Error("The compiler kept asking for contracts: " + names.join(", "));
}

/**
 * The whole the compiler path for one program: .qppm → .qec → .sysprog against `spec`
 * (machine and system-spec text from spec.mjs), then admission and expansion.
 * Returns { dir, files, verdict, listing } with listing = expand()'s result.
 */
export async function build({ qppm, qec, spec, dir, name = "program", code, distance, specialize, options, staged = false }) {
  mkdirSync(dir, { recursive: true });
  const files = {
    machine: join(dir, name + ".machine"),
    sysspec: join(dir, name + ".sysspec"),
    qec: qec ? resolve(qec) : join(dir, name + ".qec"),
    sysprog: join(dir, name + ".sysprog"),
  };
  writeFileSync(files.machine, spec.machine);
  writeFileSync(files.sysspec, spec.sysspec);
  if (!qec) await prepareQec(qppm, files.qec, { code, distance, specialize });
  await compileSys(files.qec, { machine: files.machine, sysspec: files.sysspec, out: files.sysprog, options, staged });
  const verdict = await admit(files.sysprog);
  const listing = await expand(files.sysprog);
  return { dir, files, verdict, listing, text: readFileSync(files.sysprog, "utf8") };
}
