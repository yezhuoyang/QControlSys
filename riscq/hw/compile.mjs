// A hardware document as a machine the cycle-exact model runs: what the design page designs is what
// a program runs on (riscq/os/program-runs.mjs programRun with `machine`).
//
//   superconducting  the document's chip is a twin device (riscq/ftqvm/platforms.mjs transmonTwin):
//                    its transmons at their designed lattice points, its couplers as drawn. A program is
//                    placed as usual and must land on designed transmons, every gated pair on a coupler,
//                    or the run says why it does not fit. Decoder units follow the document's decoder cores.
//   atoms, ions      the document's design point (riscq/ftqvm/optical.mjs OPTICAL_DESIGNS) with the
//                    document's atom or ion positions (`homeUm`, one per placed qubit), its SLM pitch,
//                    its race-track zones, and its RISC-Q cores' beam, mover and readout channels.
// What the document does not decide yet (and the run takes from the design point): the RISC-Q builder
// still places cores on boards itself, one core per transmon.
import { transmonTwin, optical } from "../ftqvm/platforms.mjs";
import { OPTICAL_DESIGNS } from "../ftqvm/optical.mjs";
import { DESIGNS } from "../ftqvm/corpus.mjs";

const r2 = (v) => Math.round(v * 2) / 2;

/** The corpus design point a run's controller names (its board title), when there is one. */
export function pointOfTitle(title) {
  const opt = Object.entries(OPTICAL_DESIGNS).find(([, p]) => p.title === title)?.[0];
  if (opt) return { id: opt };
  const sc = DESIGNS.superconducting?.find((d) => d.title === title);
  return sc ? { id: sc.id, options: sc.options } : null;
}

/** Decoder units of a document: cores named dec<unit>.<core>, as the transmon chips name them. */
function decoderUnits(doc) {
  const units = new Map();
  for (const b of doc.control.boards) for (const c of b.cores) {
    const m = /^dec(\d+)\.(\d+)$/.exec(c.name);
    if (m) units.set(m[1], (units.get(m[1]) ?? 0) + 1);
  }
  return units.size ? { decoders: units.size, coresPerDecoder: Math.max(...units.values()) } : null;
}

/** Channels of a role on the document's cores. */
const channelsOf = (doc, role) => doc.control.boards.flatMap((b) => b.cores.filter((c) => c.role === role).flatMap((c) => c.channels)).length;

/** The machine a document describes: { adapter, platform, title }. */
export function machineOf(doc) {
  const dev = doc.device, title = doc.name ?? "designed machine";
  if (doc.platform === "superconducting") {
    const f = dev.trackFrame ?? { pitchMm: 2, offsetMm: [0, 0] };
    const sites = dev.qubits.map((q) => ({
      kind: /^data/.test(q.site ?? "") ? "data" : "ancilla",
      rc: [r2((q.positionMm[2] + f.offsetMm[1]) / f.pitchMm), r2((q.positionMm[0] + f.offsetMm[0]) / f.pitchMm)],
    }));
    const units = decoderUnits(doc) ?? doc.run?.options ?? { decoders: 1, coresPerDecoder: 4 };
    const device = { id: title, title, sites, couplers: dev.couplers ?? [] };
    return { platform: "superconducting", title, adapter: transmonTwin(device, { decoders: units.decoders ?? 1, coresPerDecoder: units.coresPerDecoder ?? 4 }) };
  }
  const ring = dev.trackFrame?.kind === "ring";
  const id = doc.run?.id && OPTICAL_DESIGNS[doc.run.id] ? doc.run.id : doc.platform === "neutral" ? "atoms-moving" : ring ? "quantinuum-h2" : "ions-qccd";
  const point = OPTICAL_DESIGNS[id];
  const overrides = {
    // Every qubit where the document puts it (µm): atoms on their SLM sites, ions in their zones.
    homeUm: dev.qubits.map((q) => [q.positionMm[0] * 1000, q.positionMm[2] * 1000]),
  };
  if (doc.platform === "neutral" && dev.layout?.slms?.[0]) overrides.pitchUm = Math.round(dev.layout.slms[0].pitchMm[0] * 1e4) / 10;
  for (const [role, field] of [["beam", "beams"], ["mover", "movers"], ["readout", "readouts"]]) {
    const n = channelsOf(doc, role);
    if (n) overrides[field] = n;
  }
  if (ring) overrides.profileOverrides = { ringZones: { value: dev.layout.sites.length, source: "the designed trap: " + dev.layout.sites.length + " zones" } };
  return { platform: doc.platform, title: title + " (" + point.title + ")", adapter: optical(id, overrides) };
}
