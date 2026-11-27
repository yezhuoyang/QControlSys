// The machine in 3D, as one hardware document describes it (riscq/hw/doc-core.mjs): the stage and
// the scene the design page edits (studio/hw/design.js), and the player that plays a run on that same
// scene for Reproduce, Examples, the Workspace and /schedule (studio/reproduce/twin3d.js mountTwin).
//
// The scene is the document's installation (studio/machine-scene.js: cryostat, optical table or vacuum
// chamber, built by machine/apparatus.mjs) with its RISC-Q boards; positions are mm. The player lights
// what the run's track (riscq/ftqvm/track.mjs) says happened: a qubit glows over the interval the Lean
// trace shows its operation, an atom or ion moves when its move ran, a board lights while one of its
// cores plays a pulse. Qubits are drawn where the document puts them; a move goes along the device's
// trackFrame (lattice, µm, or race-track zones).
import * as T from "three";
import { OrbitControls } from "/three/OrbitControls.js";
import { installation, buildMachine } from "/machine-scene.js";
import { installedPoint } from "/installation-display.js";
import { documentFromTrack, setTemplates } from "/hw/doc-core.mjs";

const DEVICE_KIND = { superconducting: "transmon", neutral: "atom", qccd: "ion" };
const STUB = { pickQubit() {}, pickConductor() {}, probeValue: () => null };
export const machineView = (d) => ({ kind: "machine-design", version: 1, parts: d.parts, wires: d.wires ?? [], device: { ...d.device, kind: DEVICE_KIND[d.platform] } });

let templates = null;
/** A run's hardware document, built in the page from its track (the same code the server runs). */
export async function documentForTrack(track, options = {}) {
  if (!templates) templates = fetch("/api/hw/templates").then((r) => r.json()).then((t) => (setTemplates(t), t));
  await templates;
  return documentFromTrack(track, options);
}

// ---------------------------------------------------------------- keyboard flight
// Every stage can be flown from the keyboard, as in a 3D game. Keys go to the stage the user last
// pointed at or clicked (a page may hold several, such as a list of cards), never while typing in a field.
export const KEYS_HELP = [
  ["\u2191 \u2193 or W S", "fly forward, back"], ["\u2190 \u2192", "turn left, right"], ["A D", "strafe left, right"], ["Q E", "rise, sink"],
  ["Z X", "orbit round what you look at"], ["+ \u2212", "zoom in, out"], ["Shift", "faster"], ["1 2 3", "whole machine \u00b7 device \u00b7 control system"],
  ["R or Home", "reset the view"], ["F", "present: full screen"], ["?", "show or hide these keys"],
];
let activeStage = null;
const typing = (e) => e.target?.closest?.("input, select, textarea, [contenteditable=true]") || e.ctrlKey || e.metaKey || e.altKey;
const FLY = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d", "q", "e", "z", "x", "+", "=", "-", "_", "pageup", "pagedown"]);
addEventListener("keydown", (e) => {
  const st = activeStage;
  if (!st || typing(e) || !st.host.isConnected) return;
  const k = e.key.toLowerCase();
  // A stage inside a page that steps with ← → (the Workspace, the debugger, /schedule) leaves those keys,
  // Home, F and 1 2 3 to the page.
  if (st.mode === "fly" && ["arrowleft", "arrowright", "home", "f", "1", "2", "3"].includes(k)) return;
  if (FLY.has(k)) { e.preventDefault(); st.press(k, e.shiftKey); return; }
  if (k === "shift") return st.press("shift", true);
  if (k === "?" || (k === "/" && e.shiftKey)) { e.preventDefault(); return st.toggleHelp(); }
  if (k === "f") { e.preventDefault(); return st.present(); }
  if (k === "r" || k === "home") { e.preventDefault(); return st.reset(); }
  if (["1", "2", "3"].includes(k) && st.onView) { e.preventDefault(); st.onView(["all", "device", "control"][Number(k) - 1]); }
});
addEventListener("keyup", (e) => activeStage?.release(e.key.toLowerCase()));
addEventListener("blur", () => activeStage?.release(null));

/** The stage both pages share: renderer, lights, floor grid, orbit camera, render on demand, keyboard flight. */
export function createStage(host, { canvas, keys = "full" } = {}) {
  const renderer = new T.WebGLRenderer({ antialias: true, ...(canvas ? { canvas } : {}) });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  if (!canvas) host.prepend(renderer.domElement);
  const scene = new T.Scene();
  scene.background = new T.Color(0x20343a);
  scene.add(new T.HemisphereLight(0xf1faf8, 0x839890, 2.3));
  const sun = new T.DirectionalLight(0xfff0d4, 2.4);
  sun.position.set(-400, 900, 600);
  scene.add(sun);
  const grid = new T.GridHelper(6000, 120, 0x4d6c72, 0x31505a);
  grid.position.y = -2.5;
  scene.add(grid);
  const camera = new T.PerspectiveCamera(38, 1, 0.01, 80000);
  const orbit = new OrbitControls(camera, renderer.domElement);
  let pending = false, disposed = false;
  const render = () => {
    if (pending || disposed) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; if (!disposed) renderer.render(scene, camera); });
  };
  orbit.addEventListener("change", render);
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  /** Point the camera at objects (or a Box3). The last fit is what "reset" returns to. */
  let lastFit = null;
  function fit(objects, { dir = new T.Vector3(0.55, 0.62, 1) } = {}) {
    lastFit = [objects, { dir }];
    const box = objects instanceof T.Box3 ? objects.clone() : new T.Box3();
    if (!(objects instanceof T.Box3)) for (const o of objects) box.expandByObject(o);
    if (box.isEmpty()) return;
    const c = box.getCenter(new T.Vector3()), r = Math.max(1e-6, box.getSize(new T.Vector3()).length() / 2);
    const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * 1.05;
    camera.position.copy(c).add(dir.clone().normalize().multiplyScalar(dist));
    camera.near = Math.max(1e-6, dist / 150);
    camera.far = dist * 60;
    camera.updateProjectionMatrix();
    orbit.target.copy(c);
    orbit.update();
    render();
  }
  // Keyboard flight: held keys move the camera and what it looks at together, at a speed that scales
  // with the distance to what it looks at (a chip and a fridge fly alike); turning swings the target
  // round the camera, orbiting swings the camera round the target.
  const held = new Set();
  let fast = false, flying = false, last = 0;
  const v = new T.Vector3(), fwd = new T.Vector3(), right = new T.Vector3(), up = new T.Vector3(0, 1, 0);
  function step(now) {
    if (disposed || !held.size) { flying = false; return; }
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const dist = camera.position.distanceTo(orbit.target), speed = dist * (fast ? 2.4 : 0.8) * dt, turn = (fast ? 2.2 : 1.1) * dt;
    camera.getWorldDirection(fwd);
    right.crossVectors(fwd, up).normalize();
    v.set(0, 0, 0);
    if (held.has("arrowup") || held.has("w")) v.addScaledVector(fwd, speed);
    if (held.has("arrowdown") || held.has("s")) v.addScaledVector(fwd, -speed);
    if (held.has("a")) v.addScaledVector(right, -speed);
    if (held.has("d")) v.addScaledVector(right, speed);
    if (held.has("q") || held.has("pageup")) v.addScaledVector(up, speed);
    if (held.has("e") || held.has("pagedown")) v.addScaledVector(up, -speed);
    camera.position.add(v);
    orbit.target.add(v);
    const yaw = (held.has("arrowleft") ? 1 : 0) - (held.has("arrowright") ? 1 : 0);
    if (yaw) {
      const d = orbit.target.clone().sub(camera.position).applyAxisAngle(up, yaw * turn);
      orbit.target.copy(camera.position).add(d);
    }
    const spin = (held.has("z") ? 1 : 0) - (held.has("x") ? 1 : 0);
    if (spin) {
      const d = camera.position.clone().sub(orbit.target).applyAxisAngle(up, spin * turn);
      camera.position.copy(orbit.target).add(d);
    }
    const zoom = (held.has("+") || held.has("=") ? 1 : 0) - (held.has("-") || held.has("_") ? 1 : 0);
    if (zoom > 0) camera.position.lerp(orbit.target, Math.min(0.5, (fast ? 2.5 : 1.2) * dt));
    if (zoom < 0) camera.position.add(camera.position.clone().sub(orbit.target).multiplyScalar((fast ? 2.5 : 1.2) * dt));
    const range = camera.position.distanceTo(orbit.target);
    camera.near = Math.max(1e-6, range / 150);
    camera.far = Math.max(camera.near * 1e4, range * 60);
    camera.updateProjectionMatrix();
    camera.lookAt(orbit.target);
    orbit.update();
    render();
    requestAnimationFrame(step);
  }
  // The keys panel, shown with "?".
  const help = document.createElement("div");
  help.className = "hw-keys";
  help.hidden = true;
  const shown = keys === "fly" ? KEYS_HELP.filter(([k]) => !/^(\u2190|1 2 3|F$|R or Home)/.test(k) && !k.startsWith("←")) : KEYS_HELP;
  help.innerHTML = "<b>Fly with the keyboard</b><dl>" + shown.map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join("") + "</dl>";
  Object.assign(help.style, { position: "absolute", right: "10px", top: "10px", zIndex: 5, background: "#0d1b20ee", color: "#eaf4f1", padding: "8px 12px",
    borderRadius: "8px", font: "12px system-ui, sans-serif", maxWidth: "320px", pointerEvents: "none" });
  if (!document.getElementById("hw-keys-style")) {
    const st = document.createElement("style");
    st.id = "hw-keys-style";
    st.textContent = ".hw-keys dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:6px 0 0}.hw-keys dt{font-family:ui-monospace,monospace;color:#ffd27a}.hw-keys dd{margin:0}.hw-keys[hidden]{display:none}";
    document.head.append(st);
  }
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  host.append(help);
  const me = {
    host, onView: null, mode: keys,
    press(k, shift) {
      fast = shift || fast;
      if (k === "shift") return;
      held.add(k);
      if (!flying) { flying = true; last = performance.now(); requestAnimationFrame(step); }
    },
    release(k) {
      if (k === null) { held.clear(); fast = false; return; }
      if (k === "shift") fast = false;
      held.delete(k);
    },
    toggleHelp() { help.hidden = !help.hidden; },
    present() {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else host.requestFullscreen?.().catch(() => {});
    },
    reset() { if (lastFit) fit(...lastFit); },
  };
  const claim = () => (activeStage = me);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.style.outline = "none";
  for (const ev of ["pointerdown", "pointerenter", "focus", "wheel"]) renderer.domElement.addEventListener(ev, claim, { passive: true });
  if (!activeStage) activeStage = me;
  return {
    renderer, scene, camera, orbit, grid, render, fit, keys: me,
    /** What 1, 2 and 3 do on this stage: fn("all" | "device" | "control"). */
    setViewKeys(fn) { me.onView = fn; },
    dispose() {
      disposed = true;
      if (activeStage === me) activeStage = null;
      help.remove();
      observer.disconnect(); orbit.dispose(); renderer.dispose(); renderer.forceContextLoss();
    },
  };
}

/**
 * Highlight parts of a scene by opacity: the parts named in `ids` keep their colours, every other part
 * of the machine turns translucent so the chosen ones stand out. `ids` null or empty restores all.
 */
export function highlight(sceneObj, ids) {
  const keep = new Set(ids ?? []), dim = keep.size > 0;
  const faded = (sceneObj._faded ??= new Map());
  sceneObj.root.traverse((o) => {
    if (!o.isMesh && !o.isLine) return;
    let g = o;
    while (g && g.parent !== sceneObj.root) g = g.parent;
    const part = g?.userData.part;
    if (!dim || (part && keep.has(part))) {
      if (o.userData.original) { o.material = o.userData.original; delete o.userData.original; }
      return;
    }
    const own = o.userData.original ?? o.material;
    o.userData.original = own;
    const ghost = (m) => {
      if (!faded.has(m)) {
        const c = m.clone();
        c.transparent = true;
        c.opacity = Math.min(m.opacity ?? 1, 0.13);
        c.depthWrite = false;
        faded.set(m, c);
      }
      return faded.get(m);
    };
    o.material = Array.isArray(own) ? own.map(ghost) : ghost(own);
  });
}

/**
 * The scene of a document: { root, system, built, groups (part id → group), partIds, chipId,
 * qubitPoint(positionMm) → world point, dispose }.
 */
export function buildScene(doc) {
  const view = machineView(doc);
  const system = installation(view);
  for (const p of system.parts) { const o = doc.install?.[p.id]; if (o?.centerMm) p.centerMm = [...o.centerMm]; }
  for (const x of doc.extras ?? []) system.parts.push({ ...x });
  const built = buildMachine(system, STUB);
  const partIds = new Set(system.parts.map((p) => p.id)), groups = new Map();
  for (const g of built.root.children) if (partIds.has(g.userData.part)) groups.set(g.userData.part, g);
  const qubitPoint = (positionMm) => built.displayPoint(new T.Vector3(...installedPoint(view.device, positionMm)));
  // A chip's metal lies a fraction of a micron above its substrate (studio/device-scene.js face): draw the
  // flat layers with a depth offset by their height, so they do not fight the substrate at any zoom.
  groups.get(system.equipment?.chip)?.traverse((o) => {
    if (!o.isMesh || o.geometry?.type !== "ShapeGeometry") return;
    o.material.polygonOffset = true;
    o.material.polygonOffsetFactor = -1 - Math.round(o.position.y * 1e4);
    o.material.polygonOffsetUnits = -4;
  });
  return { root: built.root, system, built, groups, partIds, chipId: system.equipment?.chip, device: view.device, qubitPoint, dispose: () => built.dispose?.() };
}

/** Show one of the three views on a stage: the whole machine, the device alone, or the control system. */
export function showView(stage, scene, doc, v) {
  for (const g of scene.root.children) g.visible = v !== "device" || g.userData.part === scene.chipId;
  stage.grid.visible = v !== "device";
  const chip = scene.groups.get(scene.chipId);
  if (v === "device" && chip) return stage.fit([chip], { dir: new T.Vector3(0.3, doc.device.mounting?.faceDown ? -1 : 1, 0.7) });
  if (v === "control") return stage.fit(doc.parts.map((p) => scene.groups.get(p.id)).filter(Boolean));
  stage.fit([scene.root]);
}

// ---------------------------------------------------------------- the run player
const COLORS = { data: 0x22b8cf, ancilla: 0x8b7bd8, "1q": 0x34d399, "2q": 0xf97316, measure: 0xfacc15, reset: 0x60a5fa, decode: 0xf472b6, frame: 0xe879f9, factory: 0xa3e635 };
const LABEL = { "1q": "one-qubit gate", "2q": "two-qubit gate", measure: "measurement", reset: "reset", decode: "decode", frame: "Pauli frame", factory: "magic-state factory" };
const smooth = (s) => (s < 0.5 ? 2 * s * s : 1 - 2 * (1 - s) * (1 - s));
const fmt = (ns) => (ns < 1e3 ? ns.toFixed(0) + " ns" : ns < 1e6 ? (ns / 1e3).toFixed(1) + " µs" : (ns / 1e6).toFixed(3) + " ms");
const hex = (c) => "#" + c.toString(16).padStart(6, "0");
let haloTexture;
function halo() {
  if (haloTexture) return haloTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d"), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.3, "rgba(255,255,255,0.45)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return (haloTexture = new T.CanvasTexture(c));
}

/**
 * Play a run on its machine. `track` = { device, controller, events, moves, endNs }; `doc` is the
 * run's hardware document (built from the track when not given). Same interface as the schematic twin:
 * returns { dispose, setTime(ns), setView("all" | "device" | "control") } at once; the machine appears
 * when its document is built.
 */
export function mountMachine(root, track, { caption = "", external = false, compact = false, doc: given = null, view: firstView = "device" } = {}) {
  root.innerHTML = `
    <div class="twin-stage"><canvas></canvas>
      <div class="twin-hud"><div class="twin-time">building the machine…</div><ol class="twin-now"></ol></div>
      <div class="twin-legend"></div>
      <div class="twin-views"><button type="button" data-view="all">Whole machine</button><button type="button" data-view="device" aria-pressed="true">Device</button><button type="button" data-view="control">Control system</button></div>
    </div>
    <div class="twin-controls">
      <button type="button" class="btn small" data-act="play">Pause</button>
      <button type="button" class="btn small alt" data-act="restart">Restart</button>
      <label>Speed <select data-act="speed"><option value="0.25">slow</option><option value="1" selected>normal</option><option value="4">fast</option></select></label>
      <input type="range" min="0" max="1000" value="0" data-act="scrub" aria-label="Machine time">
    </div>
    <p class="twin-caption">${caption}</p>`;
  if (external) for (const sel of [".twin-controls", ".twin-caption", ".twin-views"]) root.querySelector(sel).style.display = "none";
  if (compact) for (const sel of [".twin-controls", ".twin-caption"]) root.querySelector(sel).style.display = "none";
  const stageEl = root.querySelector(".twin-stage"), hudTime = root.querySelector(".twin-time"), hudNow = root.querySelector(".twin-now");
  const stage = createStage(stageEl, { canvas: root.querySelector("canvas"), keys: external ? "fly" : "full" });
  const endNs = Math.max(1, track.endNs ?? 1), events = track.events ?? [];
  let t = 0, playing = !(compact && matchMedia("(prefers-reduced-motion: reduce)").matches), speed = 1, last = performance.now(), disposed = false;
  let view = firstView, scene = null, doc = null, anim = null;
  const runSeconds = 45;
  const controlsEl = root.querySelector(".twin-controls");
  const playBtn = controlsEl.querySelector('[data-act="play"]'), scrub = controlsEl.querySelector('[data-act="scrub"]');
  playBtn.onclick = () => { playing = !playing; playBtn.textContent = playing ? "Pause" : "Play"; };
  controlsEl.querySelector('[data-act="restart"]').onclick = () => { t = 0; playing = true; playBtn.textContent = "Pause"; };
  controlsEl.querySelector('[data-act="speed"]').onchange = (e) => (speed = Number(e.target.value));
  scrub.oninput = () => { t = (Number(scrub.value) / 1000) * endNs; };
  stage.setViewKeys((v) => setView(v));
  const viewsEl = root.querySelector(".twin-views");
  const setView = (v) => {
    view = v;
    for (const b of viewsEl.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.view === v));
    if (scene) showView(stage, scene, doc, v);
    anim?.setView(v);
  };
  viewsEl.onclick = (e) => { if (e.target.dataset?.view) setView(e.target.dataset.view); };

  (given ? Promise.resolve(given) : documentForTrack(track)).then((d) => {
    if (disposed) return;
    doc = d;
    scene = buildScene(doc);
    stage.scene.add(scene.root);
    anim = animator(stage, scene, doc, track);
    root.querySelector(".twin-legend").innerHTML = anim.legend;
    anim.setView(view);
    setView(view);
  }).catch((e) => { hudTime.textContent = "The machine could not be built: " + e.message; });

  const firstAfter = (x) => { let lo = 0, hi = events.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid].t0 < x) lo = mid + 1; else hi = mid; } return lo; };
  const maxDur = Math.max(1, ...events.map((e) => e.t1 - e.t0));
  function loop(now) {
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing && !external) { t += (dt * speed * endNs) / runSeconds; if (t > endNs) t = 0; }
    if (anim) {
      const active = [];
      for (let i = firstAfter(t - maxDur); i < events.length && events[i].t0 <= t; i++) if (events[i].t1 > t) active.push(events[i]);
      const n = anim.update(t, active);
      hudTime.textContent = "machine time " + fmt(t) + " / " + fmt(endNs) + (n ? " · " + n + " core" + (n === 1 ? "" : "s") + " playing pulses" : "");
      hudNow.innerHTML = active.filter((e) => e.k !== "decode").slice(0, 5).map((e) => `<li><b style="color:${hex(COLORS[e.k] ?? 0xffffff)}">●</b> ${String(e.line ?? "").replace(/[<>&]/g, "")}</li>`).join("");
      scrub.value = String(Math.round((t / endNs) * 1000));
      stage.renderer.render(stage.scene, stage.camera);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  return {
    dispose: () => { disposed = true; scene?.dispose(); stage.dispose(); },
    setTime: (ns) => { t = Math.max(0, Math.min(endNs, ns)); },
    setView,
  };
}

/** What lights and moves on a scene as a run plays. */
function animator(stage, scene, doc, track) {
  const dev = doc.device, frame = dev.trackFrame ?? { kind: "none" }, n = dev.qubits.length;
  const sites = dev.layout?.sites ?? [];
  // A position given in the track's units, as the document's positionMm.
  const zonePoint = (z) => {
    const m = sites.length, a = Math.floor(z), f = z - a, p = sites[((a % m) + m) % m], q = sites[(((a + 1) % m) + m) % m];
    return [p.x + (q.x - p.x) * f, frame.heightMm ?? 0, p.z + (q.z - p.z) * f];
  };
  const fromTrack = (at) => frame.kind === "lattice" ? [at[0] * frame.pitchMm - frame.offsetMm[0], 0, at[1] * frame.pitchMm - frame.offsetMm[1]]
    : frame.kind === "um" ? [at[0] / 1000 - frame.originMm[0], frame.heightMm ?? 0, at[1] / 1000 - frame.originMm[1]] : null;
  const byMoves = Array.from({ length: n }, () => []);
  for (const m of track.moves ?? []) byMoves[m.s]?.push(m);
  const along = (from, to, s) => { const Z = sites.length; let d = to - from; if (d > Z / 2) d -= Z; if (d < -Z / 2) d += Z; return from + d * s; };
  // Where qubit k is at time t, in the device's own coordinates (mm).
  const localAt = (k, t) => {
    let p = dev.qubits[k].positionMm;
    for (const m of byMoves[k]) {
      const s = t >= m.t1 ? 1 : t > m.t0 ? smooth((t - m.t0) / (m.t1 - m.t0)) : null;
      if (s === null) break;
      if (frame.kind === "ring") p = zonePoint(along(m.from, m.to, s));
      else { const a = fromTrack(m.from), b = fromTrack(m.to); if (a && b) p = a.map((v, i) => v + (b[i] - v) * s); }
      if (s < 1) break;
    }
    return p;
  };
  // The register's own atom or ion meshes (studio/device-scene.js tags them with their qubit) move too.
  const meshOf = new Map();
  scene.groups.get(scene.chipId)?.traverse((o) => { if (o.isMesh && o.userData.qubit && !meshOf.has(o.userData.qubit)) meshOf.set(o.userData.qubit, o); });
  // Marker size: a fraction of the nearest distance between two qubits, in world units.
  const pts = dev.qubits.map((q) => scene.qubitPoint(q.positionMm));
  let near = Infinity;
  for (let i = 0; i < Math.min(n, 200); i++) for (let j = i + 1; j < Math.min(n, 200); j++) near = Math.min(near, pts[i].distanceTo(pts[j]) || Infinity);
  if (!Number.isFinite(near)) near = 1;
  const kindOf = (k) => (track.device?.sites?.[k]?.kind === "data" ? "data" : "ancilla");
  const overlay = new T.Group();
  stage.scene.add(overlay);
  const sprite = (color, size, opacity) => {
    const s = new T.Sprite(new T.SpriteMaterial({ map: halo(), color, blending: T.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false, opacity }));
    s.scale.set(size, size, 1);
    overlay.add(s);
    return s;
  };
  const qubits = pts.map((p, k) => ({ base: COLORS[kindOf(k)], glow: sprite(COLORS[kindOf(k)], near * 0.7, 0.55), flash: sprite(0xffffff, near * 1.1, 0) }));
  // Couplers and gate pairs: a bright bond between the two qubits.
  const bondMat = new T.LineBasicMaterial({ color: 0xffd27a, transparent: true, blending: T.AdditiveBlending, depthTest: false });
  const bonds = new T.LineSegments(new T.BufferGeometry(), bondMat);
  overlay.add(bonds);
  // Boards: the tile of a core (studio/zcu216-hardware.js) lights while that core plays a pulse, and
  // its board takes a faint tint. A core's tile is its place among the cores of its board.
  const cores = track.controller?.cores ?? [], pulses = track.controller?.pulses ?? [];
  const boardMeshes = new Map(), tileOf = new Map(), seen = new Map();
  for (const b of doc.control.boards) {
    const g = scene.groups.get("board" + b.index);
    if (!g) continue;
    const ms = [], tiles = [];
    g.traverse((o) => {
      if (!o.isMesh || !o.material?.emissive) return;
      if (o.userData.coreTile !== undefined) tiles[o.userData.coreTile] = o.material;
      else ms.push([o.material, o.material.emissive.clone()]);
    });
    boardMeshes.set(b.index, { mats: [...new Map(ms.map(([m, e]) => [m, e])).entries()], tiles });
  }
  cores.forEach((c, k) => {
    const b = c.board ?? 0, place = seen.get(b) ?? 0;
    seen.set(b, place + 1);
    tileOf.set(k, [b, place]);
  });
  // A beacon over the device: in the whole-machine view the qubits are too small to see, so the
  // device's own activity shows as one glow the colour of what runs on it now.
  const chipGroup = scene.groups.get(scene.chipId);
  const sceneBox = new T.Box3().setFromObject(scene.root), deviceBox = chipGroup ? new T.Box3().setFromObject(chipGroup) : sceneBox;
  const beacon = sprite(0xffffff, sceneBox.getSize(new T.Vector3()).length() * 0.06, 0);
  beacon.position.copy(deviceBox.getCenter(new T.Vector3()));
  let wide = false;
  const used = new Set((track.events ?? []).map((e) => e.k));
  const legend = [`<span><i style="background:#22b8cf"></i>data qubit</span>`, `<span><i style="background:#8b7bd8"></i>ancilla</span>`,
    ...[...used].filter((k) => LABEL[k]).map((k) => `<span><i style="background:${hex(COLORS[k])}"></i>${LABEL[k]}</span>`),
    ...(track.moves?.length ? [`<span><i style="background:#ffffff"></i>${dev.kind === "atom" ? "AOD move" : "ion transport"}</span>`] : []),
    ...(boardMeshes.size ? [`<span><i style="background:#ffb96d;border-radius:2px"></i>RISC-Q core playing a pulse</span>`] : [])].join("");
  function update(t, active) {
    for (let k = 0; k < n; k++) {
      let p = pts[k];
      if (byMoves[k].length) {
        const local = localAt(k, t);
        p = scene.qubitPoint(local);
        const mesh = dev.kind !== "transmon" && meshOf.get(dev.qubits[k].id);
        if (mesh) mesh.position.set(...local);
      }
      const q = qubits[k];
      q.glow.position.copy(p);
      q.flash.position.copy(p);
      q.flash.material.opacity = byMoves[k].some((m) => t > m.t0 && t < m.t1) ? 0.8 : 0;
      q.flash.material.color.setHex(0xffffff);
    }
    const seg = [];
    for (const e of active) {
      const color = COLORS[e.k];
      if (!color || e.k === "decode" || e.k === "frame") continue;
      for (const s of e.s ?? []) {
        const q = qubits[s];
        if (!q) continue;
        q.flash.material.color.setHex(color);
        q.flash.material.opacity = 0.95;
      }
      if (e.k === "2q" && e.s?.length === 2 && qubits[e.s[0]] && qubits[e.s[1]]) seg.push(qubits[e.s[0]].glow.position.clone(), qubits[e.s[1]].glow.position.clone());
    }
    bonds.geometry.dispose();
    bonds.geometry = new T.BufferGeometry().setFromPoints(seg);
    // Cores playing a pulse now: their tiles light, their boards take a tint.
    const live = new Set(), liveTiles = new Set();
    for (const p of pulses) if (p[2] <= t && t < p[3]) {
      const [b, place] = tileOf.get(p[0]) ?? [cores[p[0]]?.board ?? 0, -1];
      live.add(b);
      liveTiles.add(b + "/" + place);
    }
    for (const [b, { mats, tiles }] of boardMeshes) {
      for (const [m, e] of mats) { if (live.has(b)) m.emissive.setHex(0x2e1c08); else m.emissive.copy(e); }
      tiles.forEach((m, place) => m?.emissive.setHex(liveTiles.has(b + "/" + place) ? 0xff8a1c : 0x000000));
    }
    // The beacon takes the colour of the commonest operation running now.
    const count = {};
    for (const e of active) if (COLORS[e.k]) count[e.k] = (count[e.k] ?? 0) + 1;
    const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    beacon.material.opacity = wide && top ? 0.9 : 0;
    if (top) beacon.material.color.setHex(COLORS[top[0]]);
    return liveTiles.size;
  }
  return { update, legend, setView: (v) => (wide = v !== "device") };
}
