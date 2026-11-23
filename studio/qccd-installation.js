import * as T from "three";

const metal = 0x9baeb6,
  dark = 0x293d49,
  gold = 0xcaa45f,
  teal = 0x53c9c0;
const optical = 0xc5a2ff,
  on = 0xffc460,
  ceramic = 0x656477;

/** Project the native cycle driver onto the reference installation. Studio
 * supplies a single atomic cycle, so the association adds no rack latency. */
export function studioCycleParts(frame) {
  return frame?.physicalParts ?? [];
}

/** All mesh vertices, link centerlines, electrodes and ion centers use millimetres. */
export function buildQccdInstallation(system, run) {
  const root = new T.Group(),
    anchors = new Map(),
    bodies = new Map(),
    lamps = new Map();
  const geometries = new Set(),
    materials = new Set(),
    textures = new Set();
  const paints = new Map(),
    localSites = new Map(),
    ions = new Map(),
    tracks = new Map();
  const dimensions = new T.Group(),
    carrierDetails = new T.Group();
  let active = new Set(),
    selected;
  function mat(color) {
    if (!paints.has(color)) {
      const material = new T.MeshStandardMaterial({
        color,
        roughness: 0.52,
        metalness: 0.35,
      });
      materials.add(material);
      paints.set(color, material);
    }
    return paints.get(color);
  }
  function shape(parent, geometry, color, position) {
    geometries.add(geometry);
    const obj = new T.Mesh(geometry, mat(color));
    obj.position.fromArray(position);
    parent.add(obj);
    return obj;
  }
  const cube = new T.BoxGeometry(1, 1, 1),
    globe = new T.SphereGeometry(1, 12, 8);
  const cyl = new T.CylinderGeometry(1, 1, 1, 12);
  function box(p, x, y, z, w, h, d, c) {
    const block = shape(p, cube, c, [x, y, z]);
    block.scale.set(w, h, d);
    return block;
  }
  function bead(p, x, y, z, r, color) {
    const obj = shape(p, globe, color, [x, y, z]);
    obj.scale.setScalar(r);
    return obj;
  }
  function shaft(p, a, b, r, color) {
    const from = new T.Vector3(...a),
      to = new T.Vector3(...b);
    const d = to.clone().sub(from);
    const obj = shape(p, cyl, color, from.addScaledVector(d, 0.5).toArray());
    obj.scale.set(r, d.length(), r);
    obj.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.normalize());
    return obj;
  }
  function path(p, points, r, color) {
    for (let i = 1; i < points.length; i++)
      shaft(p, points[i - 1], points[i], r, color);
  }
  function label(p, text, x, y, z, w) {
    if (typeof document === "undefined") return;
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 80;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#17353d";
    ctx.fillRect(0, 0, 512, 80);
    ctx.fillStyle = "#e8fff5";
    ctx.font = "bold 40px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(text, 256, 55, 490);
    const map = new T.CanvasTexture(canvas);
    const material = new T.MeshBasicMaterial({ map, side: T.DoubleSide });
    textures.add(map);
    materials.add(material);
    const g = new T.PlaneGeometry(w, (w * 80) / 512);
    geometries.add(g);
    const tag = new T.Mesh(g, material);
    tag.position.set(x, y, z);
    tag.rotation.x = -Math.PI / 2;
    p.add(tag);
  }
  function chassis(p, id, w, h, d) {
    box(p, 0, 0, 0, w, h, d, dark);
    box(p, 0, 0, d / 2 - 1, w, h, 2, metal);
    for (const x of [-w * 0.46, w * 0.46]) {
      for (const y of [-h * 0.3, h * 0.3])
        shaft(p, [x, y, d / 2], [x, y, d / 2 + 2], 1.8, dark);
      shaft(p, [x, -h * 0.24, d / 2 + 4], [x, h * 0.24, d / 2 + 4], 1.8, metal);
    }
    for (let i = 0; i < 10; i++)
      box(p, -w * 0.33 + i * 6, 0, d / 2 + 0.2, 2.3, h * 0.42, 1, dark);
    for (let i = 0; i < 6; i++) {
      const x = w * 0.13 + i * 14;
      shaft(p, [x, 0, d / 2], [x, 0, d / 2 + 2], 3.2, gold);
      shaft(p, [x, 0, d / 2 + 2], [x, 0, d / 2 + 2.4], 1.7, dark);
    }
    lamps.set(id, bead(p, w * 0.01, 0, d / 2 + 1, 3, teal));
  }
  for (const part of system.parts) {
    const g = new T.Group();
    g.name = part.id;
    g.userData.part = part.id;
    g.position.fromArray(part.centerMm);
    bodies.set(part.id, g);
    anchors.set(part.id, g.position.clone());
    root.add(g);
    const [w, h, d] = part.sizeMm;
    switch (part.kind) {
      case "table":
        box(g, 0, 0, 0, w, h, d, 0x6c858d);
        for (let i = -5; i <= 5; i++)
          for (let j = -3; j <= 3; j++)
            shaft(
              g,
              [i * 96, h / 2, j * 97],
              [i * 96, h / 2 + 0.25, j * 97],
              2.3,
              dark,
            );
        break;
      case "rack":
        for (const x of [-w / 2 + 5, w / 2 - 5])
          for (const z of [-d / 2 + 5, d / 2 - 5])
            box(g, x, 0, z, 10, h, 10, metal);
        for (const y of [-h / 2 + 5, h / 2 - 5])
          for (const z of [-d / 2 + 5, d / 2 - 5])
            box(g, 0, y, z, w, 10, 10, metal);
        for (const y of [-h / 2 + 5, h / 2 - 5])
          for (const x of [-w / 2 + 5, w / 2 - 5])
            box(g, x, y, 0, 10, 10, d, metal);
        break;
      case "fpga":
      case "dac":
      case "receiver":
      case "laser":
        chassis(g, part.id, w, h, d);
        break;
      case "chamber":
        box(g, 0, -h / 2 + 5, 0, w, 10, d, metal);
        box(g, 0, 0, -d / 2 + 3, w, h, 6, metal);
        box(g, -w / 2 + 3, 0, 0, 6, h, d, metal);
        for (const x of [-w / 2 + 4, w / 2 - 4])
          for (const z of [-d / 2 + 4, d / 2 - 4])
            box(g, x, 0, z, 8, h, 8, metal);
        for (const x of [-w * 0.35, w * 0.35])
          shaft(g, [x, -2, -d / 2], [x, -2, -d / 2 + 8], 23, dark);
        break;
      case "feedthrough":
        shaft(g, [-w / 2, 0, 0], [w / 2, 0, 0], d / 2, metal);
        shaft(g, [-w / 2 - 0.2, 0, 0], [-w / 2, 0, 0], d * 0.36, ceramic);
        break;
      case "objective":
        shaft(g, [0, 0, -d / 2], [0, 0, d / 2], w / 2, dark);
        shaft(g, [0, 0, d / 2], [0, 0, d / 2 + 0.4], w * 0.37, optical);
        break;
      case "mount":
        box(g, 0, -h / 2 + 2, 0, w, 4, d, metal);
        shaft(g, [0, -h / 2 + 4, 0], [0, h / 2 - 2, 0], 9, metal);
        box(g, 0, h / 2 - 1, 0, 29, 2, 25, dark);
        break;
      case "carrier":
        box(g, 0, 0, 0, w, h, d, ceramic);
        for (const side of [-1, 1])
          for (let i = 0; i < 18; i++) {
            const x = (i - 8.5) * 1.4;
            box(g, x, h / 2 + 0.015, side * (d / 2 - 1), 0.65, 0.03, 1.7, gold);
          }
        break;
      case "chip":
        box(g, 0, 0, 0, w, h, d, 0x374452);
        for (const [side, z] of [
          [-1, -d * 0.37],
          [1, d * 0.37],
        ])
          for (let i = 0; i < 20; i++) {
            const x = (i - 9.5) * 0.37;
            box(g, x, h / 2 + 0.002, z, 0.21, 0.004, 0.24, gold);
            path(
              carrierDetails,
              [
                [x, h / 2, z],
                [x * 1.12, h / 2 + 0.33, z + side * 0.32],
                [x * 2.05, -0.25, side * 5],
              ],
              0.016,
              gold,
            );
          }
        g.add(carrierDetails, dimensions);
        break;
    }
  }
  const cableGroups = new Map();
  for (const l of system.links) {
    const g = new T.Group();
    g.name = l.id;
    g.userData.part = l.id;
    g.userData.eventPart = l.id;
    const isLight = l.kind.includes("fiber") || l.kind === "optical path";
    const col =
      l.kind === "data fiber"
        ? teal
        : isLight
          ? optical
          : l.kind === "package bond"
            ? gold
            : 0x597386;
    const radius =
      l.kind === "package bond"
        ? 0.022
        : l.kind === "optical path"
          ? 0.15
          : isLight
            ? 1.6
            : 2.5;
    path(g, l.pointsMm, radius, col);
    root.add(g);
    cableGroups.set(l.id, g);
    anchors.set(
      l.id,
      new T.Vector3(...l.pointsMm[Math.floor(l.pointsMm.length / 2)]),
    );
  }
  const chip = bodies.get("chip"),
    chipData = system.parts.find((p) => p.id === "chip");
  const c = system.chipModel,
    surface = chipData.sizeMm[1] / 2,
    ionY = surface + c.ionHeightMm;
  anchors.set("trap", chip.position.clone());
  const layout = new T.Group();
  chip.add(layout);
  const segmentObjects = new Map();
  function electrode(id, x, z, width, depth, gate = false) {
    const pad = box(
      layout,
      x,
      surface + 0.003,
      z,
      width,
      0.006,
      depth,
      gate ? 0xa697be : gold,
    );
    pad.userData.eventPart = id;
    localSites.set(id, new T.Vector3(x, ionY, z));
    anchors.set(id, chip.position.clone().add(localSites.get(id)));
    tracks.set(id, pad);
    pad.userData.base = gate ? 0xa697be : gold;
  }
  function dimension(x1, z1, x2, z2, text, labelX, labelZ, labelWidth) {
    const y = surface + 0.015,
      mid = (x1 + x2) / 2,
      fore = (z1 + z2) / 2;
    path(
      dimensions,
      [
        [x1, y, z1],
        [x2, y, z2],
      ],
      0.009,
      teal,
    );
    const dx = x1 === x2 ? 0.075 : 0,
      dz = z1 === z2 ? 0.075 : 0;
    for (const [x, z] of [
      [x1, z1],
      [x2, z2],
    ])
      shaft(dimensions, [x - dx, y, z - dz], [x + dx, y, z + dz], 0.011, teal);
    label(dimensions, text, mid + labelX, y + 0.006, fore + labelZ, labelWidth);
  }
  dimension(
    -c.electrodeSpanMm / 2,
    1.19,
    c.electrodeSpanMm / 2,
    1.19,
    "6.58 mm",
    0,
    0.16,
    1.3,
  );
  dimension(
    3.58,
    -c.isthmusWidthMm / 2,
    3.58,
    c.isthmusWidthMm / 2,
    "2.02 mm",
    0,
    1.4,
    1.15,
  );
  const imported = Array.isArray(run.machine?.nodes),
    laneIds = run.program?.zones?.map((z) => z.id) ?? [];
  // A separate die envelope surrounds the electrode field. Its cut and bond
  // patterns are illustrative; the reference dimensions above are independent.
  box(
    layout,
    0,
    surface + 0.0006,
    0,
    c.electrodeSpanMm,
    0.0012,
    c.isthmusWidthMm,
    0x584e4d,
  );
  if (imported) {
    const [ox, oz] = c.h2OriginPitch;
    for (const n of run.machine.nodes) {
      electrode(
        n.id,
        (n.pos[0] - ox) * c.h2PitchMm,
        (n.pos[1] - oz) * c.h2PitchMm,
        n.gate ? 0.156 : 0.083,
        n.gate ? 0.093 : 0.048,
        n.gate,
      );
    }
    for (const s of run.machine.segments) {
      const a = localSites.get(s.a),
        b = localSites.get(s.b);
      const lateral = new T.Vector2(b.z - a.z, a.x - b.x)
        .normalize()
        .multiplyScalar(0.044);
      for (const side of [-1, 1]) {
        const dx = lateral.x * side,
          dz = lateral.y * side;
        shaft(
          layout,
          [a.x + dx, surface + 0.005, a.z + dz],
          [b.x + dx, surface + 0.005, b.z + dz],
          0.014,
          gold,
        );
      }
      const seg = shaft(
        layout,
        [a.x, surface + 0.004, a.z],
        [b.x, surface + 0.004, b.z],
        0.012,
        0xb89258,
      );
      seg.userData.eventPart = s.id;
      segmentObjects.set(s.id, seg);
    }
    dimension(-1.125, -0.72, -0.375, -0.72, "750 µm", 0, -0.12, 0.83);
  } else if (laneIds.length) {
    const travel = run.program.travelUm / 1000;
    for (const [index, id] of laneIds.entries()) {
      const z = (index - (laneIds.length - 1) / 2) * c.broadcastLanePitchMm;
      const key = "zone-" + id,
        x = c.broadcastStartMm;
      electrode(key, x, z, 0.075, 0.065);
      for (const side of [-1, 1]) {
        box(
          layout,
          x + travel / 2,
          surface + 0.004,
          z + side * 0.053,
          travel + 0.1,
          0.008,
          0.021,
          gold,
        );
        for (let i = 0; i < 8; i++)
          box(
            layout,
            x + (i * travel) / 7,
            surface + 0.004,
            z + side * 0.084,
            Math.max(0.004, travel * 0.1),
            0.008,
            0.03,
            gold,
          );
      }
      bead(layout, x + travel, surface + 0.009, z, 0.019, optical);
    }
    dimension(
      c.broadcastStartMm,
      -0.86,
      c.broadcastStartMm + travel,
      -0.86,
      run.program.travelUm + " µm",
      0,
      -0.12,
      0.75,
    );
  }
  function ionAt(id, point, engaged) {
    let marker = ions.get(id);
    if (!marker) {
      marker = bead(layout, 0, 0, 0, c.markerRadiusMm, teal);
      marker.name = "ion:" + id;
      ions.set(id, marker);
    }
    marker.visible = true;
    marker.position.copy(point);
    marker.material = mat(engaged ? on : 0x8af5e5);
  }
  function paint() {
    for (const [id, lamp] of lamps)
      lamp.material = mat(id === selected || active.has(id) ? on : teal);
    for (const [id, track] of tracks)
      track.material = mat(
        id === selected || active.has(id) ? on : track.userData.base,
      );
  }
  const pathData = system.links
    .find((l) => l.id === "optical-fiber")
    .pointsMm.map((p) => new T.Vector3(...p));
  const opticalPath = new T.CurvePath();
  pathData
    .slice(1)
    .forEach((point, i) =>
      opticalPath.add(new T.LineCurve3(pathData[i], point)),
    );
  const signalFront = bead(root, 0, 0, 0, 1.95, on),
    signalTail = bead(root, 0, 0, 0, 1.95, optical);
  signalFront.userData.part = signalTail.userData.part = "optical-fiber";
  const beamGroup = cableGroups.get("gate-beam"),
    origin = system.links.find((l) => l.id === "gate-beam").pointsMm[0];
  // The authored point list defines the optical route toward the chip center.
  // Actual delivery terminates at a gate or a broadcast lane's terminal well.
  beamGroup.clear();
  const rays = new Map();
  for (const [site, point] of localSites) {
    const target = point.clone().add(chip.position);
    if (!imported) target.x += run.program.travelUm / 1000;
    const ray = shaft(beamGroup, origin, target.toArray(), 0.014, optical);
    ray.userData.eventPart = site;
    rays.set(site, ray);
  }
  function update(frame, positions) {
    active = new Set([
      frame?.part,
      ...(frame?.targets || []),
      ...(imported ? studioCycleParts(frame) : []),
    ]);
    for (const marker of ions.values()) marker.visible = false;
    if (imported) {
      const occupants = new Map();
      for (const [ion, site] of positions instanceof Map
        ? positions
        : Object.entries(positions || {})) {
        if (!occupants.has(site)) occupants.set(site, []);
        occupants.get(site).push(ion);
      }
      for (const [site, names] of occupants) {
        const at = localSites.get(site);
        if (!at) continue;
        names.sort().forEach((ion, i) => {
          const point = at.clone();
          point.x +=
            (i - (names.length - 1) / 2) * c.coLocatedMarkerSeparationMm;
          ionAt(ion, point, frame?.ions?.includes(ion));
          ions.get(ion).userData.eventPart = site;
          ions.get(ion).userData.readout = ion + " · " + site;
        });
      }
      const traversed = new Set(frame?.moves?.flatMap((m) => m.via) || []);
      for (const [id, seg] of segmentObjects)
        seg.material = mat(traversed.has(id) ? on : 0xb89258);
    } else if (laneIds.length) {
      const state = frame?.state || run.initial;
      for (const lane of state.lanes) {
        const key = "zone-" + lane.id;
        const point = localSites.get(key).clone();
        point.x += lane.ionUm / 1000;
        ionAt(lane.id, point, state.lightOn && state.exposedIon === lane.id);
        ions.get(lane.id).userData.eventPart = key;
        ions.get(lane.id).userData.readout =
          "Ion " +
          lane.id +
          " · lane " +
          lane.id +
          " · " +
          lane.ionUm +
          " µm from start";
      }
      const head = frame?.opticalHeadPermille ?? 0,
        tail = frame?.opticalTailPermille ?? 0;
      signalFront.visible = signalTail.visible = head > tail;
      if (head > tail) {
        signalFront.position.copy(opticalPath.getPointAt(head / 1000));
        signalTail.position.copy(opticalPath.getPointAt(tail / 1000));
      }
      for (const [id, g] of cableGroups) {
        const lit =
          (id === "optical-fiber" &&
            (frame?.opticalHeadPermille ?? 0) >
              (frame?.opticalTailPermille ?? 0)) ||
          (id === "fiber" && frame?.part === id) ||
          (id === "analog" && frame?.part === "dac");
        for (const child of g.children) {
          child.userData.restMaterial ??= child.material;
          child.material = lit ? mat(on) : child.userData.restMaterial;
        }
      }
    }
    if (!laneIds.length) signalFront.visible = signalTail.visible = false;
    if (run.program?.kind === "waveform-controller") {
      for (const id of ["dac-bus", "analog"]) {
        for (const segment of cableGroups.get(id).children) {
          segment.userData.restMaterial ??= segment.material;
          segment.material = active.has(id) ? mat(on) : segment.userData.restMaterial;
        }
      }
    }
    const litSites = new Set(
      imported
        ? frame?.control?.driver === "optical"
          ? frame.targets
          : []
        : frame?.state.lightOn
          ? ["zone-" + run.program.gateZone]
          : [],
    );
    for (const [id, ray] of rays) ray.visible = litSites.has(id);
    paint();
  }
  function setFocus(id) {
    const inside = id === "chip" || id === "carrier";
    bodies.get("chamber").visible = !inside;
    carrierDetails.visible = inside;
    dimensions.visible = id === "chip";
  }
  setFocus("installation");
  return {
    root,
    anchors,
    update,
    setFocus,
    select(id) {
      selected = id;
      paint();
    },
    dispose() {
      for (const obj of [...geometries, ...materials, ...textures])
        obj.dispose();
    },
  };
}
