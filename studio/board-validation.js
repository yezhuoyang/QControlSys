import { deadlineCounts } from "/board-deadlines.mjs";
const el = (id) => document.getElementById(id);
const fmt = (v, d = 2) => v.toLocaleString("en", { maximumFractionDigits: d });
const workbench = (id, row) =>
  "/machines?" +
  new URLSearchParams({ boardCase: id, ...(row === undefined ? {} : { row }) });
let report,
  current,
  request = 0,
  edge,
  edgeRequest = 0;
async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw Error(await r.text());
  return r.json();
}
function draw(data, cv, row) {
  if (!data) return;
  const electrode = Boolean(data.lowMv),
    w = cv.clientWidth,
    h = cv.clientHeight,
    dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.font = "12px system-ui";
  const left = 49,
    right = w - 18,
    n = data.outputMv.length;
  const limit = electrode ? 11000 : 5000;
  const x = (i) => left + ((right - left) * i) / (n - 1),
    y = (mv) =>
      12 + ((limit - mv) / (2 * limit)) * (h - (electrode ? 42 : 100));
  const ty = (mv) => h - 32 - (mv / 6500) * 36;
  for (const v of electrode ? [-10, -5, 0, 5, 10] : [-5, 0, 5]) {
    ctx.fillStyle = "#45605f";
    ctx.fillText(v + " V", 7, y(v * 1000) + 4);
    ctx.fillStyle = "#dae4e1";
    ctx.fillRect(left, y(v * 1000), right - left, 1);
  }
  function line(values, fy, color, dashed = false) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.setLineDash(dashed ? [5, 3] : []);
    values.forEach((v, i) =>
      i ? ctx.lineTo(x(i), fy(v)) : ctx.moveTo(x(i), fy(v)),
    );
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (electrode) {
    ctx.beginPath();
    data.highMv.forEach((v, i) =>
      i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)),
    );
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(x(i), y(data.lowMv[i]));
    ctx.closePath();
    ctx.fillStyle = "#ddcde9";
    ctx.fill();
  } else {
    line(data.triggerMv, ty, "#915f1c");
    ctx.fillStyle = "#45605f";
    ctx.fillText("6 V", 7, ty(6000) + 4);
    ctx.fillText("0 V", 7, ty(0) + 4);
  }
  line(data.outputMv, y, "#8752a3");
  line(data.predictedMv, y, "#006d55", true);
  ctx.fillStyle = "#45605f";
  for (let j = 0; j <= 4; j++) {
    const i = Math.round(((n - 1) * j) / 4);
    ctx.textAlign = j === 4 ? "right" : j ? "center" : "left";
    ctx.fillText(
      electrode
        ? fmt(data.timeUs[i], 1) + " µs"
        : fmt((data.startUs + i * data.stepUs) / 1000, 1) + " ms",
      x(i),
      h - 6,
    );
  }
  ctx.fillStyle = "#425857";
  ctx.fillRect(x(row), 8, 1, h - 33);
}
const plot = () => draw(current, el("plot"), Number(el("row").value));
const plotEdge = () => draw(edge, el("edgePlot"), Number(el("edgeRow").value));
function readEdgeRow() {
  if (!edge) return;
  const i = el("edgeRow").valueAsNumber;
  el("edgeReading").textContent = [
    fmt(edge.timeUs[i], 2) + " µs",
    "figure centre " + fmt(edge.outputMv[i] / 1000, 2) + " V",
    "stroke " +
      fmt(edge.lowMv[i] / 1000, 2) +
      " to " +
      fmt(edge.highMv[i] / 1000, 2) +
      " V",
    "replay " + fmt(edge.predictedMv[i] / 1000, 3) + " V",
  ].join(" · ");
  el("debugEdge").href = workbench(edge.id, i);
  el("debugWord").href = workbench(edge.id, i) + "&inspect=spi-commit";
  plotEdge();
}
async function readEdge() {
  const token = ++edgeRequest,
    direction = el("edge").value;
  edge = null;
  const cv = el("edgePlot");
  cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
  el("debugEdge").removeAttribute("href");
  el("debugWord").removeAttribute("href");
  el("edgeReading").textContent =
    "Replaying the SPI write and analog response…";
  const e = await get("/api/board-validation/capture?case=peaks-" + direction);
  if (token !== edgeRequest) return;
  edge = e;
  el("edgeRow").max = e.outputMv.length - 1;
  const s = report.electrode.edges.find((s) => s.direction === direction);
  el("edgeResult").textContent =
    "The 10–90% transition takes " +
    fmt(s.measured.widthUs) +
    " µs in Figure 8 and " +
    fmt(s.replay.widthUs) +
    " µs in replay (" +
    fmt(s.nominal.widthUs) +
    " µs with nominal component values). Reaching the final 1 V band from 0 V takes " +
    fmt(s.measured.midToBandUs) +
    " µs in the figure and " +
    fmt(s.replay.midToBandUs) +
    " µs in replay. Voltage error over −12 to +12 µs is " +
    fmt(s.transitionRmsMv / 1000, 3) +
    " V RMS.";
  readEdgeRow();
}
function readRow() {
  if (!current) return;
  const i = Number(el("row").value),
    a = current.outputMv[i],
    b = current.predictedMv[i];
  el("reading").textContent = [
    fmt((current.startUs + i * current.stepUs) / 1000) + " ms",
    "measured " + fmt(a / 1000, 3) + " V",
    "replay " + fmt(b / 1000, 3) + " V",
    "difference " + fmt(b - a, 1) + " mV",
  ].join(" · ");
  el("debugRamp").href = workbench(current.id, i);
  plot();
}
async function readCapture() {
  const token = ++request,
    id = el("capture").value;
  current = null;
  el("plot")
    .getContext("2d")
    .clearRect(0, 0, el("plot").width, el("plot").height);
  el("reading").textContent = "Replaying capture…";
  el("debugRamp").removeAttribute("href");
  const data = await get(
    "/api/board-validation/capture?case=" + encodeURIComponent(id),
  );
  if (token !== request) return;
  current = data;
  el("rampSources").textContent =
    "Paired Tektronix files · " + data.members.join(" and ");
  readRow();
}
function selectRecord() {
  const input = el("ordinal"),
    link = el("debugDma");
  if (input.value && input.validity.valid)
    link.href = workbench("dma-" + el("burst").value, input.valueAsNumber);
  else link.removeAttribute("href");
}
function readDma() {
  const d = report.dma.find((x) => x.records === Number(el("burst").value));
  const input = el("ordinal");
  input.max = d.records;
  input.value = Math.min(d.records, Math.max(1, input.valueAsNumber || 1));
  el("dmaReading").textContent = [
    fmt(d.measuredMeanMBps) + " MB/s measured mean",
    fmt(d.predictedMBps) + " MB/s replay",
    fmt(d.predictedCycles) + " replay cycles",
    d.count + " counter readings",
  ].join(" · ");
  el("deadline").value = d.predictedCycles;
  el("repetition").replaceChildren(
    ...d.counterCycles.map((_, i) => new Option(String(i + 1), i)),
  );
  readDeadline();
  selectRecord();
}
function readDeadline() {
  const d = report.dma.find((x) => x.records === Number(el("burst").value));
  const budget = el("deadline").valueAsNumber,
    valid = Number.isSafeInteger(budget) && budget >= 0;
  const us = (cycles) => fmt((cycles * d.clockPs) / 1e6, 2) + " µs";
  const cycles = d.counterCycles[Number(el("repetition").value)];
  el("counterReading").textContent =
    fmt(cycles) +
    " measured cycles · " +
    us(cycles) +
    (valid
      ? cycles <= budget
        ? " · met deadline"
        : " · late by " + us(cycles - budget)
      : "");
  if (!valid) {
    el("deadlineReading").textContent =
      "Enter a nonnegative whole number of cycles.";
    return;
  }
  const stat = deadlineCounts(d, budget);
  el("deadlineReading").textContent =
    "At " +
    us(budget) +
    ", " +
    stat.missed +
    " of " +
    stat.count +
    " measured transfers missed the deadline. Replay " +
    (stat.replayMet ? "met" : "missed") +
    " it. Latest measured finish " +
    us(stat.latestCycles) +
    " · largest overrun " +
    us(stat.largestLateCycles) +
    ".";
}
function readCable() {
  const c = report.cables.find(
    (x) => x.lengthMm === Number(el("length").value),
  );
  el("cableReading").textContent = [
    fmt(c.measuredMeanPs / 1000, 3) + " ns measured mean",
    fmt(c.predictedPs / 1000, 3) + " ns replay",
    fmt(c.rms / 1000, 3) + " ns RMS error",
    c.count + " estimates",
  ].join(" · ");
  el("debugCable").href = workbench("cable-" + c.lengthMm);
}
function error(e) {
  el("error").hidden = false;
  el("error").textContent = e.message;
}
try {
  report = await get("/api/board-validation/results");
  for (const c of report.ramp)
    el("capture").add(
      new Option(
        c.id
          .replace("free-", "Free-running ")
          .replace("gated-", "Start/stop ") +
          " · " +
          c.split,
        c.id,
      ),
    );
  for (const c of report.cables)
    el("length").add(
      new Option(c.lengthMm / 1000 + " m · " + c.split, c.lengthMm),
    );
  for (const d of report.dma)
    el("burst").add(new Option(fmt(d.records) + " · " + d.split, d.records));
  el("burst").value = "8388608";
  el("capture").value = "gated-1";
  el("length").value = "20000";
  el("rtlResult").textContent =
    report.rtl.transitions +
    " output transitions match the published Verilog timing core on its 20 ns clock grid. A four-record program drives the address and data pins together, skips one output and checks the rising and falling strobes. FPGA startup time is excluded.";
  el("voltageResult").textContent =
    "Held-out voltage error · " +
    fmt(report.holdout.voltageMv.rms) +
    " mV RMS across 9 captures and " +
    fmt(report.holdout.voltageMv.count) +
    " rows.";
  el("timingResult").textContent =
    "Held-out one-way timing error · " +
    fmt(report.holdout.oneWayPs.rms / 1000, 3) +
    " ns RMS across 8 cable lengths and " +
    report.holdout.oneWayPs.count +
    " board estimates.";
  el("dmaResult").textContent =
    "Held-out throughput error · " +
    fmt(report.holdout.txMBps.rms) +
    " MB/s RMS and " +
    fmt(report.holdout.txMBps.peak) +
    " MB/s peak across " +
    report.holdout.txMBps.count +
    " counter readings.";
  el("burst").onchange = readDma;
  el("deadline").oninput = readDeadline;
  el("repetition").onchange = readDeadline;
  el("edge").onchange = () => readEdge().catch(error);
  el("edgeRow").oninput = readEdgeRow;
  new ResizeObserver(plotEdge).observe(el("edgePlot"));
  el("ordinal").oninput = selectRecord;
  el("capture").onchange = () => readCapture().catch(error);
  el("length").onchange = readCable;
  el("row").oninput = readRow;
  new ResizeObserver(plot).observe(el("plot"));
  readCable();
  readDma();
  await Promise.all([readCapture(), readEdge()]);
} catch (e) {
  error(e);
}
