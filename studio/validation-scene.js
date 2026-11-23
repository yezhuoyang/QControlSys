import * as T from "three";

// All dimensions use millimetres. Separate camera presets keep the design reference
// apart from the experiment whose measured position or emission is being compared.
export function buildValidationScene(system, run) {
  const root = new T.Group(),
    anchors = new Map(),
    objects = new Map();
  const materials = new Map(),
    geometries = new Set();
  const up = new T.Vector3(0, 1, 0);
  const cube = new T.BoxGeometry(1, 1, 1),
    drum = new T.CylinderGeometry(0.5, 0.5, 1, 32);
  const sphere = new T.SphereGeometry(0.5, 14, 10);
  function material(color) {
    if (!materials.has(color))
      materials.set(
        color,
        new T.MeshStandardMaterial({
          color,
          roughness: 0.48,
          metalness: 0.36,
          side: T.DoubleSide,
        }),
      );
    return materials.get(color);
  }
  function piece(parent, geometry, xyz, size, color) {
    geometries.add(geometry);
    const mesh = new T.Mesh(geometry, material(color));
    mesh.userData.rest = mesh.material;
    mesh.position.fromArray(xyz);
    mesh.scale.fromArray(size);
    parent.add(mesh);
    return mesh;
  }
  function wire(parent, a, b, diameter, color) {
    const start = new T.Vector3(...a),
      delta = new T.Vector3(...b).sub(start);
    if (!delta.length()) return;
    const tube = piece(
      parent,
      drum,
      start.addScaledVector(delta, 0.5).toArray(),
      [diameter, delta.length(), diameter],
      color,
    );
    tube.quaternion.setFromUnitVectors(up, delta.normalize());
  }
  const body = 0x83979e,
    brass = 0xc39c60,
    face = 0x27444c,
    accent = 0x65bdb4;
  for (const p of system.parts) {
    const g = new T.Group(),
      [w, h, d] = p.sizeMm;
    root.add(g);
    g.position.fromArray(p.centerMm);
    g.userData.part = p.id;
    objects.set(p.id, g);
    anchors.set(p.id, new T.Vector3(...p.centerMm));
    if (p.kind === "base") {
      piece(g, cube, [0, 0, 0], [w, h, d], 0x536b70);
    } else if (p.kind === "frame") {
      for (const side of [-1, 1]) {
        for (const end of [-1, 1])
          piece(g, cube, [side * w * 0.49, 0, end * d * 0.48], [9, h, 9], body);
        for (const y of [-0.47, 0.47]) {
          piece(g, cube, [0, h * y, side * d * 0.48], [w, 9, 9], body);
          piece(g, cube, [side * w * 0.49, h * y, 0], [9, 9, d], body);
        }
      }
    } else if (p.kind === "rack") {
      piece(g, cube, [0, 0, 0], [w, h, d], body);
      piece(g, cube, [0, 0, d * 0.51], [w * 0.99, h * 0.94, d * 0.02], face);
      for (let i = 0; i < 7; i++)
        piece(
          g,
          cube,
          [-w * 0.39 + i * w * 0.026, 0, d * 0.53],
          [w * 0.011, h * 0.57, 1.2],
          body,
        );
      for (let i = 0; i < 4; i++)
        piece(
          g,
          sphere,
          [w * (0.18 + i * 0.06), 0, d * 0.53],
          [9, 9, 5],
          brass,
        );
    } else if (p.kind === "fridge") {
      for (const [height, diameter] of [
        [0.46, 1],
        [0.25, 0.85],
        [0.04, 0.69],
        [-0.16, 0.53],
        [-0.355, 0.36],
      ]) {
        piece(
          g,
          drum,
          [0, h * height, 0],
          [w * diameter, h * 0.027, d * diameter],
          brass,
        );
      }
      for (const x of [-1, 1])
        for (const z of [-1, 1])
          wire(
            g,
            [x * w * 0.17, -h * 0.36, z * d * 0.17],
            [x * w * 0.32, h * 0.46, z * d * 0.32],
            7,
            body,
          );
      for (let i = 0; i < 5; i++) {
        const offset = i * 8;
        wire(
          g,
          [-w * 0.3 + offset, h * 0.25, 0],
          [-w * 0.12 + offset, -h * 0.36, 0],
          3,
          0xbd8a55,
        );
      }
    } else if (p.kind === "vacuum" || p.kind === "penning") {
      piece(g, drum, [0, -h * 0.41, 0], [w, h * 0.14, d], body);
      piece(g, drum, [0, h * 0.41, 0], [w, h * 0.12, d], body);
      for (const side of [-1, 1])
        for (const z of [-1, 1])
          piece(
            g,
            drum,
            [side * w * 0.28, 0, z * d * 0.28],
            [w * 0.042, h * 0.8, w * 0.042],
            brass,
          );
      if (p.kind === "penning")
        for (const side of [-1, 1])
          piece(
            g,
            drum,
            [0, side * h * 0.27, 0],
            [w * 1.07, h * 0.13, d * 1.07],
            0x91675d,
          );
    } else if (p.kind === "optic") {
      piece(g, drum, [0, 0, 0], [w, h * 0.8, d], body);
      piece(g, drum, [0, h * 0.44, 0], [w * 0.7, h * 0.1, d * 0.7], accent);
    } else if (p.kind === "camera" || p.kind === "aod" || p.kind === "mixer") {
      piece(g, cube, [0, 0, 0], [w, h, d], p.kind === "aod" ? 0x729198 : face);
      for (const x of [-1, 1]) {
        const jack = piece(
          g,
          drum,
          [x * w * 0.51, 0, 0],
          [h * 0.46, w * 0.14, h * 0.46],
          brass,
        );
        jack.rotation.z = Math.PI / 2;
      }
    } else {
      piece(
        g,
        cube,
        [0, -h * 0.55, 0],
        [w, h, d],
        p.kind === "chip" ? 0x375767 : 0x415c63,
      );
      if (p.kind === "h2")
        piece(
          g,
          cube,
          [0, 0, 0],
          [p.fieldSpanMm, 0.0012, p.isthmusWidthMm],
          brass,
        );
      else if (run.experiment === "qccd-pair" && p.kind === "trap")
        for (let i = -2; i <= 2; i++)
          for (const side of [-1, 1])
            piece(
              g,
              cube,
              [i * 0.28, 0, side * 0.285],
              [0.25, h * 0.2, 0.07],
              brass,
            );
      else if (p.kind === "trap")
        for (let i = 0; i < 10; i++)
          for (const side of [-1, 1])
            piece(
              g,
              cube,
              [((i - 4.5) * w) / 10, 0, side * d * 0.28],
              [w * 0.09, h * 0.2, d * 0.3],
              brass,
            );
    }
  }
  for (const link of system.links) {
    const g = new T.Group();
    root.add(g);
    g.userData.part = link.id;
    objects.set(link.id, g);
    for (let i = 1; i < link.pointsMm.length; i++)
      wire(
        g,
        link.pointsMm[i - 1],
        link.pointsMm[i],
        link.id === "return-path" ? 2 : 4,
        link.id === "dac-bus"
          ? 0x697d9e
          : link.id === "return-path"
            ? 0x8c738c
            : brass,
      );
  }
  const detail = objects.get("endpoint"),
    markers = [];
  if (system.platform === "neutral" || run.experiment === "qccd") {
    for (const [value, color] of [
      [run.predicted, 0x64d5bd],
      [run.observed, 0xf3a05e],
    ]) {
      if (value == null) continue;
      const r = system.platform === "neutral" ? 0.00048 : 0.0016;
      const marker = piece(
        detail,
        sphere,
        [value / 1000, r / 2, 0],
        [r, r, r],
        color,
      );
      marker.userData.readout =
        (markers.length ? "Measured " : "Predicted ") +
        value.toPrecision(5) +
        " µm";
      marker.userData.marker = true;
      markers.push(marker);
    }
  }
  const designGroup = new T.Group();
  root.add(designGroup);
  designGroup.position.copy(detail.position);
  function facePolygon(record, color, height) {
    if (!record.points?.length) return;
    const outline = (pts) => pts.map(([x, y]) => new T.Vector2(x, -y));
    const shape = new T.Shape(outline(record.points));
    for (const hole of record.holes || [])
      shape.holes.push(new T.Path(outline(hole)));
    const obj = piece(
      designGroup,
      new T.ShapeGeometry(shape),
      [0, height, 0],
      [1, 1, 1],
      color,
    );
    obj.rotation.x = -Math.PI / 2;
  }
  const design = run.design;
  let transported = null;
  if (system.platform === "superconducting" && design) {
    const [x0, y0, x1, y1] = design.chip.boundsMm,
      depth = design.chip.substrateThicknessMm;
    piece(
      designGroup,
      cube,
      [(x0 + x1) / 2, -depth / 2, (y0 + y1) / 2],
      [x1 - x0, depth, y1 - y0],
      0x355767,
    );
    for (const poly of design.metalPolygons)
      facePolygon(poly, poly.role === "ground" ? 0x8a949b : brass, 0.0002);
    // Junction rows describe a lumped element. Show its centerline as a model marker.
    for (const path of design.junctions || []) {
      for (let i = 1; i < path.points.length; i++) {
        const pt = (k) => [path.points[k][0], 0.0004, path.points[k][1]];
        wire(designGroup, pt(i - 1), pt(i), path.widthMm || 0.001, accent);
      }
    }
  } else if (system.platform === "neutral" && design?.selectedMove?.pathUm) {
    const path = design.selectedMove.pathUm;
    const [x0, y0] = path[0],
      last = path.length - 1;
    const metric = ([x, y]) => [(x - x0) / 1000, 0, (y - y0) / 1000];
    for (let i = 1; i <= last; i++)
      wire(designGroup, metric(path[i - 1]), metric(path[i]), 0.00016, accent);
    for (const [i, point] of path.entries())
      piece(
        designGroup,
        sphere,
        metric(point),
        [0.0007, 0.0007, 0.0007],
        i === last ? brass : accent,
      );
    transported = piece(
      designGroup,
      sphere,
      [0, 0.0004, 0],
      [0.00085, 0.00085, 0.00085],
      0xf3a05e,
    );
  }
  let selection = null,
    frame = null,
    focus = "installation";
  function paint() {
    const lit = new Set([selection, frame?.part, ...(frame?.targets || [])]);
    for (const [id, obj] of objects) {
      obj.visible =
        focus !== "design" && (focus !== "endpoint" || id === "endpoint");
      obj.traverse((m) => {
        if (!m.isMesh || m.userData.marker) return;
        m.material = lit.has(id) ? material(0xd1af65) : m.userData.rest;
      });
    }
    designGroup.visible = focus === "design";
    markers.forEach(
      (m, i) =>
        (m.visible = Boolean(
          frame?.id === "compare-observation" ||
            (i === 0 && frame?.id === "device-response"),
        )),
    );
  }
  paint();
  return {
    root,
    anchors,
    update(next, nativeStep) {
      frame = next;
      if (transported && nativeStep) {
        const [ox, oy] = design.selectedMove.pathUm[0],
          [x, y] = nativeStep.pathUm.at(-1);
        transported.position.set((x - ox) / 1000, 0.0004, (y - oy) / 1000);
      }
      paint();
    },
    select(id) {
      selection = id;
      paint();
    },
    setFocus(id) {
      focus = id;
      paint();
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials.values()) m.dispose();
    },
  };
}
