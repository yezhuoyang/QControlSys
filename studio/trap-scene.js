import * as T from "three";
import { OrbitControls } from "/three/OrbitControls.js";
import { box, cylinder, group, surface, parts, createStage } from "./scene.js";

const gold = surface(0xcaa250, 0.5),
  dark = surface(0x203038),
  ceramic = surface(0x45445c);
const silver = surface(0xb7c7c9, 0.58),
  green = surface(0x347759);
const active = surface(0xffc95e, 0.32),
  held = surface(0x88754d, 0.35);
const ionMat = surface(0xabfff1),
  optical = surface(0xba8cff);
ionMat.emissive.setHex(0x178b80);
optical.emissive.setHex(0x493674);

function lead(parent, name, points, radius, material) {
  const curve = new T.CatmullRomCurve3(
    points.map(([x, y, z]) => new T.Vector3(x, y, z)),
  );
  const mesh = new T.Mesh(
    new T.TubeGeometry(curve, 28, radius, 8, false),
    material,
  );
  mesh.userData.part = name;
  parent.add(mesh);
  return mesh;
}

function controller(g) {
  box(g, 0, 1, 0, 64, 3, 48, green);
  box(g, -5, 4, 0, 26, 4, 26, dark);
  for (let x = -16; x <= 6; x += 3) box(g, x, 9, 0, 1.5, 7, 23, silver);
  for (const x of [-26, 26])
    for (const z of [-18, 18]) cylinder(g, x, 3, z, 2, 2, gold, 8);
  for (let i = 0; i < 8; i++) box(g, 17 + i, 3, 0, 0.7, 0.4, 22, gold);
  box(g, 28, 7, 7, 14, 8, 12, silver);
  box(g, 37, 7, 7, 7, 5, 8, green);
  for (let i = 0; i < 3; i++) box(g, -18 + i * 11, 4, 17, 9, 3, 5, dark);
}

function electronics(g, analog) {
  box(g, 0, 2, 0, 37, 4, 27, ceramic);
  box(g, 0, 6, 0, 23, 5, 17, analog ? silver : dark);
  for (let i = 0; i < 9; i++)
    for (const z of [-11, 11]) box(g, -14 + i * 3.5, 4.5, z, 1.5, 2.5, 4, gold);
}

function trap(g) {
  box(g, 0, 0, 0, 120, 4, 32, ceramic);
  box(g, 0, 2.6, 0, 117, 1.4, 26, dark);
  for (const z of [-3, 3]) box(g, 0, 3.5, z, 115, 0.8, 2.2, gold);
  const pads = [];
  for (let i = 0; i < 10; i++)
    for (const z of [-9, 9])
      pads.push(box(g, -51 + i * 11.4, 3.7, z, 10.4, 1.2, 7.8, gold));
  for (const x of [-36, 36]) {
    const dock = new T.Mesh(new T.TorusGeometry(4.2, 0.55, 6, 24), silver);
    dock.rotation.x = Math.PI / 2;
    dock.position.set(x, 4.3, 0);
    g.add(dock);
  }
  const ion = new T.Mesh(new T.SphereGeometry(2.6, 16, 12), ionMat);
  g.add(ion);
  const localSwitch = box(g, -57, 6.4, -8, 10, 4, 8, dark);
  return { g, ion, pads, localSwitch };
}

export function createTrapScene(host, onPick) {
  const { world, renderer, canvas } = createStage(
    host,
    "QCCD selector electronics, segmented surface electrodes and ion positions",
  );
  const root = new T.Group();
  world.add(root);
  const camera = new T.OrthographicCamera(-200, 200, 100, -100, 1, 4000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.minZoom = 0.4;
  controls.maxZoom = 5;
  const ray = new T.Raycaster(),
    anchors = document.querySelector("#labels");
  const objects = new Map(),
    labels = new Map(),
    lanes = new Map();
  let gatePulse = null,
    beam = null,
    frame = null,
    chosen = null,
    program = null,
    initial = null,
    down = null;
  const v = new T.Vector3();

  function resetGeometry() {
    const geometries = new Set();
    root.traverse((obj) => {
      if (obj.isMesh && obj.geometry.type !== "BoxGeometry")
        geometries.add(obj.geometry);
    });
    geometries.forEach((g) => g.dispose());
    root.clear();
    objects.clear();
    lanes.clear();
    for (const el of labels.values()) el.remove();
    labels.clear();
  }
  function tag(id) {
    const el = document.createElement("span");
    el.className = "annotation";
    anchors.append(el);
    labels.set(id, el);
  }
  function layoutLabels() {
    if (!program) return;
    const state = frame?.state || initial;
    for (const [id, el] of labels) {
      const obj = objects.get(id);
      obj.getWorldPosition(v);
      const lane = state.lanes.find((l) => "zone-" + l.id === id);
      v.y += lane ? 12 : 16;
      if (lane) v.z -= 12;
      v.project(camera);
      el.style.left = (v.x + 1) * 50 + "%";
      el.style.top = (1 - v.y) * 50 + "%";
      const focus = chosen || frame?.part || "controller";
      const instrument =
        host.clientWidth >= 700 &&
        ["laser", "optics", "selector", "dac"].includes(id);
      el.classList.toggle("active", id === focus);
      // Keep every lane identified and show the label of the currently inspected instrument.
      el.hidden =
        Math.abs(v.x) > 0.92 ||
        Math.abs(v.y) > 0.91 ||
        (!lane && id !== focus && id !== "controller" && !instrument);
      el.textContent = lane ? lane.id + " · " + lane.ionUm + " µm" : parts[id];
    }
  }
  function draw() {
    if (!program) return;
    renderer.render(world, camera);
    layoutLabels();
  }
  function resize() {
    const w = host.clientWidth,
      h = host.clientHeight;
    if (!w || !h) return;
    const depth = program ? Math.max(94, program.zones.length * 16 + 30) : 100;
    const half = Math.max(193, (depth * w) / h);
    camera.left = -half;
    camera.right = half;
    camera.top = (half * h) / w;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    draw();
  }
  function home() {
    controls.target.set(-5, 1, 0);
    camera.position.set(70, 290, 379);
    camera.zoom = 1;
    controls.update();
    resize();
  }
  function build(p, nodes, zero) {
    resetGeometry();
    program = p;
    initial = zero;
    frame = null;
    chosen = null;
    for (const node of nodes) {
      parts[node.id] = node.label;
      const g = group(root, node.id, node.x, 0, node.z);
      objects.set(node.id, g);
      tag(node.id);
      if (node.id === "controller") controller(g);
      else if (node.id === "selector" || node.id === "dac")
        electronics(g, node.id === "dac");
      else if (node.id === "laser") {
        box(g, 0, 2, 0, 37, 4, 20, dark);
        box(g, 0, 7, 0, 28, 8, 15, silver);
        box(g, 16, 7, 0, 6, 5, 6, optical);
      } else if (node.id === "optics") {
        cylinder(g, 0, 3, 0, 9, 5, silver);
        cylinder(g, 0, 18, 0, 3.2, 25, silver);
        box(g, -5, 31, 0, 18, 6, 9, dark);
        cylinder(g, -12, 27, 0, 4, 5, optical);
      } else if (node.id.startsWith("zone-"))
        lanes.set(node.id.slice(5), trap(g));
    }
    // All wiring endpoints use emitted assembly positions. Hold bias has its own local strap.
    const at = (id, x, y, z) => {
      const o = objects.get(id).position;
      return [o.x + x, o.y + y, o.z + z];
    };
    lead(
      root,
      "fiber",
      [
        at("controller", 40, 7, 7),
        at("fiber", 0, 4, 10),
        at("selector", -17, 5, 0),
      ],
      1.8,
      surface(0x5cc9bd),
    );
    lead(
      root,
      "selector",
      [at("selector", 6, 3, 13), at("dac", 6, 3, -22), at("dac", 6, 3, -13)],
      1.2,
      silver,
    );
    const gateCable = lead(
      root,
      "optical-fiber",
      [
        at("laser", 19, 7, 0),
        at("optical-fiber", 0, 5, 0),
        at("optics", 0, 20, -14),
        at("optics", 0, 30, 0),
      ],
      1.2,
      surface(0x967eb7),
    );
    // Each side of a tube segment uses two triangles, or six indices.
    gatePulse = new T.Mesh(
      new T.TubeGeometry(
        gateCable.geometry.parameters.path,
        100,
        1.55,
        8,
        false,
      ),
      optical,
    );
    gatePulse.userData.part = "optical-fiber";
    root.add(gatePulse);
    lead(
      root,
      "laser",
      [
        at("controller", 10, 3, -22),
        at("laser", -27, 2, 2),
        at("laser", -15, 5, 2),
      ],
      0.75,
      silver,
    );
    p.zones.forEach((z, i) => {
      const id = "zone-" + z.id,
        zz = objects.get(id).position.z;
      lead(
        root,
        id,
        [
          at("selector", 16, 4, i - 2),
          [-18 - i * 2, 1, -40],
          [-2 - i, 2, zz - 12],
          [14, 6, zz - 8],
        ],
        0.72,
        surface(0x72a1a2),
      );
      if (z.wired)
        lead(
          root,
          id,
          [
            at("dac", 16, 4, i - 2),
            [-20 + i * 2, 2, 20],
            [-10 + i * 2, 2, zz],
            [12, 3, zz],
          ],
          1.1,
          gold,
        );
      else {
        const g = objects.get(id);
        box(g, -59, 4, 7, 9, 3, 3, silver);
        box(g, -62, 3.5, 3, 2, 2, 8, silver);
      }
    });
    const opticalTarget = "zone-" + p.gateZone;
    beam = lead(
      root,
      "optics",
      [at("optics", -12, 25, 0), at(opticalTarget, 36, 8, 0)],
      1.35,
      optical,
    );
    beam.visible = false;
    root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    home();
  }
  function display(f, selection) {
    frame = f;
    chosen = selection;
    const s = f?.state || initial;
    if (!s) return;
    for (const l of s.lanes) {
      const lane = lanes.get(l.id);
      lane.ion.position.set(-36 + (72 * l.ionUm) / program.travelUm, 8, 0);
      const mat = l.wired && l.latched ? (s.busMv ? active : gold) : held;
      lane.pads.forEach((p) => (p.material = mat));
      lane.localSwitch.material = l.latched ? surface(0x66a99c) : dark;
      lane.ion.material = s.lightOn && s.exposedIon === l.id ? optical : ionMat;
    }
    const head = Math.ceil((f?.opticalHeadPermille ?? 0) / 10);
    const tail = Math.floor((f?.opticalTailPermille ?? 0) / 10);
    const ringIndices = 8 * 6;
    gatePulse.geometry.setDrawRange(
      tail * ringIndices,
      (head - tail) * ringIndices,
    );
    gatePulse.visible = head > tail;
    beam.visible = s.lightOn;
    draw();
  }
  controls.addEventListener("change", draw);
  new ResizeObserver(resize).observe(host);
  canvas.addEventListener("pointerdown", (e) => {
    down = [e.clientX, e.clientY];
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5)
      return;
    down = null;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new T.Vector2(
        ((e.clientX - r.left) * 2) / r.width - 1,
        1 - ((e.clientY - r.top) * 2) / r.height,
      ),
      camera,
    );
    for (const hit of ray.intersectObjects(root.children, true)) {
      let o = hit.object;
      if (!o.visible) continue;
      while (o && !o.userData.part) o = o.parent;
      if (o) {
        onPick(o.userData.part);
        break;
      }
    }
  });
  return { setProgram: build, setFrame: display, home };
}
