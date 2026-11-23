import * as T from "three";
import { drawNeutralHardware, drawNeutralZones } from "./neutral-hardware.js";
import { drawIonHardware, drawStudioTrap } from "./ion-hardware.js";
import { drawCryoHardware } from "./cryo-hardware.js";

// Coordinates in mm, in the same x / up / z convention as the machine editor.
const boxGeometry = new T.BoxGeometry(),
  cylinderGeometry = new T.CylinderGeometry(1, 1, 1, 24);
const ballGeometry = new T.SphereGeometry(1, 14, 10),
  ringGeometry = new T.TorusGeometry(1, 0.11, 6, 32);
const sectionPlate = new T.CylinderGeometry(
  1,
  1,
  1,
  40,
  1,
  false,
  Math.PI * 0.61,
  Math.PI * 0.95,
);
const rearRim = new T.TorusGeometry(1, 0.085, 8, 36, Math.PI * 1.04);
const silver = 0x9caeb7,
  dark = 0x283945,
  gold = 0xd9a652,
  copper = 0xb77743,
  aqua = 0x66d4ce;

function shapes(root) {
  const materials = new Map();
  function material(color) {
    if (!materials.has(color))
      materials.set(
        color,
        new T.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.23 }),
      );
    return materials.get(color);
  }
  function mesh(geo, p, size, color) {
    const m = new T.Mesh(geo, material(color));
    m.position.fromArray(p);
    m.scale.fromArray(size);
    root.add(m);
    return m;
  }
  const box = (p, size, color) => mesh(boxGeometry, p, size, color);
  const disc = (p, r, h, color) => mesh(cylinderGeometry, p, [r, h, r], color);
  function line(a, b, r, color) {
    const d = new T.Vector3(...b).sub(new T.Vector3(...a)),
      length = d.length();
    if (!length) return;
    const m = disc(
      a.map((v, i) => (v + b[i]) / 2),
      r,
      length,
      color,
    );
    m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.normalize());
    return m;
  }
  function ring(p, r, color) {
    const m = mesh(ringGeometry, p, [r, r, r], color);
    m.rotation.x = -Math.PI / 2;
    return m;
  }
  return {
    mesh,
    box,
    disc,
    line,
    ring,
    material,
    dispose() {
      materials.forEach((m) => m.dispose());
    },
  };
}

// A cutaway exposes the chip even when the camera looks through the vacuum enclosure.
export function buildApparatusPart(group, p) {
  const s = shapes(group),
    [w, h, d] = p.sizeMm;
  if (
    drawNeutralHardware(s, p) ||
    drawIonHardware(s, p) ||
    drawCryoHardware(s, p)
  )
    return s.dispose;
  switch (p.form) {
    case "cryostat": {
      for (const [fraction, r] of [
        [0.48, 0.49],
        [0.23, 0.44],
        [-0.02, 0.38],
        [-0.24, 0.31],
        [-0.46, 0.23],
      ]) {
        s.mesh(
          sectionPlate,
          [0, h * fraction, 0],
          [w * r, 5, w * r],
          fraction > 0 ? silver : gold,
        );
      }
      for (const a of [3.35, 4.65, 6.1]) {
        const pos = (r, height) => [
          w * r * Math.cos(a),
          height,
          w * r * Math.sin(a),
        ];
        s.line(pos(0.41, h * 0.48), pos(0.21, -h * 0.46), 2.1, silver);
      }
      for (let i = 0; i < 4; i++) {
        const a = [-48 + i * 14, h * 0.46, -40],
          b = [-21 + i * 8, -h * 0.44, -24];
        s.line(a, b, 1.2, copper);
      }
      break;
    }
    case "coax":
      s.disc([0, 0, 0], w * 0.26, h, gold);
      s.disc([0, 0, 0], w * 0.49, h * 0.39, silver);
      break;
    case "mount":
      s.box([0, 0, 0], [w, h, d], copper);
      s.box([0, h * 0.53, 0], [w * 0.72, 0.35, d * 0.72], dark);
      break;
    case "chamber":
      s.disc([0, -h * 0.38, 0], w * 0.46, h * 0.2, silver);
      {
        const r = w * 0.43,
          rim = s.mesh(rearRim, [0, h * 0.33, 0], [r, r, r], silver);
        rim.rotation.x = -Math.PI / 2;
      }
      for (const a of [3.4, 4.7, 6.05]) {
        const x = w * 0.41 * Math.cos(a),
          z = d * 0.41 * Math.sin(a);
        s.line([x, -h * 0.35, z], [x, h * 0.33, z], w * 0.041, silver);
      }
      s.line([w * 0.45, -12, 0], [w * 0.59, -12, 0], w * 0.13, silver);
      break;
    case "objective":
      s.disc([0, h * 0.14, 0], w * 0.47, h * 0.65, dark);
      s.disc([0, -h * 0.27, 0], w * 0.36, h * 0.19, silver);
      s.disc([0, -h * 0.41, 0], w * 0.26, h * 0.12, aqua);
      break;
    case "aod":
      for (const n of [-1, 1]) {
        s.box(
          [n * w * 0.23, 0, n * 3],
          [w * 0.41, h * 0.63, d * 0.7],
          0x556d73,
        );
        s.box(
          [n * w * 0.23, h * 0.12, n * 3 + d * 0.36],
          [w * 0.18, h * 0.26, 2],
          aqua,
        );
      }
      break;
    case "laser":
      s.box([0, 0, 0], [w, h, d], 0x567d75);
      for (let i = -2; i <= 2; i++)
        s.box([i * 9, h * 0.5, 0], [2, 2, d * 0.85], dark);
      break;
    case "table":
      s.box([0, 0, 0], [w, h, d], 0x50616c);
      break;
    case "feedthrough":
      s.disc([0, 0, 0], w * 0.47, h, silver);
      break;
  }
  return s.dispose;
}

const idle = { ion: 0xc6f7ff, atom: 0x7df4da, transmon: 0xe6be74 };
export function buildRegister(device) {
  const root = new T.Group(),
    s = shapes(root),
    owned = [],
    markers = new Map();
  const coords = device.qubits.map((q) => new T.Vector3(...q.positionMm));
  const bounds = new T.Box3().setFromPoints(coords);
  const range = bounds.getSize(new T.Vector3()),
    mid = bounds.getCenter(new T.Vector3());
  const l = device.layout;
  function mark(q, objects) {
    const color = idle[device.kind],
      mat = s.material(color).clone();
    owned.push(mat);
    for (const m of objects) {
      m.material = mat;
      m.userData.qubit = q.id;
    }
    markers.set(q.id, mat);
  }
  function face(poly, holes, offset, height, color) {
    const toPath = (pts) => pts.map(([x, z]) => new T.Vector2(x, -z));
    const shape = new T.Shape(toPath(poly));
    for (const hole of holes) shape.holes.push(new T.Path(toPath(hole)));
    const g = new T.ShapeGeometry(shape);
    owned.push(g);
    const m = s.mesh(
      g,
      [offset[0], offset[1] + height, offset[2]],
      [1, 1, 1],
      color,
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  }
  let span, verticalPadding;
  if (device.kind === "transmon") {
    const [x0, z0, x1, z1] = l.chip.boundsMm,
      depth = l.chip.substrateThicknessMm;
    s.box(
      [(x0 + x1) / 2, -depth / 2, (z0 + z1) / 2],
      [x1 - x0, depth, z1 - z0],
      0x31375b,
    );
    const ground = l.metalPolygons.find((p) => p.role === "ground");
    const holes = device.qubits.flatMap((q) =>
      ground.holes.map((h) =>
        h.map(([x, z]) => [x + q.positionMm[0], z + q.positionMm[2]]),
      ),
    );
    face(ground.points, holes, [0, 0, 0], 0.0001, 0x4a6477);
    for (const q of device.qubits) {
      const objects = [];
      for (const poly of l.metalPolygons.filter((p) => p.role !== "ground")) {
        const m = face(
          poly.points,
          poly.holes,
          q.positionMm,
          0.00025,
          poly.role === "port" ? copper : gold,
        );
        m.userData.qubit = q.id;
        if (poly.role === "electrode") objects.push(m);
      }
      for (const jj of l.junctions)
        for (let i = 1; i < jj.points.length; i++) {
          const at = (n) => [
            q.positionMm[0] + jj.points[n][0],
            q.positionMm[1] + 0.00045,
            q.positionMm[2] + jj.points[n][1],
          ];
          const m = s.line(at(i - 1), at(i), jj.widthMm / 2, aqua);
          if (m) m.userData.qubit = q.id;
        }
      mark(q, objects);
    }
    span = Math.max(range.x, range.z, range.y) + 1.14;
    verticalPadding = 0.68;
  } else if (device.kind === "ion") {
    if (device.mounting) drawStudioTrap(s, device);
    else {
      const sites = new Map(l.sites.map((p) => [p.id, p]));
      s.box([0, -0.19, 0], [l.spanMm, 0.38, l.widthMm], 0x344650);
      for (const [a, b] of l.edges) {
        const p = sites.get(a),
          q = sites.get(b),
          dx = q.x - p.x,
          dz = q.z - p.z,
          length = Math.hypot(dx, dz);
        if (!length) continue;
        for (const side of [-1, 1]) {
          const ox = (side * 0.045 * dz) / length,
            oz = (-side * 0.045 * dx) / length;
          s.line(
            [p.x + ox, 0.008, p.z + oz],
            [q.x + ox, 0.008, q.z + oz],
            0.012,
            gold,
          );
        }
      }
      for (const p of l.sites)
        s.box(
          [p.x, 0.006, p.z],
          [0.074, 0.012, 0.035],
          p.zone === "gate" ? copper : 0x826241,
        );
    }
    for (const q of device.qubits) {
      const radius = device.qubits.some(
        (other) => other.id !== q.id && other.site === q.site,
      )
        ? 0.00165
        : 0.045;
      const m = s.mesh(
        ballGeometry,
        q.positionMm,
        [radius, radius, radius],
        idle.ion,
      );
      mark(q, [m]);
    }
    bounds.expandByPoint(new T.Vector3(-l.spanMm / 2, 0, -l.widthMm / 2));
    bounds.expandByPoint(new T.Vector3(l.spanMm / 2, 0.08, l.widthMm / 2));
    bounds.getCenter(mid);
    const ext = bounds.getSize(new T.Vector3());
    span = Math.max(ext.x, ext.z, ext.y) * 1.12;
    verticalPadding = 0.35;
  } else {
    if (device.mounting) drawNeutralZones(s, device);
    const pitch = Math.min(...l.slms.map((g) => Math.min(...g.pitchMm)));
    // Crop empty SLM sites to the vicinity of the occupied register.
    for (const grid of l.slms) {
      const [x, z] = grid.originMm,
        [px, pz] = grid.pitchMm;
      const lo = (n, o, p) => Math.max(0, Math.floor((n - o) / p) - 1);
      const hi = (n, o, p, max) =>
        Math.min(max - 1, Math.ceil((n - o) / p) + 1);
      const c0 = lo(bounds.min.x, x, px),
        c1 = hi(bounds.max.x, x, px, grid.cols);
      const r0 = lo(bounds.min.z, z, pz),
        r1 = hi(bounds.max.z, z, pz, grid.rows);
      if ((c1 - c0 + 1) * (r1 - r0 + 1) <= 2000)
        for (let r = r0; r <= r1; r++)
          for (let c = c0; c <= c1; c++)
            s.ring(
              [x + c * px, -pitch * 0.16, z + r * pz],
              pitch * 0.21,
              0x377789,
            );
    }
    for (const q of device.qubits) {
      const [x, y, z] = q.positionMm,
        waist = pitch * 0.13;
      for (const side of [-1, 1]) {
        s.line(
          [x + side * pitch * 0.31, y + pitch * 0.83, z],
          [x + side * waist, y, z],
          pitch * 0.018,
          0x408c96,
        );
        s.line(
          [x + side * waist, y, z],
          [x + side * pitch * 0.26, y - pitch * 0.65, z],
          pitch * 0.018,
          0x39717c,
        );
      }
      const m = s.mesh(
        ballGeometry,
        q.positionMm,
        [pitch * 0.2, pitch * 0.2, pitch * 0.2],
        idle.atom,
      );
      mark(q, [m]);
    }
    span = Math.max(range.x, range.z, range.y) + pitch * 2.5;
    verticalPadding = pitch * 3;
  }
  const extent = bounds.getSize(new T.Vector3());
  const projectedHeight =
    (0.12 * extent.x + 0.58 * extent.y + 0.86 * extent.z + verticalPadding) *
    1.12;
  return {
    root,
    mid,
    span,
    projectedHeight,
    markers,
    device,
    paint(levels, selected) {
      for (const [id, mat] of markers) {
        const active = levels.has(id);
        mat.color.setHex(
          active ? 0xff9257 : id === selected ? 0xf7e595 : idle[device.kind],
        );
        mat.emissive.setHex(
          active ? 0x71340d : id === selected ? 0x514622 : 0x122731,
        );
      }
    },
    dispose() {
      s.dispose();
      owned.forEach((o) => o.dispose());
    },
  };
}
