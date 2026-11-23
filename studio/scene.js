import * as T from "three";
import { OrbitControls } from "/three/OrbitControls.js";

export const parts = Object.create(null);

const materials = new Map();
function surface(color, metalness = 0.12, roughness = 0.5) {
  const key = [color, metalness, roughness].join("/");
  if (!materials.has(key))
    materials.set(
      key,
      new T.MeshStandardMaterial({ color, metalness, roughness }),
    );
  return materials.get(key);
}
const pcb = surface(0x26785e),
  mask = surface(0x255548),
  silver = surface(0xb8c4c7, 0.54);
const graphite = surface(0x273439),
  ceramic = surface(0xb4a284),
  gold = surface(0xd2ac60, 0.5);
const unitBox = new T.BoxGeometry(1, 1, 1);
function box(parent, x, y, z, w, h, d, mat) {
  const mesh = new T.Mesh(unitBox, mat);
  mesh.scale.set(w, h, d);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}
function cylinder(parent, x, y, z, r, h, mat, sides = 12) {
  const mesh = new T.Mesh(new T.CylinderGeometry(r, r, h, sides), mat);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}
function group(parent, name, x, y, z) {
  const g = new T.Group();
  g.position.set(x, y, z);
  g.userData.part = name;
  parent.add(g);
  return g;
}
function silk(parent, text, x, z, width) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "bold 44px monospace";
  ctx.fillStyle = "#ecf3d8";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 2, 34, 508);
  const map = new T.CanvasTexture(canvas);
  map.colorSpace = T.SRGBColorSpace;
  const label = new T.Mesh(
    new T.PlaneGeometry(width, width / 8),
    new T.MeshBasicMaterial({ map, transparent: true, depthWrite: false }),
  );
  label.position.set(x, 5.16, z);
  label.rotation.x = -Math.PI / 2;
  parent.add(label);
}
function board(parent, role) {
  const isTx = role === "tx",
    facing = isTx ? 1 : -1;
  const base = group(parent, null, 0, 0, 0);
  base.userData.board = role;
  box(base, 0, 4, 0, 156, 2, 108, pcb);
  box(base, 0, 2.8, 0, 155, 0.5, 107, gold);
  for (const x of [-69, 69])
    for (const z of [-46, 46]) {
      cylinder(base, x, 0, z, 3.9, 6, gold, 6);
      cylinder(base, x, 5.5, z, 4.1, 1.2, gold);
      cylinder(base, x, 6.4, z, 2.7, 1.3, silver);
      box(base, x, 7.1, z, 3.3, 0.2, 0.55, graphite);
    }
  // Solder-mask traces and vias use a repeatable layout in board-local millimetres.
  const paths = [];
  for (let i = 0; i < 19; i++) {
    const z = -34 + i * 3.45,
      x = -57 + (i % 5) * 2.3;
    const points = [
      [x, z],
      [x + 19, z],
      [x + 25, z + 6],
      [27 + (i % 4) * 3, z + 6],
      [47, z + 2],
      [59, z + 2],
    ];
    for (let j = 1; j < points.length; j++) {
      for (const [px, pz] of [points[j - 1], points[j]])
        paths.push(px * facing, 5.08, pz);
    }
  }
  const traceGeometry = new T.BufferGeometry();
  traceGeometry.setAttribute(
    "position",
    new T.Float32BufferAttribute(paths, 3),
  );
  base.add(
    new T.LineSegments(
      traceGeometry,
      new T.LineBasicMaterial({ color: 0x72a87b }),
    ),
  );
  const fpga = group(base, role + "-fpga", -15 * facing, 5, 0);
  box(fpga, 0, 1, 0, 43, 2, 41, graphite);
  box(fpga, 0, 3, 0, 39, 2, 37, silver);
  for (let i = 0; i < 12; i++)
    box(fpga, -17 + i * 3.1, 8, 0, 1.4, 9, 36, silver);
  const mem = group(base, isTx ? "tx-fpga" : "ram", 9 * facing, 5, -31);
  for (let i = 0; i < 3; i++) {
    const x = (i * 14 - 13) * facing;
    box(mem, x, 1.3, 0, 10, 2.5, 14, graphite);
    for (let j = 0; j < 7; j++)
      for (const side of [-1, 1])
        box(mem, x + side * 5.2, 0.4, j * 1.7 - 5, 0.8, 0.8, 0.7, silver);
  }
  const convert = group(base, isTx ? "adc" : "dac", -45 * facing, 5, 24);
  box(convert, 0, 1.5, 0, 18, 3, 17, graphite);
  box(convert, 0, 3.2, 0, 12, 0.5, 11, silver);
  for (const x of [-15, 6]) {
    box(convert, x, 3, 19, 10, 6, 12, gold);
    const pin = cylinder(convert, x, 3, 27, 4.3, 10, gold);
    pin.rotation.x = Math.PI / 2;
    const opening = cylinder(convert, x, 3, 32.3, 2.7, 0.65, graphite);
    opening.rotation.x = Math.PI / 2;
    const tip = cylinder(convert, x, 3, 32.8, 0.7, 0.6, gold);
    tip.rotation.x = Math.PI / 2;
  }
  const port = group(base, role + "-port", facing * 65, 5, 2);
  box(port, 0, 5, 0, 29, 10, 16, silver);
  for (const z of [-4, 0, 4]) box(port, 0, 10.1, z, 10, 0.5, 1.25, graphite);
  box(port, facing * 14, 5, 0, 3, 8, 13, graphite);
  for (const z of [-3.2, 3.2]) {
    box(port, facing * 18, 5, z, 8, 5, 5, surface(0x58b8ac));
    box(port, facing * 24, 5, z, 6, 4, 4, graphite);
  }
  for (let i = 0; i < 9; i++)
    for (const z of [-18, 19]) {
      const x = (25 + i * 3.4) * facing;
      box(base, x, 5.8, z, 1.5, 1.5, 3.2, ceramic);
    }
  box(base, -52 * facing, 7, -29, 21, 4, 8, graphite);
  for (let i = 0; i < 9; i++)
    box(base, (-61 + i * 2.2) * facing, 10, -29, 1.1, 4, 1.1, gold);
  silk(base, isTx ? "A  /  ACQUISITION" : "B  /  PULSE ENGINE", 8, 40, 58);
  silk(base, "RFSoC", -15 * facing, -23, 25);
  return { base, port, fpga, mem, convert, facing };
}

// Draw the same mesh vertices with a depth-sorted CPU projection when WebGL is unavailable.
// All studio cameras are orthographic. Intersecting a depth plane is linear in these
// projected coordinates, including when a microscope view clips through an enclosure.
function clipDepth(polygon, plane, keepAbove) {
  const out=[];
  let prev=polygon.at(-1);
  for (const next of polygon) {
    const inside=keepAbove ? next[2]>=plane : next[2]<=plane;
    const wasInside=keepAbove ? prev[2]>=plane : prev[2]<=plane;
    if (inside!==wasInside) {
      const t=(plane-prev[2])/(next[2]-prev[2]);
      out.push([prev[0]+t*(next[0]-prev[0]),prev[1]+t*(next[1]-prev[1]),plane]);
    }
    if(inside) out.push(next);
    prev=next;
  }
  return out;
}
function softwareRenderer(canvas) {
  const c = canvas.getContext("2d");
  const v = new T.Vector3(),
    n = new T.Vector3(),
    matrix = new T.Matrix4(),
    normalMatrix = new T.Matrix3();
  const light = new T.Vector3(-0.4, 0.9, 0.4).normalize(),
    color = new T.Color();
  return {
    setSize(w, h) {
      canvas.width = w;
      canvas.height = h;
    },
    render(scene, camera) {
      const w = canvas.width,
        h = canvas.height;
      c.fillStyle = "#1c3036";
      c.fillRect(0, 0, w, h);
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      const vp = new T.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      const faces = [];
      const frustum = new T.Frustum().setFromProjectionMatrix(vp);
      scene.traverseVisible((obj) => {
        if (
          !obj.isMesh ||
          obj.userData.ground ||
          !obj.geometry.attributes.position ||
          obj.material.map ||
          !frustum.intersectsObject(obj)
        )
          return;
        const pos = obj.geometry.attributes.position,
          norm = obj.geometry.attributes.normal,
          idx = obj.geometry.index;
        matrix.multiplyMatrices(vp, obj.matrixWorld);
        normalMatrix.getNormalMatrix(obj.matrixWorld);
        const points = [];
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
          points.push([((v.x + 1) * w) / 2, ((1 - v.y) * h) / 2, v.z]);
        }
        const count = idx ? idx.count : pos.count;
        const range = obj.geometry.drawRange;
        const end = Math.min(count, range.start + range.count);
        for (let j = range.start; j < end; j += 3) {
          const a = idx ? idx.getX(j) : j,
            b = idx ? idx.getX(j + 1) : j + 1,
            d = idx ? idx.getX(j + 2) : j + 2;
          const p = points[a],
            q = points[b],
            r = points[d];
          if (
            (p[2] < -1 && q[2] < -1 && r[2] < -1) ||
            (p[2] > 1 && q[2] > 1 && r[2] > 1)
          )
            continue;
          if (
            (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]) >=
            0
          )
            continue;
          n.fromBufferAttribute(norm, a).applyMatrix3(normalMatrix).normalize();
          color
            .copy(obj.material.color)
            .multiplyScalar(0.55 + 0.65 * Math.max(0, n.dot(light)));
          const style=color.getStyle();
          if ([p,q,r].every(point=>Math.abs(point[2])<=1)) {
            faces.push([p,q,r,(p[2]+q[2]+r[2])/3,style]);
          } else {
            const visible=clipDepth(clipDepth([p,q,r],-1,true),1,false);
            for(let k=2;k<visible.length;k++) {
              const [a,b,c]=[visible[0],visible[k-1],visible[k]];
              faces.push([a,b,c,(a[2]+b[2]+c[2])/3,style]);
            }
          }
        }
      });
      faces.sort((a, b) => b[3] - a[3]);
      for (const [p, q, r, , style] of faces) {
        c.fillStyle = style;
        c.beginPath();
        c.moveTo(p[0], p[1]);
        c.lineTo(q[0], q[1]);
        c.lineTo(r[0], r[1]);
        c.closePath();
        c.fill();
      }
    },
  };
}

export { box, cylinder, group, surface };

export function createStage(host, description) {
  let canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", description);
  host.prepend(canvas);
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
  } catch {
    const freshCanvas = canvas.cloneNode(false);
    canvas.replaceWith(freshCanvas);
    canvas = freshCanvas;
    renderer = softwareRenderer(canvas);
  }
  const world = new T.Scene();
  world.background = new T.Color(0x20343a);
  world.add(new T.HemisphereLight(0xf1faf8, 0x839890, 2.25));
  const sun = new T.DirectionalLight(0xfff0d4, 3.4);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, {
    left: -460,
    right: 460,
    top: 410,
    bottom: -410,
    far: 1100,
  });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.normalBias = 0.35;
  sun.position.set(-125, 340, 220);
  world.add(sun);
  const ground = box(
    world,
    0,
    -4.2,
    0,
    2400,
    2,
    2400,
    surface(0x22363b, 0, 0.95),
  );
  ground.receiveShadow = true;
  ground.userData.ground = true;
  const grid = new T.GridHelper(1600, 80, 0x49636a, 0x354d54);
  grid.position.y = -3.1;
  world.add(grid);
  return { canvas, renderer, world };
}

export function createScene(host, onPick, onMove) {
  const { canvas, renderer, world } = createStage(
    host,
    "Orbitable 3D model of the acquisition board, fiber and pulse board",
  );
  const tx = board(world, "tx"),
    rx = board(world, "rx"),
    wire = group(world, "fiber", 0, 0, 0);
  for (const { base } of [tx, rx])
    base.traverse((obj) => {
      if (obj.isMesh && !obj.material.map) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
  const assemblies = {
    adc: tx.convert,
    "tx-fpga": tx.fpga,
    "tx-port": tx.port,
    fiber: wire,
    "rx-port": rx.port,
    "rx-fpga": rx.fpga,
    ram: rx.mem,
    dac: rx.convert,
  };
  const anchors = document.querySelector("#labels");
  function label() {
    const el = document.createElement("span");
    el.className = "annotation";
    anchors.append(el);
    return el;
  }
  const tags = [label(), label(), label()];
  const camera = new T.OrthographicCamera(-200, 200, 140, -140, 1, 4000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minZoom = 0.42;
  controls.maxZoom = 4;
  const pickRay = new T.Raycaster(),
    plane = new T.Plane(new T.Vector3(0, 1, 0), 0);
  let active = "fiber",
    selected = null,
    moving = false,
    drag = null,
    down = null,
    fitWidth = 440,
    curve,
    frame;
  const indicator = new T.Mesh(
    new T.TorusGeometry(7, 1.3, 8, 30),
    surface(0x92f4c9, 0.05),
  );
  indicator.rotation.x = -Math.PI / 2;
  world.add(indicator);
  function aim(e) {
    const r = canvas.getBoundingClientRect();
    pickRay.setFromCamera(
      new T.Vector2(
        ((e.clientX - r.left) * 2) / r.width - 1,
        1 - ((e.clientY - r.top) * 2) / r.height,
      ),
      camera,
    );
  }
  function pick(e) {
    aim(e);
    const hits = pickRay.intersectObjects([tx.base, rx.base, wire], true);
    let node = hits[0]?.object,
      part = null,
      role = null;
    while (node) {
      part ||= node.userData.part;
      role ||= node.userData.board;
      node = node.parent;
    }
    return { part, role };
  }
  function worldPoint(obj) {
    return obj.getWorldPosition(new T.Vector3());
  }
  function partPoint(id) {
    if (id === "fiber") return curve.getPoint(0.5);
    return worldPoint(assemblies[id]);
  }
  function placeTag(tag, txt, p, act) {
    const xy = p.clone().project(camera);
    tag.textContent = txt;
    tag.classList.toggle("active", act);
    tag.style.left = (xy.x + 1) * 50 + "%";
    tag.style.top = (1 - xy.y) * 50 + "%";
    tag.hidden = Math.abs(xy.x) > 0.91 || Math.abs(xy.y) > 0.9;
  }
  function draw() {
    if (!curve) return;
    const focus = selected || active;
    const p = partPoint(focus);
    p.y += focus === "fiber" ? 2 : 15;
    indicator.position.copy(p);
    indicator.visible = true;
    renderer.render(world, camera);
    const a = worldPoint(tx.base);
    a.z -= 39;
    a.y += 19;
    const b = worldPoint(rx.base);
    b.z -= 39;
    b.y += 19;
    placeTag(tags[0], "A / ACQUISITION", a, false);
    placeTag(tags[1], "B / PULSE ENGINE", b, false);
    p.y += 9;
    const s = frame?.state;
    let reading = "";
    if (s && focus === "dac")
      reading = s.marker ? " · marker high" : " · " + s.outputMv + " mV";
    if (s && focus === "fiber" && s.inFlight !== null)
      reading = " · " + s.inFlight.toString(2).padStart(2, "0");
    if (s && focus === "rx-fpga" && s.fault) reading = " · fault";
    placeTag(tags[2], parts[focus] + reading, p, true);
  }
  function wirePath() {
    for (const mesh of [...wire.children]) {
      mesh.geometry.dispose();
      wire.remove(mesh);
    }
    const a = worldPoint(tx.port).add(new T.Vector3(28, 5, 0)),
      b = worldPoint(rx.port).add(new T.Vector3(-28, 5, 0));
    const midZ = Math.max(a.z, b.z) + 62;
    curve = new T.CatmullRomCurve3([
      a,
      a.clone().add(new T.Vector3(15, -1, 5)),
      new T.Vector3((a.x + b.x) / 2 - 12, 2, midZ),
      new T.Vector3((a.x + b.x) / 2 + 12, 2, midZ + 2),
      b.clone().add(new T.Vector3(-15, -1, 5)),
      b,
    ]);
    for (const offset of [-2.25, 2.25]) {
      const line = new T.CatmullRomCurve3(
        curve.points.map((p) => p.clone().add(new T.Vector3(0, 0.25, offset))),
      );
      wire.add(
        new T.Mesh(
          new T.TubeGeometry(line, 56, 1.45, 7, false),
          surface(offset > 0 ? 0xe6af49 : 0xf0c45c),
        ),
      );
    }
  }
  function resize() {
    const w = host.clientWidth,
      h = host.clientHeight;
    if (!w || !h) return;
    const half = Math.max(fitWidth / 2, (100 * w) / h);
    camera.left = -half;
    camera.right = half;
    camera.top = (half * h) / w;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    draw();
  }
  function home() {
    const average = tx.base.position
      .clone()
      .add(rx.base.position)
      .multiplyScalar(0.5);
    average.z += 9;
    fitWidth = Math.max(
      435,
      tx.base.position.distanceTo(rx.base.position) + 205,
    );
    controls.target.copy(average);
    camera.position.copy(average).add(new T.Vector3(70, 365, 490));
    camera.zoom = 1;
    controls.update();
    resize();
  }
  controls.addEventListener("change", draw);
  new ResizeObserver(resize).observe(host);
  canvas.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
    if (!moving) return;
    const { role } = pick(e);
    if (!role) return;
    const base = role === "tx" ? tx.base : rx.base;
    const hit = pickRay.ray.intersectPlane(plane, new T.Vector3());
    if (!hit) return;
    drag = {
      role,
      base,
      original: base.position.clone(),
      offset: base.position.clone().sub(hit),
    };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    aim(e);
    const p = pickRay.ray.intersectPlane(plane, new T.Vector3());
    if (!p) return;
    drag.base.position.copy(p.add(drag.offset));
    drag.base.position.y = 0;
    wirePath();
    draw();
  });
  canvas.addEventListener("pointerup", (e) => {
    if (drag) {
      const { role, base, original } = drag;
      drag = null;
      const dest = {
        x: Math.round(base.position.x),
        z: Math.round(base.position.z),
      };
      base.position.copy(original);
      wirePath();
      draw();
      onMove(role, dest);
      return;
    }
    if (
      !moving &&
      down &&
      Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5
    ) {
      const { part, role } = pick(e);
      if (part || role) onPick(part || role + "-fpga");
    }
    down = null;
  });
  canvas.addEventListener("pointercancel", () => {
    if (drag) {
      drag.base.position.copy(drag.original);
      drag = null;
      wirePath();
      draw();
    }
    down = null;
  });
  return {
    setProgram(p, nodes) {
      for (const node of nodes) {
        const obj = assemblies[node.id];
        if (!obj) throw new Error("Missing 3D assembly for " + node.id);
        const mount = { tx: tx.base, rx: rx.base, bench: world }[node.mount];
        if (obj.parent !== mount)
          throw new Error("Unexpected mount for " + node.id);
        parts[node.id] = node.label;
        obj.position.set(node.xMm, node.yMm, node.zMm);
      }
      tx.base.position.set(p.tx.x, 0, p.tx.z);
      rx.base.position.set(p.rx.x, 0, p.rx.z);
      wirePath();
      home();
    },
    setFrame(f, chosen) {
      frame = f;
      active = f?.part || "adc";
      selected = chosen;
      const inflight = frame?.state.inFlight != null;
      for (const child of wire.children)
        child.material = surface(inflight ? 0xffd46c : 0xcaa04b);
      indicator.material = surface(f?.state.fault ? 0xf18b60 : 0x92f4c9);
      draw();
    },
    home,
    setMoving(v) {
      moving = v;
      controls.enabled = !v;
      canvas.style.cursor = v ? "move" : "grab";
    },
  };
}
