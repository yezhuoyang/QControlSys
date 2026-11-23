// The physical coordinate system is millimetres. Only the overview uses this
// invertible radial map. Every vertex and route shares the same fixed point.
export function installedPoint(device, local) {
  return local.map(
    (v, i) =>
      device.centerMm[i] + (device.mounting?.faceDown && i > 0 ? -v : v),
  );
}

export function registerLens(device) {
  const lo = [Infinity, Infinity, Infinity],
    hi = lo.map(() => -Infinity);
  for (const { positionMm } of device.qubits)
    for (let axis = 0; axis < 3; axis++) {
      const v =
        device.mounting?.faceDown && axis > 0
          ? -positionMm[axis]
          : positionMm[axis];
      lo[axis] = Math.min(lo[axis], v);
      hi[axis] = Math.max(hi[axis], v);
    }
  const center = lo.map((x, i) => device.centerMm[i] + (x + hi[i]) / 2);
  // Keep planar electrode surfaces planar even where the radial scale changes.
  if (device.kind !== "atom") center[1] = device.centerMm[1];
  const padding =
    device.kind === "atom"
      ? Math.min(...device.layout.slms.map((s) => Math.min(...s.pitchMm)))
      : device.kind === "transmon"
        ? 0.48
        : 0.12;
  const inner =
    Math.hypot(
      ...hi.map((v, i) =>
        Math.max(
          Math.abs(device.centerMm[i] + v - center[i]),
          Math.abs(device.centerMm[i] + lo[i] - center[i]),
        ),
      ),
    ) + padding;
  const enlarged = Math.max(inner, 90);
  return { center, inner, enlarged, outer: Math.max(230, enlarged * 2) };
}

export function radiusScale(r, { inner, enlarged, outer }) {
  if (r <= inner) return enlarged / inner;
  if (r >= outer) return 1;
  return (enlarged + ((r - inner) * (outer - enlarged)) / (outer - inner)) / r;
}

// A delivery branch describes where an already observed output is directed.
// This is geometry for the binding, with no extra simulation time.
export function deliveryBranches(device, equipment) {
  const qubits = new Map(device.qubits.map((q) => [q.id, q]));
  return device.drives.flatMap(({ probe, targets }) => {
    const end = equipment.links.find(
      (l) => l.to === equipment.chip && l.probes.includes(probe),
    );
    if (!end) return [];
    const source = end.pointsMm[0];
    return targets.map((target) => {
      const q = qubits.get(target);
      const siteMm = installedPoint(device, q.positionMm);
      const endMm = [...siteMm];
      if (device.kind === "transmon" && device.layout.drivePinMm) {
        endMm[0] += device.layout.drivePinMm[0];
        endMm[2] += device.layout.drivePinMm[1];
      }
      const pointsMm = [source];
      if (device.kind === "transmon" && device.mounting) {
        const [x0, z0, , z1] = device.layout.chip.boundsMm;
        const side =
          device.qubits.findIndex((other) => other.id === q.id) % 2 ? 1 : -1;
        const lane = device.centerMm[2] + (side > 0 ? z1 * 0.32 : z0 * 0.32);
        const y = endMm[1] + 0.003,
          approach = endMm[0] - 0.12;
        pointsMm.push(
          [device.centerMm[0] + x0, y, lane],
          [approach, y, lane],
          [approach, y, endMm[2]],
        );
      } else if (device.kind === "transmon")
        pointsMm.push([
          device.centerMm[0] + device.layout.chip.boundsMm[0],
          endMm[1] + 0.003,
          endMm[2],
        ]);
      pointsMm.push(endMm);
      return {
        probe,
        target,
        from: end.from,
        link: end.id,
        sourceMm: source,
        siteMm,
        endMm,
        pointsMm,
      };
    });
  });
}

// The executor puts the producing event first, followed by state dependencies.
// Follow that producing chain to label the electronic path for a delivered sample.
export function producingParts(frames, event) {
  const parts = new Set(),
    wires = new Set();
  for (let f = frames[event]; f; f = frames[f.parents[0]]) {
    parts.add(f.part);
    if (f.wire) wires.add(f.wire);
    if (f.part !== frames[event].part && f.pc != null && !f.native) break;
  }
  return { parts: [...parts].reverse(), wires: [...wires].reverse() };
}
