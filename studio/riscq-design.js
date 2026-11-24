// RISC-Q hardware design editor. The document being edited is a `riscq-design` (riscq/design.mjs):
// parts with positions in mm, the channels of each control core, routed wires and the calibrated
// qubits and couplers. Edits go through studio/riscq-design-doc.js. The server checks every
// version against the rules of riscq/design.mjs and returns each wire's delay and each calibrated
// pulse's arrival delay. "Run" hands the document and the program to the debugger, which runs
// them through the same `run` as `node riscq/cli.mjs --design file.json --qasm program.qasm`.
import * as D from "/riscq-design-doc.js";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node[k] = v;
    else if (k === "value") node.value = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
  return node;
}
function sv(tag, attrs = {}, ...kids) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid) node.append(kid);
  return node;
}
const put = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const fmt = (v, digits = 3) => (Number.isFinite(v) ? String(Number(v.toFixed(digits))) : "—");
const ns = (ps) => (Number.isFinite(ps) ? fmt(ps / 1000, 3) + " ns" : "—");
const mm = (v) => (Math.abs(v) >= 1000 ? fmt(v / 1000, 3) + " m" : fmt(v, 2) + " mm");
const GHz = (hz) => fmt(hz / 1e9, 6) + " GHz";

// ───────────────────────────── state ─────────────────────────────
let doc, qasm = "", template = "chain3";
let rules = { components: {}, media: D.SPEEDS, toleranceMm: 0.5 };
let verdict = { errors: [], warnings: [], wires: [], pulses: [] }, checked = false, checkToken = 0, checkTimer = 0;
let badIds = new Set();
let selection = null; // { kind: "part" | "wire", id, point? }
let hovered = null;
let undoStack = [], redoStack = [];
let proj = "plan";
let cam = { u: 0, v: 0, s: 1 };
let tool = "select", placing = null, wireFrom = null, ghostAt = null;
const STORE = "riscq-design:current", RUN = "riscq-design:run", EDIT = "riscq-design:edit";

const TYPE_ORDER = ["control-board", "core", "dac", "adc", "stage", "qubit", "resonator"];
const TYPE_NAME = { "control-board": "Control board", core: "Core", dac: "DAC", adc: "ADC", stage: "Stage", qubit: "Qubit", resonator: "Resonator" };

// ───────────────────────────── projection ─────────────────────────────
const C30 = Math.cos(Math.PI / 6), S30 = 0.5;
const PROJ = {
  plan: { axes: [0, 1], name: "x–y", project: ([x, y]) => [x, y] },
  side: { axes: [0, 2], name: "x–z", project: ([x, , z]) => [x, z] },
  front: { axes: [1, 2], name: "y–z", project: ([, y, z]) => [y, z] },
  iso: { axes: [0, 1], name: "3D", project: ([x, y, z]) => [(x - y) * C30, (x + y) * S30 + z] },
};
const size = () => ({ w: $("canvas").clientWidth || 800, h: $("canvas").clientHeight || 500 });
function toScreen(p) {
  const [u, v] = PROJ[proj].project(p), { w, h } = size();
  return [w / 2 + (u - cam.u) * cam.s, h / 2 - (v - cam.v) * cam.s];
}
/** The world displacement in mm of a screen drag, in the two axes the projection edits. */
function dragDelta(dx, dy) {
  const du = dx / cam.s, dv = -dy / cam.s, d = [0, 0, 0];
  if (proj === "iso") {
    d[0] = (du / C30 + dv / S30) / 2;
    d[1] = (dv / S30 - du / C30) / 2;
  } else {
    const [a, b] = PROJ[proj].axes;
    d[a] = du;
    d[b] = dv;
  }
  return d;
}
/** The world point under a screen point. The axis the projection hides comes from `depth`. */
function fromScreen(sx, sy, depth) {
  const { w, h } = size();
  const u = (sx - w / 2) / cam.s + cam.u, v = -(sy - h / 2) / cam.s + cam.v;
  const p = depth.slice();
  if (proj === "iso") {
    const a = u / C30, b = (v - p[2]) / S30;
    p[0] = (a + b) / 2;
    p[1] = (b - a) / 2;
  } else {
    const [i, j] = PROJ[proj].axes;
    p[i] = u;
    p[j] = v;
  }
  return p;
}
function niceStep(target) {
  const p = 10 ** Math.floor(Math.log10(target)), m = target / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
const gridStep = () => niceStep(90 / cam.s) / 5;
function fit(points) {
  if (!points.length) return;
  const uv = points.map((p) => PROJ[proj].project(p));
  const us = uv.map((p) => p[0]), vs = uv.map((p) => p[1]);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const { w, h } = size();
  cam = { u: (u0 + u1) / 2, v: (v0 + v1) / 2, s: Math.min((w - 120) / Math.max(u1 - u0, 1e-3), (h - 90) / Math.max(v1 - v0, 1e-3), 4000) };
}
const chipParts = () => doc.parts.filter((p) => p.type === "qubit" || p.type === "resonator");
const controlParts = () => doc.parts.filter((p) => ["control-board", "core", "dac", "adc"].includes(p.type));
function fitTo(what) {
  const pts = what === "chip" ? chipParts().map((p) => p.centerMm) : what === "control" ? controlParts().map((p) => p.centerMm)
    : [...doc.parts.map((p) => p.centerMm), ...doc.wires.flatMap((w) => w.routeMm)];
  fit(pts.length ? pts : doc.parts.map((p) => p.centerMm));
  render();
}

// ───────────────────────────── glyphs ─────────────────────────────
const COLORS = { "control-board": "#2e6b4f", core: "#1f3a5f", dac: "#f2a36b", adc: "#78c2de", stage: "#c4cdc9", qubit: "#e3b23c", resonator: "#4f8fd1" };
function glyph(type, x, y) {
  const g = sv("g", { class: "glyph", transform: "translate(" + x.toFixed(1) + " " + y.toFixed(1) + ")" });
  const f = COLORS[type];
  if (type === "control-board") g.append(sv("rect", { x: -15, y: -10, width: 30, height: 20, rx: 3, fill: f }), sv("rect", { x: -6, y: -5, width: 12, height: 10, fill: "#d8c27a", stroke: "none" }));
  else if (type === "core") g.append(sv("rect", { x: -7, y: -7, width: 14, height: 14, rx: 2, fill: f }),
    ...[-4, 0, 4].flatMap((k) => [sv("line", { x1: k, y1: -10, x2: k, y2: -7 }), sv("line", { x1: k, y1: 7, x2: k, y2: 10 })]));
  else if (type === "dac") g.append(sv("path", { d: "M-6 -7 L7 0 L-6 7 Z", fill: f }));
  else if (type === "adc") g.append(sv("path", { d: "M6 -7 L-7 0 L6 7 Z", fill: f }));
  else if (type === "stage") g.append(sv("rect", { x: -3, y: -9, width: 6, height: 18, rx: 1, fill: f }));
  else if (type === "qubit") g.append(sv("path", { d: "M-2.5 -9 H2.5 V-2.5 H9 V2.5 H2.5 V9 H-2.5 V2.5 H-9 V-2.5 H-2.5 Z", fill: f }));
  else if (type === "resonator") g.append(sv("path", { d: "M-8 0 L-6 -5 L-3 5 L0 -5 L3 5 L6 -5 L8 0", fill: "none", stroke: f, "stroke-width": 2 }));
  else g.append(sv("circle", { r: 6, fill: "#999" }));
  return g;
}
const RING = { "control-board": 19, core: 12, stage: 11, qubit: 12, resonator: 11 };
function paletteIcon(type) {
  const s = sv("svg", { viewBox: "-11 -11 22 22" });
  const g = glyph(type, 0, 0);
  g.setAttribute("transform", type === "control-board" ? "scale(0.65)" : "");
  s.append(g);
  return s;
}

// ───────────────────────────── rendering ─────────────────────────────
const svg = $("svg");
function render() {
  if (!doc) return;
  const { w, h } = size();
  svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  const layers = { grid: sv("g", { class: "grid" }), chip: sv("g"), wires: sv("g"), parts: sv("g"), handles: sv("g"), labels: sv("g"), ghost: sv("g") };
  // Grid in the projection's two axes. The isometric view has none.
  if (proj !== "iso") {
    const step = gridStep(), major = step * 5;
    const [u0, v1] = [cam.u - w / 2 / cam.s, cam.v + h / 2 / cam.s], [u1, v0] = [cam.u + w / 2 / cam.s, cam.v - h / 2 / cam.s];
    const sx = (u) => w / 2 + (u - cam.u) * cam.s, sy = (v) => h / 2 - (v - cam.v) * cam.s;
    if (step * cam.s >= 7)
      for (let u = Math.ceil(u0 / step) * step; u <= u1; u += step) layers.grid.append(sv("line", { x1: sx(u), x2: sx(u), y1: 0, y2: h, class: Math.abs(u) < step / 2 ? "axis" : Math.abs(u / major - Math.round(u / major)) < 1e-6 ? "major" : "" }));
    if (step * cam.s >= 7)
      for (let v = Math.ceil(v0 / step) * step; v <= v1; v += step) layers.grid.append(sv("line", { y1: sy(v), y2: sy(v), x1: 0, x2: w, class: Math.abs(v) < step / 2 ? "axis" : Math.abs(v / major - Math.round(v / major)) < 1e-6 ? "major" : "" }));
    const bar = niceStep(120 / cam.s);
    put($("scalebar"), el("i", { style: "width:" + (bar * cam.s).toFixed(1) + "px" }), mm(bar) + " · " + PROJ[proj].name);
  } else put($("scalebar"), "isometric · lengths along each axis are drawn alike");
  // The chip: an outline around the qubits and resonators, schematic, as the document has no die.
  const chip = chipParts();
  if (chip.length) {
    const pts = chip.map((p) => toScreen(p.centerMm));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    layers.chip.append(sv("rect", { x: Math.min(...xs) - 18, y: Math.min(...ys) - 18, width: Math.max(...xs) - Math.min(...xs) + 36, height: Math.max(...ys) - Math.min(...ys) + 36,
      rx: 6, fill: "#eef3f6", stroke: "#b8c8d2", "stroke-dasharray": "4 3", "data-hover": "chip" }));
  }
  // Wires.
  const linked = linkedIds();
  for (const w0 of doc.wires) {
    if (!Array.isArray(w0.routeMm) || w0.routeMm.length < 2) continue;
    const pts = w0.routeMm.map(toScreen).map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ");
    const cls = ["wire", w0.medium, selection?.kind === "wire" && selection.id === w0.id ? "selected" : "", badIds.has(w0.id) ? "bad" : "", hovered === w0.id || linked.has(w0.id) ? "hover" : ""].join(" ");
    layers.wires.append(sv("polyline", { points: pts, class: cls }), sv("polyline", { points: pts, class: "wirehit", "data-wire": w0.id }));
  }
  // Parts, drawn chip last so qubits sit above the board.
  const order = [...doc.parts].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
  const screen = new Map();
  for (const p of order) {
    if (!Array.isArray(p.centerMm)) continue;
    const [x, y] = toScreen(p.centerMm);
    screen.set(p.id, [x, y]);
    const cls = ["part", selection?.kind === "part" && selection.id === p.id ? "selected" : "", badIds.has(p.id) ? "bad" : "", wireFrom === p.id ? "wirefrom" : "", linked.has(p.id) ? "linked" : ""].join(" ");
    const g = sv("g", { class: cls, "data-part": p.id });
    g.append(sv("circle", { class: "ring", cx: x, cy: y, r: RING[p.type] ?? 10, fill: "transparent" }), glyph(p.type, x, y));
    layers.parts.append(g);
  }
  // Labels: greedy, so that crowded parts at a small scale do not print over one another.
  const boxes = [];
  const priority = (p) => (selection?.id === p.id || hovered === p.id ? -1 : ["qubit", "core", "control-board", "dac", "adc", "resonator", "stage"].indexOf(p.type));
  for (const p of [...doc.parts].filter((p) => screen.has(p.id)).sort((a, b) => priority(a) - priority(b))) {
    const [x, y] = screen.get(p.id), width = p.id.length * 6.4 + 4, box = [x + 11, y - 3, x + 11 + width, y + 10];
    if (priority(p) >= 0 && boxes.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) continue;
    boxes.push(box);
    layers.labels.append(sv("text", { class: "plabel", x: x + 12, y: y + 7 }, document.createTextNode(p.id)));
  }
  // Waypoint handles of the selected wire.
  if (selection?.kind === "wire") {
    const w0 = D.wire(doc, selection.id);
    w0?.routeMm.forEach((p, k) => {
      const [x, y] = toScreen(p), end = k === 0 || k === w0.routeMm.length - 1;
      layers.handles.append(sv("circle", { class: "handle" + (end ? " end" : ""), cx: x, cy: y, r: selection.point === k ? 6 : 4.5, "data-point": end ? undefined : k }));
    });
  }
  if (tool === "wire" && wireFrom && ghostAt) {
    const [x, y] = screen.get(wireFrom) ?? [0, 0];
    layers.ghost.append(sv("line", { class: "ghost", x1: x, y1: y, x2: ghostAt[0], y2: ghostAt[1] }));
  }
  svg.replaceChildren(...Object.values(layers));
}

/** Parts and wires related to the hovered or selected item: a core's converters and their wires, a qubit's lines. */
function linkedIds() {
  const out = new Set(), id = hovered ?? (selection?.kind === "part" ? selection.id : null);
  if (!id || !doc) return out;
  const p = D.part(doc, id);
  if (!p) return out;
  if (p.type === "core") for (const c of D.channelsOf(doc, id)) if (c.converter) {
    out.add(c.converter);
    for (const w of D.wiresAt(doc, c.converter)) out.add(w.id);
  }
  if (p.type === "dac" || p.type === "adc") {
    for (const c of D.channelsUsing(doc, id)) out.add(c.core);
    for (const w of D.wiresAt(doc, id)) out.add(w.id);
  }
  const q = D.qubitOf(doc, id);
  if (q >= 0) {
    const entry = doc.qubits[q];
    for (const role of ["gate", "ro", "demod"]) {
      const c = D.channel(doc, entry[role]);
      if (c) out.add(c.core).add(c.converter);
    }
    for (const w of [...D.wiresAt(doc, entry.part), ...D.wiresAt(doc, entry.resonator)]) out.add(w.id);
    out.add(entry.part).add(entry.resonator);
  }
  out.delete(id);
  return out;
}

// ───────────────────────────── edits and history ─────────────────────────────
function edit(change, { keepSelection = true } = {}) {
  const before = JSON.stringify(doc);
  change(doc);
  if (JSON.stringify(doc) === before) return refresh(false);
  undoStack.push(before);
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
  if (!keepSelection) selection = null;
  refresh(true);
}
function commitFrom(before) {
  if (JSON.stringify(doc) === before) return;
  undoStack.push(before);
  redoStack = [];
  refresh(true);
}
function replaceDoc(next, how) {
  if (doc) undoStack.push(JSON.stringify(doc));
  redoStack = [];
  doc = next;
  selection = null;
  refresh(true);
  if (how !== "keepView") fitTo("all");
}
function step(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(doc));
  doc = JSON.parse(from.pop());
  if (selection && !(selection.kind === "part" ? D.part(doc, selection.id) : D.wire(doc, selection.id))) selection = null;
  refresh(true);
}
function refresh(changed) {
  $("undo").disabled = !undoStack.length;
  $("redo").disabled = !redoStack.length;
  render();
  paintOutline();
  paintInspector();
  paintMetrics();
  $("docText").textContent = JSON.stringify(doc, (k, v) => (Array.isArray(v) && v.length > 16 && v.every(Number.isFinite) ? "[" + v.length + " samples]" : v), 1);
  if (changed) {
    save();
    scheduleCheck();
  }
}
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ design: doc, qasm, template }));
  } catch {
    /* Storage may be unavailable. The design stays in the page. */
  }
}

// ───────────────────────────── rule check ─────────────────────────────
function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, 180);
}
async function runCheck() {
  const mine = ++checkToken;
  try {
    const response = await fetch("/api/riscq/design/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
    const text = await response.text();
    if (mine !== checkToken) return;
    if (!response.ok) throw Error(text);
    verdict = JSON.parse(text);
    checked = true;
    alertBox("");
  } catch (error) {
    if (mine !== checkToken) return;
    verdict = { errors: ["The server could not check the design: " + error.message], warnings: [], wires: [], pulses: [] };
  }
  badIds = new Set(verdict.errors.flatMap((m) => D.idsIn(doc, m).map((x) => x.id)));
  render();
  paintRules();
  paintTiming();
  paintMetrics();
  paintOutline();
  paintInspector();
}
function alertBox(message) {
  $("alert").textContent = message;
  $("alert").hidden = !message;
}

function idChips(message) {
  return el("span", { class: "chips" }, D.idsIn(doc, message).map(({ id, kind }) => el("button", { text: id, title: "Select " + id, onclick: () => select(kind === "channel" ? { kind: "part", id: D.channel(doc, id).core } : { kind, id }) })));
}
function paintRules() {
  const { errors, warnings } = verdict;
  $("ruleCount").textContent = errors.length ? errors.length + (errors.length === 1 ? " error" : " errors") : warnings.length ? warnings.length + " warn" : "✓";
  $("ruleCount").className = errors.length ? "bad" : "";
  const row = (kind, message) => el("div", { class: "rule " + kind }, el("b", { text: kind }), el("span", { text: message }), kind === "ok" ? null : idChips(message));
  put($("rules"),
    !checked ? el("p", { class: "hint", text: "Checking the design…" }) : null,
    errors.map((m) => row("error", m)),
    warnings.map((m) => row("warning", m)),
    checked && !errors.length ? row("ok", "The design obeys every rule of riscq/design.mjs. " + verdict.pulses.length + " calibrated pulses are bound to channels, each with the delay of its wired path (Signal timing). Run it to see the firmware play them.") : null,
    el("p", { class: "hint", text: "Rules: one control board; 1 to 64 cores, each with 1 to 16 channels of distinct names; a pulse channel names a DAC and a demod channel an ADC; every DAC and ADC has its own index 0–63; each wire starts and ends within " + rules.toleranceMm + " mm of the parts it joins; every qubit has a wired path from its drive DAC, from its readout DAC to its resonator, and from the resonator back to its ADC; a coupler pulse has a wired path to its qubit. A warning names a consequence: an acquisition window that opens before the readout tone can have returned." }));
}
function paintTiming() {
  const wires = new Map(verdict.wires.map((w) => [w.id, w]));
  put($("timing"),
    el("p", { class: "hint", text: "Delay = routed length ÷ signal speed of the medium (machine/interconnect.mjs: " + Object.entries(rules.media).map(([k, v]) => k + " " + fmt(v, 2) + " mm/ns").join(", ") + "), rounded up to a ps. A pulse's delay is that of the fastest wired path from its converter, through stages, to the part it acts on. Loss, dispersion and crosstalk are not modeled." }),
    el("div", { class: "cols" },
      el("div", {}, el("h4", { text: "Calibrated pulses" }),
        verdict.pulses.length ? el("table", {}, el("tr", {}, ["pulse", "channel", "ends at", "delay"].map((t, k) => el("th", { text: t, class: k === 3 ? "num" : "" }))),
          verdict.pulses.map((p) => el("tr", { onclick: () => select({ kind: "part", id: p.part }) }, el("td", { text: p.id }), el("td", { text: p.core + "." + p.channel }), el("td", { text: p.part }), el("td", { class: "num", text: p.kind === "acquire" ? "—" : ns(p.delayPs) }))))
          : el("p", { class: "hint", text: "Pulses are listed once the design obeys every rule." })),
      el("div", {}, el("h4", { text: "Wires" }),
        el("table", {}, el("tr", {}, ["wire", "from → to", "medium", "length", "delay"].map((t, k) => el("th", { text: t, class: k > 2 ? "num" : "" }))),
          doc.wires.map((w) => el("tr", { onclick: () => select({ kind: "wire", id: w.id }) }, el("td", { text: w.id }), el("td", { text: w.from + " → " + w.to }), el("td", { text: w.medium }),
            el("td", { class: "num", text: mm(wires.get(w.id)?.lengthMm ?? D.routeLength(w.routeMm)) }), el("td", { class: "num", text: ns(wires.get(w.id)?.delayPs ?? D.wireDelayPs(w, rules.media)) })))))));
}
function paintMetrics() {
  const s = D.summary(doc, rules.media);
  const status = !checked ? ["rules", "…", ""] : verdict.errors.length ? ["rules", verdict.errors.length + " broken", "bad"] : ["rules", verdict.warnings.length ? "ok, " + verdict.warnings.length + " warn" : "ok", "ok"];
  put($("metrics"), [["qubits", s.qubits], ["cores", s.cores], ["converters", s.converters], ["channels", s.channels], ["wires", s.wires],
    ["coax", mm(s.byMedium.coax ?? 0)], ["longest", s.longest ? ns(s.longest.delayPs) : "—"], status].map(([k, v, c]) =>
    el("span", { class: "m " + (c ?? ""), title: k === "longest" && s.longest ? "Wire " + s.longest.id + ": " + mm(s.longest.lengthMm) : "" }, k, el("b", { text: String(v) }))));
  $("runIt").disabled = !checked || verdict.errors.length > 0;
  $("runIt").title = verdict.errors.length ? "The design breaks " + verdict.errors.length + " rule(s). See Rules." : "Compile the program for this hardware, run the firmware in the Lean model, and open the run in the debugger";
}

// ───────────────────────────── outline ─────────────────────────────
function paintOutline() {
  const group = (title, items, open = true) => el("details", { open }, el("summary", { text: title + " (" + items.length + ")" }), items);
  const item = (sel, label, extra) => el("button", {
    "aria-current": String(selection?.kind === sel.kind && selection.id === sel.id), class: badIds.has(sel.id) ? "bad" : "",
    onclick: () => select(sel, true), onmouseenter: () => setHover(sel.id), onmouseleave: () => setHover(null),
  }, label, extra ? el("span", { class: "muted", text: " " + extra }) : null);
  const ofType = (type) => doc.parts.filter((p) => p.type === type);
  put($("outline"),
    group("Board and cores", [...ofType("control-board"), ...ofType("core")].map((p) => item({ kind: "part", id: p.id }, p.id, p.type === "core" ? D.channelsOf(doc, p.id).length + " ch" + (doc.decoder === p.id ? " · decoder" : "") : "board"))),
    group("Converters", [...ofType("dac"), ...ofType("adc")].map((p) => item({ kind: "part", id: p.id }, p.id, p.type + " " + p.index))),
    group("Qubits", doc.qubits.map((q, i) => item({ kind: "part", id: q.part }, "q[" + i + "] " + q.part, GHz(q.freqHz ?? NaN)))),
    group("Chip parts", [...ofType("resonator"), ...ofType("stage")].map((p) => item({ kind: "part", id: p.id }, p.id, p.type)), false),
    group("Wires", doc.wires.map((w) => item({ kind: "wire", id: w.id }, w.id, w.medium)), false));
}

// ───────────────────────────── inspector ─────────────────────────────
let focusKey = null;
// A number is shown to 12 significant digits, so that 656.6700000000001 reads 656.67. The
// document keeps its value until the field is edited.
const shown = (v) => (typeof v === "number" && Number.isFinite(v) ? String(Number(v.toPrecision(12))) : v ?? "");
function field(key, label, value, commit, { unit, step = "any", type = "number", options, readonly } = {}) {
  let input;
  if (options) {
    input = el("select", { "data-key": key, disabled: readonly }, options.map(([v, t]) => el("option", { value: v, text: t ?? v })));
    input.value = value ?? "";
  } else input = el("input", { type, step: type === "number" ? step : undefined, value: shown(value), "data-key": key, readonly });
  input.onchange = () => {
    focusKey = key;
    const raw = input.value;
    const v = options || type !== "number" ? raw : Number(raw);
    if (type === "number" && !options && (raw.trim() === "" || !Number.isFinite(v))) return input.classList.add("invalid");
    commit(v);
  };
  return [el("label", { text: label, title: key }), el("div", { class: "cell" }, input, unit ? el("span", { class: "unit", text: unit }) : null)];
}
function xyz(key, label, point, commit) {
  const inputs = [0, 1, 2].map((k) => {
    const input = el("input", { type: "number", step: "any", value: shown(point[k]), "data-key": key + k, title: "xyz"[k] + " in mm" });
    input.onchange = () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return input.classList.add("invalid");
      focusKey = key + k;
      commit(point.map((old, i) => (i === k ? v : old)));
    };
    return input;
  });
  return [el("label", { text: label }), el("div", { class: "cell" }, el("div", { class: "xyz" }, inputs), el("span", { class: "unit", text: "mm" }))];
}
function paintInspector() {
  const host = $("inspector");
  $("remove").disabled = !selection;
  const content = selection?.kind === "wire" ? wireInspector(D.wire(doc, selection.id)) : selection?.kind === "part" && D.part(doc, selection.id) ? partInspector(D.part(doc, selection.id)) : designInspector();
  put(host, content);
  if (focusKey) {
    const again = host.querySelector('[data-key="' + CSS.escape(focusKey) + '"]');
    if (again) again.focus();
    focusKey = null;
  }
}
function boardForm() {
  const b = doc.board ?? {};
  const set = (k) => (v) => edit((d) => ((d.board ??= {})[k] = v));
  return el("div", { class: "form" },
    field("board.dspHz", "DSP clock", b.dspHz / 1e6, (v) => edit((d) => ((d.board ??= {}).dspHz = v * 1e6)), { unit: "MHz" }),
    field("board.linkStages", "Link stages", b.linkStages, set("linkStages"), { step: 1 }),
    field("board.memWords", "Core memory", b.memWords, set("memWords"), { step: 1, unit: "words" }),
    field("board.queueDepth", "Queue depth", b.queueDepth, set("queueDepth"), { step: 1 }),
    field("board.envDepth", "Envelope memory", b.envDepth, set("envDepth"), { step: 1, unit: "samples" }),
    field("decoder", "Decoder core", doc.decoder ?? "", (v) => edit((d) => (v ? (d.decoder = v) : delete d.decoder)),
      { options: [["", "none"], ...doc.parts.filter((p) => p.type === "core").map((p) => [p.id])] }));
}
function designInspector() {
  return [
    el("div", { class: "title", text: doc.name || "Hardware design" }),
    el("p", { class: "what", text: "A machine as a document: parts with positions in mm, the channels of each control core, and routed wires. The simulator derives the RISC-Q build from the cores and channels, the pulse tables from the calibrated qubits and couplers, and every wire's delay from its routed length." }),
    el("div", { class: "form" }, field("name", "Name", doc.name, (v) => edit((d) => (d.name = v)), { type: "text" })),
    el("h4", { text: "Board" }), boardForm(),
    el("p", { class: "note", text: "Select a part or a wire on the canvas or in the outline to edit it. Drag parts to move them, drag the white handles of a selected wire to reroute it, double-click a wire to add a bend." }),
  ];
}
function wireList(id) {
  const timing = new Map(verdict.wires.map((w) => [w.id, w]));
  return el("div", { class: "chips" }, D.wiresAt(doc, id).map((w) => el("button", { text: w.id + " · " + ns(timing.get(w.id)?.delayPs ?? D.wireDelayPs(w, rules.media)), onclick: () => select({ kind: "wire", id: w.id }) })));
}
function partInspector(p) {
  const out = [
    el("div", { class: "title" }, p.id, el("small", { text: TYPE_NAME[p.type] ?? p.type })),
    el("p", { class: "what", text: rules.components[p.type] ?? "" }),
    el("div", { class: "form" },
      field("id", "Id", p.id, (v) => {
        let ok = true;
        edit((d) => (ok = D.renamePart(d, p.id, v.trim())));
        if (ok) select({ kind: "part", id: v.trim() });
        else alertBox("The id " + v + " is taken by another part, channel or wire.");
      }, { type: "text" }),
      xyz("pos", "Position", p.centerMm, (v) => edit((d) => D.movePart(d, p.id, v))),
      p.type === "dac" || p.type === "adc" ? field("index", "Index", p.index, (v) => edit((d) => (D.part(d, p.id).index = v)), { step: 1 }) : null),
  ];
  if (p.type === "control-board") out.push(el("h4", { text: "Board" }), boardForm());
  if (p.type === "core") out.push(...coreSection(p));
  if (p.type === "dac" || p.type === "adc") {
    const users = D.channelsUsing(doc, p.id);
    out.push(el("h4", { text: "Channels on this " + p.type.toUpperCase() }),
      users.length ? el("div", { class: "chips" }, users.map((c) => el("button", { text: c.id, onclick: () => select({ kind: "part", id: c.core }) })))
        : el("p", { class: "note", text: "No channel names this converter." }),
      p.type === "dac" && users.length > 1 ? el("p", { class: "note", text: "Pulse channels that name one DAC are summed into its output (riscq/design.mjs)." }) : null);
  }
  const q = D.qubitOf(doc, p.id);
  if (q >= 0) out.push(...qubitSection(q));
  out.push(el("h4", { text: "Wires" }), D.wiresAt(doc, p.id).length ? wireList(p.id) : el("p", { class: "note", text: "No wire ends here." }),
    el("div", { class: "row-buttons" }, el("button", { text: "Start a wire here", onclick: () => {
      setTool("wire");
      wireFrom = p.id;
      render();
    } })));
  return out;
}
function coreSection(p) {
  const chans = D.channelsOf(doc, p.id);
  const converters = (kind) => doc.parts.filter((x) => x.type === { pulse: "dac", demod: "adc" }[kind]).map((x) => [x.id]);
  const setCh = (id, k) => (v) => edit((d) => (D.channel(d, id)[k] = v));
  return [
    el("h4", { text: "Channels (" + chans.length + " of 16)" }),
    el("table", {}, el("tr", {}, ["name", "kind", "converter", "slots", "interp", ""].map((t) => el("th", { text: t }))),
      chans.map((c) => {
        const cell = (k, opts) => el("td", {}, field(c.id + "." + k, k, c[k], setCh(c.id, k), opts)[1].firstChild);
        return el("tr", { title: c.id },
          cell("name", { type: "text" }),
          cell("kind", { options: [["pulse"], ["demod"], ["dio"]] }),
          c.kind === "dio" ? el("td", { class: "muted", text: "—" }) : cell("converter", { options: [["", "none"], ...converters(c.kind)] }),
          cell("slots", { step: 1 }), cell("interp", { step: 1 }),
          el("td", { class: "x" }, el("button", { text: "×", title: "Remove channel " + c.id, onclick: () => edit((d) => D.removeChannel(d, c.id)) })));
      })),
    el("div", { class: "row-buttons" }, ["pulse", "demod", "dio"].map((kind) => el("button", { text: "+ " + kind, disabled: chans.length >= 16, onclick: () => edit((d) => D.addChannel(d, p.id, kind)) }))),
    el("p", { class: "note", text: "pulse: a DAC output with a pulse table; demod: an ADC input demodulated into a measured bit; dio: a digital line, as a decoder core's status output. slots: pulse-table entries; interp: DSP samples per envelope sample." }),
  ];
}
function gateForm(i, gate) {
  const g = doc.qubits[i][gate] ?? {};
  const set = (k) => (v) => edit((d) => ((d.qubits[i][gate] ??= {})[k] = v));
  return el("div", { class: "form" },
    field(gate + ".amp", "Amplitude", g.amp, set("amp"), { unit: "of full scale" }),
    field(gate + ".phaseRad", "Phase", g.phaseRad, set("phaseRad"), { unit: "rad" }),
    field(gate + ".durNs", "Duration", g.durNs, set("durNs"), { unit: "ns" }),
    el("label", { text: "Envelope" }), el("span", { class: "ro", text: envelope(g.envelope) }));
}
const envelope = (e) => (Array.isArray(e) ? e.length + " samples" : e ?? "—");
function qubitSection(i) {
  const q = doc.qubits[i], r = q.readout ?? {};
  const channels = (kind) => doc.channels.filter((c) => c.kind === kind).map((c) => [c.id]);
  const setQ = (k) => (v) => edit((d) => (d.qubits[i][k] = v));
  const setR = (k, scale = 1) => (v) => edit((d) => ((d.qubits[i].readout ??= {})[k] = v * scale));
  const arrivals = verdict.pulses.filter((p) => p.part === q.part || p.part === q.resonator);
  const couplings = (doc.couplings ?? []).map((c, k) => [c, k]).filter(([c]) => c.qubits.includes(i));
  const others = doc.qubits.map((x, k) => k).filter((k) => k !== i && !couplings.some(([c]) => c.qubits.includes(k)));
  let partner = others[0];
  return [
    el("h4", { text: "Qubit q[" + i + "]" }),
    el("p", { class: "note", text: "Programs address this qubit as q[" + i + "]. Calibration values are the document's; a qubit added in the editor starts as a copy of another and is a starting value to edit." }),
    el("div", { class: "form" },
      field("q.part", "Qubit part", q.part, setQ("part"), { options: doc.parts.filter((x) => x.type === "qubit").map((x) => [x.id]) }),
      field("q.resonator", "Resonator", q.resonator, setQ("resonator"), { options: doc.parts.filter((x) => x.type === "resonator").map((x) => [x.id]) }),
      field("q.gate", "Drive channel", q.gate, setQ("gate"), { options: channels("pulse") }),
      field("q.ro", "Readout channel", q.ro, setQ("ro"), { options: channels("pulse") }),
      field("q.demod", "Acquire channel", q.demod, setQ("demod"), { options: channels("demod") }),
      field("q.freq", "Qubit frequency", q.freqHz / 1e9, (v) => edit((d) => (d.qubits[i].freqHz = v * 1e9)), { unit: "GHz" })),
    el("h4", { text: "X90 pulse" }), gateForm(i, "x90"),
    el("h4", { text: "X pulse" }), gateForm(i, "x"),
    el("h4", { text: "Readout" }),
    el("div", { class: "form" },
      field("r.freq", "Tone frequency", r.freqHz / 1e9, setR("freqHz", 1e9), { unit: "GHz" }),
      field("r.amp", "Tone amplitude", r.amp, setR("amp"), { unit: "of full scale" }),
      field("r.durNs", "Tone duration", r.durNs, setR("durNs"), { unit: "ns" }),
      field("r.demodDelayNs", "Acquire after", r.demodDelayNs, setR("demodDelayNs"), { unit: "ns" }),
      field("r.demodNs", "Acquire for", r.demodNs, setR("demodNs"), { unit: "ns" }),
      field("r.demodPhaseRad", "Demod phase", r.demodPhaseRad, setR("demodPhaseRad"), { unit: "rad" })),
    arrivals.length ? [el("h4", { text: "Arrival delays" }), el("table", {}, arrivals.filter((a) => a.kind !== "acquire").map((a) => el("tr", {}, el("td", { text: a.id }), el("td", { text: a.core + "." + a.channel }), el("td", { class: "num", text: ns(a.delayPs) }))))] : null,
    el("h4", { text: "Couplers (" + couplings.length + ")" }),
    couplings.map(([c, k]) => el("div", { class: "form" },
      el("label", { text: "q[" + c.qubits.join("]–q[") + "]" }), el("div", { class: "cell" }, el("button", { text: "Remove coupler", onclick: () => edit((d) => D.removeCoupling(d, k)) })),
      field("c" + k + ".freq", "CZ frequency", c.freqHz / 1e9, (v) => edit((d) => (d.couplings[k].freqHz = v * 1e9)), { unit: "GHz" }),
      field("c" + k + ".dur", "CZ duration", c.durNs, (v) => edit((d) => (d.couplings[k].durNs = v)), { unit: "ns" }),
      c.pulses.map((pl, n) => field("c" + k + ".amp" + n, "Amp on q[" + pl.qubit + "]", pl.amp, (v) => edit((d) => (d.couplings[k].pulses[n].amp = v)), { unit: pl.channel })))),
    others.length ? el("div", { class: "row-buttons" },
      (() => {
        const s = el("select", { "aria-label": "Qubit to couple to" }, others.map((k) => el("option", { value: k, text: "q[" + k + "] " + doc.qubits[k].part })));
        s.onchange = () => (partner = Number(s.value));
        return s;
      })(),
      el("button", { text: "+ Couple", title: "Adds a CZ channel on the core of each qubit's drive, on its DAC, and a coupler calibration copied from an existing one", onclick: () => {
        const tmpl = doc.couplings?.[0] ?? seed.couplings?.[0];
        edit((d) => D.addCoupling(d, Math.min(i, partner), Math.max(i, partner), tmpl));
      } })) : null,
    el("div", { class: "row-buttons" }, el("button", { class: "danger", text: "Remove qubit q[" + i + "]", title: "Removes the qubit, its resonator, channels, couplers and wires, and the core and converters left with nothing to do. Later qubits move down one index.", onclick: () => edit((d) => D.removeQubit(d, i), { keepSelection: false }) })),
  ];
}
function wireInspector(w) {
  if (!w) return designInspector();
  const timing = verdict.wires.find((x) => x.id === w.id);
  const parts = doc.parts.map((p) => [p.id]);
  return [
    el("div", { class: "title" }, w.id, el("small", { text: "wire · " + w.medium })),
    el("p", { class: "what", text: "A wire carries a signal from one part to another along its route, the centreline it follows. Its delay is the routed length over the signal speed of its medium, so a longer or more winding route arrives later." }),
    el("div", { class: "form" },
      field("w.id", "Id", w.id, (v) => {
        let ok = true;
        edit((d) => (ok = D.renameItem(d, "wire", w.id, v.trim())));
        if (ok) select({ kind: "wire", id: v.trim() });
        else alertBox("The id " + v + " is taken.");
      }, { type: "text" }),
      field("w.from", "From", w.from, (v) => edit((d) => {
        D.wire(d, w.id).from = v;
        D.wire(d, w.id).routeMm[0] = D.part(d, v).centerMm.slice();
      }), { options: parts }),
      field("w.to", "To", w.to, (v) => edit((d) => {
        D.wire(d, w.id).to = v;
        D.wire(d, w.id).routeMm[D.wire(d, w.id).routeMm.length - 1] = D.part(d, v).centerMm.slice();
      }), { options: parts }),
      field("w.medium", "Medium", w.medium, (v) => edit((d) => (D.wire(d, w.id).medium = v)), { options: Object.keys(rules.media).map((m) => [m, m + " · " + fmt(rules.media[m], 2) + " mm/ns"]) }),
      el("label", { text: "Length" }), el("span", { class: "stat", text: mm(timing?.lengthMm ?? D.routeLength(w.routeMm)) }),
      el("label", { text: "Delay" }), el("span", { class: "stat", text: ns(timing?.delayPs ?? D.wireDelayPs(w, rules.media)) })),
    el("h4", { text: "Route (" + w.routeMm.length + " points)" }),
    el("table", {}, el("tr", {}, ["", "x", "y", "z", ""].map((t) => el("th", { text: t }))),
      w.routeMm.map((p, k) => {
        const end = k === 0 || k === w.routeMm.length - 1;
        return el("tr", {}, el("td", { text: end ? (k ? "to" : "from") : String(k) }),
          [0, 1, 2].map((a) => {
            const input = el("input", { type: "number", step: "any", value: shown(p[a]), readonly: end, "data-key": "r" + k + a, title: end ? "An end follows its part. Move the part." : "" });
            input.onchange = () => {
              const v = Number(input.value);
              if (!Number.isFinite(v)) return input.classList.add("invalid");
              focusKey = "r" + k + a;
              edit((d) => (D.wire(d, w.id).routeMm[k][a] = v));
            };
            return el("td", {}, input);
          }),
          el("td", { class: "x" }, k < w.routeMm.length - 1 ? el("button", { text: "+", title: "Insert a point after this one, halfway to the next", onclick: () => edit((d) => {
            const r = D.wire(d, w.id).routeMm;
            D.insertWaypoint(d, w.id, k, r[k].map((v, a) => (v + r[k + 1][a]) / 2));
          }) }) : null, !end ? el("button", { text: "×", title: "Remove this point", onclick: () => edit((d) => D.removeWaypoint(d, w.id, k)) }) : null));
      })),
    el("div", { class: "row-buttons" },
      el("button", { text: "Right-angle route", title: "Along x, then y, then z", onclick: () => edit((d) => D.reroute(d, w.id, "orthogonal")) }),
      el("button", { text: "Straight", title: "The shortest route: one straight piece", onclick: () => edit((d) => D.reroute(d, w.id, "straight")) })),
  ];
}

// ───────────────────────────── selection, hover cards ─────────────────────────────
function select(sel, reveal = false) {
  selection = sel;
  if (reveal && sel?.kind === "part") {
    const p = D.part(doc, sel.id);
    if (p) {
      const [x, y] = toScreen(p.centerMm), { w, h } = size();
      if (x < 20 || y < 20 || x > w - 20 || y > h - 20) {
        const [u, v] = PROJ[proj].project(p.centerMm);
        cam.u = u;
        cam.v = v;
      }
    }
  }
  render();
  paintOutline();
  paintInspector();
}
function setHover(id) {
  if (hovered === id) return;
  hovered = id;
  render();
}
const card = $("hovercard");
function showCard(event, kind, title, text, live, source) {
  put(card, el("div", { class: "hk", text: kind }), el("div", { class: "ht", text: title }), text ? el("p", { text }) : null,
    live?.length ? el("div", { class: "live" }, live.map((l) => el("div", { text: l }))) : null, source ? el("div", { class: "src", text: source }) : null);
  card.hidden = false;
  const r = card.getBoundingClientRect();
  card.style.left = Math.min(innerWidth - r.width - 8, event.clientX + 14) + "px";
  card.style.top = Math.min(innerHeight - r.height - 8, event.clientY + 14) + "px";
}
const hideCard = () => (card.hidden = true);
function partCard(event, p) {
  const live = ["at (" + p.centerMm.map((v) => fmt(v, 3)).join(", ") + ") mm"];
  if (p.type === "core") {
    const chans = D.channelsOf(doc, p.id);
    live.push(chans.length + " of 16 channels: " + chans.map((c) => c.name + (c.converter ? "→" + c.converter : "")).join(", "));
    if (doc.decoder === p.id) live.push("decodes and keeps the Pauli frame");
  }
  if (p.type === "dac" || p.type === "adc") live.push("index " + p.index, "channels: " + (D.channelsUsing(doc, p.id).map((c) => c.id).join(", ") || "none"));
  const q = D.qubitOf(doc, p.id);
  if (q >= 0) {
    const entry = doc.qubits[q];
    if (p.type === "qubit") live.push("q[" + q + "] at " + GHz(entry.freqHz) + ", X90 " + fmt(entry.x90?.durNs) + " ns");
    else live.push("reads out q[" + q + "] at " + GHz(entry.readout?.freqHz ?? NaN));
    for (const a of verdict.pulses.filter((x) => x.part === p.id && x.kind !== "acquire")) live.push(a.id + " arrives " + ns(a.delayPs) + " after its DAC");
  }
  const wires = D.wiresAt(doc, p.id);
  if (wires.length) live.push(wires.length + (wires.length === 1 ? " wire" : " wires") + ": " + wires.map((w) => w.id).join(", "));
  for (const m of verdict.errors.filter((m) => D.idsIn(doc, m).some((x) => x.id === p.id))) live.push("✗ " + m);
  showCard(event, TYPE_NAME[p.type] ?? p.type, p.id, rules.components[p.type], live, "riscq/design.mjs COMPONENTS");
}
function wireCard(event, w) {
  const t = verdict.wires.find((x) => x.id === w.id);
  const length = t?.lengthMm ?? D.routeLength(w.routeMm), delay = t?.delayPs ?? D.wireDelayPs(w, rules.media);
  showCard(event, "Wire · " + w.medium, w.id, "Carries the signal from " + w.from + " to " + w.to + " along its route.",
    [mm(length) + " routed, " + w.routeMm.length + " points", fmt(rules.media[w.medium], 2) + " mm/ns → " + ns(delay)], "delay = length ÷ speed (machine/interconnect.mjs)");
}
const UI = {
  modes: ["Workspace", "Design and debug", "Design edits the hardware. Debug runs a program on it and steps through the trace: animation beside the source, hardware instructions and firmware."],
  metrics: ["Summary", "This design in numbers", "Counts of parts, the total coax length, the longest wire delay, and whether the design obeys the rules."],
  palette: ["Palette", "Allowed components", "A design may contain only these part types. Each follows the rules of riscq/design.mjs."],
  build: ["Build", "Macros and tools", "Add a qubit with everything it needs to run, or join two parts with a wire."],
  outline: ["Outline", "Every part and wire", "Click to select. A red entry is named by a broken rule."],
  projection: ["Projection", "Plan, side, front, 3D", "Positions are 3D. Each projection shows two axes and drags move parts in those two."],
  canvas: ["Canvas", "The hardware at its positions in mm", "Drag a part to move it; its wires follow with their bends kept. Scroll to zoom, drag the background to pan."],
  rules: ["Rules", "Checked on every edit", "The server applies riscq/design.mjs check. An error stops the design from running; a warning names a consequence."],
  inspector: ["Inspector", "Edit the selection", "Positions, ids, channels, calibration values and wire routes. Every field writes the design document."],
};

// ───────────────────────────── canvas interaction ─────────────────────────────
const canvas = $("canvas");
let drag = null;
const local = (e) => {
  const r = svg.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
const snapOn = (e) => $("snap").checked && !e.altKey;
function snapPoint(point, axes, e) {
  if (!snapOn(e)) return point.map((v) => Math.round(v * 1000) / 1000);
  const s = gridStep();
  return point.map((v, k) => (axes.includes(k) ? Math.round(Math.round(v / s) * s * 1000) / 1000 : v));
}
const editAxes = () => (proj === "iso" ? [0, 1] : PROJ[proj].axes);
function depthFor(type) {
  const same = doc.parts.find((p) => p.type === type) ?? (type === "resonator" ? doc.parts.find((p) => p.type === "qubit") : null);
  const ref = (selection?.kind === "part" && D.part(doc, selection.id)) || same || D.board(doc);
  return ref ? ref.centerMm.slice() : [0, 0, 0];
}
svg.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !doc) return;
  hideCard();
  const [sx, sy] = local(e);
  const partId = e.target.closest("[data-part]")?.dataset.part, wireId = e.target.dataset.wire, point = e.target.dataset.point;
  if (placing) {
    const at = snapPoint(fromScreen(sx, sy, depthFor(placing)), editAxes(), e);
    let id;
    edit((d) => (id = D.addPart(d, placing, at).id));
    select({ kind: "part", id });
    if (!e.shiftKey) setPlacing(null);
    return;
  }
  if (tool === "wire") {
    if (!partId) return setTool("select");
    if (!wireFrom) {
      wireFrom = partId;
      $("toolhint").textContent = "Wire from " + partId + ": click the part it goes to · Esc to stop";
      return render();
    }
    if (partId !== wireFrom) {
      let id;
      const from = wireFrom;
      edit((d) => (id = D.connect(d, from, partId, $("medium").value).id));
      wireFrom = null;
      $("toolhint").textContent = "Click the part a new wire starts at · Esc to stop";
      select({ kind: "wire", id });
    }
    return;
  }
  svg.setPointerCapture(e.pointerId);
  if (point !== undefined && selection?.kind === "wire") {
    const k = Number(point);
    selection.point = k;
    drag = { kind: "point", id: selection.id, k, start: [sx, sy], from: D.wire(doc, selection.id).routeMm[k].slice(), before: JSON.stringify(doc) };
  } else if (partId) {
    select({ kind: "part", id: partId });
    drag = { kind: "part", id: partId, start: [sx, sy], from: D.part(doc, partId).centerMm.slice(), before: JSON.stringify(doc) };
  } else if (wireId) {
    select({ kind: "wire", id: wireId });
    drag = { kind: "pan", start: [sx, sy], cam: { ...cam }, moved: false };
  } else drag = { kind: "pan", start: [sx, sy], cam: { ...cam }, moved: false, clear: true };
});
svg.addEventListener("pointermove", (e) => {
  if (!doc) return;
  const [sx, sy] = local(e);
  if (!drag) {
    const p = fromScreen(sx, sy, depthFor("stage"));
    $("cursor").textContent = proj === "iso" ? "" : PROJ[proj].axes.map((a) => "xyz"[a] + " " + fmt(p[a], 2)).join("  ") + " mm";
    if (tool === "wire" && wireFrom) {
      ghostAt = [sx, sy];
      render();
    }
    return;
  }
  const dx = sx - drag.start[0], dy = sy - drag.start[1];
  if (drag.kind === "pan") {
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    cam.u = drag.cam.u - dx / cam.s;
    cam.v = drag.cam.v + dy / cam.s;
    canvas.classList.add("panning");
    return render();
  }
  const d = dragDelta(dx, dy);
  const next = snapPoint(drag.from.map((v, k) => v + d[k]), editAxes(), e);
  if (drag.kind === "part") D.movePart(doc, drag.id, next);
  else D.wire(doc, drag.id).routeMm[drag.k] = next;
  render();
  $("cursor").textContent = (drag.kind === "part" ? drag.id : drag.id + " point " + drag.k) + " → (" + next.map((v) => fmt(v, 2)).join(", ") + ") mm";
});
svg.addEventListener("pointerup", () => {
  canvas.classList.remove("panning");
  if (!drag) return;
  const done = drag;
  drag = null;
  if (done.kind === "pan") {
    if (done.clear && !done.moved) select(null);
    return;
  }
  commitFrom(done.before);
});
svg.addEventListener("dblclick", (e) => {
  const wireId = e.target.dataset.wire;
  if (!wireId) return;
  const [sx, sy] = local(e), route = D.wire(doc, wireId).routeMm, pts = route.map(toScreen);
  let best = { k: 0, t: 0, d: Infinity };
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1], len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = len2 ? Math.max(0, Math.min(1, ((sx - ax) * (bx - ax) + (sy - ay) * (by - ay)) / len2)) : 0;
    const d = Math.hypot(ax + t * (bx - ax) - sx, ay + t * (by - ay) - sy);
    if (d < best.d) best = { k, t, d };
  }
  const a = route[best.k], b = route[best.k + 1];
  edit((d) => D.insertWaypoint(d, wireId, best.k, a.map((v, i) => v + best.t * (b[i] - v))));
  selection = { kind: "wire", id: wireId, point: best.k + 1 };
  render();
  paintInspector();
});
svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [sx, sy] = local(e), { w, h } = size();
  const u = (sx - w / 2) / cam.s + cam.u, v = -(sy - h / 2) / cam.s + cam.v;
  cam.s = Math.min(20000, Math.max(0.01, cam.s * Math.exp(-e.deltaY * 0.0015)));
  cam.u = u - (sx - w / 2) / cam.s;
  cam.v = v + (sy - h / 2) / cam.s;
  render();
}, { passive: false });
svg.addEventListener("mouseover", (e) => {
  if (drag) return;
  const partId = e.target.closest("[data-part]")?.dataset.part, wireId = e.target.dataset.wire;
  if (partId) {
    setHover(partId);
    partCard(e, D.part(doc, partId));
  } else if (wireId) {
    setHover(wireId);
    wireCard(e, D.wire(doc, wireId));
  } else if (e.target.dataset.hover === "chip")
    showCard(e, "Chip", "Qubits and resonators", "Drawn around the qubit and resonator parts. The document gives their positions, not a die outline, so this outline is schematic.", [chipParts().length + " parts"]);
  else {
    setHover(null);
    hideCard();
  }
});
svg.addEventListener("mouseleave", () => {
  setHover(null);
  hideCard();
  $("cursor").textContent = "";
});

// ───────────────────────────── tools ─────────────────────────────
function setTool(next) {
  tool = next;
  wireFrom = null;
  ghostAt = null;
  if (next !== "select") setPlacing(null, true);
  $("toolSelect").setAttribute("aria-checked", String(next === "select"));
  $("toolWire").setAttribute("aria-checked", String(next === "wire"));
  canvas.classList.toggle("wiring", next === "wire");
  $("toolhint").textContent = next === "wire" ? "Click the part a new wire starts at · Esc to stop" : "";
  render();
}
function setPlacing(type, quiet) {
  placing = type;
  for (const b of $("palette").children) b.setAttribute("aria-pressed", String(b.dataset.type === type));
  canvas.classList.toggle("placing", !!type);
  if (type) {
    if (tool !== "select") setTool("select");
    $("toolhint").textContent = "Click to place a " + (TYPE_NAME[type] ?? type) + " · Shift-click to place several · Esc to stop";
  } else if (!quiet) $("toolhint").textContent = "";
}
$("toolSelect").onclick = () => setTool("select");
$("toolWire").onclick = () => setTool("wire");
$("addQubit").onclick = () => {
  const tmpl = doc.qubits[0] ?? seed.qubits[0];
  let index;
  edit((d) => (index = D.addQubit(d, tmpl)));
  select({ kind: "part", id: doc.qubits[index].part });
  fitTo("chip");
};
function removeSelection() {
  if (!selection) return;
  if (selection.kind === "wire" && selection.point !== undefined) {
    const { id, point } = selection;
    edit((d) => D.removeWaypoint(d, id, point));
    selection = { kind: "wire", id };
    return render();
  }
  const sel = selection;
  edit((d) => (sel.kind === "wire" ? D.removeWire(d, sel.id) : D.removePart(d, sel.id)), { keepSelection: false });
}
$("remove").onclick = removeSelection;

// ───────────────────────────── page controls ─────────────────────────────
for (const b of document.querySelectorAll("[data-proj]")) b.onclick = () => {
  proj = b.dataset.proj;
  for (const x of document.querySelectorAll("[data-proj]")) x.setAttribute("aria-selected", String(x === b));
  fitTo(selection?.kind === "part" && ["qubit", "resonator"].includes(D.part(doc, selection.id)?.type) ? "chip" : "all");
};
for (const b of document.querySelectorAll("[data-fit]")) b.onclick = () => fitTo(b.dataset.fit);
for (const b of document.querySelectorAll(".tabs [data-tab]")) b.onclick = () => {
  for (const x of document.querySelectorAll(".tabs [data-tab]")) x.setAttribute("aria-selected", String(x === b));
  for (const p of document.querySelectorAll(".dock .pane")) p.hidden = p.dataset.pane !== b.dataset.tab;
  $("dock").classList.remove("folded");
};
$("foldDock").onclick = () => {
  $("dock").classList.toggle("folded");
  render();
};
$("undo").onclick = () => step(undoStack, redoStack);
$("redo").onclick = () => step(redoStack, undoStack);
$("explain").onclick = () => $("explain").setAttribute("aria-pressed", String(document.body.classList.toggle("explaining")));
$("save").onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }));
  el("a", { href: url, download: (doc.name || "design").replace(/[^\w.-]+/g, "-") + ".json" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("open").onclick = () => $("designFile").click();
$("designFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const next = JSON.parse(await file.text());
    if (next?.kind !== "riscq-design") throw Error("This file is not a riscq-design document.");
    template = "mine";
    $("template").value = "mine";
    replaceDoc(next);
  } catch (error) {
    alertBox(error.message);
  }
};
$("template").onchange = async (e) => {
  template = e.target.value;
  if (template === "mine") return;
  replaceDoc(await templateDoc(template));
};
$("qasm").onchange = () => {
  qasm = $("qasm").value;
  save();
};
$("runIt").onclick = () => {
  if (verdict.errors.length) return;
  qasm = $("qasm").value;
  try {
    localStorage.setItem(RUN, JSON.stringify({ design: doc, qasm }));
  } catch (error) {
    return alertBox("The browser would not hand the design to the debugger: " + error.message);
  }
  location.href = "/riscq-studio?design=run";
};
$("toDebug").onclick = (e) => {
  if (verdict.errors.length) return;
  e.preventDefault();
  $("runIt").click();
};
// Panel sizes, hiding and present mode: panels.js. The canvas redraws through its ResizeObserver.
document.addEventListener("mouseover", (e) => {
  const target = e.target.closest?.("[data-explain]");
  if (!target || !document.body.classList.contains("explaining") || target === svg || svg.contains(e.target)) return;
  const [kind, title, text] = UI[target.dataset.explain] ?? [];
  if (kind) showCard(e, kind, title, text);
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest?.("[data-explain]") && !svg.contains(e.target)) hideCard();
});
document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    return step(...(e.shiftKey ? [redoStack, undoStack] : [undoStack, redoStack]));
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    return step(redoStack, undoStack);
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const keys = {
    Delete: removeSelection, Backspace: removeSelection,
    Escape: () => (placing ? setPlacing(null) : tool !== "select" ? setTool("select") : select(null)),
    v: () => setTool("select"), w: () => setTool("wire"), f: () => fitTo("all"), c: () => fitTo("chip"), h: () => $("explain").click(),
    1: () => document.querySelector('[data-proj="plan"]').click(), 2: () => document.querySelector('[data-proj="side"]').click(),
    3: () => document.querySelector('[data-proj="front"]').click(), 4: () => document.querySelector('[data-proj="iso"]').click(),
  };
  if (keys[e.key]) {
    e.preventDefault();
    keys[e.key]();
  }
});
new ResizeObserver(() => doc && render()).observe(canvas);

// ───────────────────────────── start ─────────────────────────────
let seed, ringCache = {};
async function json(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw Error(text);
  return JSON.parse(text);
}
async function templateDoc(name) {
  const key = name === "ring-decoder" ? "ring-decoder" : "ring";
  ringCache[key] ??= await json("/api/riscq/design?template=" + key);
  const base = D.clone(ringCache[key].design);
  if (name !== "chain3") return base;
  const out = D.firstQubits(base, 3);
  out.name = "Three transmons of the x6y3 ring";
  return out;
}
try {
  const [r, start] = await Promise.all([json("/api/riscq/design/rules"), json("/api/riscq/design?template=ring")]);
  rules = r;
  ringCache.ring = start;
  seed = start.design;
  put($("palette"), Object.keys(rules.components).map((type) => el("button", {
    "data-type": type, "aria-pressed": "false",
    onclick: () => setPlacing(placing === type ? null : type),
    onmouseenter: (e) => showCard(e, "Component", TYPE_NAME[type] ?? type, rules.components[type], [doc ? doc.parts.filter((p) => p.type === type).length + " in this design" : ""], "riscq/design.mjs COMPONENTS"),
    onmouseleave: hideCard,
  }, paletteIcon(type), TYPE_NAME[type] ?? type)));
  put($("medium"), Object.entries(rules.media).map(([m, v]) => el("option", { value: m, text: m + " · " + fmt(v, 1) + " mm/ns" })));
  // A design handed over by the debugger, else the one this browser kept, else three ring transmons.
  const query = new URLSearchParams(location.search);
  let kept = null;
  try {
    kept = JSON.parse(localStorage.getItem(query.get("from") === "run" ? EDIT : STORE) ?? "null");
  } catch {
    kept = null;
  }
  if (kept?.design?.kind === "riscq-design") {
    doc = kept.design;
    qasm = kept.qasm ?? start.qasm;
    template = kept.template ?? "mine";
    if (query.get("from") === "run") template = "mine";
    if (query.get("from") === "run") history.replaceState(null, "", location.pathname);
  } else {
    doc = await templateDoc("chain3");
    qasm = start.qasm;
  }
  $("template").value = template;
  $("qasm").value = qasm;
  refresh(true);
  fitTo("all");
} catch (error) {
  alertBox(error.message);
}
