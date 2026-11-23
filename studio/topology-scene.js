import * as T from "three";
import { OrbitControls } from "/three/OrbitControls.js";
import { createStage, box, surface } from "./scene.js";

const substrate = surface(0x404862, 0.3),
  die = surface(0x293d4b, 0.2);
const siteMetal = surface(0xb5995d, 0.52),
  gateMetal = surface(0xb096ca, 0.44);
const rail = surface(0x9b8467, 0.4),
  routed = surface(0xffc864, 0.25);
const cold = surface(0x76e4d4, 0.12),
  engaged = surface(0xfce0a0, 0.15);
const selected = surface(0xf1ffed, 0.14);
cold.emissive.setHex(0x14635a);
routed.emissive.setHex(0x794511);
const bead = new T.SphereGeometry(1, 12, 8);

// Studio's floor plan uses x/y with optional elevation z. Three's vertical axis is y.
export function createTopologyScene(host, onPick) {
  const { world, renderer, canvas } = createStage(
    host,
    "QCCD Studio trap sites, transport electrodes and ion occupancy",
  );
  const root = new T.Group();
  world.add(root);
  const camera = new T.OrthographicCamera(-200, 200, 115, -115, 0.1, 4000);
  const controls = new OrbitControls(camera, canvas);
  controls.minZoom = 0.35;
  controls.maxZoom = 25;
  controls.maxPolarAngle = Math.PI * 0.49;
  const ray = new T.Raycaster(),
    ndc = new T.Vector2(),
    vec = new T.Vector3();
  const sites = new Map(),
    segments = new Map(),
    ions = new Map();
  const labelLayer = host.querySelector("#labels");
  let model,
    selection,
    current,
    pinLabels = [],
    cameraTarget = new T.Vector3(),
    fitWidth = 155,
    fitHeight = 55,
    radius = 2;

  function render() {
    renderer.render(world, camera);
    const tagIds = new Set();
    if (host.clientWidth > 520) for (const id of pinLabels) tagIds.add(id);
    const moving = current?.moves?.length === 1 ? current.moves[0] : null;
    const focused =
      selection?.kind === "site"
        ? selection.id
        : (moving?.to ?? current?.targets?.[0]);
    if (focused) tagIds.add(focused);
    labelLayer.replaceChildren();
    const seen = [];
    for (const id of [...tagIds].reverse()) {
      const site = sites.get(id);
      if (!site) continue;
      vec.copy(site.point);
      vec.y += radius * 3.6;
      vec.project(camera);
      const x = ((vec.x + 1) * host.clientWidth) / 2;
      const y = ((1 - vec.y) * host.clientHeight) / 2;
      if (
        x < 26 ||
        x > host.clientWidth - 26 ||
        y < 52 ||
        y > host.clientHeight - 40 ||
        seen.some((p) => Math.abs(x - p[0]) < 55 && Math.abs(y - p[1]) < 23)
      )
        continue;
      const label = document.createElement("span");
      label.className = "annotation" + (id === focused ? " active" : "");
      label.textContent =
        id === focused && moving?.to === id ? moving.ion + " · " + id : id;
      label.style.left = x + "px";
      label.style.top = y + "px";
      labelLayer.append(label);
      seen.push([x, y]);
    }
  }
  function resize() {
    const w = Math.max(1, host.clientWidth),
      h = Math.max(1, host.clientHeight);
    const half = Math.max(fitWidth, (fitHeight * w) / h);
    camera.left = -half;
    camera.right = half;
    camera.top = (half * h) / w;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    render();
  }
  function home() {
    camera.zoom = 1;
    controls.target.copy(cameraTarget);
    camera.position.copy(cameraTarget).add(new T.Vector3(28, 212, 240));
    controls.update();
    resize();
  }
  function setMachine(machine) {
    model = machine;
    selection = current = null;
    root.clear();
    sites.clear();
    segments.clear();
    ions.clear();
    pinLabels = [];
    if (!machine.nodes.length) {
      home();
      return;
    }
    const bounds = new T.Box3();
    for (const n of machine.nodes)
      bounds.expandByPoint(new T.Vector3(n.pos[0], n.pos[2], -n.pos[1]));
    const span = bounds.getSize(new T.Vector3()),
      center = bounds.getCenter(new T.Vector3());
    const scale = 245 / Math.max(span.x, span.y, span.z, 1);
    for (const n of machine.nodes) {
      const point = new T.Vector3(
        n.pos[0] - center.x,
        n.pos[2] - bounds.min.y,
        -n.pos[1] - center.z,
      ).multiplyScalar(scale);
      point.y += 7;
      sites.set(n.id, {
        node: n,
        point,
        pads: [],
        nearest: Infinity,
        tangent: null,
      });
    }
    const distances = machine.segments
      .map((e) =>
        sites
          .get(e.a)
          ?.point.distanceTo(sites.get(e.b)?.point ?? new T.Vector3()),
      )
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    radius = Math.max(
      0.65,
      Math.min(4.5, (distances[Math.floor(distances.length / 4)] || 15) * 0.26),
    );
    const margin = Math.max(10, radius * 3.3);
    const w = Math.max(span.x * scale + 2 * margin, 40),
      d = Math.max(span.z * scale + 2 * margin, 35);
    box(root, 0, 0, 0, w + 12, 4, d + 12, substrate);
    box(root, 0, 3, 0, w, 2, d, die);
    // Contact fingers around the illustrative chip carrier are display geometry.
    for (let x = -w / 2 + 5; x < w / 2; x += 6)
      for (const z of [-1, 1])
        box(root, x, 2.1, z * (d / 2 + 2.2), 3.7, 0.45, 4.6, siteMetal);
    for (const edge of machine.segments) {
      const a = sites.get(edge.a),
        b = sites.get(edge.b);
      if (!a || !b) continue;
      const middle = a.point.clone().lerp(b.point, 0.5);
      const length = a.point.distanceTo(b.point);
      if (!length) continue;
      const direction = b.point.clone().sub(a.point).normalize();
      for (const site of [a, b])
        if (length < site.nearest) {
          site.nearest = length;
          site.tangent = direction;
        }
      const path = box(
        root,
        middle.x,
        middle.y,
        middle.z,
        radius * 0.9,
        radius * 0.42,
        length,
        rail,
      );
      path.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), direction);
      segments.set(edge.id, path);
    }
    for (const {
      node: n,
      point: p,
      pads,
      tangent,
      nearest,
    } of sites.values()) {
      const mat = n.gate ? gateMetal : siteMetal;
      const angle = tangent ? Math.atan2(-tangent.z, tangent.x) : 0;
      const along = Math.min(nearest * 0.74, radius * (n.gate ? 5.4 : 3.3));
      for (const shift of [-1.1, 1.1]) {
        const pad = box(
          root,
          p.x + Math.sin(angle) * shift * radius,
          p.y + 0.18,
          p.z + Math.cos(angle) * shift * radius,
          along,
          radius * 0.64,
          radius * (n.gate ? 1.7 : 1.25),
          mat,
        );
        pad.rotation.y = angle;
        pad.userData.pick = { kind: "site", id: n.id };
        pads.push(pad);
      }
    }
    const gates = machine.nodes.filter((n) => n.gate);
    pinLabels = gates
      .filter((_, i) => i % Math.max(1, Math.ceil(gates.length / 4)) === 0)
      .slice(0, 4)
      .map((n) => n.id);
    cameraTarget.set(0, span.y * scale * 0.5 + 5, 0);
    fitWidth = (w + 0.12 * d + 16) * 0.54;
    fitHeight = (0.1 * w + 0.68 * d + 0.78 * span.y * scale + 24) * 0.63;
    home();
  }
  function show(frame, positions, chosen) {
    if (!model) return;
    current = frame;
    selection = chosen;
    const active = new Set(frame?.ions),
      targets = new Set(frame?.targets);
    const route = new Set((frame?.moves || []).flatMap((m) => m.via));
    for (const [id, path] of segments)
      path.material = route.has(id) ? routed : rail;
    for (const [id, s] of sites) {
      const mat =
        chosen?.kind === "site" && chosen.id === id
          ? selected
          : targets.has(id)
            ? routed
            : s.node.gate
              ? gateMetal
              : siteMetal;
      s.pads.forEach((pad) => (pad.material = mat));
    }
    const occupancy = new Map();
    for (const [id, site] of positions) {
      if (!occupancy.has(site)) occupancy.set(site, []);
      occupancy.get(site).push(id);
    }
    for (const [id, sphere] of ions) sphere.visible = positions.has(id);
    for (const [site, group] of occupancy) {
      const s = sites.get(site);
      if (!s) continue;
      group.sort();
      group.forEach((id, i) => {
        let sphere = ions.get(id);
        if (!sphere) {
          sphere = new T.Mesh(bead, cold);
          sphere.userData.pick = { kind: "ion", id };
          root.add(sphere);
          ions.set(id, sphere);
        }
        sphere.visible = true;
        sphere.material =
          chosen?.kind === "ion" && chosen.id === id
            ? selected
            : active.has(id)
              ? engaged
              : cold;
        sphere.scale.setScalar(radius * 0.8);
        sphere.position.copy(s.point);
        sphere.position.y += radius * (1.85 + Math.floor(i / 4) * 1.7);
        sphere.position.x +=
          radius *
          1.5 *
          ((i % 4) -
            (Math.min(group.length - 4 * Math.floor(i / 4), 4) - 1) / 2);
      });
    }
    render();
  }
  let down;
  canvas.addEventListener("pointerdown", (e) => {
    down = [e.clientX, e.clientY];
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5)
      return;
    const r = canvas.getBoundingClientRect();
    ndc.set(
      (2 * (e.clientX - r.left)) / r.width - 1,
      1 - (2 * (e.clientY - r.top)) / r.height,
    );
    ray.setFromCamera(ndc, camera);
    const pick = ray
      .intersectObjects(root.children, false)
      .find((h) => h.object.visible && h.object.userData.pick)?.object
      .userData.pick;
    if (pick) onPick(pick);
  });
  controls.addEventListener("change", render);
  new ResizeObserver(resize).observe(host);
  home();
  return { setMachine, show, home };
}
