import { neutralInstallation } from "./neutral-installation.mjs";
import { ionInstallation } from "./ion-installation.mjs";
import { cryoInstallation } from "./cryo-installation.mjs";
import { physicalRoute, pathLengthMm } from "./wiring.mjs";
import { deliveryBranches } from "./installation-display.mjs";

// All coordinates are millimetres. Routes carrying a probe are lowered by delivery.mjs.
export function apparatus(device, electronics, wires, version = 2) {
  if (version !== 1 && version !== 2)
    throw Error("Unknown installation geometry version");
  const [x, y, z] = device.centerMm,
    parts = [],
    links = [];
  const occupied = new Set([...electronics, ...wires].map((p) => p.id));
  let prefix = "@device/";
  while ([...occupied].some((id) => id.startsWith(prefix)))
    prefix = "@" + prefix;
  const id = (s) => prefix + s;
  function add(key, label, form, offset, sizeMm, basis) {
    const centerMm = [x + offset[0], y + offset[1], z + offset[2]];
    const p = {
      id: id(key),
      label,
      form,
      centerMm,
      sizeMm,
      basis:
        basis ??
        (form === "register"
          ? device.basis
          : "Illustrative installation envelope in millimetres."),
    };
    parts.push(p);
    return p.id;
  }
  function route(
    from,
    to,
    kind,
    probes = [],
    fromOffsetMm,
    toOffsetMm,
    options = {},
  ) {
    if (version === 1) {
      fromOffsetMm = undefined;
      toOffsetMm = undefined;
    }
    const find = (i) =>
      [...electronics, ...parts].find((p) => p.id === i).centerMm;
    const offset = (point, v) => (v ? point.map((n, i) => n + v[i]) : point);
    const a = offset(find(from), fromOffsetMm),
      b = offset(find(to), toOffsetMm),
      mid = a.map((v, i) => (v + b[i]) / 2);
    mid[1] += Math.min(18, Math.abs(a[0] - b[0]) * 0.08);
    const { viaMm, ...properties } = options;
    const link = {
      id: id("route-" + links.length),
      from,
      to,
      kind,
      pointsMm: [a, ...(viaMm ?? (device.mounting ? [] : [mid])), b],
      probes,
      devicePath: true,
      ...(fromOffsetMm ? { fromOffsetMm } : {}),
      ...(toOffsetMm ? { toOffsetMm } : {}),
      ...properties,
    };
    links.push(link);
    return link;
  }
  const chip = add(
    "register",
    device.label,
    "register",
    [0, 0, 0],
    device.kind === "transmon"
      ? [9, 0.75, 6]
      : device.kind === "ion"
        ? [8, 0.6, 3]
        : [0.3, 0.002, 0.38],
  );
  const inputs = device.drives.map((d) => d.probe);
  if (device.mounting?.layout === "published-topology-v1") {
    const build = {
      ion: ionInstallation,
      atom: neutralInstallation,
      transmon: cryoInstallation,
    }[device.kind];
    const main = build({ device, inputs, chip, add, route, electronics });
    for (const link of links) Object.assign(link, physicalRoute(link, device));
    for (const branch of deliveryBranches(device, { chip, links })) {
      const l = links.find((item) => item.id === branch.link);
      (l.branches ??= []).push({
        ...branch,
        lengthMm: pathLengthMm(branch.pointsMm),
      });
    }
    return { version, parts, links, chip, main };
  }
  if (device.kind === "transmon") {
    const fridge = add(
      "cryostat",
      "Dilution refrigerator",
      "cryostat",
      [0, 80, 0],
      [172, 192, 172],
    );
    const carrier = add(
      "mount",
      "Cold chip package",
      "mount",
      [
        0,
        version === 1 ? -3 : -device.layout.chip.substrateThicknessMm - 3.2,
        0,
      ],
      [28, 5.5, 22],
    );
    for (const [i, probe] of inputs.entries()) {
      const coax = add(
        "coax-" + i,
        "Cryogenic line " + (i + 1),
        "coax",
        [-62 + i * 22, 115, -34],
        [9, 30, 9],
      );
      route(probe, coax, "Microwave coax", [probe]);
      route(coax, carrier, "Attenuated drive line", [probe], undefined, [
        -14,
        0,
        ((i % 5) - 2) * 2,
      ]);
    }
    route(carrier, chip, "Chip launch", inputs, [-14, 0, 0]);
    return {
      ...(version === 2 ? { version } : {}),
      parts,
      links,
      chip,
      main: fridge,
    };
  }
  const chamber = add(
    "chamber",
    "UHV chamber",
    "chamber",
    [0, -12, 0],
    [106, 99, 106],
  );
  const source = add(
    "light",
    "Laser head",
    "laser",
    [-140, -71, 58],
    [64, 36, 38],
  );
  const mod = add(
    "optics",
    device.kind === "atom" ? "Crossed AODs" : "Beam modulator",
    "aod",
    [-66, -63, 62],
    [42, 44, 38],
  );
  const objective = add(
    "objective",
    device.kind === "atom" ? "Tweezer objective" : "Addressing objective",
    "objective",
    [0, 54, 0],
    [32, 63, 32],
  );
  add("table", "Optical breadboard", "table", [-50, -110, 15], [311, 12, 191]);
  if (device.kind === "ion") {
    const feed = add(
      "feedthrough",
      "Electrode feedthrough",
      "feedthrough",
      [65, -26, 0],
      [28, 26, 28],
    );
    route(feed, chip, "Trap electrode wiring", [], undefined, [
      device.layout.spanMm / 2,
      -0.18,
      0,
    ]);
  }
  for (const probe of inputs) route(probe, mod, "RF drive", [probe]);
  route(source, mod, "Laser light");
  route(mod, objective, "Optical delivery", inputs);
  route(objective, chip, "Focused beam", inputs, [0, -29, 0]);
  return {
    ...(version === 2 ? { version } : {}),
    parts,
    links,
    chip,
    main: chamber,
  };
}
