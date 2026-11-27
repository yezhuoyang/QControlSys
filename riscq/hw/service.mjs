// The hardware documents the design page opens: one per reproduced paper and per Examples run, each
// built from the run's own 3D track (riscq/hw/document.mjs), so the design page starts from exactly
// the machine that page shows.
//   GET /api/hw/documents          [{ id, title, platform, group }]
//   GET /api/hw/document?id=…      a hardware document (kind "riscq-design", version 2); a paper's other
//                                  runs are reproduce:<paper>:<row>
//   GET /api/hw/templates          the reference devices a page's riscq/hw/doc-core.mjs builds documents with
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { documentFromTrack, TEMPLATES } from "./document.mjs";

const ROOT = new URL("../../", import.meta.url);
const PAPERS = new URL("validation/ftqvm/papers/", ROOT), SITE = new URL("validation/calib/site/", ROOT);
const cache = new Map();
const read = (url) => {
  const mtime = statSync(url).mtimeMs, hit = cache.get(url.href);
  if (hit?.mtime === mtime) return hit.value;
  const value = JSON.parse(readFileSync(url, "utf8"));
  cache.set(url.href, { mtime, value });
  return value;
};

/**
 * Small machines to start a design from scratch, one per platform: a 3 × 3 transmon chip, a 4 × 4
 * atom array, a ten-zone ion race track, each with one RISC-Q board whose cores serve the qubits.
 */
const core = (name, role, sites, channels) => ({ name, role, board: 0, channels, sites });
const BLANK = {
  superconducting: () => {
    const sites = Array.from({ length: 9 }, (_, i) => ({ kind: "qubit", at: [i % 3, Math.floor(i / 3)] }));
    const couplers = [];
    sites.forEach((s, i) => { if (i % 3 < 2) couplers.push([i, i + 1]); if (i < 6) couplers.push([i, i + 3]); });
    return { device: { kind: "transmon", unit: "lattice", sites, couplers },
      controller: { board: { name: "A new superconducting machine", dspMHz: 500 },
        cores: sites.map((_, i) => core("q" + i, "qubit", [i], [["pulse", "gate", i], ["pulse", "ro", 15], ["demod", "demod", i]])) } };
  },
  neutral: () => ({
    device: { kind: "atoms", unit: "µm", sites: Array.from({ length: 16 }, (_, i) => ({ kind: "atom", at: [(i % 4) * 10, Math.floor(i / 4) * 10] })), gateSiteUm: 10, interactUm: 2.5 },
    controller: { board: { name: "A new neutral-atom machine", dspMHz: 500 },
      cores: [core("beams0", "beam", [], [0, 1, 2, 3].map((k) => ["pulse", "b" + k, k])), core("movers0", "mover", [], [0, 1].map((k) => ["pulse", "aod" + k, 4 + k])),
        core("readout0", "readout", [], [["pulse", "detect", 6], ["demod", "pmt", 0]])] },
  }),
  qccd: () => ({
    device: { kind: "ions-ring", ring: { zones: 10 }, sites: Array.from({ length: 8 }, (_, i) => ({ kind: "ion", at: [i, 0] })) },
    controller: { board: { name: "A new trapped-ion machine", dspMHz: 500 },
      cores: [core("beams-zones", "beam", [], [0, 1, 2, 3].map((k) => ["pulse", "zone" + k])), core("shuttle0", "mover", [], [0, 1].map((k) => ["pulse", "dc" + k]))] },
  }),
};

/** Every run with a stored track: { id, title, platform, group, load() → { track, name, source, design } }. */
function sources() {
  const out = Object.entries(BLANK).map(([platform, make]) => ({ id: "new:" + platform, title: "New " + { superconducting: "superconducting", neutral: "neutral-atom", qccd: "trapped-ion" }[platform] + " machine",
    group: "Start from scratch", load: () => ({ track: make(), name: make().controller.board.name, source: { kind: "new", id: platform } }) }));
  if (existsSync(PAPERS))
    for (const f of readdirSync(PAPERS).filter((x) => x.endsWith(".json"))) {
      const id = f.replace(/\.json$/, ""), data = read(new URL(f, PAPERS));
      const rows = (data.rows ?? []).map((r, i) => [r, i]).filter(([r]) => r.track?.device);
      for (const [row, i] of rows.slice(0, 1))
        out.push({ id: "reproduce:" + id, title: data.meta?.title ?? id, group: "Reproduce",
          load: () => ({ track: row.track, name: data.meta?.title ?? id, source: { kind: "reproduction", id, row: i }, design: row.design ?? data.design }) });
    }
  const index = existsSync(new URL("index.json", SITE)) ? read(new URL("index.json", SITE)) : [];
  for (const study of index) {
    const file = new URL(study.id + ".json", SITE);
    if (!existsSync(file)) continue;
    read(file).rows?.forEach((row, i) => {
      if (row.track?.device) out.push({ id: "example:" + study.id + ":" + i, title: study.title + " · " + row.label, group: "Examples",
        load: () => ({ track: row.track, name: row.label, source: { kind: "example", id: study.id, row: i } }) });
    });
  }
  return out;
}

const PLATFORM = { transmon: "superconducting", atoms: "neutral", ions: "qccd", "ions-ring": "qccd" };

export function hwService(path, query) {
  if (path === "/documents")
    return sources().map((s) => {
      const { track } = s.load();
      return { id: s.id, title: s.title, group: s.group, platform: PLATFORM[track.device.kind] ?? track.device.kind, qubits: track.device.sites.length };
    });
  if (path === "/templates") return TEMPLATES;
  if (path === "/document") {
    const row = /^reproduce:([^:]+):(\d+)$/.exec(query.id ?? "");
    if (row) {
      const file = new URL(row[1] + ".json", PAPERS);
      if (!/^[a-z0-9-]+$/.test(row[1]) || !existsSync(file)) throw Object.assign(Error("no reproduction " + row[1]), { status: 404 });
      const data = read(file), r = data.rows?.[Number(row[2])];
      if (!r?.track?.device) throw Object.assign(Error("no run " + row[2] + " with a track in " + row[1]), { status: 404 });
      return documentFromTrack(r.track, { id: query.id, name: data.meta?.title ?? row[1], source: { kind: "reproduction", id: row[1], row: Number(row[2]) }, design: r.design ?? data.design });
    }
    const s = sources().find((x) => x.id === query.id);
    if (!s) throw Object.assign(Error("no hardware document " + query.id), { status: 404 });
    const { track, ...rest } = s.load();
    return documentFromTrack(track, { id: s.id, ...rest });
  }
  throw Object.assign(Error("unknown hardware path " + path), { status: 404 });
}
