// Krinner et al., EPJ Quantum Technology 6, 2 (2019), Table 1 and Figs. 3–4.
// Dimensions are mm. Heights and flange outside diameters are installation choices.
const source = "https://doi.org/10.1140/epjqt/s40507-019-0072-0";
const feedZ = 184;
const stages = [
  // key, nominal station, referenced empty-fridge temperature, local y, OD, incoming cable length, attenuation.
  ["rt", "Room-temperature vacuum flange", "room temperature", 1060, 620, 0, 0],
  ["50k", "50 K plate", "35 K", 870, 572, 200, 0],
  ["4k", "4 K plate", "2.85 K", 590, 536, 290, 20],
  ["still", "Still", "882 mK", 350, 500, 250, 0],
  ["cp", "Cold plate", "82 mK", 190, 478, 170, 20],
  ["mxc", "Mixing chamber", "6 mK", 60, 460, 140, 20],
];

// Bend the centerline for strain relief. Solve for the small lateral excursion
// that makes the *drawn polyline* exactly as long as the Table 1 cable.
function strainRelief(start, end, length) {
  const deltaY = end[1] - start[1];
  function points(excursion) {
    return Array.from({ length: 17 }, (_, i) => {
      const t = i / 16;
      return [
        start[0],
        start[1] + t * deltaY,
        start[2] - excursion * Math.sin(Math.PI * t) ** 2,
      ];
    });
  }
  let low = 0, high = length;
  for (let i = 0; i < 44; i++) {
    const mid = (low + high) / 2;
    const path = points(mid);
    const arc = path.slice(1).reduce((sum, p, j) =>
      sum + Math.hypot(p[1] - path[j][1], p[2] - path[j][2]), 0);
    if (arc < length) low = mid;
    else high = mid;
  }
  return points((low + high) / 2).slice(1, -1);
}

export function cryoInstallation({ device, inputs, chip, add, route, electronics = [] }) {
  const world = (p) => p.map((v, i) => v + device.centerMm[i]);
  const assumptions = "Reference installation. Plate diameters, heights and support dimensions are design assumptions.";
  const stagesBasis = "Krinner et al. Table 1 empty-fridge temperatures and Fig. 3 drive-line topology. " + source;
  const thermalBasis = "Krinner et al. Fig. 4 copper thermalization clamp. Housing dimensions are illustrative. " + source;
  add("cryo-stand", "Room-temperature support frame", "cryo-stand",
    [0, 424, 0], [720, 1268, 640], assumptions);
  const plates = stages.map(([key, label, temperature, y, diameter], i) => {
    const plate = add(i === 0 ? "cryostat" : "plate-" + key,
      i === 0 ? label : label + " · " + temperature,
      i < 3 ? "cryo-silver-plate" : "cryo-copper-plate", [0, y, 0], [diameter, i === 0 ? 16 : 12, diameter],
      stagesBasis + " " + assumptions + " The exposed sector shows the thermalization insert.");
    if (i) {
      const above = stages[i - 1][3];
      add("hangers-" + key, label + " suspension", "cryo-hangers",
        [0, (above + y) / 2, -85], [246, above - y, 66],
        "Illustrative low-conductivity interstage support locations.");
    }
    return plate;
  });
  // Leave the front sector open in the *drawing* to expose the cold stages.
  // Krinner §2.3 specifies Al shields on 50 K/4 K and Cu on still/MXC.
  for (const [key, station, bottom, form] of [
    ["vacuum-jacket", 0, -110, "cryo-jacket"],
    ["shield-50k", 1, -90, "cryo-al-shield"],
    ["shield-4k", 2, -70, "cryo-al-shield"],
    ["shield-still", 3, -48, "cryo-cu-shield"],
    ["shield-mxc", 5, -26, "cryo-cu-shield"],
  ]) {
    const [ , label, , top, diameter] = stages[station];
    add(key, station ? label + " radiation shield · cutaway" : "Outer vacuum vessel · cutaway",
      form, [0, (top + bottom) / 2, 0], [diameter - 2, top - bottom, diameter - 2],
      "Rear sector of the enclosure shown for access to the signal route. Shield materials and nesting follow Krinner et al. §2.3. Wall thickness, radius and length are design choices. " + source);
  }

  const [x0, z0, x1, z1] = device.layout.chip.boundsMm;
  const depth = device.layout.chip.substrateThicknessMm;
  const sign = device.mounting?.faceDown ? -1 : 1;
  const middleX = (x0 + x1) / 2, middleZ = sign * (z0 + z1) / 2;
  const width = x1 - x0 + 20, spanZ = z1 - z0 + 14;
  const carrier = add("mount", "Cold package · RF launch board", "cryo-launch-board",
    [middleX, -sign * depth / 2, middleZ], [width, depth, spanZ],
    "Illustrative single-die RF package. A perimeter board brings signals to the native Metal die. The board thickness matches the substrate to align the active surfaces.");
  add("package-base", "Machined copper package base", "cryo-package-base",
    [middleX, -sign * (depth + 2.5), middleZ], [width + 4, 5, spanZ + 4],
    "Illustrative copper backing contacts the substrate backside and the launch-board backside.");
  // The chip and cold plate are mechanically connected, while the active die face remains accessible.
  for (const side of [-1, 1]) {
    const atX = middleX + side * (width / 2 + 1);
    const baseY = -sign * (depth + 2.5);
    add("package-standoff-" + (side < 0 ? "left" : "right"), "Cold package mounting pillar", "cryo-pillar",
      [atX, (54 + baseY) / 2, middleZ - spanZ / 2], [1.8, 54 - baseY, 1.8],
      "Assumed copper thermal and mechanical connection from package base to the underside of the mixing-chamber plate.");
  }

  for (const [i, probe] of inputs.entries()) {
    const lane = (i + 0.5) / inputs.length - 0.5;
    const cableX = lane * 72;
    const line = [probe];
    const fittings = stages.map(([key, label, , y, , , atten], j) => {
      const form = j === 0 ? "cryo-bulkhead" : atten ? "cryo-attenuator" : "cryo-clamp";
      const role = j === 0 ? "vacuum feedthrough" : atten ? "20 dB attenuator" : "outer-conductor clamp";
      return add(key + "-line-" + i, label + " · " + role + " · " + probe, form,
        [cableX, y, feedZ], [11, j === 0 ? 28 : atten ? 26 : 15, 11],
        (j === 0 ? "Illustrative hermetic coaxial feedthrough based on Fig. 4(f). " + source : thermalBasis) +
        (atten ? " The 20 dB nameplate identifies the paper's C3 drive configuration. Propagated control values are normalized envelopes." : ""));
    });
    const sourcePart = electronics.find((p) => p.id === probe);
    const startY = sourcePart?.centerMm[1] ?? device.centerMm[1] - 210;
    const startZ = sourcePart?.centerMm[2] ?? device.centerMm[2];
    const riserX = 368 + lane * 30, topY = stages[0][3] + 36 + lane * 12;
    route(probe, fittings[0], "External warm microwave coax", line, undefined, undefined, {
      signal: "electrical", diameterMm: 3.6,
      basis: "Assumed flexible external jumper. The controller and feedthrough positions determine the centerline length.",
      viaMm: [
        [device.centerMm[0] + riserX, startY, startZ],
        [device.centerMm[0] + riserX, startY + 20, device.centerMm[2] + feedZ],
        world([riserX, topY - 15, feedZ]),
        world([riserX - 15, topY, feedZ]),
        world([cableX + 15, topY, feedZ]),
        world([cableX, topY - 15, feedZ]),
      ],
    });
    for (let j = 1; j < stages.length; j++) {
      const [ , label, , y, , cableLengthMm, referenceAttenuationDb] = stages[j];
      const start = world([cableX, stages[j - 1][3], feedZ]);
      const end = world([cableX, y, feedZ]);
      route(fittings[j - 1], fittings[j], "Thermalized UT-085 coax to " + label,
        line, undefined, undefined, {
          signal: "electrical", cableLengthMm, diameterMm: 0.085 * 25.4, referenceAttenuationDb,
          basis: "Krinner et al. Table 1 gives the coax length to this stage. Fig. 3b gives the receiving-stage drive attenuation. The bend shape and flange spacing are assumed. " + source,
          viaMm: strainRelief(start, end, cableLengthMm),
        });
    }
    const entryZ = lane * Math.min(spanZ - 4, 14);
    const contact = [-width / 2, sign * depth / 2, entryZ];
    const entryX = middleX + contact[0], z = middleZ + entryZ;
    route(fittings.at(-1), carrier, "MXC to cold package launch", line, undefined, contact, {
      signal: "electrical", diameterMm: 2.159,
      basis: "Illustrative short microwave jumper from the mixing chamber to the package edge.",
      viaMm: [
        world([cableX, 39, feedZ]),
        world([entryX - 25, 12, z + 24]),
        world([entryX - 12, 0, z]),
      ],
    });
    route(carrier, chip, "Package launch to transmon drive pin", line, contact);
  }
  return plates[0];
}
