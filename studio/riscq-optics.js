// Paraxial Gaussian-beam optics for the optical benches of the RISC-Q workspace
// (studio/riscq-benches.js). Pure module with no imports, so the browser page, the tests and a
// headless agent trace the same beams.
//
// Model. A beam is a fundamental Gaussian mode with its own complex beam parameter q along each
// transverse axis of the beam (x and y of a local frame that travels with the beam), so an
// astigmatic beam such as a light sheet is two independent Gaussians. Elements act through ABCD
// matrices on q:  q' = (A q + B) / (C q + D),  1/q = 1/R − i M² λ / (π w²).
// The beam centre is a ray (offset h, angle θ) per axis, propagated with the same matrices, so a
// deflection by an AOD is carried through lenses and telescopes to a shifted focus. The optical
// axis of a train is a polyline: it changes direction only at mirrors and beam splitters, which
// reflect the direction and the local frame about their normal.
//
// Units: positions and distances along a bench in mm, waists and Rayleigh ranges in µm,
// wavelengths in nm, frequencies in Hz, power in W, intensity in W/cm².
//
// Approximation boundary (what this does not model): fields are scalar and paraxial; every
// element is thin; lenses have no aberration; polarization is not tracked; apertures are only
// flagged when the beam overfills them (no diffraction by the aperture); M² multiplies the
// divergence of an embedded Gaussian; AODs and AOMs act in first order with a constant
// efficiency; SLM phase patterns, top-hat shaping and fiber modes other than the fundamental
// are not modeled. These are standard textbook relations (Siegman, Lasers, 1986, ch. 17 and 20;
// Saleh and Teich, Fundamentals of Photonics, ch. 3).

export const C_M_PER_S = 299792458;
export const C_MM_PER_NS = C_M_PER_S / 1e6;

/** Optical frequency in Hz of a vacuum wavelength in nm. */
export const opticalFrequencyHz = (nm) => C_M_PER_S / (nm * 1e-9);

/** Rayleigh range in µm of a waist w0 (µm) at a wavelength (nm): π w0² / (M² λ). */
export const rayleighRangeUm = (w0Um, nm, m2 = 1) => (Math.PI * w0Um * w0Um) / (m2 * nm * 1e-3);

/** Waist in µm a lens of focal length f (mm) makes of a collimated beam of radius w (µm): M² λ f / (π w). */
export const waistAfterLensUm = (wInUm, fMm, nm, m2 = 1) => (m2 * nm * 1e-3 * fMm * 1e3) / (Math.PI * wInUm);

/** Peak intensity in W/cm² of a Gaussian of power P (W) and radii wx, wy (µm): 2P / (π wx wy). */
export const peakIntensityWcm2 = (powerW, wxUm, wyUm = wxUm) => (2 * powerW) / (Math.PI * wxUm * 1e-4 * wyUm * 1e-4);

// ───────────────────────────── vectors and complex numbers ─────────────────────────────
const add = (a, b) => a.map((v, k) => v + b[k]);
const scale = (a, s) => a.map((v) => v * s);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => scale(a, 1 / Math.hypot(...a));
const reflect = (v, n) => add(v, scale(n, -2 * dot(v, n)));
const cdiv = (a, b) => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
/** q' = (A q + B) / (C q + D) with a real matrix. */
const abcdQ = ([A, B, C, D], q) => cdiv({ re: A * q.re + B, im: A * q.im }, { re: C * q.re + D, im: C * q.im });
/** Radius w in mm of a beam parameter q (mm) at an effective wavelength λ·M² (mm). */
const radiusMm = (q, lambdaEffMm) => {
  const inv = cdiv({ re: 1, im: 0 }, q);
  return Math.sqrt(-lambdaEffMm / (Math.PI * inv.im));
};
/** Beam parameter of a waist w0 (mm) at distance z past it. */
const qOf = (w0Mm, lambdaEffMm, z = 0) => ({ re: z, im: (Math.PI * w0Mm * w0Mm) / lambdaEffMm });

// ───────────────────────────── sources and elements ─────────────────────────────
/** A laser source: a waist w0 (µm) at the start of the train. */
export function gaussian({ lambdaNm, w0Um, m2 = 1, powerW = 1, w0yUm = w0Um, name }) {
  return { kind: "source", lambdaNm, w0Um, w0yUm, m2, powerW, name };
}
/** Free space of length d (mm). Trains place elements with `at`, so this is mostly for direct use. */
export const space = (dMm) => ({ kind: "space", dMm });
/** Thin spherical lens of focal length f (mm). */
export const lens = (fMm, extra = {}) => ({ kind: "lens", fMm, ...extra });
/** Thin cylindrical lens acting on the beam's local x or y axis. */
export const cylLens = (fMm, axis, extra = {}) => ({ kind: "cylLens", fMm, axis, ...extra });
/** Flat fold mirror: reflects the direction and the local frame about `normal`. */
export const mirror = ({ normal, reflectivity = 1, ...extra }) => ({ kind: "mirror", normal, reflectivity, ...extra });
/** Curved mirror of radius R (mm): a lens of focal length R/2 and a fold. */
export const curvedMirror = (rMm, { normal, reflectivity = 1, ...extra }) => ({ kind: "curvedMirror", rMm, normal, reflectivity, ...extra });
/**
 * Acousto-optic deflector on one local axis. First diffraction order: angle
 * θ = sign · λ (f_RF − f_centre) / v_acoustic, optical frequency shifted by +f_RF, power × efficiency.
 * `sign` is the mounting orientation (which way a higher RF tilts the beam).
 */
export const aod = ({ vAcousticMPerS, apertureMm, efficiency = 1, axis = "x", centreHz, sign = 1, ...extra }) =>
  ({ kind: "aod", vAcousticMPerS, apertureMm, efficiency, axis, centreHz, sign, ...extra });
/** Acousto-optic modulator on its first order: frequency shift +f_RF, power × efficiency, no steering. */
export const aom = ({ centreHz, efficiency = 1, ...extra }) => ({ kind: "aom", centreHz, efficiency, ...extra });
/** Single-mode fiber: the fundamental mode with radius MFD/2 leaves the tip; power × coupling. */
export const fiber = ({ mfdUm, couplingEfficiency = 1, ...extra }) => ({ kind: "fiber", mfdUm, couplingEfficiency, ...extra });
/** Microscope objective: a thin lens of focal length f whose pupil has radius f · NA. */
export const objective = ({ fMm, na, ...extra }) => ({ kind: "objective", fMm, na, ...extra });
/** Beam splitter or dichroic: passes (no normal) or folds (with a normal), power × transmission. */
export const beamSplitter = ({ transmission = 0.5, normal, ...extra }) => ({ kind: "beamSplitter", transmission, normal, ...extra });
export const dichroic = ({ transmission = 0.95, normal, ...extra }) => ({ kind: "dichroic", transmission, normal, ...extra });

// ───────────────────────────── tracing ─────────────────────────────
/**
 * Trace a train. train = { source, start: [x,y,z] mm, dir, xAxis?, elements: [{ kind, at, label, … }],
 * endMm?, plane?: { point, normal } }. `at` is the distance in mm from the previous element (from
 * the start for the first). drive = { rfHz: { label: Hz }, powerFraction }.
 * Returns { segments, elements, focus, plane, warnings, lambdaNm, opticalHz, powerW }.
 * `focus` is the waist after the last element, per axis; `plane` is where the beam centre
 * crosses train.plane, when given.
 */
export function traceTrain(train, drive = {}) {
  const src = train.source;
  const lambdaMm = src.lambdaNm * 1e-6;
  let m2 = src.m2 ?? 1;
  let leff = lambdaMm * m2;
  let qx = qOf(src.w0Um / 1000, leff), qy = qOf((src.w0yUm ?? src.w0Um) / 1000, leff);
  // Centre ray per axis: offset h (mm) and angle θ (rad) in the local frame.
  const ray = { x: { h: 0, t: 0 }, y: { h: 0, t: 0 } };
  let pos = train.start.slice(), dir = unit(train.dir);
  let ux = train.xAxis ? unit(train.xAxis) : unit(Math.abs(dir[2]) > 0.99 ? cross([0, 1, 0], dir) : cross([0, 0, 1], dir));
  ux = unit(add(ux, scale(dir, -dot(ux, dir))));
  let uy = cross(dir, ux);
  let powerW = (src.powerW ?? 1) * (drive.powerFraction ?? 1);
  let opticalHz = opticalFrequencyHz(src.lambdaNm);
  const warnings = [], segments = [], elements = [];
  const centre = (p, d = 0) => add(add(p, scale(ux, ray.x.h + ray.x.t * d)), scale(uy, ray.y.h + ray.y.t * d));
  const sample = (p, d) => {
    const a = abcdQ([1, d, 0, 1], qx), b = abcdQ([1, d, 0, 1], qy);
    return { at: centre(add(p, scale(dir, d)), d), wxUm: radiusMm(a, leff) * 1000, wyUm: radiusMm(b, leff) * 1000 };
  };
  /** Free space of length d from the current position, recorded as one segment. */
  const go = (d) => {
    if (d <= 0) return;
    const n = Math.max(2, Math.min(48, Math.ceil(d / 5) + 1));
    const samples = [];
    for (let k = 0; k < n; k++) {
      const s = (d * k) / (n - 1);
      samples.push({ s, ...sample(pos, s) });
    }
    segments.push({ a: samples[0].at, b: samples.at(-1).at, axisA: pos.slice(), axisB: add(pos, scale(dir, d)), samples });
    for (const r of [ray.x, ray.y]) r.h += r.t * d;
    qx = abcdQ([1, d, 0, 1], qx);
    qy = abcdQ([1, d, 0, 1], qy);
    pos = add(pos, scale(dir, d));
  };
  const lensOn = (axes, f) => {
    for (const axis of axes) {
      const r = ray[axis];
      r.t -= r.h / f;
      if (axis === "x") qx = abcdQ([1, 0, -1 / f, 1], qx);
      else qy = abcdQ([1, 0, -1 / f, 1], qy);
    }
  };
  const fold = (normal) => {
    const n = unit(normal);
    dir = unit(reflect(dir, n));
    ux = unit(reflect(ux, n));
    uy = unit(reflect(uy, n));
  };
  for (const e of train.elements) {
    go(e.at ?? 0);
    const wx = radiusMm(qx, leff) * 1000, wy = radiusMm(qy, leff) * 1000;
    const rf = drive.rfHz?.[e.label];
    switch (e.kind) {
      case "space":
        go(e.dMm);
        break;
      case "lens":
        lensOn(["x", "y"], e.fMm);
        break;
      case "cylLens":
        lensOn([e.axis], e.fMm);
        break;
      case "objective": {
        const pupil = e.fMm * e.na;
        if (Math.max(wx, wy) / 1000 > pupil) warnings.push(e.label + ": the beam (w = " + (Math.max(wx, wy) / 1000).toFixed(2) + " mm) overfills the pupil of radius " + pupil.toFixed(2) + " mm and is clipped.");
        lensOn(["x", "y"], e.fMm);
        break;
      }
      case "mirror":
        fold(e.normal);
        powerW *= e.reflectivity ?? 1;
        break;
      case "curvedMirror":
        lensOn(["x", "y"], e.rMm / 2);
        fold(e.normal);
        powerW *= e.reflectivity ?? 1;
        break;
      case "beamSplitter":
      case "dichroic":
        if (e.normal) fold(e.normal);
        powerW *= e.transmission ?? 1;
        break;
      case "aod": {
        const f = rf ?? e.centreHz;
        const theta = (e.sign ?? 1) * (lambdaMm * 1e-3 * (f - e.centreHz)) / e.vAcousticMPerS;
        ray[e.axis].t += theta;
        if (e.apertureMm && 2 * Math.max(wx, wy) / 1000 > e.apertureMm) warnings.push(e.label + ": the beam is wider than the AOD aperture " + e.apertureMm + " mm.");
        opticalHz += f;
        powerW *= e.efficiency ?? 1;
        break;
      }
      case "aom":
        opticalHz += rf ?? e.centreHz;
        powerW *= e.efficiency ?? 1;
        break;
      case "fiber": {
        const w = e.mfdUm / 2000;
        m2 = 1;
        leff = lambdaMm;
        qx = qOf(w, leff);
        qy = qOf(w, leff);
        ray.x = { h: 0, t: 0 };
        ray.y = { h: 0, t: 0 };
        powerW *= e.couplingEfficiency ?? 1;
        break;
      }
      default:
        warnings.push("Unknown element kind " + e.kind + ".");
    }
    elements.push({ label: e.label, kind: e.kind, at: pos.slice(), wxUm: radiusMm(qx, leff) * 1000, wyUm: radiusMm(qy, leff) * 1000, source: e.source });
  }
  // The waist after the last element, per axis.
  const toWaist = (q) => -q.re;
  const zx = toWaist(qx), zy = toWaist(qy);
  const waist = (q, z) => radiusMm(abcdQ([1, z, 0, 1], q), leff) * 1000;
  const w0x = waist(qx, Math.max(0, zx)), w0y = waist(qy, Math.max(0, zy));
  const zFocus = Math.max(0, (zx + zy) / 2);
  // Where the centre crosses the sample plane, when the train names one.
  let plane = null, zPlane = null;
  if (train.plane) {
    const n = unit(train.plane.normal), denom = dot(dir, n);
    if (Math.abs(denom) > 1e-12) {
      // Solve along the centre ray: the offset grows with the angle, so iterate twice.
      let d = dot(add(train.plane.point, scale(pos, -1)), n) / denom;
      for (let k = 0; k < 3; k++) {
        const p = centre(add(pos, scale(dir, d)), d);
        d += dot(add(train.plane.point, scale(p, -1)), n) / denom;
      }
      zPlane = d;
      const s = sample(pos, d);
      plane = { at: s.at, wxUm: s.wxUm, wyUm: s.wyUm, distanceMm: d };
    }
  }
  const tail = Math.max(zFocus, zPlane ?? 0) + (train.endMm ?? 0);
  const focusPoint = sample(pos, zFocus).at;
  go(tail);
  const zRx = rayleighRangeUm(w0x, src.lambdaNm, m2), zRy = rayleighRangeUm(w0y, src.lambdaNm, m2);
  return {
    lambdaNm: src.lambdaNm, opticalHz, powerW, segments, elements, warnings,
    focus: {
      at: focusPoint, wxUm: w0x, wyUm: w0y, zRxUm: zRx, zRyUm: zRy, distanceXmm: zx, distanceYmm: zy,
      divergenceRad: (m2 * lambdaMm * 1000) / (Math.PI * Math.min(w0x, w0y)),
      powerW, peakWcm2: peakIntensityWcm2(powerW, w0x, w0y), opticalHz,
    },
    plane,
  };
}

// ───────────────────────────── colour ─────────────────────────────
/**
 * Display colour of a vacuum wavelength: the common piecewise-linear approximation of the
 * visible spectrum (380–750 nm, after Dan Bruton's table), dimmed toward the ends. Outside the
 * visible range there is no colour to show: ultraviolet below 380 nm is drawn violet-white and
 * infrared above 750 nm deep red to magenta, and `falseColour` is true.
 */
export function wavelengthRgb(nm) {
  if (nm < 380) return { rgb: [0.62, 0.45, 1], falseColour: true };
  if (nm > 750) {
    // Infrared: deeper magenta with wavelength, so 780, 850 and 1013 nm stay distinguishable.
    const t = Math.min(1, (nm - 750) / 350);
    return { rgb: [0.95, 0.15 + 0.1 * (1 - t), 0.25 + 0.55 * t], falseColour: true };
  }
  let r = 0, g = 0, b = 0;
  if (nm < 440) [r, g, b] = [-(nm - 440) / 60, 0, 1];
  else if (nm < 490) [r, g, b] = [0, (nm - 440) / 50, 1];
  else if (nm < 510) [r, g, b] = [0, 1, -(nm - 510) / 20];
  else if (nm < 580) [r, g, b] = [(nm - 510) / 70, 1, 0];
  else if (nm < 645) [r, g, b] = [1, -(nm - 645) / 65, 0];
  else [r, g, b] = [1, 0, 0];
  const edge = nm < 420 ? 0.3 + (0.7 * (nm - 380)) / 40 : nm > 700 ? 0.3 + (0.7 * (750 - nm)) / 50 : 1;
  return { rgb: [r, g, b].map((v) => Math.max(0, v * edge)), falseColour: false };
}
