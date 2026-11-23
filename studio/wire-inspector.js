import { conductorPinout, payloadSkewPs, serialSymbols, transportTiming } from "../machine/interconnect.mjs";

const number = new Intl.NumberFormat("en", { maximumSignificantDigits: 5 });
const metric = new Intl.NumberFormat("en", { maximumFractionDigits: 9, useGrouping:false });
const format = value => number.format(value);
const ps = value => Number.isSafeInteger(value) ? value.toLocaleString("en") + " ps" : "Unspecified";
const diameter = mm => mm < 1 ? format(mm * 1000) + " µm" : format(mm) + " mm";
const roles = { data: "Data", return: "Return", clock: "Clock", shield: "Shield / return",
  positive: "Positive", negative: "Negative", signal: "Signal", guided: "Guided mode", "free-space": "Beam mode" };
const colors = { data: "#a86627", signal: "#a86627", positive: "#a86627", negative: "#527db4",
  return: "#6b7c7d", clock: "#7854a0", shield: "#6b7c7d", guided: "#15816e", "free-space": "#15816e" };

// A payload is a transaction-level observation. Even at arrival it is not a
// parallel capture, nor does an NRZ frame size define its line-code bit pattern.
export function wireSample(link, frame) {
  if (!frame || !link) return null;
  const spec = link.interconnect;
  const arrival = frame.wire === link.id && Array.isArray(frame.received);
  const issue = spec && frame.part === link.from &&
    (frame.outputs ?? [frame.emitted]).find(pair => pair?.[0] === spec.fromPort);
  let value, direction, receivedValue = null;
  if (arrival || issue) {
    value = (arrival ? frame.received : issue)[1];
    direction = arrival ? "Received" : "Issued";
    if (arrival && Number.isSafeInteger(frame.transmittedValue)) {
      receivedValue = value;
      value = frame.transmittedValue;
    }
  } else if (link.board === frame.part) {
    const native = frame.native;
    if (link.id.endsWith("/word") && native?.op === "convert" && native.state.lastAddress != null) {
      value = native.state.pcm;
      direction = "FIFO word consumed";
    } else if (link.id.endsWith("/analog") && ["convert", "underrun"].includes(native?.op)) {
      value = native.state.outputUv;
      direction = "DAC output";
    } else if (link.id.endsWith("/request") && native?.op === "dma") {
      value = native.state.dmaAddress;
      direction = "DMA start address";
    } else if (link.id.endsWith("/trigger") && frame.received?.[0] === "start") {
      value = frame.received[1];
      direction = "Board trigger received";
    }
  }
  if (!Number.isSafeInteger(value)) return null;
  const width = link.payloadBits;
  const digital = ["parallel-beats", "serial-nrz", "logic-level"].includes(spec?.encoding);
  const word = v => digital && Number.isInteger(width) && width > 0 && width <= 1024 ?
    BigInt.asUintN(width, BigInt(v)).toString(2).padStart(width, "0") : null;
  return { value, bits:word(value), receivedValue, receivedBits:receivedValue != null ? word(receivedValue) : null,
    direction, id: frame.id, atPs: frame.atPs,
    transport: arrival ? frame.transport ?? null : null };
}

export function lanePayload(lane, spec, sample) {
  if (!sample?.bits) return null;
  if (spec.encoding === "logic-level" && lane.role === "signal") return sample.bits;
  if (spec.encoding === "logic-level" && spec.polarity === "positive-follows-logical-bit") {
    if (lane.role === "positive") return sample.bits;
    if (lane.role === "negative") return sample.bits === "1" ? "0" : "1";
  }
  if (spec.encoding !== "parallel-beats" || lane.role !== "data") return null;
  const values = [];
  for (let bit = lane.bitIndex; bit < sample.bits.length; bit += spec.transferWidthBits)
    values.push(sample.bits[sample.bits.length - 1 - bit]);
  return values.length ? values.join(" → ") : null;
}

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
}
function button(text, handler) {
  const node = el("button", null, text);
  node.type = "button";
  node.onclick = handler;
  return node;
}
function put(node, value) {
  if (node.textContent !== value) node.textContent = value;
}
function field(list, key, value) {
  if (value != null && value !== "") list.append(el("dt", null, key), el("dd", null, value));
}
function label(text, control) {
  const node = el("label");
  node.append(el("span", "wi-caption", text), control);
  return node;
}
function routeLength(points) {
  if (!Array.isArray(points) || !points.length || !points.every(p =>
    Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) return undefined;
  return points.slice(1).reduce((n, p, i) =>
    n + Math.hypot(...p.map((a, k) => a - points[i][k])), 0);
}
function endpoint(name, partId, port, part) {
  const box = el("div", "wi-end");
  box.append(el("span", "wi-caption", name), el("b", null, part?.label ?? partId),
    el("code", null, port ?? "Port unspecified"));
  box.title = partId;
  return box;
}
function nodeSvg(tag, attrs) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attrs)) n.setAttribute(name, value);
  return n;
}

function sectionDrawing(spec, selectLane) {
  const chart = nodeSvg("svg", { role: "img", "aria-label": "Metric transverse cross-section" });
  const laneShapes = new Map();
  const circle = (x, r, color) => nodeSvg("circle", { cx: x, cy: 0, r, fill: color });
  let left = Infinity, right = -Infinity, height = 0;
  function bounds(x, width, h) {
    left = Math.min(left, x - width / 2);
    right = Math.max(right, x + width / 2);
    height = Math.max(height, h);
  }
  function add(lane, shape) {
    const name = nodeSvg("title", {});
    name.textContent = lane.id + " · " + (roles[lane.role] ?? lane.role);
    shape.append(name);
    shape.style.cursor = "pointer";
    shape.addEventListener("click", () => selectLane(lane.id));
    chart.append(shape);
    laneShapes.set(lane.id, shape);
  }
  if (spec.opticalMode) {
    const m = spec.opticalMode, outer = m.jacketDiameterMm ?? m.diameterMm;
    bounds(0, outer, outer);
    if (m.jacketDiameterMm) {
      chart.append(circle(0, outer / 2, "#6d807f"), circle(0, m.claddingDiameterMm / 2, "#c3e5dd"),
        circle(0, m.coreDiameterMm / 2, "#455f60"));
    }
    add(m, circle(0, m.diameterMm / 2, colors[m.role]));
  } else {
    // Draw the outer coax body first. Its hollow center exposes the core.
    const ordered = [...spec.conductors].sort((a, b) => Number(b.role === "shield") - Number(a.role === "shield"));
    for (const c of ordered) {
      const w = c.widthMm ?? c.diameterMm, h = c.thicknessMm ?? c.diameterMm;
      bounds(c.offsetMm, w, h);
      let shape;
      if (c.shape === "strip")
        shape = nodeSvg("rect", { x: c.offsetMm - w / 2, y: -h / 2, width: w, height: h, fill: colors[c.role] });
      else if (c.innerDiameterMm)
        shape = nodeSvg("circle", { cx: c.offsetMm, cy: 0, r: (w + c.innerDiameterMm) / 4,
          fill: "none", stroke: colors[c.role], "stroke-width": (w - c.innerDiameterMm) / 2 });
      else shape = circle(c.offsetMm, w / 2, colors[c.role]);
      add(c, shape);
    }
  }
  const margin = Math.max((right-left)*0.035, height*.15), viewH = Math.max(height+2*margin, (right-left)*.08);
  chart.setAttribute("viewBox", [left - margin, -viewH/2, right-left+2*margin, viewH].join(" "));
  return { chart, laneShapes };
}

function symbolView(s, symbols, inspectSymbol) {
  const box = el("div", "wi-symbols");
  const title = el("h3", null, "Encoded symbols");
  const info = el("div", "wi-meta", "Transmit order · " + symbols.bitOrder + " · " + format(symbols.symbolPeriodPs) + " ps per symbol");
  const levels = symbols.positive ? [["P", symbols.positive, colors.positive], ["N", symbols.negative, colors.negative]] :
    [["Mode", symbols.bits, colors.guided]];
  const total = symbols.bits.length;
  const chart = nodeSvg("svg", {viewBox:"0 0 480 " + levels.length * 25, preserveAspectRatio:"none",
    role:"img", "aria-label":"Encoded logic versus symbol index"});
  const windowSize = Math.min(total, 48), x = i => 1 + 478*i/windowSize;
  const traces = levels.map(([,,color]) => nodeSvg("path", { fill:"none",stroke:color,"stroke-width":1.7,"vector-effect":"non-scaling-stroke" }));
  chart.append(...traces);
  const cursor = nodeSvg("rect", { y:0, width:478/windowSize, height:25*levels.length, fill:"#267d6b", opacity:.14 });
  chart.append(cursor);
  const range = el("input"), state = el("output");
  range.type = "range"; range.min = 0; range.max = total - 1; range.value = 0;
  range.setAttribute("aria-label","Inspect encoded symbol");
  function read() {
    const i = Number(range.value), t = symbols.symbolPeriodPs, start = s.transport?.startPs;
    inspectSymbol(i);
    const left = Math.min(total - windowSize, Math.floor(i / windowSize) * windowSize);
    levels.forEach(([,bits], row) => {
      const y = bit => 5 + 25*row + (bit === "1" ? 0 : 14);
      const path = ["M", x(0), y(bits[left])];
      for (let k=0;k<windowSize;k++) path.push("V",y(bits[left+k]),"H",x(k+1));
      traces[row].setAttribute("d",path.join(" "));
    });
    cursor.setAttribute("x", x(i-left));
    const named = levels.map(([name,bits]) => name + " = " + bits[i]).join(" · ");
    const offset = i - symbols.prefixBits.length;
    const field = i < symbols.prefixBits.length ? "prefix" :
      i >= total - symbols.paddingBits ? "padding" :
      i >= total - symbols.paddingBits - symbols.suffixBits.length ? "suffix" :
      "payload bit " + (symbols.bitOrder === "lsb-first" ? offset : s.bits.length - 1 - offset);
    state.textContent = "Symbol " + (i+1) + " / " + total + " · " + field + " · " + named + " · " +
      (start != null ? format(start+i*t) + " ps on trace clock" : format(i*t) + " ps from transmit start");
  }
  range.oninput = read; read();
  box.append(title, info, chart, range, state,
    el("p", "wi-meta", "The encoder maps the recorded payload to nominal symbols. Physical level and edge shape are unsampled."));
  return box;
}

const style = `
.wi {padding:13px 16px;background:#f5f8f6;border-top:1px solid #b9c9c3;min-width:0;font-size:13px;color:#213b3b}
.wi h2 {font-size:16px;margin:0}.wi h3 {font-size:14px;margin:0}
.wi-head,.wi-legend,.wi-row,.wi-samples {display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wi-head {justify-content:space-between;margin-bottom:8px}.wi-count,.wi-meta {font-size:12px;color:#486360}
.wi-tools {display:grid;gap:9px;grid-template-columns:minmax(9em,1fr) minmax(10em,2.4fr) auto;align-items:end}
.wi input,.wi select {min-width:0;width:100%;max-width:100%;box-sizing:border-box}
.wi button {font-size:12px;line-height:1.35;padding:4px 8px}.wi-caption {display:block;font-size:11px;color:#49625f;margin:0 0 3px;font-weight:600}
.wi-head .wi-caption {margin:0}.wi-endpoints {display:grid;grid-template-columns:1fr auto 1fr;gap:9px;align-items:center;margin:10px 0 5px}
.wi-end {min-width:0;background:#fff;border:1px solid #ccd9d2;border-radius:4px;padding:6px 9px;overflow-wrap:anywhere}
.wi-end code {display:block;font-size:11px;color:#4b6862}.wi details {margin-top:8px}
.wi summary {cursor:pointer;font-weight:600;color:#28584f}.wi-body {display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:13px;margin-top:7px}
.wi svg {width:100%;height:42px;display:block;background:#e4ece7;border-radius:3px}.wi-legend {margin:4px 0 6px}
.wi-lanes {display:flex;gap:4px;flex-wrap:wrap;align-content:flex-start;max-height:158px;overflow:auto;padding:2px}
.wi-lanes button {display:inline-flex;align-items:center;gap:4px;min-height:26px;padding:2px 6px;border:1px solid #bacbc5;background:white;color:#274143}
.wi-lanes button i {width:7px;height:7px;border-radius:50%}.wi-lanes button code {font:11px Consolas,monospace}
.wi-lanes button[aria-pressed=true] {outline:2px solid #196b5e;outline-offset:-1px}
.wi-lanes output {font:11px Consolas,monospace;color:#365850}.wi-lanes output[data-value="1"] {background:#dcf0d8;color:#075943}
.wi-samples {padding:5px 0;color:#304f4a}.wi-payload {overflow-wrap:anywhere;font:12px Consolas,monospace}
.wi p {margin:4px 0;line-height:1.45}.wi-data {font-variant-numeric:tabular-nums;margin:4px 0 0;display:grid;grid-template-columns:auto 1fr;gap:4px 12px}
.wi-data dt {color:#486360}.wi-data dd {margin:0;overflow-wrap:anywhere}.wi .wi-id {overflow-wrap:anywhere}.wi a {color:#176756}
.wi-basis {margin-top:8px;border-top:1px solid #d0dcd6;padding-top:5px}
.wi-symbols {margin-top:8px}.wi-symbols svg {height:45px;margin:5px 0}.wi-symbols input {display:block;margin:0}
.wi-symbols output {font:12px Consolas,monospace}.wi-branches {max-height:170px;overflow:auto}
.wi-branches table {border-collapse:collapse;width:100%;font-size:11px;font-variant-numeric:tabular-nums}
.wi-branches td,.wi-branches th {text-align:left;padding:3px 4px;border-bottom:1px solid #d3ded7}
@media(max-width:680px){.wi-body{grid-template-columns:1fr}.wi-tools{grid-template-columns:1fr 1fr}.wi-tools button{justify-self:start}.wi-endpoints{gap:5px}.wi-end{padding:5px}}
`;

export function createWireInspector(host, onInspect) {
  const sheet = el("style", null, style), wrap = el("div", "wi");
  const head = el("div", "wi-head"), count = el("span", "wi-count");
  head.append(el("h2", null, "Wiring inspector"), count);
  const search = el("input"), choice = el("select"), tools = el("div", "wi-tools");
  search.type = "search"; search.placeholder = "Cable, part or port"; search.autocomplete = "off";
  choice.setAttribute("aria-label", "Cable");
  const open3D = button("Highlight cable", () => pickLane(null));
  tools.append(label("Find a connection", search), label("Cable", choice), open3D);
  const ends = el("div", "wi-endpoints"), status = el("div", "wi-samples"), sample = el("span"),
    payload = el("code", "wi-payload"), queue = el("span", "wi-meta");
  status.append(sample, payload, queue);
  const details = el("details"), summary = el("summary", null, "Conductors and timing"),
    body = el("div", "wi-body"), cross = el("div"), facts = el("div"), basis = el("div", "wi-basis wi-meta");
  body.append(cross, facts); details.append(summary, body, basis);
  wrap.append(head, tools, ends, status, details); host.replaceChildren(sheet, wrap);
  let system, parts = new Map(), index = new Map(), entries = [], current, focusedLane = null, frame,
    lanes = [], geometryText, lastSample = undefined, draw, detailLink, lastExternalId, symbolsHost;

  function pickLane(id) {
    if (!current) return;
    focusedLane = id;
    showLane();
    onInspect(current.id, id);
  }

  function showLane() {
    for (const row of lanes) row.btn.setAttribute("aria-pressed", String(row.c.id === focusedLane));
    for (const [id, shape] of draw?.laneShapes ?? []) shape.style.opacity = !focusedLane || id === focusedLane ? "1" : ".4";
    if (!geometryText) return;
    const c = lanes.find(row => row.c.id === focusedLane)?.c;
    if (!c) {
      geometryText.textContent = "Select a conductor or optical mode to inspect its geometry in 3D.";
      return;
    }
    const geometry = c.shape === "strip" ? diameter(c.widthMm) + " wide × " + diameter(c.thicknessMm) + " thick" :
      diameter(c.diameterMm) + (c.role === "guided" || c.role === "free-space" ? " mode diameter" : " diameter");
    geometryText.textContent = [c.id, roles[c.role] ?? c.role, geometry,
      c.fromPin != null ? "source pin " + c.fromPin : null, c.toPin != null ? "destination pin " + c.toPin : null,
      c.bitIndex != null ? "source lane bit " + c.bitIndex : null,
      c.destinationBitIndex != null ? "destination lane bit " + c.destinationBitIndex : null,
      c.skewPs != null ? "lane skew " + ps(c.skewPs) : null,
      c.innerDiameterMm && diameter(c.innerDiameterMm) + " bore",
      c.wavelengthNm && format(c.wavelengthNm) + " nm wavelength",
      c.jacketDiameterMm && [c.coreDiameterMm,c.claddingDiameterMm,c.jacketDiameterMm].map(diameter).join(" / ") + " core / cladding / jacket",
      "offset " + format(c.offsetMm) + " mm",
    ].filter(value => value != null && value !== false).join(" · ");
  }

  function refreshSample() {
    const s = wireSample(current, frame);
    if (!s && lastSample === null) return;
    if (s && lastSample && s.id === lastSample.id && s.atPs === lastSample.atPs &&
      s.value === lastSample.value && s.receivedValue === lastSample.receivedValue &&
      s.direction === lastSample.direction && s.transport === lastSample.transport) return;
    lastSample = s;
    const spec = current?.interconnect;
    const sourceModel = parts.get(current?.from)?.model;
    const signal = sourceModel?.affine?.output ?? sourceModel?.switch?.signal ?? sourceModel?.stimulus?.signal;
    const analogUnit = s?.bits ? "" : current?.devicePath && current.probes?.length && !current.payloadBits ? " µV control envelope" :
      s?.direction === "DAC output" || sourceModel?.dac || sourceModel?.clockedDac || sourceModel?.spiDac81416 || sourceModel?.rcFilter || sourceModel?.waveformBoard || current?.dcLane && spec?.encoding === "held-analog" ? " µV" :
      {voltageUv:" µV",frequencyHz:" Hz",positionNm:" nm"}[signal] ?? "";
    const target = s && frame?.deliveryTarget ? " · " + [frame.deliveryProbe,frame.deliveryTarget].filter(Boolean).join(" → ") : "";
    const observed = s?.receivedValue != null ? "Sent " + s.value.toLocaleString("en") + " → received " + s.receivedValue.toLocaleString("en") :
      s ? s.direction + " " + s.value.toLocaleString("en") : "";
    put(sample, s ? observed + analogUnit + target + " · event " + s.id + " at " + ps(s.atPs) :
      current?.held ? "No update at this step. The prior setpoint is unspecified here." :
      current?.carrier ? "Passive carrier route. No sampled level at this step." : "No sample on this connection at this step.");
    const grouped = bits => "0b" + bits.replace(/\B(?=(?:.{4})+$)/g, " ");
    put(payload, s?.bits ? grouped(s.bits) + (s.receivedBits ? " → " + grouped(s.receivedBits) : "") : "");
    const t = s?.transport;
    put(queue, t ? "Issued " + ps(t.issuedPs) + " · queued " + ps(t.startPs - t.issuedPs) +
      " · transmitter [" + ps(t.startPs) + ", " + ps(t.releasePs) + ") · arrived " + ps(s.atPs) +
      (t.priorEvent != null ? " · prior reservation event " + t.priorEvent : "") : "");
    for (const row of lanes) {
      const v = lanePayload(row.c, spec, s);
      put(row.out, v ?? "");
      if (v == null) row.out.removeAttribute("data-value"); else row.out.dataset.value = v;
    }
    if (symbolsHost && details.open) {
      const encoded = s?.bits && spec.encoding === "serial-nrz";
      const beyondLimit = encoded && transportTiming(spec,0,current.payloadBits).wireBits > 1_048_576;
      const symbols = encoded && !beyondLimit && serialSymbols(spec,s.value,current.payloadBits);
      const displaySymbol = i => {
        for (const {c,out} of lanes) {
          const v = c.role === "positive" ? symbols.positive?.[i] : c.role === "negative" ? symbols.negative?.[i] :
            ["guided","free-space"].includes(c.role) ? symbols.bits[i] : null;
          if (v != null) { put(out,v); out.dataset.value=v; }
        }
      };
      symbolsHost.replaceChildren(...(symbols ? [symbolView(s,symbols,displaySymbol)] : beyondLimit ?
        [el("p","wi-meta","This frame exceeds the symbol inspector’s 1,048,576-symbol limit. Its transfer timing is available.")] : []));
    }
  }

  function describe(link) {
    facts.replaceChildren();
    const spec = link.interconnect, data = el("dl", "wi-data");
    facts.append(el("h3", null, "Route and timing"), data);
    const branches = link.branches ?? [];
    const routed = routeLength(link.pointsMm);
    const xyz = p => p?.map(v => metric.format(v)).join(", ") ?? "Unspecified";
    if (!branches.length) {
      field(data, "Routed length", routed != null ? format(routed) + " mm" : "Unspecified");
      field(data, "From / to XYZ", link.pointsMm?.length && xyz(link.pointsMm[0]) + " → " + xyz(link.pointsMm.at(-1)) + " mm");
    }
    if (spec) {
      if (spec.lengthMm != null && !branches.length) field(data, "Installed length", format(spec.lengthMm) + " mm");
      field(data, "Medium", spec.medium);
      field(data, "Encoding", spec.encoding);
      field(data, "Speed", format(spec.speedMmPerNs) + " mm/ns");
      if (spec.kind === "parallel") field(data, "Sampling skew", ps(payloadSkewPs(spec, link.payloadBits)));
      if (spec.bitRateGbps) {
        field(data, "Line rate", format(spec.bitRateGbps) + " Gb/s");
        field(data, "Framing", spec.frameOverheadBits + " overhead bits · " + spec.lineCodeDataBits + " data bits per " + spec.lineCodeWireBits + " wire bits");
      }
      if (spec.beatNs) {
        if (spec.strobeLink) field(data, "Physical strobe wire", spec.strobeLink);
        field(data, "Parallel transfer", spec.transferWidthBits + " bits per " + format(spec.beatNs) + " ns beat");
        field(data, "Peak bit rate", format(spec.transferWidthBits / spec.beatNs) + " Gb/s across all data lanes");
        field(data, "Pin mapping", spec.pinRouting === "inside-receiver" ? "Inside the receiver" : "At the receiver connector");
      }
      if (!branches.length && (routed != null || spec.lengthMm != null) && Number.isSafeInteger(link.payloadBits)) {
          const t = transportTiming(spec, routed, link.payloadBits);
          field(data, "Flight", ps(t.flightPs));
          if (t.serializationPs) {
            field(data, "Per payload", t.payloadBits + " data bits · " + t.wireBits + " line bits · " + ps(t.serializationPs) + " transmit");
            field(data, "Effective payload rate", format(t.payloadBits * 1000 / t.serializationPs) + " Gb/s at continuous occupancy");
          }
      }
    }
    if (Number.isSafeInteger(link.extraDelayPs))
      field(data, spec ? "Additional wire delay" : "Programmed wire delay", ps(link.extraDelayPs));
    field(data, "Design ID", link.id);
    if (branches.length) {
      const table = el("table"), area = el("div", "wi-branches"), headers = el("tr");
      for (const name of ["Probe → target","From XYZ (mm)","To XYZ (mm)","Length","Flight"]) headers.append(el("th",null,name));
      table.append(headers);
      for (const b of branches) {
        const tr = el("tr"), length = b.lengthMm ?? routeLength(b.pointsMm);
        const t = spec && length != null && Number.isSafeInteger(link.payloadBits) ?
          transportTiming({...spec,lengthMm:length},length,link.payloadBits) : null;
        for (const v of [[b.probe,b.target].filter(Boolean).join(" → "),xyz(b.sourceMm),xyz(b.endMm),length != null ? metric.format(length) + " mm" : "Unspecified",ps(t?.flightPs)])
          tr.append(el("td",null,v));
        table.append(tr);
      }
      area.append(table);
      facts.append(el("h3",null,"Terminal paths"),area);
    }
    basis.replaceChildren();
    for (const text of [spec?.timingBasis, spec?.provenance, link.basis,
      link.dcLane && "DC " + link.dcLane + " uses reference contacts. The H2 channel-to-electrode pinout is unpublished."]) {
      if (text) basis.append(el("p", null, text));
    }
    if (spec?.sharedReturn) {
      const p = el("p", null, "Shared return · " + spec.sharedReturn);
      for (const other of system.links.filter(r => r.sharedNet === spec.sharedReturn)) {
        p.append(" ", button(other.kind, () => { selectExternal(other); onInspect(other.id, null); }));
      }
      basis.append(p);
    }
    for (const source of system.sources ?? []) {
      if (!/^https?:\/\//i.test(source.url)) continue;
      const a = el("a", null, source.title); a.href = source.url; a.target = "_blank"; a.rel = "noreferrer";
      basis.append(a, " ");
    }
  }

  function renderDetails() {
    const link = current;
    if (!link || !details.open || detailLink === link) return;
    detailLink = link;
    const spec = link.interconnect;
    cross.replaceChildren();
    if (spec) {
      const channels = spec.opticalMode ? [spec.opticalMode] : conductorPinout(spec);
      draw = sectionDrawing(spec, pickLane);
      const legend = el("div", "wi-legend wi-meta", spec.opticalMode ? "Optical cross-section" : channels.length + " conductor" + (channels.length === 1 ? "" : "s") + " · transverse cross-section");
      const chips = el("div", "wi-lanes"); geometryText = el("p", "wi-meta");
      for (const c of channels) {
        const b = button("", () => pickLane(c.id)), dot = el("i"), out = el("output");
        dot.style.backgroundColor = colors[c.role]; dot.setAttribute("aria-hidden", "true");
        b.append(dot, el("code", null, c.id), el("span", null, roles[c.role] ?? c.role), out);
        chips.append(b); lanes.push({c,btn:b,out});
      }
      const note = spec.encoding === "parallel-beats" ?
        "Data chips show payload bits in beat order. Clock, return and instantaneous pin levels are unsampled." :
        spec.encoding === "serial-nrz" ? spec.serialFormat?.blockEncoding === "identity" ? "The frame format specifies the nominal ordered symbols for a recorded payload." :
          "This frame format specifies the line rate and encoded length. Its bit patterns are unspecified." :
        spec.encoding === "optical-envelope" || spec.kind === "coax" ? "A delivered envelope has no sampled carrier phase." : null;
      cross.append(legend, draw.chart, chips, geometryText);
      if (note) cross.append(el("p", "wi-meta", note));
      symbolsHost = el("div"); cross.append(symbolsHost);
      showLane();
    } else {
      cross.append(el("p", "wi-meta", "This design provides a centerline. Pin assignments, conductor dimensions and physical timing are unspecified."));
    }
    describe(link);
    lastSample = undefined;
    refreshSample();
  }

  function selectLink(link) {
    if (current === link) return;
    current = link; focusedLane = null; geometryText = null; lastSample = undefined; lanes = []; draw = null; detailLink = null; symbolsHost = null;
    const visible = Boolean(link);
    open3D.disabled = !visible; ends.hidden = status.hidden = details.hidden = !visible;
    if (!visible) return;
    if (choice.value !== link.id) choice.value = link.id;
    const spec = link.interconnect;
    ends.replaceChildren(endpoint("From", link.from, spec?.fromPort, parts.get(link.from)), el("span", null, "→"),
      endpoint("To", link.to, spec?.toPort, parts.get(link.to)));
    summary.textContent = spec?.opticalMode ? "Optical mode and timing" : "Conductors and timing";
    renderDetails();
    refreshSample();
  }

  function options() {
    const phrase = search.value.toLocaleLowerCase().trim();
    const terms = phrase.split(/\s+/).filter(Boolean);
    // A useful hit on "DC 268" is channel 268. An unrelated route whose ID
    // contains 268 remains accessible, after the literal label/port matches.
    const score = e => e.name.includes(phrase) ? 2 : e.text.includes(phrase) ? 1 : 0;
    const results = terms.length ? entries.filter(e => terms.every(t => e.text.includes(t)))
      .sort((a,b) => score(b) - score(a)) : entries;
    const options = results.map(e => {
      const o = el("option", null, e.label); o.value = e.link.id; return o;
    });
    choice.replaceChildren(...options); choice.disabled = !results.length;
    put(count, (terms.length ? results.length + " of " : "") + entries.length + " connections");
    const first = results.find(e => e.link === current && score(e) === score(results[0])) ?? results[0];
    if (first) choice.value = first.link.id;
    selectLink(first?.link ?? null);
  }
  function selectExternal(link) {
    if (!link || current === link) return;
    if (search.value) { search.value = ""; options(); }
    selectLink(link);
  }
  search.addEventListener("input", options);
  details.addEventListener("toggle", () => {
    if (details.open && detailLink === current && current) { lastSample = undefined; refreshSample(); }
    else renderDetails();
  });
  choice.addEventListener("change", () => { selectLink(index.get(choice.value)); if (current) onInspect(current.id, null); });

  return {
    load(value) {
      system = value ?? {parts:[], links:[]};
      parts = new Map(system.parts.map(p => [p.id, p]));
      index = new Map(system.links.map(l => [l.id, l]));
      entries = system.links.map(link => {
        const spec = link.interconnect, from = parts.get(link.from)?.label ?? link.from,
          to = parts.get(link.to)?.label ?? link.to;
        const label = link.kind + " · " + from + " → " + to;
        return { link, label, name:label.toLocaleLowerCase(), text: [label, link.id, link.from, link.to, spec?.fromPort, spec?.toPort,
          spec?.medium, spec?.encoding, spec?.sharedReturn].join(" ").toLocaleLowerCase() };
      });
      search.value = ""; frame = null; current = undefined; lastExternalId = null; host.hidden = !entries.length;
      options();
    },
    selectConductor(id, laneId) {
      const link = index.get(id);
      if (!link) return;
      selectExternal(link);
      focusedLane = laneId;
      details.open = true;
      renderDetails();
      showLane();
    },
    update(nextFrame, selectedId) {
      frame = nextFrame;
      const selected = index.get(selectedId);
      if (selected && (!search.value || selected.id !== lastExternalId)) selectExternal(selected);
      else if (!search.value && !selectedId) selectExternal(index.get(frame?.wire));
      lastExternalId = selectedId;
      if (current) refreshSample();
    },
  };
}
