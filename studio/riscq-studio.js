// RISC-Q workspace: the animation and every program layer of one run, side by side.
//
//   source  →  intermediate (TSIR)  →  hardware instructions  →  RV32I firmware of each core
//
// The page reads a run bundle of `/api/riscq/run` and derives everything it shows from the
// frames: the state through riscq-model.js, the layers and the apparatus through
// riscq-layers.js. A step is a frame index, so `?example=<id>&step=<n>&view=<chip|control|machine>`
// names the same picture for a person and for a headless agent that calls the same functions.
import * as model from "./riscq-model.js";
import * as layers from "./riscq-layers.js";
import * as glossary from "./riscq-glossary.js";
import { createWorkspaceStage } from "./riscq-stage.js";
import { signalsAt } from "./riscq-world.js";
import * as benches from "./riscq-benches.js";
import { wavelengthRgb } from "./riscq-optics.js";
import { lightScene } from "./riscq-beamview.js";

const $ = (id) => document.getElementById(id);
const integer = new Intl.NumberFormat("en-US");
const count = (n) => integer.format(n);
const hex = (v, digits = 8) => "0x" + (v >>> 0).toString(16).padStart(digits, "0");

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}
const put = (target, ...children) => (target.replaceChildren(...children.flat(2).filter((c) => c !== null && c !== undefined && c !== false)), target);
const fields = (rows) => el("dl", { class: "fields" }, rows.filter(Boolean).flatMap(([name, value]) => [el("dt", { text: name }), el("dd", {}, value)]));
const button = (label, action, title) => el("button", { type: "button", class: "linkish", text: label, onclick: action, title });

// ───────────────────────────── virtual list ─────────────────────────────

/** A scrolling list that keeps only the visible rows in the document. */
function createList(host, columns, className, fill, hooks) {
  const rowHeight = 22, spacer = el("div", { class: "spacer" }), pool = [];
  let total = 0, scroll = 0, viewHeight = host.clientHeight, emptyText = "";
  function render() {
    spacer.style.height = Math.max(total, 1) * rowHeight + "px";
    if (!total) return host.replaceChildren(spacer, el("div", { class: "vrow inert", text: emptyText, style: "top:0;grid-template-columns:1fr" }));
    const first = Math.max(0, Math.floor(scroll / rowHeight) - 3);
    const last = Math.min(total, first + Math.ceil(viewHeight / rowHeight) + 7);
    const rows = [];
    for (let i = first; i < last; i++) {
      const row = (pool[i - first] ??= el("div", {}, Array.from({ length: columns }, () => el("span"))));
      row.className = "vrow " + className;
      row.style.top = i * rowHeight + "px";
      row.dataset.row = i;
      row.removeAttribute("aria-current");
      fill(row, i);
      rows.push(row);
    }
    host.replaceChildren(spacer, ...rows);
  }
  host.addEventListener("scroll", () => {
    if (Math.abs(host.scrollTop - scroll) < 1) return;
    scroll = host.scrollTop;
    render();
  }, { passive: true });
  const rowOf = (e) => {
    const row = e.target.closest?.(".vrow");
    return row?.dataset.row === undefined ? null : Number(row.dataset.row);
  };
  host.addEventListener("click", (e) => {
    const i = rowOf(e);
    if (i !== null) hooks.pick(i);
  });
  host.addEventListener("mousemove", (e) => hooks.hover?.(rowOf(e), e));
  host.addEventListener("mouseleave", (e) => hooks.hover?.(null, e));
  new ResizeObserver(() => {
    viewHeight = host.clientHeight;
    render();
  }).observe(host);
  return {
    render,
    setCount(n, empty = "") {
      total = n;
      emptyText = empty;
      host.scrollTop = scroll = 0;
      render();
    },
    /** Scroll a row into the middle third when it is outside it. */
    reveal(i) {
      if (i < 0 || i >= total) return;
      const top = i * rowHeight;
      if (top >= scroll + viewHeight * 0.15 && top + rowHeight <= scroll + viewHeight * 0.85) return;
      scroll = Math.max(0, Math.min(top - viewHeight / 2 + rowHeight, total * rowHeight - viewHeight));
      host.scrollTop = scroll;
    },
  };
}

// ───────────────────────────── page state ─────────────────────────────

let run = null, runText = "", index = -1, chosen = null, state = null, focus = null;
let examples = [], program = null, outcomes = {}, token = 0, pendingStep = null;
let stopLists = { pulse: [], fault: [], instruction: [] }, faultSet = new Set();
let playing = false, playClock = 0, playCarry = 0, dirty = false;
// Time-based playback: the batch the stage shows while playing. Ions, atoms and tones are
// placed at this batch, which runs on between the frames, so a shuttle or an AOD move is drawn
// as a continuous motion. The step shown is the last frame at or before it. null when paused.
let clockBatch = null;
let view = "chip", coreChoice = "follow", hint = null, kindCursor = {};
// Hover records of the beams and signals drawn at this step, by stage id ("beam:…", "signal:…").
let lightIndex = new Map();
// The optical bench of the run (riscq-benches.js), built once per run, and its elements.
let bench = null, benchElements = [], opticIndex = new Map();
/** Per-run lookups: rows of hardware instructions, origins and windows. */
let ix = null;

const stage = createWorkspaceStage($("viewport"), {
  // Ions, atoms, couplers, trap sites and zones are drawn but are not parts of the run: hover explains them.
  pick: (id) => model.partKind(run, id) && choose(id),
  hover: (id, x, y) => (id ? card(partCard(id), x, y) : card(null)),
});

// Every run plays on its hardware document, the machine the design page (/riscq-design) builds
// (studio/hw/machine3d.js through studio/reproduce/twin3d.js), set to the machine time of this step. A
// reproduced paper's run (riscq/ftqvm/studio-runs.mjs) carries the track its reproduce page plays; a
// Workspace run's track is derived from its trace and geometry (studio/hw/from-run.js).
let twin = null, twinBox = null;
const TWIN_VIEW = { chip: "device", control: "control", machine: "all" };
async function mountReproduction() {
  twin?.dispose();
  twin = null;
  twinBox?.remove();
  twinBox = null;
  let track = run?.derived?.track;
  if (!track && run) {
    const mine = run, { trackFromBundle } = await import("/hw/from-run.js");
    if (mine !== run) return;
    try { track = trackFromBundle(run); } catch (error) { note("The machine could not be drawn for this run: " + error.message); }
    if (track) (run.derived ??= {}).trackBaseBatch = 0;
  }
  if (!track) return;
  const { mountTwin } = await import("/reproduce/twin3d.js");
  twinBox = document.createElement("div");
  twinBox.className = "studio-twin";
  $("viewport").append(twinBox);
  twin = mountTwin(twinBox, track, { external: true });
  twin.setView(TWIN_VIEW[view] ?? "all");
  schedule();
}

const period = () => run.machine.dspPeriodPs;
const timeOf = (batch) => model.formatTime(batch * period());
const partLabel = (id) => run.system.parts.find((p) => p.id === id)?.label ?? id;
const partButton = (id) => button(id, () => choose(id), partLabel(id));
const frameButton = (id, label) => button(label ?? id, () => jump(model.frameIndex(run, id)), "Go to frame " + id);
const unitOf = () => (run.hardware.timeUnit === "ps" ? model.formatTime : (v) => v + " " + run.hardware.timeUnit);

function note(message) {
  $("alert").textContent = message ?? "";
  $("alert").hidden = !message;
}
function stop() {
  playing = false;
  if (clockBatch !== null) {
    clockBatch = null;
    schedule();
  }
  $("play").textContent = "Play";
}
function schedule() {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(paint);
}
function jump(i, fromPlayer = false) {
  if (!run) return;
  if (!fromPlayer) stop();
  index = Math.min(run.frames.length - 1, Math.max(-1, i));
  schedule();
}
function choose(id) {
  if (!run) return;
  chosen = chosen === id ? null : id;
  schedule();
}
function setView(next) {
  view = next;
  for (const b of document.querySelectorAll(".views button")) b.setAttribute("aria-selected", String(b.dataset.view === view));
  stage.setView(view);
  twin?.setView(TWIN_VIEW[view] ?? "all");
  paintKinds();
  syncAddress();
  schedule();
}
/**
 * Show the machine at batch `batch` without playing: the step is the last frame at or before
 * it, and ions, atoms and tones are placed at the batch itself, as real-time playback places
 * them. For scripts such as docs/media/capture.mjs. Any other navigation returns to steps.
 * Resolves with the counter text once the stage has painted.
 */
window.riscqShowBatch = async (batch) => {
  if (!run) throw Error("No run is loaded.");
  stop();
  clockBatch = Math.max(0, batch);
  index = model.indexAtBatch(run, clockBatch);
  schedule();
  for (let k = 0; k < 3; k++) await new Promise((done) => requestAnimationFrame(done));
  return $("counter").textContent;
};

function syncAddress() {
  if (!run) return;
  const q = new URLSearchParams();
  if (program?.example) {
    q.set("example", program.example);
    for (const [bit, value] of Object.entries(outcomes)) if (value) q.append("outcome", bit + "=" + value);
  }
  // A run on a hardware design from the editor reloads from the design this browser handed over.
  if (program?.design) q.set("design", "run");
  if (index >= 0) q.set("step", index + 1);
  if (view !== "chip") q.set("view", view);
  history.replaceState(null, "", location.pathname + (String(q) ? "?" + q : ""));
  $("classic").href = "/riscq" + (program?.example ? "?" + new URLSearchParams([["example", program.example], ...(index >= 0 ? [["step", index + 1]] : [])]) : "");
}

// ───────────────────────────── per-run lookups ─────────────────────────────

const opColours = { x90: "#2a7287", x: "#1f5f8a", cz: "#8058a1", measure: "#b0521c", frame: "#7c8b8e", transport: "#3b7f4e", rotate: "#2a7287",
  ms: "#8058a1", cool: "#4f6a82", pickup: "#3b7f4e", move: "#5a9a3a", drop: "#7a8f2a", raman: "#2a7287", rydberg: "#8058a1",
  decode: "#a0522d", "pauli-frame": "#7c6a2a", load: "#4f6a82", report: "#4f6a82" };
const opColour = (op) => opColours[op] ?? "#5f7f7a";

function buildIndex() {
  const ops = model.hardwareOps(run);
  const row = new Map(ops.map((e, k) => [e.op.id, k]));
  const origin = ops.map((e) => layers.originOf(run, e.op));
  const bySource = new Map(), byIr = new Map();
  origin.forEach((o, k) => {
    for (const line of o.source) (bySource.get(line) ?? bySource.set(line, []).get(line)).push(k);
    for (const line of o.ir) (byIr.get(line) ?? byIr.set(line, []).get(line)).push(k);
  });
  // The span of an instruction: its first window opening to its last window closing.
  const span = new Map();
  for (const r of run.summary?.pulses ?? []) {
    const s = span.get(r.source) ?? [Infinity, -Infinity];
    span.set(r.source, [Math.min(s[0], r.opens), Math.max(s[1], r.closes ?? r.opens + 1)]);
  }
  ix = { ops, row, origin, bySource, byIr, span, pcCounts: new Map() };
}

/** Frames per pc of one core: Map(pc → [frame index]). Built when first asked. */
function framesAtPc(core) {
  if (!ix.pcCounts.has(core)) {
    const name = run.machine.cores[core]?.name, map = new Map();
    run.frames.forEach((f, i) => {
      if (f.part === name && f.pc !== undefined) (map.get(f.pc) ?? map.set(f.pc, []).get(f.pc)).push(i);
    });
    ix.pcCounts.set(core, map);
  }
  return ix.pcCounts.get(core);
}
const fwCore = () => (coreChoice === "follow" ? focus?.core ?? 0 : Number(coreChoice));

// ───────────────────────────── program layers ─────────────────────────────

/** Rows lit by the step (now), by open windows (run) and by the hover link (link) in each layer. */
let lit = { source: new Set(), ir: new Set(), hw: new Set(), fw: new Set(), runSource: new Set(), runIr: new Set(), runHw: new Set(), region: new Set() };
let link = null;

function classes(row, i, nowSet, runSet, linkSet, regionSet) {
  if (nowSet.has(i)) row.classList.add("now");
  else if (linkSet?.has(i)) row.classList.add("link");
  else if (runSet?.has(i)) row.classList.add("run");
  else if (regionSet?.has(i)) row.classList.add("region");
}
const sourceList = createList($("sourceList"), 2, "src-row", (row, i) => {
  const line = layers.programLayers(run).source.lines[i];
  row.children[0].textContent = line.key ?? "";
  row.children[1].textContent = line.text;
  if (!ix.bySource.has(i)) row.classList.add("inert");
  classes(row, i, lit.source, lit.runSource, link?.source);
}, { pick: (i) => pickOps(ix.bySource.get(i)), hover: (i, e) => hoverLayer("source", i, e) });
const irList = createList($("irList"), 2, "src-row", (row, i) => {
  const line = layers.programLayers(run).ir.lines[i];
  row.children[0].textContent = line.key;
  row.children[1].textContent = line.text;
  if (!ix.byIr.has(i)) row.classList.add("inert");
  classes(row, i, lit.ir, lit.runIr, link?.ir);
}, { pick: (i) => pickOps(ix.byIr.get(i)), hover: (i, e) => hoverLayer("ir", i, e) });
const hwList = createList($("hwList"), 5, "hw-row", (row, i) => {
  const { op, segment, frames } = ix.ops[i], cells = row.children, unit = unitOf();
  const classical = run.hardware.segments[segment]?.classical;
  cells[0].textContent = op.id;
  cells[1].textContent = op.op;
  cells[1].className = "op";
  cells[1].style.background = opColour(op.op);
  cells[2].textContent = operands(op);
  cells[3].textContent = classical ? "when reached" : unit(op.t);
  cells[4].textContent = classical ? "" : unit(op.dur);
  if (!frames) row.classList.add("inert");
  classes(row, i, lit.hw, lit.runHw, link?.hw);
}, { pick: (i) => ix.ops[i].first >= 0 && jump(ix.ops[i].first), hover: (i, e) => hoverLayer("hw", i, e) });
const fwList = createList($("fwList"), 4, "fw-row", (row, i) => {
  const word = layers.firmware(run, fwCore())[i], cells = row.children;
  cells[0].textContent = hex(word.pc);
  cells[1].textContent = hex(word.word);
  cells[1].className = "reg";
  cells[2].textContent = word.text;
  cells[3].textContent = word.region ?? "";
  cells[3].className = "reg";
  classes(row, i, lit.fw, null, link?.fw, lit.region);
}, { pick: (i) => pickWord(i), hover: (i, e) => hoverLayer("fw", i, e) });

function operands(op) {
  return [
    op.qubits?.length ? "q" + op.qubits.join(",q") : null,
    op.pauli ? "Pauli " + op.pauli : null,
    op.inputs ? op.inputs.join(",") + "→" + op.outputs.join(",") : null,
    op.ions ? op.ions.join(",") : null,
    op.pairs ? op.pairs.map((p) => p.join("+")).join(" ") : null,
    op.aod !== undefined ? "AOD " + op.aod : null,
    op.sites ? "@" + op.sites.join(",") : null,
    op.moves ? op.moves.map((m) => m.ion + " " + m.from + "→" + m.to).join(", ") : null,
    op.when !== undefined ? "if " + op.when : null,
  ].filter(Boolean).join(" ");
}

/** Go to the first frame of the first of these hardware instructions that has one. */
function pickOps(rows) {
  const entry = (rows ?? []).map((k) => ix.ops[k]).find((e) => e.first >= 0);
  if (entry) jump(entry.first);
}
/** Go to the next frame of the listed core at this word, wrapping to the first. */
function pickWord(i) {
  const core = fwCore(), word = layers.firmware(run, core)[i];
  const list = framesAtPc(core).get(word.pc);
  if (list?.length) return jump(list.find((k) => k > index) ?? list[0]);
  // A word that touches no control register has no frame in an io trace: go to its region's instruction.
  const entry = ix.ops[ix.row.get(word.region)];
  if (entry?.first >= 0) jump(entry.first);
}

/** Cross-layer link for a hovered row of one layer: the rows of the other layers it relates to. */
function linkOf(layer, i) {
  const ops = layer === "source" ? ix.bySource.get(i) ?? [] : layer === "ir" ? ix.byIr.get(i) ?? []
    : layer === "hw" ? [i] : [ix.row.get(layers.firmware(run, fwCore())[i]?.region)].filter((k) => k !== undefined);
  const out = { source: new Set(), ir: new Set(), hw: new Set(ops), fw: new Set(), ops };
  for (const k of ops) {
    for (const line of ix.origin[k].source) out.source.add(line);
    for (const line of ix.origin[k].ir) out.ir.add(line);
    for (const r of layers.firmwareRowsOf(run, fwCore(), ix.ops[k].op.id)) out.fw.add(r);
  }
  if (layer === "source") out.source.add(i);
  if (layer === "ir") out.ir.add(i);
  if (layer === "fw") out.fw.add(i);
  return out;
}

function hoverLayer(layer, i, e) {
  if (!run) return;
  const key = i === null ? null : layer + i;
  if (key !== link?.key) {
    link = i === null ? null : { key, ...linkOf(layer, i) };
    // The apparatus and channels the linked instructions act on are lit on the stage.
    hint = link ? partsOfOps(link.ops) : null;
    renderLists();
    schedule();
  }
  card(i === null ? null : rowCard(layer, i), e.clientX, e.clientY);
}

function partsOfOps(rows) {
  const out = new Set();
  for (const k of rows.slice(0, 12)) {
    let n = 0;
    for (const f of model.framesOfSource(run, ix.ops[k].op.id)) {
      const frame = run.frames[f];
      if (frame.op === "effect" || frame.op === "pulse" || frame.op === "fire") out.add(frame.part);
      if (++n > 400) break;
    }
  }
  return out;
}

function renderLists() {
  sourceList.render();
  if (layers.programLayers(run).ir) irList.render();
  hwList.render();
  fwList.render();
}

// ───────────────────────────── hover cards ─────────────────────────────

const cardNode = $("hovercard");
function card(content, x, y) {
  if (!content) {
    cardNode.hidden = true;
    return;
  }
  put(cardNode, content);
  cardNode.hidden = false;
  const w = cardNode.offsetWidth, h = cardNode.offsetHeight;
  cardNode.style.left = Math.max(6, Math.min(innerWidth - w - 6, x + 14)) + "px";
  cardNode.style.top = Math.max(6, y + 16 + h > innerHeight ? y - h - 12 : y + 16) + "px";
}
const cardHead = (kind, title) => [el("div", { class: "hk", text: kind }), el("div", { class: "ht", text: title })];

/** Hover card of a part, an ion or an atom: what it is, and its state at this step. */
function partCard(id) {
  if (!run || !state) return null;
  if (id.startsWith("ion:")) {
    const ion = layers.ionPositions(run, state.atBatch).find((o) => "ion:" + o.ion === id);
    return [cardHead("Trapped ion", id.slice(4)), el("p", { text: "One qubit. Its position comes from QCCD Studio's replay: the ion is at a site once the transport cycle that moves it has played every waveform on time." }),
      el("div", { class: "live", text: ion?.moving ? "moving " + ion.moving.from + " → " + ion.moving.to + " in " + ion.moving.op + " · " + Math.round((ion.fraction ?? 0) * 100) + "% of its window" : "at site " + (ion?.site ?? "unknown") })];
  }
  if (id.startsWith("optic:")) {
    const e = opticIndex.get(id);
    if (id === "optic:sample") return [cardHead("Optical bench", "The apparatus"), el("p", { text: "Where the bench delivers its light: the atom plane or the trap surface, shown in close-up at the centre of the stage." })];
    if (id === "optic:table" || !e) return [cardHead("Optical table", "The bench of this platform"), el("p", { text: "Every laser, modulator, fiber, lens and objective of the bench at one scale, with the path of each beam that is on. The close-up of the light at the apparatus is drawn at the apparatus's own scale." }),
      el("div", { class: "live", text: benchElements.length + " elements · " + (bench?.lasers?.length ?? 0) + " lasers" })];
    return [cardHead("Optical element · " + e.kind, e.label), el("div", { class: "live" }, [["position", e.at.map((v) => v.toFixed(2)).join(", ") + " mm"], e.wxUm ? ["beam radius here", (e.wxUm / 1000).toFixed(3) + " × " + (e.wyUm / 1000).toFixed(3) + " mm"] : null,
      ["train", e.train ?? "—"]].filter(Boolean).map(([k, v]) => el("div", {}, el("span", { class: "muted", text: k + " " }), v))), e.source ? el("div", { class: "src", text: e.source }) : null];
  }
  if (id.startsWith("signal:") || id.startsWith("beam:")) {
    // Light and signals on the stage: their own records, derived from the trace this step.
    const item = lightIndex.get(id);
    if (!item) return [cardHead(id.startsWith("beam:") ? "Laser beam" : "Signal", id.replace(/^\w+:/, "")), el("p", { text: "Not live at this step." })];
    return [cardHead(item.kind, item.title), item.text ? el("p", { text: item.text }) : null,
      el("div", { class: "live" }, item.lines.map(([k, v]) => el("div", {}, el("span", { class: "muted", text: k + " " }), v))),
      item.source ? el("div", { class: "src", text: item.source }) : null];
  }
  if (id.startsWith("atom:")) {
    const atom = layers.atomPositions(run, state.atBatch).find((a) => "atom:" + a.atom === id);
    return [cardHead("Neutral atom", "Atom " + id.slice(5)), el("p", { text: "One qubit in an optical tweezer. While an AOD carries it, it sits where its column tone crosses its row tone. Atoms are assumed to follow their tones." }),
      el("div", { class: "live", text: atom ? "x " + atom.at[0].toFixed(2) + " µm · y " + atom.at[1].toFixed(2) + " µm" + (atom.carried ? " · carried by " + atom.job : " · in a static trap") : "" })];
  }
  if (id.startsWith("coupler:")) {
    const [pair, off] = id.slice(8).split(":");
    return [cardHead("Coupler", "Qubits " + pair.replace("-", " and ")), el("p", { text: "Fixed coupling between two neighbouring transmons. A CZ plays a tone on both qubits' CZ channels at once." }),
      off ? el("p", { class: "bad", text: "Not offered: this pair's CZ needs a pulse on the second excited level, which the lowering does not provide." }) : null];
  }
  if (id.startsWith("trapsite:")) {
    const site = run.machine.geometry?.sites?.find((s) => s.id === id.slice(9));
    return [cardHead("Trap site", id.slice(9)), el("p", { text: "A place where ions can be held, from QCCD Studio's architecture." }),
      site ? el("div", { class: "live", text: "zone " + site.zone + " · capacity " + site.capacity + (site.gate ? " · gate site" : "") + " · at (" + site.position.slice(0, 2).join(", ") + ") " + (run.machine.geometry.units?.position ?? "") }) : null];
  }
  if (id.startsWith("zone:")) {
    const zone = run.machine.geometry?.zones?.find((z) => "zone:" + z.id === id);
    return [cardHead("Array zone", id.slice(5)), el("p", { text: zone?.kind === "entanglement" ? "Entanglement zone: atoms brought here in pairs are entangled by the global Rydberg pulse." : "Storage zone: a grid of static traps that hold atoms between gates." }),
      zone ? el("div", { class: "live", text: "origin (" + zone.origin.join(", ") + ") µm · size " + zone.size.join(" × ") + " µm" }) : null];
  }
  const kind = model.partKind(run, id);
  const g = glossary.part(kind, id, partLabel(id));
  return [cardHead(g.kind, g.title), el("p", { text: g.what }), g.role ? el("p", { text: g.role }) : null, el("div", { class: "live" }, liveLines(id, kind).map((t) => el("div", { text: t }))),
    g.source ? el("div", { class: "src", text: "RISC-Q source: " + g.source + " · " + id }) : el("div", { class: "src", text: id })];
}

/** Short statements about a part at this step. */
function liveLines(id, kind) {
  const out = [], core = state.cores[model.coreOfPart(run, id)];
  const seen = model.countUpTo(model.framesOfPart(run, id), index), total = model.framesOfPart(run, id).length;
  if (kind === "core" && core) {
    out.push(core.stopped ? "stopped: " + core.stopped : core.waiting ? "stalled on " + core.waiting.register : "running");
    out.push("last instruction: " + (core.lastText ?? "none traced") + " at " + hex(core.pc));
    if (core.lastSource) out.push("working on " + core.lastSource);
  }
  const channel = core?.channels.find((ch) => ch.part === id);
  if (channel) {
    out.push(channel.open.length ? channel.open.length + " window open until batch " + channel.open[0].closes : "no window open");
    out.push(count(channel.windows) + " windows so far · start time " + channel.buffer.startTime);
    const driven = layers.drivenBy(run).get(id);
    if (driven) out.push("drives " + driven.join(", "));
  }
  if (kind === "device") {
    const active = layers.activeDevices(run, state).get(id);
    out.push(active ? "driven now by " + active.map((a) => a.binding.id).join(", ") : "not driven now");
    out.push((state.devices[id]?.count ?? 0) + " signals arrived so far");
  }
  if (kind === "hub") {
    out.push(state.hub.barriers.length ? state.hub.barriers.map((b) => "barrier " + b.barrier + ": " + b.arrived.length + " of " + b.expected).join(" · ") : "no barrier open");
    out.push(state.hub.waiting.length ? state.hub.waiting.length + " messages waiting at the arbiter" : "arbiter idle");
  }
  if (["dac", "adc", "pins"].includes(kind)) {
    const open = state.openWindows.filter((w) => w.converter === id);
    out.push(open.length ? open.length + " window open: " + open.map((w) => w.part).join(", ") : "idle");
  }
  out.push(count(seen) + " of " + count(total) + " frames of this part are at or before this step");
  if (!stage.shows(id)) out.push("not drawn in this view, still running");
  return out;
}

/** Hover card of a row in a program layer. */
function rowCard(layer, i) {
  if (layer === "source" || layer === "ir") {
    const L = layers.programLayers(run)[layer === "source" ? "source" : "ir"], line = L.lines[i];
    const ops = (layer === "source" ? ix.bySource : ix.byIr).get(i) ?? [];
    const linked = ops.length
      ? count(ops.length) + " hardware instructions: " + ops.slice(0, 8).map((k) => ix.ops[k].op.id + " " + ix.ops[k].op.op).join(", ") + (ops.length > 8 ? "…" : "") + ". Click to go to the first."
      : "No hardware instruction names this " + (layer === "source" ? "line" : "instruction") + ".";
    return [cardHead(L.language, (layer === "source" ? "Line " : "Instruction ") + (line.key ?? "")), el("p", { text: line.text.trim() || "(blank)" }),
      el("div", { class: "live", text: linked })];
  }
  if (layer === "hw") {
    const { op, frames, segment } = ix.ops[i], unit = unitOf(), span = ix.span.get(op.id);
    return [cardHead("Hardware instruction " + op.id, op.op + " " + operands(op)), el("p", { text: glossary.OPS[op.op] ?? "" }),
      el("div", { class: "live" }, [
        el("div", { text: "scheduled at " + unit(op.t) + " for " + unit(op.dur) + " in segment " + segment }),
        span ? el("div", { text: "windows open batch " + count(span[0]) + " to " + count(span[1]) + " (" + timeOf(span[0]) + " to " + timeOf(span[1]) + ")" }) : null,
        el("div", { text: count(frames) + " frames carry it · origin " + (op.source ?? "none") }),
        el("div", { text: "Click to go to its first frame. Its channels light up on the stage." })])];
  }
  const core = fwCore(), word = layers.firmware(run, core)[i], hits = framesAtPc(core).get(word.pc)?.length ?? 0;
  const what = { load: "Load from memory or a control register.", store: "Store to memory, a control register or the put window (a posted write to a channel or the hub).",
    branch: "Conditional branch.", jump: "Jump. A jump to itself parks the core.", alu: "Arithmetic on registers.", system: "System instruction.", illegal: "Not an instruction: data, such as an entry of an issue table." }[word.kind];
  return [cardHead("RV32I · core " + run.machine.cores[core].name, word.text), el("p", { text: what }),
    el("div", { class: "live" }, [el("div", { text: hex(word.pc) + " · word " + hex(word.word) }), el("div", { text: "region " + (word.region ?? "none") }),
      el("div", { text: hits ? count(hits) + " traced executions. Click for the next one." : model.traceDetail(run) === "io" ? "No traced execution: this trace records only instructions that touch control registers." : "Never executed in this run." })])];
}

// Hover explanations of the page's own regions.
document.addEventListener("mouseover", (e) => {
  const target = e.target.closest?.("[data-explain], .kind");
  if (!target || e.target.closest(".vrow") || e.target.closest("canvas.track") && !document.body.classList.contains("explaining")) return;
  if (target.classList.contains("kind")) {
    const g = glossary.part(target.dataset.kind, "", "");
    return card([cardHead("Part kind", g.kind), el("p", { text: g.what }), el("p", { text: g.role }), g.source ? el("div", { class: "src", text: "RISC-Q source: " + g.source }) : null], e.clientX, e.clientY);
  }
  const text = glossary.UI[target.dataset.explain];
  if (text && (target.tagName === "BUTTON" || document.body.classList.contains("explaining") || target.classList.contains("now") || target.classList.contains("offview")))
    card([cardHead("Explain", target.dataset.explain.replace(/^view-/, "view: ")), el("p", { text })], e.clientX, e.clientY);
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest?.("[data-explain], .kind") && !e.relatedTarget?.closest?.("[data-explain], .kind")) card(null);
});

// ───────────────────────────── rail ─────────────────────────────

const kindColours = { host: "#273439", hub: "#d2ac60", core: "#3a4a50", link: "#58b8ac", inbox: "#b4a284", pulse: "#26785e", demod: "#6c5a94",
  dio: "#4f6a82", dac: "#d2ac60", adc: "#6aa0c8", pins: "#8a6027", device: "#b096ca" };
const kindOrder = ["device", "pulse", "demod", "dio", "dac", "adc", "pins", "core", "link", "inbox", "hub", "host"];

function paintKinds() {
  if (!run) return;
  const shown = layers.viewParts(run, view), byKind = new Map();
  for (const p of run.system.parts) (byKind.get(p.kind) ?? byKind.set(p.kind, []).get(p.kind)).push(p.id);
  const acting = run.frames[index] ? model.partKind(run, run.frames[index].part) : null;
  put($("kinds"), kindOrder.filter((k) => byKind.has(k)).map((kind) => {
    const ids = byKind.get(kind), visible = ids.filter((id) => shown.has(id)).length;
    return el("button", { type: "button", class: "kind" + (visible ? "" : " off") + (kind === acting ? " live" : ""), "data-kind": kind,
      onclick: () => {
        kindCursor[kind] = ((kindCursor[kind] ?? -1) + 1) % ids.length;
        chosen = null;
        choose(ids[kindCursor[kind]]);
      } }, el("i", { class: "av", style: "background:" + kindColours[kind] }), glossary.PARTS[kind]?.[0] ?? kind, el("span", { class: "n", text: count(ids.length) }));
  }));
  // One world for all three views (riscq-world.js): the note is the same in each.
  const chip = layers.chipLayout(run);
  $("chipNote").textContent = (run.system.parts.some((p) => p.kind === "device") ? "Apparatus: " + chip.note + " " : "") +
    "All three views show this one layout: they frame it differently and fade what they do not focus on. Converters ring the apparatus at the angle of the parts they drive, channels beside them, cores outside at the angle of their channels, joined to the hub by a bus ring. Outside the apparatus the layout is schematic." +
    (run.platform === "neutral" || run.platform === "qccd" ? " Beams are drawn at their Gaussian 1/e² radius from the optical bench (riscq-benches.js); infrared light is drawn in a false colour." : "") +
    (run.platform === "superconducting" ? " A microwave pulse is drawn as a packet that leaves its DAC when its window opens and reaches the qubit after its wire delay." : "");
}

function paintSelection() {
  const box = $("selection");
  if (!chosen) return put(box, el("h4", { text: "Selection" }), el("p", { class: "hint", text: "Nothing selected. Click a part on the stage, or a kind above, to see its details here." }));
  const kind = model.partKind(run, chosen), g = glossary.part(kind, chosen, partLabel(chosen));
  const list = model.framesOfPart(run, chosen), seen = model.countUpTo(list, index);
  const prev = list[seen - 1 - (list[seen - 1] === index ? 1 : 0)] ?? -1, next = list[seen] ?? -1;
  put(box, el("h4", { text: "Selection" }), el("p", { class: "sel-title", text: g.title }),
    el("p", { class: "hint", text: g.what }),
    el("dl", {}, [["id", chosen], ["kind", g.kind], ...liveLines(chosen, kind).map((t, k) => ["·", t])].flatMap(([a, b]) => [el("dt", { text: a }), el("dd", { text: b })])),
    el("div", { class: "row-buttons" },
      Object.assign(el("button", { type: "button", text: "‹ Its previous frame", onclick: () => jump(prev) }), { disabled: prev < 0 }),
      Object.assign(el("button", { type: "button", text: "Its next frame ›", onclick: () => jump(next) }), { disabled: next < 0 }),
      el("button", { type: "button", text: "Clear", onclick: () => choose(chosen) })));
}

// ───────────────────────────── stage overlays ─────────────────────────────

function paintNow(frame, fault) {
  const total = run.frames.length, now = $("now");
  now.classList.toggle("fault", fault);
  const head = el("div", { class: "k", text: (frame ? "Executing · step " + count(index + 1) + " / " + count(total) : "Reset state · step 0 / " + count(total)) +
    " · batch " + count(state.atBatch) + " · " + timeOf(state.atBatch) });
  if (!frame) return put(now, head, el("div", { class: "t", text: "Before the first frame" }), el("div", { text: "Every core starts at " + hex(run.initial.pc) + ". Press Play or →." }));
  const [title] = model.describe(run, frame);
  const op = focus.op ?? model.hardwareOp(run, state.cores[focus.core]?.lastSource)?.op;
  const { source, ir } = layers.programLayers(run);
  const word = layers.firmware(run, focus.core)[focus.row];
  const line = (k, v) => el("div", { class: "l" }, el("span", { text: k }), el("span", { text: v, title: v }));
  put(now, head, el("div", { class: "t", text: title + " · " + frame.part }),
    line("frame", frame.id + " " + frame.op + (frame.targets?.length ? " → " + frame.targets.join(", ") : "")),
    line("hardware", op ? op.id + " " + op.op + " " + operands(op) + (focus.op ? "" : "  (last of " + run.machine.cores[focus.core].name + ")") : frame.source ? "firmware phase " + frame.source : "none"),
    ir && focus.ir.length ? line(ir.language.split(" ")[0], ir.lines[focus.ir[0]].text.trim()) : null,
    line(source.language.split(" ")[0], focus.source.length ? focus.source.map((k) => source.lines[k].text.trim()).join(" · ") : "no source line for this step"),
    line("firmware", word ? run.machine.cores[focus.core].name + " " + hex(word.pc) + "  " + word.text : "no firmware word"));
}

function paintOffview(frame) {
  const ids = frame ? [frame.part, ...(frame.targets ?? [])].filter((id) => !stage.shows(id)) : [];
  const list = [...new Set(ids)];
  if (!list.length) return $("offview").replaceChildren();
  put($("offview"), el("span", { class: "cap", text: "Acting off view" }), list.slice(0, 4).map((id) => {
    const kind = model.partKind(run, id), home = layers.VIEWS.chip.kinds.includes(kind) && layers.viewParts(run, "chip").has(id) ? "chip"
      : layers.viewParts(run, "control").has(id) ? "control" : "machine";
    return el("button", { type: "button", title: "Show it in the " + layers.VIEWS[home].title + " view", onclick: () => {
      setView(home);
      chosen = id;
      schedule();
    } }, el("b", { text: id === frame.part ? frame.op + " " : "→ " }), id + " · " + (glossary.PARTS[kind]?.[0] ?? kind));
  }));
}

// ───────────────────────────── time track ─────────────────────────────

const track = $("track");
function paintTrack() {
  const w = track.clientWidth, h = track.clientHeight, dpr = Math.min(devicePixelRatio, 2);
  if (track.width !== Math.round(w * dpr) || track.height !== Math.round(h * dpr)) {
    track.width = Math.round(w * dpr);
    track.height = Math.round(h * dpr);
  }
  const ctx = track.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!run) return;
  const end = Math.max(1, run.summary.elapsedBatches ?? run.frames.at(-1)?.atBatch ?? 1), left = 8, right = 8;
  const x = (b) => left + (b / end) * (w - left - right);
  const kinds = [...new Set(ix.ops.map((e) => e.op.op))], laneH = Math.max(4, Math.min(10, (h - 14) / Math.max(1, kinds.length)));
  ix.ops.forEach((e, k) => {
    const span = ix.span.get(e.op.id);
    if (!span) return;
    const lane = kinds.indexOf(e.op.op);
    ctx.fillStyle = opColour(e.op.op);
    ctx.globalAlpha = lit.hw.has(k) ? 1 : link?.hw.has(k) ? 1 : 0.75;
    ctx.fillRect(x(span[0]), 4 + lane * laneH, Math.max(1.5, x(span[1]) - x(span[0])), laneH - 1.5);
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#5a6c6f";
  ctx.font = "10px Inter, Segoe UI, sans-serif";
  ctx.fillText(kinds.join(" · ") + "   ·   " + timeOf(end) + " in all", left, h - 3);
  for (const f of stopLists.fault.slice(0, 400)) {
    ctx.fillStyle = "#f1583a";
    ctx.fillRect(x(run.frames[f].atBatch) - 0.5, 0, 1, h);
  }
  ctx.fillStyle = "#d39b00";
  ctx.fillRect(x(clockBatch ?? state.atBatch) - 1, 0, 2, h);
}
track.addEventListener("click", (e) => {
  if (!run) return;
  const r = track.getBoundingClientRect(), end = Math.max(1, run.summary.elapsedBatches ?? 1);
  jump(model.indexAtBatch(run, Math.round(((e.clientX - r.left - 8) / (r.width - 16)) * end)));
});
track.addEventListener("mousemove", (e) => {
  if (!run) return;
  const r = track.getBoundingClientRect(), end = Math.max(1, run.summary.elapsedBatches ?? 1);
  const b = ((e.clientX - r.left - 8) / (r.width - 16)) * end;
  const hits = ix.ops.filter((o) => {
    const s = ix.span.get(o.op.id);
    return s && s[0] <= b && b <= s[1];
  });
  card([cardHead("Time track", "batch " + count(Math.max(0, Math.round(b))) + " · " + timeOf(Math.max(0, b))),
    el("p", { text: hits.length ? hits.slice(0, 6).map((o) => o.op.id + " " + o.op.op + " " + operands(o.op)).join("\n") : "No instruction has a window open here." }),
    el("div", { class: "src", text: "Click to go to the last step at or before this time." })], e.clientX, e.clientY);
});
track.addEventListener("mouseleave", () => card(null));

// ───────────────────────────── dock ─────────────────────────────

function showValue(key, value) {
  if (value === null) return "none";
  if (key === "buffer") return "start time " + value.startTime + " · carrier code " + value.freq;
  if (key === "arrivesPs") return model.formatTime(value);
  if (Number.isInteger(value) && ["pc", "address", "word"].includes(key)) return hex(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function paintInspector(frame, fault) {
  if (!frame) return put($("inspector"), el("p", { class: "hint", text: "Reset state. Every core starts at " + hex(run.initial.pc) + " with zeroed registers. Step forward to see the first frame." }));
  const [title, description] = model.describe(run, frame);
  const chain = model.causalChain(run, frame.id);
  const op = focus.op;
  put($("inspector"), el("div", { class: "cols" },
    el("div", {}, el("h4", { text: title + (fault ? " · fault" : "") }), el("p", { class: "hint", text: description }),
      fields([["frame", frame.id], ["part", el("span", {}, partButton(frame.part), " " + partLabel(frame.part))],
        frame.targets?.length ? ["targets", el("span", {}, frame.targets.map(partButton))] : null,
        ["time", "batch " + count(frame.atBatch) + " · " + timeOf(frame.atBatch)],
        ["hardware", op ? op.id + " " + op.op + " · " + (op.source ?? "") : frame.source ?? "none"],
        frame.pc !== undefined ? ["pc", hex(frame.pc) + (frame.state?.text ? "  " + frame.state.text : "")] : null])),
    el("div", {}, el("h4", { text: "State committed by this frame" }),
      fields(Object.entries(frame.state ?? {}).filter(([k]) => k !== "text").map(([k, v]) => [k, showValue(k, v)]))),
    el("div", {}, el("h4", { text: "Causes" }),
      el("div", {}, frame.parents?.length ? frame.parents.map((id) => frameButton(id)) : frame.op === "edge" ? "A scripted input. It has no cause inside the model." : "Program start"),
      chain.length > 1 ? el("p", { class: "hint" }, "Chain back to the core instruction: ", chain.flatMap((f, k) => [k ? " → " : "", frameButton(f.id, f.id + " " + f.op)])) : null)));
}

function paintMachine() {
  const open = state.openWindows, hub = state.hub;
  const status = (c) => (c.stopped ? "stopped: " + c.stopped : c.waiting ? "stalled on " + c.waiting.register : "running");
  put($("machineState"), el("div", { class: "cols" },
    el("div", {}, el("h4", { text: "Cores" }), el("table", {}, el("thead", {}, el("tr", {}, ["core", "status", "last pc", "last instruction", "working on"].map((t) => el("th", { text: t })))),
      el("tbody", {}, state.cores.map((c) => el("tr", {}, el("td", {}, partButton(c.name)), el("td", { text: status(c) }), el("td", { text: hex(c.pc) }), el("td", { text: c.lastText ?? "" }), el("td", { text: c.lastSource ?? "" })))))),
    el("div", {}, el("h4", { text: count(open.length) + (open.length === 1 ? " window" : " windows") + " open at batch " + count(state.atBatch) }),
      open.length ? el("table", {}, el("tbody", {}, open.slice(0, 30).map((w) => el("tr", {}, el("td", {}, partButton(w.part)), el("td", { text: w.source }), el("td", { text: w.opens + "–" + w.closes }), el("td", { text: w.converter }),
        el("td", { text: layers.bindingOf(run, w)?.part ?? "" }))))) : el("p", { class: "hint", text: "None." }),
      el("h4", { text: "Hub" }),
      fields([["group words", hub.groups.map((w) => hex(w)).join(" ")],
        ["open barriers", hub.barriers.length ? hub.barriers.map((b) => "barrier " + b.barrier + ": " + b.arrived.length + " of " + b.expected).join(" · ") : "none"],
        ["waiting", hub.waiting.length ? count(hub.waiting.length) : "none"], ["dropped", hub.dropped ? count(hub.dropped) : "none"]]))));
}

const traceList = createList($("trace"), 7, "trace-row", (row, i) => {
  const f = run.frames[i], c = row.children;
  c[0].textContent = count(i + 1);
  c[1].textContent = count(f.atBatch);
  c[2].textContent = timeOf(f.atBatch);
  c[3].textContent = f.op;
  c[4].textContent = f.part;
  c[5].textContent = f.source ?? "";
  c[6].textContent = f.id;
  if (faultSet.has(i)) row.classList.add("faulty");
  if (i === index) row.setAttribute("aria-current", "true");
}, { pick: (i) => jump(i) });

let dockTab = "inspector";
for (const b of document.querySelectorAll(".tabs [data-tab]"))
  b.onclick = () => {
    dockTab = b.dataset.tab;
    $("dock").classList.remove("folded");
    for (const t of document.querySelectorAll(".tabs [data-tab]")) t.setAttribute("aria-selected", String(t === b));
    for (const p of document.querySelectorAll(".dock .pane")) p.hidden = p.dataset.pane !== dockTab;
    schedule();
  };
$("foldDock").onclick = () => {
  $("dock").classList.toggle("folded");
  $("foldDock").textContent = $("dock").classList.contains("folded") ? "▴" : "▾";
};

// ───────────────────────────── painting ─────────────────────────────

let lastFollow = null;
function paint() {
  dirty = false;
  if (!run) return;
  const frame = run.frames[index], fault = faultSet.has(index);
  state = model.stateAt(run, index);
  focus = layers.focusAt(run, index, state);
  const { ir } = layers.programLayers(run);
  // Layer highlights: the step's own rows, and the rows of instructions whose windows are open.
  const op = focus.op ?? model.hardwareOp(run, state.cores[focus.core]?.lastSource)?.op;
  const opRow = op ? ix.row.get(op.id) : undefined;
  const running = new Set(state.openWindows.map((w) => ix.row.get(w.source)).filter((k) => k !== undefined));
  const core = fwCore();
  lit = {
    source: new Set(focus.source.length ? focus.source : opRow !== undefined ? ix.origin[opRow].source : []),
    ir: new Set(focus.ir.length ? focus.ir : opRow !== undefined ? ix.origin[opRow].ir : []),
    hw: new Set(opRow !== undefined ? [opRow] : []),
    fw: new Set(core === focus.core && focus.row >= 0 ? [focus.row] : []),
    runSource: new Set([...running].flatMap((k) => ix.origin[k].source)),
    runIr: new Set([...running].flatMap((k) => ix.origin[k].ir)),
    runHw: running,
    region: new Set(op ? layers.firmwareRowsOf(run, core, op.id) : []),
  };
  if ($("fwCore").dataset.shown !== String(core)) {
    $("fwCore").dataset.shown = String(core);
    fwList.setCount(layers.firmware(run, core).length, "This bundle carries no firmware image for this core.");
    $("fwNote").textContent = count(layers.firmware(run, core).length) + " words";
    lastFollow = null;
  }
  if ($("follow").checked) {
    const key = [index, core].join("/");
    if (key !== lastFollow) {
      lastFollow = key;
      sourceList.reveal([...lit.source][0] ?? -1);
      if (ir) irList.reveal([...lit.ir][0] ?? -1);
      hwList.reveal(opRow ?? -1);
      fwList.reveal(focus.row >= 0 && core === focus.core ? focus.row : [...lit.region][0] ?? -1);
    }
  }
  renderLists();
  // The stage. While playing, moving things are drawn at the playback clock, between frames.
  const shown = clockBatch ?? state.atBatch;
  const extra = { active: layers.activeDevices(run, state), hint };
  if (run.platform === "qccd") extra.ions = layers.ionPositions(run, shown);
  if (run.platform === "neutral") {
    extra.atoms = layers.atomPositions(run, shown);
    extra.tones = new Map(model.tonesAt(run, shown).map((t) => [t.part, t.um]));
    extra.openParts = state.openWindows.map((w) => w.part);
  }
  // Electrical signals in flight on their wires, and the light of the optical benches.
  lightIndex = new Map();
  const carriers = new Map((run.platform === "superconducting" ? benches.microwaveAt(run, state) : []).map((m) => [m.window?.id ?? m.id, m]));
  if (bench?.trains?.length) {
    const beams = benches.beamsAt(run, bench, state, { tones: extra.tones ?? new Map() });
    const scene = lightScene(stage.world(), bench, beams, { height: run.platform === "neutral" ? 90 : 60, elements: benchElements });
    extra.beams = scene.close.map((c) => ({ ...c, colour: wavelengthRgb(c.lambdaNm).rgb }));
    extra.table = scene.table;
    for (const [key, record] of scene.records) lightIndex.set(key, record);
  }
  extra.signals = signalsAt(run, state, shown).map((s) => {
    const freqMHz = s.window.freq !== undefined ? s.window.freq : null;
    const mw = carriers.get(s.window.id);
    lightIndex.set("signal:" + s.id, {
      kind: { drive: "Drive pulse", "cz-drive": "CZ pulse", "readout-tone": "Readout tone", acquire: "Returning readout signal" }[s.kind] ?? "RF drive",
      title: s.binding.id + " → " + s.binding.part,
      text: s.kind === "acquire" ? "The signal reflected by the resonator travels back to the ADC, which demodulates it during this window."
        : run.platform === "superconducting" ? "A pulse leaves the DAC when its window opens and reaches " + s.binding.part + " after the wire's delay."
        : /^electrodes:/.test(s.binding.part) ? "The DAC plays the transport waveform on the electrodes of " + s.binding.part.replace(/^electrodes:(zone\.)?/, "") + "."
        : "The DAC plays the RF tone of the acousto-optic modulator or deflector that switches and steers this light. The light itself is drawn as its beam.",
      lines: [["window", s.window.id + " · batches " + s.window.opens + "–" + s.window.closes], ["converter", s.window.converter],
        ["wire delay", model.formatTime(s.binding.delayPs ?? 0)], ["elapsed", model.formatTime(s.elapsedPs) + (s.t < 1 ? " · in flight" : " · arrived")],
        ...(mw?.carrierHz ? [["carrier", (mw.carrierHz / 1e9).toFixed(6) + " GHz"]] : []), ...(mw?.ampFraction !== undefined ? [["amplitude", (100 * mw.ampFraction).toFixed(2) + " % of full scale"]] : []),
        ["frequency code", String(freqMHz)], ["amplitude code", String(s.window.amp)], ["instruction", s.window.source ?? "—"]],
      source: "Delay: routed wire length ÷ signal speed (riscq/design.mjs, machine/interconnect.mjs)",
    });
    return { ...s, glowAt: s.to, glowSize: 9 };
  });
  stage.show(frame, state, frame ? model.causalPath(run, frame.id) : [], chosen, fault, extra);
  twin?.setTime(((shown - run.derived.trackBaseBatch) * period()) / 1000);
  paintNow(frame, fault);
  paintOffview(frame);
  paintTrack();
  paintKinds();
  paintSelection();
  if (dockTab === "inspector") paintInspector(frame, fault);
  if (dockTab === "machine") paintMachine();
  if (dockTab === "trace") {
    traceList.reveal(index);
    traceList.render();
  }
  $("counter").textContent = count(index + 1) + " / " + count(run.frames.length);
  $("step").value = index + 1;
  $("back").disabled = $("first").disabled = index < 0;
  $("next").disabled = index >= run.frames.length - 1;
  const after = (list) => list.find((k) => k > index) ?? -1;
  $("nextPulse").disabled = after(stopLists.pulse) < 0;
  $("nextFault").disabled = after(stopLists.fault) < 0;
  $("nextInstruction").disabled = after(stopLists.instruction) < 0;
  if (!playing) syncAddress();
}

// hint repaints the stage only; it is cheap enough to go through paint.
// ───────────────────────────── loading ─────────────────────────────

function check(bundle) {
  const whole = bundle?.kind === "riscq-run" && Array.isArray(bundle.frames) && Array.isArray(bundle.system?.parts) &&
    Array.isArray(bundle.machine?.cores) && Array.isArray(bundle.hardware?.segments) && bundle.summary?.cores && bundle.initial;
  if (!whole) throw Error("This is not a RISC-Q run bundle (kind \"riscq-run\" with machine, hardware, system, initial, frames and summary).");
  return bundle;
}

const isCalls = () => run?.source?.language === "System calls";
const editable = () => (/^OpenQASM/.test(run?.source?.language ?? "") && ["superconducting", "qccd"].includes(run.platform)) || isCalls();

function show(bundle, text, keepStep) {
  check(bundle);
  stop();
  run = bundle;
  runText = text;
  chosen = null;
  link = hint = null;
  kindCursor = {};
  buildIndex();
  const predicates = model.stops(run);
  for (const name of Object.keys(stopLists)) {
    stopLists[name] = [];
    for (let i = model.nextIndex(run, -1, predicates[name]); i >= 0; i = model.nextIndex(run, i, predicates[name])) stopLists[name].push(i);
  }
  faultSet = new Set(stopLists.fault);
  index = keepStep ? Math.min(index, run.frames.length - 1) : -1;
  if (pendingStep !== null) {
    index = Math.min(run.frames.length - 1, Math.max(-1, pendingStep));
    pendingStep = null;
  }
  $("step").max = run.frames.length;
  $("export").disabled = false;
  // The layers.
  const { source, ir } = layers.programLayers(run);
  $("sourceLanguage").textContent = source.language + (source.note ? " · " + source.note : "");
  sourceList.setCount(source.lines.length, "No source text.");
  $("layerIr").hidden = $("arrowIr").hidden = !ir;
  if (ir) {
    $("irLanguage").textContent = ir.language;
    irList.setCount(ir.lines.length);
  }
  $("arrowHw").textContent = ir ? "replayed by QCCD Studio as" : run.platform === "decoder" ? "phases of" : "scheduled as";
  $("hwNote").textContent = count(ix.ops.length) + " in " + run.hardware.segments.length + (run.hardware.segments.length === 1 ? " segment" : " segments") + " · one batch is " + model.formatTime(period());
  hwList.setCount(ix.ops.length, "This program has no hardware instruction.");
  put($("fwCore"), el("option", { value: "follow", text: "acting core" }), run.machine.cores.map((c, k) => el("option", { value: k, text: c.name })));
  $("fwCore").value = coreChoice = "follow";
  $("fwCore").dataset.shown = "";
  traceList.setCount(run.frames.length);
  // Metrics.
  const s = run.summary;
  put($("metrics"), [["machine", run.machine.name], ["platform", run.platform], ["cores", run.machine.cores.length], ["frames", count(run.frames.length)],
    ["runtime", model.formatTime(s.elapsedPs)], ["instructions", count(ix.ops.length)], ["faults", s.faults.length]].map(([k, v]) =>
    el("span", { class: "m" + (k === "faults" && v ? " bad" : ""), title: k === "faults" && v ? s.faults.slice(0, 5).map((f) => f.part + ": " + f.reason).join("\n") : "" }, k, el("b", { text: String(v) }))));
  // Write pane.
  $("writeNote").textContent = editable() ? "Edit the " + run.source.language + " source and run it on this " + run.platform + " machine. The server compiles it, lowers it to firmware and executes the firmware in the Lean model."
    : "This run's source (" + (run.source?.language ?? "none") + ") cannot be recompiled from the page. Choose an OpenQASM or system-call program to write your own.";
  $("sourceEdit").disabled = $("runSource").disabled = $("resetSource").disabled = !editable();
  if (editable() && program?.qasm === undefined && program?.calls === undefined) $("sourceEdit").value = run.source.text;
  // The optical bench of a laser platform: its trains, elements and their hover records.
  try {
    bench = benches.benchFor(run);
    benchElements = bench?.trains?.length ? benches.benchElements(bench) : [];
  } catch (error) {
    bench = null;
    benchElements = [];
    note("The optical bench could not be built: " + error.message);
  }
  opticIndex = new Map(benchElements.map((e) => ["optic:" + e.label, e]));
  stage.setRun(run, view);
  mountReproduction();
  paintKinds();
  paint();
  // The hardware editor opens the design of this run, or a fresh one when the run has none.
  $("designLink").textContent = run.machine.design ? "Edit this hardware" : "Design hardware";
  $("designLink").onclick = () => {
    if (!run.machine.design) return;
    try {
      // A reproduction hands over its id: the editor then reruns the paper's own program on the edited chip.
      const reproduction = /^reproduction:/.test(run.example?.id ?? "") ? run.example.id : undefined;
      localStorage.setItem("riscq-design:edit", JSON.stringify(reproduction ? { design: run.machine.design, reproduction } : { design: run.machine.design, qasm: run.source.text }));
      $("designLink").href = "/riscq-design?from=run";
    } catch {
      /* Without storage the editor opens its own last design. */
    }
  };
}

async function load(next, keepStep = false, report = note) {
  const mine = ++token;
  put($("now"), el("div", { class: "k", text: next.example ? "Running " + next.example + " on the server…" : "Compiling and running…" }));
  try {
    let response;
    const query = new URLSearchParams(next.example ? { example: next.example } : {});
    if (next.example && next.design)
      // A reproduction on a chip edited in /riscq-design: the paper's program on that chip.
      response = await fetch("/api/riscq/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ example: next.example, design: next.design }) });
    else if (next.example) {
      for (const [bit, value] of Object.entries(outcomes)) if (value) query.append("outcome", bit + "=" + value);
      response = await fetch("/api/riscq/run?" + query);
    } else
      response = await fetch("/api/riscq/run", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: next.platform, ...(next.calls ? { calls: next.calls } : { qasm: next.qasm }), ...(next.design ? { design: next.design } : {}), outcomes }) });
    const text = await response.text();
    if (mine !== token) return;
    if (!response.ok) throw Error(text);
    const bundle = check(JSON.parse(text));
    program = next;
    note("");
    report("");
    $("example").value = next.example ?? "";
    show(bundle, text, keepStep);
  } catch (error) {
    if (mine !== token) return;
    report(error.message);
    if (run) paint();
  }
}

// ───────────────────────────── controls ─────────────────────────────

for (const b of document.querySelectorAll(".views button")) b.onclick = () => setView(b.dataset.view);
$("example").onchange = (e) => {
  outcomes = {};
  load({ example: e.target.value });
};
$("home").onclick = () => stage.home();
$("first").onclick = () => jump(-1);
$("back").onclick = () => jump(index - 1);
$("next").onclick = () => jump(index + 1);
$("step").oninput = (e) => jump(Number(e.target.value) - 1);
$("nextPulse").onclick = () => jump(stopLists.pulse.find((k) => k > index) ?? index);
$("nextFault").onclick = () => jump(stopLists.fault.find((k) => k > index) ?? index);
$("nextInstruction").onclick = () => jump(stopLists.instruction.find((k) => k > index) ?? index);
$("fwCore").onchange = (e) => {
  coreChoice = e.target.value;
  schedule();
};
$("follow").onchange = () => {
  lastFollow = null;
  schedule();
};
$("play").onclick = () => {
  if (!run) return;
  if (playing) return stop();
  if (index >= run.frames.length - 1) index = -1;
  playing = true;
  playClock = performance.now();
  playCarry = 0;
  $("play").textContent = "Pause";
  // "time:<s>" plays the whole run in s seconds of wall time, with motion between frames.
  // A number plays that many trace steps per second.
  const [mode, amount] = String($("speed").value).split(":");
  const end = Math.max(1, run.summary.elapsedBatches ?? run.frames.at(-1)?.atBatch ?? 1);
  if (mode === "time") clockBatch = Math.max(0, run.frames[index]?.atBatch ?? 0);
  requestAnimationFrame(function tick(now) {
    if (!playing) return;
    const seconds = (now - playClock) / 1000;
    playClock = now;
    if (mode === "time") {
      clockBatch = Math.min(end, clockBatch + (seconds * end) / Number(amount));
      const next = model.indexAtBatch(run, clockBatch);
      if (next !== index) jump(next, true);
      else schedule();
      if (clockBatch >= end) {
        jump(run.frames.length - 1, true);
        stop();
        syncAddress();
        return;
      }
    } else {
      playCarry += seconds * Number(mode);
      const steps = Math.floor(playCarry);
      playCarry -= steps;
      if (steps) jump(index + steps, true);
      if (index >= run.frames.length - 1) {
        stop();
        syncAddress();
        return;
      }
    }
    requestAnimationFrame(tick);
  });
};
$("explain").onclick = () => {
  const on = document.body.classList.toggle("explaining");
  $("explain").setAttribute("aria-pressed", String(on));
};
$("export").onclick = () => {
  if (!run) return;
  const url = URL.createObjectURL(new Blob([runText], { type: "application/json" }));
  el("a", { href: url, download: "riscq-" + (run.example?.id ?? "custom") + ".json" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("open").onclick = () => $("runFile").click();
$("runFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const bundle = check(JSON.parse(text));
    token++;
    program = null;
    $("example").value = "";
    show(bundle, text, false);
    note("");
  } catch (error) {
    note(error.message);
  }
};
const sourceError = (message) => {
  $("sourceError").textContent = message;
  $("sourceError").hidden = !message;
};
$("runSource").onclick = () => {
  if (!run) return;
  // A run on a hardware design reruns on the same design.
  const design = run.machine.design ? { design: run.machine.design } : {};
  if (!isCalls()) return load({ platform: run.platform, qasm: $("sourceEdit").value, ...design }, false, sourceError);
  let calls;
  try {
    calls = JSON.parse($("sourceEdit").value);
  } catch (error) {
    return sourceError("The system-call program is not valid JSON: " + error.message);
  }
  load({ platform: run.platform, calls, ...design }, false, sourceError);
};
$("resetSource").onclick = () => {
  if (run) $("sourceEdit").value = run.source.text;
  sourceError("");
};
// Panel sizes, hiding and present mode: panels.js.
document.addEventListener("keydown", (e) => {
  if (!run || e.ctrlKey || e.metaKey || e.altKey || ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  const move = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: -1, End: run.frames.length - 1 }[e.key];
  if (move !== undefined) {
    e.preventDefault();
    return jump(move);
  }
  const keys = { " ": () => $("play").click(), n: () => $("nextInstruction").click(), p: () => $("nextPulse").click(), f: () => stage.home(),
    h: () => $("explain").click(), 1: () => setView("chip"), 2: () => setView("control"), 3: () => setView("machine") };
  if (keys[e.key] && !(e.key === " " && e.target.tagName === "BUTTON")) {
    e.preventDefault();
    keys[e.key]();
  }
});
new ResizeObserver(() => run && paintTrack()).observe(track);

try {
  const response = await fetch("/api/riscq/examples");
  const text = await response.text();
  if (!response.ok) throw Error(text);
  examples = JSON.parse(text);
  put($("example"), el("option", { value: "", text: "Custom or opened run", hidden: true }),
    examples.map((e) => el("option", { value: e.id, text: e.title + " · " + e.platform, title: e.description })));
  $("example").disabled = false;
  const query = new URLSearchParams(location.search);
  for (const item of query.getAll("outcome")) outcomes[item.split("=")[0]] = Number(item.split("=")[1]);
  if (query.has("step")) pendingStep = Number(query.get("step")) - 1;
  if (layers.VIEWS[query.get("view")]) {
    view = query.get("view");
    for (const b of document.querySelectorAll(".views button")) b.setAttribute("aria-selected", String(b.dataset.view === view));
  }
  // ?design=run: the hardware design and program the editor (/riscq-design) handed over.
  let handed = null;
  try {
    if (query.get("design") === "run") handed = JSON.parse(localStorage.getItem("riscq-design:run") ?? "null");
  } catch {
    handed = null;
  }
  const wanted = examples.find((e) => e.id === query.get("example")) ?? examples[0];
  if (handed?.design && handed.reproduction) await load({ example: handed.reproduction, design: handed.design });
  else if (handed?.design) await load({ platform: "superconducting", qasm: handed.qasm, design: handed.design });
  else if (wanted) await load({ example: wanted.id });
} catch (error) {
  note(error.message);
}
