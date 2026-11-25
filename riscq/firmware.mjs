// Firmware generation for RISC-Q control cores. `Firmware` emits the operations of RISC-Q's
// firmware library (software/fw/riscq.h) as RV32I instructions. `compileCore` turns one core's
// timed plan into a complete program: program the pulse tables, anchor a time base, then issue
// each fire one schedule lead ahead of its start time.
//
// Units: every time is a count of batches (dspClk cycles). Codes are the 16-bit register codes.
// Register use: s0 = time base of the current segment, s1 = control block (0x4000),
// s2 = classical bit table, t0–t2 and a0–a2 = scratch.
import { Assembler } from "./rv32.mjs";
import { MAP, LEAD, READOUT_LEAD, channelBase, sinkAddress, pack16, model } from "./soc.mjs";

/**
 * Cycles from a segment's time read (now() or the barrier release) to the core's first issue wait:
 * the read's own latency, the table addresses and the first loop iteration's loads. Measured 53 on the
 * core model that matches RISC-Q's RTL (QControl/RiscQ/Pipe.lean); 64 keeps the margin RISC-Q's own LEAD
 * keeps for its CPU jitter. Each bit fetched from another core before the segment adds FETCH_COST.
 */
export const SEGMENT_SETUP = 64;
export const FETCH_COST = 14;
/**
 * Batches added to a barrier release before the first start time: the lead, the segment setup, and the
 * age of the release stamp when the core reads it (the hub stamps it at dispatch; it reaches the core's
 * inbox 3 + 2·linkPipe later and the read returns 4 after that, riscq/soc.mjs hubUp).
 */
export const syncLead = (spec) => LEAD + SEGMENT_SETUP + 1 + spec.linkPipe + 2 + spec.linkPipe + 4 + remoteReleaseLead(spec);
/**
 * On several boards a release carries the root's stamp but reaches the other boards later (QControl/
 * RiscQ/Soc.lean, the barrier release): board 0 sends one release frame per remote board, the i-th
 * one cycle after the previous, and a frame reaches the far hub's lane input `laneCross` cycles after
 * it leaves, on the next of the lane's word-clock edges (laneWord cycles apart); that hub dispatches
 * it 7 cycles later (validation/riscq/rtl/QosLaneTiming.scala: 317–324 cycles root to far dispatch),
 * after at most one grant to each of its other sources. Every member of a barrier shares one time base,
 * so every core waits for the last board's release. `spec.laneModel` takes riscq/soc.mjs model()'s
 * overrides (`laneWords`) when the program runs with them.
 */
export function remoteReleaseLead(spec) {
  const boards = new Set(spec.cores.map((c) => c.board ?? 0)).size;
  if (boards < 2) return 0;
  const m = model(spec, spec.laneModel ?? {});
  const perBoard = Math.max(...[...new Set(spec.cores.map((c) => c.board ?? 0))].map((b) => spec.cores.filter((c) => (c.board ?? 0) === b).length));
  return 1 + (boards - 2) + m.laneCross + (m.laneWord - 1) + 7 + perBoard;
}
/**
 * The bound above holds for a release with no frame ahead of it on its lane. A lane carries one frame
 * per `laneFrame` cycles, so each frame still queued there when the root sends the release delays it
 * one frame time: `frames` is what riscq/compile.mjs counts, the shared bits the previous segment
 * published (a decoder's result just before its barrier, as on RISC-Q's PutLane).
 */
export function laneBacklogLead(spec, frames = 0) {
  if (!frames || new Set(spec.cores.map((c) => c.board ?? 0)).size < 2) return 0;
  return frames * model(spec, spec.laneModel ?? {}).laneFrame;
}
export const SYNC_LEAD = LEAD + 32; // kept for older callers; compileCore uses syncLead(spec)
/** Smallest distance from a fire's issue to its start that still lands on time, with margin. */
export const MIN_ISSUE_LEAD = 64;

const FIELD = { phase: 0, amp: 4, env: 8, dur: 12 };

export class Firmware {
  constructor(spec, coreIndex) {
    this.spec = spec;
    this.core = spec.cores[coreIndex];
    this.coreIndex = coreIndex;
    this.asm = new Assembler();
    this.bits = new Map();
    // The bit table occupies the top of RAM, below a small stack reserve.
    this.bitBase = MAP.MEM_BASE + 4 * (this.core.memWords - 320);
  }
  channel(ref) {
    const index = typeof ref === "number" ? ref : this.core.channels.findIndex((ch) => ch.name === ref);
    if (!this.core.channels[index]) throw Error("Core " + this.core.name + " has no channel " + ref + ".");
    return index;
  }
  bit(name) {
    if (!this.bits.has(name)) {
      if (this.bits.size >= 256) throw Error("Core " + this.core.name + " uses more than 256 classical bits.");
      this.bits.set(name, this.bits.size);
    }
    return 4 * this.bits.get(name);
  }
  /** Load the fixed base registers. */
  begin() {
    const a = this.asm;
    a.li("s1", MAP.CTRL_TIME_CMP);
    a.li("s2", this.bitBase);
  }
  /** rd = current batch time (core-local copy). */
  now(rd) {
    const a = this.asm;
    a.lui("t0", 0xc);
    a.lw(rd, "t0", MAP.CTRL_TIME - 0xc000);
  }
  /** Stall until the batch time reaches the value in `rs`. */
  waitUntil(rs) {
    const a = this.asm;
    a.sw(rs, "s1", 0);
    a.lw("t2", "s1", MAP.CTRL_WAIT_TIME_CMP - MAP.CTRL_TIME_CMP);
  }
  /** rd = time base + offset. */
  timeAt(rd, offset) {
    const a = this.asm;
    if (offset >= -2048 && offset < 2048) a.addi(rd, "s0", offset);
    else {
      a.li(rd, offset);
      a.add(rd, "s0", rd);
    }
  }
  /** Store `rs` to a channel register. Uses t0. */
  put(channel, offset, rs) {
    const a = this.asm;
    const address = channelBase(this.channel(channel)) + offset;
    const low = (address << 20) >> 20;
    a.lui("t0", ((address - low) >>> 12) & 0xfffff);
    a.sw(rs, "t0", low);
  }
  putConstant(channel, offset, value) {
    if (value === 0) return this.put(channel, offset, "zero");
    this.asm.li("t1", value);
    this.put(channel, offset, "t1");
  }
  setStart(channel, rs) {
    this.put(channel, MAP.RF_START_TIME, rs);
  }
  fire(channel, slot) {
    this.putConstant(channel, MAP.RF_FIRE, slot);
  }
  setField(channel, slot, field, code) {
    this.putConstant(channel, (slot + 1) * MAP.RF_SLOT_STRIDE + FIELD[field], pack16(code));
  }
  setFreq(channel, code) {
    this.putConstant(channel, MAP.RF_FREQ, pack16(code));
  }
  setPhaseOffset(channel, code) {
    this.putConstant(channel, MAP.RF_PHASE_OFFSET, pack16(code));
  }
  setDcOffset(channel, code) {
    this.putConstant(channel, MAP.RF_DC_OFFSET, pack16(code));
  }
  /** Reset the live registers of a channel and program its table (riscq.h init_pulse_params). */
  initChannel(channel, slots, freq) {
    this.now("t1");
    this.setStart(channel, "t1");
    const kind = this.core.channels[this.channel(channel)].kind;
    if (kind !== "dio") {
      this.setPhaseOffset(channel, 0);
      this.setDcOffset(channel, 0);
      if (freq !== undefined) this.setFreq(channel, freq);
    }
    for (const s of slots)
      for (const field of ["phase", "amp", "env", "dur"]) this.setField(channel, s.slot, field, s[field] ?? 0);
  }
  /** rd = result bit of a demod channel. Stalls until the integral has settled. */
  readResult(channel, rd) {
    this.asm.lw(rd, "s1", sinkAddress(this.core, this.channel(channel)) - MAP.CTRL_TIME_CMP);
  }
  /** Publish the bit in `rs` (0 or 1) to slot `slot` of shared group `group`. Uses t0, t1. */
  publish(group, slot, rs) {
    const a = this.asm;
    a.ori("t1", rs, slot << 1);
    const address = MAP.PUT_WINDOW + ((MAP.GROUP_NODE0 + group) << 16);
    a.lui("t0", address >>> 12);
    a.sw("t1", "t0", 0);
  }
  /** rd = the bit last published to a slot of a group. Read it after the barrier that orders it. */
  remote(group, slot, rd) {
    const a = this.asm;
    a.lw(rd, "s1", MAP.INBOX_BOARD + 4 * group - MAP.CTRL_TIME_CMP);
    if (slot) a.srli(rd, rd, slot);
    a.andi(rd, rd, 1);
  }
  /** Arrive at a counted barrier and stall until every member has. rd = the common release time. */
  barrier(id, members, rd) {
    const a = this.asm;
    a.li("t1", members);
    const address = MAP.PUT_WINDOW + ((MAP.BARRIER_NODE0 + id) << 16);
    a.lui("t0", address >>> 12);
    a.sw("t1", "t0", 0);
    a.lw(rd, "s1", MAP.INBOX_RELEASE - MAP.CTRL_TIME_CMP);
  }
  /**
   * Count rising edges on input lines of a dio channel until the batch time `untilOffset`.
   * `lines[i]` is counted into `counters[i]`. One loop drains the channel's event queue, so
   * several lines are counted in the same window.
   */
  /**
   * Count rising edges like `countEdges`, but without polling: wait until the window has closed,
   * then drain the events the channel queued during it (a dio channel queues its edges). The
   * core does no work during the exposure, so a long window costs no instructions.
   */
  countEdgesAtEnd(channel, lines, untilOffset, counters) {
    const a = this.asm;
    const sink = sinkAddress(this.core, this.channel(channel)) - MAP.CTRL_TIME_CMP;
    const [drain, done] = ["drain", "drained"].map((n) => a.fresh(n));
    for (const counter of counters) a.li(counter, 0);
    this.timeAt("t2", untilOffset);
    this.waitUntil("t2");
    a.lw("a1", "s1", sink + 0x18); // queued events
    a.label(drain);
    a.beq("a1", "zero", done);
    a.lw("t1", "s1", sink);
    a.addi("a1", "a1", -1);
    a.srli("t2", "t1", 16);
    a.and("t1", "t1", "t2");
    lines.forEach((line, i) => {
      a.srli("t2", "t1", line);
      a.andi("t2", "t2", 1);
      a.add(counters[i], counters[i], "t2");
    });
    a.j(drain);
    a.label(done);
  }
  countEdges(channel, lines, untilOffset, counters) {
    const a = this.asm;
    const sink = sinkAddress(this.core, this.channel(channel)) - MAP.CTRL_TIME_CMP;
    const [poll, drain, next] = ["poll", "drain", "next"].map((n) => a.fresh(n));
    for (const counter of counters) a.li(counter, 0);
    this.timeAt("a2", untilOffset);
    a.label(poll);
    a.lw("a1", "s1", sink + 0x18); // queued events
    a.label(drain);
    a.beq("a1", "zero", next);
    a.lw("t1", "s1", sink); // pop one event: {changed[31:16], levels[15:0]}
    a.addi("a1", "a1", -1);
    a.srli("t2", "t1", 16);
    a.and("t1", "t1", "t2"); // lines that changed and are now high
    lines.forEach((line, i) => {
      a.srli("t2", "t1", line);
      a.andi("t2", "t2", 1);
      a.add(counters[i], counters[i], "t2");
    });
    a.j(drain);
    a.label(next);
    this.now("t1");
    a.sub("t1", "t1", "a2");
    a.blt("t1", "zero", poll); // signed distance, safe across the 32-bit wrap
  }
  /** Keep a measured bit in the bit table and report it to the host result window. */
  storeBit(name, rs) {
    const a = this.asm;
    const offset = this.bit(name);
    a.sw(rs, "s2", offset);
    a.lui("t0", MAP.HOSTWIN >>> 12);
    a.sw(rs, "t0", offset);
  }
  /**
   * Lookup decode. The `width` shared bits that start at `slot` of group `group` index a table
   * of correction words in RAM. Bit j of the word becomes the classical bit `outputs[j]`:
   * stored, reported to the host and, where `publishes[j]` names a shared slot, published.
   * Read the group after the barrier that orders its bits. Uses a0–a2, t0, t1.
   */
  decode(group, slot, width, table, outputs, publishes = []) {
    const a = this.asm;
    if (width < 1 || width > 10) throw Error("A lookup decode takes 1 to 10 syndrome bits.");
    a.lw("a0", "s1", MAP.INBOX_BOARD + 4 * group - MAP.CTRL_TIME_CMP);
    if (slot) a.srli("a0", "a0", slot);
    a.andi("a0", "a0", (1 << width) - 1);
    a.slli("a0", "a0", 2);
    a.la("a2", table);
    a.add("a2", "a2", "a0");
    a.lw("a0", "a2", 0);
    outputs.forEach((name, j) => {
      if (j) a.srli("a1", "a0", j);
      else a.mv("a1", "a0");
      a.andi("a1", "a1", 1);
      this.storeBit(name, "a1");
      if (publishes[j]) this.publish(publishes[j].group, publishes[j].slot, "a1");
    });
  }
  /** Pauli-frame update: flip the bits `mask` of the frame word `name`. No pulse is played. */
  frameUpdate(name, mask) {
    const a = this.asm;
    a.lw("a1", "s2", this.bit(name));
    a.xori("a1", "a1", mask);
    this.storeBit(name, "a1");
  }
  /** XOR of classical bits of this core's bit table into a new bit, stored and reported. Uses a0, a1. */
  parity(inputs, output) {
    const a = this.asm;
    a.li("a0", 0);
    for (const name of inputs) {
      a.lw("a1", "s2", this.bit(name));
      a.xor("a0", "a0", "a1");
    }
    this.storeBit(output, "a0");
  }
  /** Raise the completion flag and park. */
  done() {
    const a = this.asm;
    a.li("t1", 1);
    a.sw("t1", "s1", MAP.CTRL_DONE - MAP.CTRL_TIME_CMP);
    a.park();
  }
}

/** Batches from the close of a readout window until the stalled result read has returned. */
export const READ_SETTLE = 40;
/**
 * Core cycles to issue one operation from the table-driven loop, back to back: measured on the core
 * model that matches RISC-Q's RTL cycle for cycle (QControl/RiscQ/Pipe.lean, validation/riscq/rtl/):
 * four table loads (6 cycles each on the data bus), the timeCmp write and the waitTimeCmp read that
 * waits for it to drain, the two posted stores (they drain one per 6 cycles), the loop branch.
 * 63 cycles per write (tests/riscq-limits.test.mjs re-measures it).
 */
export const TABLE_COST = 63;

/**
 * Core cycles to issue one inline operation, back to back, measured on the same model: 38–40 for a
 * fire with one field or a phase offset, about 4.5 more per further field set (41–42 for two, 46 for
 * three). A condition (`when`) adds the load of its bit (6 cycles) and its branch, which the 2-entry
 * branch target buffer mispredicts when it skips (10 cycles): 17 at most.
 */
function inlineCost(op) {
  return 35 + 5 * ((op.set?.length ?? 0) + (op.phaseOffset !== undefined ? 1 : 0)) + (op.when !== undefined ? 17 : 0);
}

/**
 * Core cycles that a decode, a Pauli-frame update or a parity occupies the core, measured on the core
 * model that matches RISC-Q's RTL (each routine run alone, between two host-window markers): a lookup
 * decode of k syndrome bits 17 + 10·k (27 for one bit, 97 for eight; riscq/limits.mjs decodeFanIn),
 * plus about 6 per decoded bit it publishes; a frame update 21; a parity of k bits 13 + 8·k.
 */
export function busyCycles(op) {
  if (op.decode) return 17 + 10 * op.decode.width + 6 * (op.publishes?.length ?? 0);
  if (op.frame) return 21;
  if (op.parity) return 13 + 8 * op.parity.inputs.length;
  return 0;
}

/**
 * Order one segment's operations by the batch at which the core issues them.
 *
 * A timed write (a fire or a carrier update) is issued one schedule lead before its start. A
 * result read or an edge count holds the core from its begin until its window has closed, so
 * a write whose issue falls inside a hold is issued before the hold begins. The core issues
 * one operation at a time: a backward pass moves each issue early enough for the operations
 * after it. A channel's timed queues hold `depth + 1` entries, so a write cannot be issued
 * before the entry that many places ahead of it has started.
 */
export function issueOrder(ops, core, channelOf, cost = inlineCost) {
  const holds = [];
  for (const op of ops) {
    if (op.read) holds.push({ begin: op.at + READOUT_LEAD, end: op.read.until + READ_SETTLE });
    if (op.count) holds.push({ begin: op.at, end: op.count.until + 8 });
    // Classical work the core does when it reaches it holds the core for its measured duration.
    const busy = busyCycles(op);
    if (busy) holds.push({ begin: op.at, end: op.at + busy });
  }
  const history = new Map();
  const items = [];
  for (const [order, op] of [...ops].sort((x, y) => x.at - y.at).entries()) {
    if (!Number.isInteger(op.at) || op.at < 0) throw Error("Operation time must be a nonnegative batch count.");
    if (!op.fire && !op.freq) {
      items.push({ op, issue: op.read ? op.at + READOUT_LEAD : op.at, order, hold: true });
      continue;
    }
    const channel = channelOf((op.fire ?? op.freq).channel);
    const name = core.name + "." + core.channels[channel].name;
    // Fires and carrier updates wait in separate queues of the same channel.
    const key = channel + (op.freq ? ":freq" : "");
    const earlier = history.get(key) ?? [];
    const floor = earlier.length > core.queueDepth ? earlier.at(-core.queueDepth - 1) : -Infinity;
    let issue = op.at - LEAD;
    for (let moved = true; moved; ) {
      moved = false;
      for (const hold of holds)
        if (issue >= hold.begin - 24 && issue <= hold.end) {
          issue = hold.begin - 25;
          moved = true;
        }
    }
    earlier.push(op.at);
    history.set(key, earlier);
    items.push({ op, issue, order, channel, floor, name, key });
  }
  // Fires precede a hold that begins at the same batch. The backward pass can pull a write earlier
  // than a hold (a result read, a count, classical work) that precedes it: the core must then issue it
  // before entering the hold, and a write pulled into a hold's busy window goes before it. Sort and
  // pass again until nothing moves (issues only decrease, so this ends).
  const inHold = (issue) => holds.find((hold) => issue >= hold.begin - 24 && issue <= hold.end);
  for (let changed = true; changed; ) {
    changed = false;
    items.sort((x, y) => x.issue - y.issue || (x.hold ? 1 : 0) - (y.hold ? 1 : 0) || x.order - y.order);
    for (let i = items.length - 2; i >= 0; i--) {
      if (items[i].hold) continue;
      let issue = Math.min(items[i].issue, items[i + 1].issue - cost(items[i].op));
      for (let hold = inHold(issue); hold; hold = inHold(issue)) issue = hold.begin - 25;
      if (issue !== items[i].issue) {
        items[i].issue = issue;
        changed = true;
      }
    }
    // A channel's timed queues are first in, first out: its writes must enter in start order, so an
    // earlier write is issued no later than a later one on the same queue.
    const queues = new Map();
    for (const item of items) if (!item.hold) (queues.get(item.key) ?? queues.set(item.key, []).get(item.key)).push(item);
    for (const queue of queues.values()) {
      queue.sort((x, y) => x.order - y.order);
      for (let k = queue.length - 2; k >= 0; k--)
        if (queue[k].issue > queue[k + 1].issue) {
          queue[k].issue = queue[k + 1].issue;
          changed = true;
        }
    }
  }
  for (const item of items)
    if (!item.hold && item.issue < item.floor)
      throw Error("Channel " + item.name + " cannot take this write on time: the core must issue it at batch " +
        item.issue + ", before the entry " + (core.queueDepth + 1) + " places ahead of it starts at batch " +
        item.floor + ". The schedule exceeds the queue depth or the issue rate of the core.");
  return items;
}

/** A segment of plain timed writes is issued by the table loop. */
function isPlain(ops) {
  return ops.length > 0 && ops.every((op) =>
    op.freq || (op.fire && !op.set?.length && op.phaseOffset === undefined && op.when === undefined));
}
export function segmentIssue(core, ops, channelOf) {
  const plain = isPlain(ops);
  return { plain, items: issueOrder(ops, core, channelOf, plain ? () => TABLE_COST : inlineCost) };
}
/** Batches by which a segment must start later so that its earliest write is issued on time. */
export function prerollOf(core, ops) {
  const channelOf = (ref) => (typeof ref === "number" ? ref : core.channels.findIndex((ch) => ch.name === ref));
  const { items } = segmentIssue(core, ops, channelOf);
  const earliest = items.reduce((m, item) => (item.hold ? m : Math.min(m, item.issue)), 0);
  return Math.max(0, -earliest - LEAD);
}

/**
 * Compile one core's plan.
 *
 * plan = {
 *   channels: [{ channel, freq?, slots: [{ slot, phase, amp, env, dur }] }],
 *   segments: [{
 *     sync: { barrier, members } | undefined,     // undefined anchors on the core's own clock
 *     fetch: [{ group, slot, bit }],              // shared bits read right after the barrier
 *     ops: [
 *       { at, fire: { channel, slot }, set?: [{ field, code }], phaseOffset?, when?, source }
 *       { at, freq: { channel, code }, source }   // carrier update that lands at `at`
 *       { at, read: { channel, until }, bit, publish?: { group, slot }, source }
 *       { at, count: { channel, lines, until, threshold }, bits, publishes?, source }  // one bit per line
 *       { at, decode: { group, slot, width, table, outputs }, publishes?, source }   // lookup decoder
 *       { at, frame: { name, mask }, when?, source }                                 // Pauli-frame update
 *     ],
 *     span,                                       // batches the segment lasts, or undefined
 *                                                 // when the cores go on as soon as they are done
 *   }],
 * }
 * `at` and `until` are in batches from the segment's time base. A segment that consists only
 * of plain timed writes is issued by a loop over a four-word table: issue time, start time,
 * register address, data. Other segments are issued inline. A decode or a frame update runs
 * as soon as the core reaches it. It has no start time of its own.
 */
export function compileCore(spec, coreIndex, plan) {
  const fw = new Firmware(spec, coreIndex);
  const a = fw.asm;
  const core = fw.core;
  const tables = [], data = [];
  a.source("init");
  fw.begin();
  for (const ch of plan.channels ?? []) fw.initChannel(ch.channel, ch.slots ?? [], ch.freq);
  let writes = 0;
  for (const [segmentIndex, segment] of (plan.segments ?? []).entries()) {
    a.source("segment" + segmentIndex + "/sync");
    const setup = FETCH_COST * (segment.fetch?.length ?? 0);
    if (segment.sync) {
      fw.barrier(segment.sync.barrier, segment.sync.members, "a0");
      a.li("t1", syncLead(spec) + laneBacklogLead(spec, segment.sync.laneBacklog) + setup);
    } else {
      fw.now("a0");
      a.li("t1", LEAD + SEGMENT_SETUP + setup);
    }
    a.add("s0", "a0", "t1");
    for (const f of segment.fetch ?? []) {
      fw.remote(f.group, f.slot, "t1");
      a.sw("t1", "s2", fw.bit(f.bit));
    }
    for (const op of segment.ops)
      if (op.fire && op.fire.slot >= core.channels[fw.channel(op.fire.channel)].slots)
        throw Error("Fire of a missing pulse-table entry on " + core.name + ".");
    const { plain, items } = segmentIssue(core, segment.ops, (ref) => fw.channel(ref));
    if (plain) {
      const [table, end, loop] = ["table", "tableEnd", "issue"].map((n) => a.fresh(n));
      tables.push({ table, end, items });
      // The loop carries no source of its own. Each write is attributed to its table entry.
      a.source("");
      a.la("a3", table);
      a.la("a6", end);
      a.label(loop);
      a.lw("t2", "a3", 0); // issue time
      a.lw("t1", "a3", 4); // start time
      a.lw("a4", "a3", 8); // register address
      a.lw("a5", "a3", 12); // data
      a.addi("a3", "a3", 16);
      a.add("t2", "s0", "t2");
      fw.waitUntil("t2");
      a.add("t1", "s0", "t1");
      a.srli("t0", "a4", 16);
      a.slli("t0", "t0", 16); // channel window
      a.lui("t2", MAP.RF_START_TIME >>> 12);
      a.add("t0", "t0", "t2");
      a.sw("t1", "t0", MAP.RF_START_TIME & 0xfff);
      a.sw("a5", "a4", 0);
      a.bne("a3", "a6", loop);
      writes += items.length;
    } else {
      let waited = -Infinity;
      for (const { op, issue, channel } of items) {
        a.source(op.source ?? "segment" + segmentIndex);
        if (issue > waited && !op.decode && !op.frame && !op.parity) {
          fw.timeAt("t2", issue);
          fw.waitUntil("t2");
          waited = issue;
        }
        // A classical operation marked `timed` starts at its own time, as a listing schedules it.
        if (op.timed && (op.decode || op.frame || op.parity)) {
          fw.timeAt("t2", op.at);
          fw.waitUntil("t2");
        }
        let skip;
        if (op.when !== undefined) {
          skip = a.fresh("skip");
          a.lw("t1", "s2", fw.bit(op.when));
          a.beq("t1", "zero", skip);
        }
        if (op.fire) {
          for (const s of op.set ?? []) fw.setField(channel, op.fire.slot, s.field, s.code);
          if (op.phaseOffset !== undefined) fw.setPhaseOffset(channel, op.phaseOffset);
          fw.timeAt("t1", op.at);
          fw.setStart(channel, "t1");
          fw.fire(channel, op.fire.slot);
          writes++;
        } else if (op.freq) {
          fw.timeAt("t1", op.at);
          fw.setStart(channel, "t1");
          fw.setFreq(channel, op.freq.code);
          writes++;
        } else if (op.read) {
          // The result latch holds the previous window until this one opens (riscq.h read_res).
          fw.readResult(op.read.channel, "a1");
          fw.storeBit(op.bit, "a1");
          if (op.publish) fw.publish(op.publish.group, op.publish.slot, "a1");
        } else if (op.count) {
          const counters = ["s3", "s4", "s5", "s6"].slice(0, op.count.lines.length);
          if (counters.length !== op.count.lines.length) throw Error("A count reads at most four lines.");
          if (op.count.atEnd) fw.countEdgesAtEnd(op.count.channel, op.count.lines, op.count.until, counters);
          else fw.countEdges(op.count.channel, op.count.lines, op.count.until, counters);
          counters.forEach((counter, i) => {
            a.sltiu("a1", counter, op.count.threshold); // a1 = (count < threshold)
            a.xori("a1", "a1", 1);
            fw.storeBit(op.bits[i], "a1");
            if (op.publishes?.[i]) fw.publish(op.publishes[i].group, op.publishes[i].slot, "a1");
          });
        } else if (op.decode) {
          const { group, slot, width, table, outputs } = op.decode;
          if (table.length !== 1 << width) throw Error("A lookup decode of " + width + " bits needs " + (1 << width) + " table words.");
          const label = a.fresh("lut");
          data.push({ label, words: table, source: op.source });
          fw.decode(group, slot, width, label, outputs, op.publishes);
        } else if (op.frame) {
          fw.frameUpdate(op.frame.name, op.frame.mask);
        } else if (op.parity) {
          fw.parity(op.parity.inputs, op.parity.output);
        } else throw Error("Unknown firmware operation.");
        if (skip) a.label(skip);
      }
    }
    if (segment.span !== undefined) {
      // Hold the core until the segment's last window has closed.
      a.source("segment" + segmentIndex + "/end");
      fw.timeAt("t2", segment.span);
      fw.waitUntil("t2");
    }
  }
  a.source("done");
  fw.done();
  for (const { table, end, items } of tables) {
    a.label(table);
    for (const { op, issue, channel } of items) {
      a.source(op.source ?? "table");
      a.word(issue);
      a.word(op.at);
      a.word(channelBase(channel) + (op.fire ? MAP.RF_FIRE : MAP.RF_FREQ));
      a.word(op.fire ? op.fire.slot : pack16(op.freq.code));
    }
    a.label(end);
    a.source("");
  }
  for (const block of data) {
    a.label(block.label);
    a.source(block.source ?? "table");
    for (const word of block.words) a.word(word);
    a.source("");
  }
  const image = a.assemble();
  if (image.words.length > core.memWords - 320)
    throw Error("Core " + core.name + ": the program needs " + image.words.length + " words and the RAM has " +
      (core.memWords - 320) + " below the bit table.");
  return { words: image.words, sourceMap: image.sourceMap, bits: Object.fromEntries(fw.bits),
    bitBase: fw.bitBase, stats: { instructions: image.words.length, writes } };
}
