import * as T from "three";
import { OrbitControls } from "/three/OrbitControls.js";
import { box, cylinder, group, surface, parts, createStage } from "./scene.js";

const metal = surface(0xbbc4c4, 0.48);
const dark = surface(0x303e43);
const pcb = surface(0x32664d);
const brass = surface(0xcba863, 0.42);
const xTone = surface(0x63bdb1);
const yTone = surface(0xd4a557);
const light = surface(0xb799e2);
const atomSurface = surface(0xe6fff4);
const active = surface(0x8af2bd);
const planeSurface = surface(0x243840);
const etched = surface(0x51666b);
const idle = surface(0x425653);
const antennaHeight = 12;

function rod(parent, start, end, radius, mat) {
  const from = new T.Vector3(...start),
    to = new T.Vector3(...end);
  const delta = to.sub(from);
  const mesh = cylinder(parent, 0, 0, 0, radius, delta.length(), mat, 8);
  mesh.position.copy(from).addScaledVector(delta, 0.5);
  mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), delta.normalize());
  return mesh;
}

function ring(parent, radius, width, mat) {
  const mesh = new T.Mesh(new T.TorusGeometry(radius, width, 6, 24), mat);
  mesh.rotation.x = -Math.PI / 2;
  parent.add(mesh);
  return mesh;
}

function controller(g) {
  box(g, 0, 3, 0, 40, 2, 31, pcb);
  for (const x of [-16, 16])
    for (const z of [-12, 12]) cylinder(g, x, 2, z, 1.5, 5, brass, 8);
  box(g, -4, 5, -2, 17, 2, 16, dark);
  for (let x = -11; x < 4; x += 2.7) box(g, x, 8, -2, 1.3, 5, 14, metal);
  for (const x of [-8, 1, 10]) box(g, x, 5, 9, 6, 2, 4, dark);
  box(g, 16, 7, -5, 9, 6, 9, metal);
  return box(g, -15, 4.8, 7, 2.7, 1.2, 2.7, idle);
}

function driver(g, p) {
  box(g, 0, 2, 0, 32, 4, 27, dark);
  box(g, 0, 5, 0, 29, 2, 24, pcb);
  const banks = {};
  for (const [axis, tones, shift, mat] of [
    ["X", p.columnsKHz, -7, xTone],
    ["Y", p.rowsKHz, 7, yTone],
  ]) {
    box(g, shift, 7, 1, 10, 2.5, 13, dark);
    rod(g, [shift, 7, -11], [shift, 7, -15], 2.7, brass);
    banks[axis] = tones.map((_, i) =>
      box(
        g,
        shift - (tones.length - 1) * 1.1 + i * 2.2,
        9,
        1,
        1.3,
        1.2,
        1,
        mat,
      ),
    );
  }
  return banks;
}

function deflector(g, mat, orthogonal) {
  box(g, 0, 1.5, 0, 23, 3, 19, metal);
  for (const x of [-9, 9])
    for (const z of [-7, 7]) {
      cylinder(g, x, 3.4, z, 1.05, 0.9, dark, 8);
      box(g, x, 3.9, z, 1.3, 0.2, 0.28, metal);
    }
  box(g, 0, 6, 0, 16, 6, 14, dark);
  // Two AOD crystals have perpendicular acoustic axes in the beam cross-section.
  const cell = group(g, null, 0, antennaHeight, 0);
  if (orthogonal) cell.rotation.x = Math.PI / 2;
  box(cell, 0, 0, 0, 12, 9, 10, metal);
  box(cell, 0, 6, 0, 12, 3, 10, mat);
  for (const x of [-4.5, 4.5]) {
    cylinder(cell, x, 7.8, -3.5, 0.65, 0.65, dark, 8);
    cylinder(cell, x, 7.8, 3.5, 0.65, 0.65, dark, 8);
  }
  rod(cell, [0, 6.2, 3.5], [0, 6.2, 6], 1.6, brass);
  for (const x of [-6.2, 6.2]) {
    rod(cell, [x - 0.4, 0, 0], [x + 0.4, 0, 0], 3.6, dark);
    rod(cell, [x - 0.5, 0, 0], [x + 0.5, 0, 0], 2.4, light);
  }
}

// Use one magnification for X and Y, fixed at program load. Rewinding or stepping
// never rescales or recentres the array, including for negative sample coordinates.
function arrayScale(p) {
  function bounds(axis, tones) {
    const targets = p.moves
      .filter((m) => m.axis === axis)
      .map((m) => m.targetKHz);
    const khz = [...tones, ...targets];
    const min = Math.min(...khz),
      max = Math.max(...khz);
    const middleNm = ((min + max) / 2 - p.referenceKHz) * p.nmPerKHz;
    return { min, max, middleNm, rangeNm: (max - min) * p.nmPerKHz };
  }
  const x = bounds("x", p.columnsKHz),
    y = bounds("y", p.rowsKHz);
  const unitsPerNm = 58 / Math.max(1, x.rangeNm, y.rangeNm);
  return { x, y, unitsPerNm };
}

function sample(g, initial, scale) {
  // The entry lens belongs to the array assembly. Its large square field is
  // a magnified view of the focal plane, with the hardware axes marked on its edges.
  box(g, 0, 3, 0, 82, 6, 82, metal);
  box(g, 0, 6, 0, 78, 2, 78, planeSurface);
  for (const x of [-36, 36])
    for (const z of [-36, 36]) cylinder(g, x, 7.2, z, 1.2, 0.5, metal);
  box(g, 0, 7.2, 34, 65, 0.4, 0.65, xTone);
  box(g, -34, 7.2, 0, 0.65, 0.4, 65, yTone);
  // Choose a 1/2/5 scale bar, sized in nanometres in the same coordinate frame as the sites.
  const desiredNm = 21 / scale.unitsPerNm;
  const power = 10 ** Math.floor(Math.log10(desiredNm));
  const barNm = [5, 2, 1].find((n) => n <= desiredNm / power) * power;
  const length = barNm * scale.unitsPerNm;
  box(g, 31 - length / 2, 7.3, 37, length, 0.3, 0.55, atomSurface);
  for (const x of [31 - length, 31])
    box(g, x, 7.3, 37, 0.55, 0.3, 2, atomSurface);
  const guides = {
    X: initial.deliveredXKHz.map(() =>
      box(g, 0, 7.15, 0, 0.28, 0.22, 64, etched),
    ),
    Y: initial.deliveredYKHz.map(() =>
      box(g, 0, 7.15, 0, 64, 0.22, 0.28, etched),
    ),
  };
  const sites = new Map();
  const trapGeometry = new T.TorusGeometry(1, 0.19, 6, 22);
  for (const t of initial.traps) {
    const mesh = new T.Mesh(trapGeometry, light);
    mesh.rotation.x = -Math.PI / 2;
    mesh.userData.site = t.id;
    sites.set(t.id, mesh);
    g.add(mesh);
  }
  const atoms = new Map();
  if (initial.atoms.length) {
    const atomGeometry = new T.SphereGeometry(0.67, 12, 8);
    for (const a of initial.atoms) {
      const mesh = new T.Mesh(atomGeometry, atomSurface);
      mesh.userData.site = "trap-" + a.column + "-" + a.row;
      g.add(mesh);
      atoms.set(a.id, mesh);
    }
  }
  return { guides, sites, atoms, scale, barNm };
}

function updateSample(view, s, f, p) {
  const { scale, guides, sites, atoms } = view;
  const localX = (nm) => (nm - scale.x.middleNm) * scale.unitsPerNm;
  const localZ = (nm) => -(nm - scale.y.middleNm) * scale.unitsPerNm;
  const arriving = f?.op === "deliver";
  let radius = 3;
  for (const axis of ["X", "Y"]) {
    const axisTones = s["delivered" + axis + "KHz"];
    axisTones.forEach((khz, tone) => {
      const nm = (khz - p.referenceKHz) * p.nmPerKHz;
      const guide = guides[axis][tone];
      if (axis === "X") guide.position.x = localX(nm);
      else guide.position.z = localZ(nm);
      guide.material =
        arriving && axis.toLowerCase() === f.axis && tone === f.tone
          ? axis === "X"
            ? xTone
            : yTone
          : etched;
      if (tone)
        radius = Math.min(
          radius,
          0.32 * (khz - axisTones[tone - 1]) * p.nmPerKHz * scale.unitsPerNm,
        );
    });
  }
  for (const t of s.traps) {
    const mesh = sites.get(t.id);
    mesh.position.set(localX(t.xNm), 7.65, localZ(t.yNm));
    mesh.scale.setScalar(radius);
    const matched = arriving && (f.axis === "x" ? t.column : t.row) === f.tone;
    mesh.material = matched ? (f.axis === "x" ? xTone : yTone) : light;
  }
  for (const a of s.atoms) {
    const mesh = atoms.get(a.id);
    mesh.position.set(localX(a.xNm), 7.7 + radius * 0.58, localZ(a.yNm));
    mesh.scale.setScalar(radius);
  }
}

export function createAtomScene(host, onPick) {
  const { world, renderer, canvas } = createStage(
    host,
    "Neutral-atom controller and RF driver with orthogonal AODs and magnified tweezer intersections. Rings show traps and filled spheres show atoms.",
  );
  const camera = new T.OrthographicCamera(-155, 155, 95, -95, 1, 4000);
  const controls = new OrbitControls(camera, canvas);
  controls.maxPolarAngle = Math.PI * 0.45;
  controls.minZoom = 0.45;
  controls.maxZoom = 10;
  const root = new T.Group();
  world.add(root);
  const assemblies = new Map(),
    labels = new Map();
  const anchors = host.querySelector("#labels");
  const ray = new T.Raycaster();
  let program,
    initial,
    array,
    banks,
    commandLamp,
    focusRing,
    frame,
    selection,
    siteId,
    down;
  const center = new T.Vector3();
  let width = 315,
    depth = 155;

  function clear() {
    const geometries = new Set();
    root.traverse((o) => {
      if (o.isMesh && o.geometry.type !== "BoxGeometry")
        geometries.add(o.geometry);
    });
    geometries.forEach((geometry) => geometry.dispose());
    root.clear();
    assemblies.clear();
    labels.forEach((el) => el.remove());
    labels.clear();
  }
  function point(id, x, y, z) {
    return assemblies
      .get(id)
      .position.clone()
      .add(new T.Vector3(x, y, z));
  }
  function cable(id, points, radius, mat) {
    const curve = new T.CatmullRomCurve3(points);
    const mesh = new T.Mesh(
      new T.TubeGeometry(curve, 18, radius, 7, false),
      mat,
    );
    mesh.userData.part = id;
    root.add(mesh);
  }
  function labelText(id, state) {
    if (id === "array") {
      const site = state.traps.find((t) => t.id === siteId);
      if (site && selection === "array")
        return (
          "X" +
          site.column +
          " × Y" +
          site.row +
          " · " +
          (site.atom === null ? "empty" : site.atom) +
          " · (" +
          site.xNm / 1000 +
          ", " +
          site.yNm / 1000 +
          ") µm"
        );
      const bar =
        array.barNm < 1000
          ? Number(array.barNm.toPrecision(2)) + " nm"
          : array.barNm / 1000 + " µm";
      return (
        "Trap plane · " +
        state.atoms.length +
        "/" +
        state.traps.length +
        " filled · bar " +
        bar
      );
    }
    if (frame?.frequencyKHz != null && frame.part === id)
      return (
        parts[id] +
        " · " +
        frame.axis.toUpperCase() +
        frame.tone +
        " " +
        frame.frequencyKHz +
        " kHz"
      );
    return parts[id];
  }
  function draw() {
    if (!array || !root.children.length) return;
    const state = frame?.state || initial;
    const focus = selection || frame?.part || "controller";
    focusRing.position.copy(assemblies.get(focus).position);
    focusRing.position.y = focus === "array" ? 7.2 : 1;
    focusRing.scale.setScalar(
      focus === "array"
        ? 44
        : focus === "controller"
          ? 23
          : focus === "dds"
            ? 20
            : 15,
    );
    if (focus === "array" && siteId) {
      const site = array.sites.get(siteId);
      site.getWorldPosition(focusRing.position);
      focusRing.scale.setScalar(site.scale.x * 1.55);
    }
    renderer.render(world, camera);
    const labelPositions = [];
    const siteSelected = siteId && selection === "array";
    for (const id of new Set([
      focus,
      "array",
      "aod-x",
      "aod-y",
      "controller",
      "dds",
    ])) {
      const el = labels.get(id);
      const v = point(
        id,
        0,
        id === "array" ? 17 : id === "aod-y" ? 40 : 20,
        id === "array" ? -34 : -2,
      );
      if (id === "array" && siteSelected) {
        array.sites.get(siteId).getWorldPosition(v);
        v.y += 8;
      }
      v.project(camera);
      const anchorX = ((v.x + 1) * host.clientWidth) / 2;
      const y = ((1 - v.y) * host.clientHeight) / 2;
      el.textContent = labelText(id, state);
      el.classList.toggle("active", id === focus);
      el.hidden = false;
      const half = el.offsetWidth / 2;
      const x = Math.max(
        half + 4,
        Math.min(host.clientWidth - 4 - half, anchorX),
      );
      const left = x - half,
        right = x + half;
      el.hidden =
        Math.abs(v.x) > 1 ||
        y < 45 ||
        y > host.clientHeight - 33 ||
        labelPositions.some(
          (r) =>
            left < r.right + 5 && right > r.left - 5 && Math.abs(r.y - y) < 28,
        );
      if (!el.hidden) {
        el.style.left = x + "px";
        el.style.top = y + "px";
        labelPositions.push({ left, right, y });
      }
    }
  }
  function resize() {
    const w = host.clientWidth,
      h = host.clientHeight;
    if (!w || !h) return;
    const half = Math.max(width / 2, ((depth / 2) * w) / h);
    camera.left = -half;
    camera.right = half;
    camera.top = (half * h) / w;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    draw();
  }
  function home() {
    controls.target.copy(center);
    camera.position.copy(center).add(new T.Vector3(23, 334, 352));
    camera.zoom = 1;
    controls.update();
    resize();
  }
  function setFrame(next, chosen) {
    frame = next;
    selection = chosen;
    if (chosen !== "array") siteId = null;
    const s = frame?.state || initial;
    updateSample(array, s, frame, program);
    commandLamp.material = s.issued ? active : idle;
    for (const axis of ["X", "Y"]) {
      const bounds = array.scale[axis.toLowerCase()];
      s["rf" + axis + "KHz"].forEach((khz, tone) => {
        const normalized = (khz - bounds.min) / (bounds.max - bounds.min || 1);
        const bar = banks[axis][tone];
        bar.scale.z = 2 + 8 * normalized;
        bar.position.z = 5 - bar.scale.z / 2;
      });
    }
    draw();
  }
  function setProgram(p, nodes, zero) {
    clear();
    program = p;
    initial = zero;
    selection = frame = siteId = null;
    for (const n of nodes) {
      parts[n.id] = n.label;
      const g = group(root, n.id, n.x, 0, n.z);
      assemblies.set(n.id, g);
      const el = document.createElement("span");
      el.className = "annotation";
      anchors.append(el);
      labels.set(n.id, el);
      if (n.id === "controller") commandLamp = controller(g);
      else if (n.id === "dds") banks = driver(g, p);
      else if (n.id === "aod-x" || n.id === "aod-y")
        deflector(g, n.id === "aod-x" ? xTone : yTone, n.id === "aod-y");
      else if (n.id === "array") array = sample(g, zero, arrayScale(p));
    }

    cable(
      "dds",
      [
        point("controller", 20, 7, -5),
        point("dds", -20, 6, -7),
        point("dds", -15, 5, -3),
      ],
      1.1,
      metal,
    );
    for (const [axis, dx, mat] of [
      ["x", -7, xTone],
      ["y", 7, yTone],
    ]) {
      const id = "aod-" + axis;
      cable(
        id,
        [
          point("dds", dx, 7, -15),
          point("dds", dx, 4, -23),
          point(id, -2, 3, 18),
          point(
            id,
            0,
            antennaHeight + (axis === "x" ? 6 : 0),
            axis === "x" ? 3 : 6,
          ),
        ],
        1.15,
        mat,
      );
    }
    // The collimated input and relay exit lie on the real-space optical axis.
    // Only the sample field receives the nm-to-display magnification above.
    const opticalSegments = [
      [
        "aod-x",
        point("aod-x", -27, antennaHeight, 0),
        point("aod-x", -6, antennaHeight, 0),
      ],
      [
        "aod-y",
        point("aod-x", 6, antennaHeight, 0),
        point("aod-y", -6, antennaHeight, 0),
      ],
    ];
    const aperture = point("array", -52, antennaHeight, 0);
    aperture.z = assemblies.get("aod-y").position.z;
    opticalSegments.push([
      "array",
      point("aod-y", 6, antennaHeight, 0),
      aperture,
    ]);
    for (const [part, a, b] of opticalSegments)
      rod(root, a.toArray(), b.toArray(), 0.68, light).userData.part = part;
    const lens = group(root, "array", aperture.x, aperture.y, aperture.z);
    rod(lens, [0, 0, 0], [12, 0, 0], 4.3, dark);
    for (const x of [1, 3.3, 8.5, 10.8])
      rod(lens, [x, 0, 0], [x + 0.7, 0, 0], 4.8, metal);
    rod(lens, [-0.35, 0, 0], [0, 0, 0], 3.3, light);
    box(lens, 8, -6, 0, 5, 7, 4, metal);
    box(lens, 8, -10.5, 0, 11, 2, 10, dark);
    focusRing = ring(root, 1, 0.034, active);
    focusRing.raycast = () => {};
    root.traverse((obj) => {
      if (obj.isMesh) obj.receiveShadow = true;
    });
    const bounds = new T.Box3().setFromObject(root);
    bounds.getCenter(center);
    const size = bounds.getSize(new T.Vector3());
    width = size.x + 30;
    depth = Math.max(138, size.z + 40);
    setFrame(null, null);
    home();
  }
  canvas.addEventListener("pointerdown", (e) => {
    down = [e.clientX, e.clientY];
  });
  canvas.addEventListener("pointercancel", () => {
    down = null;
  });
  canvas.addEventListener("pointerup", (e) => {
    const click =
      down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) <= 5;
    down = null;
    if (!click || !array) return;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new T.Vector2(
        ((e.clientX - r.left) * 2) / r.width - 1,
        1 - ((e.clientY - r.top) * 2) / r.height,
      ),
      camera,
    );
    for (const hit of ray.intersectObjects(root.children, true)) {
      const { object } = hit;
      let g = object;
      while (g && !g.userData.part) g = g.parent;
      if (g) {
        siteId = object.userData.site ?? null;
        // Picking the open centre of an empty ring hits the focal plane itself.
        if (g.userData.part === "array" && !siteId) {
          const projected = assemblies
            .get("array")
            .worldToLocal(hit.point.clone());
          for (const [id, mesh] of array.sites)
            if (
              Math.hypot(
                projected.x - mesh.position.x,
                projected.z - mesh.position.z,
              ) <=
              mesh.scale.x * 1.2
            ) {
              siteId = id;
              break;
            }
        }
        onPick(g.userData.part);
        break;
      }
    }
  });
  controls.addEventListener("change", draw);
  new ResizeObserver(resize).observe(host);
  return { setProgram, setFrame, home };
}
