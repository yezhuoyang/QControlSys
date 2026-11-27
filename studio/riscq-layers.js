// The layers of a RISC-Q run as the workspace page shows them side by side:
//
//   source program  →  intermediate program (TSIR, QCCD only)  →  hardware instructions  →  RV32I firmware
//
// and the apparatus each step acts on. Everything here is a pure function of a run bundle
// (`/api/riscq/run`, `node riscq/cli.mjs --out`) and of the state riscq-model.js rebuilds from
// its frames. A headless agent gets the same answers as the page:
//
//   import * as layers from "./studio/riscq-layers.js";
//   layers.focusAt(bundle, 120)   // the source lines, hardware instruction and firmware word of step 121
//
// Approximation boundaries are stated where they apply. Two are display choices and not model
// facts: which OpenQASM line an expanded statement came from (`qasmStatements`), and every
// position in `chipLayout`, which is a schematic drawing unless the bundle carries geometry.
import * as model from "./riscq-model.js";
import { listing } from "./riscq-disasm.js";

const cache = new WeakMap();
function memo(bundle, key, build) {
  let entry = cache.get(bundle);
  if (!entry) cache.set(bundle, (entry = {}));
  if (!(key in entry)) entry[key] = build();
  return entry[key];
}
const natural = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });

/** JSON text that may hold Python's bare `Infinity`, `-Infinity` or `NaN` (TSIR from QCCD Studio). They read as null. */
export function parseLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Outside strings only: a token after `:`, `,` or `[`.
    return JSON.parse(text.replace(/("(?:[^"\\]|\\.)*")|([:,[]\s*)-?(?:Infinity|NaN)\b/g, (m, str, lead) => str ?? lead + "null"));
  }
}

// ───────────────────────────── source and intermediate program ─────────────────────────────

/**
 * Statements of an OpenQASM text with the number of operations each expands to, in the order a
 * compiler numbers them: [{ line, text, ops }]. A statement whose operand is a whole register
 * expands to one operation per qubit of that register. `barrier` expands to none.
 * Declarations and headers are not statements. QCCD Studio's `source_op` counts this way.
 * This is a display mapping, checked against the GHZ example in tests/riscq-studio.test.mjs.
 */
export function qasmStatements(text) {
  const sizes = new Map(), out = [];
  text.split("\n").forEach((raw, line) => {
    for (const piece of raw.replace(/\/\/.*$/, "").split(";")) {
      const s = piece.trim();
      if (!s) continue;
      const declared = /^(?:qreg|creg)\s+(\w+)\s*\[(\d+)\]/.exec(s) ?? /^(?:qubit|bit)\s*\[(\d+)\]\s*(\w+)/.exec(s);
      if (declared) {
        const [name, size] = /^(?:qreg|creg)/.test(s) ? [declared[1], declared[2]] : [declared[2], declared[1]];
        sizes.set(name, Number(size));
        continue;
      }
      if (/^(OPENQASM|include|gate\b|opaque\b|qubit\b|bit\b|\}|\{)/.test(s)) continue;
      if (/^barrier\b/.test(s)) {
        out.push({ line, text: s, ops: 0 });
        continue;
      }
      // Quantum operands: the part before `->` of a measure, the whole argument list otherwise.
      const head = s.replace(/^(?:\w+\s*=\s*)/, "").split("->")[0];
      const args = head.replace(/^\s*[\w.]+\s*(\([^)]*\))?/, "").split(",").map((a) => a.trim()).filter(Boolean);
      const widths = args.map((a) => (/\[/.test(a) ? 1 : sizes.get(a) ?? 1));
      out.push({ line, text: s, ops: Math.max(1, ...widths) });
    }
  });
  return out;
}

const brief = (value, limit = 150) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
};

/** One line of a TSIR instruction. */
function tsirLine(i) {
  const who = i.ions ? i.ions.join(",") : i.pairs ? i.pairs.map((p) => p.join("+")).join(" ") : i.participants
    ? i.participants.map((p) => p.ion + " " + p.from + "→" + p.to).join(", ") : i.placement ? brief(i.placement, 90) : "";
  return [String(i.id).padStart(3), i.type + (i.gate ? " " + i.gate : i.class ? " " + i.class : ""), who, i.sites ? "@ " + i.sites.join(",") : ""]
    .filter(Boolean).join("  ");
}

/**
 * The program layers above the hardware instructions:
 * { source: { language, lines, note }, ir: { language, lines, note } | null }.
 * Each `lines` entry is { text, key } where `key` is what a hardware instruction's `source`
 * field names (a line number, an instruction ID or a call index) or null.
 */
export function programLayers(bundle) {
  return memo(bundle, "layers", () => {
    const src = bundle.source ?? {}, language = src.language ?? "unknown language", text = src.text ?? "";
    let source;
    if (/^OpenQASM/.test(language) || /^C \(/.test(language))
      source = { language, lines: text.replace(/\r/g, "").split("\n").map((t, k) => ({ text: t, key: k + 1 })) };
    else if (/^ZAC/.test(language)) {
      const code = parseLoose(text);
      source = { language, note: "One line per ZAC instruction. Locations and gate lists are abbreviated.",
        lines: (code.instructions ?? []).map((i) => {
          const { id, type, ...rest } = i;
          delete rest.locs;
          delete rest.init_locs;
          return { text: String(id).padStart(3) + "  " + type + "  " + brief(rest, 120), key: id };
        }) };
    } else if (language === "System calls") {
      const program = parseLoose(text);
      source = { language, lines: (program.calls ?? []).map((c, k) => {
        const { call, ...rest } = c;
        return { text: String(k).padStart(3) + "  " + call + "  " + brief(rest, 120), key: k };
      }) };
    } else
      source = { language, note: text ? "This source has no per-instruction origin. Its instructions come from QCCD Studio's replay."
        : "The bundle carries no source text for this program.", lines: text.replace(/\r/g, "").split("\n").slice(0, 4000).map((t) => ({ text: t, key: null })) };
    let ir = null;
    if (typeof src.tsir === "string" && src.tsir) {
      const program = parseLoose(src.tsir);
      ir = { language: "TSIR (QCCD Studio)", instructions: program.instructions ?? [],
        note: "Compiled by " + (src.compiler ?? "QCCD Studio") + ". A hardware instruction names its TSIR instruction. A TSIR instruction names its OpenQASM operations in meta.source_op.",
        lines: (program.instructions ?? []).map((i) => ({ text: tsirLine(i), key: i.id })) };
    }
    return { source, ir };
  });
}

/** Lines of `layer` whose key is in `keys`, as indices. */
const linesWith = (layer, keys) => {
  const out = [];
  if (!layer) return out;
  layer.lines.forEach((line, k) => {
    if (line.key !== null && keys.has(line.key)) out.push(k);
  });
  return out;
};

/**
 * Where a hardware instruction comes from: { source: [line index], ir: [line index] }.
 * Origins: "OpenQASM line N", "TSIR instruction N", "ZAC instruction N (…)", "call N · …",
 * "C functions a, b". Anything else has no line.
 */
export function originOf(bundle, op) {
  const none = { source: [], ir: [] };
  if (!op?.source) return none;
  const { source, ir } = programLayers(bundle);
  const text = op.source;
  let m;
  if ((m = /^OpenQASM line (\d+)/.exec(text))) return { source: linesWith(source, new Set([Number(m[1])])), ir: [] };
  if ((m = /^ZAC instruction (\d+)/.exec(text))) return { source: linesWith(source, new Set([Number(m[1])])), ir: [] };
  if ((m = /^call (\d+)/.exec(text))) return { source: linesWith(source, new Set([Number(m[1])])), ir: [] };
  if ((m = /^C functions (.+)$/.exec(text))) {
    const names = m[1].split(/,\s*/);
    const out = [];
    source.lines.forEach((line, k) => {
      // A definition: a type, the name and a parameter list, at the start of a line.
      if (names.some((n) => new RegExp("^[A-Za-z_][\\w\\s*]*\\b" + n + "\\s*\\(").test(line.text) && !/;\s*$/.test(line.text))) out.push(k);
    });
    return { source: out, ir: [] };
  }
  if ((m = /^TSIR instruction (\d+)/.exec(text))) {
    const id = Number(m[1]);
    const irLines = linesWith(ir, new Set([id]));
    if (!ir || !/^OpenQASM/.test(source.language)) return { source: linesWith(source, new Set([id])), ir: irLines };
    const instruction = ir.instructions.find((i) => i.id === id);
    const wanted = instruction?.meta?.source_op ?? [];
    const statements = memo(bundle, "statements", () => qasmStatements(bundle.source.text));
    const lines = new Set();
    let next = 0;
    for (const statement of statements) {
      for (let k = 0; k < statement.ops; k++) if (wanted.includes(next + k)) lines.add(statement.line);
      next += statement.ops;
    }
    return { source: [...lines].sort((a, b) => a - b), ir: irLines };
  }
  return none;
}

// ───────────────────────────── firmware ─────────────────────────────

/** Firmware listing of core `k` (riscq-disasm.js `listing`), or [] when the bundle has no program image. */
export function firmware(bundle, k) {
  return memo(bundle, "fw" + k, () => (bundle.program?.cores?.[k]?.image ? listing(bundle.program.cores[k]) : []));
}

/** Row of a pc in a core's listing, or −1. */
export function firmwareRow(bundle, k, pc) {
  const rows = firmware(bundle, k);
  if (!rows.length || pc === undefined || pc === null) return -1;
  const i = (pc - rows[0].pc) / 4;
  return Number.isInteger(i) && i >= 0 && i < rows.length ? i : -1;
}

/**
 * What step `index` (−1 is reset) is doing at every layer:
 * { frame, op, source: [line], ir: [line], core, pc, row }.
 * `op` is the hardware instruction the frame names, or null for a firmware phase such as
 * "init". `core` is the core the frame belongs to: its own core for a core, link, inbox,
 * channel or pins frame, else the core whose instruction is its cause, else the last core
 * that acted. `pc` is the frame's own pc when it has one, else that core's last traced pc.
 */
export function focusAt(bundle, index, state = model.stateAt(bundle, index)) {
  const frame = bundle.frames[index] ?? null;
  const entry = frame ? model.hardwareOp(bundle, frame.source) : undefined;
  const op = entry?.op ?? null;
  const origin = originOf(bundle, op);
  let core = frame ? model.coreOfPart(bundle, frame.part) : -1;
  if (core < 0 && frame) {
    for (const link of model.causalChain(bundle, frame.id).reverse()) {
      const c = model.coreOfPart(bundle, link.part);
      if (c >= 0) {
        core = c;
        break;
      }
    }
  }
  if (core < 0) core = 0;
  const pc = frame?.pc ?? state.cores[core]?.pc;
  return { frame, op, source: origin.source, ir: origin.ir, core, pc, row: firmwareRow(bundle, core, pc) };
}

/** Rows of core `k`'s listing whose source-map region is hardware instruction `opId`. */
export function firmwareRowsOf(bundle, k, opId) {
  const rows = [];
  firmware(bundle, k).forEach((row, i) => {
    if (row.region === opId) rows.push(i);
  });
  return rows;
}

// ───────────────────────────── views ─────────────────────────────

/**
 * The three views of the workspace. Every part keeps running in every view. A view only
 * decides which parts are drawn:
 *   chip      the apparatus, drawn at its chip layout, and the converters and channels that drive it
 *   control   the controller: host, hub, cores, links, inboxes, channels and converters
 *   machine   everything at its floorplan position
 */
export const VIEWS = {
  chip: { title: "Chip", kinds: ["device", "dac", "adc", "pins", "pulse", "demod", "dio"] },
  control: { title: "Control system", kinds: ["host", "hub", "core", "link", "inbox", "pulse", "demod", "dio", "dac", "adc", "pins"] },
  machine: { title: "Whole machine", kinds: null },
};

/** IDs of the parts drawn in a view. A run without apparatus shows its controller in the chip view. */
export function viewParts(bundle, view) {
  const parts = bundle.system.parts;
  let kinds = VIEWS[view]?.kinds;
  if (view === "chip" && !parts.some((p) => p.kind === "device")) kinds = VIEWS.control.kinds;
  return new Set(parts.filter((p) => !kinds || kinds.includes(p.kind)).map((p) => p.id));
}

// ───────────────────────────── apparatus ─────────────────────────────

/** Binding of a pulse record or open window: program.bindings entry with the same core, channel and slot. */
export function bindingOf(bundle, record) {
  const map = memo(bundle, "bindings", () => new Map((bundle.program?.bindings ?? []).map((b) => [b.core + "/" + b.channel + "/" + b.slot, b])));
  const ref = model.channelInfo(bundle, record.part);
  return ref ? map.get(ref.core + "/" + ref.channel + "/" + record.slot) : undefined;
}

/** Apparatus parts each channel drives, from the bindings: Map(channel part → [device part]). */
export function drivenBy(bundle) {
  return memo(bundle, "driven", () => {
    const out = new Map();
    for (const b of bundle.program?.bindings ?? []) {
      const core = bundle.machine.cores[b.core];
      const part = core && core.name + "." + core.channels[b.channel]?.name;
      if (!part) continue;
      if (!out.has(part)) out.set(part, new Set());
      out.get(part).add(b.part);
    }
    return new Map([...out].map(([k, v]) => [k, [...v]]));
  });
}

/**
 * Apparatus parts driven at this step: Map(device part → [{ window, binding }]) from the
 * windows open at `state.atBatch` and the bindings of the program.
 */
export function activeDevices(bundle, state) {
  const out = new Map();
  for (const window of state.openWindows) {
    const binding = bindingOf(bundle, window);
    if (!binding) continue;
    if (!out.has(binding.part)) out.set(binding.part, []);
    out.get(binding.part).push({ window, binding });
  }
  return out;
}

/** Converter (dac, adc or pins part) of each channel part, from `system.links`. */
export function converterOf(bundle) {
  return memo(bundle, "converter", () => {
    const kinds = new Map(bundle.system.parts.map((p) => [p.id, p.kind]));
    const out = new Map();
    for (const link of bundle.system.links ?? []) {
      const [a, b] = [link.from, link.to];
      if (["pulse", "demod", "dio"].includes(kinds.get(a)) && ["dac", "adc", "pins"].includes(kinds.get(b)) && !out.has(a)) out.set(a, b);
      if (["pulse", "demod", "dio"].includes(kinds.get(b)) && ["dac", "adc", "pins"].includes(kinds.get(a)) && !out.has(b)) out.set(b, a);
    }
    return out;
  });
}

/** QCCD sites and edges named by the hardware instructions: { sites: [name], edges: [[a, b]] }. */
function qccdGraph(bundle) {
  const sites = new Set(), edges = new Map();
  const ops = model.hardwareOps(bundle).map((e) => e.op);
  for (const op of ops) {
    for (const s of op.sites ?? []) sites.add(s);
    for (const mv of op.moves ?? []) {
      sites.add(mv.from);
      sites.add(mv.to);
      const key = [mv.from, mv.to].sort().join("\n");
      edges.set(key, [mv.from, mv.to].sort());
    }
    for (const s of Object.values(op.at ?? {})) if (s) sites.add(s);
  }
  for (const p of bundle.system.parts) {
    const m = /^(?:site|electrodes):(?:zone\.)?(.+)$/.exec(p.id);
    if (m && /^[A-Za-z]+\d/.test(m[1]) && !/\.all\./.test(m[1])) sites.add(m[1]);
  }
  return { sites: [...sites].sort(natural), edges: [...edges.values()] };
}

/** Schematic placement of a site graph: a ring where every site has two neighbours, else a chain per component. Unit spacing. */
function placeGraph(sites, edges) {
  const adj = new Map(sites.map((s) => [s, new Set()]));
  for (const [a, b] of edges) {
    adj.get(a)?.add(b);
    adj.get(b)?.add(a);
  }
  const placed = new Map(), seen = new Set();
  let row = 0;
  for (const start of [...sites].sort((a, b) => adj.get(a).size - adj.get(b).size || natural(a, b))) {
    if (seen.has(start)) continue;
    const order = [], stack = [start];
    while (stack.length) {
      const s = stack.pop();
      if (seen.has(s)) continue;
      seen.add(s);
      order.push(s);
      for (const n of [...adj.get(s)].sort(natural).reverse()) if (!seen.has(n)) stack.push(n);
    }
    const ring = order.length > 2 && order.every((s) => adj.get(s).size === 2);
    order.forEach((s, k) => {
      if (ring) {
        const a = (2 * Math.PI * k) / order.length, r = order.length / (2 * Math.PI);
        placed.set(s, [r * Math.cos(a), row + r + r * Math.sin(a)]);
      } else placed.set(s, [k - (order.length - 1) / 2, row]);
    });
    row += ring ? order.length / Math.PI + 1.5 : 1.5;
  }
  return placed;
}

/**
 * Display layout of the apparatus, the "chip" of the chip view:
 * { platform, unit, note, devices: Map(part → [x, y]), sites?: Map(site → [x, y]),
 *   edges?: [[a, b]], couplers?: [[qubit, qubit, offered]], zones?: [{ id, kind, origin, size }],
 *   tones?: true, focus: [[x, y]] }.
 * Coordinates are in `unit`. `focus` holds the points the view should fit: the sites the program
 * uses, or the atoms. When the bundle carries `machine.geometry` (riscq/geometry.mjs: QCCD
 * Studio's architecture coordinates, the ZAC architecture in µm, the transmon ring) its
 * positions are used and its `basis` is the note. Otherwise every position is schematic.
 */
export function chipLayout(bundle) {
  return memo(bundle, "chip", () => {
    const devices = bundle.system.parts.filter((p) => p.kind === "device").map((p) => p.id);
    const geo = bundle.machine?.geometry;
    const out = { platform: bundle.platform, devices: new Map(), unit: geo?.units?.position ?? "schematic unit", note: geo ? geo.basis + " " + (geo.schematic ?? "") : "" };
    if (bundle.platform === "superconducting") {
      const n = devices.filter((d) => /^qubit\d+$/.test(d)).length;
      const layout = bundle.machine?.layout, design = bundle.machine?.design;
      if (layout?.kind === "hardware-design" && design) {
        // A run on a hardware design: the qubits and resonators at the design's own positions,
        // seen from above. `qubitParts` names the part of each qubit index, as couplers name indices.
        out.types = new Map();
        for (const p of layout.parts) if (p.type === "qubit" || p.type === "resonator") {
          out.devices.set(p.id, p.centerMm.slice(0, 2));
          out.types.set(p.id, p.type);
        }
        out.qubitParts = design.qubits.map((q) => q.part);
        out.couplers = (design.couplings ?? []).map((c) => [...c.qubits, true]);
        out.unit = "mm";
        out.note = layout.basis + " The chip view shows x and y. Schematic: " + layout.schematic;
      } else if (geo?.kind === "transmon-ring") {
        for (const q of geo.qubits) out.devices.set("qubit" + q.id, q.position);
        for (const r of geo.resonators) out.devices.set("resonator" + r.id, r.position);
        out.couplers = geo.couplers.map((c) => [...c.pair, c.offered]);
      } else {
        out.note = "A ring of " + n + " transmons, as the coupling map of the x6y3 calibration states. Positions are schematic, not the chip's layout.";
        const pairs = new Set();
        for (const b of bundle.program?.bindings ?? []) if (b.detail?.pair) pairs.add(b.detail.pair.slice().sort((a, c) => a - c).join("-"));
        out.couplers = [...pairs].map((p) => [...p.split("-").map(Number), true]);
        for (let q = 0; q < n; q++) {
          const a = (2 * Math.PI * q) / n - Math.PI / 2;
          out.devices.set("qubit" + q, [Math.cos(a), Math.sin(a)]);
          out.devices.set("resonator" + q, [1.5 * Math.cos(a), 1.5 * Math.sin(a)]);
        }
      }
      out.focus = [...out.devices.values()];
      return out;
    }
    if (bundle.platform === "qccd") {
      const nodes = geo?.sites ?? geo?.nodes;
      const graph = qccdGraph(bundle);
      let sites;
      if (Array.isArray(nodes) && nodes.length) {
        sites = new Map(nodes.map((n) => [n.id, (n.position ?? n.pos).slice(0, 2)]));
        out.edges = (geo.segments ?? []).map((s) => [s.a, s.b]).filter(([a, b]) => sites.has(a) && sites.has(b));
        // The view fits the sites this program uses. The rest of the architecture extends beyond it.
        out.focus = graph.sites.map((s) => sites.get(s)).filter(Boolean);
      } else {
        sites = placeGraph(graph.sites, graph.edges);
        out.edges = graph.edges;
        out.note = "Sites the program names, joined where an ion moves between them. The bundle carries no architecture coordinates, so the placement is schematic: a ring when every site has two neighbours, else a chain.";
      }
      out.sites = sites;
      if (!out.focus?.length) out.focus = [...sites.values()];
      const xs = out.focus.map((p) => p[0]), ys = out.focus.map((p) => p[1]);
      const box = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const banks = devices.filter((d) => /^electrodes:/.test(d) && !sites.has(d.replace(/^electrodes:(zone\.)?/, "")));
      for (const d of devices) {
        const site = d.replace(/^(?:site|electrodes):(?:zone\.)?/, "");
        if (sites.has(site)) {
          const [x, y] = sites.get(site);
          out.devices.set(d, /^electrodes:/.test(d) ? [x, y + 0.32] : [x, y - 0.32]);
        }
      }
      // Electrode banks that address no single site, and broadcast light, sit along the edges of the trap.
      banks.forEach((d, k) => {
        const t = banks.length > 1 ? k / (banks.length - 1) : 0.5;
        out.devices.set(d, [box[0] - 0.5 + t * (box[1] - box[0] + 1), box[3] + 1.1]);
      });
      devices.filter((d) => !out.devices.has(d)).forEach((d, k) => out.devices.set(d, [box[0] - 1.2, box[2] + k * 0.8]));
      return out;
    }
    if (bundle.platform === "neutral") {
      out.unit = "µm";
      out.tones = true;
      out.note = (geo ? geo.basis + " " : "") + "An atom carried by an AOD is drawn where its column tone crosses its row tone, from the carrier updates of the trace. Atoms are assumed to follow their tones.";
      out.zones = geo?.zones ?? [];
      out.focus = [...atomPositions(bundle, -1), ...atomPositions(bundle, Infinity)].map((a) => a.at);
      const xs = out.focus.map((p) => p[0]), ys = out.focus.map((p) => p[1]);
      const [x0, x1] = xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 100], [y0, y1] = ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 100];
      devices.filter((d) => /^beam:/.test(d)).forEach((d, k) => out.devices.set(d, [x0 - 0.1 * (x1 - x0) - 2, y0 + (k + 0.5) * 0.3 * (y1 - y0)]));
      return out;
    }
    devices.forEach((d, k) => out.devices.set(d, [k, 0]));
    return out;
  });
}

/**
 * Ions at a batch for the chip view: [{ ion, site, at: [x, y] | null, moving }]. A moving ion is
 * placed on the straight line between its sites at the fraction of the move's window that has
 * passed. That path is a display interpolation. Studio's waypoints are not drawn.
 */
export function ionPositions(bundle, atBatch) {
  const layout = chipLayout(bundle);
  const view = model.ionsAt(bundle, atBatch);
  const records = memo(bundle, "ionRecords", () => new Map((bundle.derived?.ionMoves ?? []).map((r) => [r.op, r])));
  return view.ions.map((ion) => {
    const here = ion.site !== null ? layout.sites?.get(ion.site) : null;
    if (!ion.moving) return { ion: ion.ion, site: ion.site, at: here ?? null, moving: null };
    const a = layout.sites?.get(ion.moving.from), b = layout.sites?.get(ion.moving.to), r = records.get(ion.moving.op);
    const f = r && r.closes > r.opens ? Math.min(1, Math.max(0, (atBatch - r.opens) / (r.closes - r.opens))) : 0;
    return { ion: ion.ion, site: ion.site, moving: ion.moving, fraction: f, at: a && b ? [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] : here ?? null };
  });
}

/**
 * Rearrangement jobs of a neutral-atom run: [{ aod, atoms: [{ atom, from, to, x, y }], opens, closes }].
 * `x` and `y` are the tone channel parts that carry the atom. A job runs from the first window of
 * its pickup to the last window of its drop.
 */
export function atomJobs(bundle) {
  return memo(bundle, "atomJobs", () => {
    const windows = new Map();
    for (const r of bundle.summary?.pulses ?? []) {
      if (r.closes === undefined) continue;
      const w = windows.get(r.source) ?? [Infinity, -Infinity];
      windows.set(r.source, [Math.min(w[0], r.opens), Math.max(w[1], r.closes)]);
    }
    const ops = model.hardwareOps(bundle).map((e) => e.op), jobs = [];
    ops.forEach((op, k) => {
      if (op.op !== "move") return;
      const pickup = [...ops.slice(0, k)].reverse().find((o) => o.op === "pickup" && o.aod === op.aod);
      const drop = ops.slice(k + 1).find((o) => o.op === "drop" && o.aod === op.aod);
      const core = bundle.machine.cores.find((c) => c.name === "aod" + op.aod)?.name ?? "aod" + op.aod;
      const atoms = (op.atoms ?? []).map((a) => {
        const col = (op.cols ?? []).find((c) => c.from === a.from[0]), row = (op.rows ?? []).find((r) => r.from === a.from[1]);
        return { atom: a.atom, from: a.from, to: a.to, x: col ? core + ".x" + col.id : null, y: row ? core + ".y" + row.id : null };
      });
      const span = [pickup, op, drop].filter(Boolean).map((o) => windows.get(o.id)).filter(Boolean);
      if (!span.length) return;
      jobs.push({ aod: op.aod, move: op.id, atoms, opens: Math.min(...span.map((w) => w[0])), closes: Math.max(...span.map((w) => w[1])) });
    });
    return jobs;
  });
}

/**
 * Atoms at a batch: [{ atom, at: [x µm, y µm], carried, job }]. An atom starts at its trap of
 * the ZAC `init` instruction when the bundle's geometry names it (riscq/geometry.mjs), else at
 * the `from` of its first job. While a job runs it is at the crossing of its two tones. After,
 * at `to`. Without geometry, an atom that no job moves is not drawn.
 */
export function atomPositions(bundle, atBatch) {
  const tones = new Map(model.tonesAt(bundle, atBatch).map((t) => [t.part, t.um]));
  const atoms = new Map();
  for (const a of bundle.machine?.geometry?.atoms ?? []) atoms.set(a.id, { atom: a.id, at: a.position.slice(0, 2), carried: false, job: null });
  for (const job of atomJobs(bundle))
    for (const a of job.atoms) {
      const prev = atoms.get(a.atom);
      if (job.closes <= atBatch) atoms.set(a.atom, { atom: a.atom, at: a.to, carried: false, job: job.move });
      else if (job.opens <= atBatch) {
        const x = tones.get(a.x), y = tones.get(a.y);
        atoms.set(a.atom, { atom: a.atom, at: [x ?? a.from[0], y ?? a.from[1]], carried: true, job: job.move });
      } else if (!prev) atoms.set(a.atom, { atom: a.atom, at: a.from, carried: false, job: null });
    }
  return [...atoms.values()].sort((a, b) => a.atom - b.atom);
}
