// The digital twin in 3D, playing one run of a reproduced experiment.
//
// Everything that moves or lights up comes from the run's track (riscq/ftqvm/track.mjs): an
// operation glows over the interval the Lean trace shows for it, an atom or ion moves when the
// controller played its move, a decode runs when the decoder service ran it. Geometry is the
// twin's: transmons and couplers on the lattice of the chip, atoms at their positions in µm,
// ions in the zones of the race track. Sizes of parts are drawn for legibility (schematic);
// positions and times are the run's.
import * as THREE from "three";
import { OrbitControls } from "/three/OrbitControls.js";
import { buildControl, describePick, ROLE_COLORS, ROLE_LABEL } from "/reproduce/control3d.js";

const COLORS = {
  data: 0x22b8cf, ancilla: 0x8b7bd8, "1q": 0x34d399, "2q": 0xf97316, measure: 0xfacc15, reset: 0x60a5fa,
  decode: 0xf472b6, frame: 0xe879f9, factory: 0xa3e635, rydberg: 0xff3b6b, raman: 0x34d399,
};
const LABEL = { "1q": "one-qubit gate", "2q": "two-qubit gate", measure: "measurement", reset: "reset", decode: "decode", frame: "Pauli frame", factory: "magic-state factory" };
const smooth = (s) => (s < 0.5 ? 2 * s * s : 1 - 2 * (1 - s) * (1 - s)); // accelerate, then brake

function fmt(ns) {
  return ns < 1e3 ? ns.toFixed(0) + " ns" : ns < 1e6 ? (ns / 1e3).toFixed(1) + " µs" : (ns / 1e6).toFixed(3) + " ms";
}

/** A glowing halo sprite (additive), for atoms, ions and flashes. */
function haloTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d"), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.3, "rgba(255,255,255,0.45)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/**
 * Mount the viewer. `track` = { device, endNs, events, moves }. Returns { dispose }.
 */
export function mountTwin(root, track, { caption = "" } = {}) {
  root.innerHTML = `
    <div class="twin-stage"><canvas></canvas>
      <div class="twin-hud"><div class="twin-time"></div><ol class="twin-now"></ol></div>
      <div class="twin-legend"></div>
      <div class="twin-tip" hidden></div>
      <div class="twin-views"><button type="button" data-view="all" aria-pressed="true">Whole machine</button><button type="button" data-view="device">Device</button><button type="button" data-view="control">Control system</button></div>
    </div>
    <div class="twin-controls">
      <button type="button" class="btn small" data-act="play">Pause</button>
      <button type="button" class="btn small alt" data-act="restart">Restart</button>
      <label>Speed <select data-act="speed"><option value="0.25">slow</option><option value="1" selected>normal</option><option value="4">fast</option></select></label>
      <input type="range" min="0" max="1000" value="0" data-act="scrub" aria-label="Machine time">
    </div>
    <p class="twin-caption">${caption}</p>`;
  const canvas = root.querySelector("canvas"), hudTime = root.querySelector(".twin-time"), hudNow = root.querySelector(".twin-now");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);
  const camera = new THREE.PerspectiveCamera(40, 2, 0.05, 2000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1f33, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(5, 10, 6);
  scene.add(sun);
  const halo = haloTexture();
  const glow = (color, size) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
    s.scale.set(size, size, 1);
    return s;
  };

  const dev = track.device, n = dev.sites.length;
  const kindOf = (k) => (dev.sites[k].kind === "data" ? "data" : "ancilla");
  // ---- geometry: site positions in world units, as a function of time for moving qubits ----
  let at0, positionAt, frame = { center: new THREE.Vector3(), radius: 5 };
  const byMoves = Array.from({ length: n }, () => []);
  for (const m of track.moves ?? []) byMoves[m.s]?.push(m);
  if (dev.kind === "transmon") {
    at0 = dev.sites.map((s) => new THREE.Vector3(s.at[0], 0, s.at[1]));
    positionAt = (k) => at0[k];
  } else if (dev.kind === "atoms") {
    const scale = 0.1; // 10 µm per unit
    at0 = dev.sites.map((s) => new THREE.Vector3(s.at[0] * scale, 0, s.at[1] * scale));
    positionAt = (k, t) => {
      let p = at0[k];
      for (const m of byMoves[k]) {
        const from = new THREE.Vector3(m.from[0] * scale, 0, m.from[1] * scale), to = new THREE.Vector3(m.to[0] * scale, 0, m.to[1] * scale);
        if (t >= m.t1) p = to;
        else if (t > m.t0) return from.clone().lerp(to, smooth((t - m.t0) / (m.t1 - m.t0))).setY(0.35 * Math.sin(Math.PI * (t - m.t0) / (m.t1 - m.t0)));
        else break;
      }
      return p;
    };
  } else {
    // Ions on a race track: zones round a stadium, two straights of Z/2 zones.
    const Z = dev.ring.zones, half = Z / 2, len = half - 1, r = 3.2;
    const zonePoint = (z) => {
      z = ((z % Z) + Z) % Z;
      if (z <= len) return new THREE.Vector3(z - len / 2, 0, -r);
      if (z < half) { const a = (z - len) * Math.PI; return new THREE.Vector3(len / 2 + r * Math.sin(a), 0, -r * Math.cos(a)); }
      const w = z - half;
      if (w <= len) return new THREE.Vector3(len / 2 - w, 0, r);
      const a = (w - len) * Math.PI;
      return new THREE.Vector3(-len / 2 - r * Math.sin(a), 0, r * Math.cos(a));
    };
    // Shortest way round the loop from one zone to another, as a fractional zone index.
    const along = (from, to, s) => {
      let d = to - from;
      if (d > Z / 2) d -= Z;
      if (d < -Z / 2) d += Z;
      return from + d * s;
    };
    const zoneAt = (k, t) => {
      let z = dev.sites[k].at[0];
      for (const m of byMoves[k]) {
        if (t >= m.t1) z = m.to;
        else if (t > m.t0) return along(m.from, m.to, smooth((t - m.t0) / (m.t1 - m.t0)));
        else break;
      }
      return z;
    };
    at0 = dev.sites.map((s) => zonePoint(s.at[0]));
    positionAt = (k, t) => {
      const z = zoneAt(k, t), p = zonePoint(z);
      // Two ions in one zone sit side by side along the track.
      if (Number.isInteger(z)) {
        const mates = [];
        for (let j = 0; j < n; j++) if (zoneAt(j, t) === z) mates.push(j);
        if (mates.length > 1) {
          const tangent = zonePoint(z + 0.5).sub(zonePoint(z - 0.5)).normalize();
          p.addScaledVector(tangent, (mates.indexOf(k) - (mates.length - 1) / 2) * 0.28);
        }
      }
      return p.setY(0.25);
    };
    // Electrodes: one segment per zone round the loop, and the RF rails.
    const seg = new THREE.BoxGeometry(0.7, 0.08, 0.5);
    for (let z = 0; z < Z; z++) {
      const a = zonePoint(z), b = zonePoint(z + 0.5);
      const e = new THREE.Mesh(seg, new THREE.MeshStandardMaterial({ color: 0x9aa3b8, metalness: 0.7, roughness: 0.35 }));
      e.position.copy(a);
      e.lookAt(b.x, a.y, b.z);
      e.rotateY(Math.PI / 2);
      scene.add(e);
    }
    // The RF rails follow the track: two straights joined by half circles.
    const path = [];
    for (let z = 0; z < Z; z += 0.1) path.push(zonePoint(z));
    const curve = new THREE.CatmullRomCurve3(path, true);
    for (const offset of [-0.32, 0.32]) {
      const points = curve.getSpacedPoints(400).map((p, i, all) => {
        const next = all[(i + 1) % all.length], tangent = next.clone().sub(p).normalize();
        return p.clone().add(new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(offset)).setY(0.06);
      });
      const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, true), 400, 0.035, 6, true),
        new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 0.9, roughness: 0.3 }));
      scene.add(rail);
    }
  }
  // Frame the camera on the device.
  const box = new THREE.Box3();
  for (const p of at0) box.expandByPoint(p);
  box.getCenter(frame.center);
  frame.radius = Math.max(2, box.getSize(new THREE.Vector3()).length() / 2);
  camera.position.copy(frame.center).add(new THREE.Vector3(0, frame.radius * 1.3, frame.radius * 1.5));
  controls.target.copy(frame.center);

  // ---- the device's parts ----
  const plateSize = box.getSize(new THREE.Vector3());
  const plate = new THREE.Mesh(new THREE.BoxGeometry(plateSize.x + 3, 0.12, plateSize.z + 3),
    new THREE.MeshStandardMaterial({ color: dev.kind === "transmon" ? 0x2b3147 : 0x10162a, roughness: 0.9 }));
  plate.position.copy(frame.center).setY(-0.12);
  scene.add(plate);
  const couplers = [];
  if (dev.kind === "transmon") {
    for (const [a, b] of dev.couplers ?? []) {
      const pa = at0[a], pb = at0[b], len = pa.distanceTo(pb);
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, len), new THREE.MeshStandardMaterial({ color: 0x6b7280, emissive: COLORS["2q"], emissiveIntensity: 0 }));
      m.position.copy(pa).add(pb).multiplyScalar(0.5).setY(0.02);
      m.lookAt(pb.x, 0.02, pb.z);
      scene.add(m);
      couplers.push({ a, b, mesh: m, key: Math.min(a, b) + "-" + Math.max(a, b) });
    }
  }
  const couplerOf = new Map(couplers.map((c) => [c.key, c]));
  const qubits = dev.sites.map((s, k) => {
    const color = COLORS[kindOf(k)];
    const geometry = dev.kind === "transmon" ? new THREE.CylinderGeometry(0.18, 0.18, 0.06, 24) : new THREE.SphereGeometry(dev.kind === "atoms" ? 0.07 : 0.1, 20, 14);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: dev.kind === "transmon" ? 0.15 : 0.8, roughness: 0.4 }));
    mesh.position.copy(at0[k]);
    scene.add(mesh);
    const g = glow(color, dev.kind === "transmon" ? 0.9 : 0.6);
    g.material.opacity = dev.kind === "transmon" ? 0 : 0.35;
    scene.add(g);
    const flash = glow(0xffffff, dev.kind === "transmon" ? 1.2 : 0.9);
    scene.add(flash);
    return { mesh, glow: g, flash, base: color };
  });
  // Global pulses (atoms): a translucent sheet over the array; laser beams (ions): lines from above.
  const sheet = new THREE.Mesh(new THREE.BoxGeometry(plateSize.x + 2, 0.02, plateSize.z + 2),
    new THREE.MeshBasicMaterial({ color: COLORS.rydberg, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  sheet.position.copy(frame.center).setY(0.05);
  scene.add(sheet);
  const beams = [];
  const beamMaterial = (color) => new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending });
  const decoder = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.8), new THREE.MeshStandardMaterial({ color: 0x334155, emissive: COLORS.decode, emissiveIntensity: 0 }));
  decoder.position.copy(frame.center).add(new THREE.Vector3(plateSize.x / 2 + 3, 0.25, 0));
  scene.add(decoder);

  // ---- the control system: RISC-Q board, converters, cables, optics, host ----
  const control = track.controller ? buildControl(scene, track.controller, { kind: dev.kind, center: frame.center, size: plateSize, positionAt, siteCount: n, glowSprite: glow }) : null;
  const deviceBox = box.clone().expandByScalar(1.2);
  const look = (b, tilt = 1) => {
    const c = b.getCenter(new THREE.Vector3()), r = Math.max(2, b.getSize(new THREE.Vector3()).length() / 2);
    camera.position.copy(c).add(new THREE.Vector3(0, r * 1.25 * tilt, r * 1.5));
    controls.target.copy(c);
  };
  if (control) {
    decoder.visible = false;
    look(control.bounds);
  }
  const viewsEl = root.querySelector(".twin-views");
  if (!control) viewsEl.hidden = true;
  viewsEl.onclick = (e) => {
    const v = e.target.dataset?.view;
    if (!v) return;
    for (const b of viewsEl.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === e.target));
    look(v === "device" ? deviceBox : v === "control" ? control.controlBounds.clone().expandByScalar(0.8) : control.bounds, v === "control" ? 1.2 : 1);
  };
  // Hover inspector for the control system's parts.
  const tip = root.querySelector(".twin-tip"), ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  canvas.addEventListener("pointermove", (ev) => {
    if (!control) return;
    const r = canvas.getBoundingClientRect();
    mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(control.pickables, false)[0];
    if (!hit) { tip.hidden = true; return; }
    tip.innerHTML = describePick(hit.object.userData, track.controller);
    tip.style.left = Math.min(r.width - 300, ev.clientX - r.left + 14) + "px";
    tip.style.top = ev.clientY - r.top + 14 + "px";
    tip.hidden = false;
  });
  canvas.addEventListener("pointerleave", () => (tip.hidden = true));

  // ---- legend ----
  const used = new Set(track.events.map((e) => e.k));
  root.querySelector(".twin-legend").innerHTML = [
    `<span><i style="background:#22b8cf"></i>${dev.kind === "transmon" ? "data transmon" : dev.kind === "atoms" ? "data atom" : "data ion"}</span>`,
    `<span><i style="background:#8b7bd8"></i>ancilla</span>`,
    ...[...used].map((k) => `<span><i style="background:#${COLORS[k].toString(16).padStart(6, "0")}"></i>${LABEL[k]}</span>`),
    ...(track.moves?.length ? [`<span><i style="background:#ffffff"></i>${dev.kind === "atoms" ? "AOD move" : "ion transport"}</span>`] : []),
    ...(control ? [...new Set(track.controller.cores.map((c) => c.role))].map((r) => `<span><i style="background:#${ROLE_COLORS[r].toString(16).padStart(6, "0")};border-radius:2px"></i>${ROLE_LABEL[r]}</span>`) : []),
  ].join("");

  // ---- time ----
  const events = track.events, endNs = Math.max(1, track.endNs);
  const maxDur = Math.max(1, ...events.map((e) => e.t1 - e.t0));
  const firstAfter = (t) => { let lo = 0, hi = events.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid].t0 < t) lo = mid + 1; else hi = mid; } return lo; };
  let t = 0, playing = true, speed = 1, last = performance.now(), disposed = false;
  const runSeconds = 45; // the whole run, at normal speed
  const controlsEl = root.querySelector(".twin-controls");
  const playBtn = controlsEl.querySelector('[data-act="play"]'), scrub = controlsEl.querySelector('[data-act="scrub"]');
  playBtn.onclick = () => { playing = !playing; playBtn.textContent = playing ? "Pause" : "Play"; };
  controlsEl.querySelector('[data-act="restart"]').onclick = () => { t = 0; playing = true; playBtn.textContent = "Pause"; };
  controlsEl.querySelector('[data-act="speed"]').onchange = (e) => (speed = Number(e.target.value));
  scrub.oninput = () => { t = (Number(scrub.value) / 1000) * endNs; };

  function update() {
    const active = [];
    for (let i = firstAfter(t - maxDur); i < events.length && events[i].t0 <= t; i++) if (events[i].t1 > t) active.push(events[i]);
    for (let k = 0; k < n; k++) {
      const p = positionAt(k, t), q = qubits[k];
      q.mesh.position.copy(p);
      q.glow.position.copy(p);
      q.flash.position.copy(p);
      q.flash.material.opacity = 0;
      q.mesh.material.emissive.setHex(q.base);
      q.mesh.material.emissiveIntensity = dev.kind === "transmon" ? 0.15 : 0.8;
    }
    for (const c of couplers) c.mesh.material.emissiveIntensity = 0;
    sheet.material.opacity = 0;
    for (const b of beams.splice(0)) {
      scene.remove(b);
      b.geometry.dispose();
      b.material.dispose();
    }
    let decoding = 0, framing = 0;
    const pairs = [];
    for (const e of active) {
      const color = COLORS[e.k];
      if (e.k === "decode" || e.k === "frame") { if (e.k === "decode") decoding++; else framing++; continue; }
      for (const s of e.s) {
        const q = qubits[s];
        if (!q) continue;
        q.flash.material.color.setHex(color);
        q.flash.material.opacity = e.k === "factory" ? 0.35 : 0.95;
        q.mesh.material.emissive.setHex(color);
        q.mesh.material.emissiveIntensity = 1.4;
      }
      if (e.k === "2q" && e.s.length === 2) {
        pairs.push(e.s);
        const c = couplerOf.get(Math.min(...e.s) + "-" + Math.max(...e.s));
        if (c) c.mesh.material.emissiveIntensity = 2.2;
        if (dev.kind === "atoms") sheet.material.opacity = 0.16;
      }
      if (dev.kind !== "transmon" && (e.k === "2q" || e.k === "1q" || e.k === "measure"))
        for (const s of e.s) {
          const p = positionAt(s, t);
          const g = new THREE.BufferGeometry().setFromPoints([p.clone().setY(4), p]);
          const line = new THREE.Line(g, beamMaterial(e.k === "2q" ? (dev.kind === "atoms" ? COLORS.rydberg : COLORS["2q"]) : color));
          scene.add(line);
          beams.push(line);
        }
    }
    // A Rydberg pair or an MS pair: a short bright bond between the two.
    for (const [a, b] of pairs) if (dev.kind !== "transmon") {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([positionAt(a, t), positionAt(b, t)]), beamMaterial(0xffffff));
      scene.add(line);
      beams.push(line);
    }
    // A qubit in motion trails a white halo.
    for (let k = 0; k < n; k++) if (byMoves[k].some((m) => t > m.t0 && t < m.t1)) {
      qubits[k].flash.material.color.setHex(0xffffff);
      qubits[k].flash.material.opacity = 0.8;
    }
    decoder.material.emissiveIntensity = decoding + framing ? 1.6 : 0;
    const ctl = control?.update(t, { decoding, framing });
    hudTime.textContent = "machine time " + fmt(t) + " / " + fmt(endNs) + (ctl ? " · " + ctl.activePulses + " pulse" + (ctl.activePulses === 1 ? "" : "s") + " playing" : "");
    const lines = active.filter((e) => e.k !== "decode").slice(0, 5).map((e) => `<li><b style="color:#${COLORS[e.k].toString(16).padStart(6, "0")}">●</b> ${e.line.replace(/[<>&]/g, "")}</li>`);
    if (decoding) lines.unshift(`<li><b style="color:#f472b6">●</b> decoder cores: ${decoding} decode${decoding > 1 ? "s" : ""} running</li>`);
    if (framing) lines.unshift(`<li><b style="color:#e879f9">●</b> frame core: Pauli-frame update</li>`);
    hudNow.innerHTML = lines.join("");
    scrub.value = String(Math.round((t / endNs) * 1000));
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }
  function loop(now) {
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) {
      t += (dt * speed * endNs) / runSeconds;
      if (t > endNs) t = 0;
    }
    resize();
    update();
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  return { dispose: () => { disposed = true; renderer.dispose(); } };
}
