import * as T from "three";
import { buildApparatusPart, buildRegister } from "./device-scene.js";
import { apparatus } from "./apparatus.js";
import {
  registerLens,
  deliveryBranches,
  installedPoint,
} from "/installation-display.js";
import { boardLayout } from "/provenance.mjs";
import { wireExecution } from "/wiring.mjs";
import { createWireSection } from "./wire-section.js";
import { installationLens } from "./installation-lens.js";

const colors = {
  fpga: 0x216850,
  ram: 0x416f60,
  bus: 0x727e87,
  busBuffer: 0x35715a,
  dac: 0x97703a,
  clockedDac: 0x97703a,
  spiDac81416: 0x97703a,
  rcFilter: 0x457562,
  dmaBurst: 0x486d85,
  affine: 0x597d8a,
  threshold: 0x7b6898,
  switch: 0x4c7980,
  probe: 0x3b596c,
  stimulus: 0x695987,
  waveformBoard: 0x377752,
};
const unit = new T.BoxGeometry(1, 1, 1);
const typeOf = (part) => Object.keys(part.model)[0];
function center(points) {
  const bounds = new T.Box3().setFromPoints(
    points.map((p) => new T.Vector3(...p)),
  );
  return bounds.getCenter(new T.Vector3()).toArray();
}

export function installation(design) {
  const parts = design.parts.map((p) => ({
    ...p,
    basis: "Design envelope in millimetres.",
  }));
  const byId = new Map(parts.map((p) => [p.id, p]));
  const links = design.wires.map((w) => {
    const a = byId.get(w.src.part),
      b = byId.get(w.dst.part);
    const geometry = wireExecution(w, byId);
    return {
      id: w.id,
      from: a.id,
      to: b.id,
      kind: w.src.port + " → " + w.dst.port,
      interconnect: w.interconnect,
      extraDelayPs: w.delayPs,
      signal:
        a.model.dac || a.model.clockedDac || a.model.spiDac81416 || a.model.rcFilter ||
        a.model.waveformBoard ||
        (a.model.switch && w.src.port === "out")
          ? "analog"
          : "digital",
      ...geometry,
    };
  });
  const equipment = design.device
    ? apparatus(design.device, parts, design.wires)
    : null;
  if (equipment) {
    parts.push(...equipment.parts);
    links.push(...equipment.links);
  }
  const pcb = boardLayout(design);
  parts.push(...pcb.parts);
  links.push(...pcb.links);
  const corners = parts.flatMap((p) =>
    [-1, 1].map((sign) =>
      p.centerMm.map((n, i) => n + (sign * p.sizeMm[i]) / 2),
    ),
  );
  const origin = center(corners);
  const boardBounds = new Map();
  for (const p of parts.filter(p => p.pcbGroup)) {
    const bounds = boardBounds.get(p.pcbGroup) ?? new T.Box3();
    for (const sign of [-0.5, 0.5])
      bounds.expandByPoint(new T.Vector3(...p.centerMm.map((v, i) => v + sign * p.sizeMm[i])));
    boardBounds.set(p.pcbGroup, bounds);
  }
  const substrates = [...boardBounds].map(([label, bounds]) => {
    const size = bounds.getSize(new T.Vector3()), middle = bounds.getCenter(new T.Vector3());
    return { id: "pcb/" + label, label, centerMm: [middle.x, bounds.min.y - 0.8, middle.z],
      sizeMm: [size.x + 6, 1.6, size.z + 6], spanMm: (Math.max(size.x,size.z)+6)*1.55 };
  });
  const spanMm = Math.max(
    1,
    ...corners.map((p) => Math.hypot(...p.map((v, i) => v - origin[i])) * 2.25),
  );
  const focus = [
    { id: "", label: "Whole machine", centerMm: origin, spanMm },
    ...substrates,
    ...parts.map((p) => ({
      id: p.id,
      label: p.label,
      centerMm: p.centerMm,
      spanMm: Math.max(...p.sizeMm) * 3.3,
    })),
    ...(design.device?.qubits ?? []).map((q) => ({
      id: equipment.chip + "/" + q.id,
      label: "Physical site · " + q.id,
      centerMm: installedPoint(design.device, q.positionMm),
      spanMm: Math.max(
        0.001,
        design.device.kind === "ion"
          ? 0.03
          : design.device.kind === "atom"
            ? 0.015
            : 1.2,
      ),
      site: true,
    })),
  ];
  return {
    parts,
    links,
    focus,
    device: design.device,
    equipment,
    pcb,
    substrates,
    sources: design.device?.mounting
      ? {
          ion: [
            {
              title: "H2 electrode layout · Fig. 2",
              url: "https://arxiv.org/html/2305.03828",
            },
            {
              title: "QCCD Studio architecture",
              url: "https://github.com/yezhuoyang/QCCD/blob/97c94dbcb92c63cc529c451363603f1a813388cf/Reproduce/moses2023/h2.arch.json",
            },
          ],
          atom: [
            {
              title: "Lukin group optical apparatus · Extended Data Fig. 1",
              url: "https://arxiv.org/html/2312.03982v1",
            },
            {
              title: "ZAC native layout and program",
              url: "https://github.com/UCLA-VAST/ZAC/tree/e5083362f99e6915f20c2bd0eaa88b6d1cdcecac",
            },
          ],
          transmon: [
            {
              title: "Krinner et al. · cryogenic wiring",
              url: "https://doi.org/10.1140/epjqt/s40507-019-0072-0",
            },
          ],
        }[design.device.kind]
      : [],
    overviewLabels: equipment
      ? [
          design.parts.find((p) => p.model.fpga)?.id,
          design.parts.find((p) => p.model.dac)?.id,
          equipment.main,
          ...equipment.parts
            .filter(
              (p) =>
                ["aod", "mount"].includes(p.form) ||
                /\/(raman-x|moving-x|blue-source|raman-source|feedthrough|mount)$/.test(
                  p.id,
                ),
            )
            .map((p) => p.id),
        ].filter(Boolean)
      : design.parts
          .filter(
            (p) =>
              p.model.fpga ||
              p.model.waveformBoard ||
              p.model.dac || p.model.clockedDac || p.model.spiDac81416 || p.model.rcFilter || p.model.busBuffer || p.model.dmaBurst ||
              p.model.probe,
          )
          .map((p) => p.id)
          .slice(0, 5),
    note: "Cable paths show placement. Each wire’s programmed delay determines signal arrival.",
  };
}

export function buildMachine(system, run) {
  const root = new T.Group(),
    anchors = new Map(),
    materials = [],
    surfaces = new Map();
  const cableGeometry = [],
    cleanups = [];
  const routeGroups = new Map(),
    wireSection = createWireSection(root);
  let openedWire;
  function addRouteGroup(id, g) {
    if (!routeGroups.has(id)) routeGroups.set(id, []);
    routeGroups.get(id).push(g);
  }
  function clearSection() {
    if (!openedWire) return;
    for (const group of routeGroups.get(openedWire) ?? []) group.visible = true;
    wireSection.clear();
    openedWire = null;
  }
  const branchMeshes = [],
    normalColors = new Map(),
    physicalMaterials = new Map();
  const scopeDisplays = [];
  let register = null;
  function material(color, owner) {
    const m = new T.MeshStandardMaterial({
      color,
      roughness: 0.6,
      metalness: 0.2,
    });
    materials.push(m);
    if (owner) {
      surfaces.set(owner, m);
      normalColors.set(m, m.color.clone());
    }
    return m;
  }
  function box(group, size, xyz, mat) {
    const mesh = new T.Mesh(unit, mat);
    mesh.scale.fromArray(size);
    mesh.position.fromArray(xyz);
    group.add(mesh);
  }
  const chip = material(0x27343c),
    brass = material(0xc6a664);
  // A shared PCB follows the placed components. Its padded outline is display geometry.
  for (const board of system.substrates)
    box(root, board.sizeMm, board.centerMm, material(0x305d51));
  if (system.device) {
    const boards = system.parts.filter((p) => p.model);
    const bounds = new T.Box3();
    for (const p of boards)
      for (const sign of [-0.5, 0.5])
        bounds.expandByPoint(
          new T.Vector3(...p.centerMm.map((v, i) => v + sign * p.sizeMm[i])),
        );
    const c = bounds.getCenter(new T.Vector3()),
      size = bounds.getSize(new T.Vector3());
    const tray = material(0x425864);
    for (const side of [-1, 1]) {
      box(
        root,
        [size.x + 18, 3, 4],
        [c.x, bounds.min.y - 5, c.z + side * (size.z / 2 + 6)],
        tray,
      );
      box(
        root,
        [4, 3, size.z + 18],
        [c.x + side * (size.x / 2 + 6), bounds.min.y - 5, c.z],
        tray,
      );
    }
    for (const p of boards) {
      const bottom = p.centerMm[1] - p.sizeMm[1] / 2,
        h = bottom - bounds.min.y + 4;
      box(
        root,
        [p.sizeMm[0] * 0.7, h, p.sizeMm[2] * 0.5],
        [p.centerMm[0], bottom - h / 2, p.centerMm[2]],
        tray,
      );
      box(
        root,
        [4, 2, size.z + 15],
        [p.centerMm[0], bounds.min.y - 5, c.z],
        tray,
      );
    }
  }
  for (const p of system.parts) {
    const g = new T.Group(),
      [w, h, d] = p.sizeMm;
    g.userData.part = p.id;
    g.position.fromArray(p.centerMm);
    root.add(g);
    anchors.set(p.id, g.position.clone());
    if (p.form === "register") {
      register = buildRegister(system.device);
      if (system.device.mounting?.faceDown) register.root.rotation.x = Math.PI;
      g.add(register.root);
      cleanups.push(register.dispose);
      continue;
    }
    if (p.form === "board-chip") {
      box(
        g,
        p.sizeMm,
        [0, 0, 0],
        material(p.local === "dac" ? 0xaa8245 : 0x345760, p.id),
      );
      continue;
    }
    if (p.form) {
      cleanups.push(buildApparatusPart(g, p));
      const palette = new Set();
      g.traverse((o) => {
        if (o.isMesh) palette.add(o.material);
      });
      physicalMaterials.set(
        p.id,
        [...palette].map((m) => [m, m.color.clone()]),
      );
      continue;
    }
    const type = typeOf(p);
    if (p.displayForm === "oscilloscope") {
      box(g, p.sizeMm, [0, 0, 0], material(0xa6b4b2, p.id));
      const face = d / 2;
      box(g, [w * 0.66, h * 0.68, 1], [-w * 0.11, h * 0.045, face + 0.5], chip);
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 190;
      const ctx = canvas.getContext("2d");
      const texture = new T.CanvasTexture(canvas);
      texture.colorSpace = T.SRGBColorSpace;
      const display = new T.MeshBasicMaterial({map:texture});
      const pane = new T.PlaneGeometry(w * 0.63, h * 0.63);
      const screen = new T.Mesh(pane, display);
      screen.position.set(-w * 0.11, h * 0.045, face + 1.1);
      g.add(screen);
      let previous;
      const refresh = () => {
        const uv = run.probeValue(p.id);
        if (uv === previous) return;
        previous = uv;
        ctx.fillStyle = "#152b31";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#a2c2c5";
        ctx.font = "26px system-ui";
        ctx.fillText("Probe voltage", 18, 46);
        ctx.fillStyle = "#90f6cc";
        ctx.font = "54px monospace";
        ctx.fillText(uv == null ? "—" : (uv / 1e6).toFixed(3) + " V", 18, 132);
        texture.needsUpdate = true;
      };
      scopeDisplays.push(refresh);
      refresh();
      cleanups.push(() => { texture.dispose(); display.dispose(); pane.dispose(); });
      for (const [x, y, r] of [[0.32,0.21,0.078],[0.32,-0.01,0.055],[0.24,-0.30,0.047]]) {
        const start = new T.Vector3(w*x, h*y, face), end = start.clone();
        end.z += y < -0.2 ? 3 : 2;
        tapered(g, start, end, r*h, r*h, y < -0.2 ? brass : chip);
      }
      continue;
    }
    const shell = material(colors[type], p.id);
    box(g, [w, h * 0.45, d], [0, -h * 0.275, 0], shell);
    if (type === "busBuffer") {
      for (const z of [-0.30, 0, 0.30]) {
        box(g, [w * 0.5, h * 0.55, d * 0.17], [0, h * 0.225, d*z], chip);
      }
    } else if (type === "rcFilter") {
      box(g, [w * 0.32, h * 0.55, d * 0.27], [-w * 0.22, h * 0.22, 0], chip);
      box(g, [w * 0.20, h * 0.52, d * 0.40], [w * 0.23, h * 0.21, 0], brass);
    } else if (type !== "waveformBoard")
      box(g, [w * 0.64, h * 0.55, d * 0.68], [0, h * 0.225, 0], chip);
    if (p.pcbGroup) {
      for (const wire of system.links.filter(wire => wire.from === p.id || wire.to === p.id)) {
        const pt = wire.from === p.id ? wire.pointsMm[0] : wire.pointsMm.at(-1);
        box(g, [0.36, 0.15, 0.28], pt.map((v, i) => v - p.centerMm[i]), brass);
      }
    } else {
      for (const side of [-1, 1]) {
        for (let k = 0; k < 4; k++)
          box(
            g,
            [w * 0.13, h * 0.17, d * 0.07],
            [side * w * 0.41, 0, (k - 1.5) * d * 0.18],
            brass,
          );
      }
    }
    anchors.set(p.id, new T.Vector3(...p.centerMm));
  }
  const device = system.device,
    equipment = system.equipment;
  const branches = device ? deliveryBranches(device, equipment) : [];
  const terminals = new Set(branches.map((b) => b.link));
  function tapered(group, a, b, r0, r1, mat) {
    const delta = b.clone().sub(a),
      len = delta.length();
    if (!len) return;
    const geom = new T.CylinderGeometry(r1, r0, len, 8);
    cableGeometry.push(geom);
    const mesh = new T.Mesh(geom, mat);
    mesh.position.copy(a).lerp(b, 0.5);
    mesh.quaternion.setFromUnitVectors(
      new T.Vector3(0, 1, 0),
      delta.normalize(),
    );
    group.add(mesh);
  }
  function focused(group, start, end, tip, maximum, mat) {
    const length = start.distanceTo(end);
    if (!length) return;
    const radius = (r) => Math.max(tip, Math.min(maximum, r * 0.018));
    let a = start,
      remaining = length;
    while (remaining > 4 * tip) {
      const next = remaining / 2,
        b = end.clone().lerp(start, next / length);
      tapered(group, a, b, radius(remaining), radius(next), mat);
      a = b;
      remaining = next;
    }
    tapered(group, a, end, radius(remaining), tip, mat);
  }
  for (const l of system.links) {
    const g = new T.Group();
    g.userData.part = l.id;
    addRouteGroup(l.id, g);
    root.add(g);
    const spectral = {
      420: 0x7584ff,
      780: 0xf08171,
      795: 0xe65e64,
      850: 0xecab58,
      852: 0xedbc6d,
      1013: 0xc776b7,
    };
    const color =
      l.signal === "optical" || l.carrier
        ? (spectral[l.wavelengthNm] ?? 0xce7980)
        : l.signal === "analog" || l.devicePath
          ? 0xb1915b
          : 0x528f9b;
    const mat = material(color, l.id);
    const points = l.pointsMm.map((p) => new T.Vector3(...p));
    anchors.set(l.id, points[1]);
    if (terminals.has(l.id)) continue;
    for (let i = 1; i < points.length; i++) {
      const delta = points[i].clone().sub(points[i - 1]),
        length = delta.length();
      if (!length) continue;
      if (
        l.signal === "optical" &&
        equipment &&
        ((l.from === equipment.chip && i === 1) ||
          (l.to === equipment.chip && i === points.length - 1))
      ) {
        const outgoing = l.from === equipment.chip;
        focused(
          g,
          points[outgoing ? i : i - 1],
          points[outgoing ? i - 1 : i],
          device.kind === "atom" ? 0.00011 : 0.006,
          0.48,
          mat,
        );
        continue;
      }
      const radius = Math.min(
        l.diameterMm ? l.diameterMm / 2 : l.board ? 0.45 : 0.85,
        length / 4,
      );
      tapered(
        g,
        points[i - 1],
        points[i],
        radius,
        equipment && l.to === equipment.chip ? 0.045 : radius,
        mat,
      );
    }
    anchors.set(l.id, points[1]);
  }
  // Coincident single- and two-qubit routes share a physical branch.
  const shared = new Map();
  for (const b of branches) {
    const key = JSON.stringify([b.link, b.target]);
    if (shared.has(key)) {
      shared.get(key).probes.add(b.probe);
      continue;
    }
    const g = new T.Group(),
      mat = material(device.kind === "transmon" ? 0xa58964 : 0x619d9d);
    g.userData.part = b.link;
    addRouteGroup(b.link, g);
    root.add(g);
    const branch = {
      target: b.target,
      link: b.link,
      probes: new Set([b.probe]),
      mat,
      color: mat.color.clone(),
    };
    shared.set(key, branch);
    branchMeshes.push(branch);
    let start = new T.Vector3(...b.sourceMm);
    const end = new T.Vector3(...b.endMm);
    for (const [index, p] of b.pointsMm.slice(1, -1).entries()) {
      const corner = new T.Vector3(...p);
      tapered(g, start, corner, index === 0 ? 0.04 : 0.006, 0.006, mat);
      start = corner;
    }
    focused(
      g,
      start,
      end,
      device.kind === "atom" ? 0.000065 : device.kind === "ion" ? 0.001 : 0.005,
      device.kind === "transmon" ? 0.006 : 0.48,
      mat,
    );
  }
  const lens = device ? registerLens(device) : null;
  const geometryMap = device ? installationLens(root, lens) : null;
  let enlarged = Boolean(device),
    frame,
    selected,
    driveState;
  geometryMap?.apply(enlarged);
  if (geometryMap) cleanups.push(geometryMap.dispose);
  function displayPoint(v) {
    return enlarged ? geometryMap.project(v) : v;
  }
  const qPoints =
    device?.qubits.map((q) => ({
      id: q.id,
      point: new T.Vector3(...installedPoint(device, q.positionMm)),
    })) ?? [];
  const steerSymbol = device?.kind === "atom" ? new T.Group() : null,
    steerPosition = new T.Vector3();
  if (steerSymbol) {
    const geo = new T.SphereGeometry(1, 12, 8),
      glow = material(0xf7e878);
    cableGeometry.push(geo);
    const m = new T.Mesh(geo, glow);
    steerSymbol.add(m);
    steerSymbol.visible = false;
    root.add(steerSymbol);
  }
  const tmp = new T.Vector3();
  const machineFrames = new Map();
  function machineFrame(f) {
    if (machineFrames.has(enlarged)) return machineFrames.get(enlarged);
    const direction = (
      device.kind === "ion"
        ? new T.Vector3(0.34, -0.52, 1.25)
        : new T.Vector3(0.48, 0.66, 1.22)
    ).normalize();
    const basis = new T.Matrix4().lookAt(
      direction,
      new T.Vector3(),
      new T.Vector3(0, 1, 0),
    );
    const inverse = basis.clone().invert(),
      matrix = new T.Matrix4(),
      bounds = new T.Box3();
    root.updateMatrixWorld(true);
    root.traverseVisible((o) => {
      if (!o.isMesh) return;
      matrix.multiplyMatrices(inverse, o.matrixWorld);
      const points = o.geometry.attributes.position;
      for (let i = 0; i < points.count; i++)
        bounds.expandByPoint(
          tmp.fromBufferAttribute(points, i).applyMatrix4(matrix),
        );
    });
    const size = bounds.getSize(new T.Vector3());
    const result = {
      ...f,
      direction,
      centerMm: bounds.getCenter(tmp).applyMatrix4(basis).toArray(),
      fitWidth: size.x * 1.1,
      fitHeight: size.y * 1.28,
      spanMm: size.length(),
    };
    machineFrames.set(enlarged, result);
    return result;
  }
  function paint() {
    if (steerSymbol) {
      const spot = driveState?.steering;
      steerSymbol.visible = Boolean(spot);
      if (spot) {
        const [x, y, z] = spot.originMm;
        steerPosition.fromArray(
          installedPoint(device, [x + spot.xNm / 1e6, y, z + spot.yNm / 1e6]),
        );
        steerSymbol.position.copy(displayPoint(steerPosition.clone()));
        const edge = displayPoint(
          steerPosition.clone().add(new T.Vector3(0, 0.00065, 0)),
        );
        steerSymbol.scale.setScalar(edge.distanceTo(steerSymbol.position));
      }
    }
    const local = frame?.native && system.pcb.id(frame.part, frame.native.part);
    const probes = driveState?.activeProbes;
    const live = new Set([
      ...(driveState?.path?.parts ?? []),
      ...(driveState?.path?.wires ?? []),
    ]);
    if (!driveState?.timed)
      for (const l of system.links)
        if (l.probes?.some((p) => probes?.has(p))) live.add(l.id);
    for (const [id, palette] of physicalMaterials)
      for (const [m, base] of palette) {
        m.color.copy(base);
        if (id === frame?.part || live.has(id) || id === selected)
          m.color.lerp(new T.Color(0xffb96d), 0.6);
        m.emissive.setHex(
          id === frame?.part || id === selected
            ? 0x653914
            : live.has(id)
              ? 0x453217
              : 0,
        );
      }
    for (const [id, m] of surfaces) {
      const current = id === frame?.part || id === frame?.wire || id === local;
      m.color.copy(normalColors.get(m));
      if (driveState?.carriers?.includes(id)) m.color.setHex(0xda8ac9);
      if (current || live.has(id))
        m.color.setHex(current ? 0xff9c57 : 0xd7a354);
      m.emissive.setHex(
        current
          ? 0x87501c
          : live.has(id)
            ? 0x5c3619
            : driveState?.carriers?.includes(id)
              ? 0x572c4b
              : id === selected
                ? 0x16575c
                : 0,
      );
    }
    for (const b of branchMeshes) {
      const active = [...b.probes].some((p) =>
        driveState?.activeBindings?.has(JSON.stringify([p, b.target])),
      );
      b.mat.color.copy(b.color);
      if (active || selected === b.link) b.mat.color.setHex(0xff9c57);
      b.mat.emissive.setHex(active || selected === b.link ? 0xa04615 : 0);
    }
    if (driveState) register?.paint(driveState.levels, driveState.selected);
  }
  return {
    root,
    anchors,
    displayPoint,
    pickQubit: run.pickQubit,
    pickConductor: run.pickConductor,
    openWire(id, conductor) {
      const l = system.links.find((edge) => edge.id === id);
      if (!l?.interconnect) return;
      clearSection();
      const routes = branches
        .filter((b) => b.link === id)
        .map((b) => b.pointsMm);
      const focus = wireSection.open(
        l,
        conductor,
        routes.length ? routes : undefined,
      );
      if (focus) {
        openedWire = id;
        for (const group of routeGroups.get(id) ?? []) group.visible = false;
      }
      return focus;
    },
    clearWire: clearSection,
    setEnlarged(v) {
      enlarged = Boolean(v && geometryMap);
      geometryMap?.apply(enlarged);
    },
    cameraFocus(f) {
      if (!register) return f;
      if (f === system.focus[0]) return machineFrame(f);
      if (f.site)
        return {
          ...f,
          centerMm: displayPoint(new T.Vector3(...f.centerMm)).toArray(),
          spanMm: f.spanMm * (enlarged ? lens.enlarged / lens.inner : 1),
          direction: new T.Vector3(
            0.1,
            device.mounting?.faceDown ? -1 : 1,
            0.52,
          ).normalize(),
        };
      if (f.id === equipment.chip) {
        const point = new T.Vector3(
          ...installedPoint(device, register.mid.toArray()),
        );
        return {
          ...f,
          centerMm: displayPoint(point).toArray(),
          spanMm:
            register.span * (enlarged ? lens.enlarged / lens.inner : 1) * 1.15,
          direction: new T.Vector3(
            0.14,
            device.mounting?.faceDown ? -1 : 1,
            0.68,
          ).normalize(),
        };
      }
      return {
        ...f,
        centerMm: displayPoint(new T.Vector3(...f.centerMm)).toArray(),
      };
    },
    scaleLabel(label) {
      return enlarged ? "Lab · " + label : label;
    },
    labelQubits(layer, camera, w, h, used) {
      if (!register) return;
      if (steerSymbol?.visible) {
        const p = tmp.copy(steerSymbol.position).project(camera),
          x = ((p.x + 1) * w) / 2,
          y = ((1 - p.y) * h) / 2;
        if (Math.abs(p.z) < 1 && x >= 0 && x < w && y >= 0 && y < h) {
          const label = document.createElement("span");
          label.className = "qubit-tag driven";
          label.textContent = driveState.steering.label;
          label.style.left = x + "px";
          label.style.top = y - 10 + "px";
          layer.append(label);
          used.push([x, y]);
        }
      }
      const chosen = driveState?.selected,
        levels = driveState?.levels;
      const order = qPoints
        .slice()
        .sort(
          (a, b) =>
            Number(b.id === chosen || levels?.has(b.id)) -
            Number(a.id === chosen || levels?.has(a.id)),
        );
      for (const q of order) {
        const p = displayPoint(tmp.copy(q.point)).project(camera),
          x = ((1 + p.x) * w) / 2,
          y = ((1 - p.y) * h) / 2;
        if (Math.abs(p.z) > 1 || x < 5 || x > w - 5 || y < 14 || y > h - 14)
          continue;
        const separated = !used.some(
          ([a, b]) => Math.abs(x - a) < 44 && Math.abs(y - b) < 24,
        );
        if (!separated) continue;
        const tag = document.createElement("button");
        tag.type = "button";
        tag.tabIndex = -1;
        tag.setAttribute("aria-label", "Inspect " + q.id);
        tag.onclick = () => run.pickQubit(q.id);
        tag.className = "qubit-tag" + (levels?.has(q.id) ? " driven" : "");
        tag.textContent = q.id;
        tag.style.left = x + "px";
        tag.style.top = y - 10 + "px";
        layer.append(tag);
        used.push([x, y]);
      }
    },
    update(f, state) {
      frame = f;
      driveState = state;
      for (const refresh of scopeDisplays) refresh();
      paint();
    },
    select(id) {
      selected = id;
      paint();
    },
    dispose() {
      wireSection.dispose();
      cleanups.forEach((fn) => fn());
      materials.forEach((m) => m.dispose());
      cableGeometry.forEach((g) => g.dispose());
    },
  };
}
