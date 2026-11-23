import * as T from "three";

const palette = {
  data: 0xdaa15c, clock: 0xae76c2, signal: 0xc58950, return: 0x607987,
  positive: 0xd17a62, negative: 0x618ebe, shield: 0x93a2aa,
  mode: 0x67d9be, jacket: 0x627a80, cladding: 0x94cfdf, glass: 0xafdee7,
  dielectric: 0xb9ad89,
};
const selectedColor = 0xffda64;
const tau = 2 * Math.PI;
const Y = new T.Vector3(0, 1, 0), X = new T.Vector3(1, 0, 0);

function routePoints(raw) {
  const points = [];
  for (const p of raw) {
    const v = p?.isVector3 ? p.clone() : new T.Vector3(...p);
    if (!points.length || v.distanceToSquared(points.at(-1)) > 0) points.push(v);
  }
  return points;
}

// At each bend, parallel-transport the previous transverse axis by the minimum
// rotation between tangents. This avoids lane swaps when a cable passes vertical.
function framesFor(points) {
  const edges = points.slice(1).map((p, i) => p.clone().sub(points[i]).normalize());
  const frames = [];
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    let t = edges[i] ?? edges.at(-1);
    if (i > 0 && i < edges.length) {
      const mean = edges[i - 1].clone().add(edges[i]);
      if (mean.lengthSq() > 1e-16) t = mean.normalize();
    }
    let u;
    if (i === 0) u = (Math.abs(t.y) < 0.95 ? Y : X).clone().cross(t);
    else {
      s += points[i].distanceTo(points[i - 1]);
      const prev = frames[i - 1];
      u = prev.u.clone();
      if (prev.t.dot(t) > -0.99999999)
        u.applyQuaternion(new T.Quaternion().setFromUnitVectors(prev.t, t));
      u.addScaledVector(t, -u.dot(t));
    }
    u.normalize();
    frames.push({ p: points[i], t, u, v: t.clone().cross(u).normalize(), s });
  }
  return frames;
}

function longestSpan(path) {
  let i = 0, length = 0;
  for (let n = 1; n < path.length; n++) {
    const d = path[n].distanceTo(path[n - 1]);
    if (d > length) { i = n - 1; length = d; }
  }
  return { i, length };
}

function ring(r, start = 0, arc = tau) {
  const steps = 24;
  const n = arc === tau ? steps : Math.ceil(arc / tau * steps);
  return Array.from({ length: arc === tau ? n : n + 1 }, (_, i) => {
    const a = start + arc * i / n;
    return new T.Vector2(r * Math.cos(a), r * Math.sin(a));
  });
}

function shell(outer, inner, start = 0, arc = tau) {
  const outside = ring(outer, start, arc);
  const inside = ring(inner, start, arc).reverse();
  return arc === tau ? [outside, inside] : [outside.concat(inside)];
}

// Extrude arbitrary cross-sections along an explicitly framed polyline, including
// ground strips, circular conductors, annuli and exposed annular cut faces.
function sweep(frames, contours, offset, origin) {
  const profile = contours.flat(), count = profile.length;
  const vertices = [], indices = [];
  for (const { p, u, v } of frames) {
    for (const pt of profile) {
      const a = offset + pt.x, b = pt.y;
      vertices.push(p.x - origin.x + a*u.x + b*v.x, p.y - origin.y + a*u.y + b*v.y,
        p.z - origin.z + a*u.z + b*v.z);
    }
  }
  for (let k = 1; k < frames.length; k++) {
    let first = 0;
    for (const contour of contours) {
      for (let i = 0; i < contour.length; i++) {
        const a = (k-1)*count + first + i, b = (k-1)*count + first + (i+1)%contour.length;
        indices.push(a,b,b+count, a,b+count,a+count);
      }
      first += contour.length;
    }
  }
  const last = count * (frames.length - 1);
  for (const [a,b,c] of T.ShapeUtils.triangulateShape(contours[0], contours.slice(1))) {
    indices.push(c,b,a, last+a,last+b,last+c);
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute("position", new T.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function diameter(spec) {
  const mode = spec.opticalMode;
  if (mode) return mode.jacketDiameterMm ?? mode.diameterMm;
  const edges = spec.conductors.flatMap(c => {
    const half = (c.widthMm ?? c.diameterMm)/2;
    return [c.offsetMm-half, c.offsetMm+half];
  });
  return Math.max(...edges) - Math.min(...edges);
}

// The reference connector has one fixed contact position per destination bit.
// Give overlapping spans separate insulated levels. Nonoverlapping crossovers
// can use the same level. Receiver-internal remapping leaves the cable straight.
function connectorLanes(spec) {
  const moved = new Map();
  if (spec.kind !== "parallel" || spec.pinRouting === "inside-receiver") return moved;
  const data = spec.conductors.filter(c => c.role === "data");
  const atBit = new Map(data.map(c => [c.bitIndex, c.offsetMm]));
  const clearance = 1.75 * Math.max(...spec.conductors.map(c => c.diameterMm));
  const spans = data.filter(c => (c.destinationBitIndex ?? c.bitIndex) !== c.bitIndex).map(c => {
    const target = atBit.get(c.destinationBitIndex);
    return { id:c.id, target, travel:Math.abs(target-c.offsetMm),
      left:Math.min(target,c.offsetMm)-c.diameterMm/2, right:Math.max(target,c.offsetMm)+c.diameterMm/2 };
  }).sort((a,b) => a.left-b.left || a.right-b.right);
  const rightEdges = [];
  for (const span of spans) {
    let level = rightEdges.findIndex(right => right < span.left);
    if (level < 0) level = rightEdges.length;
    rightEdges[level] = span.right;
    moved.set(span.id, { ...span, height: (level+1)*clearance });
  }
  return moved;
}

function frameAt(frames, distance) {
  let lo = 0, hi = frames.length-1;
  while (hi-lo > 1) {
    const mid = Math.floor((lo+hi)/2);
    if (frames[mid].s < distance) lo=mid;
    else hi=mid;
  }
  const a=frames[lo], b=frames[hi];
  if (distance <= a.s) return a;
  if (distance >= b.s) return b;
  const f=(distance-a.s)/(b.s-a.s);
  const t=a.t.clone().lerp(b.t,f).normalize(), u=a.u.clone().lerp(b.u,f);
  u.addScaledVector(t,-t.dot(u)).normalize();
  return {p:a.p.clone().lerp(b.p,f), t, u, v:t.clone().cross(u).normalize(), s:distance};
}

function connectorApproach(frames, moved) {
  if (!moved.size) return;
  const distance = frames.at(-1).s;
  const span = Math.min(distance * 0.9, Math.max(...Array.from(moved.values(), c => Math.max(2.4*c.travel, 5*c.height))));
  const start = distance-span;
  const stations = new Set(frames.map(f => f.s));
  for (let j=0;j<=16;j++) stations.add(Math.min(distance,start+span*j/16));
  return { start, span, frames:[...stations].sort((a,b)=>a-b).map(s=>frameAt(frames,s)) };
}

function crossover(approach, c, route) {
  const ease = t => t*t*(3-2*t);
  return approach.frames.map(f => {
    const phase = Math.max(0, Math.min(1, (f.s-approach.start)/approach.span));
    const level = phase < 0.25 ? ease(4*phase) : phase > 0.75 ? ease(4*(1-phase)) : 1;
    const across = ease(Math.max(0, Math.min(1, (phase-0.25)*2)));
    return f.p.clone().addScaledVector(f.u, c.offsetMm + across*(route.target-c.offsetMm))
      .addScaledVector(f.v, level*route.height);
  });
}

export function createWireSection(root) {
  const group = new T.Group();
  group.name = "Interconnect cross-section";
  const geometries = [], surfaces = [];
  let current, currentPaths, focus, focusFrame, diameterMm;

  function clear() {
    root.remove(group);
    group.clear();
    geometries.splice(0).forEach(g => g.dispose());
    surfaces.splice(0).forEach(s => s.material.dispose());
    current = currentPaths = focus = focusFrame = undefined;
  }

  function build(link, paths) {
    const spec = link.interconnect;
    diameterMm = diameter(spec);
    const moved = connectorLanes(spec);
    let connectorFocus;
    const usable = paths.map(routePoints).filter(path => path.length >= 2);
    if (!usable.length) return false;
    const spans = usable.map(longestSpan);
    const best = spans.reduce((i, s, j) => s.length > spans[i].length ? j : i, 0);
    const anchor = usable[best][spans[best].i].clone().lerp(usable[best][spans[best].i+1], 0.5);
    group.position.copy(anchor); // Preserve sub-micron detail around the camera target.
    group.userData.part = link.id;
    root.add(group);
    function draw(frames, contours, offset, color, pickId, highlightId = pickId, opacity = 1) {
      const geometry = sweep(frames, contours, offset, anchor);
      const material = new T.MeshStandardMaterial({ color, side: T.DoubleSide, roughness: 0.54,
        metalness: opacity < 1 ? 0.05 : 0.27, transparent: opacity < 1, opacity,
        depthWrite: opacity === 1 });
      const mesh = new T.Mesh(geometry, material);
      mesh.userData = { part: link.id, conductor: pickId };
      group.add(mesh);
      geometries.push(geometry);
      surfaces.push({ material, color, highlightId });
    }
    for (const [n, path] of usable.entries()) {
      const { i, length } = spans[n];
      const a = path[i], b = path[i+1];
      // Keep at least one annular cut face inside the fitted view, so a coax
      // return reads as a thick-walled tube rather than parallel colored bands.
      const half = Math.min(0.41, diameterMm * 0.7 / length);
      const at = fraction => a.clone().lerp(b, fraction);
      const points = [...path.slice(0,i+1), at(0.5-half), at(0.5), at(0.5+half), ...path.slice(i+1)];
      const frames = framesFor(points);
      const approach = connectorApproach(frames, moved);
      if (approach && n === best) {
        const frame = frameAt(frames, approach.start + approach.span/2);
        const highest = Math.max(...Array.from(moved.values(), c => c.height));
        connectorFocus = { frame, center: frame.p.clone().addScaledVector(frame.v,highest/2),
          span: Math.max(1.75*diameterMm, 1.5*approach.span, 3*highest) };
      }
      const middle = i+2;
      if (n === best) focusFrame = frames[middle];
      // Keep the back of each shell intact and remove an angular sector only
      // inside this observation window. Both ends of the cable remain enclosed.
      function layered(outer, inner, cutStart, cutArc, color, id, highlight = id, opacity = 1) {
        const whole = shell(outer, inner);
        draw(frames.slice(0, middle), whole, 0, color, id, highlight, opacity);
        draw(frames.slice(middle-1,middle+2), shell(outer, inner, cutStart, cutArc), 0,
          color, id, highlight, opacity);
        draw(frames.slice(middle+1), whole, 0, color, id, highlight, opacity);
      }
      for (const c of spec.conductors) {
        const color = palette[c.role];
        if (c.role === "shield") {
          layered(c.diameterMm/2, c.innerDiameterMm/2, 0.88*Math.PI, 1.26*Math.PI, color, c.id);
          const core = spec.conductors.find(l => l.role === "signal");
          layered(c.innerDiameterMm/2, core.diameterMm/2, 1.02*Math.PI, 0.96*Math.PI,
            palette.dielectric, core.id, null);
        } else if (c.shape === "strip") {
          const w = c.widthMm/2, h = c.thicknessMm/2;
          const rect = [[-w,-h],[w,-h],[w,h],[-w,h]].map(([x,y]) => new T.Vector2(x,y));
          draw(frames, [rect], c.offsetMm, color, c.id);
        } else if (moved.has(c.id)) {
          const line = crossover(approach,c,moved.get(c.id));
          draw(framesFor(line), [ring(c.diameterMm/2)], 0, color, c.id);
        } else draw(frames, [ring(c.diameterMm/2)], c.offsetMm, color, c.id);
      }
      const mode = spec.opticalMode;
      if (mode) {
        if (mode.role === "guided") {
          if (mode.jacketDiameterMm > mode.claddingDiameterMm)
            layered(mode.jacketDiameterMm/2, mode.claddingDiameterMm/2, 0.9*Math.PI, 1.18*Math.PI,
              palette.jacket, mode.id, null);
          layered(mode.claddingDiameterMm/2, mode.coreDiameterMm/2, 1.02*Math.PI, 0.94*Math.PI,
            palette.cladding, mode.id, null, 0.68);
          draw(frames, [ring(mode.coreDiameterMm/2)], 0, palette.glass, mode.id, null, 0.4);
        }
        // The mode diameter is an envelope annotation, including its cladding
        // tail where specified. A free-space beam has no material tube.
        draw(frames, [ring(mode.diameterMm/2)], 0, palette.mode, mode.id, mode.id, 0.62);
      }
    }
    if (connectorFocus) focusFrame = connectorFocus.frame;
    const direction = focusFrame.v.clone().multiplyScalar(0.92)
      .addScaledVector(focusFrame.u, 0.18).addScaledVector(focusFrame.t, 0.6).normalize();
    focus = { id: link.id, label: link.kind ?? spec.kind, centerMm: (connectorFocus?.center ?? anchor).toArray(),
      spanMm: connectorFocus?.span ?? diameterMm * 3.4, direction };
    return true;
  }

  function open(link, conductorId, pathsMm) {
    if (!link?.interconnect) { clear(); return; }
    if (current !== link || currentPaths !== pathsMm) {
      clear();
      if (!build(link, pathsMm ?? [link.pointsMm])) return;
      current = link; currentPaths = pathsMm;
    }
    for (const {material, color, highlightId} of surfaces) {
      const active = conductorId != null && conductorId === highlightId;
      material.color.setHex(active ? selectedColor : color);
      material.emissive.setHex(active ? 0x634500 : 0);
    }
    const mode = link.interconnect.opticalMode;
    const spanMm = mode?.role === "guided" && conductorId === mode.id ? mode.diameterMm * 10 : focus.spanMm;
    return { ...focus, centerMm: [...focus.centerMm], direction: focus.direction.clone(), spanMm };
  }
  return { open, clear, dispose: clear };
}
