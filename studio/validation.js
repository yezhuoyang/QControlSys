import { createPhysicalViews } from "./metric-stage.js";
import { buildValidationScene } from "./validation-scene.js";
import { createScope } from "./scope.js";
import { channels, operations } from "./controller.js";

const $ = (id) => document.getElementById(id);
const format = (v) =>
  typeof v === "number" ? Number(v.toPrecision(5)).toString() : String(v);
const axes = {
  qccd: ["probeDelayNs", "Probe delay (ns)"],
  neutral: ["appliedFrequencyMHz", "Applied RF frequency (MHz)"],
  superconducting: ["amplitudeIf", "Applied IF amplitude (source units)"],
};
const names = {
  qccd: "QCCD Studio",
  neutral: "ZAC",
  superconducting: "Qiskit Metal",
};
let report,
  platform,
  benchmarkId,
  study,
  row,
  design,
  current,
  steps = [],
  index = 0,
  selected = null,
  request = 0;
let plotPoints = [],
  nativeStep = null;
const metric = createPhysicalViews(
  $("viewport"),
  buildValidationScene,
  (id) => {
    selected = id;
    showStep(index);
  },
  null,
);
const waveform = createScope(
  $("scope"),
  (i) => showStep(Math.max(i, 0)),
  channels,
);

function element(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}
function link(text, href) {
  const el = element("a", text);
  el.href = href;
  return el;
}
function message(error) {
  $("alert").textContent = error || "";
  $("alert").hidden = !error;
}
async function json(url, params) {
  const res = await fetch(url, params);
  if (!res.ok) throw Error(await res.text());
  return res.json();
}
function stat(label, value) {
  const box = document.createElement("div");
  box.append(element("b", value), element("small", label));
  return box;
}
function axis() {
  return study.meta.plotAxis || axes[platform];
}
function visibleRows() {
  const key = study.meta.seriesKey;
  return key
    ? study.rows.filter((r) => r[key] === $("series").value)
    : study.rows;
}
function drawPlot() {
  if (!study) return;
  const canvas = $("comparison"),
    ctx = canvas.getContext("2d");
  const w = canvas.clientWidth,
    h = canvas.clientHeight,
    dpr = Math.min(devicePixelRatio, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  const [key, label] = axis();
  const rows = [...visibleRows()].sort((a, b) => a[key] - b[key]);
  if (!rows.length) return;
  const xv = rows.map((r) => r[key]),
    yv = rows.flatMap((r) => [r.observed, r.predicted]);
  const xmin = Math.min(...xv),
    xmax = Math.max(...xv),
    bottom = Math.min(...yv),
    top = Math.max(...yv);
  const pad = (top - bottom) * 0.08 || 1,
    ymin = bottom - pad,
    ymax = top + pad;
  const left = 78,
    right = w - 16,
    base = h - 43;
  const x = (v) => left + ((right - left) * (v - xmin)) / (xmax - xmin || 1),
    y = (v) => base - ((base - 15) * (v - ymin)) / (ymax - ymin);
  ctx.font = "12px system-ui";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const val = ymin + ((ymax - ymin) * i) / 4;
    ctx.strokeStyle = "#e1e8e5";
    ctx.beginPath();
    ctx.moveTo(left, y(val));
    ctx.lineTo(right, y(val));
    ctx.stroke();
    ctx.fillStyle = "#486259";
    ctx.textAlign = "right";
    ctx.fillText(Number(val.toPrecision(3)).toString(), left - 7, y(val) + 4);
  }
  for (let i = 0; i <= 4; i++) {
    const val = xmin + ((xmax - xmin) * i) / 4;
    ctx.textAlign = i === 4 ? "right" : "center";
    ctx.fillText(Number(val.toPrecision(4)).toString(), x(val), base + 17);
  }
  ctx.textAlign = "center";
  ctx.fillText(label, (left + right) / 2, h - 3);
  ctx.strokeStyle = "#166a64";
  ctx.lineWidth = 2;
  ctx.beginPath();
  rows.forEach((r, i) =>
    i
      ? ctx.lineTo(x(r[key]), y(r.predicted))
      : ctx.moveTo(x(r[key]), y(r.predicted)),
  );
  ctx.stroke();
  plotPoints = rows.map((r) => ({ r, x: x(r[key]), y: y(r.observed) }));
  for (const p of plotPoints) {
    ctx.beginPath();
    ctx.fillStyle = p.r.split === "holdout" ? "#ac622b" : "#748b93";
    ctx.arc(p.x, p.y, rows.length > 70 ? 2.4 : 3.7, 0, 2 * Math.PI);
    ctx.fill();
    if (p.r.id === row?.id) {
      ctx.lineWidth = 1.7;
      ctx.strokeStyle = "#222f31";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }
}
$("comparison").onclick = (e) => {
  const rect = e.target.getBoundingClientRect(),
    px = e.clientX - rect.left,
    py = e.clientY - rect.top;
  const nearest = plotPoints.reduce((a, b) =>
    Math.hypot(a.x - px, a.y - py) < Math.hypot(b.x - px, b.y - py) ? a : b,
  );
  chooseCase(nearest.r.id);
};
new ResizeObserver(drawPlot).observe($("comparison"));

function showStudy() {
  const m = study.meta;
  $("seriesLabel").hidden = !m.seriesKey;
  if (m.seriesKey) {
    $("seriesLabel").querySelector("span").textContent = m.seriesTitle;
    $("series").replaceChildren(
      ...[...new Set(study.rows.map((r) => r[m.seriesKey]))].map(
        (v) => new Option(v, v),
      ),
    );
  }
  $("study").textContent = m.title;
  $("observable").textContent = m.observable + " · " + m.unit;
  $("criterion").textContent = m.criterion;
  $("scopeNote").textContent = m.scope;
  $("studyLinks").replaceChildren(
    link("Source measurements", m.source),
    link("Experimental paper", m.paper || m.source),
  );
  $("statistics").replaceChildren(
    stat("Calibration settings", study.calibrationCount),
    stat("Held-out settings", study.holdoutCount),
    stat("Held-out RMS error", format(study.rmse) + " " + m.unit),
  );
  $("verdict").textContent = study.metrics.passed
    ? "Held-out criterion met"
    : "Held-out criterion missed";
  $("verdict").dataset.passed = study.metrics.passed;
  $("plotCaption").textContent =
    "The line joins model predictions at the evaluated settings. Select a measurement to inspect its program.";
  showOptions();
  $("parameters").textContent = JSON.stringify(
    {
      parameters: study.parameters,
      metrics: study.metrics,
      independentScore: study.independentScore,
      path: m.physicalPath,
      drive: m.drive,
      traceObservable: m.traceObservable,
    },
    null,
    2,
  );
  $("rows").replaceChildren(
    ...study.rows.map((r) => {
      const tr = document.createElement("tr"),
        pick = element("button", r.id);
      pick.onclick = () => chooseCase(r.id);
      const first = document.createElement("td");
      first.append(pick);
      tr.append(
        first,
        ...[r.split, r.observed, r.predicted, r.residual].map((v) =>
          element("td", format(v)),
        ),
      );
      return tr;
    }),
  );
  drawPlot();
}
function showOptions() {
  $("observation").replaceChildren(
    ...visibleRows().map(
      (r) =>
        new Option(format(r[axis()[0]]) + " · " + r.split + " · " + r.id, r.id),
    ),
  );
}
$("series").onchange = () => {
  showOptions();
  const rows = visibleRows();
  chooseCase((rows.find((r) => r.split === "holdout") || rows[0]).id);
};

function showDesign() {
  nativeStep = null;
  $("designSteps").replaceChildren();
  $("designTitle").textContent = names[platform] + " design reference";
  let description,
    source = design.source;
  if (benchmarkId === "qccd-h2") {
    description =
      "Quantinuum’s archived shot circuits were compiled for Studio’s H2 racetrack. Replay the circuit for the selected phase, including its final analysis rotations.";
  } else if (platform === "qccd") {
    const f = design.frame,
      m = f.moves[0];
    description =
      m.ion +
      " travels from " +
      m.from +
      " through " +
      m.via.join(", ") +
      " to " +
      m.to +
      " in Studio model time " +
      f.start +
      "–" +
      f.end +
      ". The measured shuttle used a different trap.";
  } else if (platform === "neutral") {
    const m = design.selectedMove;
    description =
      "Native job " +
      m.job +
      " moves qubit " +
      m.qubit +
      " from (" +
      m.pathUm[0].join(", ") +
      ") to (" +
      m.pathUm.at(-1).join(", ") +
      ") µm. The design view shows this ZAC move. The camera measurements come from the separate cesium apparatus.";
  } else {
    description =
      "The design view shows a native TransmonPocket layout in millimetres, including ground cutouts, electrodes and a lumped junction marker. The emission experiment used a separate chip.";
  }
  if (platform === "neutral") {
    const job = design.selectedMove;
    const label = element("label", "Native ZAC phase "),
      select = document.createElement("select");
    select.setAttribute("aria-label", "Native ZAC phase");
    const out = element("p", "");
    select.replaceChildren(
      ...job.events.map((e, i) => new Option(e.nativeType + " · " + e.id, i)),
    );
    const advance = () => {
      nativeStep = job.events[Number(select.value)];
      const path = nativeStep.pathUm;
      out.textContent =
        format(nativeStep.beginUs) +
        "–" +
        format(nativeStep.endUs) +
        " µs · " +
        nativeStep.fromOwner +
        " → " +
        nativeStep.toOwner +
        " · (" +
        path[0].join(", ") +
        ") → (" +
        path.at(-1).join(", ") +
        ") µm";
      if (current) showStep(index);
    };
    select.onchange = () => {
      advance();
      zoomDesign();
    };
    label.append(select);
    $("designSteps").append(label, out);
    advance();
  }
  if (platform === "superconducting") {
    const pins = design.pins
      .map((p) => p.name + " (" + p.middle.join(", ") + ") mm")
      .join(" · ");
    $("designSteps").append(
      element(
        "p",
        pins +
          " · " +
          design.chip.substrateThicknessMm +
          " mm silicon thickness",
      ),
    );
  }
  $("designDescription").textContent = description;
  $("designLinks").replaceChildren(
    link(
      "Download design record",
      "/api/validation/" +
        platform +
        (benchmarkId === "qccd-h2" ? "/h2-design" : "/design"),
    ),
  );
  if (typeof source === "string" && source.startsWith("https://"))
    $("designLinks").append(link("Upstream source", source));
  if (platform === "qccd") {
    const native = link("Replay in QCCD Studio", "/qccd-studio");
    native.id = "nativeReplay";
    $("designLinks").append(native);
  } else {
    const zoom = element("button", "View design in 3D");
    zoom.onclick = zoomDesign;
    $("designLinks").append(zoom);
  }
  const compact = { ...design };
  for (const k of ["metalPolygons", "paths", "polygons", "junctions", "pins"])
    if (Array.isArray(compact[k])) compact[k] = compact[k].length + " records";
  $("design").textContent = JSON.stringify(compact, null, 2);
}
function zoomDesign() {
  if (!current) return;
  const focus = document.querySelector('[aria-label="Physical camera focus"]');
  focus.value = "design";
  focus.dispatchEvent(new Event("change"));
  $("viewport").scrollIntoView({ block: "center" });
}

function showStep(i) {
  if (!current || !steps.length) return;
  index = Math.max(0, Math.min(steps.length - 1, i));
  const f = steps[index],
    hardware = f.atNs != null,
    s = f.state;
  $("step").value = index;
  $("counter").textContent = index + 1 + " / " + steps.length;
  $("back").disabled = index === 0;
  $("next").disabled = index === steps.length - 1;
  $("when").classList.toggle("analysis-stamp", !hardware);
  $("when").textContent = hardware
    ? format(f.atNs) + " ns"
    : "Offline analysis";
  $("eventName").textContent = operations[f.op]?.[0] || f.op;
  $("description").textContent = hardware
    ? operations[f.op]?.[1] || ""
    : f.id === "compare-observation"
      ? "Residual is predicted minus measured at the original setting."
      : f.id === "drive-observable"
        ? study.meta.traceObservable
        : study.meta.scope;
  $("selection").textContent = selected
    ? "Selected component · " + selected
    : "";
  const values = hardware
    ? {
        event: f.id,
        sourcePC: f.sourcePc,
        accumulator: s.acc,
        fifoWords: s.fifo.length,
        wordsPending: s.dmaLeft,
        ramAddress: s.lastAddress,
        dacCode: s.dacCode,
        outputUv: s.outputUv,
        underruns: s.underruns,
      }
    : s;
  $("values").replaceChildren(
    ...Object.entries(values)
      .map(([k, v]) => [
        element("dt", k),
        element(
          "dd",
          v == null
            ? "—"
            : typeof v === "object"
              ? JSON.stringify(v)
              : format(v),
        ),
      ])
      .flat(),
  );
  $("parents").replaceChildren(
    ...f.parents.map((id) => {
      const button = element("button", id);
      button.onclick = () => showStep(steps.findIndex((x) => x.id === id));
      return button;
    }),
  );
  metric.show(f, selected, nativeStep);
  waveform(current.trace, Math.min(index, current.trace.frames.length - 1));
}

async function chooseCase(id, program) {
  const token = ++request;
  if (current && current.case !== id) {
    current = null;
    steps = [];
  }
  document.body.classList.toggle("no-case", !current);
  $("restore").hidden = true;
  row = study.rows.find((r) => r.id === id);
  if (!row) return false;
  if (benchmarkId === "qccd-h2" && $("nativeReplay"))
    $("nativeReplay").href =
      "/qccd-studio?experiment=h2-parity&phase=" + row.phaseIndex;
  if (study.meta.seriesKey && $("series").value !== row[study.meta.seriesKey]) {
    $("series").value = row[study.meta.seriesKey];
    showOptions();
  }
  $("observation").value = id;
  const query = new URLSearchParams({
    platform,
    experiment: benchmarkId,
    case: id,
  });
  history.replaceState(null, "", "/validation?" + query);
  $("loading").textContent = "Replaying…";
  $("save").disabled = $("edit").disabled = true;
  message("");
  drawPlot();
  try {
    const payload = { platform, experiment: benchmarkId, case: id };
    if (program != null) payload.program = program;
    const r = await json("/api/validation/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (token !== request) return false;
    current = r;
    document.body.classList.remove("no-case");
    selected = null;
    steps = [...r.trace.frames, ...r.analysisSteps];
    $("step").max = steps.length - 1;
    metric.load({ ...r, design });
    showStep(steps.length - 1);
    $("restore").hidden = r.referenceProgram;
    $("loading").textContent =
      r.diagnostic ||
      (r.referenceProgram
        ? "Reference program"
        : "Counterfactual · no matching measurement");
    $("edit").disabled = $("save").disabled = false;
    return true;
  } catch (e) {
    if (token === request) {
      $("loading").textContent = "";
      message(e.message);
      $("edit").disabled = $("save").disabled = !current;
      $("restore").hidden = !current || current.referenceProgram;
    }
    return false;
  }
}
async function choosePlatform(name, id, example) {
  const token = ++request;
  platform = name;
  benchmarkId =
    example ||
    (name === "qccd" && report.experiments["qccd-h2"] ? "qccd-h2" : name);
  study = report.experiments[benchmarkId];
  if (!study || study.platform !== name) {
    benchmarkId = name;
    study = report.experiments[name];
  }
  current = null;
  document.body.classList.add("no-case");
  $("save").disabled = $("edit").disabled = true;
  $("restore").hidden = true;
  steps = [];
  row = null;
  message("");
  $("loading").textContent = "Loading design…";
  document
    .querySelectorAll("#platforms button")
    .forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.platform === name),
    );
  const variants = Object.entries(report.experiments).filter(
    ([, r]) => r.platform === name,
  );
  $("experiment").replaceChildren(
    ...variants.map(
      ([key, r]) =>
        new Option(
          (r.metrics.passed ? "Met" : "Missed") + " · " + r.meta.title,
          key,
        ),
    ),
  );
  $("experiment").value = benchmarkId;
  $("experiment").parentElement.hidden = variants.length < 2;
  showStudy();
  try {
    const source = await json(
      "/api/validation/" +
        name +
        (benchmarkId === "qccd-h2" ? "/h2-design" : "/design"),
    );
    if (token !== request) return;
    design = source;
    showDesign();
    await chooseCase(
      study.rows.find((r) => r.id === id)?.id ||
        study.rows.find((r) => r.split === "holdout").id,
    );
  } catch (e) {
    if (token === request) {
      message(e.message);
      $("loading").textContent = "";
    }
  }
}
document
  .querySelectorAll("#platforms button")
  .forEach((b) => (b.onclick = () => choosePlatform(b.dataset.platform)));
$("observation").onchange = (e) => chooseCase(e.target.value);
$("experiment").onchange = (e) =>
  choosePlatform(platform, null, e.target.value);
$("step").oninput = (e) => showStep(Number(e.target.value));
$("back").onclick = () => showStep(index - 1);
$("next").onclick = () => showStep(index + 1);
$("restore").onclick = () => chooseCase(row.id);
$("edit").onclick = () => {
  $("program").value = JSON.stringify(current.trace.program, null, 2);
  $("editorError").textContent = "";
  $("editor").showModal();
};
$("cancel").onclick = () => $("editor").close();
$("apply").onclick = async () => {
  try {
    const p = JSON.parse($("program").value);
    if (await chooseCase(row.id, p)) $("editor").close();
    else $("editorError").textContent = $("alert").textContent;
  } catch (e) {
    $("editorError").textContent = e.message;
  }
};
$("save").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(current, null, 2)], { type: "application/json" }),
  );
  const a = link("Save", url);
  a.download = platform + "-" + row.id + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
try {
  report = await json("/api/validation/results");
  const q = new URLSearchParams(location.search);
  await choosePlatform(
    Object.hasOwn(axes, q.get("platform")) ? q.get("platform") : "qccd",
    q.get("case"),
    q.get("experiment"),
  );
} catch (e) {
  message(e.message);
}
