// Where the light of an optical bench (studio/riscq-benches.js) is drawn in the world of the
// workspace (studio/riscq-world.js). Pure: no three.js, so a test can check the mapping.
//
// Light is drawn twice, each at a stated scale:
//   close-up   in the apparatus disc, at the apparatus's own scale (world units per µm of the
//              chip layout): the last free-space piece of every live beam as the Gaussian beam
//              w(z) = w0 √(1 + (z/zR)²) about its waist, clipped to the apparatus region. A
//              tweezer, a gate beam or a light sheet therefore has its true size next to the atoms
//              and ions it acts on.
//   table      on the optical table beside the controller: the whole bench (sources, AOMs, AODs,
//              fibers, lenses, mirrors, objectives) fitted into the table at one mm scale, with
//              the traced path of every live beam through it.
// Heights: the bench's z (mm above the atom plane or trap surface) maps to world y at the same
// scale as x and y, so the 70 µm ion height and the tweezer cone are to scale in the close-up.

/** Linear map of the bench's table frame (mm) to the world, and the scale in world units per mm. */
export function worldMap(world, bench) {
  const o = bench.toSample([0, 0, 0]), ex = bench.toSample([1, 0, 0]);
  const unitsPerMm = ex[0] - o[0];
  const wpm = world.scale * unitsPerMm;
  const at = (mm) => {
    const s = bench.toSample(mm), [x, , z] = world.toWorld([s[0], s[1]]);
    return [x, (mm[2] ?? 0) * wpm, z];
  };
  return { wpm, at };
}

/** Range [from, to] of t for which p + t·d lies inside the box; null when the line misses it. */
function clipRange(p, d, box) {
  let lo = -Infinity, hi = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (p[k] < box.min[k] || p[k] > box.max[k]) return null;
      continue;
    }
    const t1 = (box.min[k] - p[k]) / d[k], t2 = (box.max[k] - p[k]) / d[k];
    lo = Math.max(lo, Math.min(t1, t2));
    hi = Math.min(hi, Math.max(t1, t2));
  }
  return lo < hi ? [lo, hi] : null;
}

const sub = (a, b) => a.map((v, k) => v - b[k]);
const unit = (a) => {
  const n = Math.hypot(...a);
  return n ? a.map((v) => v / n) : [0, 0, 1];
};

/**
 * Draw specs of the live beams of one step.
 * Returns { close: [{ id, lambdaNm, focused: { focus, dir, w0x, w0y, zRx, zRy, before, after }, glow, opacity, cone? }],
 *           table: { elements: [{ label, kind, at }], paths: [{ id, lambdaNm, samples: [{ at, rx, ry }] }], scaleMmPerUnit, sample: [x, y, z] },
 *           records: Map("beam:<id>" → { kind, title, lines, source }) }.
 * `height` is the top of the close-up region in world units (the objective sits there for atoms).
 */
export function lightScene(world, bench, beams, { height = 90, elements = [] } = {}) {
  const { wpm, at } = worldMap(world, bench);
  const R = world.R ?? 100;
  const box = { min: [-1.15 * R, -0.2, -1.15 * R], max: [1.15 * R, height, 1.15 * R] };
  const close = [], records = new Map();
  for (const beam of beams) {
    const g = beam.geometry;
    if (g?.focus && g.segments?.length) {
      const last = g.segments.at(-1);
      const focus = at(g.focus.at);
      const dir = unit(sub(at(last.b), at(last.a)));
      // The part of the beam's axis inside the apparatus region, measured from its waist. The waist
      // may lie outside it, as for a light sheet focused beyond the array.
      // The benches' local x axis is vertical (xAxis [0, 0, ±1]): wx is a sheet's height and wy its
      // width in the plane. The tube's first radius is horizontal, so the two are swapped here.
      const w0h = (g.focus.wyUm / 1000) * wpm, w0v = (g.focus.wxUm / 1000) * wpm, zRh = (g.focus.zRyUm / 1000) * wpm, zRv = (g.focus.zRxUm / 1000) * wpm;
      // A wide beam whose axis passes beside the apparatus still lights it: grow the region by the
      // beam's radius where the axis passes closest to the centre.
      const tc = -focus.reduce((s0, v, k) => s0 + v * dir[k], 0);
      const margin = Math.min(2 * R, Math.max(w0h * Math.sqrt(1 + (tc / zRh) ** 2), w0v * Math.sqrt(1 + (tc / zRv) ** 2)));
      const grown = { min: [box.min[0] - margin, box.min[1], box.min[2] - margin], max: [box.max[0] + margin, box.max[1], box.max[2] + margin] };
      const range = clipRange(focus, dir, beam.role === "tweezer" ? box : grown);
      // A tweezer ends in the atom plane; other beams run on across the apparatus.
      if (range && beam.role === "tweezer") range[1] = Math.min(range[1], 0.6 * (g.focus.zRxUm / 1000) * wpm + 0.5);
      if (range && range[1] > range[0])
        close.push({
          id: beam.id, lambdaNm: beam.lambdaNm, opacity: beam.role === "tweezer" ? 0.42 : beam.role === "raman" || beam.role === "rydberg" || beam.role === "cool" ? 0.07 : 0.3, core: !["raman", "rydberg", "cool"].includes(beam.role),
          focused: { focus, dir, w0x: w0h, w0y: w0v, zRx: zRh, zRy: zRv, before: -range[0], after: range[1] },
          glow: beam.role === "tweezer" ? [{ at: focus, size: Math.max(3, 6 * (g.focus.wxUm / 1000) * wpm), opacity: 0.9 }] : [],
        });
    }
    if (beam.cone) {
      // Fluorescence collected from the ion toward the imaging optics and the PMT.
      const apex = at(beam.cone.apex), axis = unit(sub(at(beam.cone.apex.map((v, k) => v + beam.cone.axis[k])), apex));
      const length = Math.min(beam.cone.lengthMm * wpm, Math.max(0, clipRange(apex, axis, box)?.[1] ?? 0));
      const tan = Math.tan(beam.cone.halfAngleRad), samples = [];
      for (let i = 0; i <= 12; i++) {
        const s = (length * i) / 12, r = Math.max(0.3, s * tan);
        samples.push({ at: apex.map((v, k) => v + axis[k] * s), rx: r, ry: r });
      }
      close.push({ id: beam.id, lambdaNm: beam.lambdaNm, opacity: 0.14, samples, glow: [{ at: apex, size: Math.max(6, 0.2 * R), opacity: 0.95 }] });
    }
    records.set("beam:" + beam.id, {
      kind: { tweezer: "Optical tweezer", gate: "Raman gate beam", detect: "Detection beam", cool: "Cooling beam", raman: "Raman beam", rydberg: "Rydberg beam", fluorescence: "Fluorescence" }[beam.role] ?? "Laser beam",
      title: beam.label ?? beam.id, lines: beam.hover ?? [],
      text: beam.role === "tweezer" ? "The crossed AOD deflects one beam per pair of RF tones; the objective focuses it to a spot at their crossing. The atom is held at that spot." : beam.role === "fluorescence" ? "Light scattered by the ion under the detection beam, collected by the imaging optics onto its photomultiplier." : undefined,
      source: "Traced through the bench by studio/riscq-optics.js (paraxial Gaussian beams). Parameters and sources: docs/riscq-optics.md.",
    });
  }
  // The bench on the table, fitted into the table rectangle.
  let table = null;
  if (world.table && elements.length) {
    const pts = [...elements.map((e) => e.at), [0, 0, 0]];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const [tw, td] = world.table.size;
    const s = Math.min((tw - 40) / Math.max(x1 - x0, 1), (td - 40) / Math.max(y1 - y0, 1));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    // Same handedness as the close-up: bench y runs along world z.
    const onTable = (p) => [world.table.at[0] + (p[0] - cx) * s, 3 + (p[2] ?? 0) * s, world.table.at[2] + (p[1] - cy) * s];
    const paths = [];
    for (const beam of beams)
      for (const seg of beam.geometry?.segments ?? [])
        paths.push({ id: beam.id, lambdaNm: beam.lambdaNm, samples: seg.samples.map((x) => ({ at: onTable(x.at), rx: Math.max(1, (x.wxUm / 1000) * s), ry: Math.max(1, (x.wyUm / 1000) * s) })) });
    table = { elements: elements.map((e) => ({ ...e, world: onTable(e.at) })), paths, scaleMmPerUnit: 1 / s, sample: onTable([0, 0, 0]) };
  }
  return { close, table, records, wpm };
}
