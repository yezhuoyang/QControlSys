// 3D stage of the RISC-Q workspace. It draws one of three views of a run (riscq-layers.js VIEWS):
//
//   chip     the apparatus at its chip layout, ringed by the converters and channels that drive it
//   control  the controller at its schematic floorplan
//   machine  every part at its floorplan position
//
// Parts that a view leaves out keep running: the page lists them as off view when they act.
// Every position is display geometry. Floorplan positions are the bundle's `system.parts`
// positions (tenths of a clock region, schematic). Chip positions come from
// riscq-layers.js `chipLayout`, whose `note` says what they are. Nothing is computed here
// about timing: the page passes the state riscq-model.js rebuilt from the frames.
import * as T from "three";
import { OrbitControls } from "/three/OrbitControls.js";
import { createStage, box, surface } from "./scene.js";
import * as layers from "./riscq-layers.js";

const graphite = surface(0x273439), silver = surface(0xb8c4c7, 0.54), gold = surface(0xd2ac60, 0.5),
  ceramic = surface(0xb4a284), teal = surface(0x58b8ac), slab = surface(0x24493f, 0.1, 0.8),
  channelBase = surface(0x26785e), demodBase = surface(0x6c5a94, 0.2), dioBase = surface(0x4f6a82, 0.2),
  memory = surface(0x3f9a72), adcBody = surface(0x6aa0c8, 0.3), apparatus = surface(0xb096ca, 0.44),
  wire = surface(0x55747a, 0.2), sapphire = surface(0x9fb4c8, 0.15, 0.3), niobium = surface(0xc9d2d6, 0.7, 0.35),
  trapGold = surface(0xc9a456, 0.6, 0.35), trapDie = surface(0x3b4a4f, 0.2, 0.6), glass = surface(0x24343b, 0.1, 0.4),
  coax = surface(0x8a9aa0, 0.5, 0.4);
function glow(color, emissive) {
  const material = new T.MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.45 });
  material.emissive.setHex(emissive);
  return material;
}
// These colours match the legend in riscq-studio.css.
const actingMat = glow(0x92f4c9, 0x1d6b52), targetMat = glow(0xffd46c, 0x7a5310), pathMat = glow(0x8fe6ff, 0x1c5f78),
  openMat = glow(0xf2a36b, 0x6b3410), faultMat = glow(0xf1583a, 0x7a1d0c), chosenMat = glow(0xf1ffed, 0x666666),
  ionMat = glow(0x7fe7ff, 0x1d7a93), movingMat = glow(0xffb45c, 0x8a4a0c), atomMat = glow(0xc7a7ff, 0x4b2d86),
  toneOn = glow(0xff8a65, 0x8a2c10), toneOff = surface(0x6b7f86, 0.2, 0.6), hoverMat = glow(0xe8fff7, 0x2c5a4c);
const round = new T.CylinderGeometry(1, 1, 1, 16), hexagon = new T.CylinderGeometry(1, 1, 1, 6),
  ball = new T.SphereGeometry(1, 18, 12), cone = new T.ConeGeometry(1, 1, 14);

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

// One recognizable shape per controller part kind, in floorplan units. Each returns its height.
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
const tier = (kind) => (["dac", "adc", "pins"].includes(kind) ? 4 : kind === "device" ? 8 : 0);

// Apparatus shapes of the chip view, in chip units (one transmon or site pitch ≈ 10).
const chipShapes = {
  qubit(g) {
    // A transmon cross with a small junction pad.
    box(g, 0, 0.3, 0, 7, 0.6, 1.6, niobium);
    box(g, 0, 0.3, 0, 1.6, 0.6, 7, niobium);
    box(g, 0, 0.8, 0, 1.4, 0.5, 1.4, gold);
    return 1.2;
  },
  resonator(g) {
    // A meander of four lines.
    for (let k = 0; k < 4; k++) box(g, -2.4 + k * 1.6, 0.25, 0, 0.5, 0.5, 4.5, niobium);
    box(g, 0, 0.25, 2.3, 5.3, 0.5, 0.5, niobium);
    return 0.8;
  },
  site(g) {
    box(g, 0, 0.25, 0, 5.2, 0.5, 3.2, trapGold);
    box(g, 0, 0.6, 0, 3.4, 0.3, 1.2, glass);
    return 1;
  },
  electrodes(g) {
    for (const x of [-2.2, 0, 2.2]) box(g, x, 0.2, 0, 1.8, 0.4, 1.4, trapGold);
    return 0.6;
  },
  bank(g) {
    box(g, 0, 0.3, 0, 2.2, 0.6, 3.5, trapGold);
    return 0.8;
  },
  light(g) {
    solid(g, round, 0, 2, 0, 1.6, 4, 1.6, glass);
    solid(g, cone, 0, 4.6, 0, 1.6, 1.4, 1.6, gold);
    return 5.5;
  },
  tone(g) {
    // A tone has no body. The line across the array is drawn by `show`; this is its transducer.
    box(g, 0, 0.6, 0, 3, 1.2, 3, coax);
    return 1.4;
  },
};
function chipShapeOf(id) {
  if (/^qubit\d+$/.test(id)) return "qubit";
  if (/^resonator\d+$/.test(id)) return "resonator";
  if (/^site:/.test(id)) return "site";
  if (/^electrodes:zone\./.test(id)) return "electrodes";
  if (/^electrodes:/.test(id)) return "bank";
  if (/^(light|beam):/.test(id)) return "light";
  if (/^aod\d+:[xy]\d+$/.test(id)) return "tone";
  return null;
}

/**
 * Create the stage in `host`. `hooks.pick(id)` selects a part, `hooks.hover(id | null, x, y)`
 * reports the part under the pointer in client coordinates. IDs of moving bodies are
 * "ion:<name>" and "atom:<n>".
 */
export function createWorkspaceStage(host, hooks) {
  const { world, renderer, canvas } = createStage(host, "Orbitable 3D view of a RISC-Q run: apparatus, converters, channels and controller");
  const root = new T.Group(), overlay = new T.Group(), bodies = new T.Group();
  world.add(root, overlay, bodies);
  const camera = new T.OrthographicCamera(-200, 200, 120, -120, 0.1, 9000);
  const controls = new OrbitControls(camera, canvas);
  controls.minZoom = 0.3;
  controls.maxZoom = 60;
  controls.maxPolarAngle = Math.PI * 0.49;
  const ray = new T.Raycaster(), ndc = new T.Vector2(), vec = new T.Vector3();
  const labelLayer = host.querySelector(".labels");
  const parts = new Map(), lit = new Set(), bounds = new T.Box3(), target = new T.Vector3();
  const ring = new T.Mesh(new T.TorusGeometry(1, 0.07, 8, 40), chosenMat);
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  world.add(ring);
  let run = null, view = "chip", unit = 6, fitWidth = 200, fitHeight = 120, width = 1, height = 1;
  let tags = [], pinned = [], hovered = null, chip = null, ionMeshes = new Map(), atomMeshes = new Map(), toneMeshes = new Map();

  function render() {
    renderer.render(world, camera);
    labelLayer.replaceChildren();
    const placed = [];
    const all = [...tags];
    if (hovered && !all.some((t) => t[0] === hovered)) all.push([hovered, hovered, "hover"]);
    all.push(...pinned);
    for (const [id, text, kind] of all) {
      const anchor = parts.get(id)?.top ?? bodyTop(id);
      if (!anchor) continue;
      vec.copy(anchor).project(camera);
      const x = ((vec.x + 1) * width) / 2, y = ((1 - vec.y) * height) / 2;
      if (x < 16 || x > width - 16 || y < 16 || y > height - 16) continue;
      const span = kind === "pin" ? 26 : 84;
      if (placed.some((p) => Math.abs(x - p[0]) < span && Math.abs(y - p[1]) < (kind === "pin" ? 12 : 20))) continue;
      const tag = document.createElement("span");
      tag.className = "annotation " + kind;
      tag.textContent = text;
      tag.style.left = x + "px";
      tag.style.top = y + "px";
      labelLayer.append(tag);
      placed.push([x, y]);
    }
  }
  function bodyTop(id) {
    const mesh = ionMeshes.get(id) ?? atomMeshes.get(id);
    return mesh ? mesh.position.clone().add(new T.Vector3(0, 4, 0)) : null;
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
  function home() {
    camera.zoom = 1;
    controls.target.copy(target);
    const direction = view === "chip" ? new T.Vector3(0.05, 1, 0.62) : new T.Vector3(0.14, 0.86, 0.95);
    camera.position.copy(target).add(direction.normalize().multiplyScalar(3000));
    controls.update();
    camera.updateMatrixWorld();
    let widest = 30, tallest = 20;
    if (!bounds.isEmpty())
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) {
            vec.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
            widest = Math.max(widest, Math.abs(vec.x - target.clone().applyMatrix4(camera.matrixWorldInverse).x));
            tallest = Math.max(tallest, Math.abs(vec.y - target.clone().applyMatrix4(camera.matrixWorldInverse).y));
          }
    fitWidth = widest * 1.08;
    fitHeight = tallest * 1.12;
    resize();
  }

  function addPart(part, position, scale, shape) {
    const group = new T.Group();
    group.position.copy(position);
    group.scale.setScalar(scale);
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
    bounds.expandByPoint(group.position).expandByPoint(top);
    return parts.get(part.id);
  }

  /** Floorplan layout of the parts in `ids` (control and machine views). */
  function buildFloorplan(ids) {
    const shown = run.system.parts.filter((p) => ids.has(p.id));
    const xs = shown.map((p) => p.position[0]), ys = shown.map((p) => p.position[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    unit = Math.min(6, 1000 / Math.max(maxX - minX, maxY - minY, 1));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const taken = new Map(), ground = new T.Box3();
    for (const part of shown) {
      const key = tier(part.kind) + "/" + part.position.join("/");
      const level = taken.get(key) ?? 0;
      taken.set(key, level + 1);
      const base = (tier(part.kind) + level * 2.4) * unit;
      const entry = addPart(part, new T.Vector3((part.position[0] - cx) * unit, base, (part.position[1] - cy) * unit), unit, shapes[part.kind] ?? shapes.device);
      if (base > 0) solid(root, round, entry.group.position.x, base / 2, entry.group.position.z, 0.1 * unit, base, 0.1 * unit, graphite);
      else ground.expandByPoint(entry.group.position);
    }
    if (!ground.isEmpty()) {
      const size = ground.getSize(new T.Vector3()), mid = ground.getCenter(new T.Vector3());
      const board = box(root, mid.x, -0.45 * unit, mid.z, size.x + 12 * unit, 0.6 * unit, size.z + 10 * unit, slab);
      board.receiveShadow = true;
      board.userData.ground = true;
    }
    for (const link of run.system.links ?? []) {
      const a = parts.get(link.from), b = parts.get(link.to);
      if (a && b) beam(root, a.anchor, b.anchor, 0.16 * unit, wire);
    }
  }

  /**
   * Chip layout: the apparatus inside a disc of radius 100, the converters on a ring at 150
   * and the channels on a ring at 200, each at the angle of the apparatus it drives.
   */
  function buildChip(ids) {
    chip = layers.chipLayout(run);
    const R = 100;
    // Points of the apparatus in layout coordinates, to fit them into the disc.
    const points = chip.focus?.length ? chip.focus : [...chip.devices.values(), ...(chip.sites?.values() ?? [])];
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const mid = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    // A single site or a row of atoms still gets a sensible size.
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), chip.platform === "neutral" ? 20 : chip.platform === "qccd" ? 2 : 1e-9);
    const scale = (1.7 * R) / span;
    chip.toWorld = (p) => new T.Vector3((p[0] - mid[0]) * scale, 0, (p[1] - mid[1]) * scale);
    chip.scale = scale;
    const onDie = (v) => Math.abs(v.x) <= 1.12 * R && Math.abs(v.z) <= 1.12 * R;
    const clampToDie = (v) => v.set(Math.max(-1.1 * R, Math.min(1.1 * R, v.x)), v.y, Math.max(-1.1 * R, Math.min(1.1 * R, v.z)));
    // Zones of an atom array, cut to the die.
    for (const zone of chip.zones ?? []) {
      const a = clampToDie(chip.toWorld(zone.origin)), b = clampToDie(chip.toWorld([zone.origin[0] + zone.size[0], zone.origin[1] + zone.size[1]]));
      if (Math.abs(b.x - a.x) < 1 || Math.abs(b.z - a.z) < 1) continue;
      const mesh = box(root, (a.x + b.x) / 2, 0.05, (a.z + b.z) / 2, Math.abs(b.x - a.x), 0.1, Math.abs(b.z - a.z), zone.kind === "entanglement" ? surface(0x4a3a6a, 0.1, 0.7) : surface(0x2f4750, 0.1, 0.7));
      mesh.userData.part = "zone:" + zone.id;
      mesh.userData.zone = zone;
    }
    // The die.
    const die = chip.platform === "superconducting" ? sapphire : chip.platform === "qccd" ? trapDie : glass;
    const plate = box(root, 0, -1, 0, 2.3 * R, 2, 2.3 * R, die);
    plate.receiveShadow = true;
    plate.userData.ground = true;
    // Size of one apparatus part: a transmon cross fills about a quarter of the qubit spacing.
    const pitch = chip.platform === "neutral" ? 2.2 : chip.platform === "superconducting" ? Math.max(1, Math.min(5, scale * 0.07))
      : Math.max(0.9, Math.min(2.6, (scale * 0.8) / 10));
    // Sites and segments of a trap, as far as they fall on the die.
    if (chip.sites)
      for (const [id, p] of chip.sites) {
        const at = chip.toWorld(p);
        if (!onDie(at)) continue;
        const pad = box(root, at.x, 0.1, at.z, 5 * pitch, 0.2, 5 * pitch, glass);
        pad.userData.part = "trapsite:" + id;
      }
    for (const [a, b] of chip.edges ?? []) {
      const pa = chip.sites.get(a), pb = chip.sites.get(b);
      if (!pa || !pb) continue;
      const wa = chip.toWorld(pa), wb = chip.toWorld(pb);
      if (onDie(wa) || onDie(wb)) beam(root, clampToDie(wa).add(new T.Vector3(0, 0.3, 0)), clampToDie(wb).add(new T.Vector3(0, 0.3, 0)), 1.2 * pitch, trapGold);
    }
    for (const [a, b, offered] of chip.couplers ?? []) {
      const pa = chip.devices.get(chip.qubitParts?.[a] ?? "qubit" + a), pb = chip.devices.get(chip.qubitParts?.[b] ?? "qubit" + b);
      if (pa && pb) {
        const wa = chip.toWorld(pa), wb = chip.toWorld(pb);
        const mesh = beam(root, wa.clone().lerp(wb, 0.22).setY(0.4), wa.clone().lerp(wb, 0.78).setY(0.4), 1.1 * pitch, offered === false ? graphite : niobium);
        mesh.userData.base = mesh.material;
        mesh.userData.part = "coupler:" + a + "-" + b + (offered === false ? ":not offered" : "");
        chip.couplerMeshes = (chip.couplerMeshes ?? new Map()).set([a, b].sort((x, y) => x - y).join("-"), { meshes: [mesh] });
      }
    }
    for (const part of run.system.parts) {
      if (!ids.has(part.id) || part.kind !== "device") continue;
      const p = chip.devices.get(part.id);
      const name = chip.types?.get(part.id) ?? chipShapeOf(part.id);
      if (!p && name === "tone") continue;
      addPart(part, clampToDie(chip.toWorld(p ?? [0, 0])), pitch, chipShapes[name] ?? shapes.device);
    }
    // Tones: one long bar across the array per tone, moved by `show`.
    if (chip.tones)
      for (const part of run.system.parts.filter((p) => /^aod\d+:[xy]\d+$/.test(p.id))) {
        const along = /:x/.test(part.id) ? "x" : "y";
        const mesh = box(bodies, 0, 1.2, 0, along === "x" ? 0.8 : 2.3 * R, 0.4, along === "x" ? 2.3 * R : 0.8, toneOff);
        mesh.userData.part = part.id;
        mesh.visible = false;
        toneMeshes.set(part.id, { mesh, axis: along });
        // The transducer sits at the edge of the die, where the tone enters.
        const edge = along === "x" ? new T.Vector3(0, 0, -1.2 * R) : new T.Vector3(-1.2 * R, 0, 0);
        addPart(part, edge, 2.2, chipShapes.tone);
      }
    // The ring of converters and channels.
    const driven = layers.drivenBy(run), converter = layers.converterOf(run);
    // A converter sits at the angle of the parts it drives. One that drives parts all around
    // the chip (a shared readout feedline) has no such angle and joins the free ones.
    const angleOf = (devicesList) => {
      const pts = [...new Set(devicesList ?? [])].map((d) => chip.devices.get(d)).filter(Boolean).map(chip.toWorld);
      if (!pts.length) return null;
      const c = pts.reduce((a, b) => a.add(b), new T.Vector3()).multiplyScalar(1 / pts.length);
      return pts.length > 2 && c.length() < 0.3 * R ? null : Math.atan2(c.z, c.x);
    };
    const channels = run.system.parts.filter((p) => ids.has(p.id) && ["pulse", "demod", "dio"].includes(p.kind));
    const byConverter = new Map();
    for (const ch of channels) {
      const conv = converter.get(ch.id) ?? ch.id;
      if (!byConverter.has(conv)) byConverter.set(conv, []);
      byConverter.get(conv).push(ch);
    }
    const groups = [...byConverter].map(([conv, list]) => {
      const devs = list.flatMap((ch) => driven.get(ch.id) ?? []);
      return { conv, list, devs, angle: angleOf(devs) };
    });
    // Converters with no apparatus fill the gaps in order.
    const free = groups.filter((g) => g.angle === null);
    free.forEach((g, k) => (g.angle = Math.PI / 2 + ((k + 0.5) / Math.max(1, free.length)) * 0.9 - 0.45));
    groups.sort((a, b) => a.angle - b.angle);
    // Spread converters that would overlap: at least 7 degrees apart.
    const minGap = Math.min((2 * Math.PI) / Math.max(groups.length, 1), (7 * Math.PI) / 180);
    for (let k = 1; k < groups.length; k++) if (groups[k].angle - groups[k - 1].angle < minGap) groups[k].angle = groups[k - 1].angle + minGap;
    const s = Math.min(6, (2 * Math.PI * 150) / Math.max(1, groups.length) / 6.5);
    for (const g of groups) {
      const dir = new T.Vector3(Math.cos(g.angle), 0, Math.sin(g.angle));
      const convPart = run.system.parts.find((p) => p.id === g.conv);
      let convEntry = null;
      if (convPart && ids.has(convPart.id)) {
        convEntry = addPart(convPart, dir.clone().multiplyScalar(150), s, shapes[convPart.kind] ?? shapes.dac);
        convEntry.group.rotation.y = -g.angle + Math.PI;
        // Coax to every apparatus part this converter drives.
        for (const d of new Set(g.devs)) {
          const at = parts.get(d)?.anchor ?? (chip.devices.get(d) && chip.toWorld(chip.devices.get(d)));
          if (at) beam(root, convEntry.anchor.clone().setY(1), at.clone().setY(1), new Set(g.devs).size > 2 ? 0.3 : 0.7, coax);
        }
      }
      g.list.forEach((ch, k) => {
        const spread = (k - (g.list.length - 1) / 2) * Math.min(0.06, minGap / Math.max(1, g.list.length));
        const d = new T.Vector3(Math.cos(g.angle + spread), 0, Math.sin(g.angle + spread));
        const entry = addPart(ch, d.multiplyScalar(200 + (k % 2) * 16), s, shapes[ch.kind]);
        entry.group.rotation.y = -g.angle + Math.PI / 2;
        if (convEntry) beam(root, entry.anchor, convEntry.anchor, 0.5, wire);
      });
    }
    // Converters that no shown channel names (e.g. pins of a digital channel) are already placed with it.
    for (const part of run.system.parts)
      if (ids.has(part.id) && !parts.has(part.id) && ["dac", "adc", "pins"].includes(part.kind)) addPart(part, new T.Vector3(0, 0, 240), s, shapes[part.kind]);
    const plate2 = box(root, 0, -2.4, 0, 2 * 235, 1, 2 * 235, slab);
    plate2.userData.ground = true;
    bounds.expandByPoint(new T.Vector3(-235, 0, -235)).expandByPoint(new T.Vector3(235, 0, 235));
  }

  function rebuild() {
    root.clear();
    overlay.clear();
    bodies.clear();
    parts.clear();
    lit.clear();
    ionMeshes = new Map();
    atomMeshes = new Map();
    toneMeshes = new Map();
    tags = [];
    pinned = [];
    hovered = null;
    chip = null;
    ring.visible = false;
    bounds.makeEmpty();
    if (!run?.system?.parts?.length) return home();
    const ids = layers.viewParts(run, view);
    const hasApparatus = run.system.parts.some((p) => p.kind === "device");
    if (view === "chip" && hasApparatus) buildChip(ids);
    else buildFloorplan(ids);
    bounds.getCenter(target);
    target.y = 0;
    home();
  }

  function paint(id, material) {
    const part = parts.get(id);
    if (!part) return;
    for (const mesh of part.meshes) mesh.material = material;
    lit.add(id);
  }

  /**
   * Show one step. `extra` carries what the page derived for the apparatus:
   * { active: Map(device → [{ window, binding }]), ions, atoms, tones: Map(part → µm) }.
   */
  function show(frame, state, path, chosen, fault, extra = {}) {
    for (const id of lit) for (const mesh of parts.get(id)?.meshes ?? chip?.couplerMeshes?.get(id)?.meshes ?? []) mesh.material = mesh.userData.base;
    lit.clear();
    overlay.clear();
    tags = [];
    pinned = [];
    for (const window of state?.openWindows ?? []) {
      paint(window.part, openMat);
      paint(window.converter, openMat);
    }
    for (const [device, list] of extra.active ?? []) {
      paint(device, openMat);
      for (const { binding } of list)
        if (binding.detail?.pair && chip?.couplerMeshes) {
          const key = binding.detail.pair.slice().sort((a, b) => a - b).join("-"), entry = chip.couplerMeshes.get(key);
          if (entry) {
            for (const mesh of entry.meshes) mesh.material = openMat;
            lit.add(key);
            chip.couplerMeshes.set(key, entry);
          }
        }
    }
    // Parts of the instruction or line under the pointer in the program column.
    for (const id of extra.hint ?? []) paint(id, hoverMat);
    const raise = new T.Vector3(0, (view === "chip" ? 2 : 0.55 * unit), 0);
    for (const hop of path) {
      const from = parts.get(hop.from), to = parts.get(hop.to);
      if (!from || !to) continue;
      const own = hop.frame === frame?.id;
      if (!own) {
        paint(hop.from, pathMat);
        paint(hop.to, pathMat);
      }
      const a = from.anchor.clone().add(raise), b = to.anchor.clone().add(raise), material = own ? targetMat : pathMat;
      const w = view === "chip" ? 1.6 : 0.42 * unit;
      if (hop.link) beam(overlay, a, b, w, material);
      else {
        const dashes = Math.max(3, Math.round(a.distanceTo(b) / (4 * w)));
        for (let k = 0; k < dashes; k++) beam(overlay, a.clone().lerp(b, k / dashes), a.clone().lerp(b, (k + 0.55) / dashes), w, material);
      }
      const head = solid(overlay, cone, 0, 0, 0, 1.8 * w, 4 * w, 1.8 * w, material);
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
    if (chip) updateBodies(extra);
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

  function updateBodies(extra) {
    const radius = chip.platform === "neutral" ? 3.2 : Math.max(2.2, Math.min(5, chip.scale * 0.11));
    if (extra.ions) {
      const seen = new Set();
      extra.ions.forEach((ion) => {
        if (!ion.at) return;
        const id = "ion:" + ion.ion;
        seen.add(id);
        let mesh = ionMeshes.get(id);
        if (!mesh) {
          mesh = solid(bodies, ball, 0, 0, 0, radius, radius, radius, ionMat);
          mesh.userData.part = id;
          ionMeshes.set(id, mesh);
        }
        // Ions of one site sit side by side along the trap axis.
        const sameSite = extra.ions.filter((o) => !o.moving && o.site === ion.site && o.at);
        const k = ion.moving ? 0 : sameSite.indexOf(ion) - (sameSite.length - 1) / 2;
        mesh.position.copy(chip.toWorld(ion.at)).add(new T.Vector3(k * radius * 2.4, 3.5 + radius, 0));
        mesh.material = ion.moving ? movingMat : ionMat;
        mesh.visible = true;
        pinned.push([id, ion.ion, "pin"]);
      });
      for (const [id, mesh] of ionMeshes) if (!seen.has(id)) mesh.visible = false;
    }
    if (extra.atoms) {
      const seen = new Set();
      for (const atom of extra.atoms) {
        const id = "atom:" + atom.atom;
        seen.add(id);
        let mesh = atomMeshes.get(id);
        if (!mesh) {
          mesh = solid(bodies, ball, 0, 0, 0, radius, radius, radius, atomMat);
          mesh.userData.part = id;
          atomMeshes.set(id, mesh);
        }
        mesh.position.copy(chip.toWorld(atom.at)).setY(radius + (atom.carried ? 4 : 1));
        mesh.material = atom.carried ? movingMat : atomMat;
        mesh.visible = true;
        pinned.push([id, String(atom.atom), "pin"]);
      }
      for (const [id, mesh] of atomMeshes) if (!seen.has(id)) mesh.visible = false;
    }
    if (extra.tones) {
      const open = new Set(extra.openParts ?? []);
      for (const [part, { mesh, axis }] of toneMeshes) {
        const um = extra.tones.get(part.replace(":", "."));
        mesh.visible = um !== undefined;
        if (um === undefined) continue;
        const at = chip.toWorld(axis === "x" ? [um, 0] : [0, um]);
        if (axis === "x") mesh.position.x = at.x;
        else mesh.position.z = at.z;
        mesh.material = open.has(part.replace(":", ".")) ? toneOn : toneOff;
      }
    }
    if (chip.platform === "superconducting" || chip.platform === "qccd")
      for (const [id] of chip.devices) if (/^(qubit\d+|site:.+)$/.test(id)) pinned.push([id, id.replace(/^qubit/, "Q").replace(/^site:/, ""), "pin"]);
  }

  function partAt(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set((2 * (e.clientX - r.left)) / r.width - 1, 1 - (2 * (e.clientY - r.top)) / r.height);
    ray.setFromCamera(ndc, camera);
    for (const hit of ray.intersectObjects([...bodies.children, ...root.children], true)) {
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
    /** Load a run and draw it in `nextView` (the current view when omitted). */
    setRun(bundle, nextView = view) {
      run = bundle;
      view = nextView;
      rebuild();
    },
    setView(next) {
      view = next;
      rebuild();
    },
    get view() {
      return view;
    },
    /** Parts this view draws. */
    shows: (id) => parts.has(id) || ionMeshes.has(id) || atomMeshes.has(id),
    chip: () => chip,
    show,
    home,
  };
}
