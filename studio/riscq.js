// 3D debugger for a RISC-Q controller run. Everything shown is read from the run bundle of
// `/api/riscq/run` through the pure functions of riscq-model.js. No timing or physics is
// computed here.
import * as T from "three";
import { OrbitControls } from "/three/OrbitControls.js";
import { createStage, box, surface } from "./scene.js";
import * as model from "./riscq-model.js";

const $ = (id) => document.getElementById(id);
const integer = new Intl.NumberFormat("en-US");
const count = (n) => integer.format(n);
const hex = (v, digits = 8) => "0x" + (v >>> 0).toString(16).padStart(digits, "0");
const lines16 = (v) => (v >>> 0).toString(2).padStart(16, "0");

/** Build an element. Text always goes through `textContent`, never markup. */
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
const button = (label, action, title) => el("button", { type: "button", text: label, onclick: action, title });
/** Replace the children of a node. Nested lists are flattened and absent entries skipped. */
function put(target, ...children) {
  target.replaceChildren(...children.flat(2).filter((c) => c !== null && c !== undefined && c !== false));
  return target;
}
function fields(target, rows) {
  target.replaceChildren(...rows.filter(Boolean).flatMap(([name, value]) => [el("dt", { text: name }), el("dd", {}, value)]));
  return target;
}
/** First entry of a sorted list above `i`, and last entry below it, or −1. */
const after = (list, i) => list[model.countUpTo(list, i)] ?? -1;
const before = (list, i) => list[model.countUpTo(list, i - 1) - 1] ?? -1;

// ───────────────────────────── 3D scene ─────────────────────────────

const graphite = surface(0x273439), silver = surface(0xb8c4c7, 0.54), gold = surface(0xd2ac60, 0.5),
  ceramic = surface(0xb4a284), teal = surface(0x58b8ac), slab = surface(0x24493f, 0.1, 0.8),
  channelBase = surface(0x26785e), demodBase = surface(0x6c5a94, 0.2), dioBase = surface(0x4f6a82, 0.2),
  memory = surface(0x3f9a72), adcBody = surface(0x6aa0c8, 0.3), apparatus = surface(0xb096ca, 0.44),
  wire = surface(0x55747a, 0.2);
function glow(color, emissive) {
  const material = new T.MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.45 });
  material.emissive.setHex(emissive);
  return material;
}
// These colours match the legend in riscq.css.
const actingMat = glow(0x92f4c9, 0x1d6b52), targetMat = glow(0xffd46c, 0x7a5310), pathMat = glow(0x8fe6ff, 0x1c5f78),
  openMat = glow(0xf2a36b, 0x6b3410), faultMat = glow(0xf1583a, 0x7a1d0c), chosenMat = glow(0xf1ffed, 0x666666);
const round = new T.CylinderGeometry(1, 1, 1, 16), hexagon = new T.CylinderGeometry(1, 1, 1, 6),
  ball = new T.SphereGeometry(1, 14, 10), cone = new T.ConeGeometry(1, 1, 14);
function solid(parent, geometry, x, y, z, sx, sy, sz, material) {
  const mesh = new T.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  parent.add(mesh);
  return mesh;
}
/** A cylinder whose axis lies along x. */
function barrel(parent, x, y, z, radius, length, material) {
  const mesh = solid(parent, round, x, y, z, radius, length, radius, material);
  mesh.rotation.z = Math.PI / 2;
  return mesh;
}
/** A bar from point a to point b. */
function beam(parent, a, b, width, material) {
  const length = a.distanceTo(b);
  if (!length) return null;
  const mid = a.clone().lerp(b, 0.5);
  const mesh = box(parent, mid.x, mid.y, mid.z, width, width, length, material);
  mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), b.clone().sub(a).normalize());
  return mesh;
}

// One recognizable shape per part kind, in floorplan units. Each returns its height.
const shapes = {
  // Host: a board with a processor and four memory modules.
  host(g) {
    box(g, 0, 0.9, 0, 6.5, 1.8, 7.5, graphite);
    box(g, -1.3, 2.0, 0, 2.6, 0.4, 2.6, silver);
    for (let k = 0; k < 4; k++) box(g, 1.1 + k * 0.6, 2.4, 0, 0.3, 1.2, 5, memory);
    return 3;
  },
  // Hub: a hexagonal switch.
  hub(g) {
    solid(g, hexagon, 0, 0.7, 0, 2.6, 1.4, 2.6, gold);
    solid(g, round, 0, 1.7, 0, 1.3, 0.6, 1.3, graphite);
    return 2;
  },
  // Core: a square processor package with a lid.
  core(g) {
    box(g, 0, 0.4, 0, 4, 0.8, 4, graphite);
    box(g, 0, 1.0, 0, 2.8, 0.4, 2.8, silver);
    for (const side of [-2.1, 2.1]) {
      box(g, 0, 0.15, side, 3.6, 0.3, 0.25, gold);
      box(g, side, 0.15, 0, 0.25, 0.3, 3.6, gold);
    }
    return 1.2;
  },
  // Link: a pipe with register flanges.
  link(g) {
    barrel(g, 0, 0.8, 0, 0.5, 3, teal);
    for (const x of [-1, 0, 1]) barrel(g, x, 0.8, 0, 0.85, 0.28, silver);
    return 1.7;
  },
  // Inbox: an open tray.
  inbox(g) {
    box(g, 0, 0.15, 0, 2, 0.3, 1.8, ceramic);
    box(g, 0, 0.6, -0.8, 2, 0.9, 0.2, ceramic);
    for (const side of [-0.9, 0.9]) box(g, side, 0.6, 0, 0.2, 0.9, 1.8, ceramic);
    return 1.1;
  },
  // Pulse channel: a module with an envelope-shaped row of bars.
  pulse(g) {
    box(g, 0, 0.5, 0, 5, 1, 3.6, channelBase);
    for (const [x, h] of [[-1.5, 0.7], [0, 1.5], [1.5, 0.7]]) box(g, x, 1 + h / 2, 0, 1, h, 2.2, gold);
    return 2.5;
  },
  // Demodulation channel: a module with a funnel.
  demod(g) {
    box(g, 0, 0.5, 0, 5, 1, 3.6, demodBase);
    solid(g, cone, 0, 1.9, 0, 1.3, 1.8, 1.3, silver).rotation.x = Math.PI;
    return 2.8;
  },
  // Digital channel: a module with high and low pegs.
  dio(g) {
    box(g, 0, 0.5, 0, 5, 1, 3.6, dioBase);
    [1.2, 0.4, 1.2, 0.4].forEach((h, k) => box(g, -1.5 + k, 1 + h / 2, 0, 0.6, h, 1.6, gold));
    return 2.2;
  },
  // DAC: a gold coaxial output.
  dac(g) {
    box(g, 0, 0.6, 0, 2, 1.2, 1.3, gold);
    barrel(g, 1.7, 0.6, 0, 0.4, 1.4, gold);
    barrel(g, 2.5, 0.6, 0, 0.16, 0.3, silver);
    return 1.2;
  },
  // ADC: a blue coaxial input with a flange.
  adc(g) {
    box(g, 0, 0.6, 0, 2, 1.2, 1.3, adcBody);
    barrel(g, 1.7, 0.6, 0, 0.4, 1.4, teal);
    barrel(g, 1.1, 0.6, 0, 0.7, 0.2, silver);
    return 1.2;
  },
  // Pins: a header strip.
  pins(g) {
    box(g, 0, 0.25, 0, 2.2, 0.5, 1.3, graphite);
    for (let k = 0; k < 4; k++) solid(g, round, -0.75 + k * 0.5, 1, 0, 0.12, 1, 0.12, gold);
    return 1.5;
  },
  // Apparatus part: a sphere on a post.
  device(g) {
    solid(g, round, 0, 0.4, 0, 0.5, 0.8, 0.5, graphite);
    solid(g, ball, 0, 1.7, 0, 1, 1, 1, apparatus);
    return 2.7;
  },
};
/** Display height of a part kind in floorplan units. It separates kinds whose floorplan positions overlap. */
const tier = (kind) => (["dac", "adc", "pins"].includes(kind) ? 4 : kind === "device" ? 8 : 0);

function createControllerScene(host, onPick) {
  const { world, renderer, canvas } = createStage(
    host,
    "Orbitable schematic of the RISC-Q controller: host, hub, cores, links, channels, converters and apparatus parts",
  );
  const root = new T.Group(), overlay = new T.Group();
  world.add(root, overlay);
  const camera = new T.OrthographicCamera(-200, 200, 120, -120, 0.1, 9000);
  const controls = new OrbitControls(camera, canvas);
  controls.minZoom = 0.3;
  controls.maxZoom = 40;
  controls.maxPolarAngle = Math.PI * 0.49;
  const ray = new T.Raycaster(), ndc = new T.Vector2(), vec = new T.Vector3();
  const labelLayer = host.querySelector("#labels");
  const parts = new Map(), lit = new Set(), bounds = new T.Box3(), target = new T.Vector3();
  const ring = new T.Mesh(new T.TorusGeometry(1, 0.07, 8, 40), chosenMat);
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  world.add(ring);
  let unit = 6, fitWidth = 200, fitHeight = 120, tags = [], hovered = null, width = 1, height = 1;

  function render() {
    renderer.render(world, camera);
    labelLayer.replaceChildren();
    const placed = [];
    const all = hovered && !tags.some((tag) => tag[0] === hovered) ? [...tags, [hovered, parts.get(hovered)?.part.label ?? hovered, ""]] : tags;
    for (const [id, text, kind] of all) {
      const part = parts.get(id);
      if (!part) continue;
      vec.copy(part.top).project(camera);
      const x = ((vec.x + 1) * width) / 2, y = ((1 - vec.y) * height) / 2;
      if (x < 24 || x > width - 24 || y < 84 || y > height - 34) continue;
      if (placed.some((p) => Math.abs(x - p[0]) < 84 && Math.abs(y - p[1]) < 22)) continue;
      labelLayer.append(el("span", { class: "annotation " + kind, text, style: "left:" + x + "px;top:" + y + "px" }));
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
  function home() {
    camera.zoom = 1;
    controls.target.copy(target);
    camera.position.copy(target).add(new T.Vector3(0.14, 0.86, 0.95).normalize().multiplyScalar(3000));
    controls.update();
    camera.updateMatrixWorld();
    let widest = 30, tallest = 20;
    if (!bounds.isEmpty())
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) {
            vec.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
            widest = Math.max(widest, Math.abs(vec.x));
            tallest = Math.max(tallest, Math.abs(vec.y));
          }
    fitWidth = widest * 1.07;
    fitHeight = tallest * 1.16;
    resize();
  }
  /** Build the scene from `system.parts` and `system.links`. */
  function setSystem(system) {
    root.clear();
    overlay.clear();
    parts.clear();
    lit.clear();
    hovered = null;
    tags = [];
    ring.visible = false;
    bounds.makeEmpty();
    if (!system?.parts?.length) return home();
    const xs = system.parts.map((p) => p.position[0]), ys = system.parts.map((p) => p.position[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    unit = Math.min(6, 1000 / Math.max(maxX - minX, maxY - minY, 1));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const taken = new Map(), ground = new T.Box3();
    for (const part of system.parts) {
      // Parts of one tier that share a floorplan position are stacked.
      const key = tier(part.kind) + "/" + part.position.join("/");
      const level = taken.get(key) ?? 0;
      taken.set(key, level + 1);
      const base = (tier(part.kind) + level * 2.4) * unit;
      const group = new T.Group();
      group.position.set((part.position[0] - cx) * unit, base, (part.position[1] - cy) * unit);
      group.scale.setScalar(unit);
      group.userData.part = part.id;
      const height = (shapes[part.kind] ?? shapes.device)(group);
      const meshes = [];
      group.traverse((mesh) => {
        if (!mesh.isMesh) return;
        mesh.userData.base = mesh.material;
        mesh.castShadow = mesh.receiveShadow = true;
        meshes.push(mesh);
      });
      root.add(group);
      if (base > 0) solid(root, round, group.position.x, base / 2, group.position.z, 0.1 * unit, base, 0.1 * unit, graphite);
      else ground.expandByPoint(group.position);
      const top = group.position.clone();
      top.y += (height + 0.9) * unit;
      const anchor = group.position.clone();
      anchor.y += 0.25 * unit;
      parts.set(part.id, { part, group, meshes, top, anchor });
      bounds.expandByPoint(group.position).expandByPoint(top);
    }
    if (!ground.isEmpty()) {
      const size = ground.getSize(new T.Vector3()), mid = ground.getCenter(new T.Vector3());
      const board = box(root, mid.x, -0.45 * unit, mid.z, size.x + 12 * unit, 0.6 * unit, size.z + 10 * unit, slab);
      board.receiveShadow = true;
      // The stage's fallback renderer sorts whole triangles by depth and leaves out ground meshes.
      // This large board would otherwise cover the parts that stand on it.
      board.userData.ground = true;
    }
    for (const link of system.links ?? []) {
      const a = parts.get(link.from), b = parts.get(link.to);
      if (a && b) beam(root, a.anchor, b.anchor, 0.16 * unit, wire);
    }
    bounds.getCenter(target);
    home();
  }
  function paint(id, material) {
    const part = parts.get(id);
    if (!part) return;
    for (const mesh of part.meshes) mesh.material = material;
    lit.add(id);
  }
  /** Highlight one step: open windows, the causal path, the targets and the acting part. */
  function show(frame, state, path, chosen, fault) {
    for (const id of lit) for (const mesh of parts.get(id)?.meshes ?? []) mesh.material = mesh.userData.base;
    lit.clear();
    overlay.clear();
    tags = [];
    for (const window of state?.openWindows ?? []) {
      paint(window.part, openMat);
      paint(window.converter, openMat);
    }
    const raise = new T.Vector3(0, 0.55 * unit, 0);
    for (const hop of path) {
      const from = parts.get(hop.from), to = parts.get(hop.to);
      if (!from || !to) continue;
      const own = hop.frame === frame?.id;
      if (!own) {
        paint(hop.from, pathMat);
        paint(hop.to, pathMat);
      }
      const a = from.anchor.clone().add(raise), b = to.anchor.clone().add(raise), material = own ? targetMat : pathMat;
      if (hop.link) beam(overlay, a, b, 0.42 * unit, material);
      else {
        // The bundle lists no link for this hop, so it is drawn dashed.
        const dashes = Math.max(3, Math.round(a.distanceTo(b) / (1.6 * unit)));
        for (let k = 0; k < dashes; k++)
          beam(overlay, a.clone().lerp(b, k / dashes), a.clone().lerp(b, (k + 0.55) / dashes), 0.42 * unit, material);
      }
      const head = solid(overlay, cone, 0, 0, 0, 0.75 * unit, 1.7 * unit, 0.75 * unit, material);
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
    const picked = parts.get(chosen);
    ring.visible = Boolean(picked);
    if (picked) {
      ring.position.copy(picked.group.position);
      ring.position.y += 0.2 * unit;
      ring.scale.setScalar(3.4 * unit);
      if (!tags.some((tag) => tag[0] === chosen)) tags.push([chosen, chosen, "chosen"]);
    }
    render();
  }
  function partAt(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set((2 * (e.clientX - r.left)) / r.width - 1, 1 - (2 * (e.clientY - r.top)) / r.height);
    ray.setFromCamera(ndc, camera);
    for (const hit of ray.intersectObjects(root.children, true))
      for (let node = hit.object; node; node = node.parent) if (node.userData.part) return node.userData.part;
    return null;
  }
  let down = null, pending = null;
  canvas.addEventListener("pointerdown", (e) => {
    down = [e.clientX, e.clientY];
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const id = partAt(e);
    if (id) onPick(id);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.buttons || pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      const id = partAt(e);
      canvas.style.cursor = id ? "pointer" : "grab";
      if (id === hovered) return;
      hovered = id;
      render();
    });
  });
  canvas.addEventListener("pointerleave", () => {
    if (!hovered) return;
    hovered = null;
    render();
  });
  controls.addEventListener("change", render);
  new ResizeObserver(resize).observe(host);
  home();
  return { setSystem, show, home };
}

// ───────────────────────────── virtual list ─────────────────────────────

/** A scrolling list that keeps only the visible rows in the document. */
function createVirtualList(host, columns, className, fill, onPick, emptyText) {
  const rowHeight = 26;
  const spacer = el("div", { class: "spacer" });
  const empty = el("div", { class: "vrow inert", text: emptyText, style: "top:0" });
  const pool = [];
  let total = 0, scroll = 0, viewHeight = host.clientHeight;
  function render() {
    spacer.style.height = Math.max(total, 1) * rowHeight + "px";
    if (!total) return host.replaceChildren(spacer, empty);
    const first = Math.max(0, Math.floor(scroll / rowHeight) - 3);
    const last = Math.min(total, first + Math.ceil(viewHeight / rowHeight) + 7);
    const rows = [];
    for (let i = first; i < last; i++) {
      const row = (pool[i - first] ??= el("div", {}, Array.from({ length: columns }, () => el("span"))));
      row.className = "vrow " + className;
      row.style.top = i * rowHeight + "px";
      row.dataset.row = i;
      row.removeAttribute("aria-current");
      row.removeAttribute("title");
      fill(row, i);
      rows.push(row);
    }
    host.replaceChildren(spacer, ...rows);
  }
  host.addEventListener("scroll", () => {
    // A scroll that `reveal` made has been drawn already.
    if (Math.abs(host.scrollTop - scroll) < 1) return;
    scroll = host.scrollTop;
    render();
  }, { passive: true });
  host.addEventListener("click", (e) => {
    const row = e.target.closest(".vrow");
    if (row?.dataset.row !== undefined) onPick(Number(row.dataset.row));
  });
  new ResizeObserver(() => {
    viewHeight = host.clientHeight;
    render();
  }).observe(host);
  return {
    render,
    setCount(n) {
      total = n;
      host.scrollTop = scroll = 0;
      render();
    },
    /** Scroll only when the row is outside the visible part. */
    reveal(i) {
      if (i < 0) return;
      const top = i * rowHeight;
      if (top >= scroll && top + rowHeight <= scroll + viewHeight) return;
      scroll = Math.max(0, Math.min(top - viewHeight / 2 + rowHeight, total * rowHeight - viewHeight));
      host.scrollTop = scroll;
    },
  };
}

// ───────────────────────────── timeline ─────────────────────────────

const colours = { pulse: "#2a7287", demod: "#8058a1", dio: "#8a6027", late: "#c2452d", tone: "#5f7f7a" };

/** One lane per channel with activity. Time runs in batches. Labels convert through the batch period. */
function createTimeline(axis, canvas, scroller, hooks) {
  const pad = 14, laneHeight = 20, axisHeight = 24;
  const actx = axis.getContext("2d"), ctx = canvas.getContext("2d");
  let run = null, lanes = [], faults = [], total = 1, view = [0, 1], cursor = 0, acting = null, chosen = null, drag = null;
  let gutter = 172, width = 1, axisWidth = 1, viewHeight = 1, scroll = 0, laidOut = -1, ranged = "";

  function measure() {
    width = Math.max(1, canvas.clientWidth);
    axisWidth = Math.max(1, axis.clientWidth);
    viewHeight = scroller.clientHeight;
    scroll = scroller.scrollTop;
    // The lane names take at most a third of a narrow timeline.
    gutter = Math.min(172, Math.round(width * 0.32));
  }
  /** Size the drawing buffer for the display, only when it changed. */
  function fit(target, context, w, height) {
    const dpr = Math.min(devicePixelRatio, 2), bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(height * dpr));
    if (target.width !== bw || target.height !== bh) {
      target.width = bw;
      target.height = bh;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return w;
  }
  const plotWidth = () => Math.max(10, width - gutter - pad);
  const toX = (t) => gutter + ((t - view[0]) / (view[1] - view[0])) * plotWidth();
  const toBatch = (x) => view[0] + ((x - gutter) / plotWidth()) * (view[1] - view[0]);
  function clip(context, text, width) {
    if (context.measureText(text).width <= width) return text;
    let cut = text.length;
    while (cut > 1 && context.measureText("…" + text.slice(-cut)).width > width) cut--;
    return "…" + text.slice(-cut);
  }
  function marker(context, x, y) {
    context.fillStyle = colours.late;
    context.beginPath();
    context.moveTo(x - 4, y);
    context.lineTo(x + 4, y);
    context.lineTo(x, y + 7);
    context.fill();
  }
  function draw() {
    if (!run) return;
    const height = Math.max(40, lanes.length * laneHeight);
    if (laidOut !== height) {
      laidOut = height;
      canvas.style.height = height + "px";
      measure();
    }
    const w = fit(canvas, ctx, width, height), plot = plotWidth(), [t0, t1] = view;
    ctx.clearRect(0, 0, w, height);
    ctx.font = '11px "Cascadia Code", Consolas, monospace';
    ctx.textBaseline = "middle";
    if (!lanes.length) {
      ctx.fillStyle = "#526568";
      ctx.fillText("The run summary holds no pulse window, digital update or carrier update.", 6, 20);
    }
    // Only the lanes inside the scrolled region are drawn.
    const first = Math.max(0, Math.floor(scroll / laneHeight) - 1);
    const last = Math.min(lanes.length, first + Math.ceil(viewHeight / laneHeight) + 3);
    for (let row = first; row < last; row++) {
      const lane = lanes[row], top = row * laneHeight;
      if (lane.part === acting || row % 2) {
        ctx.fillStyle = lane.part === acting ? "#dcefe6" : "#f8faf7";
        ctx.fillRect(0, top, w, laneHeight);
      }
      ctx.fillStyle = lane.part === chosen ? "#00695d" : "#344b46";
      ctx.font = (lane.part === chosen ? "bold " : "") + '11px "Cascadia Code", Consolas, monospace';
      ctx.fillText(clip(ctx, lane.part, gutter - 10), 4, top + laneHeight / 2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(gutter, top, plot + 1, laneHeight);
      ctx.clip();
      ctx.fillStyle = colours.tone;
      let column = -1;
      for (const tone of lane.tones) {
        if (tone.opens < t0 || tone.opens > t1) continue;
        const px = Math.round(toX(tone.opens));
        if (px === column) continue;
        column = px;
        ctx.fillRect(px, top + laneHeight - 6, 1, 5);
      }
      // Late windows are drawn last so that an on-time neighbour cannot hide them.
      for (const late of [false, true]) {
        let edge = -Infinity;
        for (const window of lane.windows) {
          if (window.late !== late || window.closes < t0 || window.opens > t1) continue;
          const a = toX(window.opens), b = Math.max(a + 1.5, toX(window.closes));
          if (b <= edge) continue;
          ctx.fillStyle = late ? colours.late : colours[window.kind] ?? colours.pulse;
          ctx.fillRect(Math.max(a, edge), top + 3, b - Math.max(a, edge), laneHeight - 10);
          if (b - a > 5) {
            ctx.fillStyle = "#ffffffb0";
            ctx.fillRect(a, top + 3, 1, laneHeight - 10);
          }
          edge = b;
        }
      }
      column = -1;
      for (const update of lane.updates) {
        if (update.opens < t0 || update.opens > t1) continue;
        const px = Math.round(toX(update.opens));
        if (px === column) continue;
        column = px;
        ctx.fillStyle = update.late ? colours.late : colours.dio;
        ctx.fillRect(px - 1, top + 2, 3, laneHeight - 6);
      }
      for (const { fault } of faults) if (fault.part === lane.part && fault.atBatch >= t0 && fault.atBatch <= t1) marker(ctx, toX(fault.atBatch), top);
      ctx.restore();
    }
    ctx.strokeStyle = "#cdd8d5";
    ctx.beginPath();
    ctx.moveTo(gutter - 0.5, 0);
    ctx.lineTo(gutter - 0.5, height);
    ctx.stroke();
    const cx = toX(cursor);
    if (cx >= gutter && cx <= gutter + plot) {
      ctx.strokeStyle = "#172d2b";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Time axis: ticks at round times, labelled through the batch period.
    const aw = fit(axis, actx, axisWidth, axisHeight), period = run.machine.dspPeriodPs;
    actx.clearRect(0, 0, aw, axisHeight);
    actx.font = '11px "Cascadia Code", Consolas, monospace';
    actx.textBaseline = "middle";
    actx.fillStyle = "#50635e";
    actx.fillText("time", 4, 12);
    const raw = ((t1 - t0) * period) / Math.max(2, Math.floor(plot / 130));
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
    const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw);
    actx.strokeStyle = "#b9c7c3";
    for (let k = Math.ceil((t0 * period) / step); k * step <= t1 * period; k++) {
      const px = toX((k * step) / period);
      if (px < gutter - 1) continue;
      actx.beginPath();
      actx.moveTo(px, axisHeight - 6);
      actx.lineTo(px, axisHeight);
      actx.stroke();
      actx.textAlign = px > aw - 60 ? "right" : "left";
      actx.fillText(model.formatTime(k * step || 0), px + (px > aw - 60 ? -3 : 3), 10);
    }
    actx.textAlign = "left";
    for (const { fault } of faults) if (fault.atBatch >= t0 && fault.atBatch <= t1) marker(actx, toX(fault.atBatch), axisHeight - 8);
    if (cx >= gutter && cx <= gutter + plot) {
      actx.fillStyle = "#172d2b";
      actx.fillRect(cx - 0.5, axisHeight - 9, 1, 9);
    }
    const shown = Math.round(t0) + "/" + Math.round(t1);
    if (shown !== ranged) {
      ranged = shown;
      hooks.range("batches " + count(Math.max(0, Math.round(t0))) + " to " + count(Math.round(t1)) +
        " · " + model.formatTime(Math.max(0, Math.round(t0)) * period) + " to " + model.formatTime(Math.round(t1) * period));
    }
  }
  function clampView(t0, t1) {
    const span = Math.min(Math.max(t1 - t0, 8), total * 1.06);
    const low = -0.03 * total, high = total * 1.03;
    const start = Math.min(Math.max(t0, low), Math.max(low, high - span));
    view = [start, start + span];
  }
  function whole() {
    clampView(-0.03 * total, total * 1.03);
    draw();
  }
  for (const target of [axis, canvas]) {
    target.addEventListener("wheel", (e) => {
      if (!run || e.ctrlKey) return;
      e.preventDefault();
      const x = e.clientX - target.getBoundingClientRect().left, span = view[1] - view[0];
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const shift = ((e.deltaX || e.deltaY) / plotWidth()) * span;
        clampView(view[0] + shift, view[1] + shift);
      } else {
        const anchor = toBatch(Math.max(gutter, x)), next = span * Math.exp(e.deltaY * 0.0016);
        const share = (anchor - view[0]) / span;
        clampView(anchor - share * next, anchor + (1 - share) * next);
      }
      draw();
    }, { passive: false });
    target.addEventListener("pointerdown", (e) => {
      if (!run || e.button) return;
      drag = { x: e.clientX, view: view.slice(), moved: false };
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 4) return;
      drag.moved = true;
      const shift = (-dx / plotWidth()) * (drag.view[1] - drag.view[0]);
      clampView(drag.view[0] + shift, drag.view[1] + shift);
      draw();
    });
    target.addEventListener("pointerup", (e) => {
      const was = drag;
      drag = null;
      if (!was || was.moved) return;
      const r = target.getBoundingClientRect(), x = e.clientX - r.left;
      if (x < gutter) {
        const lane = target === canvas ? lanes[Math.floor((e.clientY - r.top) / laneHeight)] : null;
        if (lane) hooks.pick(lane.part);
      } else hooks.seek(toBatch(x));
    });
    target.addEventListener("pointercancel", () => {
      drag = null;
    });
    target.addEventListener("dblclick", whole);
  }
  scroller.addEventListener("scroll", () => {
    scroll = scroller.scrollTop;
    draw();
  }, { passive: true });
  const resized = new ResizeObserver(() => {
    measure();
    draw();
  });
  for (const target of [canvas, axis, scroller]) resized.observe(target);
  measure();
  return {
    whole,
    setRun(next) {
      run = next;
      lanes = model.lanes(run);
      faults = model.faultFrames(run);
      total = Math.max(1, run.summary.elapsedBatches ?? 0, run.frames.at(-1)?.atBatch ?? 0,
        ...lanes.map((lane) => lane.windows.at(-1)?.closes ?? 0));
      scroller.scrollTop = scroll = 0;
      ranged = "";
      whole();
    },
    /** Move the cursor. The view follows when the cursor leaves it. */
    show(batch, actingPart, chosenPart) {
      cursor = batch;
      acting = actingPart;
      chosen = chosenPart;
      if (!drag && (batch < view[0] || batch > view[1])) {
        const span = view[1] - view[0];
        clampView(batch - span * 0.25, batch + span * 0.75);
      }
      draw();
    },
  };
}

// ───────────────────────────── page state ─────────────────────────────

let run = null, runText = "", index = -1, chosen = null, state = null;
let examples = [], program = null, outcomes = {}, token = 0, pendingStep = null;
let stopLists = { pulse: [], fault: [], instruction: [] }, faultSet = new Set();
let traceItems = null, lastTraceIndex = null, lastSource = null, platformKey = "", deviceKey = "", sourceLimit = 40000;
let playing = false, playClock = 0, playCarry = 0, dirty = false;

const scene = createControllerScene($("viewport"), (id) => choose(id));
const timeline = createTimeline($("timeAxis"), $("lanes"), document.querySelector(".lanes-scroll"), {
  seek: (batch) => jump(model.indexAtBatch(run, batch)),
  pick: (part) => choose(part),
  range: (text) => ($("timelineRange").textContent = text),
});
const traceList = createVirtualList($("trace"), 7, "trace-row", fillTraceRow, (row) => jump(traceItems ? traceItems[row] : row), "No frames.");
const instructionList = createVirtualList($("instructions"), 6, "instruction-row", fillInstructionRow, (row) => {
  const entry = model.hardwareOps(run)[row];
  if (entry.first >= 0) jump(entry.first);
}, "This program has no hardware instruction.");

const period = () => run.machine.dspPeriodPs;
const timeOf = (batch) => model.formatTime(batch * period());
const partLabel = (id) => run.system.parts.find((p) => p.id === id)?.label ?? id;
const partButton = (id) => button(id, () => choose(id), partLabel(id));
const frameButton = (id, label) => button(label ?? id, () => jump(model.frameIndex(run, id)), "Go to frame " + id);

function note(message) {
  $("alert").textContent = message ?? "";
  $("alert").hidden = !message;
}
function stop() {
  playing = false;
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
  traceItems = chosen ? model.framesOfPart(run, chosen) : null;
  traceList.setCount(traceItems ? traceItems.length : run.frames.length);
  lastTraceIndex = null;
  schedule();
}

// ───────────────────────────── inspector ─────────────────────────────

const batchFields = { opens: "batch", closes: "batch", atConverter: "batch", lands: "batch", until: "batch", freqLands: "batch",
  ampLands: "batch", phaseLands: "batch", envLands: "batch", startTime: "batch time", t0: "batch time", time: "batch time", dur: "batches" };
const used = (slot) => slot.phase || slot.amp || slot.env || slot.dur;
const brief = (text, limit) => (text.length > limit ? text.slice(0, limit) + "… (" + count(text.length) + " characters)" : text);

/** One state field of a frame as text. Codes stay the integers of the trace. */
function showValue(key, value) {
  if (value === null) return "none";
  if (key === "buffer")
    return "start time " + value.startTime + " · carrier code " + value.freq + " · " + value.table.filter(used).length + " of " + value.table.length + " entries set";
  if (key === "arrivesPs") return model.formatTime(value) + " (" + count(value) + " ps)";
  if (Number.isInteger(value)) {
    if (["pc", "address", "word"].includes(key)) return hex(value);
    if (["value", "store", "data"].includes(key)) return value + " (" + hex(value) + ")";
    if (["mask", "levels", "changed"].includes(key)) return lines16(value) + " (" + value + ")";
    if (batchFields[key] === "batches") return value + " batches · " + timeOf(value);
    if (batchFields[key]) return value + " (" + batchFields[key] + ")";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function paintInspector(frame, fault) {
  const total = run.frames.length;
  $("eventTime").replaceChildren(...timeOf(state.atBatch).split(" ").map((part, k) => (k ? el("small", { text: " " + part }) : document.createTextNode(part))));
  $("eventBatch").textContent = "batch " + count(state.atBatch) + " · " + count(state.atBatch * period()) + " ps · step " + count(index + 1) + " of " + count(total);
  if (!frame) {
    $("eventTitle").textContent = "Reset state";
    $("description").textContent = "Before the first frame. Every core starts at " + hex(run.initial.pc) + " with zeroed registers. The batch-time register reads " +
      run.initial.timeRegister + " and each core's copy reads " + hex(run.initial.coreTime) + ".";
    fields($("frameFields"), [["frame", "none"]]);
    fields($("stateFields"), []);
    $("causes").textContent = "Program start";
    $("chain").replaceChildren();
  } else {
    const [title, description] = model.describe(run, frame);
    $("eventTitle").textContent = title;
    $("description").textContent = description;
    const origin = model.hardwareOp(run, frame.source);
    const owner = state.cores[model.coreOfPart(run, frame.part)];
    const text = frame.state?.text ?? (frame.op === "resume" ? owner?.lastText : undefined);
    fields($("frameFields"), [
      ["frame", frame.id],
      ["operation", frame.op + (fault ? " · fault" : "")],
      ["part", el("span", {}, partButton(frame.part), partLabel(frame.part))],
      frame.targets?.length ? ["targets", el("span", {}, frame.targets.map(partButton))] : null,
      ["time", "batch " + count(frame.atBatch) + " · " + timeOf(frame.atBatch)],
      ["source", frame.source === undefined ? "none"
        : origin ? el("span", {}, button(frame.source, () => jump(origin.first), "Go to the first frame of this instruction"), origin.op.op + " · " + origin.op.source)
        : frame.source + " (firmware phase)"],
      frame.pc !== undefined ? ["pc", hex(frame.pc)] : null,
      text !== undefined ? ["assembly", text + (frame.state?.text === undefined ? " (the stalled read)" : "")] : null,
      origin ? ["instruction", brief(JSON.stringify(origin.op), 420)] : null,
    ]);
    fields($("stateFields"), Object.entries(frame.state ?? {}).filter(([key]) => key !== "text")
      .map(([key, value]) => [key, showValue(key, value)]));
    $("causes").replaceChildren(...(frame.parents?.length ? frame.parents.map((id) => frameButton(id))
      : [frame.op === "edge" ? "A scripted input. It has no cause inside the model." : "Program start"]));
    const chain = model.causalChain(run, frame.id);
    $("chain").replaceChildren(...(chain.length > 1
      ? ["Causal chain: ", ...chain.flatMap((f, k) => [k ? " → " : "", frameButton(f.id, f.id + " " + f.op)])]
      : []));
  }
  // Selection.
  if (chosen) {
    const list = model.framesOfPart(run, chosen), seen = model.countUpTo(list, index);
    const kind = model.partKind(run, chosen);
    $("selection").replaceChildren(
      el("div", { text: chosen + " · " + kind + " · " + partLabel(chosen) }),
      el("div", { class: "subtle", text: count(seen) + " of " + count(list.length) + " frames of this part are at or before this step. The trace below lists them." }),
      Object.assign(button("Previous frame", () => jump(before(list, index))), { disabled: before(list, index) < 0 }),
      Object.assign(button("Next frame", () => jump(after(list, index))), { disabled: after(list, index) < 0 }),
      button("Clear selection", () => choose(chosen)),
    );
  } else $("selection").textContent = "Select a part in the schematic, a timeline lane or an apparatus part.";
  const focus = chosen ?? frame?.part ?? run.machine.cores[0]?.name;
  $("stateTitle").textContent = "Reconstructed state of " + focus;
  $("stateNote").textContent = (frame ? "After step " + count(index + 1) + ", from frames 1 to " + count(index + 1) + " only." : "At reset.") +
    (chosen ? "" : " This is the acting part. Select a part to keep it in view.");
  put($("partState"), partState(focus, frame));
  // Every core, every open window and the hub, whatever part is in view.
  const open = state.openWindows, hub = state.hub;
  put($("machineState"),
    Object.assign(table(["core", "status", "last traced pc", "working on"],
      state.cores.map((core) => [partButton(core.name), coreStatus(core), hex(core.pc), core.lastSource ?? ""])), { className: "words" }),
    heading(count(open.length) + (open.length === 1 ? " window" : " windows") + " open at batch " + count(state.atBatch)),
    open.length ? el("div", {}, open.slice(0, 24).map((w) => button(w.part, () => choose(w.part), "Window " + w.id + ": batches " + w.opens + " to " + w.closes + " on " + w.converter))) : null,
    open.length > 24 ? el("p", { class: "subtle", text: "The first 24 are listed." }) : null,
    heading("Hub"),
    list([
      ["group words", hub.groups.map((word) => hex(word)).join(" ")],
      ["open barriers", hub.barriers.length ? hub.barriers.map((b) => "barrier " + b.barrier + ": " + b.arrived.length + " of " + b.expected + " arrived").join(" · ") : "none"],
      ["waiting at the arbiter", hub.waiting.length ? count(hub.waiting.length) : "none"],
    ]),
    run.system.parts.filter((part) => part.kind === "hub").map((part) => partButton(part.id)),
  );
}

const heading = (text) => el("h4", { text });
const coreStatus = (core) => (core.stopped ? "stopped: " + core.stopped
  : core.waiting ? "stalled on " + core.waiting.register + (core.waiting.until === null ? " until its sink is ready" : " until batch " + core.waiting.until)
  : "running");
const list = (rows) => fields(el("dl", { class: "fields" }), rows);
function table(head, rows) {
  return el("table", {}, el("thead", {}, el("tr", {}, head.map((text) => el("th", { text })))),
    el("tbody", {}, rows.map((row) => el("tr", {}, row.map((cell) => el("td", {}, cell))))));
}
function windowRows(windows) {
  return table(["window", "slot", "opens", "closes", "converter", "amp", "phase", "carrier", ""],
    windows.map((w) => [frameButton(w.id), w.slot, w.opens, w.closes, w.converter, w.amp, w.phase, w.freq,
      el("span", { class: "bad", text: [w.onTime === false && "late", w.aligned === false && "misaligned", w.overlap && "overlap"].filter(Boolean).join(" ") })]));
}

/** The reconstructed state of one part as document nodes. */
function partState(id, frame) {
  const kind = model.partKind(run, id), owner = model.coreOfPart(run, id), core = state.cores[owner];
  const seen = model.countUpTo(model.framesOfPart(run, id), index);
  if (kind === "core" && core) {
    const wrote = frame?.part === id && frame.op !== "wait" ? frame.state?.rd : undefined;
    const full = state.trace === "full";
    return [
      list([
        ["status", coreStatus(core)],
        ["last traced pc", hex(core.pc)],
        ["last instruction", core.lastText ?? "none traced"],
        ["working on", core.lastSource ?? "nothing yet"],
        ["retired", count(core.retired) + " instructions up to the last traced one"],
        ["timeCmp", core.timeCmp + " (batch time)"],
      ]),
      heading("Registers"),
      el("div", { class: "regs" }, core.regs.map((value, r) => {
        const known = full || r === 0 || core.regSeen[r];
        return el("span", { class: r === wrote ? "changed" : known ? "" : "unknown", title: known ? "x" + r + " = " + value : "No traced instruction wrote x" + r },
          el("b", { text: "x" + r }), known ? hex(value) : "not traced");
      })),
      el("p", { class: "subtle", text: full
        ? "This trace holds every instruction, so the register file is complete."
        : "This trace holds only the instructions that touch control registers. A register shows its last traced write and can have changed since. Tick “Trace every instruction” for the whole register file." }),
      heading("Channels and inbox"),
      el("div", {}, core.channels.map((ch) => partButton(ch.part)), partButton(core.name + ".inbox")),
    ];
  }
  const channel = core?.channels.find((ch) => ch.part === id);
  if (channel) {
    const set = channel.buffer.table.map((slot, k) => [k, slot]).filter(([, slot]) => used(slot));
    return [
      list([
        ["core", partButton(core.name)],
        ["start time", channel.buffer.startTime + " (batch time of the next fire)"],
        ["carrier in buffer", channel.buffer.freq + " (code)"],
        ["carrier in effect", channel.freq + " (code)"],
        ["dc offset", String(channel.buffer.dcOffset)],
        ["phase offset", channel.buffer.phaseOffset + " (code)"],
        ["windows opened", count(channel.windows)],
        channel.kind === "dio" ? ["output lines", lines16(channel.dout)] : null,
        channel.kind === "dio" ? ["input lines", lines16(channel.din)] : null,
      ]),
      heading(channel.kind === "dio" ? "Digital update table" : "Pulse table"),
      channel.written ? null : el("p", { class: "subtle", text: "No write has reached this channel. The buffer is at reset." }),
      set.length ? table(channel.kind === "dio" ? ["entry", "mask", "value", "env", "dur"] : ["entry", "phase", "amp", "env", "dur (batches)"],
        set.map(([k, slot]) => [k, slot.phase, slot.amp, slot.env, slot.dur])) : null,
      set.length < channel.buffer.table.length ? el("p", { class: "subtle", text: channel.buffer.table.length - set.length + " of " + channel.buffer.table.length + " entries are zero." }) : null,
      heading("Windows open at batch " + count(state.atBatch)),
      channel.open.length ? windowRows(channel.open) : el("p", { class: "subtle", text: "None." }),
    ];
  }
  if (kind === "inbox" && core)
    return [
      list([
        ["core", partButton(core.name)],
        ["board words", core.board.map((word) => hex(word)).join(" ")],
        ["release box", core.release === null ? "empty" : core.release + " (batch time)"],
        ["mailboxes", core.mailboxes.map((word) => (word === null ? "empty" : hex(word))).join(" · ")],
      ]),
      heading("Sinks"),
      core.sinks.length ? core.sinks.map((sink) => list(sink.kind === "result"
        ? [["channel", partButton(sink.channel)], ["result", sink.valid ? "valid · bit " + sink.res + " · real " + sink.real + " · imag " + sink.imag : "not valid"]]
        : [["channel", partButton(sink.channel)], ["queued events", sink.count + " · " + sink.nextSeq + " received"],
          ["events", sink.events.length ? JSON.stringify(sink.events) : "none"],
          ["last read", sink.popped ? JSON.stringify(sink.popped) : "none"]]))
        : el("p", { class: "subtle", text: "This core has no reporting channel." }),
    ];
  if (kind === "hub") {
    const hub = state.hub;
    return [list([
      ["group words", hub.groups.map((word) => hex(word)).join(" ")],
      ["open barriers", hub.barriers.length ? hub.barriers.map((b) => "barrier " + b.barrier + ": " + b.arrived.length + " of " + b.expected + " arrived (" + b.arrived.join(", ") + ")").join(" · ") : "none"],
      ["last release", hub.lastRelease ? el("span", {}, frameButton(hub.lastRelease.frame), "barrier " + hub.lastRelease.barrier + " · " + hub.lastRelease.members + " members · batch time " + hub.lastRelease.t0) : "none"],
      ["last signal", hub.lastSignal ? el("span", {}, frameButton(hub.lastSignal.frame), "to " + hub.lastSignal.to + " mailbox " + hub.lastSignal.mailbox + " · " + hex(hub.lastSignal.word)) : "none"],
      ["member counts", hub.countMismatch ? "disagree" : "agree"],
      ["waiting at the arbiter", hub.waiting.length ? el("span", {}, hub.waiting.map((beat) => frameButton(beat.frame)), count(hub.waiting.length) + " system " + (hub.waiting.length === 1 ? "put" : "puts") + " · one is dispatched per batch") : "none"],
      ["dropped", hub.dropped ? count(hub.dropped) + " system puts into a full queue" : "none"],
    ])];
  }
  if (kind === "host")
    return [
      list([["cores done", state.cores.filter((c) => c.done).map((c) => c.name).join(", ") || "none"]]),
      heading("Words stored to the host window"),
      state.host.length ? table(["frame", "core", "offset", "bytes", "value"], state.host.slice(-12).reverse().map((w) => [frameButton(w.frame), w.core, w.offset, w.bytes, w.value]))
        : el("p", { class: "subtle", text: "None so far." }),
      state.host.length > 12 ? el("p", { class: "subtle", text: "The last 12 of " + count(state.host.length) + "." }) : null,
    ];
  if (kind === "device") {
    const reached = state.effects.filter((effect) => effect.part === id);
    return [
      list([["effects so far", count(reached.length)]]),
      reached.length ? table(["frame", "binding", "arrives", "detail"], reached.slice(-6).reverse().map((effect) =>
        [frameButton(effect.id), effect.binding, model.formatTime(effect.arrivesPs), JSON.stringify(effect.detail)])) : null,
      reached.length > 6 ? el("p", { class: "subtle", text: "The last 6 of " + count(reached.length) + "." }) : null,
    ];
  }
  if (["dac", "adc", "pins"].includes(kind)) {
    const open = state.openWindows.filter((w) => w.converter === id), line = model.channelInfo(run, id);
    const levels = kind === "pins" && line ? state.cores[line.core].channels[line.channel] : null;
    return [
      list([
        ["frames so far", count(seen)],
        levels ? ["channel", partButton(levels.part)] : null,
        levels ? ["output lines", lines16(levels.dout)] : null,
        levels ? ["input lines", lines16(levels.din)] : null,
      ]),
      heading("Windows open at batch " + count(state.atBatch)),
      open.length ? windowRows(open) : el("p", { class: "subtle", text: "None." }),
    ];
  }
  const frames = model.framesOfPart(run, id);
  return [list([
    core ? ["core", partButton(core.name)] : null,
    ["frames so far", count(seen)],
    ["last frame", seen ? frameButton(run.frames[frames[seen - 1]].id) : "none"],
  ])];
}

// ───────────────────────────── platform view ─────────────────────────────

const platformText = {
  superconducting: ["Qubits and resonators", "The apparatus parts that a pulse has reached so far, from the effect frames. No quantum state is simulated."],
  qccd: ["Ion positions by site", "Sites follow the ion moves of the run. A move counts once its windows have closed and every waveform of its cycle played on time. Electrode voltages and ion motion are not simulated."],
  neutral: ["AOD tone positions", "Each tone's position in µm from the carrier updates that reached its channel so far. A solid line has an open pulse window at this batch. Atoms are assumed to follow their tones and are not simulated."],
};
let toneCanvas = null, toneSize = null;

function paintPlatform() {
  const devices = run.system.parts.filter((p) => p.kind === "device");
  const openParts = new Set(state.openWindows.map((w) => w.part));
  const key = JSON.stringify([devices.map((p) => state.devices[p.id]?.count ?? 0), chosen]);
  if (key !== deviceKey) {
    deviceKey = key;
    $("devices").replaceChildren(...(devices.length ? devices.map((part) => {
      const reached = state.devices[part.id];
      return el("button", { type: "button", class: "chip" + (reached ? " reached" : ""), "aria-pressed": String(chosen === part.id), onclick: () => choose(part.id) },
        part.id,
        el("small", { text: reached ? count(reached.count) + (reached.count === 1 ? " effect" : " effects") + " · last " + (reached.last.detail?.kind ?? reached.last.binding) : "no effect yet" }),
        el("small", { text: reached ? "arrived " + model.formatTime(reached.last.arrivesPs) : "" }));
    }) : [el("p", { class: "subtle", text: "The run binds no apparatus part." })]));
  }
  if (run.platform === "qccd") {
    const view = model.ionsAt(run, state.atBatch);
    const text = JSON.stringify(view);
    if (text === platformKey) return;
    platformKey = text;
    const byName = new Map(view.ions.map((ion) => [ion.ion, ion]));
    const sites = view.sites.map(({ site, ions }) => el("div", { class: "chip site reached" }, site,
      el("span", {}, ions.map((name) => {
        const ion = byName.get(name);
        return el("span", { class: "ion" + (ion.moving ? " moving" : ion.undelivered ? " undelivered" : ""),
          text: name + (ion.moving ? " → " + ion.moving.to : ""),
          title: ion.moving ? "In transit to " + ion.moving.to + " over " + ion.moving.via.join(", ") + " (" + ion.moving.op + ")"
            : ion.undelivered ? "Move " + ion.undelivered + " was not delivered" : ion.stated ? "Site stated by " + ion.stated : "" });
      }))));
    const unplaced = view.ions.filter((ion) => ion.site === null).map((ion) => ion.ion);
    const undelivered = view.ions.filter((ion) => ion.undelivered);
    put($("platformView"),
      el("div", { class: "chips" }, sites.length ? sites : el("p", { class: "subtle", text: "The run holds no ion move." })),
      unplaced.length ? el("p", { class: "subtle", text: "No move or gate of this run names a site for " + unplaced.join(", ") + "." }) : null,
      undelivered.length ? el("p", { class: "bad", text: "Not delivered: " + undelivered.map((ion) => ion.ion + " in " + ion.undelivered).join(", ") + ". These ions are shown at their site before the move." }) : null,
    );
  } else if (run.platform === "neutral") {
    const tones = model.tonesAt(run, state.atBatch);
    if (!toneCanvas) {
      toneCanvas = el("canvas", { "aria-label": "Tone positions in micrometres" });
      $("platformView").replaceChildren(toneCanvas, el("div", { id: "toneTable" }));
      toneSize = null;
      new ResizeObserver(() => {
        platformKey = "";
        toneSize = null;
        if (run?.platform === "neutral" && state) paintPlatform();
      }).observe(toneCanvas);
    }
    const text = JSON.stringify([tones, [...openParts]]);
    if (text === platformKey) return;
    platformKey = text;
    drawTones(tones, openParts);
    const axisTones = tones.filter((tone) => tone.axis);
    put($("toneTable"),
      axisTones.length ? table(["tone", "axis", "position", "last update", "from", "window open"], axisTones.map((tone) => [
        partButton(tone.part), tone.axis, tone.um.toFixed(3) + " µm", "batch " + count(tone.atBatch), tone.source,
        el("span", { class: openParts.has(tone.part) ? "lit" : "", text: openParts.has(tone.part) ? "yes" : "no" })]))
        : el("p", { class: "subtle", text: "No tone of an AOD axis has a carrier update yet." }),
      tones.length > axisTones.length ? el("p", { class: "subtle", text: "Not drawn, because no effect frame gives them an AOD axis: " + tones.filter((tone) => !tone.axis).map((tone) => tone.part).join(", ") + "." }) : null,
    );
  } else if (platformKey !== "none") {
    platformKey = "none";
    $("platformView").replaceChildren();
  }
}

/** Tone lines over the range that the tones cover in the whole run. The two axes have separate scales. */
function drawTones(tones, openParts) {
  toneSize ??= [toneCanvas.clientWidth, toneCanvas.clientHeight];
  const ctx = toneCanvas.getContext("2d"), [w, h] = toneSize, dpr = Math.min(devicePixelRatio, 2);
  const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
  if (toneCanvas.width !== bw || toneCanvas.height !== bh) {
    toneCanvas.width = bw;
    toneCanvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const extent = model.toneExtent(run), left = 64, right = 16, top = 22, bottom = 30;
  const range = (axis) => {
    const [a, b] = extent[axis] ?? [0, 1], margin = Math.max((b - a) * 0.06, 0.5);
    return [a - margin, b + margin];
  };
  const [x0, x1] = range("x"), [y0, y1] = range("y");
  // A position outside the range, such as the start-up carrier, is drawn at the edge.
  const within = (um, a, b) => Math.min(b, Math.max(a, um));
  const px = (um) => left + ((within(um, x0, x1) - x0) / (x1 - x0)) * (w - left - right);
  const py = (um) => top + ((within(um, y0, y1) - y0) / (y1 - y0)) * (h - top - bottom);
  ctx.font = '11px "Cascadia Code", Consolas, monospace';
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "#cdd8d5";
  ctx.strokeRect(left, top, w - left - right, h - top - bottom);
  ctx.fillStyle = "#526568";
  for (let k = 0; k <= 4; k++) {
    const x = x0 + ((x1 - x0) * k) / 4, y = y0 + ((y1 - y0) * k) / 4;
    ctx.textAlign = "center";
    ctx.fillText(x.toFixed(1), px(x), h - bottom + 11);
    ctx.textAlign = "right";
    ctx.fillText(y.toFixed(1), left - 6, py(y));
  }
  ctx.textAlign = "left";
  ctx.fillText("x (µm) across, y (µm) down, separate scales. The range is what hardware instructions set. Other positions sit at the edge.", left, 10);
  const palette = ["#00695d", "#8058a1", "#8a6027", "#2a7287"];
  const cores = [...new Set(tones.filter((tone) => tone.axis).map((tone) => model.channelInfo(run, tone.part).coreName))];
  cores.forEach((name, k) => {
    const mine = tones.filter((tone) => tone.axis && model.channelInfo(run, tone.part).coreName === name);
    ctx.strokeStyle = ctx.fillStyle = palette[k % palette.length];
    for (const tone of mine) {
      const on = openParts.has(tone.part);
      ctx.lineWidth = on ? 2 : 1;
      ctx.setLineDash(on ? [] : [4, 4]);
      ctx.beginPath();
      if (tone.axis === "x") {
        ctx.moveTo(px(tone.um), top);
        ctx.lineTo(px(tone.um), h - bottom);
      } else {
        ctx.moveTo(left, py(tone.um));
        ctx.lineTo(w - right, py(tone.um));
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // A spot where two driven tones of one AOD cross.
    for (const a of mine) for (const b of mine)
      if (a.axis === "x" && b.axis === "y" && openParts.has(a.part) && openParts.has(b.part)) {
        ctx.beginPath();
        ctx.arc(px(a.um), py(b.um), 4, 0, 2 * Math.PI);
        ctx.fill();
      }
    ctx.fillText(name, w - right - 60, top + 12 + 14 * k);
  });
  ctx.lineWidth = 1;
}

// ───────────────────────────── program panel and lists ─────────────────────────────

function fillTraceRow(row, i) {
  const at = traceItems ? traceItems[i] : i, frame = run.frames[at], cells = row.children;
  cells[0].textContent = count(at + 1);
  cells[1].textContent = count(frame.atBatch);
  cells[2].textContent = timeOf(frame.atBatch);
  cells[3].textContent = frame.op;
  cells[4].textContent = frame.part;
  cells[5].textContent = frame.source ?? "";
  cells[6].textContent = frame.id;
  if (faultSet.has(at)) row.classList.add("faulty");
  if (at === index) row.setAttribute("aria-current", "true");
}
function operands(op) {
  return [
    op.qubits?.length ? "q" + op.qubits.join(", q") : null,
    op.pauli ? "Pauli " + op.pauli : null,
    op.inputs ? op.inputs.join(", ") + " → " + op.outputs.join(", ") : null,
    op.ions ? op.ions.join(", ") : null,
    op.aod !== undefined ? "AOD " + op.aod : null,
    op.sites ? "at " + op.sites.join(", ") : null,
    op.when !== undefined ? "if " + op.when : null,
  ].filter(Boolean).join(" · ");
}
function fillInstructionRow(row, i) {
  const { op, segment, first, frames } = model.hardwareOps(run)[i], cells = row.children;
  const unit = run.hardware.timeUnit === "ps" ? model.formatTime : (v) => v + " " + run.hardware.timeUnit;
  cells[0].textContent = op.id;
  cells[1].textContent = op.op;
  cells[2].textContent = operands(op);
  // A classical instruction has no scheduled time: the decoder core runs it when it gets there.
  const classical = run.hardware.segments[segment]?.classical;
  cells[3].textContent = (classical ? "when reached" : unit(op.t)) + (run.hardware.segments.length > 1 ? " · s" + segment : "");
  cells[4].textContent = classical ? "see trace" : unit(op.dur);
  cells[5].textContent = op.source ?? "";
  row.title = first < 0 ? op.id + ": no frame carries this instruction." : op.id + ": " + count(frames) + " frames.";
  if (first < 0) row.classList.add("inert");
  if (op.id === run.frames[index]?.source) row.setAttribute("aria-current", "true");
}

function paintSource() {
  const text = run.source?.text ?? "", shown = text.slice(0, sourceLimit);
  $("sourceLanguage").textContent = "Source · " + (run.source?.language ?? "unknown language");
  $("sourceText").replaceChildren(...(text
    ? shown.split("\n").map((line, k) => el("span", { "data-line": k + 1, text: line }))
    : [el("span", { "data-line": "", text: "The bundle carries no source text for this program." })]));
  $("sourceAll").hidden = shown.length === text.length;
  $("sourceAll").textContent = "Show all " + count(text.length) + " characters";
  $("sourceAll").onclick = () => {
    sourceLimit = Infinity;
    paintSource();
  };
  const tsir = typeof run.source?.tsir === "string" ? run.source.tsir : "";
  $("tsir").hidden = !tsir;
  $("tsir").open = false;
  $("tsirText").textContent = "";
  $("tsir").querySelector("summary").textContent = "Compiled TSIR program · " + count(tsir.length) + " characters";
  $("tsir").ontoggle = () => {
    if ($("tsir").open) $("tsirText").textContent = brief(tsir, 60000);
  };
  lastSource = null;
}

function paintStatus() {
  const s = run.summary;
  $("runState").textContent = s.status + " · " + count(run.frames.length) + " frames · " + model.formatTime(s.elapsedPs) + " · " + s.faults.length + (s.faults.length === 1 ? " fault" : " faults");
  $("runState").classList.toggle("fault", s.status !== "quiescent" || s.faults.length > 0);
}

/** Fill everything that depends on the run and not on the step. */
function paintRun() {
  const s = run.summary, title = run.example?.title ?? "Custom " + (run.source?.language ?? "") + " program";
  $("programTitle").textContent = title + " · " + run.machine.name + " · " + run.platform + (run.example?.description ? ". " + run.example.description : "");
  paintStatus();
  $("basis").textContent = "Layout: " + run.system.basis + ". Positions are a schematic floorplan, not physical geometry. Height separates logic, converters and apparatus for display, and parts that share a position are stacked.";
  // Measured bits are inputs of the run. Each toggle re-runs the program.
  const names = [...new Set([...run.firmware.flatMap((image) => Object.keys(image.bits ?? {})), ...Object.keys(run.derived?.bits ?? {})])];
  // A QCCD bit is named `<ion>@<instruction>`, and its outcome may have been given by ion name.
  const asked = (name) => outcomes[name] ?? outcomes[name.split("@")[0]] ?? 0;
  $("outcomes").replaceChildren(...(names.length && program ? [document.createTextNode("Measurement outcome (input)"), ...names.map((name) =>
    el("label", {}, el("input", { type: "checkbox", checked: asked(name) === 1, onchange: (e) => {
      outcomes = { ...outcomes, [name]: e.target.checked ? 1 : 0 };
      load(program, true);
    } }), name + " = 1"))] : []));
  const bits = Object.entries(run.derived?.bits ?? {});
  $("bits").textContent = bits.length ? "Bits stored to the host: " + bits.map(([name, value]) => name + " = " + value).join(", ") : "";
  const [heading_, text] = platformText[run.platform] ?? ["Apparatus", ""];
  $("platformTitle").textContent = heading_;
  $("platformNote").textContent = text;
  // Program panel.
  sourceLimit = 40000;
  paintSource();
  const ops = model.hardwareOps(run), unit = run.hardware.timeUnit === "ps" ? model.formatTime : (v) => v + " " + run.hardware.timeUnit;
  $("sourceNote").textContent = count(ops.length) + " hardware instructions in " + run.hardware.segments.length + (run.hardware.segments.length === 1 ? " segment" : " segments") +
    " on " + run.machine.name + ". One batch is one dspClk cycle of " + model.formatTime(period()) + "." + (run.source?.compiler ? " Compiled by " + run.source.compiler + "." : "");
  $("hardwareNote").textContent = run.hardware.segments.slice(0, 8).map((segment, k) =>
    segment.classical
      ? "Segment " + k + ": " + segment.ops.length + " classical instructions on the decoder core, run as soon as the cores have met. They play no pulse"
      : "Segment " + k + ": " + segment.ops.length + " instructions over " + unit(segment.span) +
    (run.preroll?.[k] !== undefined ? ", delayed " + count(run.preroll[k]) + " batches (" + timeOf(run.preroll[k]) + ") so that its widest burst of writes leaves on time" : "")).join(". ") +
    (run.hardware.segments.length > 8 ? ". " + (run.hardware.segments.length - 8) + " more segments." : ".") +
    " Start times count from the start of the segment. Select an instruction to go to its first frame.";
  instructionList.setCount(ops.length);
  const editable = (/^OpenQASM/.test(run.source?.language ?? "") && ["superconducting", "qccd"].includes(run.platform)) || isCalls();
  $("qasmEditor").hidden = !editable;
  if (editable && program?.qasm === undefined && program?.calls === undefined) $("qasmText").value = run.source.text;
  document.querySelector("#qasmEditor summary").textContent = "Edit " + (run.source?.language ?? "OpenQASM") + " and run it on this " + run.platform + " machine";
  $("firmware").replaceChildren(...run.firmware.map((image, k) => el("tr", {},
    el("td", {}, partButton(image.core)), el("td", { text: count(image.instructions) }), el("td", { text: count(image.writes) }),
    el("td", { text: Object.keys(image.bits ?? {}).join(", ") || "none" }), el("td", { text: count(s.cores[k]?.retired ?? 0) }),
    el("td", { text: s.cores[k]?.stopped ?? (s.cores[k]?.waiting ? "stalled" : "running") }))));
  $("provenance").textContent = "Machine " + run.machine.name + ". " + Object.entries(run.machine.provenance ?? {}).map(([name, value]) => name + ": " + value).join(". ") + ".";
  // Faults.
  const faults = model.faultFrames(run);
  put($("faults"), (faults.length ? [...faults.slice(0, 200).map(({ fault, index: at }) => el("div", {},
    at >= 0 ? button("batch " + count(fault.atBatch), () => jump(at), "Go to the frame of this fault") : "batch " + count(fault.atBatch),
    " " + fault.part + " · " + fault.reason)),
    faults.length > 200 ? el("p", { class: "subtle", text: "The first 200 of " + count(faults.length) + " faults. “Next fault” steps through all of them." }) : null]
    : [el("p", { class: "subtle", text: "The run reports no fault." })]));
  $("traceNote").textContent = model.traceDetail(run) === "full" ? "Every instruction is a frame." : "Core frames are the instructions that touch control registers.";
}

/** The parts of the page that follow the step. */
function paint() {
  dirty = false;
  if (!run) return;
  const frame = run.frames[index], total = run.frames.length;
  state = model.stateAt(run, index);
  const fault = faultSet.has(index);
  // The lists come first: moving a scroll position is cheap while the layout is still clean.
  // They follow the step only when it changed, so that scrolling by hand is kept.
  if (lastTraceIndex !== index) {
    lastTraceIndex = index;
    // With a part selected, the list shows that part's last frame at or before this step.
    traceList.reveal(traceItems ? model.countUpTo(traceItems, index) - 1 : index);
  }
  traceList.render();
  if (lastSource !== (frame?.source ?? "")) {
    lastSource = frame?.source ?? "";
    const entry = model.hardwareOp(run, frame?.source);
    instructionList.reveal(entry ? model.hardwareOps(run).indexOf(entry) : -1);
    instructionList.render();
    // An OpenQASM origin names a source line.
    const line = /^OpenQASM line (\d+)$/.exec(entry?.op.source ?? "")?.[1];
    for (const span of $("sourceText").children) span.classList.toggle("current", span.dataset.line === line);
    const current = $("sourceText").querySelector(".current");
    if (current) $("sourceText").scrollTop = Math.max(0, current.offsetTop - $("sourceText").clientHeight / 2);
  }
  scene.show(frame, state, frame ? model.causalPath(run, frame.id) : [], chosen, fault);
  paintInspector(frame, fault);
  timeline.show(state.atBatch, frame?.part, chosen);
  paintPlatform();
  // Transport.
  $("counter").textContent = count(index + 1) + " / " + count(total);
  $("step").value = index + 1;
  $("back").disabled = index < 0;
  $("next").disabled = index >= total - 1;
  $("play").disabled = total === 0;
  $("prevPulse").disabled = before(stopLists.pulse, index) < 0;
  $("nextPulse").disabled = after(stopLists.pulse, index) < 0;
  $("nextFault").disabled = after(stopLists.fault, index) < 0;
  $("nextInstruction").disabled = after(stopLists.instruction, index) < 0;
}

// ───────────────────────────── loading ─────────────────────────────

function check(bundle) {
  const whole = bundle?.kind === "riscq-run" && Array.isArray(bundle.frames) && Array.isArray(bundle.system?.parts) &&
    Array.isArray(bundle.machine?.cores) && Array.isArray(bundle.hardware?.segments) && Array.isArray(bundle.firmware) &&
    bundle.summary?.cores && bundle.initial;
  if (!whole) throw Error("This is not a RISC-Q run bundle (kind \"riscq-run\" with machine, hardware, firmware, system, initial, frames and summary).");
  return bundle;
}

function show(bundle, text, keepStep) {
  check(bundle);
  stop();
  run = bundle;
  runText = text;
  chosen = null;
  traceItems = null;
  lastTraceIndex = lastSource = null;
  platformKey = deviceKey = "";
  toneCanvas = null;
  $("platformView").replaceChildren();
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
  for (const id of ["step", "export", "play"]) $(id).disabled = false;
  scene.setSystem(run.system);
  timeline.setRun(run);
  traceList.setCount(run.frames.length);
  paintRun();
  paint();
}

/** The source of the run is a system-call program (JSON) and not OpenQASM. */
const isCalls = () => run?.source?.language === "FTQVM system calls";

/** Run a program on the server: `{ example }`, `{ platform, qasm }` or `{ platform, calls }`. Errors are shown as the server wrote them. */
async function load(next, keepStep = false, report = note) {
  const mine = ++token;
  const trace = $("fullTrace").checked ? "full" : undefined;
  $("runState").textContent = next.example ? "Running " + next.example + "…" : "Compiling and running…";
  $("runState").classList.remove("fault");
  try {
    let response;
    const query = new URLSearchParams(next.example ? { example: next.example } : {});
    if (next.example) {
      for (const [bit, value] of Object.entries(outcomes)) if (value) query.append("outcome", bit + "=" + value);
      if (trace) query.set("trace", trace);
      response = await fetch("/api/riscq/run?" + query);
    } else
      response = await fetch("/api/riscq/run", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: next.platform, ...(next.calls ? { calls: next.calls } : { qasm: next.qasm }), outcomes, ...(trace ? { trace } : {}) }) });
    const text = await response.text();
    if (mine !== token) return;
    if (!response.ok) throw Error(text);
    const bundle = check(JSON.parse(text));
    program = next;
    note("");
    report("");
    show(bundle, text, keepStep);
    $("example").value = next.example ?? "";
    // The address names a reference program and its inputs, so that a step can be shared.
    history.replaceState(null, "", location.pathname + (next.example ? "?" + query : ""));
  } catch (error) {
    if (mine !== token) return;
    report(error.message);
    if (run) paintStatus();
    else $("runState").textContent = "No run";
  }
}

$("bench").onchange = (e) => location.assign(e.target.value);
$("example").onchange = (e) => {
  outcomes = {};
  load({ example: e.target.value });
};
$("fullTrace").onchange = () => program && load(program, false);
$("resetView").onclick = () => scene.home();
$("timelineFit").onclick = () => timeline.whole();
$("back").onclick = () => jump(index - 1);
$("next").onclick = () => jump(index + 1);
$("step").oninput = (e) => jump(Number(e.target.value) - 1);
$("prevPulse").onclick = () => jump(before(stopLists.pulse, index));
$("nextPulse").onclick = () => jump(after(stopLists.pulse, index));
$("nextFault").onclick = () => jump(after(stopLists.fault, index));
$("nextInstruction").onclick = () => jump(after(stopLists.instruction, index));
$("play").onclick = () => {
  if (!run) return;
  if (playing) return stop();
  if (index >= run.frames.length - 1) index = -1;
  playing = true;
  playClock = performance.now();
  playCarry = 0;
  $("play").textContent = "Pause";
  requestAnimationFrame(function tick(now) {
    if (!playing) return;
    playCarry += ((now - playClock) / 1000) * Number($("speed").value);
    playClock = now;
    const steps = Math.floor(playCarry);
    playCarry -= steps;
    if (steps) jump(index + steps, true);
    if (index >= run.frames.length - 1) return stop();
    requestAnimationFrame(tick);
  });
};
$("export").onclick = () => {
  if (!run) return;
  // The bundle is saved as the server sent it.
  const url = URL.createObjectURL(new Blob([runText], { type: "application/json" }));
  const a = el("a", { href: url, download: "riscq-" + (run.example?.id ?? "custom") + ".json" });
  a.click();
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
    show(bundle, text, false);
    note("");
    $("example").value = "";
    history.replaceState(null, "", location.pathname);
  } catch (error) {
    note(error.message);
  }
};
const qasmError = (message) => {
  $("qasmError").textContent = message;
  $("qasmError").hidden = !message;
};
$("runQasm").onclick = () => {
  if (!run) return;
  if (!isCalls()) return load({ platform: run.platform, qasm: $("qasmText").value }, false, qasmError);
  let calls;
  try {
    calls = JSON.parse($("qasmText").value);
  } catch (error) {
    return qasmError("The system-call program is not valid JSON: " + error.message);
  }
  load({ platform: run.platform, calls }, false, qasmError);
};
$("resetQasm").onclick = () => {
  if (run) $("qasmText").value = run.source.text;
  qasmError("");
};
document.addEventListener("keydown", (e) => {
  if (!run || e.ctrlKey || e.metaKey || e.altKey || ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  const move = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: -1, End: run.frames.length - 1 }[e.key];
  if (move !== undefined) {
    e.preventDefault();
    jump(move);
  } else if (e.key === " " && e.target.tagName !== "BUTTON") {
    e.preventDefault();
    $("play").click();
  }
});

try {
  const response = await fetch("/api/riscq/examples");
  const text = await response.text();
  if (!response.ok) throw Error(text);
  examples = JSON.parse(text);
  $("example").replaceChildren(el("option", { value: "", text: "Custom or opened run", hidden: true }),
    ...examples.map((e) => el("option", { value: e.id, text: e.title + " · " + e.platform, title: e.description })));
  $("example").disabled = false;
  const query = new URLSearchParams(location.search);
  for (const item of query.getAll("outcome")) outcomes[item.split("=")[0]] = Number(item.split("=")[1]);
  $("fullTrace").checked = query.get("trace") === "full";
  if (query.has("step")) pendingStep = Number(query.get("step")) - 1;
  const wanted = examples.find((e) => e.id === query.get("example")) ?? examples[0];
  if (wanted) await load({ example: wanted.id });
  else $("runState").textContent = "No reference program";
} catch (error) {
  note(error.message);
  $("runState").textContent = "No run";
}
