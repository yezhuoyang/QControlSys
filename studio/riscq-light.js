// Light and signals as objects of the 3D stage. A beam is a translucent tube whose radius is
// the Gaussian beam radius w(z) along its path, drawn with additive blending so that it reads
// as light, not as a wire. A microwave signal is a bright packet that runs along its coax.
// Geometry comes from studio/riscq-optics.js and studio/riscq-benches.js through the page; this
// module only turns it into meshes. Every mesh carries userData.part = "beam:<id>" or
// "signal:<id>" so the page can show the beam's own hover card.
import * as T from "three";

const additive = new Map();
/** A material that adds light: colour [r, g, b] in 0..1, opacity 0..1. */
export function lightMaterial(rgb, opacity = 0.35) {
  const key = rgb.map((v) => v.toFixed(3)).join(",") + "/" + opacity.toFixed(2);
  if (!additive.has(key))
    additive.set(key, new T.MeshBasicMaterial({ color: new T.Color(...rgb), transparent: true, opacity, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
  return additive.get(key);
}

/**
 * A tube through `samples` = [{ at: Vector3, rx, ry }] with an elliptical cross-section:
 * rx along `side` (perpendicular to the path, horizontal when possible), ry along the third axis.
 */
export function envelopeTube(samples, material, segments = 18) {
  const n = samples.length;
  if (n < 2) return null;
  const positions = new Float32Array(n * segments * 3), index = [];
  const up = new T.Vector3(0, 1, 0), side = new T.Vector3(), normal = new T.Vector3(), tangent = new T.Vector3();
  for (let i = 0; i < n; i++) {
    const a = samples[Math.max(0, i - 1)].at, b = samples[Math.min(n - 1, i + 1)].at;
    tangent.copy(b).sub(a).normalize();
    side.crossVectors(tangent, Math.abs(tangent.dot(up)) > 0.95 ? new T.Vector3(1, 0, 0) : up).normalize();
    normal.crossVectors(side, tangent).normalize();
    const { at, rx, ry } = samples[i];
    for (let k = 0; k < segments; k++) {
      const t = (2 * Math.PI * k) / segments, o = (i * segments + k) * 3;
      positions[o] = at.x + side.x * rx * Math.cos(t) + normal.x * ry * Math.sin(t);
      positions[o + 1] = at.y + side.y * rx * Math.cos(t) + normal.y * ry * Math.sin(t);
      positions[o + 2] = at.z + side.z * rx * Math.cos(t) + normal.z * ry * Math.sin(t);
    }
  }
  for (let i = 0; i < n - 1; i++)
    for (let k = 0; k < segments; k++) {
      const a = i * segments + k, b = i * segments + ((k + 1) % segments), c = a + segments, d = b + segments;
      index.push(a, c, b, b, c, d);
    }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute("position", new T.BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return new T.Mesh(geometry, material);
}

/**
 * Samples of a focused Gaussian beam around its focus, in world units: w(z) = w0 √(1 + (z/zR)²)
 * from `before` units ahead of the focus to `after` units past it along `dir`.
 * w0x, w0y, zRx, zRy are in world units. The beam is drawn at its 1/e² radius.
 */
export function focusedSamples({ focus, dir, w0x, w0y, zRx, zRy, before, after, count = 40 }) {
  const d = dir.clone().normalize(), out = [];
  for (let i = 0; i < count; i++) {
    const z = -before + ((before + after) * i) / (count - 1);
    out.push({ at: focus.clone().addScaledVector(d, z), rx: w0x * Math.sqrt(1 + (z / zRx) ** 2), ry: w0y * Math.sqrt(1 + (z / zRy) ** 2) });
  }
  return out;
}

let haloTexture = null;
function halo() {
  if (haloTexture) return haloTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const g = canvas.getContext("2d"), gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gradient;
  g.fillRect(0, 0, 64, 64);
  haloTexture = new T.CanvasTexture(canvas);
  return haloTexture;
}
const sprites = new Map();
/** A soft glow of a colour, for atoms, fluorescence and beam spots. Size in world units. */
export function glowSprite(rgb, size, opacity = 0.9) {
  const key = rgb.join(",") + "/" + opacity;
  if (!sprites.has(key)) sprites.set(key, new T.SpriteMaterial({ map: halo(), color: new T.Color(...rgb), transparent: true, opacity, blending: T.AdditiveBlending, depthWrite: false }));
  const sprite = new T.Sprite(sprites.get(key));
  sprite.scale.set(size, size, 1);
  return sprite;
}

/** A packet of microwave signal at fraction `t` of the polyline `points`, `length` world units long. */
export function signalPacket(points, t, length, radius, material) {
  const total = points.slice(1).reduce((s, p, k) => s + p.distanceTo(points[k]), 0);
  const at = (s) => {
    let left = Math.max(0, Math.min(total, s));
    for (let k = 1; k < points.length; k++) {
      const piece = points[k].distanceTo(points[k - 1]);
      if (left <= piece) return points[k - 1].clone().lerp(points[k], piece ? left / piece : 0);
      left -= piece;
    }
    return points.at(-1).clone();
  };
  const head = t * total, samples = [];
  for (let i = 0; i <= 8; i++) samples.push({ at: at(head - length + (length * i) / 8), rx: radius, ry: radius });
  return envelopeTube(samples, material, 10);
}

/** Visible-light colour of a wavelength, with a false colour outside 380–750 nm (stated on hover). */
export function wavelengthRgb(nm) {
  if (nm < 380) return [0.62, 0.38, 1];
  if (nm > 750) return nm > 950 ? [0.85, 0.12, 0.2] : [1, 0.32, 0.22];
  const stops = [[380, [0.38, 0, 0.6]], [440, [0.2, 0.2, 1]], [490, [0, 0.8, 1]], [510, [0, 1, 0.3]], [580, [1, 1, 0]], [645, [1, 0.2, 0]], [750, [0.7, 0, 0]]];
  for (let k = 1; k < stops.length; k++)
    if (nm <= stops[k][0]) {
      const [a, ca] = stops[k - 1], [b, cb] = stops[k], f = (nm - a) / (b - a);
      return ca.map((v, i) => v + f * (cb[i] - v));
    }
  return [0.7, 0, 0];
}
