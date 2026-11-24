// C firmware for RISC-Q cores, built the way RISC-Q builds it (software/riscq/build.py
// compile_c): RISC-Q's start.S, muldiv.c and riscq.h, a generated riscq_map.h and link.ld, and
// clang for rv32i (with Zmmul when the core has a multiplier). RISC-Q uses a
// riscv64-unknown-elf-clang; this module drives any clang that has the riscv32 target, with
// lld as the linker. The result is an ELF file that `loadElf` places in the core's RAM.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAP, LEAD, READOUT_LEAD, channelBase, sinkAddress } from "./soc.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** RISC-Q's firmware runtime, vendored unmodified (validation/riscq/README.md). */
export const runtimeDir = path.join(root, "validation", "riscq", "fw");

/** A clang that can target riscv32, or undefined. `RISCQ_CLANG` names one explicitly. */
export function findClang() {
  const candidates = [process.env.RISCQ_CLANG, "clang", "C:/Program Files/LLVM/bin/clang.exe", "riscv64-unknown-elf-clang"].filter(Boolean);
  for (const clang of candidates) {
    try {
      const targets = execFileSync(clang, ["--print-targets"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      if (/riscv32/.test(targets)) return clang;
    } catch {}
  }
  return undefined;
}

/** `riscq_map.h` for one core: the addresses riscq.h and start.S use (map.py gen_header). */
export function mapHeader(spec, coreIndex) {
  const core = spec.cores[coreIndex];
  const hex = (value) => "0x" + (value >>> 0).toString(16);
  const defines = [
    ["RQ_MEM_BASE", MAP.MEM_BASE], ["RQ_MEM_BYTES", core.memWords * 4],
    ["RQ_CTRL_FROM_HOST", 0x2000], ["RQ_CTRL_TIME_CMP", MAP.CTRL_TIME_CMP],
    ["RQ_CTRL_WAIT_TIME_CMP", MAP.CTRL_WAIT_TIME_CMP], ["RQ_CTRL_DONE", MAP.CTRL_DONE],
    ["RQ_CTRL_RES", MAP.SINK_BASE], ["RQ_CTRL_REAL", MAP.SINK_BASE + 4], ["RQ_CTRL_IMAG", MAP.SINK_BASE + 8],
    ["RQ_CTRL_TIME", MAP.CTRL_TIME],
    ["RQ_FIRE", MAP.RF_FIRE], ["RQ_FREQ", MAP.RF_FREQ], ["RQ_DC_OFFSET", MAP.RF_DC_OFFSET],
    ["RQ_PHASE_OFFSET", MAP.RF_PHASE_OFFSET], ["RQ_SLOT_STRIDE", MAP.RF_SLOT_STRIDE], ["RQ_START_TIME", MAP.RF_START_TIME],
    ["RQ_HOSTWIN", MAP.HOSTWIN], ["RQ_HOSTWIN_BYTES", 1 << 24],
    ["RQ_PUT_WINDOW", MAP.PUT_WINDOW], ["RQ_GROUP_NODE0", MAP.GROUP_NODE0], ["RQ_BARRIER_NODE0", MAP.BARRIER_NODE0],
    ["RQ_INBOX_NODE0", MAP.INBOX_NODE0], ["RQ_GROUPS", MAP.GROUP_NODES], ["RQ_BARRIER_IDS", MAP.BARRIER_IDS],
    ["RQ_INBOX_BOARD", MAP.INBOX_BOARD], ["RQ_INBOX_RELEASE", MAP.INBOX_RELEASE],
    ["RQ_INBOX_MAILBOX0", MAP.INBOX_MAILBOX0], ["RQ_MAILBOX_NUM", 2],
    ["RQ_SINK_BASE", MAP.SINK_BASE], ["RQ_SINK_STRIDE", MAP.SINK_STRIDE],
    ["RQ_ENV_DEPTH", Math.min(...core.channels.map((ch) => ch.envDepth))],
    ["RQ_LEAD", LEAD], ["RQ_RO_LEAD", READOUT_LEAD], ["RQ_RO_MAX_WIN", 1 << 14],
  ];
  core.channels.forEach((ch, i) => {
    defines.push(["RF_CH" + i, channelBase(i)], ["RQ_CH_" + ch.name.toUpperCase(), channelBase(i)]);
    if (ch.kind !== "pulse") defines.push(["RQ_SINK_" + ch.name.toUpperCase(), sinkAddress(core, i)]);
  });
  return ["/* GENERATED for core '" + core.name + "' of build '" + spec.name + "' by riscq/toolchain.mjs. */",
    "#ifndef RISCQ_MAP_H", "#define RISCQ_MAP_H", "",
    ...defines.map(([name, value]) => "#define " + name + " " + hex(value)), "", "#endif", ""].join("\n");
}

/** `link.ld`: one RAM region, entry at its start, 1 KB stack reserve (map.py gen_linker). */
export function linkerScript(spec, coreIndex) {
  const bytes = spec.cores[coreIndex].memWords * 4;
  return `/* GENERATED for build '${spec.name}' by riscq/toolchain.mjs after RISC-Q map.py gen_linker. */
ENTRY(_start)
MEMORY { RAM (rwx) : ORIGIN = 0x${MAP.MEM_BASE.toString(16)}, LENGTH = ${bytes} }
SECTIONS {
  .text   : { KEEP(*(.text.init)) *(.text*) } > RAM
  .rodata : { *(.rodata*) *(.srodata*) } > RAM
  .data   : { *(.data*) *(.sdata*) } > RAM
  .bss (NOLOAD) : {
    . = ALIGN(4);
    __bss_start = .;
    *(.bss*) *(.sbss*) *(COMMON)
    . = ALIGN(4);
    __bss_end = .;
  } > RAM
  /DISCARD/ : { *(.eh_frame*) *(.comment) *(.riscv.attributes) }
  _end = .;
  __stack_top = ORIGIN(RAM) + LENGTH(RAM);
  ASSERT(_end <= __stack_top - 1024, "riscq: program overflows RAM (1 KB stack reserve)")
}
`;
}

/**
 * Compile C sources for one core. `files` maps a file name to its text. Every `.c` file is
 * compiled and linked with RISC-Q's start.S and muldiv.c. Headers may be given the same way.
 * Returns the ELF bytes and the command line. Throws with clang's message when the build
 * fails, which includes a program that does not fit the core's RAM.
 */
export function compileC(spec, coreIndex, files, { clang = findClang(), optimize = "-O2" } = {}) {
  if (!clang) throw Error("No clang with the riscv32 target was found. Install LLVM or set RISCQ_CLANG.");
  const core = spec.cores[coreIndex];
  const all = {
    "start.S": readFileSync(path.join(runtimeDir, "start.S"), "utf8"),
    "muldiv.c": readFileSync(path.join(runtimeDir, "muldiv.c"), "utf8"),
    "riscq.h": readFileSync(path.join(runtimeDir, "riscq.h"), "utf8"),
    "riscq_map.h": mapHeader(spec, coreIndex),
    "link.ld": linkerScript(spec, coreIndex),
    ...files,
  };
  // RISC-Q's flags (build.py _flags), with the target and linker named for a generic clang.
  const flags = ["--target=riscv32-unknown-elf", "-march=" + (core.withMul ? "rv32i_zmmul" : "rv32i"), "-mabi=ilp32", optimize,
    "-fwrapv", "-nostdlib", "-ffreestanding", "-mno-relax", "-Werror=implicit-function-declaration", "-fuse-ld=lld", "-I.", "-w"];
  const sources = Object.keys(all).filter((name) => /\.(c|S)$/.test(name)).sort((a, b) => (a === "start.S" ? -1 : b === "start.S" ? 1 : a.localeCompare(b)));
  const key = createHash("sha256").update(JSON.stringify({ all, flags })).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "qcontrol-fw", key);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(all)) writeFileSync(path.join(dir, name), text);
  const args = [...flags, "-T", "link.ld", "-o", "main.elf", ...sources];
  try {
    execFileSync(clang, args, { cwd: dir, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw Error("clang failed for core " + core.name + ":\n" + (error.stderr || error.message));
  }
  const elf = new Uint8Array(readFileSync(path.join(dir, "main.elf")));
  rmSync(dir, { recursive: true, force: true });
  return { elf, command: "clang " + args.join(" ") };
}

/** Function and object symbols of a 32-bit little-endian ELF: [{ name, address, size, kind }]. */
export function elfSymbols(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shoff = view.getUint32(0x20, true), shentsize = view.getUint16(0x2e, true), shnum = view.getUint16(0x30, true);
  const section = (i) => {
    const at = shoff + i * shentsize;
    return { type: view.getUint32(at + 4, true), offset: view.getUint32(at + 16, true), size: view.getUint32(at + 20, true),
      link: view.getUint32(at + 24, true), entsize: view.getUint32(at + 36, true) };
  };
  const symbols = [];
  for (let i = 0; i < shnum; i++) {
    const table = section(i);
    if (table.type !== 2) continue; // SHT_SYMTAB
    const strings = section(table.link);
    const text = (offset) => {
      let end = strings.offset + offset;
      while (bytes[end]) end++;
      return Buffer.from(bytes.subarray(strings.offset + offset, end)).toString("latin1");
    };
    for (let at = table.offset; at < table.offset + table.size; at += table.entsize || 16) {
      const kind = view.getUint8(at + 12) & 15;
      if (kind !== 1 && kind !== 2) continue; // STT_OBJECT, STT_FUNC
      symbols.push({ name: text(view.getUint32(at, true)), address: view.getUint32(at + 4, true), size: view.getUint32(at + 8, true),
        kind: kind === 2 ? "function" : "object" });
    }
  }
  return symbols.sort((a, b) => a.address - b.address);
}

/**
 * Source map of a compiled image for the Lean model: each instruction is attributed to the C
 * function that contains it, through `name(function)`. Code outside every function, and data,
 * carry no source.
 */
export function functionSourceMap(bytes, name = (fn) => fn) {
  const map = [];
  let end = MAP.MEM_BASE;
  for (const symbol of elfSymbols(bytes).filter((s) => s.kind === "function" && s.size > 0)) {
    if (symbol.address > end && map.length) map.push({ pc: end - MAP.MEM_BASE, source: "" });
    map.push({ pc: symbol.address - MAP.MEM_BASE, source: name(symbol.name) });
    end = symbol.address + symbol.size;
  }
  if (map.length) map.push({ pc: end - MAP.MEM_BASE, source: "" });
  return map.filter((entry, i) => i === 0 || entry.pc !== map[i - 1].pc || entry.source !== "");
}

export { existsSync };
