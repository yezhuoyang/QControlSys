// The hardware design page: one hardware document (riscq/hw/document.mjs, kind "riscq-design",
// version 2), built and edited in 3D. The scene is the /machines installation of the document's
// device (studio/machine-scene.js: cryostat, optical table or vacuum chamber, and their lines) with
// the document's RISC-Q boards; the run pages draw the same document. Parts that are 2D in nature
// (the chip, the atom array, the trap, a board's cores) open a 2D detail editor (studio/hw/editor2d.js).
import * as T from "three";
import { TransformControls } from "/three/TransformControls.js";
import { createStage, buildScene, showView } from "/hw/machine3d.js";
import { openDetail } from "/hw/editor2d.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const DEVICE_KIND = { superconducting: "transmon", neutral: "atom", qccd: "ion" };
const PLATFORM_WORD = { superconducting: "Superconducting", neutral: "Neutral atoms", qccd: "Trapped ions" };
const ZCU216_MM = [180, 14, 130];
const round = (v) => Math.round(v * 10) / 10;

let doc = null, system = null, built = null, current = null, selected = null, undoStack = [], partIds = new Set();
let groups = new Map();

// ---------------------------------------------------------------- the stage (shared with the run pages: studio/hw/machine3d.js)
const host = $("stage");
const stage = createStage(host);
const { renderer, camera, orbit, render, fit } = stage;
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setMode("translate");
gizmo.setSize(0.8);
stage.scene.add(gizmo.getHelper());
gizmo.addEventListener("change", render);
let moving = false;
gizmo.addEventListener("dragging-changed", (e) => {
  orbit.enabled = !e.value;
  if (e.value) moving = true;
  else { moving = false; commitMove(); }
});

// ---------------------------------------------------------------- the document → the scene
function rebuild({ refit = false } = {}) {
  if (current) { stage.scene.remove(current.root); current.dispose(); }
  gizmo.detach();
  current = buildScene(doc);
  ({ system, built, groups, partIds } = current);
  stage.scene.add(current.root);
  paintOutline();
  paintFacts();
  $("json").textContent = JSON.stringify(doc, null, 1).slice(0, 200000);
  $("undo").disabled = !undoStack.length;
  if (refit) setView("all");
  render();
  if (selected && groups.has(selected)) select(selected, { focus: false });
  else { selected = null; paintInspector(); }
}

function setView(v) {
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
  showView(stage, current, doc, v);
}
document.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => setView(b.dataset.view)));

// ---------------------------------------------------------------- what the document holds
const roleCount = (cores) => Object.entries(cores.reduce((m, c) => ((m[c.role] = (m[c.role] ?? 0) + 1), m), {})).map(([r, n]) => n + " " + r).join(", ");

function paintFacts() {
  const cores = doc.control.boards.reduce((n, b) => n + b.cores.length, 0);
  $("facts").textContent = PLATFORM_WORD[doc.platform] + " · " + doc.device.qubits.length + " qubits · " + doc.control.boards.length + " RISC-Q board" +
    (doc.control.boards.length === 1 ? "" : "s") + " · " + cores + " cores · " + system.parts.length + " parts";
  const src = doc.source;
  const href = src?.kind === "reproduction" ? "/reproduce/" + src.id : src?.kind === "example" ? "/examples/" + src.id : null;
  $("runs").hidden = !href;
  if (href) $("runs").href = href;
}

function paintOutline() {
  const mine = new Set(doc.parts.map((p) => p.id)), extras = new Set((doc.extras ?? []).map((p) => p.id));
  const chip = system.equipment?.chip;
  const sections = [
    ["Device", system.parts.filter((p) => p.id === chip)],
    ["Control system", system.parts.filter((p) => mine.has(p.id))],
    ["Installation", system.parts.filter((p) => p.id !== chip && !mine.has(p.id) && !extras.has(p.id))],
    ["Added by you", system.parts.filter((p) => extras.has(p.id))],
  ].filter(([, ps]) => ps.length);
  $("outline").innerHTML = sections.map(([title, ps], k) => `<details ${k < 2 ? "open" : ""}><summary>${esc(title)} (${ps.length})</summary>${
    ps.map((p) => `<button type="button" data-part="${esc(p.id)}" title="${esc(p.label)}" aria-current="${p.id === selected}">${esc(p.label ?? p.id)}</button>`).join("")}</details>`).join("") +
    `<p class="hint">${system.links.length} cables and beam paths, routed from the parts they join.</p>`;
  $("outline").querySelectorAll("[data-part]").forEach((b) => (b.onclick = () => select(b.dataset.part)));
}

function paintInspector() {
  const el = $("inspector");
  if (!selected) { el.innerHTML = `<p class="hint">Nothing selected. Click a part in the scene or in the list.</p>`; return; }
  const p = system.parts.find((x) => x.id === selected);
  const board = doc.control.boards.find((b) => "board" + b.index === p.id);
  const isChip = p.id === system.equipment?.chip;
  const detail = isChip ? { superconducting: "Edit the chip in 2D", neutral: "Edit the atom array in 2D", qccd: "Edit the trap in 2D" }[doc.platform] : board ? "Open the board in 2D" : null;
  const where = doc.parts.some((x) => x.id === p.id) ? "the control system" : (doc.extras ?? []).some((x) => x.id === p.id) ? "parts you added (drawn, not yet wired into the run)" : isChip ? "the device" : "the installation";
  el.innerHTML = `<div class="insp"><h3>${esc(p.label ?? p.id)}</h3>
    <dl><dt>Part</dt><dd>${esc(p.form ?? Object.keys(p.model ?? {})[0] ?? "")}</dd><dt>In</dt><dd>${esc(where)}</dd>
    <dt>Size</dt><dd>${p.sizeMm.map((v) => round(v)).join(" × ")} mm</dd>
    ${board ? `<dt>Cores</dt><dd>${board.cores.length}${board.cores.length ? " (" + esc(roleCount(board.cores)) + ")" : ""}</dd>` : ""}
    ${isChip ? `<dt>Qubits</dt><dd>${doc.device.qubits.length}</dd>` : ""}</dl>
    <div>Centre (mm)</div><div class="xyz">${p.centerMm.map((v, k) => `<input type="number" step="1" data-k="${k}" value="${round(v)}" aria-label="${"xyz"[k]} in mm">`).join("")}</div>
    <div class="actions">${detail ? `<button type="button" class="primary" id="detail2d">${esc(detail)}</button>` : ""}
      <button type="button" id="focus">Look at it</button>
      ${board && doc.control.boards.length > 1 && !board.cores.length ? `<button type="button" id="remove">Remove</button>` : ""}
      ${(doc.extras ?? []).some((x) => x.id === p.id) ? `<button type="button" id="remove">Remove</button>` : ""}</div>
    <p class="basis">${esc(p.basis ?? "")}</p></div>`;
  el.querySelectorAll(".xyz input").forEach((input) => (input.onchange = () => {
    const c = [...p.centerMm];
    c[Number(input.dataset.k)] = Number(input.value);
    moveTo(p.id, c);
  }));
  $("focus").onclick = () => fit([groups.get(p.id)]);
  if ($("detail2d")) $("detail2d").onclick = () => openDetail(isChip ? doc.platform : "zcu216", doc, { board, onChange: change, close: () => $("detail").hidden = true });
  if ($("remove")) $("remove").onclick = () => change((d) => {
    d.parts = d.parts.filter((x) => x.id !== p.id);
    d.extras = (d.extras ?? []).filter((x) => x.id !== p.id);
    d.control.boards = d.control.boards.filter((b) => "board" + b.index !== p.id);
    d.device.drives = d.device.drives.filter((x) => x.probe !== p.id);
    selected = null;
  });
}

function select(id, { focus = false } = {}) {
  selected = id;
  const g = groups.get(id);
  if (g) gizmo.attach(g); else gizmo.detach();
  if (focus && g) fit([g]);
  paintInspector();
  $("outline").querySelectorAll("[data-part]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.part === id)));
}

// ---------------------------------------------------------------- editing
function change(edit, { refit = false } = {}) {
  undoStack.push(JSON.stringify(doc));
  if (undoStack.length > 60) undoStack.shift();
  edit(doc);
  rebuild({ refit });
}
$("undo").onclick = () => {
  if (!undoStack.length) return;
  doc = JSON.parse(undoStack.pop());
  rebuild();
};

/** Move a part: a board moves itself, the device moves the whole installation, any other part keeps its own position. */
function moveTo(id, centerMm) {
  const c = centerMm.map(round);
  change((d) => {
    const own = d.parts.find((x) => x.id === id) ?? (d.extras ?? []).find((x) => x.id === id);
    if (own) own.centerMm = c;
    else if (id === system.equipment?.chip) {
      const old = system.parts.find((x) => x.id === id).centerMm;
      d.device.centerMm = d.device.centerMm.map((v, k) => round(v + c[k] - old[k]));
    } else (d.install ??= {})[id] = { centerMm: c };
  });
}
function commitMove() {
  const g = groups.get(selected);
  if (g) moveTo(selected, g.position.toArray());
}

// Clicks select (a drag of the view does not).
let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || moving || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ray = new T.Raycaster();
  ray.setFromCamera(new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  for (const hit of ray.intersectObject(built.root, true)) {
    let o = hit.object;
    while (o && !partIds.has(o.userData.part)) o = o.parent;
    if (o) return select(o.userData.part);
  }
});

// ---------------------------------------------------------------- the parts palette
function paintPalette() {
  const bricks = [["zcu216", "RISC-Q board (ZCU216)", "#1f5a44"]];
  const detail = { superconducting: "Transmon chip", neutral: "Atom array", qccd: "Ion trap" }[doc.platform];
  // Every kind of part this machine's installation is built from can be added again.
  const seen = new Map();
  for (const p of system.parts) if (p.form && !["register", "zcu216"].includes(p.form) && !seen.has(p.form)) seen.set(p.form, p);
  $("palette").innerHTML = `<button type="button" data-brick="chip"><span class="sw" style="background:#5fa8d3"></span><span class="lbl">${esc(detail)} (2D)</span></button>` +
    bricks.map(([id, label, color]) => `<button type="button" data-brick="${id}"><span class="sw" style="background:${color}"></span><span class="lbl">${esc(label)}</span></button>`).join("") +
    [...seen.values()].slice(0, 18).map((p) => `<button type="button" data-brick="form:${esc(p.form)}" title="${esc(p.label)}"><span class="sw" style="background:#8a9aa2"></span><span class="lbl">${esc((p.label ?? p.form).replace(/ \d+$/, "").replace(/ [·(].*$/, ""))}</span></button>`).join("");
  $("palette").querySelectorAll("[data-brick]").forEach((b) => (b.onclick = () => addBrick(b.dataset.brick)));
}

function addBrick(kind) {
  if (kind === "chip") return openDetail(doc.platform, doc, { onChange: change, close: () => ($("detail").hidden = true) });
  if (kind === "zcu216") {
    const index = Math.max(-1, ...doc.control.boards.map((b) => b.index)) + 1, k = doc.control.boards.length;
    const last = doc.parts.find((p) => p.form === "zcu216");
    const at = last ? [round(last.centerMm[0] + ZCU216_MM[0] + 40), last.centerMm[1], last.centerMm[2]] : [0, ZCU216_MM[1] / 2, 420];
    return change((d) => {
      d.parts.push({ id: "board" + index, label: "RISC-Q board " + index + " (AMD ZCU216) · 0 cores", form: "zcu216", model: { zcu216: { board: index, cores: 0 } },
        centerMm: k % 8 === 0 && last ? [d.parts[0].centerMm[0], last.centerMm[1], round(last.centerMm[2] + ZCU216_MM[2] + 60)] : at, sizeMm: [...ZCU216_MM], board: index,
        basis: "An AMD ZCU216 board running RISC-Q, added by you. Give it cores in its 2D view." });
      d.control.boards.push({ id: "board" + index, index, cores: [] });
      selected = "board" + index;
    });
  }
  const form = kind.slice(5), like = system.parts.find((p) => p.form === form);
  const n = (doc.extras ?? []).length;
  change((d) => {
    const id = "extra" + n + "-" + form;
    (d.extras ??= []).push({ id, label: like.label + " (added)", form, centerMm: like.centerMm.map((v, k) => round(v + (k === 0 ? like.sizeMm[0] * 1.5 + 10 : 0))), sizeMm: like.sizeMm,
      basis: "Added by you: drawn in the machine, not yet wired into the run." });
    selected = id;
  });
}

// ---------------------------------------------------------------- build from scratch
let building = null;
$("build").onclick = () => {
  if (building) { clearInterval(building); building = null; for (const g of built.root.children) g.visible = true; $("caption").hidden = true; $("build").textContent = "Build from scratch"; return; }
  const chip = system.equipment?.chip, mine = new Set(doc.parts.map((p) => p.id));
  const c = new T.Vector3(...(system.parts.find((p) => p.id === chip)?.centerMm ?? [0, 0, 0]));
  const install = system.parts.filter((p) => p.id !== chip && !mine.has(p.id)).sort((a, b) => new T.Vector3(...a.centerMm).distanceTo(c) - new T.Vector3(...b.centerMm).distanceTo(c));
  const steps = [
    ...[system.parts.find((p) => p.id === chip)].filter(Boolean).map((p) => [p.id, "The " + (DEVICE_KIND[doc.platform] === "transmon" ? "chip" : DEVICE_KIND[doc.platform] === "atom" ? "atom array" : "trap") + ": " + doc.device.qubits.length + " qubits"]),
    ...install.map((p) => [p.id, p.label]),
    ...doc.parts.map((p) => [p.id, p.label]),
    ["@cables", system.links.length + " cables and beam paths"],
  ];
  for (const g of built.root.children) g.visible = false;
  fit([built.root]);
  $("build").textContent = "Stop building";
  let i = 0;
  const per = Math.max(1, Math.ceil(steps.length / 60));
  building = setInterval(() => {
    for (let k = 0; k < per && i < steps.length; k++, i++) {
      const [id, label] = steps[i];
      if (id === "@cables") for (const g of built.root.children) g.visible = true;
      else if (groups.get(id)) groups.get(id).visible = true;
      render();
      $("caption").hidden = false;
      $("caption").textContent = "Step " + (i + 1) + " of " + steps.length + ": " + label;
    }
    if (i >= steps.length) {
      clearInterval(building);
      building = null;
      for (const g of built.root.children) g.visible = true;
      $("build").textContent = "Build from scratch";
      setTimeout(() => ($("caption").hidden = true), 2500);
    }
  }, 180);
};

// ---------------------------------------------------------------- open, save
$("save").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }));
  a.download = (doc.id ?? "machine").replace(/[^a-z0-9-]+/gi, "-") + ".json";
  a.click();
};
$("file").onchange = async () => {
  const text = await $("file").files[0].text();
  const d = JSON.parse(text);
  if (d.kind !== "riscq-design" || d.version !== 2) return alert("This is not a hardware document (kind \"riscq-design\", version 2).");
  undoStack = [];
  load(d);
};

function load(d) {
  doc = d;
  selected = null;
  rebuild({ refit: true });
  paintPalette();
}

// ---------------------------------------------------------------- run a program on this machine
let player = null;
async function runProgram() {
  const out = $("runout"), program = $("program").value;
  out.innerHTML = `<p class="hint">Running ${esc($("program").selectedOptions[0]?.textContent ?? program)} on this machine… (the OS schedules it, then the cycle-exact model runs it; seconds to a minute)</p>`;
  $("run").disabled = true;
  try {
    const sent = JSON.parse(JSON.stringify(doc));
    const r = await (await fetch("/api/hw/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: sent, program }) })).json();
    if (r.error) {
      out.innerHTML = `<p class="bad">✗ ${esc(r.error)}</p><p class="hint">${/not device qubits|no coupler|does not fit/.test(r.error)
        ? "Open the device in 2D and add the qubits or couplers the program needs, or choose a smaller program." : ""}</p>`;
      return;
    }
    out.innerHTML = `<p class="${r.conforms ? "ok" : "bad"}">${r.conforms ? "✓ Every operation ran inside its window on this machine." : "✗ " + esc(r.columns?.Result ?? "it does not conform")}</p>
      <dl>${Object.entries(r.columns ?? {}).filter(([k]) => k !== "Program").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      ${r.track ? `<button type="button" class="primary" id="playrun">Play the run on this machine</button>` : ""}`;
    if (r.track) $("playrun").onclick = () => play(r, sent);
  } catch (e) {
    out.innerHTML = `<p class="bad">✗ ${esc(e.message)}</p>`;
  } finally {
    $("run").disabled = false;
  }
}
/** Play a run on the document it ran on (studio/hw/machine3d.js, the run pages' player). */
async function play(r, ranOn) {
  const { mountMachine } = await import("/hw/machine3d.js");
  $("play").hidden = false;
  $("playtitle").textContent = r.label;
  $("playnote").textContent = "The run plays on the machine as it was when you ran it: every pulse, move, readout and decode at the time the cycle-exact model executed it.";
  player?.dispose();
  player = mountMachine($("playstage"), r.track, { doc: ranOn, caption: "" });
}
$("playclose").onclick = () => { player?.dispose(); player = null; $("play").hidden = true; };
$("run").onclick = runProgram;

async function main() {
  const list = await (await fetch("/api/hw/documents")).json();
  const programs = await (await fetch("/api/hw/programs")).json();
  $("program").innerHTML = programs.map((p) => `<option value="${esc(p.id)}" title="${esc(p.summary)}">${esc(p.title)}</option>`).join("");
  const groupsOf = [...new Set(list.map((x) => x.group))];
  $("doc").innerHTML = groupsOf.map((g) => `<optgroup label="${esc(g)}">${list.filter((x) => x.group === g).map((x) =>
    `<option value="${esc(x.id)}">${esc(x.title)} · ${esc(PLATFORM_WORD[x.platform] ?? x.platform)}, ${x.qubits} qubits</option>`).join("")}</optgroup>`).join("");
  const want = new URLSearchParams(location.search).get("doc") ?? list.find((x) => x.group === "Reproduce")?.id ?? list[0].id;
  $("doc").value = want;
  const open = async (id) => {
    undoStack = [];
    const d = await (await fetch("/api/hw/document?id=" + encodeURIComponent(id))).json();
    if (d.error) throw Error(d.error);
    history.replaceState?.(null, "", "?doc=" + encodeURIComponent(id));
    load(d);
  };
  $("doc").onchange = () => open($("doc").value).catch((e) => alert(e.message));
  await open(want);
}
main().catch((e) => { $("inspector").textContent = "The design page could not start: " + e.message; console.error(e); });
