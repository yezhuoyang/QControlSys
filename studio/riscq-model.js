// Reconstruction of a RISC-Q controller run from its trace bundle. Pure functions: no DOM and
// no three.js, so the browser debugger and a headless agent read the same result.
//
//   node riscq/cli.mjs --example superconducting-feedforward --outcome c=1 --out run.json
//   node -e "import('./studio/riscq-model.js').then(async (m) => {
//     const run = JSON.parse(require('fs').readFileSync('run.json', 'utf8'));
//     console.log(m.stateAt(run, 200).cores[0]);
//   })"
//
// Everything here is derived from the bundle that `riscq/examples.mjs` returns. Nothing is
// simulated: no timing, latency or physics is computed. The Lean model
// (QControl/RiscQ/Soc.lean) wrote each frame with the committed state of the part it acts on,
// and these functions replay those frames in order.
//
// Units: a frame index counts trace frames from 0, and −1 names the reset state. `atBatch`
// counts dspClk cycles from reset release. `atPs = atBatch · machine.dspPeriodPs`. Register
// values, addresses and pulse codes are the unsigned integers of the trace.
//
// Boundaries of the reconstruction:
// * Registers change only where a frame carries `rd` and `value`. The default trace ("io")
//   holds the instructions that touch control registers, so a register can have changed since
//   its last traced write. `regSeen` marks the registers that a frame wrote. A "full" trace
//   holds every instruction and reproduces the whole register file.
// * `pc` is the address of the last traced instruction of a core, not the next one to run.
// * RAM contents are not reconstructed.
// * A sink loses its oldest event when the core reads `popEvent`, and the release box and a
//   mailbox empty when the core reads them. Those reads are located by the register name in
//   the frame and the address map below.

/** Core-local sink registers (QControl/RiscQ/Soc.lean: sinkBase, sinkStride, loadIo). */
const SINK_BASE = 0x4200, SINK_STRIDE = 0x20, MAILBOX0 = 0x4340;
/** Frames between the saved states that make a backward step cheap. */
const STRIDE = 256;

const prepared = new WeakMap(), cursors = new WeakMap();

/** Lookup tables of a bundle, built once. */
function prepare(bundle) {
  let ix = prepared.get(bundle);
  if (ix) return ix;
  const frames = bundle.frames ?? [];
  const byId = new Map();
  frames.forEach((f, i) => byId.set(f.id, i));
  const parts = new Map((bundle.system?.parts ?? []).map((p) => [p.id, p]));
  const cores = new Map(), channels = new Map(), inboxes = new Map(), pins = new Map();
  (bundle.machine?.cores ?? []).forEach((core, i) => {
    cores.set(core.name, i);
    inboxes.set(core.name + ".inbox", i);
    let sink = 0;
    core.channels.forEach((ch, j) => {
      const part = core.name + "." + ch.name;
      // Pulse-table length: the Lean program when the bundle carries it, else the part label.
      const slots = bundle.program?.cores?.[i]?.channels?.[j]?.slots ??
        Number(/: (\d+) entries$/.exec(parts.get(part)?.label ?? "")?.[1] ?? 0);
      // Sinks follow the channels that report: a result register per demod channel and an
      // event queue per dio channel, in channel order.
      const ref = { part, core: i, channel: j, name: ch.name, kind: ch.kind, slots, sink: ch.kind === "pulse" ? -1 : sink++ };
      channels.set(part, ref);
      pins.set(part + ".pins", ref);
    });
  });
  const links = new Map();
  for (const link of bundle.system?.links ?? []) {
    links.set(link.from + "\n" + link.to, { id: link.id, reversed: false });
    if (!links.has(link.to + "\n" + link.from)) links.set(link.to + "\n" + link.from, { id: link.id, reversed: true });
  }
  const ops = [];
  (bundle.hardware?.segments ?? []).forEach((segment, s) => {
    for (const op of segment.ops) ops.push({ segment: s, span: segment.span, op });
  });
  const hardware = new Map(ops.map((entry) => [entry.op.id, entry]));
  const sources = new Map(), ofPart = new Map(), pulses = [], effects = [], channelDevices = new Map();
  const push = (map, key, i) => {
    const list = map.get(key);
    if (list) list.push(i);
    else map.set(key, [i]);
  };
  frames.forEach((f, i) => {
    if (f.source !== undefined) push(sources, f.source, i);
    push(ofPart, f.part, i);
    for (const target of f.targets ?? []) if (target !== f.part) push(ofPart, target, i);
    if (f.op === "pulse") pulses.push(i);
    if (f.op === "effect") {
      effects.push({ index: i, id: f.id, part: f.part, atBatch: f.atBatch, atPs: f.atPs, source: f.source,
        binding: f.state?.binding, arrivesPs: f.state?.arrivesPs, detail: f.state?.detail });
      // The window that caused an effect names the channel that drives this apparatus part.
      const cause = frames[byId.get(f.parents?.[0])];
      if (cause && channels.has(cause.part) && !channelDevices.has(cause.part))
        channelDevices.set(cause.part, { device: f.part, axis: f.state?.detail?.axis });
    }
  });
  for (const entry of ops) {
    const list = sources.get(entry.op.id);
    entry.first = list ? list[0] : -1;
    entry.frames = list ? list.length : 0;
  }
  ix = { frames, byId, parts, cores, channels, inboxes, pins, links, ops, hardware, sources, ofPart, pulses, effects, channelDevices };
  prepared.set(bundle, ix);
  return ix;
}

/** Index of a frame by ID, or −1. */
export function frameIndex(bundle, frameId) {
  return prepare(bundle).byId.get(frameId) ?? -1;
}

/** Kind of a scene part: host, hub, core, link, inbox, pulse, demod, dio, dac, adc, pins or device. */
export function partKind(bundle, partId) {
  return prepare(bundle).parts.get(partId)?.kind;
}

/** Core and channel of a channel part or of its pins: { part, core, coreName, channel, name, kind, slots, sink }, else undefined. */
export function channelInfo(bundle, partId) {
  const ix = prepare(bundle);
  const ref = ix.channels.get(partId) ?? ix.pins.get(partId);
  return ref && { ...ref, coreName: bundle.machine.cores[ref.core].name };
}

/** Index in `machine.cores` of the core that owns a core, link, inbox, channel or pins part, else −1. */
export function coreOfPart(bundle, partId) {
  const ix = prepare(bundle);
  if (!ix.owners) {
    ix.owners = new Map();
    for (const [name, i] of ix.cores) for (const id of [name, name + ".link", name + ".inbox"]) ix.owners.set(id, i);
    for (const [id, ref] of [...ix.channels, ...ix.pins]) ix.owners.set(id, ref.core);
  }
  return ix.owners.get(partId) ?? -1;
}

/** "io" when the trace holds only instructions that touch control registers, "full" for every instruction. */
export function traceDetail(bundle) {
  return bundle.program?.trace === "full" ? "full" : "io";
}

function resetState(bundle, ix) {
  const pc = bundle.initial?.pc ?? 0;
  return {
    cores: (bundle.machine?.cores ?? []).map((core) => ({
      name: core.name, regs: Array(32).fill(0), regSeen: Array(32).fill(false), pc,
      lastText: null, lastOp: null, lastFrame: null, lastSource: null, retired: 0,
      waiting: null, stopped: null, done: false, timeCmp: 0,
      channels: core.channels.map((ch) => {
        const ref = ix.channels.get(core.name + "." + ch.name);
        return {
          part: ref.part, name: ch.name, kind: ch.kind, written: false,
          buffer: { startTime: 0, freq: 0, dcOffset: 0, phaseOffset: 0,
            table: Array.from({ length: ref.slots }, () => ({ phase: 0, amp: 0, env: 0, dur: 0 })) },
          freq: 0, windows: 0, dout: 0, din: 0,
        };
      }),
      sinks: core.channels.filter((ch) => ch.kind !== "pulse").map((ch) => ch.kind === "demod"
        ? { kind: "result", channel: core.name + "." + ch.name, valid: false, res: 0, real: 0, imag: 0 }
        : { kind: "fifo", channel: core.name + "." + ch.name, count: 0, nextSeq: 0, events: [], popped: null }),
      board: [0, 0, 0, 0], release: null, mailboxes: [null, null],
    })),
    hub: { groups: [0, 0, 0, 0], barriers: [], countMismatch: false, lastRelease: null, lastSignal: null, waiting: [], dropped: 0 },
    host: [], devices: {}, effectCount: 0,
  };
}

// Nested arrays and records are replaced on change and never edited in place, so one level
// of copying per container separates a saved state from the running one.
function copyState(s) {
  return {
    cores: s.cores.map((c) => ({
      ...c, regs: c.regs.slice(), regSeen: c.regSeen.slice(),
      channels: c.channels.map((ch) => ({ ...ch })), sinks: c.sinks.map((k) => ({ ...k })),
      board: c.board.slice(), mailboxes: c.mailboxes.slice(),
    })),
    hub: { ...s.hub, groups: s.hub.groups.slice(), barriers: s.hub.barriers.map((b) => ({ ...b })), waiting: s.hub.waiting.slice() },
    host: s.host.slice(), devices: { ...s.devices }, effectCount: s.effectCount,
  };
}

/** A core read that empties what it read: the oldest sink event, the release box or a mailbox. */
function consume(core, register, address) {
  if (register === "popEvent") {
    const k = Math.floor((address - SINK_BASE) / SINK_STRIDE);
    const sink = core.sinks[k];
    if (sink?.kind === "fifo" && sink.events.length)
      core.sinks[k] = { ...sink, popped: sink.events[0], events: sink.events.slice(1), count: sink.events.length - 1 };
  } else if (register === "release") core.release = null;
  else if (register === "mailbox") {
    const m = Math.floor((address - MAILBOX0) / SINK_STRIDE);
    if (m >= 0 && m < core.mailboxes.length) core.mailboxes[m] = null;
  }
}

/** Apply the state transition of one frame. */
function apply(st, f, i, ix) {
  const s = f.state ?? {};
  const ci = ix.cores.get(f.part);
  if (ci !== undefined) {
    const core = st.cores[ci];
    // A core frame is named `<core>:<instructions retired before it>`.
    const before = Number.parseInt(f.id.slice(f.part.length + 1), 10);
    core.lastFrame = f.id;
    core.lastOp = f.op;
    core.lastSource = f.source ?? core.lastSource;
    if (Number.isInteger(s.pc)) core.pc = s.pc;
    if (s.text !== undefined) core.lastText = s.text;
    const retires = !["wait", "park", "fault"].includes(f.op);
    if (Number.isInteger(before)) core.retired = before + (retires ? 1 : 0);
    if (f.op === "wait") core.waiting = { register: s.register, address: s.address, until: s.until ?? null, since: f.id };
    else {
      if (f.op === "resume") consume(core, s.register, core.waiting?.address);
      else if (f.op === "read") consume(core, s.register, s.address);
      core.waiting = null;
      // x0 is hard-wired to zero.
      if (Number.isInteger(s.rd) && s.rd > 0 && s.rd < 32 && s.value !== undefined) {
        core.regs[s.rd] = s.value;
        core.regSeen[s.rd] = true;
      }
    }
    if (f.op === "write" && s.register === "timeCmp") core.timeCmp = s.store;
    if (f.op === "done") {
      core.done = true;
      core.stopped = "done";
    }
    if (f.op === "park" || f.op === "fault") core.stopped = s.reason ?? f.op;
    if (f.op === "host") {
      // The host window takes byte, half and word stores. The frame holds the whole register.
      const bytes = /^sb\b/.test(s.text ?? "") ? 1 : /^sh\b/.test(s.text ?? "") ? 2 : 4;
      const value = bytes === 4 ? s.store : s.store & (bytes === 1 ? 0xff : 0xffff);
      st.host.push({ core: core.name, offset: s.offset, bytes, value, store: s.store, atBatch: f.atBatch, frame: f.id });
    }
    return;
  }
  const ref = ix.channels.get(f.part);
  if (ref) {
    const channel = st.cores[ref.core].channels[ref.channel];
    if (s.buffer) {
      channel.buffer = s.buffer;
      channel.written = true;
    }
    if (f.op === "pulse") channel.windows += 1;
    else if (f.op === "freq") channel.freq = s.freq;
    else if (f.op === "dio") channel.dout = s.levels;
    return;
  }
  if (f.op === "edge") {
    const line = ix.pins.get(f.part) ?? ix.channels.get(f.targets?.[0]);
    if (line) st.cores[line.core].channels[line.channel].din = s.levels;
    return;
  }
  const inbox = ix.inboxes.get(f.part);
  if (inbox !== undefined) {
    const core = st.cores[inbox];
    if (f.op === "board") core.board[s.group] = s.word;
    else if (f.op === "released") core.release = s.t0;
    else if (f.op === "mail") core.mailboxes[s.mailbox] = s.word;
    else {
      // The frame holds the committed sink. Its cause names the reporting channel: the
      // demodulation window of a result, or the input edge of an event.
      const cause = ix.frames[ix.byId.get(f.parents?.[0])];
      const from = cause && (ix.channels.get(cause.part) ?? ix.pins.get(cause.part));
      let k = from && from.core === inbox ? from.sink : -1;
      if (k < 0) k = core.sinks.findIndex((sink) => sink.kind === s.kind);
      if (k >= 0)
        core.sinks[k] = s.kind === "fifo"
          ? { ...core.sinks[k], kind: "fifo", count: s.count, nextSeq: s.nextSeq, events: s.events ?? [] }
          : { ...core.sinks[k], kind: "result", valid: s.valid, res: s.res, real: s.real, imag: s.imag };
    }
    return;
  }
  if (ix.parts.get(f.part)?.kind === "hub") {
    const hub = st.hub;
    // The arbiter dispatches one system put per batch. A put that stays behind is reported by
    // a `wait` frame, and its dispatch names that frame as its cause.
    if (f.op === "wait") {
      hub.waiting = [...hub.waiting, { frame: f.id, from: s.from, node: s.node }];
      return;
    }
    if (f.op === "drop") {
      hub.dropped += 1;
      return;
    }
    if (hub.waiting.length) hub.waiting = hub.waiting.filter((beat) => !f.parents?.includes(beat.frame));
    if (f.op === "publish") hub.groups[s.group] = s.word;
    else if (f.op === "arrive" || f.op === "release") {
      // Each arriver states the member count. The hub notes a disagreement with the first.
      const put = ix.frames[ix.byId.get(f.parents?.[0])];
      if (put?.state?.store !== undefined && put.state.store !== s.expected) hub.countMismatch = true;
      const rest = hub.barriers.filter((b) => b.barrier !== s.barrier);
      if (f.op === "release") {
        hub.barriers = rest;
        hub.lastRelease = { barrier: s.barrier, t0: s.t0, members: s.arrived, frame: f.id };
      } else {
        const open = hub.barriers.find((b) => b.barrier === s.barrier);
        const arrived = open?.arrived.includes(s.from) ? open.arrived : [...(open?.arrived ?? []), s.from];
        hub.barriers = [...rest, { barrier: s.barrier, expected: s.expected, arrived }].sort((a, b) => a.barrier - b.barrier);
      }
    } else if (f.op === "signal") hub.lastSignal = { to: s.to, mailbox: s.mailbox, word: s.word, frame: f.id };
    return;
  }
  if (f.op === "effect") {
    const record = ix.effects[st.effectCount];
    st.effectCount += 1;
    st.devices[f.part] = { count: (st.devices[f.part]?.count ?? 0) + 1, last: record };
  }
}

/** Running state after frames 0..index. Continues from the last request or a saved state. */
function advance(bundle, index) {
  const ix = prepare(bundle);
  let cursor = cursors.get(bundle);
  if (!cursor) {
    cursor = { index: -1, state: resetState(bundle, ix), saved: [] };
    cursor.saved[0] = copyState(cursor.state);
    cursors.set(bundle, cursor);
  }
  if (index < cursor.index) {
    const k = Math.floor((index + 1) / STRIDE);
    cursor.state = copyState(cursor.saved[k]);
    cursor.index = k * STRIDE - 1;
  }
  while (cursor.index < index) {
    cursor.index += 1;
    apply(cursor.state, ix.frames[cursor.index], cursor.index, ix);
    const k = (cursor.index + 1) / STRIDE;
    if (Number.isInteger(k) && !cursor.saved[k]) cursor.saved[k] = copyState(cursor.state);
  }
  return cursor.state;
}

/** Number of entries of a sorted index list that are at or below `index`. */
export function countUpTo(list, index) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] <= index) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * State after frame `index`, reconstructed from frames 0..index only. `index = −1` is reset.
 *
 * {
 *   index, frame, atBatch, atPs, trace,
 *   cores: [{ name, regs[32], regSeen[32], pc, lastText, lastOp, lastFrame, lastSource, retired,
 *             waiting: null | { register, address, until, since }, stopped: null | reason, done, timeCmp,
 *             channels: [{ part, name, kind, written, buffer, freq, windows, dout, din, open: [pulse records] }],
 *             sinks: [{ kind: "result", channel, valid, res, real, imag }
 *                   | { kind: "fifo", channel, count, nextSeq, events, popped }],
 *             board[4], release: null | t0, mailboxes[2] }],
 *   hub: { groups[4], barriers: [{ barrier, expected, arrived: [core names] }], countMismatch, lastRelease, lastSignal,
 *          waiting: [{ frame, from, node }] (system puts held at the arbiter, oldest report first), dropped },
 *   host: [{ core, offset, bytes, value, store, atBatch, frame }],
 *   openWindows: pulse records with opens ≤ atBatch < closes among the pulse frames seen so far,
 *   effects: [{ index, id, part, atBatch, atPs, source, binding, arrivesPs, detail }],
 *   devices: { part: { count, last } },
 * }
 * The result is a copy. Buffers, pulse records and effect records are the bundle's own objects.
 */
export function stateAt(bundle, index) {
  const ix = prepare(bundle);
  const at = Number.isFinite(index) ? Math.max(-1, Math.min(ix.frames.length - 1, Math.trunc(index))) : -1;
  const state = copyState(advance(bundle, at));
  const frame = ix.frames[at];
  const atBatch = frame?.atBatch ?? 0;
  const openWindows = [];
  const seen = countUpTo(ix.pulses, at);
  for (let k = 0; k < seen; k++) {
    const record = ix.frames[ix.pulses[k]].state;
    if (record.opens <= atBatch && atBatch < record.closes) openWindows.push(record);
  }
  for (const core of state.cores)
    for (const channel of core.channels) channel.open = openWindows.filter((w) => w.part === channel.part);
  const { effectCount, ...rest } = state;
  return {
    index: at, frame: frame?.id ?? null, atBatch, atPs: frame?.atPs ?? 0, trace: traceDetail(bundle),
    ...rest, openWindows, effects: ix.effects.slice(0, effectCount),
  };
}

/**
 * Causal ancestry of a frame, earliest first, ending with the frame itself. Parents are
 * followed back to the core instruction that issued the write. A core frame is its own
 * origin: its chain holds only the event that woke it, if any, not the earlier instructions
 * of the same core.
 */
export function causalChain(bundle, frameId) {
  const ix = prepare(bundle);
  const start = ix.byId.get(frameId);
  if (start === undefined) return [];
  const seen = new Set([start]), pending = [start];
  while (pending.length) {
    const i = pending.pop();
    const frame = ix.frames[i];
    const isCore = ix.cores.has(frame.part);
    if (isCore && i !== start) continue;
    for (const parent of frame.parents ?? []) {
      const j = ix.byId.get(parent);
      if (j === undefined || seen.has(j)) continue;
      if (isCore && ix.cores.has(ix.frames[j].part)) continue;
      seen.add(j);
      pending.push(j);
    }
  }
  return [...seen].sort((a, b) => a - b).map((i) => ix.frames[i]);
}

/**
 * The causal chain as hops between scene parts: [{ from, to, link, frame }]. `link` is the
 * ID of the `system.links` entry that joins the two parts, or null where the bundle lists
 * none (hub to inbox, inbox to core, converter to apparatus, core to host). The last hops
 * run from the frame's own part to its targets.
 */
export function causalPath(bundle, frameId) {
  const ix = prepare(bundle);
  const chain = causalChain(bundle, frameId);
  const member = new Set(chain.map((f) => f.id));
  const hops = [], drawn = new Set();
  const walk = (route, frame) => {
    for (let k = 1; k < route.length; k++) {
      const from = route[k - 1], to = route[k], key = from + "\n" + to;
      if (from === to || drawn.has(key) || !ix.parts.has(from) || !ix.parts.has(to)) continue;
      drawn.add(key);
      hops.push({ from, to, link: ix.links.get(key)?.id ?? null, frame });
    }
  };
  for (const frame of chain)
    for (const parent of frame.parents ?? []) {
      if (!member.has(parent)) continue;
      const cause = ix.frames[ix.byId.get(parent)];
      // A listed link between the two parts is the route. Otherwise the cause reaches the
      // next part through its own targets, for example core → link → channel.
      walk(ix.links.has(cause.part + "\n" + frame.part) ? [cause.part, frame.part] : [cause.part, ...(cause.targets ?? []), frame.part], frame.id);
    }
  const last = chain.at(-1);
  if (last) walk([last.part, ...(last.targets ?? [])], last.id);
  return hops;
}

/** Indices of the frames attributed to a hardware instruction ID or a firmware phase. */
export function framesOfSource(bundle, sourceId) {
  return prepare(bundle).sources.get(sourceId) ?? [];
}

/** Indices of the frames that act on a part or name it as a target. */
export function framesOfPart(bundle, partId) {
  return prepare(bundle).ofPart.get(partId) ?? [];
}

/** First index after `index` whose frame satisfies `predicate(frame, i)`, or −1. */
export function nextIndex(bundle, index, predicate) {
  const frames = bundle.frames;
  for (let i = Math.max(-1, index) + 1; i < frames.length; i++) if (predicate(frames[i], i)) return i;
  return -1;
}

/** Last index before `index` whose frame satisfies `predicate(frame, i)`, or −1. */
export function previousIndex(bundle, index, predicate) {
  const frames = bundle.frames;
  for (let i = Math.min(frames.length, index) - 1; i >= 0; i--) if (predicate(frames[i], i)) return i;
  return -1;
}

/** Index of the last frame at or before a batch, or −1. Frames are in time order. */
export function indexAtBatch(bundle, batch) {
  const frames = bundle.frames;
  let lo = 0, hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].atBatch <= batch) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Frame of each entry of `summary.faults`: [{ fault, index }]. A fault record holds a batch
 * and a part. Its frame is the one at that batch and part that shows the fault, else the
 * first frame there, else −1.
 */
export function faultFrames(bundle) {
  const ix = prepare(bundle);
  if (ix.faults) return ix.faults;
  const shows = (f) => ["fault", "drop", "ignored"].includes(f.op) || f.state?.dropped === true ||
    ((f.op === "pulse" || f.op === "dio") && (f.state.onTime === false || f.state.aligned === false || f.state.overlap === true));
  ix.faults = (bundle.summary?.faults ?? []).map((fault) => {
    const here = (ix.ofPart.get(fault.part) ?? []).filter((i) => ix.frames[i].part === fault.part && ix.frames[i].atBatch === fault.atBatch);
    return { fault, index: here.find((i) => shows(ix.frames[i])) ?? here[0] ?? -1 };
  });
  return ix.faults;
}

/**
 * Predicates for stepping with `nextIndex` and `previousIndex`:
 *   pulse        a pulse or demodulation window opens, or digital lines update
 *   fault        a frame of `summary.faults`, or a core that stopped on a fault
 *   instruction  the first frame of a hardware instruction
 */
export function stops(bundle) {
  const ix = prepare(bundle);
  const faulty = new Set(faultFrames(bundle).map((entry) => entry.index));
  const starts = new Set(ix.ops.map((entry) => entry.first));
  return {
    pulse: (f) => f.op === "pulse" || f.op === "dio",
    fault: (f, i) => f.op === "fault" || faulty.has(i),
    instruction: (f, i) => starts.has(i),
  };
}

/** Hardware instructions in program order: [{ segment, span, op, first, frames }]. `first` is −1 when no frame carries the instruction. */
export function hardwareOps(bundle) {
  return prepare(bundle).ops;
}

/** The hardware instruction with this ID, as in `hardwareOps`, or undefined for a firmware phase. */
export function hardwareOp(bundle, sourceId) {
  return prepare(bundle).hardware.get(sourceId);
}

/**
 * Timeline lanes, one per channel with a record in `summary.pulses` or `summary.tones`, in
 * machine order: [{ part, kind, windows, updates, tones }]. `windows` have `opens` and
 * `closes`. `updates` are digital updates with `opens` only. `late` marks a record that
 * missed its start time, landed its parameters on different batches or overlapped.
 */
export function lanes(bundle) {
  const ix = prepare(bundle);
  if (ix.lanes) return ix.lanes;
  const byPart = new Map();
  const lane = (part) => {
    if (!byPart.has(part)) byPart.set(part, { part, kind: ix.channels.get(part)?.kind ?? ix.parts.get(part)?.kind, windows: [], updates: [], tones: [] });
    return byPart.get(part);
  };
  for (const record of bundle.summary?.pulses ?? []) {
    const late = record.onTime === false || record.aligned === false || record.overlap === true;
    (record.closes === undefined ? lane(record.part).updates : lane(record.part).windows).push({ ...record, late });
  }
  for (const tone of bundle.summary?.tones ?? []) lane(tone.part).tones.push(tone);
  const order = [...ix.channels.keys()];
  ix.lanes = [...byPart.values()].sort((a, b) => (order.indexOf(a.part) + 1 || 1e9) - (order.indexOf(b.part) + 1 || 1e9));
  return ix.lanes;
}

const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

/** A duration in picoseconds as text in ns, µs or ms. */
export function formatTime(ps) {
  const ns = ps / 1000;
  if (Math.abs(ns) < 1000) return decimal.format(ns) + " ns";
  if (Math.abs(ns) < 1e6) return decimal.format(ns / 1000) + " µs";
  return decimal.format(ns / 1e6) + " ms";
}

const wording = {
  core: {
    exec: ["Execute instruction", "The core retires one instruction that touches no control register."],
    read: ["Read control register", "A load from the core's control block returns its value."],
    write: ["Write control register", "A store to the core's control block."],
    put: ["Post register write", "A store into the put window leaves on the posted link for a channel or the board hub."],
    wait: ["Stall on control register", "The load halts the core until its timer or sink is ready."],
    resume: ["Stalled read completes", "The timer or sink became ready and the load returns its value."],
    host: ["Store to host window", "The value is written to the host result memory."],
    done: ["Set done flag", "The firmware reports completion to the host. The model stops stepping this core."],
    park: ["Park in a self jump", "The core reached a jump to itself and stops."],
    fault: ["Core fault", "The core stopped. The reason is in the state fields."],
  },
  channel: {
    write: ["Register write arrives", "The posted write updates the channel's pulse buffer."],
    fire: ["Fire pulse-table entry", "The entry enters the timed queues with the buffer's start time. The start time advances by the entry's duration."],
    drop: ["Write dropped", "A full timed queue, or an entry outside the table, dropped this write."],
    ignored: ["Write ignored", "The offset maps to no register of this channel."],
    pulse: ["Pulse window opens", "The fired entry takes effect at this batch. A DAC output follows after the converter pipeline."],
    freq: ["Carrier update takes effect", "The channel's carrier frequency code changes at this batch."],
    dio: ["Digital lines update", "The masked output lines take their new levels."],
  },
  pins: { edge: ["Digital input changes", "The input lines of a digital channel take new levels."] },
  inbox: {
    clear: ["Result register cleared", "A demodulation window started, so the previous result is no longer valid."],
    result: ["Readout result settles", "The decoder's bit and integrals reach the core-local result register."],
    event: ["Input event queued", "A change of the digital input lines enters the core-local event queue."],
    drop: ["Input event dropped", "The event queue was full."],
    board: ["Shared bits arrive", "The hub's group word reaches this core's board register."],
    released: ["Barrier release arrives", "The hub's release time reaches this core's release box."],
    mail: ["Mailbox word arrives", "A word signalled by another core reaches this core's mailbox."],
  },
  hub: {
    publish: ["Publish shared bit", "One bit of a group word changes and is sent to every core."],
    arrive: ["Barrier arrival", "A core arrived at a counted barrier. The others have not all arrived."],
    release: ["Barrier release", "The last member arrived. Every arriver is sent the hub's time."],
    signal: ["Mailbox signal", "A word is routed to one core's mailbox."],
    ignored: ["System put ignored", "The put names no hub node."],
    wait: ["System put waits at the hub", "The hub dispatches one system put per batch for the whole board. This one stays in its core's queue."],
    drop: ["System put dropped", "The queue of this core at the hub was full."],
  },
  device: { effect: ["Signal reaches the apparatus", "The window that caused this frame is bound to this apparatus part."] },
};

/** Title and one-sentence description of a frame's operation: [title, description]. */
export function describe(bundle, frame) {
  const kind = partKind(bundle, frame.part);
  const group = ["pulse", "demod", "dio"].includes(kind) ? "channel" : ["dac", "adc"].includes(kind) ? "device" : kind;
  const entry = wording[group]?.[frame.op] ?? wording.device[frame.op];
  if (!entry) return [frame.op, ""];
  if (frame.op === "pulse" && kind === "demod") return ["Demodulation window opens", "The fired entry takes effect at this batch on the ADC samples."];
  return entry;
}

/**
 * Trapped-ion view: where each ion is at a batch, from `derived.ionMoves`.
 * A move whose `closes` is at or before the batch has happened when the run delivered it.
 * A move between `opens` and `closes` is in transit: `moving` holds its route, its window and
 * whether the run delivered it. An ion starts at the site that `machine.geometry.ions` places
 * it on, else at the `from` of its first move, else at the site that a gate or measurement
 * instruction states for it (`stated` names that instruction), and has no site when none does.
 * A closed move that the run did not deliver leaves the ion where it was and is named in
 * `undelivered`. A move whose cycle played no window has no time in the bundle and is not applied.
 * Returns { ions: [{ ion, site, stated, moving, undelivered }], sites: [{ site, ions }] }.
 */
export function ionsAt(bundle, atBatch) {
  const ix = prepare(bundle);
  const at = new Map();
  const seat = (ion) => {
    if (!at.has(ion)) at.set(ion, { ion, site: null, stated: null, moving: null, undelivered: null });
    return at.get(ion);
  };
  for (const placed of bundle.machine?.geometry?.ions ?? []) seat(placed.id).site = placed.site;
  for (const { op } of ix.ops) {
    for (const ion of op.ions ?? []) seat(ion);
    // `measure` names each ion's site. `rotate` lists one site per ion and `ms` one per pair.
    const stated = op.op === "measure" ? Object.entries(op.at ?? {})
      : op.op === "rotate" && op.ions?.length === op.sites?.length ? op.ions.map((ion, k) => [ion, op.sites[k]])
      : op.op === "ms" && op.pairs?.length === op.sites?.length ? op.pairs.flatMap((pair, k) => pair.map((ion) => [ion, op.sites[k]]))
      : [];
    for (const [name, site] of stated) {
      const ion = seat(name);
      if (ion.site === null) Object.assign(ion, { site, stated: op.id });
    }
  }
  const started = new Set();
  for (const record of bundle.derived?.ionMoves ?? [])
    for (const move of record.moves ?? []) {
      const ion = seat(move.ion);
      if (!started.has(move.ion)) {
        started.add(move.ion);
        Object.assign(ion, { site: move.from, stated: null });
      }
      if (record.closes !== null && record.closes <= atBatch) {
        if (record.delivered) {
          ion.site = move.to;
          ion.undelivered = null;
        } else ion.undelivered = record.op;
      } else if (record.opens !== null && record.opens <= atBatch)
        ion.moving = { from: move.from, to: move.to, via: move.via, op: record.op, opens: record.opens, closes: record.closes, delivered: record.delivered };
    }
  const natural = (a, b) => a.localeCompare(b, "en", { numeric: true });
  const ions = [...at.values()].sort((a, b) => natural(a.ion, b.ion));
  const bySite = new Map();
  for (const ion of ions) {
    if (ion.site === null) continue;
    if (!bySite.has(ion.site)) bySite.set(ion.site, []);
    bySite.get(ion.site).push(ion.ion);
  }
  return { ions, sites: [...bySite].sort((a, b) => natural(a[0], b[0])).map(([site, list]) => ({ site, ions: list })) };
}

/**
 * Neutral-atom view: the last entry of `derived.tonePositions` at or before a batch for each
 * channel. `device` and `axis` come from the effect frames of the channel's windows, so a
 * channel that drives no AOD axis has none.
 * Returns [{ part, um, atBatch, source, device, axis }] in channel order.
 */
export function tonesAt(bundle, atBatch) {
  const ix = prepare(bundle);
  if (!ix.tones) {
    ix.tones = new Map();
    for (const entry of bundle.derived?.tonePositions ?? []) {
      if (!ix.tones.has(entry.part)) ix.tones.set(entry.part, []);
      ix.tones.get(entry.part).push(entry);
    }
  }
  const out = [];
  for (const [part, list] of ix.tones) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].atBatch <= atBatch) lo = mid + 1;
      else hi = mid;
    }
    if (!lo) continue;
    const entry = list[lo - 1], bound = ix.channelDevices.get(part);
    out.push({ part, um: entry.um, atBatch: entry.atBatch, source: entry.source, device: bound?.device ?? null, axis: bound?.axis ?? null });
  }
  const order = [...ix.channels.keys()];
  return out.sort((a, b) => order.indexOf(a.part) - order.indexOf(b.part));
}

/**
 * Range of the tone positions that hardware instructions set, per axis and over the whole
 * run: { x: [min, max], y: [min, max] } in µm. The carrier that firmware start-up programs
 * before the first instruction is left out, so that it does not stretch the range. An axis
 * with no instruction-set position takes the range of all its entries.
 */
export function toneExtent(bundle) {
  const ix = prepare(bundle);
  const widen = (extent, axis, um) => {
    extent[axis] = extent[axis] ? [Math.min(extent[axis][0], um), Math.max(extent[axis][1], um)] : [um, um];
  };
  const set = {}, all = {};
  for (const entry of bundle.derived?.tonePositions ?? []) {
    const axis = ix.channelDevices.get(entry.part)?.axis;
    if (!axis) continue;
    widen(all, axis, entry.um);
    if (ix.hardware.has(entry.source)) widen(set, axis, entry.um);
  }
  return { ...all, ...set };
}

// ───────────────────────────── apparatus ─────────────────────────────
//
// Where the ions, atoms and light of the apparatus are at a batch time, for the 3D apparatus
// view. The layout is `machine.geometry` (riscq/geometry.mjs): display geometry with its units
// and basis. The times are the run's: the windows of `summary.pulses`, the effect frames, the
// carrier updates of `derived.tonePositions` and the transport cycles of `derived.ionMoves`.
// A batch time may be fractional, so that motion is smooth between frames.
//
// Boundaries, each also stated on the page:
// * An ion inside a transport cycle is placed on the straight line through its segments, at
//   the fraction of the cycle that has passed. Studio states the ends of a cycle, not the path.
// * An effect starts when its signal reaches the apparatus part, the `arrivesPs` of its effect
//   frame, and lasts as long as the window that caused it. So a longer cable or a slower
//   transducer moves everything it drives later. The lag of a channel is that arrival minus
//   the opening of the window at the channel.
// * An atom inside a move is where its row and column tones are: the last carrier update of
//   each tone that has reached the AOD. A carrier update takes the lag of its channel to get
//   there. Positions therefore step with the frequency code. A move with no carrier data is a
//   straight line in time.
// * A tone ramp is drawn linear over its window. The bundle does not hold the envelope.
// * Ions follow `derived.ionMoves`, whose cycles open and close with the windows at the
//   electrode channels. The converter pipeline after that is not added to them.
// An element of the apparatus scene is named `<kind>:<id>`, as in riscq/geometry.mjs.

/** Static tables of the apparatus of a bundle, built once. */
function apparatusOf(bundle) {
  const ix = prepare(bundle);
  if (ix.apparatus) return ix.apparatus;
  const geometry = bundle.machine?.geometry ?? null;
  const elements = new Map();
  const add = (id, kind, extra) => {
    if (!elements.has(id)) elements.set(id, { id, kind, ...extra });
  };
  const sites = new Map(), segments = new Map();
  if (geometry?.kind === "ion-trap") {
    for (const site of geometry.sites ?? []) {
      sites.set(site.id, site);
      add("site:" + site.id, "site", { position: site.position, zone: site.zone, gate: site.gate });
    }
    for (const segment of geometry.segments ?? []) {
      segments.set(segment.id, segment);
      add("segment:" + segment.id, "segment", { a: segment.a, b: segment.b });
    }
    for (const ion of geometry.ions ?? []) add("ion:" + ion.id, "ion", { site: ion.site });
    for (const { op } of ix.ops) for (const ion of op.ions ?? []) add("ion:" + ion, "ion", {});
    for (const record of bundle.derived?.ionMoves ?? []) for (const move of record.moves ?? []) add("ion:" + move.ion, "ion", {});
    add("light:cooling", "light", {});
  } else if (geometry?.kind === "atom-array") {
    for (const zone of geometry.zones ?? []) add("zone:" + zone.id, "zone", { origin: zone.origin, size: zone.size, zone: zone.kind });
    for (const atom of geometry.atoms ?? []) add("atom:" + atom.id, "atom", { position: atom.position });
    for (const { op } of ix.ops) for (const entry of op.atoms ?? []) add("atom:" + entry.atom, "atom", { position: entry.from });
    for (const aod of geometry.aods ?? []) {
      aod.columns.forEach((channel, k) => add("tone:" + channel, "tone", { aod: aod.id, axis: "x", index: k, channel }));
      aod.rows.forEach((channel, k) => add("tone:" + channel, "tone", { aod: aod.id, axis: "y", index: k, channel }));
    }
    add("beam:raman", "beam", {});
    add("beam:rydberg", "beam", {});
  } else if (geometry?.kind === "transmon-ring") {
    for (const qubit of geometry.qubits ?? []) add("qubit:" + qubit.id, "qubit", { position: qubit.position });
    for (const resonator of geometry.resonators ?? []) add("resonator:" + resonator.id, "resonator", { position: resonator.position, qubit: resonator.qubit });
    for (const coupler of geometry.couplers ?? []) add("coupler:" + coupler.id, "coupler", { position: coupler.position, pair: coupler.pair, offered: coupler.offered });
  }
  // Each effect frame with the batches it lasts at its apparatus part: from the arrival of
  // its signal, for as long as the window that caused it. `sent` is the batch at the converter.
  const period = bundle.machine?.dspPeriodPs || 1, lags = new Map();
  let longest = 1;
  const activity = ix.effects.map((effect) => {
    const cause = ix.frames[ix.byId.get(ix.frames[effect.index].parents?.[0])];
    const span = cause?.state?.closes !== undefined ? Math.max(1, cause.state.closes - cause.state.opens) : 1;
    const start = effect.arrivesPs === undefined ? effect.atBatch : effect.arrivesPs / period;
    longest = Math.max(longest, span);
    // Everything a channel sends takes this long from the channel to the apparatus.
    if (cause && cause.state?.opens !== undefined && !lags.has(cause.part)) lags.set(cause.part, start - cause.state.opens);
    return { id: effect.id, index: effect.index, part: effect.part, kind: effect.detail?.kind ?? null, detail: effect.detail, source: effect.source,
      binding: effect.binding, channel: cause?.part ?? null, sent: effect.atBatch, start, end: start + span };
  }).sort((a, b) => a.start - b.start);
  // Batches over which each hardware instruction acts on the apparatus: from the first arrival
  // to the last end of its effects. An instruction without an effect frame takes the windows
  // that carry it as their source, at their channels.
  const windows = new Map();
  const widen = (source, opens, closes, late) => {
    const seen = windows.get(source);
    if (seen) Object.assign(seen, { opens: Math.min(seen.opens, opens), closes: Math.max(seen.closes, closes), late: seen.late || late });
    else windows.set(source, { opens, closes, late });
  };
  for (const item of activity) if (item.source !== undefined) widen(item.source, item.start, item.end, false);
  const reached = new Set(windows.keys());
  for (const record of bundle.summary?.pulses ?? []) {
    if (record.source === undefined) continue;
    const late = record.onTime === false || record.aligned === false || record.overlap === true;
    if (!reached.has(record.source)) widen(record.source, record.opens, record.closes ?? record.opens + 1, late);
    else if (late) windows.get(record.source).late = true;
  }
  let end = Math.max(bundle.summary?.elapsedBatches ?? 0, ix.frames.at(-1)?.atBatch ?? 0);
  for (const window of windows.values()) end = Math.max(end, window.closes);
  for (const record of bundle.derived?.ionMoves ?? []) end = Math.max(end, record.closes ?? 0);
  end = Math.ceil(end);
  ix.apparatus = { geometry, elements, sites, segments, windows, activity, longest, end, lags };
  return ix.apparatus;
}

/** `machine.geometry` of the run, or null: the layout the apparatus view draws. */
export function apparatusGeometry(bundle) {
  return apparatusOf(bundle).geometry;
}

/** Elements of the apparatus scene: [{ id, kind, ... }] with kind site, segment, ion, light, zone, atom, tone, beam, qubit, resonator or coupler. */
export function apparatusElements(bundle) {
  return [...apparatusOf(bundle).elements.values()];
}

/** Last batch at which anything of the run happens: the end of the playback clock. */
export function runEnd(bundle) {
  return apparatusOf(bundle).end;
}

/**
 * Batches over which a hardware instruction acts on the apparatus, { opens, closes, late }:
 * from the first arrival to the last end of its effects. null when no window carries it.
 * `late` marks an instruction with a window that missed its time. The batches can be fractional.
 */
export function instructionWindow(bundle, sourceId) {
  return apparatusOf(bundle).windows.get(sourceId) ?? null;
}

/**
 * Batches from the opening of a window at a channel to the arrival of its signal at the
 * apparatus part it drives: converter pipeline plus the delay of its binding, from the effect
 * frames. 0 for a channel with no effect frame.
 */
export function apparatusLag(bundle, channel) {
  return apparatusOf(bundle).lags.get(channel) ?? 0;
}

/**
 * Elements of the apparatus scene that a hardware instruction acts on, by ID. A virtual Z
 * (`frame`) and the instructions of a classical segment act on no apparatus and give [].
 */
export function apparatusTargets(bundle, sourceId) {
  const ix = prepare(bundle), app = apparatusOf(bundle), entry = ix.hardware.get(sourceId);
  if (!entry || !app.geometry) return [];
  const op = entry.op, out = [];
  const add = (id) => {
    if (!out.includes(id)) out.push(id);
  };
  if (op.op === "frame" || bundle.hardware.segments[entry.segment]?.classical) return out;
  const kind = app.geometry.kind;
  if (kind === "ion-trap") {
    for (const move of op.moves ?? []) {
      add("ion:" + move.ion);
      add("site:" + move.from);
      for (const id of move.via ?? []) add("segment:" + id);
      add("site:" + move.to);
    }
    // `measure` names each ion's site. `rotate` lists one site per ion and `ms` one per pair.
    if (op.op === "measure")
      for (const [ion, site] of Object.entries(op.at ?? {})) {
        add("ion:" + ion);
        add("site:" + site);
      }
    else if (op.op === "rotate") op.ions?.forEach((ion, k) => {
      add("ion:" + ion);
      if (op.sites?.[k] !== undefined) add("site:" + op.sites[k]);
    });
    else if (op.op === "ms") op.pairs?.forEach((pair, k) => {
      for (const ion of pair) add("ion:" + ion);
      if (op.sites?.[k] !== undefined) add("site:" + op.sites[k]);
    });
    else if (op.op === "cool") {
      for (const ion of op.ions ?? []) add("ion:" + ion);
      add("light:cooling");
    }
  } else if (kind === "atom-array") {
    for (const atom of op.qubits ?? []) add("atom:" + atom);
    const aod = app.geometry.aods?.find((a) => a.id === op.aod);
    if (aod) {
      for (const column of op.cols ?? []) if (aod.columns[column.id]) add("tone:" + aod.columns[column.id]);
      for (const row of op.rows ?? []) if (aod.rows[row.id]) add("tone:" + aod.rows[row.id]);
    }
    if (op.op === "raman") add("beam:raman");
    if (op.op === "rydberg") {
      add("beam:rydberg");
      if (op.params?.zone !== undefined) add("zone:entanglement" + op.params.zone);
    }
  } else if (kind === "transmon-ring") {
    for (const qubit of op.qubits ?? []) add("qubit:" + qubit);
    if (op.op === "measure") for (const qubit of op.qubits ?? []) add("resonator:" + qubit);
    if (op.op === "cz" && op.qubits?.length === 2) {
      const [a, b] = op.qubits;
      add(app.elements.has("coupler:" + b + "-" + a) ? "coupler:" + b + "-" + a : "coupler:" + a + "-" + b);
    }
  }
  return out;
}

/**
 * Effects that reach the apparatus between two batches (inclusive), for lighting the scene:
 * [{ id, kind, part, source, binding, start, end, elements, targets }]. `elements` are the
 * scene elements of the apparatus part the effect is bound to, plus the coupler of a pair it
 * names. `targets` are the elements its hardware instruction acts on. With `from = to` these
 * are the effects active at that batch.
 */
export function litBetween(bundle, from, to = from) {
  const app = apparatusOf(bundle), list = app.activity, out = [];
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= to) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo - 1; k >= 0 && list[k].start > from - app.longest; k--) {
    const item = list[k];
    if (item.end <= from) continue;
    if (!item.elements) {
      item.elements = [...(app.geometry?.parts?.[item.part] ?? [])];
      const pair = item.detail?.pair;
      if (Array.isArray(pair))
        for (const id of ["coupler:" + pair.join("-"), "coupler:" + [...pair].reverse().join("-")])
          if (app.elements.has(id) && !item.elements.includes(id)) item.elements.push(id);
      item.targets = apparatusTargets(bundle, item.source);
    }
    out.push(item);
  }
  return out.reverse();
}

const naturalOrder = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });

/** Point at fraction `f` of the length of a polyline of positions. */
function alongPath(points, f) {
  const lengths = [];
  let total = 0;
  for (let k = 1; k < points.length; k++) {
    const d = Math.hypot(...points[k].map((v, axis) => v - points[k - 1][axis]));
    lengths.push(d);
    total += d;
  }
  if (!total) return points[0].slice();
  let left = Math.min(1, Math.max(0, f)) * total;
  for (let k = 0; k < lengths.length; k++) {
    if (left <= lengths[k] || k === lengths.length - 1) {
      const t = lengths[k] ? Math.min(1, left / lengths[k]) : 0;
      return points[k].map((v, axis) => v + (points[k + 1][axis] - v) * t);
    }
    left -= lengths[k];
  }
  return points.at(-1).slice();
}

/**
 * Trapped ions in space at a batch: [{ ion, site, position, moving, undelivered, slot, of }].
 * `position` is in the units of `machine.geometry` and is null for an ion with no site. A
 * resting ion is at its site. An ion inside a delivered transport cycle is on the line through
 * the cycle's segments at `moving.fraction` of the cycle. `slot` of `of` orders the ions that
 * rest on one site, for drawing them side by side.
 */
export function ionPositionsAt(bundle, atBatch) {
  const app = apparatusOf(bundle);
  if (app.geometry?.kind !== "ion-trap") return [];
  const place = (id) => app.sites.get(id)?.position ?? null;
  const { ions } = ionsAt(bundle, atBatch);
  const resting = new Map();
  const out = ions.map((ion) => {
    const entry = { ion: ion.ion, site: ion.site, position: place(ion.site), moving: null, undelivered: ion.undelivered, slot: 0, of: 1 };
    const move = ion.moving;
    if (move && move.delivered && place(move.from) && place(move.to)) {
      // The route runs from site to site over the segments the cycle names.
      let at = move.from, route = [place(move.from)];
      for (const id of move.via ?? []) {
        const segment = app.segments.get(id);
        at = segment && (segment.a === at || segment.b === at) ? (segment.a === at ? segment.b : segment.a) : null;
        if (at === null || !place(at)) break;
        route.push(place(at));
      }
      if (at !== move.to) route = [place(move.from), place(move.to)];
      const fraction = Math.min(1, Math.max(0, (atBatch - move.opens) / Math.max(1, move.closes - move.opens)));
      entry.moving = { ...move, fraction };
      entry.position = alongPath(route, fraction);
    } else if (move && !move.delivered) entry.undelivered = move.op;
    if (!entry.moving && entry.site !== null) {
      if (!resting.has(entry.site)) resting.set(entry.site, []);
      resting.get(entry.site).push(entry);
    }
    return entry;
  });
  for (const group of resting.values()) group.sort((a, b) => naturalOrder(a.ion, b.ion)).forEach((entry, k) => Object.assign(entry, { slot: k, of: group.length }));
  return out;
}

/**
 * Position in µm of a tone at the AOD at a batch: the last carrier update of its channel that
 * has arrived by then, or null. An update arrives the lag of its channel after it takes effect.
 */
function tonePosition(bundle, channel, atBatch) {
  const ix = prepare(bundle), sent = atBatch - (apparatusOf(bundle).lags.get(channel) ?? 0);
  if (!ix.tones) tonesAt(bundle, 0);
  const list = ix.tones.get(channel);
  if (!list) return null;
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].atBatch <= sent) lo = mid + 1;
    else hi = mid;
  }
  return lo ? list[lo - 1].um : null;
}

/** The rearrangement jobs of each atom in time order: pickup, moves and drop with their windows. */
function atomPlan(bundle) {
  const ix = prepare(bundle), app = apparatusOf(bundle);
  if (app.atomPlan) return app.atomPlan;
  const plan = new Map(), open = new Map();
  const close = (job) => {
    const aod = app.geometry?.aods?.find((a) => a.id === job.aod), legsOf = new Map();
    for (const move of job.moves) {
      const window = app.windows.get(move.id);
      // A move whose tones played no window carried nothing.
      if (!window) continue;
      for (const entry of move.atoms ?? []) {
        // The tones that hold the atom start the move at its coordinates.
        const column = move.cols?.find((c) => c.from === entry.from[0]), row = move.rows?.find((r) => r.from === entry.from[1]);
        if (!legsOf.has(entry.atom)) legsOf.set(entry.atom, []);
        legsOf.get(entry.atom).push({ op: move.id, opens: window.opens, closes: window.closes, from: entry.from, to: entry.to,
          column: aod?.columns[column?.id] ?? null, row: aod?.rows[row?.id] ?? null });
      }
    }
    const pickup = job.pickup && app.windows.get(job.pickup.id), drop = job.drop && app.windows.get(job.drop.id);
    for (const [atom, legs] of legsOf) {
      if (!plan.has(atom)) plan.set(atom, []);
      plan.get(atom).push({ aod: job.aod, pickup: job.pickup?.id ?? null, drop: job.drop?.id ?? null, legs,
        start: pickup?.opens ?? legs[0].opens, dropStart: drop?.opens ?? legs.at(-1).closes, end: drop?.closes ?? legs.at(-1).closes,
        from: legs[0].from, to: legs.at(-1).to });
    }
  };
  for (const { op } of ix.ops) {
    if (op.op === "pickup") {
      if (open.has(op.aod)) close(open.get(op.aod));
      open.set(op.aod, { aod: op.aod, pickup: op, moves: [], drop: null });
    } else if (op.op === "move") {
      if (!open.has(op.aod)) open.set(op.aod, { aod: op.aod, pickup: null, moves: [], drop: null });
      open.get(op.aod).moves.push(op);
    } else if (op.op === "drop" && open.has(op.aod)) {
      close({ ...open.get(op.aod), drop: op });
      open.delete(op.aod);
    }
  }
  for (const job of open.values()) close(job);
  for (const jobs of plan.values()) jobs.sort((a, b) => a.start - b.start);
  app.atomPlan = plan;
  return plan;
}

/**
 * Neutral atoms in space at a batch: [{ atom, position, held }] with `position` in µm.
 * Before its first pickup an atom is at its trap. From the pickup to the end of the drop it is
 * held: `held` is { aod, column, row, phase, op } with phase pickup, move, hold or drop, and
 * column and row the tone channels of its tweezer. During a move its position is that of its
 * two tones. After the drop it rests at the `to` of its last move.
 */
export function atomsAt(bundle, atBatch) {
  const app = apparatusOf(bundle);
  if (app.geometry?.kind !== "atom-array") return [];
  const plan = atomPlan(bundle), start = new Map();
  for (const atom of app.geometry.atoms ?? []) start.set(atom.id, atom.position);
  for (const [atom, jobs] of plan) if (!start.has(atom)) start.set(atom, jobs[0].from);
  return [...start].sort((a, b) => naturalOrder(a[0], b[0])).map(([atom, initial]) => {
    const jobs = plan.get(atom) ?? [];
    let k = jobs.length - 1;
    while (k >= 0 && jobs[k].start > atBatch) k--;
    if (k < 0) return { atom, position: initial.slice(), held: null };
    const job = jobs[k];
    if (atBatch >= job.end) return { atom, position: job.to.slice(), held: null };
    const leg = job.legs.find((l) => l.opens <= atBatch && atBatch < l.closes);
    const held = { aod: job.aod, column: (leg ?? job.legs[0]).column, row: (leg ?? job.legs[0]).row, phase: "hold", op: null };
    let position;
    if (leg) {
      const f = (atBatch - leg.opens) / Math.max(1, leg.closes - leg.opens);
      const x = leg.column === null ? null : tonePosition(bundle, leg.column, atBatch);
      const y = leg.row === null ? null : tonePosition(bundle, leg.row, atBatch);
      position = [x ?? leg.from[0] + (leg.to[0] - leg.from[0]) * f, y ?? leg.from[1] + (leg.to[1] - leg.from[1]) * f];
      Object.assign(held, { phase: "move", op: leg.op });
    } else if (atBatch < job.legs[0].opens) {
      position = job.from.slice();
      Object.assign(held, { phase: "pickup", op: job.pickup });
    } else {
      // Between moves and during the drop the atom is where its last move ended.
      const done = job.legs.filter((l) => l.closes <= atBatch).at(-1) ?? job.legs[0];
      position = done.to.slice();
      Object.assign(held, { column: done.column, row: done.row, phase: atBatch >= job.dropStart ? "drop" : "hold", op: atBatch >= job.dropStart ? job.drop : done.op });
    }
    return { atom, position, held };
  });
}

/**
 * AOD tweezers at a batch: [{ aod, core, columns, rows, spots }]. A tone is listed while one
 * of its windows is open: { channel, um, level, phase, source } with `level` from 0 to 1,
 * rising through a pickup window, 1 through a move and falling through a drop window. `spots`
 * are the crossings of the listed columns and rows, { x, y, level, atom }, with the atom that
 * is held there or null.
 */
export function tweezersAt(bundle, atBatch) {
  const ix = prepare(bundle), app = apparatusOf(bundle);
  if (app.geometry?.kind !== "atom-array") return [];
  if (!app.toneWindows) {
    app.toneWindows = new Map();
    for (const lane of lanes(bundle)) app.toneWindows.set(lane.part, lane.windows);
  }
  const tone = (channel) => {
    // A window is at the AOD the lag of its channel after it opens at the channel.
    const list = app.toneWindows.get(channel) ?? [], sent = atBatch - (app.lags.get(channel) ?? 0);
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].opens <= sent) lo = mid + 1;
      else hi = mid;
    }
    const window = list[lo - 1];
    if (!window || sent >= window.closes) return null;
    const phase = ix.hardware.get(window.source)?.op.op ?? null;
    const f = (sent - window.opens) / Math.max(1, window.closes - window.opens);
    return { channel, um: tonePosition(bundle, channel, atBatch), level: phase === "pickup" ? f : phase === "drop" ? 1 - f : 1, phase, source: window.source };
  };
  const atoms = atomsAt(bundle, atBatch).filter((atom) => atom.held);
  return (app.geometry.aods ?? []).map((aod) => {
    const columns = aod.columns.map(tone).filter((t) => t && t.um !== null), rows = aod.rows.map(tone).filter((t) => t && t.um !== null);
    const spots = columns.flatMap((column) => rows.map((row) => ({
      x: column.um, y: row.um, level: Math.min(column.level, row.level),
      atom: atoms.find((atom) => atom.held.column === column.channel && atom.held.row === row.channel)?.atom ?? null,
    })));
    return { aod: aod.id, core: aod.core, columns, rows, spots };
  });
}

/**
 * Box around everything of the apparatus that the run places or moves, in geometry units:
 * [[min x, min y], [max x, max y]], or null. The view starts on this region.
 */
export function apparatusBounds(bundle) {
  const ix = prepare(bundle), app = apparatusOf(bundle), points = [];
  if (app.geometry?.kind === "atom-array") {
    for (const atom of app.geometry.atoms ?? []) points.push(atom.position);
    for (const { op } of ix.ops) for (const entry of op.atoms ?? []) points.push(entry.from, entry.to);
  } else if (app.geometry?.kind === "ion-trap") for (const site of app.geometry.sites ?? []) points.push(site.position);
  else if (app.geometry?.kind === "transmon-ring") for (const item of [...(app.geometry.qubits ?? []), ...(app.geometry.resonators ?? [])]) points.push(item.position);
  if (!points.length) return null;
  return [[Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))], [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))]];
}

/**
 * Shape of the decoding graph of a decoder run, from the number of roots a decode reports:
 * { distance, rounds, rows, columns, nodes } with nodes = D · (D + 1) · (D − 1)/2, or null.
 * Node n is at round ⌊n / (rows · columns)⌋, row ⌊n / columns⌋ mod rows, column n mod columns,
 * the order in which the decoder reads a syndrome. A root is reported as 0x00KKIIJJ: round,
 * row, column.
 */
export function decodeLattice(bundle) {
  const count = bundle.derived?.decodes?.[0]?.roots?.length ?? bundle.derived?.decodes?.[0]?.syndrome?.length;
  if (!count) return null;
  for (let d = 3; d * (d + 1) * ((d - 1) / 2) <= count; d += 2)
    if (d * (d + 1) * ((d - 1) / 2) === count) return { distance: d, rounds: d, rows: d + 1, columns: (d - 1) / 2, nodes: count };
  return null;
}

/**
 * The syndrome a decoder run is working on at a batch: the last entry of `derived.decodes`
 * whose input had been read, else the first.
 * { index, decode, read, reported, nodes: [{ index, round, row, column, defect, root }] } or
 * null. `reported` counts the roots stored to the host by then. `root` is the index of the
 * node's root once it is reported, else null.
 */
export function decodeAt(bundle, atBatch) {
  const ix = prepare(bundle), decodes = bundle.derived?.decodes, lattice = decodeLattice(bundle);
  if (!decodes?.length || !lattice) return null;
  let index = 0;
  while (index + 1 < decodes.length && decodes[index + 1].inputAtBatch <= atBatch) index++;
  const decode = decodes[index], roots = decode.roots ?? [];
  // The host stores between the first and the last output frame are the record: its ID, then one root per node.
  const first = ix.byId.get(decode.frames?.firstOutput), last = ix.byId.get(decode.frames?.lastOutput);
  let stored = 0, seen = 0;
  if (first !== undefined && last !== undefined)
    for (let i = first; i <= last; i++) {
      if (ix.frames[i].op !== "host") continue;
      stored++;
      if (ix.frames[i].atBatch <= atBatch) seen++;
    }
  else if (decode.lastOutputAtBatch <= atBatch) stored = seen = roots.length;
  const reported = Math.min(roots.length, Math.max(0, seen - Math.max(0, stored - roots.length)));
  const per = lattice.rows * lattice.columns;
  const nodes = Array.from({ length: lattice.nodes }, (_, n) => {
    const word = roots[n];
    return {
      index: n, round: Math.floor(n / per), row: Math.floor(n / lattice.columns) % lattice.rows, column: n % lattice.columns,
      defect: decode.syndrome?.[n] === "1" || decode.syndrome?.[n] === 1,
      root: n < reported && word !== undefined ? ((word >>> 16) & 0xff) * per + ((word >>> 8) & 0xff) * lattice.columns + (word & 0xff) : null,
    };
  });
  return { index, decode, read: decode.inputAtBatch <= atBatch, reported, lattice, nodes };
}
