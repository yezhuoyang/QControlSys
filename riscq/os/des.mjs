// QuantumOS runtime, executor B: a discrete-event simulator of a FormalRV listing on a machine.
//
// The listing is FormalRV's own expansion (riscq/ftqvm/formalrv.mjs expand: ops with uid, order,
// kind, listed start and duration, qubits, record reads and writes). The executor runs it under a
// service model and a policy, and reports what a static admission cannot: when each operation could
// start, how long it waited and for which resource, queue lengths, utilization, deadline misses,
// starvation and deadlock.
//
// Semantics (stated so a cycle-exact run can be compared with it):
//   dependencies   an op waits for the previous op on each of its qubits (program order) and for
//                  the op that last wrote each record it reads
//   resources      pools with a capacity. An op needs amounts of some pools while it runs. The
//                  FormalRV services are pools: gates (max_parallel_gates), decoders, factories,
//                  and the three bandwidths as rates in items/µs, an op holding r(N, D) =
//                  ⌈1000·N/D⌉ while it runs (the VM's rule). Qubits are a pool too: request_ancilla
//                  takes `arg` qubits and holds them until the release_ancilla of the same
//                  ancillas, which is the program's hold-and-wait. A model may add hardware pools
//                  (decoder cores, AOD jobs, junctions, lanes).
//   modes          "triggered": an op starts no earlier than its listed start (RISC-Q's timed
//                  queues); "dependency": as soon as its dependencies and resources allow
//   acquisition    "atomic": an op starts only when all its needs fit at once; "incremental":
//                  it takes its needs one pool at a time, in the order given, and holds what it
//                  has while it waits for the rest (hold-and-wait, so it can deadlock)
//   policy         the order ready ops are offered resources: "fifo" (ready time), "deadline"
//                  (listed start, earliest first), "order" (program order), "priority" (op.priority,
//                  lower first, then ready time). `strict`: an op that
//                  cannot start blocks every later one (no backfill, no starvation of large
//                  requests); otherwise later ops that fit may pass it (backfill)
// Times are integer nanoseconds.

/** The VM's reserved rate for N items in D ns, items per µs. */
export const rate = (items, ns) => Math.ceil((1000 * items) / Math.max(1, ns));

const qkey = (q) => q.register + "[" + q.index + "]";
const GATE1 = new Set(["H", "S", "Sdg", "X", "Z"]), GATE2 = new Set(["CNOT", "CZ", "CY"]);

/**
 * The FormalRV machine as a service model: each op lasts its listed duration (or the machine's
 * latency for its kind) and needs the VM's services. `latency(op)` may be replaced by a calibrated
 * sampler. Returns { pools, needs(op), latency(op, rng) }.
 */
export function machineModel(machine, { latency } = {}) {
  const m = machine;
  const pools = {
    gates: m.max_parallel_gates, decoders: m.decoders, factories: m.factories, qubits: m.qubits,
    classical: m.classical_data_bandwidth, routing: m.qubit_routing_bandwidth, ancillaRate: m.ancilla_bandwidth,
  };
  const listed = (op) => op.duration;
  return {
    pools,
    latency: latency ?? listed,
    needs(op, ns) {
      const n = op.qubits.length;
      if (GATE1.has(op.kind) || GATE2.has(op.kind)) return [["gates", 1]];
      switch (op.kind) {
        case "measure": return [["classical", rate(1, ns)]];
        case "route": return [["routing", rate(n, ns)]];
        case "request_ancilla": return [["qubits", op.arg ?? n], ["ancillaRate", rate(op.arg ?? n, ns)]];
        case "decode_syndrome": return [["decoders", 1]];
        case "request_magic": return [["factories", 1]];
        case "pauli_frame_update": case "parity": return [["classical", rate(Math.max(1, op.reads.length), ns)]];
        default: return [];
      }
    },
  };
}

/** Deterministic random numbers (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Binary min-heap on [key, seq, value]. */
class Heap {
  constructor() { this.a = []; this.seq = 0; }
  get size() { return this.a.length; }
  push(key, value) {
    const a = this.a; a.push([key, this.seq++, value]);
    for (let i = a.length - 1; i > 0;) { const p = (i - 1) >> 1; if (this.less(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && this.less(a[l], a[m])) m = l; if (r < a.length && this.less(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } }
    return top;
  }
  peek() { return this.a[0]; }
  less(x, y) { return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }
}

/**
 * Run a listing. options: { model, mode: "triggered"|"dependency", acquisition: "atomic"|"incremental",
 * policy: "fifo"|"deadline"|"order", strict, seed, starvationBypass, trace }.
 * Returns { makespanNs, ops: [{ uid, kind, ready, start, end, listedStart, listedEnd, waitNs, waitedFor }],
 * byKind, pools: { name: { capacity, peak, busyIntegral } }, deadlock, starved, misses }.
 */
export function simulate(listing, { model, mode = "dependency", acquisition = "atomic", policy = "fifo", strict = false, seed = 1, starvationBypass = 1000, trace = false } = {}) {
  const ops = [...listing.ops].sort((a, b) => a.order - b.order || a.start - b.start);
  const random = rng(seed);
  const n = ops.length, idx = new Map(ops.map((o, i) => [o.uid, i]));
  // Dependencies: previous op on each qubit, last writer of each record read.
  const preds = Array.from({ length: n }, () => new Set());
  const lastOnQubit = new Map(), lastWriter = new Map(), ancillaHolder = new Map();
  // request_ancilla holds its qubits until they are released: heldUntilRelease[req], and for each
  // release the qubits it returns to each request.
  const heldUntilRelease = new Array(n).fill(false), returns = new Map();
  ops.forEach((op, i) => {
    for (const q of op.qubits) { const k = qkey(q); if (lastOnQubit.has(k)) preds[i].add(lastOnQubit.get(k)); lastOnQubit.set(k, i); }
    for (const r of op.reads ?? []) { const k = typeof r === "string" ? r : JSON.stringify(r); if (lastWriter.has(k)) preds[i].add(lastWriter.get(k)); }
    for (const w of op.writes ?? []) lastWriter.set(typeof w === "string" ? w : JSON.stringify(w), i);
    if (op.kind === "request_ancilla") for (const q of op.qubits) ancillaHolder.set(qkey(q), i);
    if (op.kind === "release_ancilla") {
      const back = new Map();
      for (const q of op.qubits) { const req = ancillaHolder.get(qkey(q)); if (req !== undefined) { back.set(req, (back.get(req) ?? 0) + 1); heldUntilRelease[req] = true; ancillaHolder.delete(qkey(q)); } }
      returns.set(i, back);
    }
  });
  const succs = Array.from({ length: n }, () => []);
  preds.forEach((ps, i) => ps.forEach((p) => succs[p].push(i)));
  const pending = preds.map((ps) => ps.size);

  const pools = Object.fromEntries(Object.entries(model.pools).map(([k, c]) => [k, { capacity: c, used: 0, peak: 0, busyIntegral: 0, last: 0 }]));
  const book = (name, amount, t) => { const p = pools[name]; p.busyIntegral += p.used * (t - p.last); p.last = t; p.used += amount; p.peak = Math.max(p.peak, p.used); };
  const state = ops.map((op) => ({ ready: null, start: null, end: null, dur: null, needs: null, held: [], bypassed: 0, waitedFor: null }));
  const ready = []; // indices waiting for resources
  const events = new Heap(); // [time, index] completions
  let now = 0, done = 0;
  const log = trace ? [] : null;
  // "priority": a lower op.priority first (0 the most urgent), then ready time.
  const key = (i) => (policy === "deadline" ? ops[i].start : policy === "order" ? ops[i].order : policy === "priority" ? (ops[i].priority ?? 0) * 1e15 + state[i].ready : state[i].ready);

  const makeReady = (i, t) => {
    const op = ops[i], s = state[i];
    s.ready = mode === "triggered" ? Math.max(t, op.start) : t;
    s.dur = Math.max(0, Math.round(model.latency(op, random)));
    s.needs = model.needs(op, Math.max(1, s.dur)).filter(([name, a]) => a > 0 && pools[name] && pools[name].capacity !== undefined);
    // A release frees what its request holds: the qubits of the request.
    for (const [name, a] of s.needs) if (a > pools[name].capacity) { s.impossible = name; }
    ready.push(i);
  };
  const fits = (s, from = 0) => s.needs.slice(from).every(([name, a]) => pools[name].used + a <= pools[name].capacity);
  const start = (i, t) => {
    const s = state[i], op = ops[i];
    for (const [name, a] of s.needs.slice(s.held.length)) { book(name, a, t); s.held.push([name, a]); }
    s.start = t; s.end = t + s.dur;
    events.push(s.end, i);
    if (log) log.push([t, "start", op.uid]);
  };
  const finish = (i, t) => {
    const s = state[i], op = ops[i];
    // Qubits taken by request_ancilla stay held until its release; everything else is returned.
    for (const [name, a] of s.held) if (!(op.kind === "request_ancilla" && name === "qubits" && heldUntilRelease[i])) book(name, -a, t);
    if (op.kind === "release_ancilla" && pools.qubits) for (const [, count] of returns.get(i) ?? []) book("qubits", -count, t);
    done++;
    for (const j of succs[i]) if (--pending[j] === 0) makeReady(j, t);
  };

  ops.forEach((_, i) => { if (pending[i] === 0) makeReady(i, 0); });
  let deadlock = null;
  for (let guard = 0; done < n; guard++) {
    // Offer resources to ready ops whose time has come, in policy order.
    const due = ready.filter((i) => state[i].ready <= now).sort((a, b) => key(a) - key(b) || ops[a].order - ops[b].order);
    let started = false;
    for (const i of due) {
      const s = state[i];
      if (s.impossible) continue;
      if (acquisition === "incremental") {
        // Take what fits, in order, and hold it.
        while (s.held.length < s.needs.length) {
          const [name, a] = s.needs[s.held.length];
          if (pools[name].used + a > pools[name].capacity) break;
          book(name, a, now); s.held.push([name, a]);
        }
        if (s.held.length === s.needs.length) { ready.splice(ready.indexOf(i), 1); start(i, now); started = true; }
        else { s.waitedFor ??= s.needs[s.held.length][0]; s.bypassed++; if (strict) break; }
      } else if (fits(s)) { ready.splice(ready.indexOf(i), 1); start(i, now); started = true; }
      else {
        s.waitedFor ??= s.needs.find(([name, a]) => pools[name].used + a > pools[name].capacity)?.[0] ?? null;
        s.bypassed++;
        if (strict) break;
      }
    }
    void started;
    // Advance to the next completion or the next ready time.
    const nextReady = Math.min(...ready.map((i) => state[i].ready).filter((r) => r > now), Infinity);
    const nextEnd = events.size ? events.peek()[0] : Infinity;
    const next = Math.min(nextReady, nextEnd);
    if (next === Infinity) {
      // Nothing running, nothing will become ready: what is left is blocked for good.
      const blocked = ready.filter((i) => state[i].ready <= now);
      deadlock = { atNs: now, blocked: blocked.slice(0, 20).map((i) => ({ uid: ops[i].uid, kind: ops[i].kind, line: ops[i].line, waitingFor: state[i].impossible ?? state[i].needs[state[i].held.length]?.[0], holds: state[i].held })), waitingOps: blocked.length, notReady: n - done - blocked.length,
        pools: Object.fromEntries(Object.entries(pools).map(([k, p]) => [k, { used: p.used, capacity: p.capacity }])) };
      break;
    }
    now = next;
    while (events.size && events.peek()[0] <= now) { const [t, , i] = events.pop(); finish(i, t); }
  }
  for (const p of Object.values(pools)) { p.busyIntegral += p.used * (now - p.last); p.last = now; }
  const out = ops.map((op, i) => { const s = state[i]; return { uid: op.uid, kind: op.kind, line: op.line, ready: s.ready, start: s.start, end: s.end, dur: s.dur, listedStart: op.start, listedEnd: op.end, waitNs: s.start === null ? null : s.start - s.ready, waitedFor: s.waitedFor, bypassed: s.bypassed }; });
  const finished = out.filter((o) => o.end !== null);
  const makespanNs = Math.max(0, ...finished.map((o) => o.end));
  const byKind = {};
  for (const o of finished) {
    const k = (byKind[o.kind] ??= { count: 0, wait: [], dur: [], late: 0 });
    k.count++; k.wait.push(o.waitNs); k.dur.push(o.dur); if (o.end > o.listedEnd) k.late++;
  }
  for (const k of Object.values(byKind)) { k.wait = stats(k.wait); k.dur = stats(k.dur); }
  return {
    makespanNs, listedMakespanNs: Math.max(...ops.map((o) => o.end)), completed: finished.length, total: n,
    ops: out, byKind,
    pools: Object.fromEntries(Object.entries(pools).map(([k, p]) => [k, { capacity: p.capacity, peak: p.peak, utilization: now ? p.busyIntegral / (now * p.capacity) : 0 }])),
    deadlock, starved: out.filter((o) => o.bypassed >= starvationBypass).map((o) => ({ uid: o.uid, kind: o.kind, bypassed: o.bypassed, waitNs: o.waitNs })),
    misses: finished.filter((o) => o.end > o.listedEnd).length, log,
  };
}

/** min / p50 / p99 / max / mean of a list. */
export function stats(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, min: v[0], p50: q(0.5), p99: q(0.99), max: v.at(-1), mean: v.reduce((s, x) => s + x, 0) / v.length };
}
