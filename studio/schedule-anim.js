// Interactive animations of /schedule.
//
// mountStepper: the operating system's scheduler, step by step, on the worked examples of
// riscq/os/teaching-examples.mjs (or a program the reader edits). It runs the OS's own code in the
// browser (riscq/os/schedule.mjs, riscq/os/des.mjs) and draws, at every event time, which statements
// are waiting for a predecessor, ready, running or done, how full each service is, the ready queue in
// the policy's order, and the timeline so far. Nothing here schedules: it only shows des.mjs's result.
//
// mountMachine: a cycle-exact run (validation/os/schedule.json, riscq/os/schedule-study.mjs) replayed on
// a drawing of its chip: pulses on each core's wire and transmon, couplers during CZ pulses, readout,
// bits travelling to the decoder, the decode, frame-word stores, and the firmware of the selected core.
// Every time drawn is a time of the trace.
import * as qsysasm from "/riscq/ftqvm/qsysasm.mjs";
import { schedule } from "/riscq/os/schedule.mjs";
import { machineModel } from "/riscq/os/des.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const num = (x, d = 0) => Number(x).toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d });
const tns = (t) => (t >= 1e6 ? num(t / 1e6, 3) + " ms" : t >= 1000 ? num(t / 1000, t % 1000 ? 2 : 0) + " µs" : num(t) + " ns");
const strip = (s) => String(s ?? "").replace(/^@\d+\s*ns\s+/, "").replace(/\s{2,}/g, " ");
const KIND_COLOR = (k) => (["H", "S", "Sdg", "X", "Z", "CNOT", "CZ", "CY"].includes(k) ? "#4338ca" : k === "request_ancilla" ? "#1baf7a" : k === "measure" ? "#c4622d"
  : k === "decode_syndrome" ? "#c62828" : k === "pauli_frame_update" || k === "parity" ? "#0e7490" : k === "request_magic" ? "#b45309" : "#8a9a9c");
const STATE = { blocked: ["#eef0f5", "#8a9a9c", "waiting for a predecessor"], waiting: ["#fde2e2", "#c62828", "ready, waiting for a service"],
  running: ["#e0e7ff", "#4338ca", "running"], done: ["#e3f5ec", "#1baf7a", "done"] };
const POOL_LABEL = { gates: "gate slots", qubits: "ancilla qubits", decoders: "decoders", factories: "factories", classical: "classical bandwidth (bits/µs)",
  routing: "routing bandwidth (qubits/µs)", ancillaRate: "ancilla preparation (qubits/µs)", readouts: "readout channels" };
const FIELD_OF_POOL = { gates: "max_parallel_gates", qubits: "qubits", decoders: "decoders", factories: "factories", classical: "classical_data_bandwidth",
  routing: "qubit_routing_bandwidth", ancillaRate: "ancilla_bandwidth" };
const key = (s) => s.register + "[" + s.index + "]";

const STYLE = `
.stp, .mp { border: 1px solid var(--line); border-radius: 12px; background: var(--paper); padding: 12px 14px; margin: 14px 0 20px; }
.stp-tabs, .mp-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.stp-tabs button, .mp-tabs button { border: 1px solid var(--line); background: #f7f8fc; border-radius: 16px; padding: 4px 11px; font: 13px var(--sans); color: var(--ink2); cursor: pointer; }
.stp-tabs button[aria-pressed=true], .mp-tabs button[aria-pressed=true] { background: var(--accent); border-color: var(--accent); color: #fff; }
.stp-idea { font-size: 14px; margin: 0 0 4px; } .stp-lesson { font-size: 13.5px; color: var(--ink2); margin: 0 0 10px; }
.stp-ctl { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; font-size: 13px; color: var(--ink2); padding: 8px 10px; background: #f7f8fc; border-radius: 8px; margin-bottom: 10px; }
.stp-ctl select, .stp-ctl input[type=number] { font: 13px var(--sans); padding: 2px 4px; border: 1px solid var(--line); border-radius: 5px; background: #fff; }
.stp-ctl input[type=number] { width: 78px; } .stp-ctl label { display: inline-flex; gap: 5px; align-items: center; }
.stp-ctl code { font-size: 12px; }
.stp-grid { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 12px; }
@media (max-width: 860px) { .stp-grid { grid-template-columns: minmax(0, 1fr); } }
.stp-prog { font: 12px/1.45 var(--mono); border: 1px solid var(--line); border-radius: 8px; max-height: 360px; overflow: auto; }
.stp-prog div { display: grid; grid-template-columns: 26px 14px minmax(0, 1fr) auto; gap: 6px; padding: 2px 8px; align-items: center; border-bottom: 1px solid #f1f3f8; }
.stp-prog div i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.stp-prog span.n { color: var(--ink3); text-align: right; } .stp-prog span.t { color: var(--ink3); font-size: 11px; white-space: nowrap; }
.stp-prog div.c { color: var(--ink3); background: #fafbfd; grid-template-columns: 1fr; }
.stp-side h6, .mp h6 { font: 600 11px var(--sans); letter-spacing: .07em; text-transform: uppercase; color: var(--ink3); margin: 6px 0 4px; }
.pool { margin: 0 0 7px; font-size: 12px; } .pool .bar { position: relative; height: 18px; background: #f1f3f8; border-radius: 4px; overflow: hidden; display: flex; }
.pool .bar b { display: flex; align-items: center; justify-content: center; font: 600 10.5px var(--sans); color: #fff; border-right: 1px solid #fff; overflow: hidden; white-space: nowrap; }
.pool .lab { display: flex; justify-content: space-between; color: var(--ink2); }
.queue { display: flex; flex-wrap: wrap; gap: 5px; min-height: 22px; }
.queue span { font: 11.5px var(--mono); background: #fde2e2; color: #8b1d1d; border-radius: 4px; padding: 1px 6px; }
.queue em { font: italic 12px var(--sans); color: var(--ink3); }
.stp-play, .mp-play { display: flex; align-items: center; gap: 8px; margin: 8px 0 4px; flex-wrap: wrap; }
.stp-play button, .mp-play button { border: 1px solid var(--line); background: #fff; border-radius: 6px; padding: 3px 9px; font: 13px var(--sans); cursor: pointer; min-width: 34px; }
.stp-play input[type=range], .mp-play input[type=range] { flex: 1 1 200px; accent-color: var(--accent); }
.stp-play .clock, .mp-play .clock { font: 600 13px var(--mono); min-width: 110px; }
.stp-log { font-size: 13px; color: var(--ink); background: #f7f8fc; border-radius: 8px; padding: 7px 10px; min-height: 44px; }
.stp-log li { margin: 1px 0; } .stp-log ul { margin: 0; padding-left: 18px; }
.stp-status { font-size: 13px; margin: 6px 0 0; } .stp-status b.bad { color: var(--red); } .stp-status b.ok { color: var(--green); }
.stp-edit textarea { width: 100%; min-height: 220px; font: 12px/1.45 var(--mono); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
.stp-edit .err { color: var(--red); font-size: 13px; margin: 4px 0; }
.stp svg text, .mp svg text { font: 10.5px var(--sans); fill: var(--ink2); }
.mp-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; margin-top: 8px; }
@media (max-width: 860px) { .mp-grid { grid-template-columns: minmax(0, 1fr); } }
.mp-list { font: 12px/1.5 var(--mono); border: 1px solid var(--line); border-radius: 8px; max-height: 300px; overflow: auto; }
.mp-list div { padding: 1px 8px; white-space: pre; color: var(--ink3); }
.mp-list div.on { background: #e0e7ff; color: var(--navy); font-weight: 600; } .mp-list div.past { color: var(--ink); }
.mp-fw { font: 11.5px/1.45 var(--mono); border: 1px solid var(--line); border-radius: 8px; max-height: 300px; overflow: auto; }
.mp-fw div { padding: 0 8px; white-space: pre; display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 6px; }
.mp-fw div.h { background: #f3f4f8; font-family: var(--sans); font-size: 11.5px; color: var(--ink2); display: block; padding: 3px 8px; white-space: normal; }
.mp-fw div.on { background: #fff3c4; } .mp-fw div span { color: var(--ink3); text-align: right; }
.mp-note { font-size: 13px; color: var(--ink2); margin: 6px 0 0; min-height: 20px; }
.mp-frame { font: 12px var(--mono); color: var(--ink2); }
.mp-3d { border-radius: 10px; overflow: hidden; background: #0b1020; min-height: 440px; }
.mp-3d .twin-stage { height: 460px; }
.mp-views { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0 10px; font-size: 12.5px; }
.mp-views button { border: 1px solid var(--line); background: #f7f8fc; border-radius: 14px; padding: 3px 10px; font: 12.5px var(--sans); cursor: pointer; }
.mp-views button[aria-pressed=true] { background: var(--navy); color: #fff; border-color: var(--navy); }
`;
function injectStyle() {
  if (document.getElementById("schedule-anim-style")) return;
  const s = document.createElement("style");
  s.id = "schedule-anim-style";
  s.textContent = STYLE;
  document.head.append(s);
}

// ── The scheduler, step by step ────────────────────────────────────────────────────────────────
export function mountStepper(root, { examples, policies }) {
  injectStyle();
  const st = { ex: 0, variant: 0, text: null, fields: {}, policy: null, strict: false, ordered: false, edit: false, error: null, result: null, times: [], at: 0, timer: null, speed: 1 };
  root.className = "stp";
  root.innerHTML = `<div class="stp-tabs" role="tablist">${examples.map((e, i) => `<button data-i="${i}" aria-pressed="${i === 0}">${esc(e.title)}</button>`).join("")}</div>
    <p class="stp-idea"></p><p class="stp-lesson"></p><div class="stp-ctl"></div><div class="stp-edit" hidden></div>
    <div class="stp-grid"><div class="stp-prog" aria-label="Statements"></div><div class="stp-side"></div></div>
    <div class="stp-gantt"></div>
    <div class="stp-play"><button data-a="first" title="Back to the start">⏮</button><button data-a="prev" title="Previous event">◀</button><button data-a="play" title="Play / pause">▶</button><button data-a="next" title="Next event">▶|</button><button data-a="last" title="To the end">⏭</button>
      <input type="range" min="0" value="0" aria-label="Event"><span class="clock"></span><select data-a="speed" title="Playback speed"><option value="0.5">slow</option><option value="1" selected>normal</option><option value="2.5">fast</option></select></div>
    <div class="stp-log" aria-live="polite"></div><p class="stp-status"></p>`;
  const $ = (s) => root.querySelector(s);

  const example = () => examples[st.ex];
  const programText = () => st.text ?? (example().variants?.[st.variant]?.text ?? example().text);

  function load(i) {
    st.ex = i; st.variant = 0; st.text = null; st.fields = {}; st.edit = false; st.error = null;
    const e = example();
    st.policy = e.options?.policy ?? "order"; st.strict = !!e.options?.strict; st.ordered = false;
    root.querySelectorAll(".stp-tabs button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.i) === i)));
    $(".stp-idea").innerHTML = "<b>" + esc(e.title) + ".</b> " + esc(e.idea);
    $(".stp-lesson").textContent = "What to watch: " + e.lesson;
    recompute();
  }

  function recompute() {
    stop();
    st.error = null;
    let program;
    try {
      program = qsysasm.parse(programText());
      if (!program.machine) throw new SyntaxError("the program needs a machine { … } line");
    } catch (error) {
      st.error = error.message; st.result = null; renderControls(); renderEdit(); render(); return;
    }
    program.machine = { ...program.machine, ...st.fields };
    const timed = program.ops.every((o) => o.start !== null);
    const mode = timed ? "triggered" : "dependency";
    const s = schedule(program, { policy: st.policy, strict: st.strict, orderedPools: st.ordered ? ["qubits"] : [], mode });
    const model = machineModel(program.machine);
    // Each request's qubits are held from its start until the release that names them starts.
    const release = new Map();
    s.ops.forEach((op, i) => {
      if (op.kind !== "request_ancilla") return;
      const names = new Set(op.qubits.map(key));
      const j = s.ops.findIndex((o, k) => k > i && o.kind === "release_ancilla" && o.qubits.some((q) => names.has(key(q))));
      release.set(i, j);
    });
    const times = new Set([0]);
    for (const o of s.sim.ops) for (const t of [o.ready, o.start, o.end]) if (t !== null && t !== undefined) times.add(t);
    if (s.sim.deadlock) times.add(s.sim.deadlock.atNs);
    st.result = { program, s, model, release, mode, timed, deadlock: s.sim.deadlock };
    st.times = [...times].sort((a, b) => a - b);
    st.at = 0;
    renderControls(); renderEdit(); render();
  }

  function renderControls() {
    const e = example(), m = st.result?.program.machine ?? qsysasm.parse(e.text).machine ?? {};
    const pol = policies.map((p) => `<option value="${p.id}" ${p.id === st.policy ? "selected" : ""} title="${esc(p.note)}">${esc(p.label)}</option>`).join("");
    const variants = e.variants ? `<label>Spelling <select data-c="variant">${e.variants.map((v, i) => `<option value="${i}" ${i === st.variant ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>` : "";
    const caps = e.controls.map((f) => `<label><code>${esc(f)}</code> <input type="number" min="0" step="1" data-f="${f}" value="${m[f] ?? ""}"></label>`).join("");
    $(".stp-ctl").innerHTML = `<label>Policy <select data-c="policy">${pol}</select></label>
      <label title="An op that cannot start blocks every later one (no backfill)"><input type="checkbox" data-c="strict" ${st.strict ? "checked" : ""}> strict order</label>
      <label title="The ancilla pool is granted in program order"><input type="checkbox" data-c="ordered" ${st.ordered ? "checked" : ""}> ancillas in program order</label>
      ${variants}${caps}<button data-c="edit" style="margin-left:auto">${st.edit ? "Close the editor" : "Edit the program"}</button>`;
  }
  function renderEdit() {
    const box = $(".stp-edit");
    box.hidden = !st.edit;
    if (!st.edit) return;
    box.innerHTML = `<textarea spellcheck="false" aria-label="QSysASM program">${esc(programText())}</textarea>
      ${st.error ? `<p class="err">${esc(st.error)}</p>` : ""}<button data-c="run">Schedule it</button> <button data-c="reset">Reset</button>
      <span class="muted">Flat QSysASM: one statement per line, concrete qubits, an optional <code>@t ns</code>. Gadgets, loops and parameters are refused.</span>`;
  }

  // The state of every statement at time t, from des.mjs's ready / start / end.
  function stateAt(o, t) {
    if (o.end !== null && o.end !== undefined && o.start !== null && (o.end < t || (o.end === t && o.start < t) || (o.end === t && o.dur === 0 && o.start <= t))) return "done";
    if (o.start !== null && o.start !== undefined && o.start <= t) return "running";
    if (o.ready !== null && o.ready !== undefined && o.ready <= t) return "waiting";
    return "blocked";
  }

  function render() {
    const R = st.result;
    if (!R) {
      $(".stp-prog").innerHTML = ""; $(".stp-side").innerHTML = ""; $(".stp-gantt").innerHTML = "";
      $(".stp-log").innerHTML = `<b style="color:var(--red)">Not a QSysASM program:</b> ${esc(st.error)}`; $(".stp-status").textContent = "";
      return;
    }
    const t = st.times[st.at] ?? 0, ops = R.s.ops, sim = R.s.sim.ops;
    const range = $(".stp-play input[type=range]");
    range.max = String(st.times.length - 1); range.value = String(st.at);
    $(".stp-play .clock").textContent = "t = " + tns(t);
    const states = sim.map((o) => stateAt({ ...o, dur: o.dur }, t));
    // Statements, with comment lines kept where the program has them.
    const lines = programText().split("\n");
    const byLine = new Map(ops.map((o, i) => [R.program.ops[i].line, i]));
    let html = "";
    lines.forEach((l, k) => {
      const i = byLine.get(k + 1);
      if (i === undefined) { if (/^\s*#/.test(l)) html += `<div class="c">${esc(l.trim())}</div>`; return; }
      const [bg, fg, label] = STATE[states[i]], o = sim[i];
      const when = o.start !== null && o.start <= t ? tns(o.start) + (o.end > o.start ? "–" + tns(o.end) : "") : states[i] === "waiting" ? "waits for " + (o.waitedFor ?? "its turn") : "";
      html += `<div style="background:${states[i] === "running" ? bg : states[i] === "waiting" ? "#fff5f5" : ""}"><span class="n">${i + 1}</span><i title="${label}" style="background:${fg}"></i><span>${esc(strip(lines[k]))}</span><span class="t">${esc(when)}</span></div>`;
    });
    $(".stp-prog").innerHTML = html;
    // Services: who holds what at t.
    const holders = {};
    sim.forEach((o, i) => {
      const op = ops[i];
      if (states[i] === "running") for (const [p, a] of R.model.needs(op, Math.max(1, op.duration))) if (a > 0 && !(op.kind === "request_ancilla" && p === "qubits")) (holders[p] ??= []).push([i, a]);
      if (op.kind === "request_ancilla" && o.start !== null && o.start <= t) {
        const j = R.release.get(i), rel = j >= 0 ? sim[j] : null;
        if (!rel || rel.start === null || rel.start > t) (holders.qubits ??= []).push([i, op.arg ?? op.qubits.length]);
      }
    });
    const used = new Set(ops.flatMap((op) => R.model.needs(op, Math.max(1, op.duration)).filter(([, a]) => a > 0).map(([p]) => p)));
    const pools = Object.entries(R.model.pools).filter(([p, c]) => used.has(p) && c !== undefined);
    const poolHtml = pools.map(([p, cap]) => {
      const hs = holders[p] ?? [], sum = hs.reduce((s, [, a]) => s + a, 0);
      const segs = hs.map(([i, a]) => `<b style="width:${(100 * a) / Math.max(cap, 1e-9)}%;background:${KIND_COLOR(ops[i].kind)}" title="statement ${i + 1}: ${esc(strip(ops[i].text))} holds ${a}">${i + 1}</b>`).join("");
      return `<div class="pool"><div class="lab"><span>${esc(POOL_LABEL[p] ?? p)}</span><span>${num(sum)} / ${num(cap)}${FIELD_OF_POOL[p] ? "" : ""}</span></div><div class="bar">${segs}</div></div>`;
    }).join("");
    const keyOf = (i) => (st.policy === "fifo" ? sim[i].ready : st.policy === "deadline" ? (R.program.ops[i].start ?? 0) : i);
    const waiting = sim.map((_, i) => i).filter((i) => states[i] === "waiting").sort((a, b) => keyOf(a) - keyOf(b) || a - b);
    const queue = waiting.length ? waiting.map((i) => `<span title="${esc(strip(ops[i].text))}">#${i + 1} ${esc(ops[i].kind)} ⟵ ${esc(sim[i].waitedFor ?? "turn")}</span>`).join("") : "<em>empty</em>";
    $(".stp-side").innerHTML = (ops.length <= 16 ? `<h6>Dependencies</h6>${dagSvg(ops, R.s.edges, states)}` : "") + `<h6>Services <span style="text-transform:none">at ${esc(tns(t))}</span></h6>${poolHtml || '<em class="muted">this program holds no shared service</em>'}<h6>Ready queue, in the policy's order</h6><div class="queue">${queue}</div>`;
    $(".stp-gantt").innerHTML = ganttSvg(ops, sim, t, st.times.at(-1));
    // What happens at t.
    const ev = [];
    sim.forEach((o, i) => {
      const name = `<b>#${i + 1}</b> <code>${esc(strip(ops[i].text))}</code>`;
      if (o.start === t) ev.push(name + " starts" + (o.waitNs > 0 ? ` after waiting ${tns(o.waitNs)} for <b>${esc(o.waitedFor ?? "its turn")}</b>` : "") + ".");
      if (o.end === t && o.start !== null && o.start < t) ev.push(name + " ends" + (ops[i].kind === "measure" ? ": its record is written" : ops[i].kind === "decode_syndrome" ? ": the syndrome is decoded" : "") + ".");
      if (o.ready === t && (o.start === null || o.start > t)) ev.push(name + " is ready but must wait for <b>" + esc(o.waitedFor ?? "its turn") + "</b>.");
    });
    if (R.deadlock && t >= R.deadlock.atNs) ev.push(`<b style="color:var(--red)">Deadlock.</b> Nothing is running and nothing can start: ${R.deadlock.blocked.map((b) => "#" + (b.uid + 1) + " waits for " + esc(b.waitingFor)).join(", ")}.`);
    $(".stp-log").innerHTML = ev.length ? `<ul>${ev.map((e) => `<li>${e}</li>`).join("")}</ul>` : `<span class="muted">${st.at === 0 ? "Press ▶ to play, or ▶| to step from one event to the next." : "Nothing starts or ends at this moment."}</span>`;
    const s = R.s.sim;
    $(".stp-status").innerHTML = R.deadlock ? `<b class="bad">Deadlock at ${tns(R.deadlock.atNs)}</b>: ${s.completed} of ${s.total} statements finished.`
      : `<b class="ok">Makespan ${tns(s.makespanNs)}</b> · ${s.total} statements · ${R.mode === "triggered" ? "each statement no earlier than its @ time" : "each statement as soon as its dependencies and services allow"}` +
        (s.starved.length ? ` · statement ${s.starved.map((x) => "#" + (x.uid + 1)).join(", ")} was passed ${s.starved.map((x) => x.bypassed).join(", ")} times` : "");
  }

  function dagSvg(ops, edges, states) {
    const n = ops.length, layer = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (const e of edges) if (e.to === i) layer[i] = Math.max(layer[i], layer[e.from] + 1);
    const L = Math.max(0, ...layer) + 1, by = Array.from({ length: L }, () => []);
    ops.forEach((_, i) => by[layer[i]].push(i));
    const W = 400, rowH = 26, h = L * rowH + 8, pos = new Map();
    by.forEach((ids, l) => ids.forEach((id, k) => pos.set(id, [W / 2 + (k - (ids.length - 1) / 2) * Math.min(64, (W - 40) / Math.max(1, ids.length)), 14 + l * rowH])));
    let s = `<svg viewBox="0 0 ${W} ${h}" width="100%" role="img">`;
    for (const e of edges) {
      const [x1, y1] = pos.get(e.from), [x2, y2] = pos.get(e.to);
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${e.why.startsWith("decoded") ? "#c62828" : e.why.startsWith("record") ? "#c4622d" : "#c7ccd8"}" stroke-width="1.1"><title>${esc(e.why)}</title></line>`;
    }
    ops.forEach((op, i) => {
      const [x, y] = pos.get(i), [bg, fg] = STATE[states[i]];
      s += `<circle cx="${x}" cy="${y}" r="10" fill="${bg}" stroke="${fg}" stroke-width="${states[i] === "running" ? 2.5 : 1.2}"><title>#${i + 1} ${esc(strip(op.text))}</title></circle><text x="${x}" y="${y + 3.5}" text-anchor="middle" style="font-weight:600;fill:${fg}">${i + 1}</text>`;
    });
    return s + "</svg>";
  }

  function ganttSvg(ops, sim, t, end) {
    const W = 860, lab = 34, rowH = ops.length > 20 ? 11 : 16, h = ops.length * rowH + 26, span = Math.max(1, end), x = (v) => lab + (v / span) * (W - lab - 12);
    let s = `<svg viewBox="0 0 ${W} ${h}" width="100%" role="img" aria-label="Timeline">`;
    const step = nice(span / 6);
    for (let v = 0; v <= span; v += step) s += `<line x1="${x(v)}" x2="${x(v)}" y1="0" y2="${h - 18}" stroke="#eef0f5"/><text x="${x(v)}" y="${h - 5}" text-anchor="middle">${tns(v)}</text>`;
    sim.forEach((o, i) => {
      const y = i * rowH + 2;
      s += `<text x="${lab - 5}" y="${y + rowH / 2 + 3}" text-anchor="end">${i + 1}</text>`;
      if (o.ready !== null && o.ready <= t) {
        const w0 = o.ready, w1 = Math.min(o.start ?? t, t);
        if (w1 > w0) s += `<rect x="${x(w0)}" y="${y + 2}" width="${x(w1) - x(w0)}" height="${rowH - 5}" fill="#fde2e2" stroke="#e9a0a0" stroke-dasharray="2 2"><title>#${i + 1} waits for ${esc(o.waitedFor ?? "its turn")}</title></rect>`;
      }
      if (o.start !== null && o.start <= t) {
        const e1 = Math.min(o.end ?? t, t);
        s += `<rect x="${x(o.start)}" y="${y + 1}" width="${Math.max(2, x(e1) - x(o.start))}" height="${rowH - 3}" rx="2" fill="${KIND_COLOR(ops[i].kind)}"><title>#${i + 1} ${esc(strip(ops[i].text))}: ${o.start}–${o.end} ns</title></rect>`;
      }
    });
    s += `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${h - 18}" stroke="#111827" stroke-width="1.5"/>`;
    return s + "</svg>";
  }

  function stop() { if (st.timer) clearTimeout(st.timer); st.timer = null; const b = root.querySelector('[data-a="play"]'); if (b) b.textContent = "▶"; }
  function tick() {
    if (st.at >= st.times.length - 1) { stop(); return; }
    st.at++; render();
    st.timer = setTimeout(tick, 900 / st.speed);
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.i !== undefined) return load(Number(b.dataset.i));
    const a = b.dataset.a, c = b.dataset.c;
    if (a === "play") { if (st.timer) stop(); else { if (st.at >= st.times.length - 1) st.at = 0; b.textContent = "⏸"; tick(); } return; }
    if (a) { stop(); st.at = a === "first" ? 0 : a === "last" ? st.times.length - 1 : Math.max(0, Math.min(st.times.length - 1, st.at + (a === "next" ? 1 : -1))); render(); return; }
    if (c === "edit") { st.edit = !st.edit; renderControls(); renderEdit(); }
    if (c === "run") { st.text = root.querySelector(".stp-edit textarea").value; st.fields = {}; recompute(); }
    if (c === "reset") { st.text = null; st.fields = {}; recompute(); }
  });
  root.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.c === "policy") st.policy = el.value;
    else if (el.dataset.c === "strict") st.strict = el.checked;
    else if (el.dataset.c === "ordered") st.ordered = el.checked;
    else if (el.dataset.c === "variant") { st.variant = Number(el.value); st.text = null; }
    else if (el.dataset.f) { const v = Number(el.value); if (Number.isFinite(v) && v >= 0) st.fields[el.dataset.f] = v; }
    else if (el.dataset.a === "speed") { st.speed = Number(el.value); return; }
    else return;
    recompute();
  });
  root.querySelector(".stp-play input[type=range]").addEventListener("input", (e) => { stop(); st.at = Number(e.target.value); render(); });
  load(0);
  return { load };
}
function nice(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9))), m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

// ── The machine, cycle by cycle ────────────────────────────────────────────────────────────────
const CH_COLOR = { gate: "#4338ca", ro: "#c4622d", demod: "#d59a00" };
const chColor = (ch) => CH_COLOR[ch] ?? (/^cz/.test(ch) ? "#7c3aed" : "#586174");
const PUBLISH_NS = 76; // a bit's store at its core → readable at another core of the board (riscq/ftqvm/decoder.mjs)

export function mountMachine(root, runs) {
  injectStyle();
  const st = { run: 0, t: 0, playing: false, last: 0, speed: 1, core: null };
  root.className = "mp";
  root.innerHTML = `<div class="mp-tabs">${runs.map((r, i) => `<button data-r="${i}" aria-pressed="${i === 0}">${esc(r.title)}</button>`).join("")}</div>
    <p class="stp-lesson mp-idea"></p>
    <h6>The hardware in 3D, as the trace drives it: the whole machine with each core lit while it plays a pulse, and the chip with each operation lighting its qubits</h6>
    <div class="mp-3d"></div>
    <div class="mp-views"><button data-v="all" aria-pressed="true">Whole machine</button><button data-v="device">Chip</button><button data-v="control">Control system</button>
      <span class="muted">Drag to turn, scroll to zoom, hover a part to name it.</span></div>
    <h6>The same moment as a diagram</h6><div class="mp-chip"></div>
    <div class="mp-play"><button data-a="play">▶</button><button data-a="back" title="Back 20 ns">−20 ns</button><button data-a="fwd" title="Forward 20 ns">+20 ns</button>
      <input type="range" min="0" step="2" value="0" aria-label="Time"><span class="clock"></span>
      <select data-a="speed" title="Playback speed"><option value="0.25">¼ µs per s</option><option value="0.5" selected>½ µs per s</option><option value="1">1 µs per s</option></select></div>
    <p class="mp-note"></p>
    <div class="mp-grid"><div><h6>The timetable (QSysASM), statements running now highlighted</h6><div class="mp-list"></div></div>
      <div><h6 class="mp-fwh">Firmware</h6><div class="mp-fw"></div></div></div>`;
  const $ = (s) => root.querySelector(s);

  function load(i) {
    st.run = i; st.t = 0; st.core = null;
    root.querySelectorAll(".mp-tabs button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.r) === i)));
    const R = runs[i], F = R.final;
    $(".mp-idea").textContent = R.idea + " Click a core to read its firmware.";
    $(".mp-play input").max = String(F.makespanNs);
    // Default core: the first control core with pulses.
    const busiest = F.cores.filter((c) => c.role === "control").map((c) => [c.name, F.pulses.filter((p) => p.core === c.name).length]).sort((a, b) => b[1] - a[1])[0];
    st.core = busiest?.[0];
    // Geometry: sites on a lattice, cores in a row above their transmons, the hub and the classical cores to the right.
    const sites = F.sites, rcs = sites.map((s) => s.rc);
    const c0 = Math.min(...rcs.map((r) => r[1])), c1 = Math.max(...rcs.map((r) => r[1])), r0 = Math.min(...rcs.map((r) => r[0])), r1 = Math.max(...rcs.map((r) => r[0]));
    const W = 860, left = 70, chipW = 520, pitch = Math.min(130, chipW / Math.max(1, c1 - c0 + 0.5));
    const sx = (c) => left + 40 + (c - c0) * pitch, sy = (r) => 250 + (r - r0) * 70;
    const H = sy(r1) + 70;
    const ctl = F.cores.filter((c) => c.drives);
    const siteIdx = (addr) => sites.findIndex((s) => s.address === addr);
    const corePos = new Map(ctl.map((c, k) => [c.name, [left + 10 + k * Math.min(96, chipW / Math.max(1, ctl.length)), 60]]));
    const hub = [W - 220, 130], frameCore = F.cores.find((c) => c.role === "frame and decoder")?.name, decCores = F.cores.filter((c) => c.role === "decoder").map((c) => c.name);
    corePos.set(frameCore, [W - 150, 60]);
    decCores.forEach((n, k) => corePos.set(n, [W - 150, 200 + k * 54]));
    st.geo = { sx, sy, W, H, corePos, hub, siteIdx, frameCore, decCores };
    mountTwin3d(F);
    $(".mp-list").innerHTML = F.text.split("\n").filter((l) => /^@/.test(l)).map((l, k) => `<div data-k="${k}">${esc(l)}</div>`).join("");
    draw(); renderFw();
  }

  // The 3D twin (studio/reproduce/twin3d.js), driven by this player's clock: external mode, no controls of its own.
  async function mountTwin3d(F) {
    st.twin?.dispose();
    st.twin = null;
    const box = $(".mp-3d");
    if (!F.track) { box.innerHTML = '<p class="muted">No 3D track was recorded for this run.</p>'; return; }
    try {
      const { mountTwin } = await import("/reproduce/twin3d.js");
      st.twin = mountTwin(box, F.track, { external: true });
      st.twin.setView(st.view ?? "all");
      st.twin.setTime(st.t);
    } catch (error) {
      box.innerHTML = `<p class="muted">The 3D view could not start here (${esc(error.message)}); the diagram below shows the same run.</p>`;
    }
  }

  function renderFw() {
    const F = runs[st.run].final, fw = F.firmware.find((f) => f.core === st.core);
    $(".mp-fwh").textContent = "Firmware of core " + (st.core ?? "–") + (fw ? " · " + fw.words + " words" : "");
    if (!fw) { $(".mp-fw").innerHTML = ""; return; }
    let last = null, html = "";
    fw.rows.forEach((r, k) => {
      if (r[3] !== last) {
        const s = r[4] !== null && r[4] !== undefined ? F.statements.find((x) => x.uid === r[4]) : null;
        html += `<div class="h" data-g="${esc(r[3])}">${s ? "statement " + (s.uid + 1) + " · " + esc(strip(s.text)) : esc(r[3] || "issue loop")}</div>`;
        last = r[3];
      }
      html += `<div data-g="${esc(r[3])}" title="${esc(r[5] ?? "")}"><span>${r[0]}</span>${esc(r[2])}</div>`;
    });
    $(".mp-fw").innerHTML = html;
  }

  function draw() {
    const R = runs[st.run], F = R.final, g = st.geo, t = st.t;
    st.twin?.setTime(t);
    $(".mp-play .clock").textContent = "t = " + num(t) + " ns";
    $(".mp-play input").value = String(t);
    const active = F.pulses.filter((p) => p.opens <= t && t < p.closes);
    const job = F.decodes?.[0]?.jobs?.[0];
    let s = `<svg viewBox="0 0 ${g.W} ${g.H}" width="100%" role="img" aria-label="The chip and its control cores">`;
    // The board.
    s += `<rect x="40" y="28" width="${g.W - 60}" height="${Math.max(...[...g.corePos.values()].map((p) => p[1])) + 52}" rx="10" fill="#f7f8fc" stroke="#dde1ea"/><text x="52" y="44">RISC-Q board · ${num(1000 / F.periodNs)} MHz</text>`;
    s += `<rect x="${g.hub[0] - 50}" y="${g.hub[1] - 16}" width="100" height="32" rx="6" fill="#fff" stroke="#9aa3b5"/><text x="${g.hub[0]}" y="${g.hub[1] + 4}" text-anchor="middle">board hub</text>`;
    // Couplers.
    (F.couplers ?? []).forEach((pair, k) => {
      const [a, b] = pair.map((i) => F.sites[i]);
      const on = active.some((p) => p.coupler === k);
      s += `<line x1="${g.sx(a.rc[1])}" y1="${g.sy(a.rc[0])}" x2="${g.sx(b.rc[1])}" y2="${g.sy(b.rc[0])}" stroke="${on ? "#7c3aed" : "#c7ccd8"}" stroke-width="${on ? 6 : 2.5}" stroke-linecap="round"><title>coupler ${a.address} – ${b.address}</title></line>`;
    });
    // Cores, coax to their transmons, and the transmons.
    for (const c of F.cores) {
      const [x, y] = g.corePos.get(c.name) ?? [0, 0];
      const mine = active.filter((p) => p.core === c.name);
      const site = c.drives ? g.siteIdx(c.drives) : -1;
      if (site >= 0) {
        const S = F.sites[site], col = mine.length ? chColor(mine[0].channel) : "#c7ccd8";
        s += `<path d="M${x + 36} ${y + 34} C ${x + 36} ${y + 120}, ${g.sx(S.rc[1])} ${g.sy(S.rc[0]) - 90}, ${g.sx(S.rc[1])} ${g.sy(S.rc[0]) - 17}" fill="none" stroke="${col}" stroke-width="${mine.length ? 3 : 1.2}"/>`;
      }
      const busy = mine.length || (job && c.name === g.decCores[job.core ?? 0] && t >= job.startNs && t < job.endNs);
      const sel = c.name === st.core;
      s += `<g data-core="${esc(c.name)}" style="cursor:pointer"><rect x="${x}" y="${y}" width="72" height="34" rx="6" fill="${busy ? "#fff7d6" : "#fff"}" stroke="${sel ? "#111827" : busy ? "#d59a00" : "#9aa3b5"}" stroke-width="${sel ? 2 : 1}"/>
        <text x="${x + 36}" y="${y + 14}" text-anchor="middle" style="font-weight:600;fill:#111827">${esc(c.name)}</text><text x="${x + 36}" y="${y + 27}" text-anchor="middle">${esc(mine.map((p) => p.channel).join(" ") || c.role.replace("frame and decoder", "frame"))}</text></g>`;
    }
    F.sites.forEach((S) => {
      const x = g.sx(S.rc[1]), y = g.sy(S.rc[0]);
      const p = active.filter((q) => F.cores.find((c) => c.name === q.core)?.drives === S.address);
      const col = p.length ? chColor(p[0].channel) : S.kind === "data" ? "#26324a" : "#8a9a9c";
      s += `<circle cx="${x}" cy="${y}" r="${p.length ? 17 : 14}" fill="${p.length ? col : "#fff"}" stroke="${col}" stroke-width="2.5"/><text x="${x}" y="${y + 32}" text-anchor="middle" style="font-family:var(--mono)">${esc(S.address ?? S.id)}</text>`;
    });
    // Bits: from each control core's store to the hub, then to the decoder.
    const decName = g.decCores[0];
    for (const w of F.stores.filter((w) => w.core !== g.frameCore)) {
      const from = g.corePos.get(w.core), to = job ? g.corePos.get(decName) : g.hub;
      if (!from) continue;
      const t0 = w.atNs, t1 = w.atNs + PUBLISH_NS, t2 = job ? Math.max(t1, job.readyNs) : t1;
      if (t < t0 || t > t2 + 40) continue;
      let px, py;
      if (t <= t1) { const f = (t - t0) / PUBLISH_NS; px = from[0] + 36 + (g.hub[0] - from[0] - 36) * f; py = from[1] + 17 + (g.hub[1] - from[1] - 17) * f; }
      else { const f = Math.min(1, (t - t1) / Math.max(1, t2 - t1)); px = g.hub[0] + ((to?.[0] ?? g.hub[0]) - 6 - g.hub[0]) * f; py = g.hub[1] + ((to?.[1] ?? g.hub[1]) + 17 - g.hub[1]) * f; }
      s += `<circle cx="${px}" cy="${py}" r="6" fill="#c4622d" stroke="#fff" stroke-width="1.5"><title>measured bit ${w.value}</title></circle><text x="${px + 9}" y="${py - 7}" style="fill:#c4622d;font-weight:600">${w.value}</text>`;
    }
    // Frame words written so far.
    const frameStores = F.stores.filter((w) => w.core === g.frameCore && w.atNs <= t);
    const fu = F.statements.find((x) => x.kind === "pauli_frame_update");
    if (fu) {
      const [x, y] = g.corePos.get(g.frameCore);
      s += `<text x="${x - 8}" y="${y + 52}" class="mp-frame">frame words written: ${frameStores.length} of ${F.stores.filter((w) => w.core === g.frameCore).length}</text>`;
    }
    $(".mp-chip").innerHTML = s + "</svg>";
    // Statements running now.
    const on = new Set(F.statements.filter((x) => x.start <= t && t < Math.max(x.end, x.start + 1)).map((x) => x.uid));
    const order = [...F.statements].sort((a, b) => a.start - b.start || a.uid - b.uid);
    root.querySelectorAll(".mp-list div").forEach((d, k) => { const x = order[k]; d.className = x && on.has(x.uid) ? "on" : x && x.end <= t ? "past" : ""; });
    // What is happening, in words.
    const words = [];
    for (const p of active) words.push(`<b>${esc(p.core)}</b>.${esc(p.channel)} plays (${p.opens}–${p.closes} ns)`);
    if (job && t >= job.startNs && t < job.endNs) words.push(`<b>decoder core</b> looks up the correction (${job.startNs}–${job.endNs} ns)`);
    const fresh = F.stores.filter((w) => w.atNs <= t && t < w.atNs + 30);
    for (const w of fresh) words.push(`<b>${esc(w.core)}</b> stores ${w.core === g.frameCore ? "a frame word" : "a measured bit (" + w.value + ")"}`);
    $(".mp-note").innerHTML = words.length ? words.join(" · ") : `<span class="muted">${t === 0 ? "Press ▶: about half a microsecond of the machine per second." : "No pulse is playing: the cores are waiting for their next issue time."}</span>`;
    // Firmware: the code of the latest native operation on the selected core.
    const fw = F.firmware.find((f) => f.core === st.core);
    if (fw) {
      const groups = [...new Set(fw.rows.map((r) => r[3]).filter((l) => /^h\d+$/.test(l)))];
      const timeOf = (lab) => { const n = F.natives.find((x) => x.id === lab); if (n) return n.t; const r = fw.rows.find((x) => x[3] === lab); const sx = F.statements.find((x) => x.uid === r?.[4]); return sx ? sx.start : Infinity; };
      let cur = null;
      for (const lab of groups) if (timeOf(lab) <= t && (cur === null || timeOf(lab) >= timeOf(cur))) cur = lab;
      const box = $(".mp-fw");
      let first = null;
      box.querySelectorAll("div").forEach((d) => { const onNow = cur && d.dataset.g === cur; d.classList.toggle("on", onNow && !d.classList.contains("h")); if (onNow && !first) first = d; });
      if (first && st.playing) box.scrollTop = first.offsetTop - box.offsetTop - 30;
    }
  }

  function frame(now) {
    if (!st.playing) return;
    const dt = Math.min(100, now - (st.last || now));
    st.last = now;
    const F = runs[st.run].final;
    st.t = Math.min(F.makespanNs, st.t + (dt / 1000) * 1000 * st.speed);
    st.t = Math.round(st.t / 2) * 2;
    draw();
    if (st.t >= F.makespanNs) { st.playing = false; $('[data-a="play"]').textContent = "▶"; return; }
    requestAnimationFrame(frame);
  }
  root.addEventListener("click", (e) => {
    const v = e.target.closest("[data-v]");
    if (v) { st.view = v.dataset.v; st.twin?.setView(st.view); root.querySelectorAll(".mp-views button").forEach((b) => b.setAttribute("aria-pressed", String(b === v))); return; }
    const core = e.target.closest("[data-core]");
    if (core) { st.core = core.dataset.core; renderFw(); draw(); return; }
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.r !== undefined) { st.playing = false; $('[data-a="play"]').textContent = "▶"; return load(Number(b.dataset.r)); }
    const F = runs[st.run].final;
    if (b.dataset.a === "play") {
      st.playing = !st.playing; b.textContent = st.playing ? "⏸" : "▶";
      if (st.playing) { if (st.t >= F.makespanNs) st.t = 0; st.last = 0; requestAnimationFrame(frame); }
    }
    if (b.dataset.a === "back" || b.dataset.a === "fwd") { st.t = Math.max(0, Math.min(F.makespanNs, st.t + (b.dataset.a === "fwd" ? 20 : -20))); draw(); }
  });
  root.addEventListener("change", (e) => { if (e.target.dataset.a === "speed") st.speed = Number(e.target.value); });
  root.querySelector(".mp-play input").addEventListener("input", (e) => { st.t = Number(e.target.value); draw(); });
  load(0);
}
