import * as T from "three";
import { OrbitControls } from "/three/OrbitControls.js";
import { createStage } from "./scene.js";

const format = (value) =>
  Number(value.toPrecision(4)).toLocaleString("en-US", {
    maximumSignificantDigits: 4,
  });
export function lengthLabel(mm) {
  if (mm >= 1000) return format(mm / 1000) + " m";
  if (mm >= 1) return format(mm) + " mm";
  if (mm >= 0.001) return format(mm * 1000) + " µm";
  return format(mm * 1e6) + " nm";
}
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}

/** Keep the physical model in mm. Camera presets change the viewing volume, never the model. */
export function createPhysicalViews(host, build, onPick, onDetail) {
  const toolbar = element("section", null, "system-tools");
  toolbar.setAttribute("aria-label", "Physical model views");
  toolbar.hidden = true;
  host.closest(".workbench").before(toolbar);
  const modes = element("div", null, "mode-switch");
  const physical = element("button", "Physical system"),
    detail = element("button", "Debugger detail");
  modes.append(physical, detail);
  modes.hidden = !onDetail;
  const focusLabel = element("label", "Focus "),
    focusBox = element("select");
  focusBox.setAttribute("aria-label", "Physical camera focus");
  focusLabel.append(focusBox);
  const partLabel = element("label", "Inspect "),
    partBox = element("select");
  partBox.setAttribute("aria-label", "Inspect physical component");
  partLabel.append(partBox);
  toolbar.append(modes, focusLabel, partLabel);
  const info = element("details", null, "system-info");
  info.hidden = true;
  const summary = element("summary", "Physical dimensions and connections"),
    body = element("div");
  info.append(summary, body);
  host.closest(".workbench").after(info);
  const layer = element("div", null, "metric-layer");
  layer.hidden = true;
  host.prepend(layer);
  const labels = element("div", null, "metric-labels"),
    bar = element("div", null, "metric-scale");
  const tick = element("div"),
    caption = element("span");
  bar.append(caption, tick);
  layer.append(labels, bar);
  let stage,
    camera,
    controls,
    model,
    system,
    focus,
    cameraFocus,
    frame,
    chosen,
    positions,
    isPhysical = false,
    wireFocus = null;
  let overviewWidth = 0,
    overviewHeight = 0;
  const hint = host.querySelector(".viewhint"),
    detailHint = hint?.textContent;
  const direction = new T.Vector3(0.45, 0.8, 1.28).normalize();
  const ray = new T.Raycaster(),
    vec = new T.Vector3();
  let dragging, pickedMarker;
  const markerReadout = element("p", null, "metric-readout");
  info.append(markerReadout);
  markerReadout.hidden = true;
  function startRenderer() {
    if (stage) return;
    stage = createStage(
      layer,
      "Metric 3D installation with shared hardware, connections and quantum device",
    );
    stage.world.remove(
      ...stage.world.children.filter(
        (o) => o.userData.ground || o.isGridHelper || o.type === "GridHelper",
      ),
    );
    camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.001, 10000);
    controls = new OrbitControls(camera, stage.canvas);
    controls.minZoom = 0.12;
    controls.maxZoom = 48;
    controls.maxPolarAngle = Math.PI * 0.97;
    controls.addEventListener("change", draw);
    stage.canvas.addEventListener(
      "pointerdown",
      (e) => (dragging = [e.clientX, e.clientY]),
    );
    stage.canvas.addEventListener("pointerup", (e) => {
      if (
        !dragging ||
        Math.hypot(e.clientX - dragging[0], e.clientY - dragging[1]) > 5
      )
        return;
      const rect = stage.canvas.getBoundingClientRect();
      ray.setFromCamera(
        {
          x: (2 * (e.clientX - rect.left)) / rect.width - 1,
          y: 1 - (2 * (e.clientY - rect.top)) / rect.height,
        },
        camera,
      );
      ray.near = camera.near;
      ray.far = camera.far;
      for (const hit of ray.intersectObject(model.root, true)) {
        let obj = hit.object,
          part = null,
          marker = null,
          visible = true;
        while (obj) {
          visible &&= obj.visible;
          if (!marker && obj.userData.readout) marker = obj;
          if (visible && obj.userData.conductor && model.pickConductor) {
            model.pickConductor(obj.userData.part, obj.userData.conductor);
            return;
          }
          if (visible && obj.userData.qubit && model.pickQubit) {
            model.pickQubit(obj.userData.qubit);
            return;
          }
          const id = obj.userData.part;
          if (
            !part &&
            id &&
            (system.parts.some((p) => p.id === id) ||
              system.links.some((l) => l.id === id))
          )
            part = id;
          obj = obj.parent;
        }
        if (visible && part) {
          pick(part, marker);
          return;
        }
      }
    });
    new ResizeObserver(resize).observe(layer);
  }
  function pick(id, marker = null) {
    pickedMarker = marker;
    partBox.value = id;
    info.open = true;
    onPick(id);
  }
  function span() {
    return Math.max(cameraFocus?.spanMm || focus?.spanMm || 1, 0.000001);
  }
  function resize() {
    if (!isPhysical || !stage || !focus || !layer.clientHeight) return;
    const w = layer.clientWidth,
      h = layer.clientHeight;
    const width = cameraFocus.fitWidth
      ? Math.max(cameraFocus.fitWidth, (cameraFocus.fitHeight * w) / h)
      : focus === system.focus[0]
        ? Math.max(span(), overviewWidth, (overviewHeight * w) / h)
        : span() * Math.max(1, (w / h) * 0.46);
    camera.left = -width / 2;
    camera.right = width / 2;
    camera.top = (width * h) / w / 2;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
    stage.renderer.setSize(w, h, false);
    draw();
  }
  function home() {
    if (!isPhysical || !model) return;
    focus =
      wireFocus ??
      system.focus.find((p) => p.id === focusBox.value) ??
      system.focus[0];
    cameraFocus = wireFocus ?? model.cameraFocus?.(focus) ?? focus;
    controls.target.fromArray(cameraFocus.centerMm);
    camera.position
      .copy(controls.target)
      .addScaledVector(cameraFocus.direction ?? direction, span() * 1.45);
    camera.near = span() * (wireFocus ? 1.17 : 0.001);
    camera.far = span() * (wireFocus ? 1.85 : 4);
    camera.zoom = 1;
    model.setFocus?.(focus.id, span());
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
    if (focus === system.focus[0] && !cameraFocus.fitWidth) {
      overviewWidth = overviewHeight = 0;
      for (const part of system.parts) {
        for (const sx of [-0.5, 0.5])
          for (const sy of [-0.5, 0.5])
            for (const sz of [-0.5, 0.5]) {
              vec.fromArray(part.centerMm);
              vec.x += sx * part.sizeMm[0];
              vec.y += sy * part.sizeMm[1];
              vec.z += sz * part.sizeMm[2];
              model.displayPoint?.(vec);
              vec.applyMatrix4(camera.matrixWorldInverse);
              overviewWidth = Math.max(overviewWidth, Math.abs(vec.x) * 2.16);
              overviewHeight = Math.max(overviewHeight, Math.abs(vec.y) * 2.22);
            }
      }
    }
    camera.updateProjectionMatrix();
    controls.update();
    resize();
  }
  function draw() {
    if (!isPhysical || !model || !focus) return;
    stage.renderer.render(stage.world, camera);
    markerReadout.textContent = pickedMarker?.userData.readout || "";
    markerReadout.hidden = !markerReadout.textContent;
    const mmPerPx =
      (camera.right - camera.left) /
      (camera.zoom * Math.max(layer.clientWidth, 1));
    const desired = mmPerPx * Math.min(115, layer.clientWidth * 0.21);
    const decade = 10 ** Math.floor(Math.log10(desired));
    const step = ([5, 2, 1].find((f) => f * decade <= desired) ?? 1) * decade;
    tick.style.width = step / mmPerPx + "px";
    caption.textContent =
      model.scaleLabel?.(lengthLabel(step)) ?? lengthLabel(step);
    const anchors = model.anchors,
      candidates = new Set();
    if (chosen) candidates.add(chosen);
    if (focus === system.focus[0]) {
      for (const id of system.overviewLabels ?? [
        "chamber",
        "controller",
        "laser",
      ])
        if (anchors.has(id)) candidates.add(id);
    } else if (anchors.has(focus.id) && span() > 25) candidates.add(focus.id);
    if (frame?.part) candidates.add(frame.part);
    labels.replaceChildren();
    const used = [];
    model.labelQubits?.(
      labels,
      camera,
      layer.clientWidth,
      layer.clientHeight,
      used,
    );
    for (const id of candidates) {
      const at = anchors.get(id),
        part = system.parts.find((p) => p.id === id);
      if (!at || !part) continue;
      vec.copy(at);
      model.displayPoint?.(vec);
      vec.project(camera);
      const x = ((vec.x + 1) * layer.clientWidth) / 2,
        y = ((1 - vec.y) * layer.clientHeight) / 2;
      if (
        Math.abs(vec.z) > 1 ||
        x < 45 ||
        x > layer.clientWidth - 45 ||
        y < 50 ||
        y > layer.clientHeight - 47 ||
        used.some(([a, b]) => Math.abs(a - x) < 140 && Math.abs(b - y) < 30)
      )
        continue;
      const label = element("span", part.label, "annotation");
      label.classList.toggle("active", id === chosen || id === frame?.part);
      label.style.left = x + "px";
      label.style.top = y + "px";
      labels.append(label);
      used.push([x, y]);
    }
  }
  function updateInfo() {
    if (!system) return;
    const part = system.parts.find((p) => p.id === chosen);
    partBox.value = chosen ?? "";
    body.replaceChildren();
    if (part) {
      const dims = part.sizeMm.map(lengthLabel).join(" × ");
      body.append(
        element("h3", part.label),
        element("p", dims + " (width × height × depth). " + part.basis),
      );
    }
    const connections = system.links.filter(
      (l) =>
        l.id === chosen || (part && (l.from === part.id || l.to === part.id)),
    );
    for (const link of connections) {
      const points = link.pointsMm;
      const length = points
        .slice(1)
        .reduce(
          (sum, pt, i) =>
            sum + Math.hypot(...pt.map((v, k) => v - points[i][k])),
          0,
        );
      body.append(
        element(
          "p",
          link.kind +
            " · " +
            link.from +
            " → " +
            link.to +
            " · " +
            lengthLabel(length) +
            " along the route",
        ),
      );
    }
    body.append(element("p", system.note));
    for (const ref of system.sources) {
      const a = element("a", ref.title);
      a.href = ref.url;
      a.target = "_blank";
      a.rel = "noopener";
      body.append(a);
    }
  }
  function mode(toPhysical) {
    isPhysical = toPhysical && Boolean(system);
    layer.hidden = !isPhysical;
    host.classList.toggle("metric-active", isPhysical);
    if (hint)
      hint.textContent = isPhysical
        ? "Drag to orbit · Scroll to zoom · Select hardware"
        : detailHint;
    physical.setAttribute("aria-pressed", isPhysical);
    detail.setAttribute("aria-pressed", !isPhysical);
    focusLabel.hidden = partLabel.hidden = !isPhysical;
    info.hidden = !isPhysical;
    if (isPhysical) {
      model.update(frame, positions);
      model.select?.(chosen);
      home();
    } else onDetail?.();
  }
  physical.onclick = () => mode(true);
  detail.onclick = () => mode(false);
  focusBox.onchange = () => {
    wireFocus = null;
    model?.clearWire?.();
    home();
  };
  partBox.onchange = () => pick(partBox.value || null);
  function load(run) {
    const prior = system && { physical: isPhysical, focus: focusBox.value };
    system = run.system;
    wireFocus = null;
    if (model) {
      stage.world.remove(model.root);
      // Shared primitive geometries and cached materials belong to their builders.
      model.dispose?.();
      model = null;
    }
    frame = null;
    chosen = null;
    positions = undefined;
    pickedMarker = null;
    toolbar.hidden = !system;
    if (!system) {
      mode(false);
      return;
    }
    startRenderer();
    model = build(system, run);
    stage.world.add(model.root);
    focusBox.replaceChildren(
      ...system.focus.map((f) => new Option(f.label, f.id)),
    );
    partBox.replaceChildren(
      new Option("Choose component", ""),
      ...system.parts.map((p) => new Option(p.label, p.id)),
      ...system.links
        .filter((l) => !system.parts.some((p) => p.id === l.id))
        .map((l) => new Option(l.kind + " · " + l.id, l.id)),
    );
    if (prior && system.focus.some((f) => f.id === prior.focus))
      focusBox.value = prior.focus;
    focus = system.focus.find((f) => f.id === focusBox.value);
    mode(prior?.physical ?? true);
    updateInfo();
  }
  return {
    load,
    home,
    redraw: draw,
    focusOn(id) {
      if (!system?.focus.some((f) => f.id === id)) return;
      focusBox.value = id;
      wireFocus = null;
      model?.clearWire?.();
      home();
    },
    openWire(id, conductor) {
      if (!model?.openWire) return;
      model.setEnlarged?.(false);
      wireFocus = model.openWire(id, conductor);
      if (wireFocus) {
        focusBox.value = "";
        home();
      }
    },
    closeWire() {
      if (!wireFocus) return;
      wireFocus = null;
      model?.clearWire?.();
      focusBox.selectedIndex = 0;
      home();
    },
    setEnlarged(value) {
      if (value) {
        wireFocus = null;
        model?.clearWire?.();
      }
      model?.setEnlarged?.(value);
      if (isPhysical) home();
    },
    pointOnPlane(clientX, clientY, heightMm) {
      if (!camera || !isPhysical) return null;
      const rect = stage.canvas.getBoundingClientRect();
      ray.setFromCamera(
        {
          x: (2 * (clientX - rect.left)) / rect.width - 1,
          y: 1 - (2 * (clientY - rect.top)) / rect.height,
        },
        camera,
      );
      const point = ray.ray.intersectPlane(
        new T.Plane(new T.Vector3(0, 1, 0), -heightMm),
        vec,
      );
      return point?.toArray() ?? null;
    },
    get active() {
      return isPhysical;
    },
    show(f, selection, p) {
      const changed = selection !== chosen;
      if (changed && !selection) pickedMarker = null;
      frame = f;
      chosen = selection;
      positions = p;
      if (isPhysical) {
        model.update(f, p);
        model.select?.(selection);
        draw();
      }
      if (changed) updateInfo();
    },
  };
}
