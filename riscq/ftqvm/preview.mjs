// A run's miniature, for the cards on /reproduce (and /examples): a compact copy of the track the 3D
// twin plays (riscq/ftqvm/track.mjs buildTrack) — the device's sites in the plane, its couplers, and the
// opening of the run as beats. A beat is one distinct start or end time of an operation or a move, so a
// 25 ns gate and a 200 µs atom move each take a beat: the miniature shows the order and the overlap of
// what the run did, not its durations (the 3D twin and the studio play it in machine time).
//
// preview = { kind, sites: [[x, y, kind]] (x, y in [0, 1]), couplers: [[a, b]], beats,
//             events: [[k, from, to, ...sites]], moves: [[site, from, to, x0, y0, x1, y1]] }
// with k one of 1q 2q measure reset decode frame factory, and from/to in beats.

const KIND = { data: "d", ancilla: "a", measure: "a", magic: "m" };

/** Site positions in the plane: transmons and atoms where the track puts them, ions round their ring. */
function placeSites(device) {
  const ring = device.kind === "ions-ring" ? device.ring?.zones ?? 40 : 0;
  const zoneXY = (zone, slot) => {
    const a = (2 * Math.PI * zone) / ring - Math.PI / 2, r = 1 + 0.06 * slot;
    return [Math.cos(a) * r * 1.5, Math.sin(a) * r];
  };
  const slots = new Map();
  const raw = device.sites.map((s) => {
    if (!ring) return [s.at[0], -s.at[1]];
    const z = s.at[0], k = slots.get(z) ?? 0;
    slots.set(z, k + 1);
    return zoneXY(z, k);
  });
  return { raw, zoneXY: ring ? zoneXY : null };
}

/** Scale points into [0, 1]² keeping their aspect, centred. */
function normalizer(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const ox = (span - (x1 - x0)) / 2, oy = (span - (y1 - y0)) / 2;
  return ([x, y]) => [Number(((x - x0 + ox) / span).toFixed(4)), Number(((y - y0 + oy) / span).toFixed(4))];
}

/** The preview of a track: its first `maxBeats` beats. */
export function previewOf(track, { maxBeats = 160 } = {}) {
  if (!track?.device?.sites?.length) return null;
  const { raw, zoneXY } = placeSites(track.device);
  const moves = (track.moves ?? []).map((m) => {
    const from = zoneXY ? zoneXY(m.from, 0) : [m.from[0], -m.from[1]];
    const to = zoneXY ? zoneXY(m.to, 0) : [m.to[0], -m.to[1]];
    return { ...m, fromXY: from, toXY: to };
  });
  const norm = normalizer([...raw, ...moves.flatMap((m) => [m.fromXY, m.toXY])]);
  // Beats: the distinct start and end times, in order; the preview keeps the first maxBeats of them.
  const times = [...new Set([...track.events.flatMap((e) => [e.t0, e.t1]), ...moves.flatMap((m) => [m.t0, m.t1])])].sort((a, b) => a - b);
  const kept = times.slice(0, maxBeats + 1), beatOf = new Map(kept.map((t, i) => [t, i]));
  const last = kept.at(-1);
  const beat = (t) => beatOf.get(t) ?? kept.length - 1;
  const events = track.events.filter((e) => e.t0 < last && e.s?.length)
    .map((e) => [e.k, beat(e.t0), Math.max(beat(e.t0) + 1, beat(Math.min(e.t1, last))), ...e.s]);
  const out = moves.filter((m) => m.t0 < last).map((m) => [m.s, beat(m.t0), Math.max(beat(m.t0) + 1, beat(Math.min(m.t1, last))), ...norm(m.fromXY), ...norm(m.toXY)]);
  return {
    kind: track.device.kind,
    sites: raw.map((p, k) => [...norm(p), KIND[track.device.sites[k].kind] ?? "a"]),
    couplers: (track.device.couplers ?? []).map((c) => (Array.isArray(c) ? c : [c.a ?? c[0], c.b ?? c[1]])),
    beats: Math.max(1, kept.length - 1),
    events,
    moves: out,
  };
}
