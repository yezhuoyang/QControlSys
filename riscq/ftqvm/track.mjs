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
