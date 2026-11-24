// Resizable, hideable panels and a present mode for the workspace pages (the hardware design
// editor and the RISC-Q workspace). The page provides the layout the two share:
//   .row#row > aside.rail, section.stage (… #dock), #grip, section.progcol
// and <body data-panels="<page>" data-col="<default right column, px>" data-present-hint="…">.
// This module adds a grip to the right of the left panel and one above the bottom dock, takes
// over the right column's grip, and adds a group of layout buttons to the head:
//   [ left panel ]  \ bottom panel   ] right panel   Shift+F present (full screen, the stage only)
// A panel dragged almost shut is hidden. Sizes and visibility are kept per page in this browser.

const body = document.body;
const row = document.getElementById("row");
const rail = row?.querySelector(":scope > .rail");
const stage = row?.querySelector(":scope > .stage");
const col = row?.querySelector(":scope > .progcol");
const colGrip = document.getElementById("grip");
const dock = document.getElementById("dock");
const head = document.querySelector(".head");

const KEY = "quantumos-panels:" + (body.dataset.panels || location.pathname);
const DEFAULTS = { rail: 236, col: Number(body.dataset.col) || 470, dock: 0, showRail: true, showCol: true, showDock: true };
const state = { ...DEFAULTS, ...read() };
let present = false;

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the layout still works.
  }
}

const narrow = matchMedia("(max-width: 1100px)");
const icon = (inner) =>
  `<svg viewBox="0 0 20 14" aria-hidden="true"><rect x="0.75" y="0.75" width="18.5" height="12.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>${inner}</svg>`;
const BUTTONS = [
  ["showRail", "Left panel", "[", icon('<rect class="fill" x="2.5" y="2.5" width="5" height="9" rx="1"/>')],
  ["showDock", "Bottom panel", "\\", icon('<rect class="fill" x="2.5" y="8" width="15" height="3.5" rx="1"/>')],
  ["showCol", "Right panel", "]", icon('<rect class="fill" x="12.5" y="2.5" width="5" height="9" rx="1"/>')],
];

let group, buttons = {};

function build() {
  row.classList.add("panels");
  if (rail) {
    const g = grip("grip grip-rail", "vertical", "Drag to resize the left panel. Drag it almost shut to hide it.");
    rail.after(g);
    drag(g, (x) => {
      const w = x - row.getBoundingClientRect().left;
      if (w < 110) return set({ showRail: false, rail: before.rail });
      set({ showRail: true, rail: clamp(w, 160, Math.min(560, innerWidth * 0.4)) });
    }, (d) => set({ showRail: true, rail: clamp(state.rail + d, 160, 560) }));
  }
  if (col && colGrip) {
    // The page's grip is replaced by a clone, which drops the page's own resize handler.
    const g = colGrip.cloneNode(false);
    g.title = "Drag to resize the right panel. Drag it almost shut to hide it.";
    g.tabIndex = 0;
    g.setAttribute("aria-label", "Resize the right panel");
    colGrip.replaceWith(g);
    drag(g, (x) => {
      const w = row.getBoundingClientRect().right - x;
      if (w < 150) return set({ showCol: false, col: before.col });
      set({ showCol: true, col: clamp(w, 240, innerWidth * 0.7) });
    }, (d) => set({ showCol: true, col: clamp(state.col - d, 240, innerWidth * 0.7) }));
  }
  if (dock) {
    const g = grip("hgrip", "horizontal", "Drag to resize the bottom panel. Drag it almost shut to fold it.");
    dock.before(g);
    drag(g, (_, y) => {
      const h = stage.getBoundingClientRect().bottom - y;
      fold(h < 60);
      if (h >= 60) set({ showDock: true, dock: clamp(h, 80, stage.getBoundingClientRect().height - 140) });
    }, (_, d) => {
      fold(false);
      set({ showDock: true, dock: clamp((state.dock || dock.getBoundingClientRect().height) - d, 80, stage.getBoundingClientRect().height - 140) });
    }, "y");
  }

  group = document.createElement("div");
  group.className = "layout";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Layout");
  for (const [key, name, shortcut, svg] of BUTTONS) {
    if ((key === "showRail" && !rail) || (key === "showCol" && !col) || (key === "showDock" && !dock)) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = svg;
    b.title = `Show or hide the ${name.toLowerCase()} (${shortcut})`;
    b.setAttribute("aria-label", name);
    b.onclick = () => set({ [key]: !state[key] });
    buttons[key] = b;
    group.append(b);
  }
  const p = document.createElement("button");
  p.type = "button";
  p.className = "present-btn";
  p.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg><span>Present</span>';
  p.title = "Present: full screen with the stage only (Shift+F). Esc leaves.";
  p.onclick = () => setPresent(true);
  group.append(p);
  const actions = head?.querySelector(".actions");
  if (actions) actions.before(group);
  else head?.append(group);

  bar = document.createElement("div");
  bar.className = "present-bar";
  bar.setAttribute("role", "status");
  bar.innerHTML = `<span>Present mode${body.dataset.presentHint ? " · " + body.dataset.presentHint : ""} · Esc leaves</span>`;
  const leave = document.createElement("button");
  leave.type = "button";
  leave.textContent = "Leave";
  leave.onclick = () => setPresent(false);
  bar.append(leave);
  body.append(bar);

  narrow.addEventListener("change", apply);
  addEventListener("keydown", onKey, true);
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && present) setPresent(false);
  });
  addEventListener("pointermove", (e) => {
    if (present) reveal(e.clientY < 90 ? 4000 : 1600);
  });
  apply();
}

function grip(className, orientation, title) {
  const g = document.createElement("div");
  g.className = className;
  g.setAttribute("role", "separator");
  g.setAttribute("aria-orientation", orientation);
  g.setAttribute("aria-label", title.split(".")[0]);
  g.tabIndex = 0;
  g.title = title;
  return g;
}

// Pointer drag reports the pointer position; arrow keys on a focused grip report a step.
// `before` holds the sizes when the drag began, so that a panel dragged shut reopens at that size.
let before = state;
function drag(el, onMove, onKeyStep, axis = "x") {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    before = { ...state };
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    body.classList.add("resizing", axis === "y" ? "resizing-y" : "resizing-x");
    const move = (ev) => onMove(ev.clientX, ev.clientY);
    const end = () => {
      el.classList.remove("dragging");
      body.classList.remove("resizing", "resizing-x", "resizing-y");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  });
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 64 : 16;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    onKeyStep(d[0], d[1]);
  });
}

function fold(on) {
  if (!dock || dock.classList.contains("folded") === on) return;
  dock.classList.toggle("folded", on);
  const f = document.getElementById("foldDock");
  if (f) f.textContent = on ? "▴" : "▾";
}

const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(Math.max(lo, hi), v)));

function set(change) {
  Object.assign(state, change);
  apply();
  save();
}

function apply() {
  const showRail = state.showRail && !!rail && !narrow.matches && !present;
  const showCol = state.showCol && !!col && !present;
  row.style.gridTemplateColumns = `${showRail ? state.rail + "px 6px" : "0 0"} minmax(0, 1fr) ${showCol ? "6px " + state.col + "px" : "0 0"}`;
  body.classList.toggle("hide-rail", !state.showRail);
  body.classList.toggle("hide-col", !state.showCol);
  body.classList.toggle("hide-dock", !state.showDock);
  if (dock && state.dock) dock.style.setProperty("--dock", state.dock + "px");
  for (const [key, b] of Object.entries(buttons)) b.setAttribute("aria-pressed", String(!!state[key]));
  if (buttons.showRail) buttons.showRail.disabled = narrow.matches;
}

let bar, hideTimer;
function reveal(ms) {
  bar.classList.add("shown");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => bar.classList.remove("shown"), ms);
}

function setPresent(on) {
  if (present === on) return;
  present = on;
  body.classList.toggle("present", on);
  apply();
  if (on) {
    reveal(3000);
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    bar.classList.remove("shown");
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }
}

function onKey(e) {
  if (present && e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    return setPresent(false);
  }
  if (e.ctrlKey || e.metaKey || e.altKey || ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) || e.target.isContentEditable) return;
  const action = {
    "[": () => set({ showRail: !state.showRail }),
    "]": () => set({ showCol: !state.showCol }),
    "\\": () => set({ showDock: !state.showDock }),
    F: () => setPresent(!present),
  }[e.key];
  if (action) {
    e.preventDefault();
    e.stopPropagation();
    action();
  }
}

if (row && stage) build();
