// /reproduce: published experiments compiled with FormalRV system calls onto digital twins.
// The list comes from /reproduce/data/index.json (riscq/ftqvm/reproductions.mjs); a page's
// numbers come from its run, /reproduce/data/<id>.json (riscq/ftqvm/papers.mjs).

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const code = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const µs = (ns, digits = 1) => (ns === undefined || ns === null ? "–" : (ns / 1000).toFixed(digits));
const badge = (status) => `<span class="badge ${/^reproduced$/.test(status) ? "done" : /reproduced/.test(status) ? "partial" : "todo"}">${esc(status)}</span>`;
const cite = (p) => `${esc(p.authors)}, <a href="${esc(p.url)}">${esc(p.title)}</a>, ${esc(p.venue)}`;

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw Error(url + ": " + res.status);
  return res.json();
}

export async function renderIndex(el) {
  try {
    const list = await json("/reproduce/data/index.json");
    el.innerHTML = list.map((r) => `
      <a class="card" href="/reproduce/${esc(r.id)}">
        <span class="kicker">${esc(r.platform)}</span> ${badge(r.status)}
        <h3>${esc(r.title)}</h3>
        <p>${esc(r.summary)}</p>
        <p class="cite">${esc(r.paper.authors)} · ${esc(r.paper.venue)}</p>
      </a>`).join("");
  } catch (error) {
    el.textContent = "The list could not be loaded: " + error.message;
  }
}

/** The twin's parameters as a table: name, value, unit and source. */
function twinTable(data) {
  const entries = [];
  if (data.device?.durations) for (const [k, v] of Object.entries(data.device.durations)) entries.push([k, v.value + " ns", v.source]);
  if (data.device?.published) for (const [k, v] of Object.entries(data.device.published)) if (v?.value !== undefined) entries.push(["paper: " + k, v.value + (/Ns$/.test(k) ? " ns" : ""), v.source]);
  const unit = (k) => (/Ns$/.test(k) ? " ns" : /Um$/.test(k) ? " µm" : k === "accel" ? " m/s²" : "");
  if (data.design?.profile) for (const [k, v] of Object.entries(data.design.profile)) if (v?.value !== undefined) entries.push([k, v.value + unit(k), v.source]);
  if (data.design) for (const k of ["pitchUm", "interactUm", "beams", "movers", "decoders"]) if (data.design[k] !== undefined) entries.push([k, data.design[k], "design point of the twin (riscq/ftqvm/optical.mjs)"]);
  if (!entries.length) return "";
  return `<div class="tbl"><table><thead><tr><th>Parameter</th><th>Value</th><th class="src">Source</th></tr></thead><tbody>${
    entries.map(([k, v, s]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td><td class="src">${esc(s)}</td></tr>`).join("")}</tbody></table></div>`;
}

/** The results table: one row per run, the columns that run has. */
function resultsTable(rows) {
  const cols = [
    ["distance", "d", (r) => r.distance], ["basis", "Basis or setting", (r) => r.basis ?? "–"], ["rounds", "Rounds", (r) => r.rounds ?? "–"],
    ["qubits", "Qubits placed", (r) => r.qubits ?? "–"], ["ops", "Operations", (r) => r.ops ?? "–"],
    ["conforms", "Every operation in its window", (r) => (r.error ? `<span class="no">${esc(r.error.slice(0, 90))}</span>` : r.conforms ? '<span class="yes">yes</span>' : '<span class="no">no</span>')],
    ["roundNs", "FormalRV round (µs)", (r) => µs(r.roundNs, 2)], ["paper", "Paper cycle (µs)", (r) => (r.paper ? µs(r.paper.cycleNs) : "–")],
    ["transversalSpreadNs", "Transversal CNOTs spread over (µs)", (r) => µs(r.transversalSpreadNs)],
    ["routeNs", "Route (µs)", (r) => µs(r.routeNs)], ["gate2qNs", "Two-qubit gate (µs)", (r) => µs(r.gate2qNs, 3)],
    ["measureNs", "Measure (µs)", (r) => µs(r.measureNs, 2)], ["decoderNs", "Decoder (µs)", (r) => µs(r.decoderNs)],
    ["makespanNs", "Program (ms)", (r) => (r.makespanNs ? (r.makespanNs / 1e6).toFixed(3) : "–")],
  ].filter(([key]) => rows.some((r) => r[key] !== undefined) || key === "conforms");
  return `<div class="tbl"><table><thead><tr>${cols.map(([, h]) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map(([, , f]) => `<td>${f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

/** One run's details: the program, the derived specification with sources, conformance, slack. */
function runDetail(r) {
  if (r.error) return `<p class="no">This run did not complete: ${esc(r.error)}</p>`;
  const spec = Object.entries(r.spec ?? {}).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v.value)}</td><td>${esc(v.source)}</td><td class="src">${esc(v.note ?? "")}</td></tr>`).join("");
  const kinds = Object.entries(r.byKind ?? {}).map(([k, v]) => {
    const s = r.slack?.[k];
    return `<tr><td><code>${esc(k)}</code></td><td>${v.ok} / ${v.count}</td><td>${s ? s.declaredNs : "–"}</td><td>${s ? [s.minNs, s.medianNs, s.maxNs].join(" / ") : "–"}</td><td>${v.maxOverrunNs || 0}</td></tr>`;
  }).join("");
  return `
    <h3>Compiled listing</h3>
    <p>The listing FormalRV compiled against the specification below has ${r.listingLines ?? "–"} lines and expands to ${r.ops} timed operations. Its first lines:</p>
    <pre class="code">${esc(r.listingHead ?? "")}</pre>
    <h3>Derived system specification</h3>
    <p>What FormalRV compiled against, in its own format. A value marked <b>measured</b> is the longest time the twin's trace showed for that kind of operation; <b>derived</b> counts the twin's parts; <b>provisional</b> is not yet realized by this twin.</p>
    <div class="tbl"><table><thead><tr><th>Field</th><th>Value</th><th>Source</th><th class="src">Note</th></tr></thead><tbody>${spec}</tbody></table></div>
    <details class="block"><summary>The .machine and .sysspec files</summary><pre class="code">${esc(r.machineText)}</pre><pre class="code">${esc(r.sysspecText)}</pre></details>
    <h3>Every operation against its window</h3>
    <p>For each kind of operation: how many finished inside the window the listing gave them, the listed duration, and the hardware time the trace shows (min / median / max, ns). The difference is the slack the specification leaves.</p>
    <div class="tbl"><table><thead><tr><th>Operation</th><th>In window</th><th>Listed (ns)</th><th>Hardware min / median / max (ns)</th><th>Longest overrun (ns)</th></tr></thead><tbody>${kinds}</tbody></table></div>
    <details class="block"><summary>The FormalRV program</summary><pre class="code">${esc(r.programText ?? "")}</pre></details>`;
}

export async function renderPaper(el, id) {
  let data;
  try {
    const list = await json("/reproduce/data/index.json");
    const meta = list.find((r) => r.id === id);
    if (!meta) throw Error("no reproduction named " + id);
    data = meta.hasResults ? await json("/reproduce/data/" + id + ".json") : { meta };
    data.meta = { ...meta, ...(data.meta ?? {}) };
  } catch (error) {
    el.textContent = "This page could not be loaded: " + error.message;
    return;
  }
  const m = data.meta, rows = data.rows ?? [];
  const runButtons = rows.map((r, i) =>
    `<button type="button" data-run="${i}" aria-pressed="false">d = ${r.distance}${r.basis ? " · " + r.basis : ""}${r.rounds ? " · " + r.rounds + " rounds" : ""}</button>`).join("");
  document.title = m.title + " · Reproduce · QuantumOS";
  el.innerHTML = `
    <p class="kicker"><a href="/reproduce">Reproduce</a> · ${esc(m.platform)}</p>
    <h1>${esc(m.title)}</h1>
    <p>${badge(m.status)}</p>
    <p class="lead">${esc(m.summary)}</p>
    <p class="cite">${cite(m.paper)}</p>
    <p><a class="btn design" href="/reproduce/${esc(id)}/design">Open the design: the whole machine, editable</a></p>
    ${rows.some((r) => r.track) ? `<h2>The twin, running the program</h2>
    <p>The machine below is the twin this page describes, running the compiled program. Every pulse, move, readout and decode appears at the time the Lean model of the control system executed it; drag to turn the view, scroll to zoom.</p>
    <div class="runpick" role="group" aria-label="Run">${runButtons}</div>
    <div id="twin" class="twin"></div>` : ""}
    <h2>The program</h2><p>${code(m.program)}</p>
    <h2>The digital twin</h2><p>${code(m.twin)}</p>
    ${twinTable(data)}
    ${data.device?.basis ? `<div class="note"><b>What the twin takes from the paper.</b> ${esc(data.device.basis)}</div>` : ""}
    <h2>Results</h2>
    ${rows.length ? resultsTable(rows) : "<p>No run yet.</p>"}
    ${data.generated ? `<p class="cite">Run on ${esc(data.generated.slice(0, 10))}.</p>` : ""}
    <h2>What we found</h2><ul>${m.findings.map((f) => `<li>${code(f)}</li>`).join("")}</ul>
    ${m.limits.length ? `<h2>Limits of this reproduction</h2><ul>${m.limits.map((f) => `<li>${code(f)}</li>`).join("")}</ul>` : ""}
    ${rows.length ? `<h2>One run in detail</h2><div class="runpick" role="group" aria-label="Run">${runButtons}</div><div id="run"></div>` : ""}
    ${m.command ? `<h2>Reproduce it yourself</h2><p>With QuantumOS and a built FormalRV checkout next to it:</p><pre class="code">${esc(m.command)}</pre>` : ""}`;
  const run = el.querySelector("#run"), twin = el.querySelector("#twin");
  let viewer;
  const show = async (i) => {
    run.innerHTML = runDetail(rows[i]);
    el.querySelectorAll(".runpick button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.run) === i)));
    if (!twin) return;
    viewer?.dispose();
    viewer = undefined;
    if (!rows[i].track) {
      twin.innerHTML = `<p class="no">${rows[i].error ? "This run did not complete, so there is nothing to play: " + esc(rows[i].error) : "No track was recorded for this run."}</p>`;
      return;
    }
    const { mountTwin } = await import("/reproduce/twin3d.js");
    const tr = rows[i].track;
    viewer = mountTwin(twin, tr, { caption: `${tr.device.sites.length} qubits, ${tr.events.length} operations${tr.moves?.length ? ", " + tr.moves.length + " moves" : ""}, ${(tr.endNs / 1000).toFixed(1)} µs of machine time, shown in about 45 s. Part sizes are drawn for legibility; positions and times are the run's.` });
  };
  if (run) {
    el.querySelectorAll(".runpick button").forEach((b) => b.addEventListener("click", () => show(Number(b.dataset.run))));
    show(Math.max(0, rows.findIndex((r) => !r.error)));
  }
}
