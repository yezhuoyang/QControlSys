export const operations = {
  playTriggered: [
    "Trigger waveform bank",
    "Start a new sample clock divider at this instruction edge. The first DAC strobe follows one full sample period later.",
  ],
  load: [
    "Load accumulator",
    "Write an immediate value to the sequencer’s 16-bit accumulator.",
  ],
  add: ["Add immediate", "Add to the accumulator with 16-bit wraparound."],
  jnz: [
    "Branch on accumulator",
    "A nonzero accumulator selects the branch target. Zero selects the next instruction.",
  ],
  jump: ["Jump", "Set the program counter to the target instruction."],
  wait: [
    "Wait for clock cycles",
    "The sequencer waits. The bus and DAC keep their own clock enables.",
  ],
  dma: [
    "Issue DMA read",
    "Start a transfer from signed 16-bit waveform RAM to the DAC FIFO.",
  ],
  dmaBusy: [
    "DMA engine occupied",
    "The sequencer retains this instruction until the active transfer completes.",
  ],
  play: [
    "Start sample playback",
    "The DAC consumes one FIFO word per enabled sample edge. The sequencer resumes on the final strobe.",
  ],
  halt: [
    "Halt sequencer",
    "Stop issuing instructions. An outstanding DMA transfer can still complete.",
  ],
  beat: [
    "Accept bus beat",
    "The destination accepts a packed beat. Its samples become visible after this edge’s DAC strobe.",
  ],
  denied: [
    "Bus slot reserved",
    "Another bus user owns this slot under the programmed grant schedule. The DMA address stays pending.",
  ],
  backpressure: [
    "FIFO backpressure",
    "The complete next beat will not fit in the FIFO. The bus retries on its next granted slot.",
  ],
  convert: [
    "Convert DAC sample",
    "Consume the oldest FIFO word, apply gain and DAC quantization, then evaluate the sampled output response.",
  ],
  underrun: [
    "DAC underrun",
    "The FIFO was empty at the strobe. The converter inserts a zero input and the response filter continues.",
  ],
  fault: [
    "Instruction fetch fault",
    "The program counter fell outside instruction memory.",
  ],
  stop: ["Execution stopped", "Inspect the stop reason and pending transfers."],
  finish: [
    "Controller halted",
    "The sequencer halted and the last DMA transfer retired.",
  ],
};

export function registers(s) {
  return {
    pc: ["Program counter", s.pc],
    acc: ["Accumulator", s.acc],
    wake: ["Earliest issue cycle", s.wake],
    dmaAddress: ["Next RAM address", s.dmaAddress],
    dmaLeft: ["DMA words remaining", s.dmaLeft],
    queue: [
      "FIFO addresses",
      s.fifo.map((w) => w.address).join(", ") || "empty",
    ],
    playLeft: ["Playback strobes left", s.playLeft],
    words: ["Transferred payload", s.words * 2 + " B"],
    beats: ["Accepted beats", s.beats],
    denied: ["Contended slots", s.denied],
    backpressure: ["FIFO stalls", s.backpressure],
    samples: ["Sample strobes", s.samples],
    underruns: ["Underruns", s.underruns],
    clipped: ["Clipped samples", s.clipped],
    addr: ["Sample RAM address", s.lastAddress ?? "none"],
    pcm: ["Input PCM", s.pcm],
    dacCode: ["Signed DAC code", s.dacCode],
    ideal: ["DAC output", s.idealUv + " µV"],
    filtered: ["Filtered output", s.outputUv + " µV"],
    history: ["Filter inputs (µV)", s.historyUv.join(", ") || "empty"],
    halted: ["Sequencer halted", s.halted ? "yes" : "no"],
    reason: ["Stop reason", s.reason || "running"],
  };
}

export function channels(p) {
  const range = p.fullScaleUv;
  const filteredRange =
    Math.max(1, p.firQ15.reduce((sum, t) => sum + Math.abs(t), 0) / 32768) *
    range;
  const scale = (v, peak) => 0.5 + v / (2 * peak);
  const limit = 2 ** (p.dacBits - 1);
  const volts = new Intl.NumberFormat("en", { maximumSignificantDigits: 4 });
  const voltageLabel = (uv) => {
    if (Math.abs(uv) >= 1e6) return volts.format(uv / 1e6) + " V";
    if (Math.abs(uv) >= 1000) return volts.format(uv / 1000) + " mV";
    return volts.format(uv) + " µV";
  };
  return [
    {
      label: "FIFO fill (words)",
      color: "#2a7287",
      read: (s) => s.fifo.length / p.fifoWords,
      ticks: [
        [0, "0"],
        [1, String(p.fifoWords)],
      ],
    },
    {
      label: "DAC code",
      color: "#8a6027",
      read: (s) => scale(s.dacCode, limit),
      ticks: [
        [0, String(-limit)],
        [0.5, "0"],
        [scale(limit - 1, limit), String(limit - 1)],
      ],
    },
    {
      label: "Output voltage",
      color: "#8058a1",
      read: (s) => scale(s.outputUv, filteredRange),
      ticks: [
        [0, voltageLabel(-filteredRange)],
        [0.5, "0 V"],
        [1, voltageLabel(filteredRange)],
      ],
    },
  ];
}

export function sampleRows(run) {
  return run.frames.filter((f) => f.op === "convert" || f.op === "underrun");
}

/** All four channels use a common trigger origin in integer ps. Digital
 * observations are paired in acquisition order. Scope samples use their own grid. */
export function comparePathCapture(run, capture) {
  if (capture?.version !== 1 || capture.kind !== "controller-path-capture")
    throw Error("Expected a version 1 controller-path-capture.");
  for (const field of ["board", "firmware", "trigger", "connector"])
    if (typeof capture[field] !== "string" || !capture[field].trim())
      throw Error("Missing capture " + field + ".");
  const at = (f) => f.atPs ?? Math.round(f.atNs * 1000);
  const samples = sampleRows(run);
  const expected = {
    issue: run.frames.filter(
      (f) =>
        f.part === "controller" &&
        f.sourcePc != null &&
        !["dmaBusy", "fault"].includes(f.op),
    ),
    bus: run.frames.filter((f) => f.op === "beat"),
    strobe: samples,
  };
  const rows = (name) => {
    const list = capture.observations?.[name];
    if (!Array.isArray(list))
      throw Error("Missing capture channel " + name + ".");
    for (const [i, r] of list.entries())
      if (
        !Number.isSafeInteger(r?.atPs) ||
        (i > 0 && r.atPs <= list[i - 1].atPs)
      )
        throw Error(
          "Expected increasing integer picoseconds at " +
            name +
            " row " +
            (i + 1) +
            ".",
        );
    return list;
  };
  const channels = {};
  for (const [name, frames] of Object.entries(expected)) {
    const actual = rows(name);
    let maxOffsetPs = 0,
      mismatched = 0,
      firstDifference;
    for (let i = 0; i < Math.max(actual.length, frames.length); i++) {
      const f = frames[i],
        r = actual[i];
      if (r) {
        const valid =
          name === "issue"
            ? Number.isSafeInteger(r.pc) && typeof r.op === "string"
            : name === "bus"
              ? Number.isSafeInteger(r.address) &&
                Array.isArray(r.words) &&
                r.words.length > 0 &&
                r.words.every(Number.isSafeInteger)
              : Number.isSafeInteger(r.code);
        if (!valid)
          throw Error("Invalid payload at " + name + " row " + (i + 1) + ".");
      }
      let matches = false;
      if (f && r) {
        maxOffsetPs = Math.max(maxOffsetPs, Math.abs(r.atPs - at(f)));
        if (name === "issue") matches = f.sourcePc === r.pc && f.op === r.op;
        else if (name === "strobe") matches = f.state.dacCode === r.code;
        else {
          const words = f.state.fifo.filter((w) => w.producer === f.id);
          matches =
            r.address === words[0].address &&
            r.words.length === words.length &&
            words.every((w, k) => w.pcm === r.words[k]);
        }
      }
      if (!matches) {
        mismatched++;
        firstDifference ??= {
          row: i + 1,
          eventId: f?.id ?? null,
          atPs: r?.atPs ?? null,
        };
      }
    }
    channels[name] = {
      expected: frames.length,
      measured: actual.length,
      mismatched,
      maxOffsetPs:
        Math.min(frames.length, actual.length) > 0 ? maxOffsetPs : null,
      firstDifference: firstDifference ?? null,
    };
  }
  const scope = rows("output");
  if (!scope.length)
    throw Error("Expected at least one connector voltage sample.");
  let index = -1,
    rmsUv = 0,
    peakUv = 0;
  const end = at(run.frames.at(-1));
  for (const r of scope) {
    if (!Number.isFinite(r.uv) || r.atPs < 0 || r.atPs > end)
      throw Error(
        "Connector samples need finite microvolts and timestamps inside the replay window.",
      );
    while (index + 1 < samples.length && at(samples[index + 1]) <= r.atPs)
      index++;
    const value =
      index < 0 ? run.initial.outputUv : samples[index].state.outputUv;
    const e = r.uv - value;
    rmsUv = Math.hypot(rmsUv, e / Math.sqrt(scope.length));
    peakUv = Math.max(peakUv, Math.abs(e));
  }
  return { channels, output: { samples: scope.length, rmsUv, peakUv } };
}

/** Trigger-aligned, edge-sampled observations. Preserve timing offsets when comparing. */
export function compareCapture(run, text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = header.split(",").map((c) => c.trim());
  const time = columns.indexOf("timeNs"),
    voltage = columns.indexOf("outputUv");
  if (time < 0 || voltage < 0 || new Set(columns).size !== columns.length)
    throw Error("Use unique CSV headers including timeNs and outputUv.");
  const samples = sampleRows(run);
  if (!samples.length || lines.length !== samples.length)
    throw Error(
      "Expected one row for each of the " + samples.length + " DAC strobes.",
    );
  let rmsUv = 0,
    maxUv = 0,
    maxNs = 0,
    prior = -Infinity;
  for (const [i, line] of lines.entries()) {
    const cells = line.split(",").map((c) => c.trim());
    const t = Number(cells[time]),
      uv = Number(cells[voltage]);
    if (
      cells.length !== columns.length ||
      !cells[time] ||
      !cells[voltage] ||
      !Number.isFinite(t) ||
      !Number.isFinite(uv) ||
      t <= prior
    )
      throw Error("Check timestamp and voltage at CSV row " + (i + 2) + ".");
    prior = t;
    const e = uv - samples[i].state.outputUv;
    rmsUv = Math.hypot(rmsUv, e / Math.sqrt(samples.length));
    maxUv = Math.max(maxUv, Math.abs(e));
    maxNs = Math.max(maxNs, Math.abs(t - samples[i].atNs));
  }
  return { samples: samples.length, rmsUv, maxUv, maxNs };
}

export function panel(run, applyProgram) {
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });
  const p = run.program,
    r = run.summary,
    last = run.frames.at(-1).state;
  const clockNs = p.clockNs + (p.clockSubNsPs ?? 0) / 1000;
  const busNs = clockNs * p.busEvery;
  const grants = p.grantPattern.filter(Boolean).length / p.grantPattern.length;
  $("busWidth").value = String(p.busBits);
  const pattern = JSON.stringify(p.grantPattern);
  $("busGrants").value =
    pattern === "[true]"
      ? "all"
      : pattern === "[true,false]"
        ? "half"
        : "custom";
  $("busGrants").querySelector("[value=custom]").hidden =
    $("busGrants").value !== "custom";
  $("controllerWord").value = p.inputWord;
  const edit = async (patch) => {
    const controls = [$("busWidth"), $("busGrants"), $("controllerWord")];
    for (const control of controls) control.disabled = true;
    try {
      if (!(await applyProgram({ ...p, ...patch }))) panel(run, applyProgram);
    } finally {
      for (const control of controls) control.disabled = false;
    }
  };
  $("busWidth").onchange = (e) => edit({ busBits: Number(e.target.value) });
  $("busGrants").onchange = (e) =>
    edit({ grantPattern: e.target.value === "all" ? [true] : [true, false] });
  $("controllerWord").onchange = (e) => {
    if (e.target.reportValidity()) edit({ inputWord: e.target.valueAsNumber });
  };
  const peak = ((p.busBits / 8) * 1000) / busNs;
  $("transferSummary").textContent =
    fmt(peak) +
    " MB/s peak · " +
    fmt(peak * grants) +
    " MB/s granted capacity · " +
    fmt(2000 / (p.sampleEvery * clockNs)) +
    " MB/s playback demand · " +
    fmt((r.payloadBytes * 1000) / r.elapsedNs) +
    " MB/s payload over the full run (" +
    r.payloadBytes +
    " B / " +
    r.elapsedNs +
    " ns). " +
    r.acceptedBeats +
    " accepted beats, " +
    last.denied +
    " contended slots, " +
    last.backpressure +
    " FIFO stalls, " +
    r.underruns +
    " underruns.";
  $("samplesCsv").onclick = () => {
    const lines = ["timeNs,outputUv,idealUv,dacCode,pcm,ramAddress,underrun"];
    for (const f of sampleRows(run)) {
      const s = f.state;
      lines.push(
        [
          f.atNs,
          s.outputUv,
          s.idealUv,
          s.dacCode,
          s.pcm,
          s.lastAddress ?? "",
          f.op === "underrun",
        ].join(","),
      );
    }
    const url = URL.createObjectURL(
      new Blob([lines.join("\n") + "\n"], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "controller-samples.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("compareFile").value = "";
  $("captureResult").textContent = "";
  const fileInput = $("compareFile");
  const compare = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw Error("Capture exceeds 1 MiB.");
      const raw = await file.text();
      if (raw.trimStart().startsWith("{")) {
        const result = comparePathCapture(run, JSON.parse(raw));
        if (fileInput.onchange !== compare || fileInput.files[0] !== file)
          return;
        const lines = Object.entries(result.channels).map(
          ([stage, r]) =>
            stage +
            " · " +
            r.measured +
            "/" +
            r.expected +
            " events · " +
            r.mismatched +
            " disagreements" +
            (r.firstDifference
              ? " (first at row " +
                r.firstDifference.row +
                ", replay " +
                (r.firstDifference.eventId ?? "ended") +
                ")"
              : "") +
            (r.maxOffsetPs === null
              ? ""
              : " · max ordinal-paired offset " + fmt(r.maxOffsetPs) + " ps"),
        );
        lines.push(
          "Connector · " +
            result.output.samples +
            " readings · " +
            fmt(result.output.rmsUv) +
            " µV RMS · " +
            fmt(result.output.peakUv) +
            " µV peak",
        );
        $("captureResult").textContent = lines.join("\n");
        return;
      }
      const result = compareCapture(run, raw);
      if (fileInput.onchange !== compare || fileInput.files[0] !== file) return;
      $("captureResult").textContent =
        result.samples +
        " strobes · RMS voltage error " +
        fmt(result.rmsUv) +
        " µV · peak error " +
        fmt(result.maxUv) +
        " µV · maximum strobe offset " +
        fmt(result.maxNs) +
        " ns";
    } catch (err) {
      if (fileInput.onchange === compare && fileInput.files[0] === file)
        $("captureResult").textContent = err.message;
    }
  };
  fileInput.onchange = compare;
  fileInput.disabled = false;
}
