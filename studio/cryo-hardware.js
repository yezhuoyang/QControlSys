import * as T from "three";

const brass = 0xc5a362, silver = 0xb3bec5, copper = 0xbd764b;
const edge = 0x788995, frame = 0x586975, board = 0x425650;
const feedZ = 184;
const flangeShapes = new Map();
const shieldShapes = new Map();

// One radial service cutout per plate for the cable tree. The Cu insert bridges
// the shoulders; its central slot holds the individual feedthroughs and clamps.
function flange(s, width, height, color) {
  const key = width + "/" + height;
  if (!flangeShapes.has(key)) {
    const r = width / 2, halfSlot = 44;
    const start = Math.acos(-halfSlot / r), end = 2 * Math.PI + Math.acos(halfSlot / r);
    const shape = new T.Shape();
    shape.moveTo(-halfSlot, Math.sqrt(r * r - halfSlot * halfSlot));
    for (let i = 1; i <= 64; i++) {
      const a = start + (end - start) * i / 64;
      shape.lineTo(r * Math.cos(a), r * Math.sin(a));
    }
    shape.lineTo(halfSlot, feedZ - 45);
    shape.lineTo(-halfSlot, feedZ - 45);
    shape.closePath();
    const geo = new T.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);
    flangeShapes.set(key, geo);
  }
  s.mesh(flangeShapes.get(key), [0, height / 2, 0], [1, 1, 1], color);
  const y = height / 2 - 2;
  for (const sign of [-1, 1]) {
    s.box([0, y, feedZ + sign * 23.5], [104, 4, 41], copper);
    s.box([sign * 48, y, feedZ], [8, 4, 6], copper);
    for (const z of [-32, 32]) {
      s.disc([sign * 48, y + 1.8, feedZ + z], 2.4, 0.4, brass);
    }
  }
}

export function drawCryoHardware(s, p) {
  const [w, h, d] = p.sizeMm;
  switch (p.form) {
    case "cryo-stand": {
      const x = w / 2 - 15, z = d / 2 - 15;
      for (const sign of [-1, 1]) {
        for (const side of [-1, 1]) {
          s.box([sign * x, 0, side * z], [22, h, 22], frame);
          s.box([sign * x, -h / 2 + 3, side * z], [30, 6, 30], edge);
        }
        s.box([sign * x, h / 2 - 17, 0], [22, 22, d - 30], edge);
        s.box([0, h / 2 - 17, sign * 226], [w - 30, 22, 22], edge);
      }
      break;
    }
    case "cryo-silver-plate":
    case "cryo-copper-plate":
      flange(s, w, h, p.form === "cryo-silver-plate" ? silver : copper);
      break;
    case "cryo-jacket":
    case "cryo-al-shield":
    case "cryo-cu-shield": {
      const shell = p.form === "cryo-jacket";
      const thickness = shell ? 3 : 1;
      const radius = w / 2;
      const arc = (shell ? 0.28 : 0.46) * Math.PI;
      const key = p.form + "/" + w + "/" + h;
      if (!shieldShapes.has(key)) {
        const profile = [
          [0.1, -h / 2], [radius, -h / 2], [radius, h / 2],
          [radius - thickness, h / 2], [radius - thickness, -h / 2 + thickness],
          [0.1, -h / 2 + thickness],
        ].map(([r, y]) => new T.Vector2(r, y));
        shieldShapes.set(key, new T.LatheGeometry(profile, 20, Math.PI - arc / 2, arc));
      }
      s.mesh(shieldShapes.get(key), [0, 0, 0], [1, 1, 1],
        shell ? edge : p.form === "cryo-al-shield" ? 0x9eaeb6 : 0xb88a61);
      break;
    }
    case "cryo-hangers":
      for (const sign of [-1, 1]) {
        s.disc([sign * (w / 2 - 3), 0, d / 2 - 3], 2.8, h, 0x888d80);
        for (const side of [-1, 1]) {
          s.disc([sign * (w / 2 - 3), side * (h / 2 - 7), d / 2 - 3], 4.8, 8, edge);
        }
      }
      s.disc([0, 0, -d / 2 + 3], 2.8, h, 0x888d80);
      break;
    case "cryo-pillar":
      s.disc([0, 0, 0], w / 2, h, copper);
      break;
    case "cryo-bulkhead":
    case "cryo-attenuator":
    case "cryo-clamp": {
      // The outer conductor or attenuator body makes contact with the Cu insert.
      const plainClamp = p.form === "cryo-clamp";
      s.disc([0, 0, 0], plainClamp ? 2 : 2.9, h, plainClamp ? silver : brass);
      s.box([0, 0, 0], [w, 5, d], p.form === "cryo-bulkhead" ? edge : copper);
      for (const sign of [-1, 1]) {
        s.disc([0, sign * h * 0.26, 0], plainClamp ? 3 : 4.4,
          plainClamp ? 3 : 5.5, p.form === "cryo-attenuator" ? silver : brass);
      }
      break;
    }
    case "cryo-package-base":
      s.box([0, 0, 0], [w, h, d], copper);
      break;
    case "cryo-launch-board":
      // A rectangular window fits the actual die bounds. The 10 and 7 mm
      // perimeter margins match the machine model across different die sizes.
      for (const sign of [-1, 1]) {
        s.box([sign * (w / 2 - 5), 0, 0], [10, h, d], board);
        s.box([0, 0, sign * (d / 2 - 3.5)], [w - 20, h, 7], board);
        for (const side of [-1, 1]) {
          s.disc([sign * (w / 2 - 2), 0, side * (d / 2 - 2)], 0.65, h, brass);
        }
      }
      break;
    default:
      return false;
  }
  return true;
}
