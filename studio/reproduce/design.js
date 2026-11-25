// The design page of a reproduction (/reproduce/<id>/design): the paper's twin with its hardware
// as editable parameters, and the compiled program run again on the edited machine.
//
// The program does not change: it is the QSysASM listing compiled for the paper's twin. A rerun
// plays it time-triggered on the edited machine in the Lean model of the control system
// (POST /api/reproduce/run, riscq/ftqvm/designs.mjs and magic.mjs) and checks every operation
// against the window the listing gave it.
import { ROLE_COLORS, ROLE_LABEL } from "/reproduce/control3d.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const json = async (url, options) => {
  const r = await fetch(url, options);
  if (!r.ok) throw Error(url + ": " + r.status);
  return r.json();
};
const hex = (c) => "#" + c.toString(16).padStart(6, "0");

function field(p, value, valueWord = "Paper value") {
  const id = "p-" + p.key, edited = String(value) !== String(p.value);
  const input = p.options
    ? `<select id="${id}" data-key="${esc(p.key)}">${p.options.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(value) ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`
    : `<input id="${id}" data-key="${esc(p.key)}" type="number" value="${esc(value)}"${p.min !== undefined ? ` min="${p.min}"` : ""}${p.max !== undefined ? ` max="${p.max}"` : ""}${p.step !== undefined ? ` step="${p.step}"` : ""}>`;
  return `<div class="dfield${edited ? " edited" : ""}" data-field="${esc(p.key)}">
    <label for="${id}">${esc(p.label)}${p.unit ? ` <span class="unit">(${esc(p.unit)})</span>` : ""}</label>
    <div class="dinput">${input}<span class="dchip">edited</span></div>
    ${p.source ? `<p class="dsrc">${valueWord} ${esc(p.options ? p.options.find((o) => String(o.value) === String(p.value))?.label ?? p.value : p.value)}${p.unit ? " " + esc(p.unit) : ""}: ${esc(p.source)}</p>` : ""}
  </div>`;
}

function byKindTable(byKind) {
  const rows = Object.entries(byKind ?? {}).map(([k, v]) =>
    `<tr><td><code>${esc(k)}</code></td><td class="${v.ok === v.count ? "yes" : "no"}">${v.ok} / ${v.count}</td><td>${v.maxOverrunNs ? Math.round(v.maxOverrunNs) + " ns" : "–"}</td></tr>`).join("");
  return rows ? `<div class="tbl"><table><thead><tr><th>Operation</th><th>Inside its window</th><th>Longest overrun</th></tr></thead><tbody>${rows}</tbody></table></div>` : "";
}

function controllerTable(ctl) {
  if (!ctl) return "";
  const roles = new Map();
  for (const c of ctl.cores) {
    const r = roles.get(c.role) ?? { cores: [], channels: 0, sites: new Set() };
    r.cores.push(c.name);
    r.channels += c.channels.length;
    c.sites.forEach((s) => r.sites.add(s));
    roles.set(c.role, r);
  }
  const busy = new Map();
  for (const p of ctl.pulses) busy.set(p[0], (busy.get(p[0]) ?? 0) + 1);
  const rows = [...roles.entries()].map(([role, r]) => `<tr><td><i class="dot" style="background:${hex(ROLE_COLORS[role] ?? 0x94a3b8)}"></i>${esc(ROLE_LABEL[role] ?? role)}</td><td>${r.cores.length}</td><td>${r.channels}</td><td>${r.sites.size || "–"}</td><td class="src">${esc(r.cores.slice(0, 6).join(", "))}${r.cores.length > 6 ? ", …" : ""}</td></tr>`).join("");
  return `<p>Board <b>${esc(ctl.board.name)}</b>, batch clock ${esc(ctl.board.dspMHz)} MHz, ${ctl.cores.length} cores, ${ctl.pulses.length}${ctl.truncated ? "+" : ""} pulses played.</p>
    <div class="tbl"><table><thead><tr><th>Core role</th><th>Cores</th><th>Channels</th><th>Sites driven</th><th class="src">Cores</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function failuresTable(failures) {
  if (!failures?.length) return "";
  const ns = (x) => (Number.isFinite(x) ? Math.round(x) : "–");
  return `<h3>First operations outside their window</h3>
    <div class="tbl"><table><thead><tr><th>Operation</th><th>Listing line</th><th>Window (ns)</th><th>Hardware (ns)</th><th>Why</th></tr></thead><tbody>${
    failures.map((f) => `<tr><td><code>${esc(f.kind)}</code></td><td>${esc(f.line ?? "–")}</td><td>${ns(f.start)} – ${ns(f.end)}</td><td>${f.hardwareNs ? ns(f.hardwareNs[0]) + " – " + ns(f.hardwareNs[1]) : "–"}${f.bitNs ? " (bit at " + ns(f.bitNs) + ")" : ""}</td><td>${esc(f.reason ?? "")}</td></tr>`).join("")}</tbody></table></div>`;
}

export async function renderDesign(el, id, { section = "reproduce" } = {}) {
  // `section`: "reproduce" (a paper's twin) or "examples" (an Examples study, /examples/<id>/design).
  const ex = section === "examples", base = ex ? "/examples" : "/reproduce", sectionName = ex ? "Examples" : "Reproduce";
  let meta, stored, params, intro, studioRows = [];
  try {
    const list = await json(base + "/data/index.json");
    meta = list.find((r) => r.id === id);
    if (!meta) throw Error("no " + (ex ? "example" : "reproduction") + " named " + id);
    stored = ex || meta.hasResults ? await json(base + "/data/" + id + ".json").catch(() => null) : null;
    const p = await json("/api/reproduce/params?id=" + encodeURIComponent(id));
    if (p.error) throw Error(p.error);
    params = p.params;
    intro = p.intro;
    // Rows the studio can open (riscq/ftqvm/studio-runs.mjs): reproduction:<id>:<row>.
    studioRows = (await json("/api/riscq/examples").catch(() => [])).filter((e) => e.id.startsWith("reproduction:" + id + ":")).map((e) => e.id.split(":")[2]);
  } catch (error) {
    el.innerHTML = `<p class="kicker"><a href="${base}">${sectionName}</a></p><p class="no">This design could not be loaded: ${esc(error.message)}</p>`;
    return;
  }
  document.title = "Design · " + meta.title + " · " + sectionName + " · QuantumOS";
  // Values: the paper's, then any kept in the address (#key=value&…), so an edited design can be shared.
  const values = Object.fromEntries(params.map((p) => [p.key, p.value]));
  for (const [k, v] of new URLSearchParams(location.hash.slice(1))) if (k in values) values[k] = v;
  const groups = [...new Set(params.map((p) => p.group ?? "Parameters"))];
  el.innerHTML = `
    <p class="kicker"><a href="${base}">${sectionName}</a> · <a href="${base}/${esc(id)}">${esc(meta.title)}</a> · design</p>
    <h1>${ex ? esc(meta.title) + ": choose the machine and run it" : `The machine of ${esc(meta.paper?.authors?.split(",")[0] ?? "")} ${esc(meta.paper?.venue?.match(/\((\d{4})\)/)?.[1] ?? "")}: edit it and run it again`}</h1>
    ${ex ? `<p class="lead">The study's run as a starting point: choose the program, the hardware design and how the operating system runs it, then run it on the cycle-exact model of the control system. Every operation is checked against its window.</p>` : ""}<p class="lead"${ex ? " hidden" : ""}>This is the twin the reproduction ran on, down to its control system. Change the device or the controller, then run the same compiled program again. Each pulse plays at the time the program gives it, in the Lean model of the RISC-Q board, and every operation is checked against the window the compiler's specification gave it.</p>
    ${intro ? `<div class="note">${esc(intro)}</div>` : `<div class="note">The program stays fixed: it is the QSysASM listing compiled for the paper's twin. If an operation no longer fits its window, the compiler has to derive the specification again for the edited machine (<code>${esc(meta.command ?? "")}</code>, which needs a compiler checkout). The run then reports which operations overrun, and by how much.</div>`}
    <div class="design-grid">
      <form class="dform" autocomplete="off">
        ${groups.map((g) => `<fieldset><legend>${esc(g)}</legend>${params.filter((p) => (p.group ?? "Parameters") === g).map((p) => field(p, values[p.key], ex ? "Study's value" : "Paper value")).join("")}</fieldset>`).join("")}
        <div class="dactions">
          <button type="submit" class="btn">Run on this machine</button>
          <button type="button" class="btn alt" data-act="reset">${ex ? "The study's values" : "Paper's values"}</button>
        </div>
        <p class="dstatus" role="status"></p>
      </form>
      <div>
        <div id="twin" class="twin"></div>
        <div id="verdict"></div>
      </div>
    </div>
    <div id="result"></div>`;
  const form = el.querySelector(".dform"), status = el.querySelector(".dstatus"), twin = el.querySelector("#twin"), verdict = el.querySelector("#verdict"), result = el.querySelector("#result");
  let viewer;
  const current = () => Object.fromEntries([...form.querySelectorAll("[data-key]")].map((i) => [i.dataset.key, i.value]));
  const mark = () => {
    for (const p of params) {
      const box = form.querySelector(`[data-field="${CSS.escape(p.key)}"]`), v = form.querySelector(`[data-key="${CSS.escape(p.key)}"]`).value;
      box.classList.toggle("edited", String(v) !== String(p.value));
    }
    const edits = params.filter((p) => String(current()[p.key]) !== String(p.value) && p.key !== "row");
    const hash = new URLSearchParams(Object.fromEntries(params.filter((p) => String(current()[p.key]) !== String(p.value)).map((p) => [p.key, current()[p.key]]))).toString();
    history.replaceState(null, "", location.pathname + (hash ? "#" + hash : ""));
    return edits;
  };
  form.addEventListener("input", mark);
  // The studio's name for the chosen run: a stored twin row, or one of the paper's circuits.
  const studioKey = () => { const c = current(); return c.row ?? (c.circuit ? "circuit=" + c.circuit : c.d ? "d=" + c.d : undefined); };

  async function show(row, { design, label }) {
    viewer?.dispose();
    viewer = undefined;
    if (row.track) {
      const { mountTwin } = await import("/reproduce/twin3d.js");
      const tr = row.track;
      viewer = mountTwin(twin, tr, { caption: `${esc(label)}: ${tr.device.sites.length} qubits, ${tr.events.length} operations${tr.controller ? ", " + tr.controller.cores.length + " controller cores" : ""}, ${(tr.endNs / 1000).toFixed(1)} µs of machine time. Hover a core, an instrument or the host to inspect it.` });
    } else twin.innerHTML = `<p class="no">No track was recorded for this run.</p>`;
    const cols = Object.entries(row.columns ?? {}).filter(([, v]) => v !== undefined && v !== null);
    verdict.innerHTML = `<p class="dverdict ${row.conforms ? "ok" : "bad"}">${row.conforms ? "✓ Every operation ran inside its window on this machine." : "✗ Some operations did not fit their windows on this machine."}</p>
      ${cols.length ? `<div class="tbl"><table><tbody>${cols.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
    result.innerHTML = `
      <h2>Every operation against its window</h2>${byKindTable(row.byKind)}
      ${failuresTable(row.failures)}
      ${row.program ? `<details class="qsys"><summary>The timetable the operating system produced (QSysASM)</summary><pre class="code">${esc(row.program)}</pre></details>` : ""}
      <h2>The control system</h2>${controllerTable(row.track?.controller)}
      ${design ? `<p><button type="button" class="btn" data-act="editor">Open the chip in the hardware editor</button> <span class="cite">The edited chip, its control board and every cable, in the RISC-Q design editor.</span></p>` : ""}
      ${studioRows.includes(studioKey()) ? `<p><a class="btn" href="/riscq-studio?${new URLSearchParams({ example: "reproduction:" + id + ":" + studioKey() })}">Open this run in the RISC-Q studio</a> <span class="cite">The paper's twin, without your edits, in the studio: the QSysASM listing, the hardware instructions, every core's firmware and the Lean trace, step by step.</span></p>` : ""}`;
    result.querySelector('[data-act="editor"]')?.addEventListener("click", () => {
      try {
        // With its run's id, the editor reruns the paper's own program on the chip as it is edited there.
        const key = studioKey();
        localStorage.setItem("riscq-design:reproduce", JSON.stringify({ design, ...(studioRows.includes(key) ? { reproduction: "reproduction:" + id + ":" + key } : {}) }));
        location.href = "/riscq-design?from=reproduce";
      } catch (error) {
        alert("The chip could not be handed to the editor: " + error.message);
      }
    });
  }

  // First the stored run of the paper (no rerun needed), then reruns on request.
  // A stored row is shown only when it is the run of these parameters (its twin key is the row's).
  // An Examples study keys its stored runs by all their parameters (riscq/calib/example-runs.mjs key()).
  const exampleKey = (p) => JSON.stringify([p.program, p.design, p.execution || "timetable", String(p.decoders ?? ""), String(p.factories ?? ""), String(p.ancillas ?? 100), p.windows || "spec"]);
  // A row with a `formKey` (the operating-system study) answers the form values it names.
  const answers = (r, key) => (r.formKey ? Object.entries(r.formKey).every(([k, v]) => String(current()[k]) === String(v))
    : r.twinKey !== undefined && r.twinKey === (ex ? exampleKey(current()) : key));
  const storedRow = (key) => (stored?.rows ?? []).find((r) => answers(r, key) && r.track);
  let running = false;
  async function rerun() {
    if (running) return;
    running = true;
    const t0 = performance.now(), button = form.querySelector('[type="submit"]');
    button.disabled = true;
    const tick = setInterval(() => (status.textContent = `Running on the Lean model of the control system… ${((performance.now() - t0) / 1000).toFixed(0)} s`), 500);
    try {
      const out = await json("/api/reproduce/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, params: current() }) });
      if (out.error) throw Error(out.error);
      const edits = mark();
      await show(out.rows[0], { design: out.design, label: edits.length ? "Edited machine (" + edits.map((p) => p.label.toLowerCase()).join(", ") + ")" : ex ? "The study's run, run again" : "The paper's machine, run again" });
      status.textContent = `Ran in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
    } catch (error) {
      status.innerHTML = `<span class="no">The run failed: ${esc(error.message)}</span>`;
    } finally {
      clearInterval(tick);
      button.disabled = false;
      running = false;
    }
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); rerun(); });
  form.querySelector('[data-act="reset"]').addEventListener("click", () => {
    for (const p of params) form.querySelector(`[data-key="${CSS.escape(p.key)}"]`).value = p.value;
    mark();
  });
  form.querySelector('[data-key="row"]')?.addEventListener("change", (e) => {
    const s = storedRow(e.target.value);
    if (s && !mark().length) show(s, { label: ex ? "The study's run" : "The paper's run" });
  });
  const edits = mark(), first = storedRow(values.row);
  if (first && !edits.length) await show(first, { label: ex ? "The study's run" : "The paper's run" });
  else await rerun();
}
