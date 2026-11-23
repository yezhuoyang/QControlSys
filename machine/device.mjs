// A register is a physical inventory. Each drive observation inherits the original
// Lean receive event, time and causal parents. Replay never fabricates a qubit state.
export function validateDevice(device, parts) {
  if (device === undefined) return;
  function require(ok, message) {
    if (!ok) throw Error("Quantum device — " + message);
  }
  const name = (x) => typeof x === "string" && x.length > 0 && x.length <= 160;
  const vector = (v, n) =>
    Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  const positive = (x) => Number.isFinite(x) && x > 0;
  require(device &&
    ["ion", "atom", "transmon"].includes(device.kind), "unknown device type.");
  require(name(device.label) &&
    vector(device.centerMm, 3), "supply a label and center in mm.");
  if (device.mounting !== undefined)
    require(device.mounting?.layout === "published-topology-v1" &&
      device.mounting.faceDown === (device.kind === "ion"), "invalid orientation for the selected reference mounting.");
  require(Array.isArray(device.qubits) &&
    device.qubits.length > 0 &&
    device.qubits.length <= 10000, "invalid register size.");
  const ids = new Set(),
    sites = new Set();
  for (const q of device.qubits) {
    require(q &&
      name(q.id) &&
      name(q.site) &&
      vector(q.positionMm, 3) &&
      !ids.has(q.id), "invalid or duplicate qubit.");
    ids.add(q.id);
  }
  require(Array.isArray(device.drives), "supply physical drive bindings.");
  const probes = new Set();
  for (const d of device.drives) {
    require(d &&
      !probes.has(d.probe) &&
      parts.find((p) => p.id === d.probe)?.model?.probe?.signal ===
        "voltageUv", "each drive needs a unique voltage probe: " + d?.probe);
    require(Array.isArray(d.targets) &&
      d.targets.length > 0 &&
      new Set(d.targets).size === d.targets.length &&
      d.targets.every((id) =>
        ids.has(id),
      ), "unknown or duplicate drive recipient.");
    probes.add(d.probe);
  }
  const l = device.layout;
  require(l && typeof l === "object", "missing physical layout.");
  if (device.kind === "ion") {
    require(positive(l.spanMm) &&
      positive(l.widthMm) &&
      Array.isArray(l.sites) &&
      Array.isArray(l.edges), "invalid trap layout.");
    for (const s of l.sites) {
      require(name(s.id) &&
        !sites.has(s.id) &&
        Number.isFinite(s.x) &&
        Number.isFinite(s.z), "invalid trap site.");
      sites.add(s.id);
    }
    require(l.edges.every(
      (e) => Array.isArray(e) && e.length === 2 && e.every((n) => sites.has(n)),
    ), "unknown rail endpoint.");
  } else if (device.kind === "atom") {
    require(Array.isArray(l.slms) &&
      l.slms.length > 0 &&
      l.slms.every(
        (s) =>
          vector(s.originMm, 2) &&
          vector(s.pitchMm, 2) &&
          s.pitchMm.every(positive) &&
          Number.isSafeInteger(s.rows) &&
          s.rows > 0 &&
          Number.isSafeInteger(s.cols) &&
          s.cols > 0,
      ), "invalid tweezer grid.");
  } else {
    require(l.drivePinMm === undefined || vector(l.drivePinMm,2), "invalid transmon drive pin.");
    require(vector(l.chip?.boundsMm, 4) &&
      l.chip.boundsMm[2] > l.chip.boundsMm[0] &&
      l.chip.boundsMm[3] > l.chip.boundsMm[1] &&
      positive(l.chip.substrateThicknessMm), "invalid chip dimensions.");
    const path = (v, min) =>
      Array.isArray(v) && v.length >= min && v.every((p) => vector(p, 2));
    require(Array.isArray(l.metalPolygons) &&
      l.metalPolygons.some((p) => p.role === "ground") &&
      l.metalPolygons.every(
        (p) =>
          path(p.points, 3) &&
          Array.isArray(p.holes) &&
          p.holes.every((h) => path(h, 3)),
      ) &&
      Array.isArray(l.junctions) &&
      l.junctions.every(
        (j) => path(j.points, 2) && positive(j.widthMm),
      ), "invalid transmon mask.");
  }
}

export function deviceActivity(device, frames) {
  const bindings = new Map(device.drives.map((d) => [d.probe, d.targets]));
  return frames
    .filter(
      (f) =>
        f.op !== "fault" && f.received?.[0] === "in" && bindings.has(f.part),
    )
    .map((f) => ({
      event: f.id,
      atPs: f.atPs,
      probe: f.part,
      valueUv: f.received[1],
      targets: bindings.get(f.part),
    }));
}
