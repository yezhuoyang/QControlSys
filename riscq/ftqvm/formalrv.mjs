// FormalRV, used unchanged: its compiler lowers a program to a .sysprog listing against a system
// specification that QuantumOS writes (spec.mjs), its OCaml VM admits the listing, and its own
// expander gives the timed operations QuantumOS executes (bridge/ftqvm_expand.py).
//
// Nothing here re-implements FormalRV's semantics. The FormalRV checkout is the sibling folder
// `FormalRV` or the directory named by FORMALRV_ROOT; its compiler must be built
// (`dune build` in FormalRV/compiler). Outputs go to a directory of ours, never into FormalRV.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const EXE = ".exe"; // dune names executables *.exe on every OS

export function formalrvRoot() {
  return resolve(process.env.FORMALRV_ROOT || join(REPO, "..", "FormalRV"));
}

const bin = (name) => join(formalrvRoot(), "compiler", "_build", "default", "bin", name + EXE);

/** Whether a built FormalRV is present (tests skip without one). */
export function available() {
  return existsSync(join(formalrvRoot(), "ftq_vm", "sysprog.py")) && existsSync(bin("qec_sys")) && existsSync(bin("prepare_qec"));
}

function run(file, args, { cwd = formalrvRoot(), timeoutMs = 600_000 } = {}) {
  return new Promise((ok, fail) => {
    execFile(file, args, { cwd, windowsHide: true, maxBuffer: 1 << 28, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error && !stdout) return fail(new Error(`${file.split(/[\\/]/).pop()} failed: ${(stderr || error.message).trim()}`));
      ok({ stdout, stderr, code: error ? error.code : 0 });
    });
  });
}

const python = () => process.env.QCONTROL_PYTHON || "python";

/**
 * .qppm → .qec with FormalRV's prepare_qec: `code` and `distance` choose the code family,
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

/** .prog → .qppm with FormalRV's prepare_qppm. */
export async function prepareQppm(prog, out) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  rmSync(out, { force: true, recursive: true });
  const r = await run(bin("prepare_qppm"), ["--source", resolve(prog), "-o", resolve(out)]);
  if (!existsSync(out)) throw new Error("prepare_qppm refused: " + (r.stdout + r.stderr).trim());
  return out;
}

/** .qec → .sysprog with FormalRV's back end, against our machine and system spec files. */
export async function compileSys(qec, { machine, sysspec, out, options = [], staged = false }) {
  rmSync(out, { force: true, recursive: true }); // a listing left by an earlier run must not pass for this one
  // `staged`: FormalRV's staged back end (qec_sys_staged), which also lowers transversal gates.
  const r = await run(bin(staged ? "qec_sys_staged" : "qec_sys"), [resolve(qec), "--machine", resolve(machine), "--system-spec", resolve(sysspec), "-o", resolve(out), ...options]);
  if (!existsSync(out)) throw new Error("qec_sys refused: " + (r.stdout + r.stderr).trim());
  return out;
}

/** FormalRV's OCaml VM, the evaluator of record: { status, ... } as it prints it. */
export async function admit(sysprog) {
  const r = await run(python(), ["-m", "ftq_vm", "run-symbolic", resolve(sysprog), "--json"]);
  return JSON.parse(r.stdout);
}

/** FormalRV's own expansion of the listing into timed operations (bridge/ftqvm_expand.py). */
export async function expand(sysprog, { maxOps = 1_000_000 } = {}) {
  const r = await run(python(), [join(REPO, "bridge", "ftqvm_expand.py"), resolve(sysprog), "--max-ops", String(maxOps)], { cwd: REPO });
  const out = JSON.parse(r.stdout);
  if (out.error) throw new Error(`FormalRV refused the listing: ${out.error.code}: ${out.error.message}`);
  return out;
}

/**
 * The round gadgets FormalRV's back end will emit for a .qec, which the system spec must give
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
  throw Error("FormalRV kept asking for contracts: " + names.join(", "));
}

/**
 * The whole FormalRV path for one program: .qppm → .qec → .sysprog against `spec`
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
