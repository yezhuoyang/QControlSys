// Headless access to the RISC-Q controller runs.
//   node riscq/cli.mjs --list
//   node riscq/cli.mjs --example superconducting-feedforward [--outcome c=1] [--trace full] [--out run.json]
//   node riscq/cli.mjs --qasm circuit.qasm [--platform superconducting|qccd] [--outcome c=1]
//   node riscq/cli.mjs --calls program.json [--outcome s0=1]      system calls on the transmon ring
//   node riscq/cli.mjs --design machine.json --qasm circuit.qasm  your own hardware design (riscq/design.mjs)
//   node riscq/cli.mjs --ring-design > machine.json               the built-in ring as a design to edit
//   node riscq/cli.mjs --verify run.json
// A run prints a summary. `--out` saves the whole run: source, hardware instructions, firmware
// statistics, the Lean program, every frame and the summary. `--verify` re-executes a saved run
// in Lean and reports the first differing frame.
import { readFile, writeFile } from "node:fs/promises";
import { examples, run } from "./examples.mjs";
import { execute } from "./soc.mjs";

const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
try {
  if (args.includes("--ring-design")) {
    const { ringDesign } = await import("./design.mjs");
    console.log(JSON.stringify(ringDesign(), null, 1));
  } else if (args.includes("--list")) {
    for (const e of examples) console.log(e.id.padEnd(30) + e.platform.padEnd(16) + e.title);
  } else if (value("--verify")) {
    const saved = JSON.parse(await readFile(value("--verify"), "utf8"));
    const { program, system, initial, frames, summary } = saved;
    console.log(JSON.stringify(await execute({ program, system, initial, frames, summary }, { checkTrace: true })));
  } else {
    const outcomes = {};
    args.forEach((a, i) => {
      if (a === "--outcome") {
        const [bit, v] = args[i + 1].split("=");
        outcomes[bit] = Number(v);
      }
    });
    const request = { outcomes, trace: value("--trace"), frames: value("--frames") && Number(value("--frames")) };
    if (value("--example")) request.example = value("--example");
    else if (value("--qasm")) Object.assign(request, { platform: value("--platform") ?? "superconducting", qasm: await readFile(value("--qasm"), "utf8") });
    else if (value("--calls")) Object.assign(request, { platform: "superconducting", calls: JSON.parse(await readFile(value("--calls"), "utf8")) });
    else throw Error("Usage: node riscq/cli.mjs --list | --example <id> | --qasm <file> | --calls <file> | --verify <run.json>");
    if (value("--design")) request.design = JSON.parse(await readFile(value("--design"), "utf8"));
    const result = await run(request);
    if (value("--out")) await writeFile(value("--out"), JSON.stringify(result));
    const s = result.summary;
    console.log(JSON.stringify({
      platform: result.platform, machine: result.machine.name, status: s.status,
      elapsedNs: s.elapsedPs / 1000, frames: result.frames.length,
      hardwareInstructions: result.hardware.segments.reduce((n, seg) => n + seg.ops.length, 0),
      pulses: s.pulses.length, carrierUpdates: s.tones.length, faults: s.faults,
      // Cores that take part: those that issue timed writes, and the decoder.
      firmware: result.firmware.filter((f) => f.writes || f.core === "decoder").map((f) => ({ core: f.core, words: f.instructions, timedWrites: f.writes })),
      bits: result.derived.bits,
    }, null, 1));
    if (s.status !== "quiescent" || s.faults.length) process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
