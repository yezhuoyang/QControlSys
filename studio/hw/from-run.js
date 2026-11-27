// A Workspace run (a RISC-Q studio bundle: /api/riscq/run) as a 3D track (riscq/ftqvm/track.mjs shape),
// so that the Workspace plays every run on its hardware document (studio/hw/machine3d.js), as the design
// page builds it and the Reproduce and Examples pages play it.
//
//   device       the run's own geometry (riscq/geometry.mjs through studio/riscq-layers.js chipLayout):
//                transmons on the ring or the design's chip (mm ÷ the 2 mm pitch), ions at their trap
//                sites (the architecture's coordinates in µm, every site of it a zone), atoms at their traps
//   events       the trace's effect frames, where a pulse reaches the device: a drive or rotation is a
//                one-qubit gate, a coupler drive or MS gate a two-qubit gate, a readout or detection a
//                measurement; global light (Raman, Rydberg, cooling) acts on every qubit
//   moves        ion transports (bundle.derived.ionMoves) and atom rearrangement jobs (riscq-layers atomJobs)
//   controller   the run's cores and the pulses they played (summary.pulses)
// Times are ns from batch 0 (`trackBaseBatch` 0).
import { chipLayout, ionPositions, atomPositions, atomJobs } from "/riscq-layers.js";

const KIND = {
  drive: "1q", rotate: "1q", raman: "1q", reset: "reset", cool: "reset",
  "cz-drive": "2q", ms: "2q", rydberg: "2q",
  "readout-tone": "measure", acquire: "measure", detect: "measure",
};
const ROLE = (name) => (/^q\d+$/.test(name) ? "qubit" : /^dec|decoder/.test(name) ? "decoder" : /^aod|^tr\d|shuttle|mover/.test(name) ? "mover"
  : /readout|detect|pmt/.test(name) ? "readout" : /frame/.test(name) ? "frame" : "beam");

/** The track of a native run, or null when its platform has no hardware document. */
export function trackFromBundle(bundle) {
  const period = bundle.machine?.dspPeriodPs ?? 2000, ns = (batch) => (batch * period) / 1000;
  const layout = chipLayout(bundle), geo = bundle.machine?.geometry ?? {};
  let device, siteOfEffect;
  if (bundle.platform === "superconducting") {
    // Transmons by index: the design's own mm (÷ the 2 mm chip pitch), or the ring scaled to a 3 mm radius.
    const n = [...layout.devices.keys()].filter((k) => /^qubit\d+$/.test(k)).length || (layout.qubitParts?.length ?? 0);
    const scale = layout.unit === "mm" ? 0.5 : 1.5;
    const part = (q) => layout.qubitParts?.[q] ?? "qubit" + q;
    const sites = Array.from({ length: n }, (_, q) => ({ kind: "data", at: (layout.devices.get(part(q)) ?? [q, 0]).map((v) => v * scale) }));
    device = { kind: "transmon", unit: "lattice", sites, couplers: (layout.couplers ?? []).filter((c) => c[2] !== false).map((c) => [c[0], c[1]]) };
    siteOfEffect = (f) => (f.state?.detail?.pair ?? (f.state?.detail?.qubit !== undefined ? [f.state.detail.qubit] : (/^qubit(\d+)$/.exec(f.part)?.slice(1) ?? []).map(Number)));
  } else if (bundle.platform === "qccd") {
    const um = geo.units?.micrometresPerUnit ?? 750;
    const ions = ionPositions(bundle, -1);
    const sites = ions.map((i) => ({ kind: "data", at: (i.at ?? [0, 0]).map((v) => v * um) }));
    device = { kind: "ions", unit: "µm", sites,
      zones: [...(layout.sites ?? new Map()).entries()].map(([id, p]) => ({ id, at: p.map((v) => v * um) })), edges: layout.edges ?? [] };
    const index = new Map(ions.map((i, k) => [i.ion, k]));
    siteOfEffect = (f) => {
      if (f.state?.detail?.broadcast || /^light:/.test(f.part)) return ions.map((_, k) => k);
      const site = f.part.replace(/^(?:site|electrodes):(?:zone\.)?/, "");
      return ionPositions(bundle, f.atBatch).filter((i) => i.site === site).map((i) => index.get(i.ion)).filter((k) => k !== undefined);
    };
    device.moves = (bundle.derived?.ionMoves ?? []).flatMap((r) => r.moves.map((m) => ({
      s: index.get(m.ion), t0: ns(r.opens), t1: ns(r.closes),
      from: (layout.sites.get(m.from) ?? [0, 0]).map((v) => v * um), to: (layout.sites.get(m.to) ?? [0, 0]).map((v) => v * um) }))).filter((m) => m.s !== undefined);
  } else if (bundle.platform === "neutral") {
    const atoms = atomPositions(bundle, -1);
    const sites = atoms.map((a) => ({ kind: "data", at: a.at }));
    let near = Infinity;
    for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) near = Math.min(near, Math.hypot(sites[i].at[0] - sites[j].at[0], sites[i].at[1] - sites[j].at[1]) || Infinity);
    device = { kind: "atoms", unit: "µm", sites, gateSiteUm: Number.isFinite(near) ? Math.round(near * 10) / 10 : 10, interactUm: geo.rydberg?.rangeUm ?? 2 };
    const index = new Map(atoms.map((a, k) => [a.atom, k]));
    siteOfEffect = () => atoms.map((_, k) => k); // Raman and Rydberg light is global on this array
    device.moves = atomJobs(bundle).flatMap((job) => job.atoms.map((a) => ({ s: index.get(a.atom), t0: ns(job.opens), t1: ns(job.closes), from: a.from, to: a.to }))).filter((m) => m.s !== undefined);
  } else return null;

  const pulses = new Map((bundle.summary?.pulses ?? []).map((p) => [p.id, p]));
  const events = [];
  for (const f of bundle.frames ?? []) {
    if (f.op !== "effect") continue;
    const k = KIND[f.state?.detail?.kind];
    if (!k) continue;
    const p = pulses.get(f.parents?.[0]);
    const s = siteOfEffect(f).filter((i) => i >= 0 && i < device.sites.length);
    if (!s.length) continue;
    events.push({ k, t0: ns(f.atBatch), t1: ns(f.atBatch + Math.max(1, p?.dur ?? 1)), s, line: (f.state?.binding ?? f.part) + " · " + f.source });
  }
  events.sort((a, b) => a.t0 - b.t0);
  const moves = device.moves ?? [];
  delete device.moves;
  const controller = {
    board: { name: bundle.machine?.name ?? "RISC-Q", dspMHz: Math.round(1e6 / period) },
    cores: (bundle.machine?.cores ?? []).map((c, i) => ({ name: c.name, role: ROLE(c.name), board: c.board ?? 0,
      channels: (c.channels ?? []).map((ch) => [ch.kind, ch.name, ch.dac ?? ch.adc]), sites: [] })),
    pulses: [...pulses.values()].filter((p) => p.closes !== undefined).map((p) => [p.core, p.channel, ns(p.atConverter ?? p.opens ?? 0), ns(p.closes)]),
  };
  const endNs = ns(bundle.summary?.elapsedBatches ?? bundle.frames?.at(-1)?.atBatch ?? 1);
  return { device, events, moves, controller, endNs };
}
