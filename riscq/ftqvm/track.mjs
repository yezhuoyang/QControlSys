// The animation track of a run: what the /reproduce pages play on the twin. Everything in it is
// read from the run: an operation's interval is the one the trace shows (its conformance row),
// a move is a move the controller played, a decode is the decoder service's job.
//
// Track: {
//   device: { kind: "transmon" | "atoms" | "ions-ring" | "ions", sites: [{ kind, at: [x, y] }],
//             couplers?: [[a, b]], ring?: { zones }, unit },
//   endNs,
//   events: [{ k, t0, t1, s: [site], line }]   k: 1q 2q measure reset decode frame factory
//   moves:  [{ t0, t1, s, from, to }]           positions (atoms, µm) or zones (ions)
// }

const KIND = {
  H: "1q", S: "1q", Sdg: "1q", X: "1q", Z: "1q", CZ: "2q", CNOT: "2q", CY: "2q",
  measure: "measure", request_ancilla: "reset", decode_syndrome: "decode", pauli_frame_update: "frame", parity: "frame", request_magic: "factory",
};

/** A core's role, from its name in the build: what the 3D control system draws it as. */
function roleOf(name) {
  if (/^dec\d/.test(name)) return "decoder";
  if (name === "decoder" || name === "frame") return "frame";
  if (/^beams/.test(name)) return "beam";
  if (/^pumps/.test(name)) return "pump";
  if (/^movers/.test(name)) return "mover";
  if (/^readout/.test(name)) return "readout";
  if (/^global-/.test(name)) return "global";
  return "qubit";
}

/**
 * The control system of a run, for the 3D view: the board, its cores (role, board, channels as [kind, name,
 * RF-DAC or RF-ADC index on the core's board], the sites a
 * qubit core drives) and every pulse the trace shows ([core, channel, t0 ns, t1 ns, ...sites driven]),
 * timed from the same time base as the conformance check.
 * `sitesOfOp(id)`: the sites of the listing operation a native instruction belongs to.
 */
export function controllerTrack({ spec, result, baseBatch, periodPs, sitesOfOp, coreSites = [], name, limit = 30000 }) {
  const cores = spec.cores.map((c, i) => ({ name: c.name, role: roleOf(c.name), board: c.board ?? 0, channels: c.channels.map((ch) => (ch.kind === "pulse" || ch.kind === "demod" ? [ch.kind, ch.name, ch.kind === "demod" ? ch.adc : ch.dac] : [ch.kind, ch.name])), sites: coreSites[i] ?? [] }));
  const pulses = [];
  for (const p of result.summary.pulses) {
    if (pulses.length >= limit) break;
    const sites = sitesOfOp(p.source) ?? [];
    const mine = cores[p.core]?.sites.length ? sites.filter((s) => cores[p.core].sites.includes(s)) : sites;
    pulses.push([p.core, p.channel, Math.round(((p.opens - baseBatch) * periodPs) / 1000), Math.round(((p.closes - baseBatch) * periodPs) / 1000), ...(mine.length ? mine : sites)]);
  }
  return { board: { name, dspMHz: Math.round(1e6 / periodPs), count: new Set(spec.cores.map((c) => c.board ?? 0)).size }, cores, pulses, truncated: result.summary.pulses.length > limit };
}

/** Build a track from a listing, its placement, the conformance report and the device's geometry. */
export function buildTrack({ listing, placement, report, device, moves = [] }) {
  const ops = new Map(listing.ops.map((o) => [o.uid, o]));
  const events = [];
  for (const r of report.rows) {
    const k = KIND[r.kind], op = ops.get(r.uid);
    if (!k || !op) continue;
    const t0 = Math.round(r.hardwareNs?.[0] ?? r.start), t1 = Math.round(Math.max(r.hardwareNs?.[1] ?? r.end, r.bitNs ?? 0, t0 + 1));
    const s = k === "decode" || k === "frame" ? [] : [...op.qubits, ...(k === "factory" ? op.work : [])].map((q) => placement.siteOf(q)).filter((x) => x !== undefined);
    if (!Number.isFinite(t1)) continue;
    events.push({ k, t0, t1, s, line: op.text.replace(/^@\S+\s+ns\s+/, "").slice(0, 90) });
  }
  events.sort((a, b) => a.t0 - b.t0);
  const endNs = Math.max(0, ...events.map((e) => e.t1), ...moves.map((m) => m.t1));
  return { device, endNs, events, moves: moves.sort((a, b) => a.t0 - b.t0) };
}
