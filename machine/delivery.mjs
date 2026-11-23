import { apparatus } from "./apparatus.mjs";
import { deliveryBranches } from "./installation-display.mjs";

// Lower the drive envelope into existing executable Fabric wires, identity
// transducers and terminal probes. The geometry used here is always physical.
export function lowerDelivery(device, parts, wires) {
  if (!device?.propagation) return;
  const timing = device.propagation;
  for (const key of [
    "electricalMmPerNs",
    "opticalMmPerNs",
    ...(timing.fiberMmPerNs === undefined ? [] : ["fiberMmPerNs"]),
  ])
    if (
      !Number.isFinite(timing[key]) ||
      timing[key] <= 0 ||
      timing[key] > 299.792458
    )
      throw Error("Invalid propagation speed in mm/ns: " + key);
  if (
    timing.stageDelayPs !== undefined &&
    (!timing.stageDelayPs ||
      typeof timing.stageDelayPs !== "object" ||
      Array.isArray(timing.stageDelayPs))
  )
    throw Error("Supply per-stage delays in ps.");
  for (const [stage, delay] of Object.entries(timing.stageDelayPs ?? {}))
    if (
      !["aod", "objective", "mount", "coax"].includes(stage) ||
      !Number.isSafeInteger(delay) ||
      delay < 0
    )
      throw Error("Invalid apparatus delay in ps for " + stage);
  const equipment = apparatus(device, parts, wires);
  const branches = deliveryBranches(device, equipment);
  const prefix = equipment.chip.slice(0, equipment.chip.lastIndexOf("/") + 1);
  const stages = [];
  const identity = () => ({
    affine: {
      input: "voltageUv",
      output: "voltageUv",
      numerator: 1,
      denominator: 1,
      offset: 0,
    },
  });
  const byId = new Map(equipment.parts.map((p) => [p.id, p]));
  for (const [i, drive] of device.drives.entries()) {
    const probe = parts.find((p) => p.id === drive.probe);
    probe.model = identity();
    let previous = probe.id,
      previousForm;
    const route = equipment.links.filter((l) => l.probes.includes(drive.probe));
    function add(stage, points, hardware, link, signal, branch) {
      const id = prefix + "ch" + i + "/" + stage,
        wire = id + "/line";
      const routeLink = equipment.links.find((l) => l.id === link);
      const lengthMm =
        routeLink?.cableLengthMm ??
        points
          .slice(1)
          .reduce(
            (sum, p, n) =>
              sum + Math.hypot(...p.map((v, k) => v - points[n][k])),
            0,
          );
      const speed =
        routeLink.interconnect?.speedMmPerNs ??
        (signal === "optical"
          ? /fiber/i.test(routeLink.kind)
            ? (timing.fiberMmPerNs ?? timing.opticalMmPerNs)
            : timing.opticalMmPerNs
          : timing.electricalMmPerNs);
      const delayPs =
        Math.max(1, Math.ceil((1000 * lengthMm) / speed)) +
        (timing.stageDelayPs?.[previousForm] ?? 0);
      if (!Number.isSafeInteger(delayPs))
        throw Error("Propagation delay exceeds exact time range.");
      parts.push({
        id,
        label: branch ? branch.target + " drive endpoint" : hardware.label,
        centerMm: branch ? branch.endMm : hardware.centerMm,
        sizeMm: branch ? [0.001, 0.001, 0.001] : hardware.sizeMm,
        model: branch ? { probe: { signal: "voltageUv" } } : identity(),
      });
      wires.push({
        id: wire,
        src: { part: previous, port: "out" },
        dst: { part: id, port: "in" },
        delayPs,
      });
      stages.push({
        id,
        wire,
        hardware: hardware.id,
        link,
        probe: drive.probe,
        delayPs,
        lengthMm,
        ...(branch ? { target: branch.target } : {}),
      });
      return id;
    }
    let sourceHardware = probe.id;
    for (const [n, l] of route.entries()) {
      if (l.from !== sourceHardware)
        throw Error(
          "Disconnected drive path from " + sourceHardware + " to " + l.from,
        );
      sourceHardware = l.to;
      const hardware = byId.get(l.to);
      if (l.to === equipment.chip) {
        for (const [j, b] of branches
          .filter((b) => b.probe === drive.probe)
          .entries())
          add(
            "target" + j,
            b.pointsMm,
            hardware,
            l.id,
            device.kind === "transmon" ? "electrical" : "optical",
            b,
          );
      } else {
        previous = add(
          "stage" + n,
          l.pointsMm,
          hardware,
          l.id,
          l.signal ??
            (l.kind === "Optical delivery" ? "optical" : "electrical"),
        );
        previousForm = hardware.form;
      }
    }
    if (sourceHardware !== equipment.chip)
      throw Error("No drive endpoint for " + probe.id);
  }
  return { stages };
}

export function terminalActivity(delivery, frames) {
  const receivers = new Map(
    delivery.stages.filter((s) => s.target !== undefined).map((s) => [s.id, s]),
  );
  return frames
    .filter(
      (f) =>
        f.op !== "fault" && f.received?.[0] === "in" && receivers.has(f.part),
    )
    .map((f) => {
      const s = receivers.get(f.part);
      return {
        event: f.id,
        atPs: f.atPs,
        probe: s.probe,
        receiver: s.id,
        valueUv: f.received[1],
        targets: [s.target],
      };
    });
}
