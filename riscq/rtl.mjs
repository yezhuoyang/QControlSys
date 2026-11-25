// Ground truth from RISC-Q's RTL: run a QuantumOS SoC program (the document riscq/soc.mjs `program()`
// gives the Lean model) on RISC-Q's own `PulseTableSoc` in Verilator, and compare it with the Lean run.
//
// The RTL is built and simulated in WSL with RISC-Q's own flow (mill + SpinalHDL + Verilator) from a
// checkout at ~/riscq-rtl/RISC-Q (validation/riscq/rtl/README.md says how to set it up). The harness
// validation/riscq/rtl/QosRun.scala is copied into that checkout, loads every core's image over the host
// AXI port with the cores in reset, releases them, and records each core's commits (the execute-stage
// whitebox RISC-Q's own trace probe reads), every pulse window at a channel's output and every
// host-window write, with the cycle and the batch time.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const harness = path.join(root, "validation", "riscq", "rtl", "QosRun.scala");
const envScript = path.join(root, "validation", "riscq", "rtl", "rtl-env.sh");

/** A Windows path as WSL sees it. */
const wslPath = (p) => "/mnt/" + p[0].toLowerCase() + p.slice(2).replace(/\\/g, "/");

/** The RISC-Q channel-list SocSpec JSON of a Lean program document. */
export function rtlSpec(document, { dacNum = 16, adcNum = 16, linkPipe } = {}) {
  // RISC-Q records a readout trace on the fires of channels marked `trace` and needs at least one:
  // its own configs mark every readout-drive channel (`ro`). Without one, the first pulse channel.
  const isRo = (ch) => ch.kind === "pulse" && /(^|.)ro$/.test(ch.name);
  const anyRo = document.cores.some((c) => c.channels.some(isRo));
  let firstPulse = !anyRo;
  // A build with no pulse channel at all (a decoder-only core) gets one unused pulse channel after
  // the first core's own, so the SoC has its readout-trace source; no address the firmware uses moves.
  const anyPulse = document.cores.some((c) => c.channels.some((ch) => ch.kind === "pulse"));
  const extra = anyPulse ? [] : [{ name: "rtl_trace", kind: "pulse", slots: 1, env_depth: 1024, interp: 16, dac: 15, trace: true }];
  return {
    name: "quantumos", dsp_freq_hz: 1e12 / document.dspPeriodPs, dac_num: dacNum, adc_num: adcNum,
    link_pipe: linkPipe ?? document.model.linkPipe, hostwin_bits: 23,
    cores: document.cores.map((c) => ({
      name: c.name, mem_depth: c.memWords, with_mul: c.withMul, queue_depth: c.queueDepth,
      channels: c.channels.map((ch) => ({
        name: ch.name, kind: ch.kind, slots: ch.slots, env_depth: ch.kind === "dio" ? 0 : ch.envDepth, interp: ch.interp,
        ...(ch.dac !== undefined ? { dac: ch.dac } : {}), ...(ch.adc !== undefined ? { adc: ch.adc } : {}),
        trace: isRo(ch) || (firstPulse && ch.kind === "pulse" && !(firstPulse = false)),
      })).concat(c === document.cores[0] ? extra : [])
        // RISC-Q builds exactly one demod channel (decoder + ADC) into every core
        // (RiscqRfWithPulseTableFiber's require). A core without one gets it last, so none of its
        // own channel, sink or put addresses move.
        .concat(c.channels.some((ch) => ch.kind === "demod") ? [] : [{ name: "rtl_demod", kind: "demod", slots: 1, env_depth: 1024, interp: 4, adc: 15, trace: false }]),
    })),
  };
}

/** Whether the WSL RTL checkout is there. */
export function available() {
  try {
    execFileSync("wsl", ["-e", "test", "-d", "/home/" + wslUser() + "/riscq-rtl/RISC-Q"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
function wslUser() {
  return execFileSync("wsl", ["-e", "whoami"], { encoding: "utf8", windowsHide: true }).trim();
}

/**
 * Run documents on the RTL, all on one build (they must share one spec): one Verilator compile, one
 * simulation per document. `cycles`: dspClk cycles to simulate after reset release. Returns, per
 * document, { cycles, commits: [[core, cycle, time, pc, instr]], pulses: [[core, channel, openCycle,
 * openTime, closeCycle, closeTime]], host: [[core, cycle, time, address, data, mask]], done }.
 */
export function runRtlBatch(documents, { cycles = 20000, commits = true, commitLimit = 2000000, dir, workspace } = {}) {
  dir ??= path.join(root, "output", "rtl", (documents[0].name ?? "run").replace(/[^A-Za-z0-9_-]/g, "_"));
  dir = path.resolve(dir);
  mkdirSync(dir, { recursive: true });
  const pairs = documents.map((document, i) => {
    const input = path.join(dir, "input" + i + ".json"), output = path.join(dir, "output" + i + ".json");
    writeFileSync(input, JSON.stringify({ spec: rtlSpec(document), images: document.cores.map((c) => c.image), cycles: document.rtlCycles ?? cycles, commits, commitLimit, probe: document.rtlProbe ?? 0 }));
    return [input, output];
  });
  const env = { ...process.env, WSLENV: "QOS_RTL_WORKSPACE/u", QOS_RTL_WORKSPACE: workspace ?? "simWorkspace/qos-" + path.basename(dir) };
  const files = pairs.flat().map(wslPath).join(" ");
  execFileSync("wsl", ["-e", "bash", wslPath(envScript), "bash", "-c",
    // One mill at a time in the shared RISC-Q checkout: concurrent runs crash mill's daemon.
    `flock /tmp/quantumos-riscq-mill.lock bash -c 'cp ${wslPath(harness)} src/riscq/soc/sim/QosRun.scala && mill runMain riscq.soc.sim.QosRun ${files}' > ${wslPath(path.join(dir, "mill.log"))} 2>&1`],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env, maxBuffer: 1 << 28, timeout: 3600000 });
  return pairs.map(([, output]) => JSON.parse(readFileSync(output, "utf8")));
}

/** Run one document on the RTL. */
export function runRtl(document, options = {}) {
  return runRtlBatch([document], options)[0];
}

/**
 * Compare a Lean run (trace "full") with an RTL run of the same document, instruction by instruction.
 * Both are aligned on each core's first committed instruction. Returns per core the count of
 * instructions compared, how many commit on the same cycle, and the first that differ.
 */
export function compareCommits(lean, rtl, { limit = 20 } = {}) {
  const leanBy = new Map();
  for (const f of lean.frames ?? []) {
    if (f.pc === undefined && f.pc$ === undefined) continue;
    const core = f.part;
    // One frame per committed instruction: a stalled read commits at its "resume", not at its "wait".
    if (!["exec", "read", "host", "put", "write", "done", "resume", "park"].includes(f.op)) continue;
    (leanBy.get(core) ?? leanBy.set(core, []).get(core)).push({ pc: f.pc ?? f.state?.pc, at: f.atBatch });
  }
  const rtlBy = new Map();
  for (const [core, cycle, , pc] of rtl.commits) (rtlBy.get(core) ?? rtlBy.set(core, []).get(core)).push({ pc, at: cycle });
  const out = [];
  for (const [ci, rows] of rtlBy) {
    const name = lean.cores?.[ci]?.name ?? ci;
    const mine = leanBy.get(name) ?? leanBy.get(String(ci)) ?? [];
    const n = Math.min(rows.length, mine.length);
    const r0 = rows[0]?.at ?? 0, l0 = mine[0]?.at ?? 0;
    let same = 0, pcMismatch = 0;
    const diffs = [];
    for (let i = 0; i < n; i++) {
      if (rows[i].pc !== mine[i].pc) { pcMismatch++; if (diffs.length < limit) diffs.push({ i, rtlPc: rows[i].pc, leanPc: mine[i].pc }); continue; }
      const dr = rows[i].at - r0, dl = mine[i].at - l0;
      if (dr === dl) same++;
      else if (diffs.length < limit) diffs.push({ i, pc: rows[i].pc, rtl: dr, lean: dl });
    }
    out.push({ core: name, rtlCommits: rows.length, leanCommits: mine.length, compared: n, sameCycle: same, pcMismatch, diffs });
  }
  return out;
}
