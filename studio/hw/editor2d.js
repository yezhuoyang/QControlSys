// 2D detail editors of the hardware design page, for the parts that are 2D in nature: the transmon
// chip (qubits on a lattice, couplers, pockets), the atom array (SLM sites and atoms), the ion trap
// (zones, the edges ions shuttle along, ions), and a RISC-Q board (its cores, channels and
// converters). Each edits the same hardware document the 3D scene draws; `onChange(edit)` applies an
// edit to the document and rebuilds the scene, so closing the editor shows the machine as edited.
const NS = "http://www.w3.org/2000/svg";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const ROLE_COLOR = { qubit: "#5fa8d3", beam: "#d28b3c", mover: "#8c6bd1", readout: "#d35f7a", pump: "#5fb08a", frame: "#b99a3c", decoder: "#c45fb0" };
/** A ZCU216 running RISC-Q (riscq/board.mjs): 14 cores, 16 RF-DACs, 16 RF-ADCs, 16 channels per core. */
const LIMIT = { cores: 14, dacs: 16, adcs: 16, channels: 16 };

/** Transmon pockets on a ground plane for the qubits at `at` (mm, chip plane): riscq/hw/document.mjs's chip. */
function chipLayout(at, chip, pitch) {
  const xs = at.map((p) => p[0]), ys = at.map((p) => p[1]);
  const box = [Math.min(...xs) - pitch, Math.min(...ys) - pitch, Math.max(...xs) + pitch, Math.max(...ys) + pitch].map(r6);
  const rect = (x, y, w, h) => [[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]].map((p) => p.map(r6));
  // One transmon's pocket, pads and junction, relative to its qubit (repeated at every qubit when drawn).
  const metalPolygons = [{ name: "ground", role: "ground", layer: 1, points: [[box[0], box[1]], [box[0], box[3]], [box[2], box[3]], [box[2], box[1]]], holes: [rect(0, 0, 0.65, 0.65)] },
    { name: "pad_top", role: "electrode", layer: 1, points: rect(0, 0.06, 0.455, 0.09), holes: [] },
    { name: "pad_bot", role: "electrode", layer: 1, points: rect(0, -0.06, 0.455, 0.09), holes: [] }];
  const junctions = [{ name: "rect_jj", layer: 1, subtract: false, points: [[0, -0.015], [0, 0.015]], widthMm: 0.02 }];
  return { chip: { ...chip, boundsMm: box }, drivePinMm: [box[0], 0], metalPolygons, junctions };
}

function shell(title, help) {
  const el = document.getElementById("detail");
  el.hidden = false;
  el.innerHTML = `<header><h3>${esc(title)}</h3><span class="grow"></span><span class="tools"></span><button type="button" class="primary" data-close>Done</button></header>
    <div class="canvas"><svg xmlns="${NS}"></svg><div class="side"></div></div><footer>${esc(help)}</footer>`;
  return { el, svg: el.querySelector("svg"), side: el.querySelector(".side"), tools: el.querySelector(".tools") };
}

/** Pointer position in the SVG's user units. */
function point(svg, e) {
  const p = svg.createSVGPoint();
  p.x = e.clientX;
  p.y = e.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}
function fitView(svg, xs, ys, pad) {
  const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  svg.setAttribute("viewBox", [x0, y0, x1 - x0, y1 - y0].join(" "));
  return Math.max(x1 - x0, y1 - y0);
}
/** Drag circles of class `drag`: `onDrop(index, x, y)` when released. */
function draggable(svg, onDrop, snap) {
  let held = null;
  svg.addEventListener("pointerdown", (e) => {
    const c = e.target.closest(".drag");
    if (!c) return;
    held = c;
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!held) return;
    const p = snap(point(svg, e));
    held.setAttribute("cx", p.x);
    held.setAttribute("cy", p.y);
  });
  svg.addEventListener("pointerup", (e) => {
    if (!held) return;
    const p = snap(point(svg, e)), i = Number(held.dataset.i);
    held = null;
    onDrop(i, p.x, p.y);
  });
}

// ------------------------------------------------------------------ the transmon chip
function chipEditor(doc, { onChange }) {
  const pitch = doc.device.trackFrame?.pitchMm ?? 2, step = pitch / 2;
  // Transmons sit on the lattice and half way between its points (a surface-code patch puts its
  // ancillas there), relative to the chip's own lattice origin.
  const off = doc.device.trackFrame?.offsetMm ?? [0, 0];
  const { svg, side, tools } = shell("Transmon chip · " + doc.device.qubits.length + " qubits",
    "Drag a qubit to move it (it snaps to half the " + pitch + " mm lattice, where a surface-code patch puts its ancillas). Click an empty point to add a qubit; select a qubit and press Delete to remove it. Couplers join nearest neighbours.");
  tools.innerHTML = `<label><input type="checkbox" checked data-auto> Couplers between neighbours</label>`;
  let pick = null;
  const draw = () => {
    const d = doc.device, at = d.qubits.map((q) => [q.positionMm[0], q.positionMm[2]]);
    const b = d.layout.chip.boundsMm, span = fitView(svg, [b[0], b[2]], [b[1], b[3]], pitch * 0.6), dot = span / 90;
    const lat = [];
    const gx = (v) => Math.ceil((v + off[0]) / step) * step - off[0], gy = (v) => Math.ceil((v + off[1]) / step) * step - off[1];
    for (let x = gx(b[0]); x <= b[2] + 1e-9; x += step) for (let y = gy(b[1]); y <= b[3] + 1e-9; y += step) lat.push([x, y]);
    svg.innerHTML = `<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" fill="#d8dee0" stroke="#7a8a92" vector-effect="non-scaling-stroke"/>` +
      lat.map(([x, y]) => `<circle class="lat" cx="${x}" cy="${y}" r="${dot * 0.35}" fill="#aab6bb"/>`).join("") +
      (d.couplers ?? []).map(([i, j]) => at[i] && at[j] ? `<line x1="${at[i][0]}" y1="${at[i][1]}" x2="${at[j][0]}" y2="${at[j][1]}" stroke="#b77743" stroke-width="${dot * 0.6}"/>` : "").join("") +
      at.map(([x, y]) => `<rect x="${x - 0.325}" y="${y - 0.325}" width="0.65" height="0.65" fill="#f7faf9" stroke="#9aa8ae" vector-effect="non-scaling-stroke"/>` +
        `<rect x="${x - 0.2275}" y="${y + 0.015}" width="0.455" height="0.09" fill="#c9a24e"/><rect x="${x - 0.2275}" y="${y - 0.105}" width="0.455" height="0.09" fill="#c9a24e"/>`).join("") +
      at.map(([x, y], i) => `<circle class="drag" data-i="${i}" cx="${x}" cy="${y}" r="${dot * 1.6}" fill="${i === pick ? "#ffcf4a" : "#5fa8d3"}" fill-opacity="0.75" stroke="#1d2b4f" vector-effect="non-scaling-stroke" style="cursor:grab"/>` +
        `<text x="${x}" y="${y - dot * 2.4}" font-size="${dot * 1.8}" text-anchor="middle" fill="#1d2b4f">${esc(d.qubits[i].id)}</text>`).join("");
    side.innerHTML = `<b>${d.qubits.length} transmons</b>, ${(d.couplers ?? []).length} couplers<br>Chip ${(b[2] - b[0]).toFixed(1)} × ${(b[3] - b[1]).toFixed(1)} mm` +
      (pick !== null ? `<p>Selected <b>${esc(d.qubits[pick].id)}</b> at (${at[pick].map((v) => v.toFixed(2)).join(", ")}) mm</p>` : "");
  };
  // Nearest neighbours: every pair at the smallest distance between two transmons of the chip.
  const neighbours = (at) => {
    let near = Infinity;
    at.forEach((a, i) => at.forEach((b, j) => { if (j > i) near = Math.min(near, Math.hypot(a[0] - b[0], a[1] - b[1])); }));
    const out = [];
    at.forEach((a, i) => at.forEach((b, j) => { if (j > i && Math.hypot(a[0] - b[0], a[1] - b[1]) < near + 1e-6) out.push([i, j]); }));
    return out;
  };
  const apply = (at, { auto = svg.closest(".detail").querySelector("[data-auto]")?.checked } = {}) => onChange((d) => {
    d.device.qubits.forEach((q, i) => (q.positionMm = [r6(at[i][0]), 0, r6(at[i][1])]));
    d.device.layout = chipLayout(at, d.device.layout.chip, pitch);
    if (auto) d.device.couplers = neighbours(at);
    doc = d;
  });
  const snap = (p) => ({ x: r6(Math.round((p.x + off[0]) / step) * step - off[0]), y: r6(Math.round((p.y + off[1]) / step) * step - off[1]) });
  draggable(svg, (i, x, y) => {
    const at = doc.device.qubits.map((q) => [q.positionMm[0], q.positionMm[2]]);
    if (at.some(([a, b], k) => k !== i && Math.abs(a - x) < 1e-6 && Math.abs(b - y) < 1e-6)) return draw();
    at[i] = [x, y];
    pick = i;
    apply(at);
    draw();
  }, snap);
  svg.addEventListener("click", (e) => {
    if (e.target.classList.contains("drag")) { pick = Number(e.target.dataset.i); return draw(); }
    if (!e.target.classList.contains("lat")) return;
    const p = snap(point(svg, e));
    const at = doc.device.qubits.map((q) => [q.positionMm[0], q.positionMm[2]]);
    if (at.some(([a, b]) => Math.abs(a - p.x) < 1e-6 && Math.abs(b - p.y) < 1e-6)) return;
    onChange((d) => {
      const id = "q[" + (Math.max(-1, ...d.device.qubits.map((q) => Number(/\d+/.exec(q.id)?.[0] ?? 0))) + 1) + "]";
      d.device.qubits.push({ id, site: "qubit (added)", positionMm: [p.x, 0, p.y] });
      at.push([p.x, p.y]);
      d.device.layout = chipLayout(at, d.device.layout.chip, pitch);
      d.device.couplers = neighbours(at);
      d.device.drives[0]?.targets.push(id);
      doc = d;
    });
    draw();
  });
  keyDelete(() => {
    if (pick === null) return;
    const i = pick;
    pick = null;
    onChange((d) => {
      const id = d.device.qubits[i].id;
      d.device.qubits.splice(i, 1);
      const at = d.device.qubits.map((q) => [q.positionMm[0], q.positionMm[2]]);
      d.device.layout = chipLayout(at, d.device.layout.chip, pitch);
      d.device.couplers = neighbours(at);
      for (const dr of d.device.drives) dr.targets = dr.targets.filter((t) => t !== id);
      doc = d;
    });
    draw();
  });
  draw();
}

let deleteHandler = null;
function keyDelete(fn) {
  if (deleteHandler) removeEventListener("keydown", deleteHandler);
  deleteHandler = (e) => { if ((e.key === "Delete" || e.key === "Backspace") && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) fn(); };
  addEventListener("keydown", deleteHandler);
}

// ------------------------------------------------------------------ the atom array
function atomEditor(doc, { onChange }) {
  const slm = doc.device.layout.slms[0];
  const { svg, side } = shell("Atom array · " + doc.device.qubits.length + " atoms",
    "The SLM's trap sites are the grey dots (" + (slm.pitchMm[0] * 1000).toFixed(1) + " µm pitch). Drag an atom to another site, click an empty site to load an atom, select one and press Delete to remove it. The AODs move atoms between sites during a run.");
  let pick = null;
  const draw = () => {
    const s = doc.device.layout.slms[0], d = doc.device;
    const sites = [];
    for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) sites.push([s.originMm[0] + c * s.pitchMm[0], s.originMm[1] + r * s.pitchMm[1]]);
    const at = d.qubits.map((q) => [q.positionMm[0], q.positionMm[2]]);
    const span = fitView(svg, [...sites, ...at].map((p) => p[0]), [...sites, ...at].map((p) => p[1]), s.pitchMm[0] * 1.2), dot = span / 90;
    svg.innerHTML = sites.map(([x, y]) => `<circle class="lat" cx="${x}" cy="${y}" r="${dot * 0.45}" fill="#aab6bb"/>`).join("") +
      at.map(([x, y], i) => `<circle class="drag" data-i="${i}" cx="${x}" cy="${y}" r="${dot * 1.3}" fill="${i === pick ? "#ffcf4a" : "#d35f7a"}" stroke="#1d2b4f" vector-effect="non-scaling-stroke" style="cursor:grab"/>`).join("");
    side.innerHTML = `<b>${d.qubits.length} atoms</b> on ${s.rows} × ${s.cols} sites<br>pitch ${(s.pitchMm[0] * 1000).toFixed(1)} µm` +
      `<p><label>Rows <input type="number" min="1" max="200" value="${s.rows}" data-k="rows" style="width:5em"></label> <label>Columns <input type="number" min="1" max="200" value="${s.cols}" data-k="cols" style="width:5em"></label></p>` +
      `<p><label>Pitch (µm) <input type="number" min="1" max="100" step="0.5" value="${(s.pitchMm[0] * 1000).toFixed(1)}" data-k="pitch" style="width:5em"></label></p>` +
      (pick !== null ? `<p>Selected <b>${esc(d.qubits[pick].id)}</b></p>` : "");
    side.querySelectorAll("input").forEach((input) => (input.onchange = () => {
      onChange((dd) => {
        const t = dd.device.layout.slms[0], v = Number(input.value);
        if (input.dataset.k === "pitch") {
          const scale = v / 1000 / t.pitchMm[0];
          t.pitchMm = [r6(v / 1000), r6(v / 1000)];
          dd.device.qubits.forEach((q) => (q.positionMm = [r6(t.originMm[0] + (q.positionMm[0] - t.originMm[0]) * scale), 0, r6(t.originMm[1] + (q.positionMm[2] - t.originMm[1]) * scale)]));
        } else t[input.dataset.k] = Math.max(1, Math.round(v));
        doc = dd;
      });
      draw();
    }));
  };
  const snap = (p) => {
    const s = doc.device.layout.slms[0];
    const c = Math.max(0, Math.min(s.cols - 1, Math.round((p.x - s.originMm[0]) / s.pitchMm[0]))), r = Math.max(0, Math.min(s.rows - 1, Math.round((p.y - s.originMm[1]) / s.pitchMm[1])));
    return { x: r6(s.originMm[0] + c * s.pitchMm[0]), y: r6(s.originMm[1] + r * s.pitchMm[1]) };
  };
  const taken = (x, y, except) => doc.device.qubits.some((q, k) => k !== except && Math.abs(q.positionMm[0] - x) < 1e-9 && Math.abs(q.positionMm[2] - y) < 1e-9);
  draggable(svg, (i, x, y) => {
    if (!taken(x, y, i)) onChange((d) => { d.device.qubits[i].positionMm = [x, 0, y]; doc = d; });
    pick = i;
    draw();
  }, snap);
  svg.addEventListener("click", (e) => {
    if (e.target.classList.contains("drag")) { pick = Number(e.target.dataset.i); return draw(); }
    if (!e.target.classList.contains("lat")) return;
    const p = snap(point(svg, e));
    if (taken(p.x, p.y, -1)) return;
    onChange((d) => {
      const id = "q[" + (Math.max(-1, ...d.device.qubits.map((q) => Number(/\d+/.exec(q.id)?.[0] ?? 0))) + 1) + "]";
      d.device.qubits.push({ id, site: "atom (loaded)", positionMm: [p.x, 0, p.y] });
      for (const dr of d.device.drives) dr.targets.push(id);
      doc = d;
    });
    draw();
  });
  keyDelete(() => {
    if (pick === null) return;
    const i = pick;
    pick = null;
    onChange((d) => {
      const id = d.device.qubits[i].id;
      d.device.qubits.splice(i, 1);
      for (const dr of d.device.drives) dr.targets = dr.targets.filter((t) => t !== id);
      doc = d;
    });
    draw();
  });
  draw();
}

// ------------------------------------------------------------------ the ion trap
function trapEditor(doc, { onChange }) {
  const { svg, side, tools } = shell("Ion trap · " + doc.device.layout.sites.length + " zones, " + doc.device.qubits.length + " ions",
    "Zones are the squares; the lines between them are the paths ions shuttle along. Drag a zone to move it (its ions go with it). Tools: add a zone where you click; connect two zones by clicking one, then the other; delete the selected zone with Delete.");
  tools.innerHTML = `<span class="seg"><button type="button" data-tool="move" aria-pressed="true">Move</button><button type="button" data-tool="zone">Add zone</button><button type="button" data-tool="edge">Connect</button></span>`;
  let tool = "move", pick = null;
  tools.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => { tool = b.dataset.tool; pick = null; tools.querySelectorAll("[data-tool]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); draw(); }));
  const zoneOf = (q, sites) => sites.reduce((best, s, k) => (Math.hypot(s.x - q.positionMm[0], s.z - q.positionMm[2]) < Math.hypot(sites[best].x - q.positionMm[0], sites[best].z - q.positionMm[2]) ? k : best), 0);
  const draw = () => {
    const L = doc.device.layout, sites = L.sites, byId = new Map(sites.map((s) => [s.id, s]));
    const span = fitView(svg, sites.map((s) => s.x), sites.map((s) => s.z), 0.25), dot = span / 90;
    const ions = doc.device.qubits.map((q) => zoneOf(q, sites));
    svg.innerHTML = `<rect class="bg" x="-1000" y="-1000" width="2000" height="2000" fill="transparent"/>` +
      L.edges.map(([a, b]) => byId.get(a) && byId.get(b) ? `<line x1="${byId.get(a).x}" y1="${byId.get(a).z}" x2="${byId.get(b).x}" y2="${byId.get(b).z}" stroke="#7a8a92" stroke-width="${dot * 0.5}"/>` : "").join("") +
      sites.map((s, k) => `<rect class="drag zone" data-i="${k}" x="${s.x - dot * 1.6}" y="${s.z - dot * 1.6}" width="${dot * 3.2}" height="${dot * 3.2}" rx="${dot * 0.4}" fill="${k === pick ? "#ffcf4a" : "#c9d5da"}" stroke="#1d2b4f" vector-effect="non-scaling-stroke" style="cursor:pointer"/>`).join("") +
      sites.map((s, k) => {
        const mine = ions.map((z, i) => (z === k ? i : -1)).filter((i) => i >= 0);
        return mine.map((i, j) => `<circle cx="${s.x - dot * 0.8 + (j % 3) * dot * 0.8}" cy="${s.z - dot * 0.4 + Math.floor(j / 3) * dot * 0.8}" r="${dot * 0.35}" fill="#5f7bd3"/>`).join("");
      }).join("");
    side.innerHTML = `<b>${sites.length} zones</b>, ${L.edges.length} shuttle paths, ${doc.device.qubits.length} ions` + (pick !== null ? `<p>Selected zone <b>${esc(sites[pick].id)}</b></p>` : "");
    // Zones drag as rectangles: reuse the circle dragger through cx/cy on a proxy.
  };
  let held = null;
  svg.addEventListener("pointerdown", (e) => {
    const z = e.target.closest(".zone"), p = point(svg, e);
    if (tool === "zone" && !z) {
      onChange((d) => {
        const n = Math.max(-1, ...d.device.layout.sites.map((s) => Number(/\d+/.exec(s.id)?.[0] ?? 0))) + 1;
        d.device.layout.sites.push({ id: "Z" + n, x: r6(p.x), z: r6(p.y), zone: "gate" });
        doc = d;
      });
      return draw();
    }
    if (!z) return;
    const k = Number(z.dataset.i);
    if (tool === "edge") {
      if (pick === null) { pick = k; return draw(); }
      const a = doc.device.layout.sites[pick].id, b = doc.device.layout.sites[k].id;
      pick = null;
      if (a !== b && !doc.device.layout.edges.some((e2) => e2.includes(a) && e2.includes(b))) onChange((d) => { d.device.layout.edges.push([a, b]); doc = d; });
      return draw();
    }
    pick = k;
    held = { k, from: p };
    svg.setPointerCapture(e.pointerId);
    draw();
  });
  svg.addEventListener("pointerup", (e) => {
    if (!held) return;
    const p = point(svg, e), dx = p.x - held.from.x, dz = p.y - held.from.y, k = held.k;
    held = null;
    if (Math.hypot(dx, dz) < 1e-6) return;
    onChange((d) => {
      const s = d.device.layout.sites[k], mine = d.device.qubits.filter((q) => zoneOf(q, d.device.layout.sites) === k);
      s.x = r6(s.x + dx);
      s.z = r6(s.z + dz);
      for (const q of mine) q.positionMm = [r6(q.positionMm[0] + dx), q.positionMm[1], r6(q.positionMm[2] + dz)];
      doc = d;
    });
    draw();
  });
  keyDelete(() => {
    if (pick === null) return;
    const k = pick;
    pick = null;
    const sites = doc.device.layout.sites;
    if (doc.device.qubits.some((q) => zoneOf(q, sites) === k)) return alert("Move this zone's ions out first: a zone with ions cannot be removed.");
    onChange((d) => {
      const id = d.device.layout.sites[k].id;
      d.device.layout.sites.splice(k, 1);
      d.device.layout.edges = d.device.layout.edges.filter((e2) => !e2.includes(id));
      doc = d;
    });
    draw();
  });
  draw();
}

// ------------------------------------------------------------------ a RISC-Q board
function boardEditor(doc, { board, onChange }) {
  const { svg, side, tools } = shell("RISC-Q board " + board.index + " (AMD ZCU216) · " + board.cores.length + " cores",
    "The RFSoC carries one tile per RISC-Q core (colour: its role); the strips below are the board's 16 RF-DAC and 16 RF-ADC outputs, lit where a core's channel uses them. Click a core to see its channels. A ZCU216 holds " + LIMIT.cores + " cores.");
  tools.innerHTML = `<button type="button" data-add>Add a qubit core</button> <button type="button" data-remove disabled>Remove selected core</button>`;
  let pick = null;
  const draw = () => {
    const b = doc.control.boards.find((x) => x.index === board.index) ?? board;
    const dacs = new Set(), adcs = new Set();
    for (const c of b.cores) for (const ch of c.channels) if (ch[2] !== undefined) (ch[0] === "demod" ? adcs : dacs).add(ch[2]);
    svg.setAttribute("viewBox", "0 0 400 260");
    const tile = (c, i) => {
      const r = Math.floor(i / 4), k = i % 4, x = 132 + k * 36, y = 40 + r * 36;
      return `<rect class="core" data-i="${i}" x="${x}" y="${y}" width="32" height="32" rx="3" fill="${ROLE_COLOR[c.role] ?? "#8a9aa2"}" stroke="${i === pick ? "#ffcf4a" : "#1d2b4f"}" stroke-width="${i === pick ? 2.5 : 0.6}" style="cursor:pointer"/>` +
        `<text x="${x + 16}" y="${y + 19}" font-size="7" text-anchor="middle" fill="#fff" pointer-events="none">${esc(c.name.slice(0, 8))}</text>`;
    };
    svg.innerHTML = `<rect x="10" y="10" width="380" height="240" rx="6" fill="#1f5a44"/><rect x="124" y="32" width="152" height="${Math.max(48, Math.ceil(Math.max(1, b.cores.length) / 4) * 36 + 16)}" rx="4" fill="#2a2f36"/>` +
      `<text x="200" y="26" font-size="9" fill="#cfe7dd" text-anchor="middle">RFSoC · ${b.cores.length} RISC-Q cores</text>` + b.cores.map(tile).join("") +
      Array.from({ length: 16 }, (_, i) => `<rect x="${26 + i * 22}" y="200" width="18" height="14" rx="2" fill="${dacs.has(i) ? "#d9a652" : "#3e6b5b"}"/><rect x="${26 + i * 22}" y="222" width="18" height="14" rx="2" fill="${adcs.has(i) ? "#b9c3c9" : "#3e6b5b"}"/>`).join("") +
      `<text x="14" y="211" font-size="7" fill="#cfe7dd">DAC</text><text x="14" y="233" font-size="7" fill="#cfe7dd">ADC</text>`;
    const c = b.cores[pick];
    side.innerHTML = `<b>${b.cores.length} / ${LIMIT.cores} cores</b> · DACs in use ${dacs.size} / ${LIMIT.dacs} · ADCs ${adcs.size} / ${LIMIT.adcs}` +
      (b.cores.length > LIMIT.cores ? `<p style="color:#b3321c">More cores than a ZCU216 holds.</p>` : "") +
      (c ? `<p><b>${esc(c.name)}</b> · ${esc(c.role)}${c.sites?.length ? " · serves qubit " + c.sites.join(", ") : ""}</p><table><tr><th>Kind</th><th>Name</th><th>Converter</th></tr>` +
        c.channels.map((ch) => `<tr><td>${esc(ch[0])}</td><td>${esc(ch[1])}</td><td>${ch[2] === undefined ? "–" : (ch[0] === "demod" ? "ADC " : "DAC ") + ch[2]}</td></tr>`).join("") + `</table>` : "<p>Click a core.</p>");
    tools.querySelector("[data-remove]").disabled = pick === null;
  };
  svg.addEventListener("click", (e) => { const t = e.target.closest(".core"); if (t) { pick = Number(t.dataset.i); draw(); } });
  tools.querySelector("[data-add]").onclick = () => {
    onChange((d) => {
      const b = d.control.boards.find((x) => x.index === board.index);
      const used = new Set(b.cores.flatMap((c) => c.channels.filter((ch) => ch[0] === "pulse").map((ch) => ch[2])));
      const dac = [...Array(16).keys()].find((i) => !used.has(i)) ?? 0;
      b.cores.push({ name: "q" + b.cores.length + "@" + b.index, role: "qubit", channels: [["pulse", "gate", dac], ["pulse", "ro", 15], ["demod", "demod", dac]], sites: [] });
      const part = d.parts.find((p) => p.id === "board" + b.index);
      if (part) { part.model.zcu216.cores = b.cores.length; part.label = "RISC-Q board " + b.index + " (AMD ZCU216) · " + b.cores.length + " cores"; }
      doc = d;
    });
    draw();
  };
  tools.querySelector("[data-remove]").onclick = () => {
    const i = pick;
    pick = null;
    onChange((d) => {
      const b = d.control.boards.find((x) => x.index === board.index);
      b.cores.splice(i, 1);
      const part = d.parts.find((p) => p.id === "board" + b.index);
      if (part) { part.model.zcu216.cores = b.cores.length; part.label = "RISC-Q board " + b.index + " (AMD ZCU216) · " + b.cores.length + " cores"; }
      doc = d;
    });
    draw();
  };
  draw();
}

/** Open the 2D editor of `kind` ("superconducting" | "neutral" | "qccd" | "zcu216") on `doc`. */
export function openDetail(kind, doc, options) {
  const run = { superconducting: chipEditor, neutral: atomEditor, qccd: trapEditor, zcu216: boardEditor }[kind];
  // Every edit goes through the page (undo, rebuild); the editor keeps the edited document.
  const onChange = (edit) => options.onChange((d) => edit(d));
  run(doc, { ...options, onChange });
  document.getElementById("detail").querySelector("[data-close]").onclick = () => {
    document.getElementById("detail").hidden = true;
    if (deleteHandler) removeEventListener("keydown", deleteHandler);
  };
}
