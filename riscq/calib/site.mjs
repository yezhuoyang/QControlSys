// The Examples section of the site (/examples): the system-call calibration and runtime studies,
// one page each, assembled here from their results in validation/calib (riscq/calib/*.mjs,
// riscq/os/*.mjs). The site serves only what this script writes (validation/calib/site/), so a
// value that must not be published (an audit machine's figures) never leaves the raw files.
//
//   node riscq/calib/site.mjs   → validation/calib/site/index.json and <id>.json
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { PROGRAMS, DESIGN_IDS, STUDY_RUNS, studyRun } from "./example-runs.mjs";
import { PROGRAMS as OS_PROGRAMS, programText } from "../os/programs.mjs";
import { parse as parseQsysasm } from "../ftqvm/qsysasm.mjs";
import { mediumStudy } from "../ftqvm/medium.mjs";

const DIR = new URL("../../validation/calib/", import.meta.url);
const OUT = new URL("site/", DIR);
const read = (name) => (existsSync(new URL(name, DIR)) ? JSON.parse(readFileSync(new URL(name, DIR), "utf8")) : null);
const readAt = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const fmt = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? "–" : typeof x === "number" ? x.toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: d }) : String(x));
const us = (ns, d = 2) => (ns === null || ns === undefined ? "–" : fmt(ns / 1000, d));
const ms = (ns, d = 2) => (ns === null || ns === undefined ? "–" : fmt(ns / 1e6, d));
const cyc = (c) => fmt(c) + " (" + fmt(c * 2) + " ns)";
const PLATFORM = { superconducting: "Superconducting", neutral: "Neutral atoms", qccd: "Trapped ions" };
const COMMON_NOTE = "All numbers are measured on QuantumOS's Lean model of RISC-Q control hardware (its cores, hubs and lanes are checked against RISC-Q's RTL cycle for cycle), on generated or published hardware designs. They are properties of that model, not of laboratory hardware.";

function fabricStudy() {
  const f = read("fabric.json");
  const pub = f.publish, bar = f.barrier;
  return {
    id: "fabric", title: "The classical fabric of a RISC-Q system", kicker: "Calibration · every platform",
    summary: "How long a measured bit takes to reach another core, how fast boards synchronize, and how many bits per microsecond a board and a lane between boards carry. Every system call that moves a classical bit pays these costs.",
    method: [
      "Small firmware programs run on one to eight ZCU216-class boards at RISC-Q's 500 MHz clock: one core publishes a bit, every core meets at a barrier, cores publish bits back to back. Times come from the trace of each run.",
      "A board's hub joins its cores. Between boards, RISC-Q's lane carries one 72-bit frame per published bit. With three or more boards, board 0 forwards between lanes, an extension of RISC-Q's two-board design. The lane's word-clock phase is arbitrary at power-up, so every lane-dependent probe is swept over all eight phases; the spread is a few cycles.",
    ],
    sections: [
      { heading: "Latency", table: { head: ["Service", "Cycles (min–max over phases)", "Time"], rows: [
        ["Publish → own board's cores", fmt(29), "58 ns"],
        ["Publish → another board", fmt(pub[2].toRoot.min) + "–" + fmt(pub[2].toRoot.max), us(pub[2].toRoot.median * 2) + " µs"],
        ["Publish → a third board (through board 0)", fmt(pub[4].toOther.min) + "–" + fmt(pub[4].toOther.max), us(pub[4].toOther.median * 2) + " µs"],
        ["Barrier, one board", fmt(bar[1].lastOnRoot.median), us(bar[1].lastOnRoot.median * 2, 3) + " µs"],
        ...[2, 4, 8].map((B) => ["Barrier, " + B + " boards, last arrival on board 0 / elsewhere", fmt(bar[B].lastOnRoot.median) + " / " + fmt(bar[B].lastOnOther.median), us(bar[B].lastOnRoot.median * 2) + " / " + us(bar[B].lastOnOther.median * 2) + " µs"]),
      ] } },
      { heading: "Cable delay between boards", text: "The lane delay L (transceiver and cable, in 16 ns word clocks) is not part of RISC-Q's RTL; its simulation uses 3. Both costs grow exactly linearly: a publish takes 324 + 8L cycles to another board, a barrier whose last arrival is remote 784 + 16L.",
        table: { head: ["L (word clocks)", "Publish to another board (cycles)", "Barrier, last arrival remote (cycles)"], rows: f.laneDelay.map((x) => [fmt(x.laneWords), fmt(x.publishCycles), fmt(x.barrierWorstCycles)]) } },
      { heading: "Throughput", table: { head: ["Path", "Sustained", "Notes"], rows: [
        ["Hub (one board)", fmt(f.flood.hub.bitsPerUs) + " bits/µs", "8 cores publishing back to back: " + f.flood.hub.dropped + " of " + f.flood.hub.sent + " bits dropped (8-deep source queues)"],
        ["Lane (between two boards)", fmt(f.flood.lane.bitsPerUs, 1) + " bits/µs", "one frame per 160 cycles; the last of " + f.flood.lane.delivered + " bits arrives " + us(f.flood.lane.lastLatency * 2, 0) + " µs after it was published"],
      ] } },
      { heading: "Classical operations on a core", table: { head: ["Operation", "Core cycles"], rows: f.ops.map((o) => [o.op + (o.op === "parity" || o.op === "decode" ? " (" + o.k + " bit" + (o.k > 1 ? "s" : "") + ")" : ""), fmt(o.cycles)]) } },
    ],
    findings: [
      "A machine-wide classical bandwidth is two numbers 160 times apart: 500 bits/µs inside a board, 3.1 bits/µs across a lane. Syndrome bits have to stay on the board that measures them, or travel packed into words.",
      "Publishing has no back-pressure: a burst larger than the hub's 8-deep queues loses bits. Firmware must pace its publishes, so the pacing belongs to the cost of a measurement.",
      "Classical traffic delays synchronization: a bit published just before a barrier's release frame occupies the lane and delays the release on the far board by a frame (found in a Besedin et al. reproduction on two boards).",
    ],
    command: "node riscq/calib/fabric.mjs",
  };
}

function decoderStudy() {
  const c = readAt("../../validation/ftqvm/decoder-calibration.json");
  return {
    id: "decoder", title: "decode_syndrome: a compiled decoder, calibrated", kicker: "Calibration · the decoder system call",
    summary: "The decoder is a C program compiled for a RISC-Q core: union-find with peeling on each circuit's own detector graph (and cluster decoding with GF(2) elimination when the error model is a hypergraph). Its decode times are measured on noisy syndromes and become the system call's latency, its throughput and its decoding window.",
    method: [
      "Rotated surface-code memories (d = 3 and 5, 1 to 4 rounds, three noise strengths, SI1000) are sampled with Stim; each shot is decoded by the compiled decoder in the Lean model of a RISC-Q core and compared with PyMatching.",
      "The same decoder images were run on RISC-Q's RTL in Verilator: on a Luthra & Owens circuit and a Caune et al. circuit every instruction committed on the same cycle as in the Lean model (74,989 and 132,446 instructions, 12 decodes each); on a distance-5 colour code (hypergraph) the 28 host writes of 4 decodes, 1.38 to 1.55 million cycles each, landed on the same cycles.",
    ],
    sections: [
      { heading: "Decode times on noisy syndromes (µs)", table: { head: ["d", "Rounds", "p", "Detectors", "Median", "99th pct.", "Longest", "Same correction as PyMatching"], rows: c.workloads.map((w) => [w.d, w.rounds, w.p, w.detectors, us(w.ns.median, 1), us(w.ns.p99, 1), us(w.ns.max, 1), w.accuracy ? w.accuracy.agree + " / " + w.shots : "–"]) } },
      { heading: "What the system call declares", table: { head: ["Field", "Value", "How"], rows: Object.entries(c.fields).map(([k, x]) => [k, String(x.value), x.note ?? x.source]) } },
      { heading: "In a control program", text: "On a distance-3 memory on 17 transmons, in the same Lean run as the pulses: the bits reach the decoder " + c.inRun.bitsInNs + " ns after the last readout window closes, the decode takes " + us(c.inRun.computeNs, 1) + " µs, its result reaches another core " + c.inRun.resultOutNs + " ns later, and the conditioned pulse starts " + us(c.inRun.toPulseNs, 1) + " µs after the readout." },
    ],
    findings: [
      "One RISC-Q core decodes a syndrome bit in about 0.75 µs at the median (1.4 µs at worst) at d = 5: tens of microseconds per window, far from the nanoseconds of dedicated decoder logic.",
      "A single latency must be the worst case: at d = 5 and 4 rounds the median decode is half the longest.",
    ],
    command: "node riscq/decoders/calibrate.mjs 200",
  };
}

function tableStudy() {
  const t = read("table.json");
  const fields = ["gate1q_ns", "gate2q_ns", "measure_ns", "reset_ns", "route_latency_ns", "decoder_latency_ns", "pauli_frame_update_ns"];
  const rows = t.rows.filter((r) => fields.includes(r.field)).sort((a, b) => a.platform.localeCompare(b.platform) || a.design.localeCompare(b.design) || fields.indexOf(a.field) - fields.indexOf(b.field));
  return {
    id: "system-calls", title: "Every system call on six hardware designs", kicker: "Calibration · in programs",
    summary: "Eleven logical programs (memories, Deutsch–Jozsa, Bell pairs, a Z⊗Z merge, GHZ, a checked measurement, T injection, a loop of merges, at distances 3 and 5) on two designs of each platform. For every system call, the time each operation actually needed on the cycle-exact model, against the one number the machine declares.",
    method: [
      "For each program and design, the compiler lowers the program against a machine specification, its resource VM admits the listing, and the listing runs time-triggered on the design. Every duration the hardware exceeded is raised and the loop repeats until the run conforms. The final run's operations are the samples.",
      t.runs + " runs conform. " + (t.failed.length ? t.failed.map((f) => f.program + " on " + f.design + ": " + f.why).join("; ") + "." : ""),
    ],
    sections: [{ heading: "Needed against declared (ns)", table: { head: ["Platform", "Design", "Field", "Operations", "Declared", "Needed: min / median / 99th / max", "Slack at the median"],
      rows: rows.map((r) => [PLATFORM[r.platform], r.design, r.field, fmt(r.samples), fmt(r.derived), [r.needed.min, r.needed.p50, r.needed.p99, r.needed.max].map((x) => fmt(x)).join(" / "), fmt(r.slackAtMedian)]) } }],
    findings: [
      "Routes on atoms need 73 to 183 µs and on ions 0.87 to 1.25 ms; the declared route latency must be the longest, so the median route carries 90 µs (atoms) and 0.2 ms (ions) the hardware does not use.",
      "Readout lengths differ per transmon (1.0 to 1.4 µs on the generated chip's calibration): the declared measurement is the longest.",
      "The decoder's median decode is a fifth of its worst; the worst is what a single latency must say.",
    ],
    command: "node riscq/calib/insitu.mjs && node riscq/calib/table.mjs",
  };
}

function methodsStudy() {
  const m = read("methods.json");
  const rules = ["max", "p99", "p90", "p50"];
  const sum = rules.map((rule) => {
    const rs = m.rows.filter((r) => r.rule === rule);
    const conform = rs.reduce((s, r) => s + r.programsConforming * r.programs, 0) / rs.reduce((s, r) => s + r.programs, 0);
    const cover = rs.reduce((s, r) => s + r.coverage * r.ops, 0) / rs.reduce((s, r) => s + r.ops, 0);
    return [{ max: "worst case", p99: "99th percentile", p90: "90th percentile", p50: "median" }[rule], fmt(100 * conform, 1) + "%", fmt(100 * cover, 2) + "%"];
  });
  const fails = m.rows.filter((r) => r.rule === "max" && r.programsConforming < 1);
  return {
    id: "choosing-the-number", title: "Choosing the one number a system call declares", kicker: "Calibration · method",
    summary: "A machine specification gives each system call one latency. Fitted on some programs, does it hold for a program it has not seen? A leave-one-program-out test over the corpus, for four ways of choosing the number.",
    method: ["For each design and field, the number is fitted on every program but one and judged on the held-out program's operations: an operation that needed more than the number would be late, so its program would not conform."],
    sections: [
      { heading: "Held-out programs", table: { head: ["Rule", "Held-out programs whose every operation fits", "Operations that fit"], rows: sum } },
      { heading: "Where even the worst case of the other programs fails", table: { head: ["Design", "Field", "Held-out programs that conform", "Largest overrun (ns)"], rows: fails.map((r) => [r.design, r.field, fmt(100 * r.programsConforming, 0) + "%", fmt(r.worstOverrunNs)]) } },
    ],
    findings: [
      "Even the worst case seen on other programs is not portable for routes on atoms and ions: a new program brings a longer route. A route latency needs a model of distance, or the worst route the layout allows.",
      "Percentiles cover almost every operation but almost never a whole program: one late operation is enough to break a time-triggered schedule.",
    ],
    command: "node riscq/calib/methods.mjs",
  };
}

function backlogStudy() {
  const b = read("backlog.json");
  const sc = b.rows.filter((r) => r.platform === "superconducting");
  return {
    id: "decoder-backlog", title: "Decoder backlog: how many decoder cores", kicker: "Contention · decode_syndrome",
    summary: "Each logical qubit produces a decoding job every few syndrome rounds. If the decoder is slower than the rounds, jobs queue and the backlog grows without bound. How many RISC-Q decoder cores keep up, against a count that reserves a decoder for the worst case of every decode.",
    method: ["Jobs arrive at the round period (1.1 µs for superconducting, 4.45 ms for neutral atoms, 2 ms for ions); each lasts a decode time drawn from the compiled decoder's measured decodes for that distance and window; QuantumOS's runtime simulator queues them on c cores. A stream is stable when the worst wait per window does not grow along it. The static count reserves the worst decode for every job."],
    sections: [
      { heading: "Superconducting, one logical qubit", table: { head: ["d", "Window (rounds)", "p", "Load on one core", "Cores needed", "Static count", "99th-pct. wait at the cores needed (µs)"],
        rows: sc.map((r) => [r.d, r.w, r.p, fmt(r.loadWithOne, 1) + "×", r.criticalDecoders, r.vmDecoders, us(r.atCritical.waitP99, 1)]) } },
      { heading: "Latency against cores (superconducting)", table: { head: ["d", "Window", "p", "Cores", "Response p50 / p99 / max (µs)"], rows: b.tradeoff.map((r) => [r.d, r.w, r.p, r.decoders + (r.decoders === r.critical ? " (needed)" : r.decoders === r.vmDecoders ? " (static)" : ""), [r.responseP50, r.responseP99, r.responseMax].map((x) => us(x, 1)).join(" / ")]) } },
      { heading: "Neutral atoms and ions: logical qubits per decoder core", table: { head: ["Platform", "Logical qubits", "Cores needed", "Static count", "99th-pct. response (ms)"], rows: b.sharing.map((r) => [PLATFORM[r.platform], r.logical, r.criticalDecoders, r.vmDecoders, ms(r.responseP99)]) } },
    ],
    findings: [
      "On superconducting hardware a firmware decoder needs 6 to 26 RISC-Q cores per logical qubit at d = 3 to 5. Reserving the worst decode for every job asks for 1.7 to 3.3 times more cores than a queue needs, for the same 99th-percentile response.",
      "On atoms and ions one core is about 1% busy per logical qubit, but all logical qubits finish their rounds together, so the decoder sees bursts; a few cores serve hundreds of logical qubits.",
    ],
    command: "node riscq/calib/backlog.mjs",
  };
}

function factoryStudy() {
  const f = read("factory.json");
  return {
    id: "factories", title: "Magic-state factories under demand", kicker: "Contention · request_magic",
    summary: "A magic-state factory keeps only some of its attempts (postselection), so its output time is random. How many factories a stream of T gates needs, what a single factory latency misses, and who starves when requests have priorities.",
    method: ["The two factories reproduced on digital twins on this site: magic state cultivation on the Willow twin (an attempt takes " + us(f.factories[0].attemptNs) + " µs, " + fmt(100 * f.factories[0].accept, 1) + "% kept) and 5-to-1 distillation on the Gemini twin (" + ms(f.factories[1].attemptNs) + " ms, " + fmt(100 * f.factories[1].accept, 1) + "% kept). A request holds a factory until an attempt is kept. Requests arrive at a fixed interval and queue on F factories."],
    sections: [
      { heading: "Factories needed, and what a single latency gives", table: { head: ["Factory", "T-request interval", "Needed", "Declared as one attempt", "As the mean", "As the 99th percentile"],
        rows: f.provisioning.map((r) => [r.factory, r.factory === "cultivation" ? us(r.intervalNs, 1) + " µs" : ms(r.intervalNs, 1) + " ms", r.critical,
          r.with_attempt.factories + (r.with_attempt.stable ? "" : " (unstable)"), r.with_mean.factories + (r.with_mean.stable ? "" : " (unstable)"), r.with_p99.factories]) } },
      { heading: "Priorities near saturation (4 factories, 20% urgent requests)", table: { head: ["Factory", "Load", "Policy", "Urgent: 99th-pct. wait", "Background: 99th-pct. / longest wait"],
        rows: f.starvation.map((r) => { const u = r.factory === "cultivation" ? (x) => us(x, 1) + " µs" : (x) => ms(x, 1) + " ms"; return [r.factory, r.load, r.policy === "priority" ? "strict priority" : "first come", u(r.urgentWait.p99), u(r.backgroundWait.p99) + " / " + u(r.backgroundWait.max)]; }) } },
    ],
    findings: [
      "Declaring one attempt as the factory's latency never keeps up. Declaring the mean keeps up only at low demand. Declaring the 99th percentile keeps up but needs 2 to 4 times the factories a queue needs.",
      "Strict priority protects urgent T gates and starves background requests as the load approaches 1.",
      "In the runs above the runtime's schedule of T injection misses its windows by 4 ns: a factory's one-qubit gates follow a reset on the same qubits with no gap, and the hardware starts them a little later. The runtime simulator does not model that turnaround.",
    ],
    command: "node riscq/calib/factory.mjs",
  };
}

function contentionStudy() {
  const c = read("contention.json").rows;
  const by = (pl) => c.filter((r) => r.platform === pl);
  const range = (xs) => { const v = xs.filter(Boolean).sort((a, b) => a - b); return v.length ? fmt(v[0], 2) + "–" + fmt(v.at(-1), 2) + " (median " + fmt(v[v.length >> 1], 2) + ")" : "–"; };
  return {
    id: "deadlock", title: "Deadlock and scheduling policy in a dynamic runtime", kicker: "Contention · request_ancilla and every service",
    summary: "The resource VM admits a program as a fixed timetable. QuantumOS's runtime simulator instead runs the same program as soon as its dependencies and resources allow, the way a dynamic operating system would. Over the whole corpus: when does that deadlock, and how much faster is it when it does not?",
    method: [
      "The simulator holds the VM's services as resource pools, with ancilla qubits held from request_ancilla to their release. Run time-triggered with the listed durations, it reproduces every admitted listing exactly (all " + c.length + "), a check of the simulator against the VM.",
      "Three dynamic policies: greedy (an operation that fits may pass one that waits), strict (no passing among ready operations), and ordered acquisition of the ancilla pool (granted in program order, which rules out a circular wait).",
    ],
    sections: [{ heading: "Per platform", table: { head: ["Platform", "Runs", "Greedy deadlocks", "Ordered acquisition: speed-up over the timetable (declared latencies)", "Same with each operation's measured latency"],
      rows: ["superconducting", "neutral", "qccd"].map((pl) => [PLATFORM[pl], by(pl).length, by(pl).filter((r) => r.greedy.deadlock).length, range(by(pl).map((r) => r.ordered.speedup)), range(by(pl).map((r) => r.orderedMeasured.speedup))]) } },
      { heading: "Every run", table: { head: ["Program", "Design", "Operations", "Greedy", "Ordered ×", "Ordered, measured ×"], rows: c.map((r) => [r.program, r.design, fmt(r.ops), r.greedy.deadlock ? "deadlock at " + ms(r.greedy.atNs, 2) + " ms" : "completes", fmt(r.ordered.speedup, 2), fmt(r.orderedMeasured.speedup, 2)]) } }],
    findings: [
      "Greedy execution deadlocks in " + c.filter((r) => r.greedy.deadlock).length + " of " + c.length + " admitted programs, always on the ancilla pool: later iterations take ancillas early and hold them, and the operations that would release them wait for an ancilla. Every program with several blocks or loops deadlocks, on every platform.",
      "Ordered acquisition never deadlocks and finishes 1.04 to 10 times sooner than the fixed timetable: a static timetable is safe but leaves most of the machine idle.",
      "Those speed-ups use only the VM's services. Whether the hardware can actually run such a schedule is the next example.",
    ],
    command: "node riscq/os/contention.mjs",
  };
}

function gateStudy() {
  const g = read("gate.json"), h = read("gate-hardware.json");
  const spec = g.rows.filter((r) => r.which === "spec");
  const per = (rows, pl) => rows.filter((r) => r.platform === pl);
  const reasons = (rows) => { const w = {}; for (const r of rows) { if (r.error) { const k = /no free site/.test(r.error) ? "no legal placement" : "error"; w[k] = (w[k] ?? 0) + 1; } else if (!r.conforms) for (const k of Object.keys(r.byKind)) w[k + " late"] = (w[k + " late"] ?? 0) + 1; } return Object.entries(w).map(([k, n]) => k + " (" + n + ")").join(", ") || "–"; };
  const rowsFor = (rows, label) => ["superconducting", "neutral", "qccd"].map((pl) => [PLATFORM[pl], label, per(rows, pl).filter((r) => r.conforms).length + " / " + per(rows, pl).length, reasons(per(rows, pl))]);
  return {
    id: "hardware-gate", title: "Does the hardware run the runtime's schedule?", kicker: "Contention · conformance gate",
    summary: "The runtime simulator's schedules are written back as timetables and run on the cycle-exact model of the same design. Every operation must finish inside the window the simulator gave it. A failure names something the simulator's resource model is missing.",
    method: ["For every program and design of the corpus, the simulator's schedule with ordered acquisition and the declared durations is retimed, placed and run time-triggered. First with the compiler's services only; then, for atoms and ions, with the hardware's movers and readout channels added to the simulator."],
    sections: [{ heading: "Schedules the cycle-exact model keeps", table: { head: ["Platform", "Simulator's resources", "Conform", "Why the others do not"], rows: [...rowsFor(spec, "the VM's services"), ...(h ? rowsFor(h.rows, "plus movers and readout channels").filter((r) => r[0] !== "Superconducting") : [])] } }],
    findings: [
      "On superconducting hardware the VM's services are enough: a dynamic schedule over them runs on the cycle-exact model.",
      "On atoms and ions they are not: a route's time depends on where the other atoms or ions are and on shared movers and zones, which a routing bandwidth cannot express. Measurements share readout channels and decodes share the decoder core.",
      "Some schedules fit the qubit count but have no legal placement: a dynamic allocator must know geometry, not only counts (fragmentation).",
      ...(h ? ["Adding the movers and readout channels to the simulator does not change the outcome on atoms and ions: what is missing is not a count of resources but where the atoms and ions are when a route or a readout runs. A dynamic runtime for these platforms has to schedule with positions."] : []),
    ],
    command: "node riscq/os/gate.mjs" + (h ? " && node riscq/os/gate.mjs --hardware" : ""),
  };
}

function scaleStudy() {
  const f = read("fabric.json"), c = readAt("../../validation/ftqvm/decoder-calibration.json");
  const wl = c.workloads.find((w) => w.d === 5 && w.rounds === 4 && w.p === 0.001);
  const perBit = wl.ns.median / wl.detectors;
  const hub = f.flood.hub.bitsPerUs, lane = f.flood.lane.bitsPerUs;
  const rows = [11, 15, 21, 27, 35].map((d) => {
    const patch = 2 * d * d - 1, bitsPerRound = d * d - 1, roundNs = 1000;
    const bitsPerUs = (1000 * bitsPerRound) / roundNs;
    return [d, fmt(patch), fmt(Math.ceil(patch / 14)), fmt(bitsPerUs), fmt(Math.ceil(bitsPerUs / lane)), fmt(Math.ceil((bitsPerUs * perBit) / 1000)), ms(perBit * bitsPerRound * 10, 2)];
  });
  return {
    id: "scale", title: "Control hardware at scale", kicker: "Scale · surface-code patches",
    summary: "What one rotated surface-code patch at large distance asks of a RISC-Q control system with one core per transmon, at the rates measured in the other examples.",
    method: ["Arithmetic on measured rates, not a simulation: 14 cores per ZCU216 board (one demodulator per core), a hub of " + fmt(hub) + " bits/µs per board, a lane of " + fmt(lane, 1) + " bits/µs between boards, and the compiled decoder's median of " + fmt(perBit, 0) + " ns per syndrome bit (d = 5, 4 rounds, p = 10⁻³). A syndrome round every microsecond."],
    sections: [{ heading: "One patch", table: { head: ["d", "Transmons", "Boards", "Syndrome bits/µs", "Lanes to carry them off a board", "Firmware decoder cores to keep up", "10-round window, one core (ms)"], rows } }],
    findings: [
      "A large patch spans dozens to hundreds of boards, so its syndrome stream has to cross boards. A lane that carries one bit per frame is two to three orders of magnitude short: control hardware at this scale needs syndrome bits packed into lane words, or decoding inside each board with a hierarchy above it.",
      "A firmware decoder on control cores would need hundreds of cores per patch and milliseconds per decoding window. Large machines need dedicated decoder logic, roughly 500 times faster per unit, which FPGA union-find decoders reach.",
    ],
    command: "node riscq/calib/site.mjs",
  };
}

/** Logical programs scheduled by the operating system on every design (riscq/os/program-runs.mjs). */
function programsStudy() {
  const dir = new URL("programs/", DIR);
  const all = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"))) : [];
  const at = (p, d) => all.find((r) => r.program === p && r.design === d);
  const designs = DESIGN_IDS;
  const titleOf = (d) => all.find((r) => r.design === d)?.designTitle ?? d;
  const CALLS = ["request_ancilla", "route", "decode_syndrome", "pauli_frame_update", "request_magic"];
  const ns = (x) => (x === undefined || x === null ? "–" : x >= 10000 ? fmt(x / 1000, x >= 1e6 ? 0 : 1) + " µs" : fmt(x) + " ns");
  const programRows = OS_PROGRAMS.map((p) => {
    const ops = parseQsysasm(programText(p.id, "superconducting")).ops;
    const count = (k) => ops.filter((o) => o.kind === k).length;
    return [p.title, p.summary, String(p.blocks), fmt(ops.length), CALLS.filter(count).map((k) => k + " ×" + count(k)).join(", ")];
  });
  const cell = (r) => (!r ? "–" : r.error ? "error" : r.conforms ? "✓ " + ms(r.makespanNs, r.makespanNs < 1e6 ? 3 : 1) + " ms" : "✗ " + (r.late ?? "?") + " late");
  const matrix = OS_PROGRAMS.map((p) => [p.title, ...designs.map((d) => cell(at(p.id, d)))]);
  const ok = all.filter((r) => r.conforms).length;
  const FIELDS = [["gate2q_ns", "Two-qubit gate"], ["measure_ns", "Measurement"], ["route_latency_ns", "Route"], ["magic_state_latency_ns", "Magic state"], ["pauli_frame_update_ns", "Frame update"]];
  const spread = (d, f) => {
    const rs = all.filter((r) => r.design === d && r.conforms && r.learned?.[f] !== undefined && (f !== "magic_state_latency_ns" || /t-injection|two-t/.test(r.program)));
    if (!rs.length) return "–";
    const told = rs[0].told[f], vals = rs.map((r) => r.learned[f]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return lo === told && hi === told ? ns(told) + " (held)" : ns(told) + " → " + (lo === hi ? ns(lo) : ns(lo) + " – " + ns(hi));
  };
  const learnedRows = designs.map((d) => [d + " · " + titleOf(d), ...FIELDS.map(([f]) => spread(d, f))]);
  const countedRows = designs.map((d) => {
    // Some capacities grow with the program's placed sites (a transmon each): their range over the programs.
    const rs = all.filter((r) => r.design === d && r.counted), c = rs[0]?.counted ?? {};
    const range = (k) => { const v = rs.map((r) => r.counted[k]), lo = Math.min(...v), hi = Math.max(...v); return lo === hi ? fmt(lo) : fmt(lo) + " – " + fmt(hi); };
    return [d, range("qubits"), range("max_parallel_gates"), range("decoders"), range("qubit_routing_bandwidth"), c.readout_channels === undefined ? "one per transmon" : fmt(c.readout_channels)];
  });
  const iters = [...new Set(all.filter((r) => r.conforms).map((r) => r.iterations.length))].sort();
  const third = all.filter((r) => r.conforms && r.iterations.length > 2);
  const routeSpread = (d) => {
    const v = all.filter((r) => r.design === d && r.conforms && r.learned.route_latency_ns !== r.told.route_latency_ns).map((r) => r.learned.route_latency_ns);
    return v.length ? [Math.min(...v), Math.max(...v)] : null;
  };
  const rs = routeSpread("ions-qccd"), ra = routeSpread("atoms-moving");
  const magicSc = at("t-injection", "sc-B")?.learned.magic_state_latency_ns, magicAt = at("t-injection", "atoms-moving")?.learned.magic_state_latency_ns;
  const twoT = at("two-t", "sc-B"), oneT = at("t-injection", "sc-B");
  return {
    id: "programs", title: "Logical programs scheduled by the operating system", kicker: "Operating system · logical circuits on every design",
    summary: "Small logical circuits on distance-3 surface-code blocks, written as QSysASM without a single time. The operating system schedules each one, the timetable is compiled to RISC-Q firmware and run on the design's cycle-exact model, and every latency the hardware needed beyond what the OS was told is learned, until every operation of the program fits its window. " + OS_PROGRAMS.length + " programs on " + designs.length + " designs of three platforms.",
    method: [
      "Each program is a logical circuit written out at the physical level: every syndrome round requests 8 ancillas, routes each to its stabilizer's data qubits, entangles and measures them, and releases them; rounds are decoded by `decode_syndrome` and the correction applied with `pauli_frame_update`; logical CNOTs are transversal, and a magic state arrives by `request_magic` into a requested ancilla block with the factory's workspace. No statement carries a time.",
      "The operating system first counts the design's capacities: qubits, gate slots (beams or channels), decoders, factories, movers, the readout channels, and on atoms and ions the beams and channels a factory borrows; the interface's machine line has no field for the last two. It is told only typical latencies for the platform. It then schedules the program (list scheduling, first ready first served, ancillas acquired in program order so that no schedule deadlocks). The timetable is placed on the design, compiled to firmware for every control core and run on the Lean model of RISC-Q, and each operation is checked against the window the OS gave it.",
      "Every latency the hardware needed beyond the declared one is raised to what was measured (rounded to the controller's 2 ns or 10 ns grid) and the program is scheduled again. A program conforms when one run fits every window.",
    ],
    sections: [
      { heading: "The programs", table: { head: ["Program", "What it does", "Blocks", "Statements", "System calls"], rows: programRows } },
      { heading: "Every program on every design", text: ok + " of " + all.length + " runs conform. A cell gives the makespan of the OS's final schedule.",
        table: { head: ["Program", ...designs], rows: matrix } },
      { heading: "What the operating system learned", text: "Told → learned. Where programs needed different amounts, the range over the programs on that design.",
        table: { head: ["Design", ...FIELDS.map(([, w]) => w)], rows: learnedRows } },
      { heading: "What the operating system counted", table: { head: ["Design", "Qubits (placed sites, by program)", "Gate slots", "Decoders", "Routing (qubits/µs)", "Readout channels"], rows: countedRows } },
    ],
    findings: [
      "The schedule-then-measure loop converges in " + iters.join(" or ") + " runs on every design. Gate, measurement, decode and factory times do not depend on the schedule, so one run measures them; a route's time depends on where the qubits are, which the schedule changes" + (third.length ? " (" + third.length + " of " + all.length + " runs needed a third run for a longer route)" : "") + ". The OS does not need to be told the hardware's latencies; it needs its capacities.",
      "The interface's machine line has no field for readout concurrency. Atoms and ions have a fixed number of imaging or detection channels, and a schedule that measures more qubits at once than there are channels loses bits on the hardware. Counted on the design and given to the scheduler as a pool, the same programs conform (compare the last run above).",
      "On atoms and ions a magic-state factory is not a separate machine: its checks run on the same addressing beams and readout channels as the program (8 of each at once for a distance-3 patch). The interface counts factories but not what they borrow; the OS reserves those beams and channels for as long as `request_magic` runs, and without that the program's gates and readouts find no free channel.",
      ...(rs && ra ? ["One route latency is not enough on atoms and ions: the time a route needs depends on where the qubits are, so different programs on the same design need different route latencies (" + ns(ra[0]) + " – " + ns(ra[1]) + " on moving atoms, " + ns(rs[0]) + " – " + ns(rs[1]) + " on the trapped-ion QCCD). The OS has to declare the worst one, or schedule with positions."] : []),
      ...(magicSc ? ["A magic state takes " + ns(magicSc) + " from the injection factory on the superconducting design and " + ns(magicAt) + " on atoms; told 10 µs and 1 ms, the OS learns both from one run." + (twoT && oneT ? " With one factory, two T gates take " + ms(twoT.makespanNs, 3) + " ms against " + ms(oneT.makespanNs, 3) + " ms for one: the second request waits for the factory." : "")] : []),
      "Every run is reproducible from its timetable alone: each run above shows the QSysASM the OS produced, and replaying that text on the same design gives the same run.",
    ],
    command: "node riscq/os/program-runs.mjs && node riscq/calib/site.mjs",
  };
}

/**
 * The listings the Examples run (validation/calib/site/runs/<program>.<design>.json): the compiler's
 * admitted listing of each in-situ run, its distance, and for every field the number fitted on the
 * other programs on the same design (max, p99, p50), for the "windows" choice.
 */
function writeRuns() {
  const dir = new URL("insitu/", DIR), runsDir = new URL("runs/", OUT);
  mkdirSync(runsDir, { recursive: true });
  const all = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"))).filter((r) => r.listing && !r.error && r.conforms);
  const FIELD = { H: "gate1q_ns", S: "gate1q_ns", Sdg: "gate1q_ns", X: "gate1q_ns", Z: "gate1q_ns", CNOT: "gate2q_ns", CZ: "gate2q_ns", CY: "gate2q_ns", measure: "measure_ns", request_ancilla: "reset_ns", route: "route_latency_ns", decode_syndrome: "decoder_latency_ns", pauli_frame_update: "pauli_frame_update_ns" };
  const q = (v, p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  let n = 0;
  for (const r of all) {
    if (!PROGRAMS.includes(r.program) || !DESIGN_IDS.includes(r.design)) continue;
    // Distance-5 programs only where their studies run them: they are the large listings.
    if (/-d5$/.test(r.program) && r.design !== "sc-B") continue;
    const by = {};
    for (const o of all.filter((x) => x.design === r.design && x.program !== r.program)) for (const sm of o.samples) {
      const f = FIELD[sm.kind];
      if (f && sm.neededNs !== null) (by[f] ??= []).push(sm.neededNs);
    }
    const fitted = Object.fromEntries(["max", "p99", "p50"].map((rule) => [rule, Object.fromEntries(Object.entries(by).map(([f, v]) => {
      v.sort((a, b) => a - b);
      return [f, Math.max(2, Math.ceil((rule === "max" ? v.at(-1) : q(v, rule === "p99" ? 0.99 : 0.5)) / 2) * 2)];
    }))]));
    writeFileSync(new URL(r.program + "." + r.design + ".json.gz", runsDir), gzipSync(JSON.stringify({ program: r.program, platform: r.platform, design: r.design, distance: r.distance, listing: r.listing, fitted })));
    n++;
  }
  return n;
}

export async function build({ runs = true } = {}) {
  // The medium-scale algorithms once a run of them is stored (riscq/ftqvm/medium.mjs).
  // Its command: this page, from the stored runs (a compile of the programs needs the compiler).
  const medium = STUDY_RUNS.medium ? [{ ...mediumStudy(), command: "node riscq/calib/site.mjs" }] : [];
  const studies = [programsStudy(), ...medium, fabricStudy(), decoderStudy(), tableStudy(), methodsStudy(), backlogStudy(), factoryStudy(), contentionStudy(), gateStudy(), scaleStudy()];
  mkdirSync(OUT, { recursive: true });
  if (runs) console.log("stored listings:", writeRuns());
  for (const s of studies) {
    const file = new URL(s.id + ".json", OUT);
    // The study's runs with their 3D tracks (riscq/calib/example-runs.mjs), or the ones stored before.
    let rows = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).rows ?? [] : [];
    if (runs && STUDY_RUNS[s.id]) {
      rows = [];
      for (const r of STUDY_RUNS[s.id]) {
        const t0 = Date.now();
        rows.push(await studyRun(r));
        const last = rows.at(-1);
        console.log("  " + s.id + ": " + r.label + " · " + (last.conforms ? "conforms" : last.deadlock ? "deadlock" : "does not conform") + " · " + (Date.now() - t0) / 1000 + " s");
      }
    }
    writeFileSync(file, JSON.stringify({ ...s, rows, note: COMMON_NOTE, generated: new Date().toISOString() }) + "\n");
  }
  writeFileSync(new URL("index.json", OUT), JSON.stringify(studies.map(({ id, title, kicker, summary }) => ({ id, title, kicker, summary })), null, 1) + "\n");
  return studies;
}

if (import.meta.url === "file:///" + process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")) {
  const s = await build({ runs: !process.argv.includes("--no-runs") });
  const text = readFileSync(new URL("index.json", OUT), "utf8") + s.map((x) => readFileSync(new URL(x.id + ".json", OUT), "utf8")).join("");
  // Names a page must not carry: the compiler's audit machines, and the words listed in a private, git-ignored
  // file (one per line) when it is present.
  const privateFile = new URL("../../docs/ftqvm-site-banned.md", import.meta.url);
  const words = ["GE2021", "Gidney2025", "Beverland2022", "Pinnacle", "Jacinto2026", "Zhou2025", "CainXu2026", "audit",
    ...(existsSync(privateFile) ? readFileSync(privateFile, "utf8").split(/\s*\n\s*/).map((w) => w.trim()).filter(Boolean) : [])];
  const lower = text.toLowerCase();
  const banned = words.find((w) => lower.includes(w.toLowerCase()));
  if (banned) throw Error("a site page names something it must not: " + banned);
  console.log("wrote", s.length, "studies to validation/calib/site/");
}
