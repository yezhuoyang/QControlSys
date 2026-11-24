// Measurements for system-call calibration, taken from a run of the controller model.
//
// The fault-tolerant virtual machine of the companion paper charges each system call one
// latency and one demand on a shared service, and reserves r(N, D) = ⌈1000·N / D⌉ items/µs for
// moving N items in D ns. These functions measure what the controller model actually spends,
// so that a declared latency or capacity can be compared with it:
//   route      time and qubit count of each qubit transport, per platform
//   control    how fast a core issues timed writes, the traffic on its posted link, the widest
//              burst of simultaneous pulses and the delay the burst cost
//   feedback   time from the close of a measurement window to the bit at another core and to
//              the earliest pulse conditioned on it
//   decode     for each decode_syndrome: when the syndrome bits reached the decoder core, how
//              long the lookup took, when the Pauli frame changed and when a pulse conditioned
//              on a decoded bit opened
// Every number is derived from the trace or from the hardware instructions the trace confirms.
// Scope: timing of the classical controller and of the scheduled operations. Physical error,
// heating and loss are outside the model, so these are costs, not fidelities.

/** The rate the virtual machine reserves for N items moved in D ns, in items per µs. */
export const reservedRate = (items, ns) => Math.ceil((1000 * items) / ns);

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  return { count: sorted.length, min: sorted[0], median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), max: sorted.at(-1) };
}

/**
 * Qubit transport samples of a run.
 * neutral: one sample per rearrangement job, pickup through drop.
 * qccd: one sample per Studio transport cycle, and one per ion for each unbroken run of cycles.
 * superconducting: no transport. Couplers are fixed.
 */
export function routeSamples(run) {
  const ops = run.hardware.segments.flatMap((s) => s.ops);
  const delivered = new Set(run.summary.pulses.filter((p) => p.onTime && p.aligned !== false).map((p) => p.source));
  if (run.platform === "neutral") {
    const jobs = new Map();
    for (const op of ops.filter((o) => ["pickup", "move", "drop"].includes(o.op))) {
      const job = op.id.split(".")[0];
      if (!jobs.has(job)) jobs.set(job, []);
      jobs.get(job).push(op);
    }
    return [...jobs].map(([job, steps]) => {
      const move = steps.find((s) => s.op === "move");
      const distanceUm = Math.max(...(move.atoms ?? []).map((a) => Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1])), 0);
      const latencyNs = (Math.max(...steps.map((s) => s.t + s.dur)) - Math.min(...steps.map((s) => s.t))) / 1000;
      return { id: job, qubits: move.qubits.length, latencyNs, moveNs: move.dur / 1000, distanceUm,
        delivered: steps.every((s) => delivered.has(s.id)) };
    });
  }
  if (run.platform === "qccd") {
    const cycles = ops.filter((o) => o.op === "transport").map((op) => ({
      id: op.id, qubits: op.moves.length, latencyNs: op.dur / 1000, channels: op.banks.reduce((n, b) => n + b.channels.length, 0),
      delivered: delivered.has(op.id) }));
    return cycles;
  }
  return [];
}

/** For each ion, the unbroken runs of transport cycles between two other operations on it. */
export function ionJourneys(run) {
  const ops = run.hardware.segments.flatMap((s) => s.ops);
  const open = new Map(), journeys = [];
  const close = (ion) => {
    if (open.has(ion)) journeys.push(open.get(ion));
    open.delete(ion);
  };
  for (const op of ops) {
    if (op.op === "transport")
      for (const move of op.moves) {
        const journey = open.get(move.ion) ?? { ion: move.ion, from: move.from, startPs: op.t, hops: 0 };
        open.set(move.ion, { ...journey, to: move.to, endPs: op.t + op.dur, hops: journey.hops + 1 });
      }
    else for (const ion of op.ions ?? []) close(ion);
  }
  for (const ion of [...open.keys()]) close(ion);
  return journeys.map((j) => ({ ...j, latencyNs: (j.endPs - j.startPs) / 1000 }));
}

/** Controller-side costs of a run. Times are in ns and rates per µs. */
export function controlMetrics(run) {
  const periodNs = run.machine.dspPeriodPs / 1000;
  const byCore = new Map();
  for (const f of run.frames)
    if (f.op === "put") {
      if (!byCore.has(f.part)) byCore.set(f.part, []);
      byCore.get(f.part).push(f.atBatch);
    }
  // A put carries a 28-bit address (16-bit window offset and 12-bit node) and 32 data bits.
  const PUT_BITS = 60;
  const cores = [...byCore].map(([core, at]) => {
    const gaps = at.slice(1).map((t, i) => t - at[i]).filter((g) => g > 0);
    const window = 100;
    let peak = 0;
    for (let i = 0, j = 0; i < at.length; i++) {
      while (at[i] - at[j] >= window) j++;
      peak = Math.max(peak, i - j + 1);
    }
    return { core, puts: at.length, minGapNs: Math.min(...gaps) * periodNs,
      peakPutsPerUs: (peak / (window * periodNs)) * 1000, peakLinkBitsPerUs: ((peak * PUT_BITS) / (window * periodNs)) * 1000 };
  });
  const opens = new Map();
  for (const p of run.summary.pulses) opens.set(p.opens, (opens.get(p.opens) ?? 0) + 1);
  const elapsedUs = run.summary.elapsedPs / 1e6;
  return {
    periodNs,
    cores,
    timedWrites: run.summary.pulses.length + run.summary.tones.length,
    widestBurst: Math.max(0, ...opens.values()),
    prerollNs: (run.preroll ?? []).map((batches) => batches * periodNs),
    meanLinkBitsPerUs: (cores.reduce((n, c) => n + c.puts, 0) * PUT_BITS) / elapsedUs,
    firmwareWords: run.firmware.reduce((n, f) => n + f.instructions, 0),
  };
}

/**
 * Feedback path of every measured bit: when its window closed, when the result reached the
 * measuring core, when the hub republished it, and when the first conditioned pulse opened.
 */
export function feedbackSamples(run) {
  const periodNs = run.machine.dspPeriodPs / 1000;
  const ops = run.hardware.segments.flatMap((s) => s.ops);
  const samples = [];
  for (const op of ops.filter((o) => o.op === "measure" && o.result !== undefined)) {
    const window = run.summary.pulses.find((p) => p.source === op.id && p.kind === "demod");
    if (!window) continue;
    const after = (predicate) => run.frames.find((f) => f.atBatch >= window.closes && predicate(f));
    const result = after((f) => f.op === "result" && f.source === op.id);
    const publish = after((f) => f.op === "publish" && f.source === op.id);
    const board = publish && run.frames.find((f) => f.op === "board" && f.parents.includes(publish.id));
    const conditioned = ops.filter((o) => o.when === op.result).map((o) => run.summary.pulses.find((p) => p.source === o.id)).filter(Boolean);
    const ns = (frame) => (frame ? (frame.atBatch - window.closes) * periodNs : undefined);
    samples.push({
      bit: op.result, measure: op.id,
      resultAtCoreNs: ns(result), publishedAtHubNs: ns(publish), atOtherCoresNs: ns(board),
      firstConditionedPulseNs: conditioned.length ? (Math.min(...conditioned.map((p) => p.opens)) - window.closes) * periodNs : undefined,
    });
  }
  return samples;
}

/**
 * Decode and frame-update path of every `decode` instruction. Times are ns after the last
 * syndrome window closed, unless the name says otherwise.
 *   inputAtDecoderNs     the last syndrome bit is in the decoder core's board register
 *   decodeStartNs        the decoder has met the other cores and reads the syndrome
 *   decodedNs            the last decoded bit is stored
 *   decodeNs             decodedNs − decodeStartNs: the lookup and the stores
 *   decodedAtEveryCoreNs the last published decoded bit is in every core's board register
 *   frameUpdates         per update: whether its bit was set, and when the frame word was stored
 *   firstConditionedPulseNs  the earliest pulse conditioned on a decoded bit opens
 *   inputBitsPerUs       the syndrome bits divided by inputAtDecoderNs: what the path delivered
 */
export function decodeSamples(run) {
  const periodNs = run.machine.dspPeriodPs / 1000;
  const ops = run.hardware.segments.flatMap((s) => s.ops);
  const { frames } = run;
  const samples = [];
  for (const op of ops.filter((o) => o.op === "decode")) {
    const measures = ops.filter((o) => o.op === "measure" && op.inputs.includes(o.result));
    const closes = Math.max(...measures.map((m) => run.summary.pulses.find((p) => p.source === m.id && p.kind === "demod").closes));
    const ns = (batch) => (batch - closes) * periodNs;
    const reached = (publish) => frames.filter((f) => f.op === "board" && f.parents.includes(publish.id));
    const inputs = measures.map((m) => {
      const publish = frames.find((f) => f.op === "publish" && f.source === m.id);
      return reached(publish).find((f) => f.part === "decoder.inbox").atBatch;
    });
    const read = frames.find((f) => f.part === "decoder" && f.source === op.id && f.state.register === "board");
    const stored = frames.filter((f) => f.part === "decoder" && f.op === "host" && f.source === op.id);
    const atCores = frames.filter((f) => f.op === "publish" && f.source === op.id).flatMap(reached).map((f) => f.atBatch);
    const decoded = Math.max(...stored.map((f) => f.atBatch));
    const updates = ops.filter((o) => o.op === "pauli-frame" && op.outputs.includes(o.when)).map((u) => {
      const store = frames.find((f) => f.part === "decoder" && f.op === "host" && f.source === u.id);
      return { update: u.id, qubit: u.qubits[0], pauli: u.pauli, applied: Boolean(store), frame: store?.state.store,
        storedNs: store ? ns(store.atBatch) : undefined };
    });
    const pulses = ops.filter((o) => o.op !== "pauli-frame" && op.outputs.includes(o.when))
      .map((o) => run.summary.pulses.find((p) => p.source === o.id)).filter(Boolean);
    const inputAtDecoderNs = ns(Math.max(...inputs));
    samples.push({
      decode: op.id, syndromeBits: op.inputs.length, decodedBits: op.outputs.length,
      inputAtDecoderNs, decodeStartNs: ns(read.atBatch), decodedNs: ns(decoded), decodeNs: (decoded - read.atBatch) * periodNs,
      decodedAtEveryCoreNs: atCores.length ? ns(Math.max(...atCores)) : undefined,
      frameUpdates: updates,
      firstConditionedPulseNs: pulses.length ? ns(Math.min(...pulses.map((p) => p.opens))) : undefined,
      inputBitsPerUs: (1000 * op.inputs.length) / inputAtDecoderNs,
    });
  }
  return samples;
}

/** One report per run, with the transport latency a system-call declaration would have to cover. */
export function report(run) {
  const routes = routeSamples(run);
  const latency = distribution(routes.map((r) => r.latencyNs));
  return {
    platform: run.platform,
    machine: run.machine.name,
    route: {
      samples: routes.length,
      allDelivered: routes.every((r) => r.delivered),
      latencyNs: latency,
      qubitsPerRoute: distribution(routes.map((r) => r.qubits)),
      // A single declared latency must cover the slowest route. The rate it then reserves for
      // the largest route follows the virtual machine's rule.
      declared: routes.length
        ? { latencyNs: latency.max, reservedQubitsPerUs: reservedRate(Math.max(...routes.map((r) => r.qubits)), latency.max),
            overchargeOfMedianRoute: latency.max / latency.median }
        : undefined,
    },
    control: controlMetrics(run),
    feedback: feedbackSamples(run),
    decode: decodeSamples(run),
    // The board hub passes one system put per batch: puts served, and the longest wait.
    hub: { served: run.summary.hub.served, longestWaitNs: run.summary.hub.maxWait * (run.machine.dspPeriodPs / 1000),
      peakWaiting: run.summary.hub.peakWaiting },
  };
}
