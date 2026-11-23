import * as T from "three";

// World lengths and component-local lengths are millimetres throughout. Small meshes
// use local coordinates so a Float32 vertex never has to encode bench and trap scales at once.
const nmToMm = 1e-6;
const up = new T.Vector3(0, 1, 0);
const alongBeam = new T.Vector3(1, 0, 0);
const unitBox = new T.BoxGeometry();
const unitDrum = new T.CylinderGeometry(1, 1, 1, 20);
const openDrum = new T.CylinderGeometry(1, 1, 1, 16, 1, true);
function finish(color, metalness = 0.24) {
  return new T.MeshStandardMaterial({ color, metalness, roughness: 0.52 });
}
const steel = finish(0xb9c5c8, 0.58);
const black = finish(0x333e43);
const holeColor = black.clone();
holeColor.polygonOffset = true;
holeColor.polygonOffsetFactor = -1;
holeColor.polygonOffsetUnits = -1;
const pcb = finish(0x287352);
const wire = finish(0x596775);
const contact = finish(0xc8a45d, 0.45);
const glass = finish(0x80c4cf);
const windowGlass = glass.clone();
windowGlass.transparent = true;
windowGlass.opacity = 0.24;
windowGlass.depthWrite = false;
const xCoax = finish(0x499f98);
const yCoax = finish(0xd1a150);
const beam = finish(0xb789d7);
const occupied = finish(0xecfff4);
const lampOn = finish(0x7ddba8);
const lampOff = finish(0x405449);
const colorsByMaterial = new Map();

function put(g, geometry, material, x = 0, y = 0, z = 0) {
  const mesh = new T.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  g.add(mesh);
  return mesh;
}
function box(g, x, y, z, width, height, depth, mat) {
  const mesh = put(g, unitBox, mat, x, y, z);
  mesh.scale.set(width, height, depth);
  return mesh;
}
function drum(g, x, y, z, radius, length, mat, normal = up) {
  const mesh = put(g, unitDrum, mat, x, y, z);
  mesh.quaternion.setFromUnitVectors(up, normal);
  mesh.scale.set(radius, length, radius);
  return mesh;
}
function annulus(g, x, y, z, radius, boreRadius, length, mat, normal = up) {
  const rim = [
    [boreRadius, -length / 2],
    [radius, -length / 2],
    [radius, length / 2],
    [boreRadius, length / 2],
    [boreRadius, -length / 2],
  ];
  const mesh = put(
    g,
    new T.LatheGeometry(
      rim.map(([r, h]) => new T.Vector2(r, h)),
      28,
    ),
    mat,
    x,
    y,
    z,
  );
  mesh.quaternion.setFromUnitVectors(up, normal);
  return mesh;
}

function table(g, [w, h, d]) {
  box(g, 0, -0.6, 0, w, h - 1.2, d, black);
  box(g, 0, h / 2 - 1, 0, w, 2, d, steel);
  // One combined mesh marks the 25 mm mounting grid. Its circles depict the hole mouths.
  const vertices = [];
  const normals = [];
  for (let x = -w / 2 + 25; x < w / 2; x += 25) {
    for (let z = -d / 2 + 25; z < d / 2; z += 25) {
      for (let j = 0; j < 8; j++) {
        const a = (-j * Math.PI) / 4,
          b = (-(j + 1) * Math.PI) / 4,
          y = h / 2;
        vertices.push(
          x,
          y,
          z,
          x + 3 * Math.cos(a),
          y,
          z + 3 * Math.sin(a),
          x + 3 * Math.cos(b),
          y,
          z + 3 * Math.sin(b),
        );
        normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      }
    }
  }
  const holes = new T.BufferGeometry();
  holes.setAttribute("position", new T.Float32BufferAttribute(vertices, 3));
  holes.setAttribute("normal", new T.Float32BufferAttribute(normals, 3));
  put(g, holes, holeColor);
}

function chassis(g, [w, h, d], cards) {
  // Open cover exposes the actual controller and DDS solids at their own emitted centres.
  const sheet = Math.min(2, h * 0.06);
  box(g, 0, -h / 2 + sheet / 2, 0, w, sheet, d, steel);
  for (const sign of [-1, 1])
    box(g, (sign * (w - sheet)) / 2, 0, 0, sheet, h, d, steel);
  box(g, 0, 0, -d / 2 + sheet / 2, w, h, sheet, black);
  box(g, 0, -h * 0.32, d / 2 - sheet / 2, w, h * 0.36, sheet, black);
  for (const side of [-1, 1])
    box(g, side * (w / 2 - 4), 0, d / 2 - 3, 8, h, 6, steel);
  box(g, 0, h / 2 - 2.5, d / 2 - 3, w, 5, 6, steel);
  for (const card of cards) {
    const [cw, ch, cd] = card.sizeMm;
    const cx = card.centerMm[0] - cw / 2 + 0.8 - g.position.x;
    const cz = card.centerMm[2] - g.position.z;
    const bottom = card.centerMm[1] - ch / 2 - g.position.y;
    const floor = -h / 2 + sheet;
    const rise = bottom - floor - 2;
    for (const end of [-1, 1])
      box(g, cx, floor + rise / 2, cz + end * cd * 0.36, 6, rise, 9, steel);
    box(g, cx, bottom - 1, cz, 5, 2, cd, black);
  }
}

function board(g, [w, h, d], controller) {
  const t = Math.min(1.6, h / 3);
  const y = -h / 2 + t;
  box(g, 0, -h / 2 + t / 2, 0, w, t, d, pcb);
  for (const x of [-0.44 * w, 0.44 * w])
    for (const z of [-0.42 * d, 0.42 * d])
      drum(g, x, y + 0.3, z, 1.5, 0.6, contact);
  if (controller) {
    box(
      g,
      -w * 0.12,
      y + h * 0.09,
      -d * 0.03,
      w * 0.31,
      h * 0.18,
      d * 0.38,
      black,
    );
    for (let i = 0; i < 8; i++)
      box(
        g,
        (-0.25 + i * 0.039) * w,
        y + h * 0.49,
        -0.03 * d,
        w * 0.014,
        h * 0.58,
        d * 0.34,
        steel,
      );
    for (const x of [-0.29, -0.09, 0.11])
      box(g, w * x, y + 0.7, d * 0.3, w * 0.15, 1.4, d * 0.12, black);
  } else {
    for (const x of [-w * 0.23, w * 0.23]) {
      box(g, x, y + h * 0.15, -d * 0.1, w * 0.28, h * 0.3, d * 0.37, black);
    }
  }
  return box(g, w * 0.37, y + 0.65, -d * 0.34, 2, 1.3, 3, lampOff);
}

function cardSockets(g, part, links) {
  const boardX = -part.sizeMm[0] / 2 + 0.8;
  const [w, h, d] = part.sizeMm;
  // The removable card front is recessed behind the connector faces.
  box(g, 0, 0, d / 2 - 2, w, h, 1.6, steel);
  for (const end of [-1, 1])
    box(g, 0, end * (h / 2 - 7), d / 2 - 0.9, w * 0.57, 3, 1.6, black);
  for (const link of links) {
    if (link.from !== part.id && link.to !== part.id) continue;
    const xyz = link.from === part.id ? link.pointsMm[0] : link.pointsMm.at(-1);
    const p = new T.Vector3(...xyz).sub(g.position);
    const z = p.z - Math.sign(p.z) * 3;
    box(g, (p.x + boardX) / 2, p.y, z, Math.abs(p.x - boardX), 4, 6, black);
    if (link.kind === "rf")
      drum(g, p.x, p.y, z, 2.7, 6, contact, new T.Vector3(0, 0, 1));
    else box(g, p.x, p.y, z, 5, 5, 6, steel);
  }
}

function laser(g, [w, h, d]) {
  box(g, 0, -h * 0.45, 0, w, h * 0.1, d, steel);
  box(g, -w * 0.04, -h * 0.04, 0, w * 0.9, h * 0.73, d * 0.89, black);
  for (let i = 0; i < 10; i++)
    box(
      g,
      (-0.43 + i * 0.088) * w,
      h * 0.38,
      0,
      w * 0.035,
      h * 0.24,
      d * 0.87,
      steel,
    );
  const radius = Math.min(d, h) * 0.13;
  drum(g, 0.45 * w, 0, 0, radius, 0.1 * w, steel, alongBeam);
  drum(g, 0.497 * w, 0, 0, radius * 0.65, 0.005 * w, glass, alongBeam);
}

function aod(g, [w, h, d], axis, aperture) {
  box(g, 0, 0, 0, w * 0.98, h * 0.96, d * 0.98, black);
  box(g, 0, -h * 0.475, 0, w, h * 0.05, d, steel);
  // The beam centre can be offset within an AOD housing. Both apertures use the optical route.
  const r = Math.min(h, d) * 0.17;
  for (const sign of [-1, 1]) {
    const x = sign * w * 0.495;
    annulus(
      g,
      x,
      aperture.y,
      aperture.z,
      r,
      r * 0.6,
      w * 0.008,
      steel,
      alongBeam,
    );
    drum(g, x, aperture.y, aperture.z, r * 0.6, w * 0.009, glass, alongBeam);
  }
  if (axis === "x") box(g, 0, 0, d * 0.49, w * 0.72, h * 0.72, d * 0.02, xCoax);
  else box(g, 0, h * 0.49, 0, w * 0.72, h * 0.02, d * 0.72, yCoax);
  for (const x of [-0.38 * w, 0.38 * w])
    for (const z of [-0.38 * d, 0.38 * d])
      drum(g, x, h * 0.48, z, 0.8, h * 0.016, steel);
}

function optics(g, p, links) {
  const [w, h, d] = p.sizeMm;
  if (p.kind === "lens") {
    const radius = Math.min(h, d) / 2;
    annulus(g, 0, 0, 0, radius, radius * 0.84, w, black, alongBeam);
    drum(g, 0, 0, 0, radius * 0.85, w * 0.18, glass, alongBeam);
  } else if (p.kind === "mirror") {
    const before = links.find(
      (l) => l.to === p.id && l.kind === "optical",
    ).pointsMm;
    const after = links.find(
      (l) => l.from === p.id && l.kind === "optical",
    ).pointsMm;
    const incoming = new T.Vector3(...before.at(-1))
      .sub(new T.Vector3(...before.at(-2)))
      .normalize();
    const outgoing = new T.Vector3(...after[1])
      .sub(new T.Vector3(...after[0]))
      .normalize();
    const normal = incoming.sub(outgoing).normalize();
    const r = d / 2;
    drum(g, 0, 0, 0, r, 0.01, steel, normal);
    annulus(g, 0, 0, 0, r, r * 0.94, 0.02, black, normal);
  } else {
    // A compound objective, represented by its catalogue outer barrel and front aperture.
    const r = Math.min(w, d) / 2;
    drum(g, 0, h * 0.12, 0, r, h * 0.76, black);
    drum(g, 0, -h * 0.33, 0, r * 0.83, h * 0.14, steel);
    drum(g, 0, -h * 0.45, 0, r * 0.65, h * 0.1, black);
    for (const level of [0.36, 0.29, -0.18])
      drum(g, 0, level * h, 0, r, h * 0.025, steel);
    drum(g, 0, -h * 0.498, 0, r * 0.48, h * 0.003, glass);
  }
}

function chamber(g, [w, h, d]) {
  // Open upper wall reveals the window and the focal volume in the close-up view.
  const wall = Math.min(1.6, h * 0.12);
  box(g, 0, -(h - wall) / 2, 0, w, wall, d, steel);
  for (const side of [-1, 1]) {
    box(g, (side * (w - wall)) / 2, 0, 0, wall, h, d, steel);
    box(g, 0, 0, (side * (d - wall)) / 2, w, h, wall, steel);
  }
}

function windowFrame(g, [w, h, d]) {
  const rim = Math.min(w, d) * 0.07;
  box(g, 0, 0, 0, w - 2 * rim, h, d - 2 * rim, windowGlass);
  for (const side of [-1, 1]) {
    box(g, (side * (w - rim)) / 2, 0, 0, rim, h, d, glass);
    box(g, 0, 0, (side * (d - rim)) / 2, w - 2 * rim, h, rim, glass);
  }
}

function support(g, [w, h, d]) {
  if (h <= Math.max(w, d) / 2) {
    box(g, 0, 0, 0, w, h, d, black);
    return;
  }
  const base = Math.min(5, 0.14 * h);
  box(g, 0, -(h - base) / 2, 0, w, base, d, black);
  drum(g, 0, base / 2, 0, 0.27 * Math.min(w, d), h - base, steel);
  box(g, 0, (h - base) / 2, 0, w * 0.82, base, d * 0.82, black);
}

function sample(g, s) {
  const traps = new Map(),
    atoms = new Map();
  const shape = new T.TorusGeometry(0.00045, 0.000028, 6, 32);
  const localRay = new T.Ray(),
    inverse = new T.Matrix4(),
    hit = new T.Vector3();
  const markPlane = new T.Plane(new T.Vector3(0, 0, 1), 0);
  for (const t of s.traps) {
    const mark = put(g, shape, beam);
    mark.name = t.id;
    mark.rotation.x = -Math.PI / 2;
    // The centre of an empty ring is selectable even though its visible contour is hollow.
    mark.raycast = (raycaster, intersections) => {
      localRay
        .copy(raycaster.ray)
        .applyMatrix4(inverse.copy(mark.matrixWorld).invert());
      if (
        !localRay.intersectPlane(markPlane, hit) ||
        Math.hypot(hit.x, hit.y) > 0.000478
      )
        return;
      const point = hit.clone().applyMatrix4(mark.matrixWorld);
      const distance = point.distanceTo(raycaster.ray.origin);
      if (distance >= raycaster.near && distance <= raycaster.far)
        intersections.push({ distance, point, object: mark });
    };
    traps.set(t.id, mark);
  }
  for (const a of s.atoms) {
    const mark = new T.Group();
    mark.name = "atom-" + a.id;
    g.add(mark);
    box(mark, 0, 0, 0, 0.0005, 0.000035, 0.00006, occupied);
    box(mark, 0, 0, 0, 0.00006, 0.000035, 0.0005, occupied);
    atoms.set(a.id, mark);
  }
  return (state, frame) => {
    for (const t of state.traps) {
      const mesh = traps.get(t.id);
      mesh.position.set(t.xNm * nmToMm, 0, -t.yNm * nmToMm);
      mesh.userData.readout =
        "Trap X" +
        t.column +
        " × Y" +
        t.row +
        " · " +
        (t.atom === null ? "empty" : "atom " + t.atom) +
        " · (" +
        t.xNm +
        ", " +
        t.yNm +
        ") nm";
      const moving =
        frame?.op === "deliver" &&
        (frame.axis === "x" ? t.column : t.row) === frame.tone;
      mesh.material = moving ? (frame.axis === "x" ? xCoax : yCoax) : beam;
    }
    for (const a of state.atoms) {
      const mark = atoms.get(a.id);
      mark.position.set(a.xNm * nmToMm, 0, -a.yNm * nmToMm);
      mark.userData.readout =
        "Atom " +
        a.id +
        " · X" +
        a.column +
        " × Y" +
        a.row +
        " · (" +
        a.xNm +
        ", " +
        a.yNm +
        ") nm";
    }
  };
}

function addLink(root, link) {
  const optical = link.kind === "optical";
  const mat = optical
    ? beam
    : link.kind === "digital"
      ? wire
      : link.to === "aod-x"
        ? xCoax
        : yCoax;
  const points = link.pointsMm.map((v) => new T.Vector3(...v));
  const route = new T.Group();
  route.userData.part = link.to;
  route.name = link.id;
  root.add(route);
  const radius = link.diameterMm / 2;
  for (let i = 1; i < points.length; i++) {
    const delta = points[i].clone().sub(points[i - 1]);
    // A beam guideline has an open end. Its width remains an annotation at the focus.
    const segment = put(route, optical ? openDrum : unitDrum, mat);
    segment.position.copy(points[i - 1]).addScaledVector(delta, 0.5);
    segment.scale.set(radius, delta.length(), radius);
    segment.quaternion.setFromUnitVectors(up, delta.normalize());
  }
  if (link.kind === "rf") {
    for (const [tip, toward] of [
      [points[0], points[1]],
      [points.at(-1), points.at(-2)],
    ]) {
      const direction = toward.clone().sub(tip).normalize();
      const center = tip.clone().addScaledVector(direction, 2.3);
      drum(route, center.x, center.y, center.z, 2.3, 4.6, contact, direction);
    }
  }
}

function tinted(base) {
  if (!colorsByMaterial.has(base)) {
    const shown = base.clone();
    shown.color.lerp(lampOn.color, 0.4);
    colorsByMaterial.set(base, shown);
  }
  return colorsByMaterial.get(base);
}

export function buildAtomInstallation(system, run) {
  const root = new T.Group(),
    anchors = new Map(),
    groups = new Map();
  const lamps = new Map();
  let updateSites;
  for (const part of system.parts) {
    const g = new T.Group();
    g.name = g.userData.part = part.id;
    g.position.fromArray(part.centerMm);
    root.add(g);
    anchors.set(part.id, g.position.clone());
    groups.set(part.id, g);
    switch (part.kind) {
      case "table":
        table(g, part.sizeMm);
        break;
      case "chassis":
        chassis(
          g,
          part.sizeMm,
          system.parts.filter((p) => p.kind === "fpga" || p.kind === "dds"),
        );
        break;
      case "dds":
      case "fpga": {
        // The card plane is vertical, its backplane faces -Z, and RF outputs face +Z.
        const card = new T.Group();
        card.rotation.z = -Math.PI / 2;
        g.add(card);
        const [width, height, depth] = part.sizeMm;
        lamps.set(
          part.id,
          board(card, [height, width, depth], part.kind === "fpga"),
        );
        cardSockets(g, part, system.links);
        break;
      }
      case "laser":
        laser(g, part.sizeMm);
        break;
      case "aod": {
        const link = system.links.find(
          (l) => l.kind === "optical" && l.to === part.id,
        );
        const aperture = new T.Vector3(...link.pointsMm.at(-1)).sub(g.position);
        aod(g, part.sizeMm, part.id === "aod-x" ? "x" : "y", aperture);
        break;
      }
      case "lens":
      case "mirror":
      case "objective":
        optics(g, part, system.links);
        break;
      case "window":
        windowFrame(g, part.sizeMm);
        break;
      case "chamber":
        chamber(g, part.sizeMm);
        break;
      case "array":
        updateSites = sample(g, run.initial);
        break;
      case "support":
        support(g, part.sizeMm);
        break;
      default:
        throw new Error("Unknown neutral-atom installation part: " + part.kind);
    }
  }
  system.links.forEach((link) => addLink(root, link));

  let activeId, chosen, highlighted;
  const restore = new Map();
  function highlight() {
    const id = chosen || activeId;
    if (id === highlighted) return;
    restore.forEach((material, mesh) => {
      mesh.material = material;
    });
    restore.clear();
    highlighted = id;
    // The calibrated sample glyph colors distinguish shared X and Y delivery.
    if (id === "array") return;
    groups.get(id)?.traverse((mesh) => {
      if (!mesh.isMesh || mesh === lamps.get(id)) return;
      restore.set(mesh, mesh.material);
      mesh.material = tinted(mesh.material);
    });
  }
  function update(frame) {
    const s = frame?.state || run.initial;
    activeId = frame?.part;
    lamps.get("controller").material = s.issued ? lampOn : lampOff;
    lamps.get("dds").material = frame?.op === "rf" ? lampOn : lampOff;
    updateSites(s, frame);
    highlight();
  }
  update(null);
  return {
    root,
    anchors,
    update,
    select(part) {
      chosen = part;
      highlight();
    },
    dispose() {
      const meshes = new Set();
      root.traverse((o) => {
        if (o.isMesh && ![unitBox, unitDrum, openDrum].includes(o.geometry))
          meshes.add(o.geometry);
      });
      meshes.forEach((geometry) => geometry.dispose());
    },
  };
}
