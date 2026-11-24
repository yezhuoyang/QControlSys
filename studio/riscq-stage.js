// 3D stage of the RISC-Q workspace. It builds ONE world per run (riscq-world.js): the
// apparatus, the converters and channels that drive it, the controller and, for laser
// platforms, the optical table. The three views (riscq-layers.js VIEWS) frame that world and
// fade the parts they do not emphasise. They never rebuild or move a part, so switching views
// shows the same machine.
//
// The apparatus is drawn in the convention of its field:
//   qccd           QCCD Studio's map: pink rails, capsule sites coloured by zone, rows of
//                  electrodes along the rails, ions as numbered navy discs
//   neutral        the figures of neutral-atom papers: a dark array, zones outlined, static
//                  traps as faint dots, atoms as glowing points, tweezers and sheet beams as light
//   superconducting a sapphire die with transmon crosses, meander resonators and couplers;
//                  microwave pulses run along the coax as bright packets
// Light (beams, fluorescence) and signals are objects of riscq-light.js with their own hover
// cards. Everything moving is passed in by the page, derived from the trace; this module
// computes no timing.
import * as T from "three";
import { OrbitControls } from "/three/OrbitControls.js";
import { createStage, box, surface } from "./scene.js";
import * as layers from "./riscq-layers.js";
import { worldLayout, viewOf, R, RINGS } from "./riscq-world.js";
import { lightMaterial, envelopeTube, focusedSamples, glowSprite, signalPacket, wavelengthRgb } from "./riscq-light.js";

const graphite = surface(0x273439), silver = surface(0xb8c4c7, 0.54), gold = surface(0xd2ac60, 0.5),
  ceramic = surface(0xb4a284), teal = surface(0x58b8ac), slab = surface(0x24493f, 0.1, 0.8),
  channelBase = surface(0x26785e), demodBase = surface(0x6c5a94, 0.2), dioBase = surface(0x4f6a82, 0.2),
  memory = surface(0x3f9a72), adcBody = surface(0x6aa0c8, 0.3), apparatus = surface(0xb096ca, 0.44),
  wire = surface(0x55747a, 0.2), sapphire = surface(0x9fb4c8, 0.15, 0.3), niobium = surface(0xc9d2d6, 0.7, 0.35),
  coax = surface(0x8a9aa0, 0.5, 0.4), table = surface(0x2b3437, 0.3, 0.7), steel = surface(0x9aa6aa, 0.7, 0.35);
function glow(color, emissive) {
  const material = new T.MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.45 });
  material.emissive.setHex(emissive);
  return material;
}
// These colours match the legend in riscq-studio.css.
const actingMat = glow(0x92f4c9, 0x1d6b52), targetMat = glow(0xffd46c, 0x7a5310), pathMat = glow(0x8fe6ff, 0x1c5f78),
  openMat = glow(0xf2a36b, 0x6b3410), faultMat = glow(0xf1583a, 0x7a1d0c), chosenMat = glow(0xf1ffed, 0x666666),
  movingMat = glow(0xffb45c, 0x8a4a0c), hoverMat = glow(0xe8fff7, 0x2c5a4c);
// QCCD Studio's palette.
const studio = {
  die: surface(0xf6f7fb, 0, 0.9), rail: surface(0xf2b4b8, 0, 0.8), electrode: surface(0xdfe3ec, 0.1, 0.6), electrodeOn: glow(0xffb26b, 0xb35a10),
  data: surface(0x8f98a6, 0.1, 0.6), gate: surface(0x5fb3a6, 0.1, 0.6), load: surface(0xf1c24d, 0.1, 0.6), aux: surface(0xb7bdc8, 0.1, 0.6),
  ion: surface(0x243063, 0.1, 0.5), ionMoving: glow(0xffa24a, 0x8a4a0c),
};
// Neutral-atom figure palette.
const array = { die: surface(0x05070d, 0, 0.95), storage: surface(0x0c1a2c, 0, 0.9), entangle: surface(0x1d1030, 0, 0.9), readout: surface(0x10261c, 0, 0.9),
  edge: new T.LineBasicMaterial({ color: 0x5f86b0, transparent: true, opacity: 0.6 }), trap: new T.MeshBasicMaterial({ color: 0x3f6f9f }) };
const round = new T.CylinderGeometry(1, 1, 1, 16), hexagon = new T.CylinderGeometry(1, 1, 1, 6),
  ball = new T.SphereGeometry(1, 18, 12), cone = new T.ConeGeometry(1, 1, 14), capsule = new T.CapsuleGeometry(1, 2, 4, 12);

function solid(parent, geometry, x, y, z, sx, sy, sz, material) {
  const mesh = new T.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  parent.add(mesh);
  return mesh;
}
function barrel(parent, x, y, z, radius, length, material) {
  const mesh = solid(parent, round, x, y, z, radius, length, radius, material);
  mesh.rotation.z = Math.PI / 2;
  return mesh;
}
function beam(parent, a, b, width, material) {
  const length = a.distanceTo(b);
  if (!length) return null;
  const mid = a.clone().lerp(b, 0.5);
  const mesh = box(parent, mid.x, mid.y, mid.z, width, width, length, material);
  mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), b.clone().sub(a).normalize());
  return mesh;
}
const V = (p) => new T.Vector3(p[0], p[1], p[2]);

// One recognizable shape per controller part kind. Each returns its height.
// The same shapes as the detailed debugger (riscq.js), so a part looks the same on both pages.
export const shapes = {
  host(g) {
    box(g, 0, 0.9, 0, 6.5, 1.8, 7.5, graphite);
    box(g, -1.3, 2.0, 0, 2.6, 0.4, 2.6, silver);
    for (let k = 0; k < 4; k++) box(g, 1.1 + k * 0.6, 2.4, 0, 0.3, 1.2, 5, memory);
    return 3;
  },
  hub(g) {
    solid(g, hexagon, 0, 0.7, 0, 2.6, 1.4, 2.6, gold);
    solid(g, round, 0, 1.7, 0, 1.3, 0.6, 1.3, graphite);
    return 2;
  },
  core(g) {
    box(g, 0, 0.4, 0, 4, 0.8, 4, graphite);
    box(g, 0, 1.0, 0, 2.8, 0.4, 2.8, silver);
    for (const side of [-2.1, 2.1]) {
      box(g, 0, 0.15, side, 3.6, 0.3, 0.25, gold);
      box(g, side, 0.15, 0, 0.25, 0.3, 3.6, gold);
    }
    return 1.2;
  },
  link(g) {
    barrel(g, 0, 0.8, 0, 0.5, 3, teal);
    for (const x of [-1, 0, 1]) barrel(g, x, 0.8, 0, 0.85, 0.28, silver);
    return 1.7;
  },
  inbox(g) {
    box(g, 0, 0.15, 0, 2, 0.3, 1.8, ceramic);
    box(g, 0, 0.6, -0.8, 2, 0.9, 0.2, ceramic);
    for (const side of [-0.9, 0.9]) box(g, side, 0.6, 0, 0.2, 0.9, 1.8, ceramic);
    return 1.1;
  },
  pulse(g) {
    box(g, 0, 0.5, 0, 5, 1, 3.6, channelBase);
    for (const [x, h] of [[-1.5, 0.7], [0, 1.5], [1.5, 0.7]]) box(g, x, 1 + h / 2, 0, 1, h, 2.2, gold);
    return 2.5;
  },
  demod(g) {
    box(g, 0, 0.5, 0, 5, 1, 3.6, demodBase);
    solid(g, cone, 0, 1.9, 0, 1.3, 1.8, 1.3, silver).rotation.x = Math.PI;
    return 2.8;
  },
  dio(g) {
    box(g, 0, 0.5, 0, 5, 1, 3.6, dioBase);
    [1.2, 0.4, 1.2, 0.4].forEach((h, k) => box(g, -1.5 + k, 1 + h / 2, 0, 0.6, h, 1.6, gold));
    return 2.2;
  },
  dac(g) {
    box(g, 0, 0.6, 0, 2, 1.2, 1.3, gold);
    barrel(g, 1.7, 0.6, 0, 0.4, 1.4, gold);
    barrel(g, 2.5, 0.6, 0, 0.16, 0.3, silver);
    return 1.2;
  },
  adc(g) {
    box(g, 0, 0.6, 0, 2, 1.2, 1.3, adcBody);
    barrel(g, 1.7, 0.6, 0, 0.4, 1.4, teal);
    barrel(g, 1.1, 0.6, 0, 0.7, 0.2, silver);
    return 1.2;
  },
  pins(g) {
    box(g, 0, 0.25, 0, 2.2, 0.5, 1.3, graphite);
    for (let k = 0; k < 4; k++) solid(g, round, -0.75 + k * 0.5, 1, 0, 0.12, 1, 0.12, gold);
    return 1.5;
  },
  device(g) {
    solid(g, round, 0, 0.4, 0, 0.5, 0.8, 0.5, graphite);
    solid(g, ball, 0, 1.7, 0, 1, 1, 1, apparatus);
    return 2.7;
  },
};

// Apparatus shapes, in units of the part's own size.
const apparatusShapes = {
  qubit(g) {
    box(g, 0, 0.3, 0, 7, 0.6, 1.6, niobium);
    box(g, 0, 0.3, 0, 1.6, 0.6, 7, niobium);
    box(g, 0, 0.8, 0, 1.4, 0.5, 1.4, gold);
    return 1.2;
  },
  resonator(g) {
    for (let k = 0; k < 4; k++) box(g, -2.4 + k * 1.6, 0.25, 0, 0.5, 0.5, 4.5, niobium);
    box(g, 0, 0.25, 2.3, 5.3, 0.5, 0.5, niobium);
    return 0.8;
  },
  // A laser head: the end of a fibre with its focusing optics, pointing at the apparatus.
  light(g) {
    barrel(g, 0, 1.6, 0, 1.4, 4.5, steel);
    barrel(g, 2.6, 1.6, 0, 1.1, 0.8, surface(0x9fd6ff, 0.1, 0.1));
    box(g, -0.6, 0.5, 0, 3.4, 1, 2.6, graphite);
    return 3;
  },
  // An AOD: a crystal with its RF transducer.
  tone(g) {
    box(g, 0, 1, 0, 3.4, 2, 2.4, surface(0xcfe3ea, 0.1, 0.15));
    box(g, 0, 2.2, 0, 3.4, 0.4, 2.4, gold);
    return 2.6;
  },
};

/**
 * Create the stage in `host`. `hooks.pick(id)` selects a part, `hooks.hover(id | null, x, y)`
 * reports what is under the pointer in client coordinates: a part id, "ion:<name>",
 * "atom:<n>", "beam:<id>", "signal:<id>", "coupler:…", "trapsite:…" or "zone:…".
 */
export function createWorkspaceStage(host, hooks) {
  const { world: scene, renderer, canvas } = createStage(host, "Orbitable 3D view of a RISC-Q run: apparatus, light, converters, channels and controller");
  const root = new T.Group(), overlay = new T.Group(), bodies = new T.Group(), light = new T.Group();
  scene.add(root, overlay, bodies, light);
  const camera = new T.OrthographicCamera(-200, 200, 120, -120, 0.1, 12000);
  const controls = new OrbitControls(camera, canvas);
  controls.minZoom = 0.3;
  controls.maxZoom = 120;
  controls.maxPolarAngle = Math.PI * 0.49;
  const ray = new T.Raycaster(), ndc = new T.Vector2(), vec = new T.Vector3();
  const labelLayer = host.querySelector(".labels");
  const parts = new Map(), lit = new Set(), target = new T.Vector3();
  const ring = new T.Mesh(new T.TorusGeometry(1, 0.07, 8, 40), chosenMat);
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  scene.add(ring);
  let run = null, view = "chip", w = null, emphasis = new Set(), width = 1, height = 1, fitWidth = 200, fitHeight = 120;
  let tags = [], pinned = [], hovered = null, platform = null;
  const faded = new Map();
  const fadedOf = (material) => {
    if (!faded.has(material)) {
      const copy = material.clone();
      copy.transparent = true;
      copy.opacity = 0.18;
      copy.depthWrite = false;
      faded.set(material, copy);
    }
    return faded.get(material);
  };

  function render() {
    renderer.render(scene, camera);
    labelLayer.replaceChildren();
    const placed = [];
    const all = [...tags];
    if (hovered && !all.some((t) => t[0] === hovered)) all.push([hovered, hovered.replace(/^(beam|signal):/, ""), "hover"]);
    all.push(...pinned);
    for (const [id, text, kind] of all) {
      const anchor = parts.get(id)?.top ?? platform?.anchor?.(id);
      if (!anchor) continue;
      vec.copy(anchor).project(camera);
      const x = ((vec.x + 1) * width) / 2, y = ((1 - vec.y) * height) / 2;
      if (x < 16 || x > width - 16 || y < 16 || y > height - 16) continue;
      const span = kind.startsWith("pin") ? 22 : 84;
      if (placed.some((p) => Math.abs(x - p[0]) < span && Math.abs(y - p[1]) < (kind.startsWith("pin") ? 11 : 20))) continue;
      const tag = document.createElement("span");
      tag.className = "annotation " + kind;
      tag.textContent = text;
      tag.style.left = x + "px";
      tag.style.top = y + "px";
      labelLayer.append(tag);
      placed.push([x, y]);
    }
  }
  function resize() {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    const half = Math.max(fitWidth, (fitHeight * width) / height);
    camera.left = -half;
    camera.right = half;
    camera.top = (half * height) / width;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    render();
  }
  /** Camera direction of a view: QCCD Studio's map is read from above, the others obliquely. */
  function direction() {
    if (view === "chip" && run?.platform === "qccd") return new T.Vector3(0, 1, 0.32);
    if (view === "chip" && run?.platform === "neutral") return new T.Vector3(0.18, 0.82, 0.78);
    if (view === "chip") return new T.Vector3(0.05, 1, 0.62);
    return new T.Vector3(0.12, 0.9, 0.8);
  }
  function home() {
    const frame = w ? viewOf(run, view).frame : { center: [0, 0, 0], half: [200, 200] };
    target.set(...frame.center);
    camera.zoom = 1;
    controls.target.copy(target);
    camera.position.copy(target).add(direction().normalize().multiplyScalar(4000));
    controls.update();
    camera.updateMatrixWorld();
    const inverse = camera.matrixWorldInverse, centre = target.clone().applyMatrix4(inverse);
    let widest = 30, tallest = 20;
    for (const x of [-1, 1]) for (const z of [-1, 1]) for (const y of [0, 30]) {
      vec.set(frame.center[0] + x * frame.half[0], y, frame.center[2] + z * frame.half[1]).applyMatrix4(inverse);
      widest = Math.max(widest, Math.abs(vec.x - centre.x));
      tallest = Math.max(tallest, Math.abs(vec.y - centre.y));
    }
    fitWidth = widest * 1.04;
    fitHeight = tallest * 1.06;
    resize();
  }

  function addPart(part, position, scale, shape, angle = 0) {
    const group = new T.Group();
    group.position.copy(position);
    group.scale.setScalar(scale);
    group.rotation.y = angle;
    group.userData.part = part.id;
    const height = shape(group);
    const meshes = [];
    group.traverse((mesh) => {
      if (!mesh.isMesh) return;
      mesh.userData.base = mesh.material;
      mesh.castShadow = mesh.receiveShadow = true;
      meshes.push(mesh);
    });
    root.add(group);
    const top = group.position.clone();
    top.y += (height + 0.9) * scale;
    const anchor = group.position.clone();
    anchor.y += 0.25 * scale;
    parts.set(part.id, { part, group, meshes, top, anchor });
    return parts.get(part.id);
  }
  const restOf = (id, mesh) => (emphasis.has(id) || !parts.has(id) ? mesh.userData.base : fadedOf(mesh.userData.base));

  // ───────────────────────────── the world ─────────────────────────────

  function buildWorld() {
    root.clear();
    overlay.clear();
    bodies.clear();
    light.clear();
    parts.clear();
    lit.clear();
    tags = [];
    pinned = [];
    hovered = null;
    platform = null;
    ring.visible = false;
    if (!run?.system?.parts?.length) return;
    w = worldLayout(run);
    // Floors: the disc of the apparatus and its drive, the controller annulus, the bus ring.
    const floor = solid(root, round, 0, -3, 0, RINGS.channel + 36, 1, RINGS.channel + 36, slab);
    floor.userData.ground = true;
    const annulus = new T.Mesh(new T.RingGeometry(RINGS.core - 22, RINGS.bus + 12, 96), surface(0x1e3a33, 0.1, 0.85));
    annulus.rotation.x = -Math.PI / 2;
    annulus.position.y = -2.6;
    root.add(annulus);
    const bus = new T.Mesh(new T.TorusGeometry(RINGS.bus, 1.1, 8, 160), teal);
    bus.rotation.x = -Math.PI / 2;
    bus.position.y = 0.8;
    bus.userData.part = "bus";
    root.add(bus);
    // The apparatus in its field's convention.
    platform = run.platform === "qccd" ? trapMap() : run.platform === "neutral" ? atomArray() : run.platform === "superconducting" ? transmonChip() : null;
    // Drive and control parts at their world positions, facing the centre.
    for (const [id, p] of w.parts) {
      if (p.kind === "device" || parts.has(id)) continue;
      const part = run.system.parts.find((x) => x.id === id);
      addPart(part, V(p.at), p.size * (p.region === "control" ? 1.15 : 1), shapes[p.kind] ?? shapes.device, -p.angle + Math.PI / 2);
    }
    // Wires: coax from converters to apparatus, plain wires elsewhere, spokes to the bus.
    for (const wire0 of w.wires) {
      if (wire0.kind === "bus") {
        const angle = wire0.angle, inner = parts.get(wire0.from)?.anchor ?? new T.Vector3(Math.cos(angle) * RINGS.bus, 0.8, Math.sin(angle) * RINGS.bus);
        const outer = parts.get(wire0.to)?.anchor ?? new T.Vector3(Math.cos(angle) * RINGS.bus, 0.8, Math.sin(angle) * RINGS.bus);
        beam(root, inner.clone().setY(0.8), outer.clone().setY(0.8), 0.9, teal);
        continue;
      }
      const a = parts.get(wire0.from)?.anchor ?? (w.parts.get(wire0.from) && V(w.parts.get(wire0.from).at)), b = parts.get(wire0.to)?.anchor ?? (w.parts.get(wire0.to) && V(w.parts.get(wire0.to).at));
      if (!a || !b) continue;
      const mesh = beam(root, a.clone().setY(1), b.clone().setY(1), wire0.kind === "coax" ? (wire0.shared ? 0.35 : 0.7) : 0.45, wire0.kind === "coax" ? coax : wire);
      if (mesh) {
        mesh.userData.base = mesh.material;
        mesh.userData.wire = wire0;
      }
    }
    if (w.table && platform?.table) platform.table();
  }

  /** Apply a view: fade the parts it does not emphasise and frame it. */
  function applyView() {
    emphasis = w ? viewOf(run, view).emphasis : new Set();
    for (const [id, entry] of parts) for (const mesh of entry.meshes) if (!lit.has(id)) mesh.material = restOf(id, mesh);
    home();
  }

  // ───────────────────────────── trapped ions: QCCD Studio's map ─────────────────────────────

  function trapMap() {
    const chip = w.chip, s = w.scale;
    const inside = (v) => Math.abs(v.x) <= 1.12 * R && Math.abs(v.z) <= 1.12 * R;
    const sites = new Map(), siteMeta = new Map((run.machine.geometry?.sites ?? []).map((x) => [x.id, x]));
    for (const [id, p] of chip.sites ?? []) sites.set(id, V(w.toWorld(p)));
    // The canvas of the map: the drawn part of the architecture with a margin, as QCCD Studio frames it.
    const shown = [...sites.values()].filter(inside);
    const minX = Math.max(-1.15 * R, Math.min(...shown.map((v) => v.x)) - 0.25 * R), maxX = Math.min(1.15 * R, Math.max(...shown.map((v) => v.x)) + 0.25 * R);
    const minZ = Math.max(-1.15 * R, Math.min(...shown.map((v) => v.z)) - 0.25 * R), maxZ = Math.min(1.15 * R, Math.max(...shown.map((v) => v.z)) + 0.25 * R);
    const die = shown.length ? box(root, (minX + maxX) / 2, -1, (minZ + maxZ) / 2, maxX - minX, 2, maxZ - minZ, studio.die) : box(root, 0, -1, 0, 2.3 * R, 2, 2.3 * R, studio.die);
    die.userData.ground = true;
    // Pitch: the median rail on the die decides the size of sites and electrodes.
    const lengths = (chip.edges ?? []).filter(([a, b]) => sites.has(a) && sites.has(b) && (inside(sites.get(a)) || inside(sites.get(b))))
      .map(([a, b]) => sites.get(a).distanceTo(sites.get(b))).filter((d) => d > 0).sort((x, y) => x - y);
    let pitch = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0.5 * s;
    pitch = Math.max(12, Math.min(60, pitch));
    const railWidth = 0.13 * pitch, electrodes = new Map();
    for (const [a, b] of chip.edges ?? []) {
      const pa = sites.get(a), pb = sites.get(b);
      if (!pa || !pb || (!inside(pa) && !inside(pb))) continue;
      const rail = beam(root, pa.clone().setY(0.2), pb.clone().setY(0.2), railWidth, studio.rail);
      if (rail) rail.scale.y = 0.15 * rail.scale.x;
      // Rows of electrodes on both sides of the rail, as QCCD Studio draws them.
      const along = pb.clone().sub(pa), length = along.length(), unit = along.clone().normalize(), across = new T.Vector3(-unit.z, 0, unit.x);
      const count = Math.max(2, Math.round(length / (0.11 * pitch)));
      for (let k = 0; k < count; k++)
        for (const side of [-1, 1]) {
          const at = pa.clone().addScaledVector(unit, ((k + 0.5) / count) * length).addScaledVector(across, side * 0.2 * pitch);
          const pill = solid(root, capsule, at.x, 0.3, at.z, 0.03 * pitch, 0.03 * pitch, 0.03 * pitch, studio.electrode);
          pill.rotation.x = Math.PI / 2;
          pill.rotation.z = Math.atan2(across.z, across.x);
          pill.userData.base = studio.electrode;
          for (const site of [a, b]) {
            if (!electrodes.has(site)) electrodes.set(site, []);
            electrodes.get(site).push(pill);
          }
        }
    }
    for (const [id, at] of sites) {
      if (!inside(at)) continue;
      const zone = siteMeta.get(id)?.zone ?? "";
      const material = siteMeta.get(id)?.gate ? studio.gate : /load/.test(zone) ? studio.load : /aux|conveyor/.test(zone) ? studio.aux : studio.data;
      const pad = solid(root, capsule, at.x, 0.5, at.z, 0.07 * pitch, 0.07 * pitch, 0.07 * pitch, material);
      pad.rotation.z = Math.PI / 2;
      pad.scale.set(0.07 * pitch, 0.1 * pitch, 0.07 * pitch);
      pad.userData.part = "trapsite:" + id;
      pad.userData.base = material;
    }
    // Apparatus parts: a site's light lands on its site; a zone's electrodes are its rows.
    // Ions float 70 µm above the surface (Pino et al. 2021), to the map's scale.
    const ionHeight = (70 * s) / (run.machine.geometry?.units?.micrometresPerUnit ?? 750);
    for (const part of run.system.parts.filter((p) => p.kind === "device")) {
      const site = part.id.replace(/^(?:site|electrodes):(?:zone\.)?/, "");
      if (/^site:/.test(part.id) && sites.has(site)) {
        const entry = addPart(part, sites.get(site).clone().setY(0.6), 0.07 * pitch, (g) => {
          const halo = solid(g, round, 0, 0.1, 0, 2.2, 0.2, 2.2, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
          void halo;
          return 1.4;
        });
        entry.top = sites.get(site).clone().setY(ionHeight + 0.1 * pitch);
      } else if (/^electrodes:/.test(part.id) && sites.has(site)) {
        const entry = addPart(part, sites.get(site).clone().setY(0.3), 1, () => 0.5);
        entry.meshes.push(...(electrodes.get(site) ?? []));
        entry.top = sites.get(site).clone().add(new T.Vector3(0, 0.3 * pitch, 0.25 * pitch));
      } else {
        // Broadcast light and banks without a site: a laser head at the edge of the trap.
        const p = w.parts.get(part.id);
        const at = V(p.at);
        if (!at.length()) at.set(-1.15 * R, 0, -0.9 * R);
        addPart(part, at, 0.06 * pitch, apparatusShapes.light, Math.atan2(at.z, -at.x));
      }
    }
    const ions = new Map();
    return {
      pitch, ionHeight, scale: s, sites,
      anchor: (id) => (ions.get(id)?.visible ? ions.get(id).position.clone().add(new T.Vector3(0, 0.12 * pitch, 0)) : null),
      bodies(extra) {
        const seen = new Set(), radius = 0.045 * pitch;
        for (const ion of extra.ions ?? []) {
          if (!ion.at) continue;
          const id = "ion:" + ion.ion;
          seen.add(id);
          let mesh = ions.get(id);
          if (!mesh) {
            mesh = solid(bodies, round, 0, 0, 0, radius, 0.4 * radius, radius, studio.ion);
            mesh.userData.part = id;
            ions.set(id, mesh);
          }
          const same = (extra.ions ?? []).filter((o) => !o.moving && o.site === ion.site && o.at);
          const k = ion.moving ? 0 : same.indexOf(ion) - (same.length - 1) / 2;
          mesh.position.copy(V(w.toWorld(ion.at))).add(new T.Vector3(k * radius * 2.6, ionHeight, 0));
          mesh.material = ion.moving ? studio.ionMoving : studio.ion;
          mesh.visible = true;
          pinned.push([id, ion.ion.replace(/^q/, ""), "pin ion"]);
        }
        for (const [id, mesh] of ions) if (!seen.has(id)) mesh.visible = false;
      },
      table: () => opticalTable(),
    };
  }

  // ───────────────────────────── neutral atoms: a paper figure ─────────────────────────────

  function atomArray() {
    const chip = w.chip, geo = run.machine.geometry ?? {}, s = w.scale;
    const die = box(root, 0, -1, 0, 2.3 * R, 2, 2.3 * R, array.die);
    die.userData.ground = true;
    const clampX = (v) => Math.max(-1.12 * R, Math.min(1.12 * R, v));
    for (const zone of geo.zones ?? chip.zones ?? []) {
      const a = V(w.toWorld(zone.origin)), b = V(w.toWorld([zone.origin[0] + zone.size[0], zone.origin[1] + zone.size[1]]));
      const x0 = clampX(Math.min(a.x, b.x)), x1 = clampX(Math.max(a.x, b.x)), z0 = clampX(Math.min(a.z, b.z)), z1 = clampX(Math.max(a.z, b.z));
      if (x1 - x0 < 1 || z1 - z0 < 1) continue;
      const fill = box(root, (x0 + x1) / 2, 0.02, (z0 + z1) / 2, x1 - x0, 0.04, z1 - z0, zone.kind === "entanglement" ? array.entangle : zone.kind === "readout" ? array.readout : array.storage);
      fill.userData.part = "zone:" + zone.id;
      fill.userData.zone = zone;
      const edge = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(x1 - x0, 0.1, z1 - z0)), array.edge);
      edge.position.set((x0 + x1) / 2, 0.1, (z0 + z1) / 2);
      root.add(edge);
    }
    // Static traps: one faint dot per trap of the architecture that falls on the die.
    const dots = [];
    for (const trap of geo.traps ?? [])
      for (let r = 0; r < trap.rows; r++)
        for (let c = 0; c < trap.columns; c++) {
          const at = w.toWorld([trap.origin[0] + c * trap.pitch[0], trap.origin[1] + r * trap.pitch[1]]);
          if (Math.abs(at[0]) <= 1.12 * R && Math.abs(at[2]) <= 1.12 * R) dots.push(at);
        }
    if (dots.length) {
      const dotR = Math.max(0.25, Math.min(0.9, 0.5 * s));
      const instanced = new T.InstancedMesh(new T.CylinderGeometry(dotR, dotR, 0.05, 8), array.trap, dots.length);
      const m = new T.Matrix4();
      dots.forEach((at, k) => instanced.setMatrixAt(k, m.makeTranslation(at[0], 0.08, at[2])));
      instanced.userData.part = "zone:traps";
      root.add(instanced);
    }
    // Light heads and AOD crystals at the edge of the array.
    for (const part of run.system.parts.filter((p) => p.kind === "device")) {
      const p = w.parts.get(part.id), at = V(p.at);
      if (/^aod\d+:/.test(part.id)) {
        const k = Number(/^aod(\d+)/.exec(part.id)[1]), x = /:x/.test(part.id);
        const index = Number(/(\d+)$/.exec(part.id)[1]);
        const pos = x ? new T.Vector3(-0.9 * R + 14 * k + 4 * index, 0, -1.22 * R) : new T.Vector3(-1.22 * R, 0, -0.9 * R + 14 * k + 4 * index);
        addPart(part, pos, 1.1, apparatusShapes.tone);
      } else {
        const head = /rydberg/.test(part.id) ? new T.Vector3(-1.25 * R, 0, 0.55 * R) : new T.Vector3(1.25 * R, 0, -0.95 * R);
        addPart(part, head, 2, apparatusShapes.light, Math.atan2(head.z, -head.x));
      }
    }
    // The objective above the array, through which every tweezer is focused.
    // Drawn as a glass element so the array stays visible beneath it.
    const objectiveHeight = 0.9 * R;
    const glassMat = new T.MeshPhysicalMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0, depthWrite: false });
    const lens = solid(root, ball, 0, objectiveHeight, 0, 0.3 * R, 0.05 * R, 0.3 * R, glassMat);
    lens.userData.part = "optic:objective";
    const rim = new T.Mesh(new T.TorusGeometry(0.31 * R, 0.012 * R, 8, 64), surface(0x8a98a0, 0.7, 0.3));
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = objectiveHeight;
    rim.userData.part = "optic:objective";
    root.add(rim);
    const atoms = new Map(), halos = new Map();
    const tones = new Map();
    return {
      objectiveHeight, scale: s,
      anchor: (id) => (atoms.get(id)?.visible ? atoms.get(id).position.clone().add(new T.Vector3(0, 3, 0)) : null),
      bodies(extra) {
        const seen = new Set(), radius = Math.max(0.5, Math.min(2.2, 0.9 * s));
        for (const atom of extra.atoms ?? []) {
          const id = "atom:" + atom.atom;
          seen.add(id);
          let mesh = atoms.get(id);
          if (!mesh) {
            mesh = solid(bodies, ball, 0, 0, 0, radius, radius, radius, new T.MeshBasicMaterial({ color: 0xfff1c9 }));
            mesh.userData.part = id;
            atoms.set(id, mesh);
            const h = glowSprite([1, 0.78, 0.42], radius * 7, 0.85);
            h.userData.part = id;
            bodies.add(h);
            halos.set(id, h);
          }
          mesh.position.copy(V(w.toWorld(atom.at))).setY(radius + 0.2);
          mesh.material.color.setHex(atom.carried ? 0xffc27a : 0xfff1c9);
          mesh.visible = true;
          const h = halos.get(id);
          h.position.copy(mesh.position);
          h.material = glowSprite(atom.carried ? [1, 0.55, 0.25] : [1, 0.78, 0.42], 1).material;
          h.scale.setScalar(radius * (atom.carried ? 9 : 7));
          h.visible = true;
          pinned.push([id, String(atom.atom), "pin atom"]);
        }
        for (const [id, mesh] of atoms) if (!seen.has(id)) {
          mesh.visible = false;
          halos.get(id).visible = false;
        }
        // RF tones: a faint line on the array where each tone's deflected beam would land.
        const open = new Set(extra.openParts ?? []);
        for (const [part, um] of extra.tones ?? []) {
          let line = tones.get(part);
          const axis = /\.x/.test(part) ? "x" : "y";
          if (!line) {
            line = box(bodies, 0, 0.15, 0, axis === "x" ? 0.25 : 2.3 * R, 0.05, axis === "x" ? 2.3 * R : 0.25, lightMaterial([1, 0.35, 0.25], 0.18));
            line.userData.part = part.replace(".", ":");
            tones.set(part, line);
          }
          const at = V(w.toWorld(axis === "x" ? [um, 0] : [0, um]));
          if (axis === "x") line.position.x = at.x;
          else line.position.z = at.z;
          line.material = lightMaterial([1, 0.35, 0.25], open.has(part) ? 0.28 : 0.1);
          line.visible = true;
        }
        for (const [part, line] of tones) if (!(extra.tones ?? new Map()).has(part)) line.visible = false;
      },
      table: () => opticalTable(),
    };
  }

  // ───────────────────────────── superconducting: the chip ─────────────────────────────

  function transmonChip() {
    const chip = w.chip;
    const die = box(root, 0, -1, 0, 2.3 * R, 2, 2.3 * R, sapphire);
    die.userData.ground = true;
    const pitch = Math.max(1, Math.min(5, w.scale * 0.07));
    const couplerMeshes = new Map();
    for (const [a, b, offered] of chip.couplers ?? []) {
      const pa = chip.devices.get(chip.qubitParts?.[a] ?? "qubit" + a), pb = chip.devices.get(chip.qubitParts?.[b] ?? "qubit" + b);
      if (!pa || !pb) continue;
      const wa = V(w.toWorld(pa)), wb = V(w.toWorld(pb));
      const mesh = beam(root, wa.clone().lerp(wb, 0.22).setY(0.4), wa.clone().lerp(wb, 0.78).setY(0.4), 1.1 * pitch, offered === false ? graphite : niobium);
      mesh.userData.base = mesh.material;
      mesh.userData.part = "coupler:" + a + "-" + b + (offered === false ? ":not offered" : "");
      couplerMeshes.set([a, b].sort((x, y) => x - y).join("-"), mesh);
    }
    for (const part of run.system.parts.filter((p) => p.kind === "device")) {
      const kind = chip.types?.get(part.id) ?? (/^resonator/.test(part.id) ? "resonator" : "qubit");
      addPart(part, V(w.parts.get(part.id).at), pitch, apparatusShapes[kind] ?? shapes.device);
    }
    return {
      couplerMeshes,
      anchor: () => null,
      bodies() {
        for (const [id] of chip.devices) if (/^qubit/.test(id) || chip.types?.get(id) === "qubit") pinned.push([id, id.replace(/^qubit/, "Q"), "pin"]);
      },
    };
  }

  // ───────────────────────────── optical table ─────────────────────────────

  /** The bench of a laser platform beside the controller: `extra.bench` elements drawn by `show`. */
  function opticalTable() {
    const t = w.table;
    const plate = box(root, t.at[0], -2, t.at[2], t.size[0], 4, t.size[1], table);
    plate.userData.part = "optic:table";
    plate.userData.ground = true;
    // Mounting holes on a 25 mm grid, drawn every 20 world units.
    const holes = new T.InstancedMesh(new T.CylinderGeometry(0.6, 0.6, 0.2, 6), surface(0x1a2022), Math.floor(t.size[0] / 20) * Math.floor(t.size[1] / 20));
    let n = 0;
    const m = new T.Matrix4();
    for (let x = -t.size[0] / 2 + 10; x < t.size[0] / 2; x += 20) for (let z = -t.size[1] / 2 + 10; z < t.size[1] / 2; z += 20) holes.setMatrixAt(n++, m.makeTranslation(t.at[0] + x, 0.1, t.at[2] + z));
    holes.count = n;
    root.add(holes);
  }

  // ───────────────────────────── light and signals ─────────────────────────────

  /**
   * Draw the live beams and signals. Each beam: { id, lambdaNm, opacity?, samples: [{ at: [x, y, z]
   * world, rx, ry }] } or { id, lambdaNm, focused: { focus: [x, y, z] world, dir, w0x, w0y, zRx, zRy,
   * before, after } }, plus glow: [{ at, size, rgb }]. Each signal: { id, from: [x,y,z], to, t, rgb }.
   */
  function drawLight(extra) {
    light.clear();
    for (const b of extra.beams ?? []) {
      const rgb = b.rgb ?? (Array.isArray(b.colour) ? b.colour : wavelengthRgb(b.lambdaNm ?? 600));
      const material = lightMaterial(rgb, b.opacity ?? 0.32);
      const pieces = b.focused ? [focusedSamples({ ...b.focused, focus: V(b.focused.focus), dir: V(b.focused.dir) })] : (b.paths ?? [b.samples]).filter(Boolean).map((list) => list.map((x) => ({ ...x, at: V(x.at) })));
      for (const samples of pieces) {
        const mesh = envelopeTube(samples, material);
        if (!mesh) continue;
        mesh.userData.part = "beam:" + b.id;
        light.add(mesh);
        // A brighter core so a thin beam stays visible from afar.
        if (b.core === false) continue;
        const core = envelopeTube(samples.map((x) => ({ ...x, rx: Math.max(0.12, x.rx * 0.25), ry: Math.max(0.12, x.ry * 0.25) })), lightMaterial(rgb, Math.min(0.9, (b.opacity ?? 0.32) * 1.8)), 8);
        if (core) {
          core.userData.part = "beam:" + b.id;
          light.add(core);
        }
      }
      for (const g of b.glow ?? []) {
        const sprite = glowSprite(g.rgb ?? rgb, g.size, g.opacity ?? 0.9);
        sprite.position.copy(V(g.at));
        sprite.userData.part = "beam:" + b.id;
        light.add(sprite);
      }
    }
    // The optical bench on its table: every element, and the path of every live beam through it.
    if (extra.table) {
      const opticMats = { source: surface(0x3a4a52, 0.4, 0.4), laser: surface(0x3a4a52, 0.4, 0.4), aod: surface(0xcfe3ea, 0.1, 0.15), aom: surface(0xcfe3ea, 0.1, 0.15),
        fiber: surface(0xf0c060, 0.2, 0.5), lens: new T.MeshPhysicalMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.55, roughness: 0.05 }),
        cylLens: new T.MeshPhysicalMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.55, roughness: 0.05 }), mirror: surface(0xdfe7ea, 0.9, 0.1),
        objective: surface(0x2b3a44, 0.6, 0.35), beamSplitter: surface(0x9fd6ff, 0.2, 0.1), dichroic: surface(0x9fd6ff, 0.2, 0.1) };
      for (const e of extra.table.elements) {
        const at = V(e.world), m = opticMats[e.kind] ?? steel;
        const mesh = e.kind === "lens" || e.kind === "cylLens" || e.kind === "objective" ? solid(light, round, at.x, at.y + 4, at.z, e.kind === "objective" ? 7 : 5.5, e.kind === "objective" ? 9 : 1, e.kind === "objective" ? 7 : 5.5, m)
          : e.kind === "source" || e.kind === "laser" ? box(light, at.x, at.y + 4, at.z, 16, 8, 8, m) : box(light, at.x, at.y + 3.5, at.z, 6.5, 7, 6.5, m);
        if (e.kind === "lens" || e.kind === "cylLens") mesh.rotation.x = Math.PI / 2;
        mesh.userData.part = "optic:" + e.label;
      }
      const marker = solid(light, round, extra.table.sample[0], 2, extra.table.sample[2], 6, 1, 6, surface(0xb096ca, 0.3, 0.5));
      marker.userData.part = "optic:sample";
      for (const p of extra.table.paths) {
        const mesh = envelopeTube(p.samples.map((x) => ({ ...x, at: V(x.at).setY(V(x.at).y + 3.5) })), lightMaterial(wavelengthRgb(p.lambdaNm), 0.7), 10);
        if (!mesh) continue;
        mesh.userData.part = "beam:" + p.id;
        light.add(mesh);
      }
    }
    for (const sgl of extra.signals ?? []) {
      const a = V(sgl.from), b = V(sgl.to);
      const material = lightMaterial(sgl.rgb ?? [0.5, 0.85, 1], 0.95);
      const length = Math.max(6, a.distanceTo(b) * 0.14);
      const packet = signalPacket([a, b], Math.min(1, sgl.t), length, 2.2, material);
      if (packet) {
        packet.userData.part = "signal:" + sgl.id;
        light.add(packet);
      }
      // The part of the line the signal has filled.
      const filled = envelopeTube([{ at: a, rx: 1.1, ry: 1.1 }, { at: a.clone().lerp(b, Math.max(0.02, Math.min(1, sgl.t))), rx: 1.1, ry: 1.1 }], lightMaterial(sgl.rgb ?? [0.5, 0.85, 1], 0.55), 8);
      if (filled) {
        filled.userData.part = "signal:" + sgl.id;
        light.add(filled);
      }
      if (sgl.t >= 1 && sgl.glowAt) {
        const sprite = glowSprite(sgl.rgb ?? [0.5, 0.85, 1], sgl.glowSize ?? 10, 0.8);
        sprite.position.copy(V(sgl.glowAt));
        sprite.userData.part = "signal:" + sgl.id;
        light.add(sprite);
      }
    }
  }

  function paint(id, material) {
    const part = parts.get(id);
    if (!part) return;
    for (const mesh of part.meshes) mesh.material = material;
    lit.add(id);
  }

  /**
   * Show one step. `extra` carries what the page derived from the trace: { active: Map(device →
   * [{ window, binding }]), hint, ions, atoms, tones: Map(part → µm), openParts, beams, signals }.
   */
  function show(frame, state, path, chosen, fault, extra = {}) {
    for (const id of lit) {
      const entry = parts.get(id);
      if (entry) for (const mesh of entry.meshes) mesh.material = restOf(id, mesh);
      const coupler = platform?.couplerMeshes?.get(id);
      if (coupler) coupler.material = coupler.userData.base;
    }
    lit.clear();
    overlay.clear();
    tags = [];
    pinned = [];
    for (const window of state?.openWindows ?? []) {
      paint(window.part, openMat);
      paint(window.converter, openMat);
    }
    for (const [device, list] of extra.active ?? []) {
      // Electrodes glow orange while their transport waveform plays; other apparatus lights up.
      paint(device, /^electrodes:/.test(device) ? studio.electrodeOn : openMat);
      for (const { binding } of list)
        if (binding.detail?.pair && platform?.couplerMeshes) {
          const key = binding.detail.pair.slice().sort((a, b) => a - b).join("-"), mesh = platform.couplerMeshes.get(key);
          if (mesh) {
            mesh.material = openMat;
            lit.add(key);
          }
        }
    }
    for (const id of extra.hint ?? []) paint(id, hoverMat);
    const raise = new T.Vector3(0, 2, 0);
    for (const hop of path) {
      const from = parts.get(hop.from), to = parts.get(hop.to);
      if (!from || !to) continue;
      const own = hop.frame === frame?.id;
      if (!own) {
        paint(hop.from, pathMat);
        paint(hop.to, pathMat);
      }
      const a = from.anchor.clone().add(raise), b = to.anchor.clone().add(raise), material = own ? targetMat : pathMat;
      const wd = 1.6;
      if (hop.link) beam(overlay, a, b, wd, material);
      else {
        const dashes = Math.max(3, Math.round(a.distanceTo(b) / (4 * wd)));
        for (let k = 0; k < dashes; k++) beam(overlay, a.clone().lerp(b, k / dashes), a.clone().lerp(b, (k + 0.55) / dashes), wd, material);
      }
      const head = solid(overlay, cone, 0, 0, 0, 1.8 * wd, 4 * wd, 1.8 * wd, material);
      head.position.copy(a).lerp(b, 0.6);
      head.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    }
    if (frame) {
      for (const id of frame.targets ?? []) {
        paint(id, targetMat);
        tags.push([id, id, "target"]);
      }
      paint(frame.part, fault ? faultMat : actingMat);
      tags.unshift([frame.part, frame.part + " · " + frame.op, "active"]);
    }
    platform?.bodies(extra);
    drawLight(extra);
    const picked = parts.get(chosen);
    ring.visible = Boolean(picked);
    if (picked) {
      ring.position.copy(picked.group.position);
      ring.position.y += 0.2 * picked.group.scale.x;
      ring.scale.setScalar(3.4 * picked.group.scale.x);
      if (!tags.some((tag) => tag[0] === chosen)) tags.push([chosen, chosen, "chosen"]);
    }
    render();
  }

  function partAt(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set((2 * (e.clientX - r.left)) / r.width - 1, 1 - (2 * (e.clientY - r.top)) / r.height);
    ray.setFromCamera(ndc, camera);
    // Light first: a beam in front of a part is what the pointer is on.
    for (const group of [light, bodies, root])
      for (const hit of ray.intersectObjects(group.children, true)) {
        if (!hit.object.visible) continue;
        for (let node = hit.object; node; node = node.parent) if (node.userData.part) return node.userData.part;
      }
    return null;
  }
  let down = null, pending = null;
  canvas.addEventListener("pointerdown", (e) => {
    down = [e.clientX, e.clientY];
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const id = partAt(e);
    if (id) hooks.pick(id);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.buttons) {
      hooks.hover(null);
      return;
    }
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      const id = partAt(e);
      canvas.style.cursor = id ? "pointer" : "grab";
      hooks.hover(id, e.clientX, e.clientY);
      if (id === hovered) return;
      hovered = id;
      render();
    });
  });
  canvas.addEventListener("pointerleave", () => {
    hooks.hover(null);
    if (!hovered) return;
    hovered = null;
    render();
  });
  controls.addEventListener("change", render);
  new ResizeObserver(resize).observe(host);
  home();
  return {
    /** Load a run: build its world once and show it in `nextView`. */
    setRun(bundle, nextView = view) {
      run = bundle;
      view = nextView;
      buildWorld();
      applyView();
    },
    /** Change the view: the same world, framed and emphasised differently. */
    setView(next) {
      view = next;
      applyView();
    },
    get view() {
      return view;
    },
    /** Whether a part is emphasised in this view. Every part is in the world. */
    shows: (id) => emphasis.has(id) || /^(ion|atom|beam|signal):/.test(id),
    world: () => w,
    platform: () => platform,
    chip: () => w?.chip ?? null,
    show,
    home,
  };
}
