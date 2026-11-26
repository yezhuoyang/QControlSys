// /schedule: Schedule and Compilation. Everything on the page is drawn from validation/os/schedule.json,
// which riscq/os/schedule-study.mjs computes: QSysASM programs scheduled by the operating system
// (riscq/os/schedule.mjs, riscq/os/des.mjs) and run on a generated transmon chip in the cycle-exact
// Lean model of RISC-Q (riscq/ftqvm/sc-run.mjs). This file only lays the numbers out.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const num = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? "–" : Number(x).toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d }));
const us = (ns, d = 2) => (ns === null || ns === undefined ? "–" : num(ns / 1000, d) + " µs");
const ns = (x) => (x === null || x === undefined ? "–" : num(x) + " ns");
const code = (s) => `<code>${esc(s)}</code>`;
const statementsOf = (text) => text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).filter((l) => !/^(machine|factory)\s*\{/.test(l));
const strip = (s) => String(s ?? "").replace(/^@\d+\s*ns\s+/, "").replace(/\s{2,}/g, " ");

function table(head, rows, { numeric = [], cls = "" } = {}) {
  const th = head.map((h, i) => `<th${numeric.includes(i) ? ' class="n"' : ""}>${h}</th>`).join("");
  const body = rows.map((r) => "<tr>" + r.map((c, i) => `<td${numeric.includes(i) ? ' class="n"' : ""}>${c}</td>`).join("") + "</tr>").join("");
  return `<div class="tbl ${cls}"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const COLOR = { gate: "#4338ca", cz: "#7c3aed", reset: "#1baf7a", measure: "#c4622d", demod: "#d59a00", decode: "#c62828", frame: "#0e7490", route: "#8a9a9c", wait: "#f3c6c6", window: "#e6e9f2", other: "#586174" };
const kindColor = (k) => (["H", "S", "Sdg", "X", "Z", "CNOT", "CZ", "CY"].includes(k) ? COLOR.gate : k === "request_ancilla" ? COLOR.reset : k === "measure" ? COLOR.measure : k === "decode_syndrome" ? COLOR.decode
  : k === "pauli_frame_update" || k === "parity" ? COLOR.frame : k === "route" || k === "release_ancilla" ? COLOR.route : COLOR.other);

/** A timeline: rows of labelled bars. rows: [{ label, bars: [{ t0, t1, color, title, outline, tick }] }]. */
function gantt(rows, { t0 = 0, t1, width = 820, rowH = 20, labelW = 210, unit = "ns", note } = {}) {
  const end = t1 ?? Math.max(1, ...rows.flatMap((r) => r.bars.map((b) => b.t1 ?? b.t0)));
  const plot = width - labelW - 10, x = (t) => labelW + ((t - t0) / (end - t0)) * plot;
  const h = rows.length * rowH + 30;
  const step = niceStep((end - t0) / 6);
  let s = `<svg viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" role="img">`;
  for (let t = Math.ceil(t0 / step) * step; t <= end; t += step)
    s += `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${h - 22}" stroke="#eef0f5"/><text x="${x(t)}" y="${h - 8}" text-anchor="middle">${t >= 1000 && unit === "ns" ? num(t / 1000, t % 1000 ? 1 : 0) + " µs" : num(t) + " " + unit}</text>`;
  rows.forEach((r, i) => {
    const y = i * rowH + 3;
    s += `<text class="mono" x="${labelW - 6}" y="${y + rowH / 2 + 1}" text-anchor="end" dominant-baseline="middle">${esc(r.label)}</text>`;
    for (const b of r.bars) {
      if (b.tick) { s += `<line x1="${x(b.t0)}" x2="${x(b.t0)}" y1="${y}" y2="${y + rowH - 6}" stroke="${b.color}" stroke-width="2"><title>${esc(b.title ?? "")}</title></line>`; continue; }
      const w = Math.max(1.5, x(b.t1) - x(b.t0));
      s += `<rect x="${x(b.t0)}" y="${y + (b.thin ? 5 : 0)}" width="${w}" height="${rowH - 6 - (b.thin ? 10 : 0)}" rx="2" fill="${b.color}" ${b.outline ? `fill-opacity=".18" stroke="${b.color}" stroke-dasharray="3 2"` : ""}><title>${esc(b.title ?? "")}</title></rect>`;
    }
  });
  return s + "</svg>" + (note ? `<figcaption>${note}</figcaption>` : "");
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9))), m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** The dependency graph, layered by longest path from a source. */
function dag(statements, edges, { width = 820 } = {}) {
  const n = statements.length, layer = Array(n).fill(0);
  for (let i = 0; i < n; i++) for (const e of edges.filter((e) => e.to === i)) layer[i] = Math.max(layer[i], layer[e.from] + 1);
  const layers = Math.max(...layer) + 1, byLayer = Array.from({ length: layers }, () => []);
  statements.forEach((s, i) => byLayer[layer[i]].push(i));
  // Layers run top to bottom; the statements of one layer sit side by side.
  const rowH = 46, boxW = 290, boxH = 24, perRow = Math.max(...byLayer.map((l) => l.length)), h = layers * rowH + 10;
  const pos = new Map();
  byLayer.forEach((ids, L) => ids.forEach((id, k) => pos.set(id, [width / 2 + (k - (ids.length - 1) / 2) * (boxW + 40), 20 + L * rowH])));
  void perRow;
  let s = `<svg viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" role="img"><defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="#9aa3b5"/></marker></defs>`;
  for (const e of edges) {
    const [x1, y1] = pos.get(e.from), [x2, y2] = pos.get(e.to);
    const c = e.why.startsWith("decoded") ? COLOR.decode : e.why.startsWith("record") ? COLOR.measure : "#9aa3b5";
    // An edge that skips layers bends out to the side so it does not cross the boxes between.
    const skip = layer[e.to] - layer[e.from] > 1, side = x2 >= width / 2 ? 1 : -1, bend = skip ? side * (boxW / 2 + 24 + 6 * (layer[e.to] - layer[e.from])) : 0;
    s += `<path d="M${x1} ${y1 + boxH / 2} C ${x1 + bend} ${y1 + boxH / 2 + 30}, ${x2 + bend} ${y2 - boxH / 2 - 30}, ${x2} ${y2 - boxH / 2 - 2}" fill="none" stroke="${c}" stroke-width="1.2" marker-end="url(#ah)"><title>${esc(e.why)}</title></path>`;
  }
  statements.forEach((st, i) => {
    const [x, y] = pos.get(i);
    const kind = st.kind ?? statementKind(st.text);
    s += `<rect x="${x - boxW / 2}" y="${y - boxH / 2}" width="${boxW}" height="${boxH}" rx="5" fill="#fff" stroke="${kindColor(kind)}"/><text x="${x}" y="${y + 1}" text-anchor="middle" dominant-baseline="middle" style="font:11px var(--mono);fill:${kindColor(kind)}">${i + 1} · ${esc(strip(st.text).replace(/basis=Z\s*/, "").replace(/rounds=\d+\s*/, "").slice(0, 42))}</text>`;
  });
  return s + "</svg>";
}
const statementKind = (t) => /(?:->\s*)?(\w+)/.exec(strip(t).replace(/^[^ ]*\[[^\]]*\]\s*->\s*/, ""))?.[1];
const shortOf = (t) => strip(t).replace(/basis=Z\s*/, "").replace(/count=\d+\s*/, "").replace(/rounds=\d+\s*/, "").slice(0, 26);

// ---------------------------------------------------------------------------------------------
export async function render(root, toc) {
  let D;
  try {
    D = await (await fetch("/os/schedule.json")).json();
  } catch (error) {
    root.innerHTML = `<p class="no">Could not load the page's data (/os/schedule.json): ${esc(error.message)}</p>`;
    return;
  }
  const R = D.round, F = R.final, P = D.problems, C = D.calibration;
  const sections = [];
  const h2 = (id, n, title) => { sections.push([id, n + " " + title, 2]); return `<h2 id="${id}"><span class="num">${n}</span>${title}</h2>`; };
  const h3 = (id, title) => { sections.push([id, title, 3]); return `<h3 id="${id}">${title}</h3>`; };

  const st = [...F.statements].sort((a, b) => a.uid - b.uid);
  const row = (uid) => F.rows.find((r) => r.uid === uid);
  const meas = st.filter((s) => s.kind === "measure");
  const dec = F.decodes[0], job = dec?.jobs?.[0];
  const frame = st.find((s) => s.kind === "pauli_frame_update");
  const it0 = R.iterations[0], itN = R.iterations.at(-1);
  const fields = [...new Set([...Object.keys(it0.needed), ...R.iterations.flatMap((i) => Object.keys(i.raise))])].sort();
  const bench = (kind) => C.microbenchmarks.filter((b) => b.kind === kind);
  const benchRate = (kind) => bench(kind).at(-1);

  let html = `
  <p class="kicker">The operating system</p>
  <h1>Schedule and Compilation</h1>
  <p class="lead">A program at the Fault-Tolerant Quantum Execution Interface says what to do to which physical qubits and
  which shared services it needs. The operating system decides <em>when</em>: it turns the program into a timetable, and the
  timetable into firmware for RISC-Q's control cores. This page follows one small program through every step, explains why
  scheduling is hard, and measures what each system call costs.</p>
  <p class="muted">Every number below is computed by <code>riscq/os/schedule-study.mjs</code> (data: <a href="/os/schedule.json">/os/schedule.json</a>,
  generated ${esc(D.generated?.slice(0, 10))}). The programs run on the cycle-exact Lean model of RISC-Q, checked against RISC-Q's RTL
  cycle for cycle. They are properties of that model, not of laboratory hardware. No quantum state is simulated; measurement
  outcomes are inputs.</p>`;

  // 1 ── Design ───────────────────────────────────────────────────────────────────────────────
  html += h2("design", "1", "How the operating system is designed");
  html += `<p>The interface is built around one question: <span class="q">what should a fault-tolerant quantum program specify, and what
  should it delegate to the operating system?</span> QuantumOS answers it this way. A program specifies its <b>physical instructions</b>
  on named physical qubits: the gates and measurements of its circuits. It delegates everything that is <b>shared</b>, through
  <b>system calls</b>: fresh ancilla qubits, routes between qubits, magic states from a factory, decoding, and the Pauli frame.
  A program in QSysASM is flat: one statement per operation, concrete qubits, no gadgets, loops or parameters.</p>`;
  html += h3("services", "Every statement holds a service");
  html += `<p>The machine line declares, for every kind of statement, how long it takes and how much of a shared service exists.
  A statement holds its service while it runs. Moving N items in D ns reserves the rate r(N, D) = ⌈1000·N / D⌉ items per µs.</p>`;
  html += table(["Statement", "What it holds while it runs", "Latency (machine field)", "Capacity (machine field)"], [
    [code("H S Sdg X Z"), "one gate slot", code("gate1q_ns"), code("max_parallel_gates")],
    [code("CNOT CZ CY"), "one gate slot", code("gate2q_ns"), code("max_parallel_gates")],
    [code("measure q -> c[i]"), "r(1, D) of the classical bandwidth", code("measure_ns"), code("classical_data_bandwidth") + " bits/µs"],
    [code("request_ancilla count=N"), "N qubits <b>until their release</b>, and r(N, D) of the ancilla bandwidth", code("reset_ns"), code("qubits") + ", " + code("ancilla_bandwidth")],
    [code("release_ancilla"), "nothing: the qubits return to the pool", "0", "–"],
    [code("route q…"), "r(n, D) of the routing bandwidth", code("route_latency_ns"), code("qubit_routing_bandwidth")],
    [code("decode_syndrome"), "one decoder", code("decoder_latency_ns") + " (+ " + code("input_ns") + ")", code("decoders")],
    [code("request_magic"), "one factory and its workspace qubits", code("magic_state_latency_ns"), code("factories") + " + the " + code("factory { … }") + " contract"],
    [code("pauli_frame_update"), "r(records, D) of the classical bandwidth", code("pauli_frame_update_ns"), code("classical_data_bandwidth")],
  ]);
  html += h3("stages", "Four stages, one loop");
  html += `<ol>
    <li><b>Admission.</b> The resource VM checks that a timetable never needs more of a service than the machine declares, and refuses it
    otherwise, naming the constraint it breaks.</li>
    <li><b>Scheduling.</b> The OS gives every statement a start time (section 2). The result is again a QSysASM program, with <code>@t ns</code> on every line.</li>
    <li><b>Execution.</b> The timetable is lowered to native pulses and compiled to RV32I firmware for each control core (section 3).
    The cores post every pulse to the converters at its time; the trace shows whether each statement finished inside its window.</li>
    <li><b>Calibration.</b> What the hardware needed is measured from the trace, and any declared latency that was too short is raised
    to what was measured. Then the loop runs again, until the program conforms (section 4).</li></ol>`;

  // 2 ── The scheduling problem ─────────────────────────────────────────────────────────────────
  html += h2("problem", "2", "The scheduling problem");
  html += `<div class="def"><p><b>Given</b> the statements of a program, each with a duration p<sub>i</sub> from the machine line; precedence
  edges (i → j); service pools r with capacities C<sub>r</sub>; and the demand d<sub>i,r</sub> of every statement on every pool.</p>
  <p><b>Find</b> start times s<sub>i</sub> ≥ 0 with s<sub>j</sub> ≥ s<sub>i</sub> + p<sub>i</sub> for every edge, and, at every moment t,
  Σ d<sub>i,r</sub> over the statements running at t ≤ C<sub>r</sub> for every pool r. A qubit taken by <code>request_ancilla</code>
  counts against <code>qubits</code> until its <code>release_ancilla</code>.</p>
  <p><b>Minimize</b> the makespan max<sub>i</sub>(s<sub>i</sub> + p<sub>i</sub>).</p></div>
  <p>The edges come from the program's own semantics; the OS adds no ordering of its own:</p>
  <ul><li><b>qubit order</b>: a statement waits for the previous statement on each of its qubits;</li>
  <li><b>records</b>: a statement that reads a record waits for the measurement that wrote it;</li>
  <li><b>decoding</b>: a statement that reads a syndrome a <code>decode_syndrome</code> has read (a frame update) waits for that decode.</li></ul>`;
  html += h3("objective", "What is maximized");
  html += `<p>The objective is the shortest makespan, which is the same as the highest rate of finished logical work. Time is not
  free in a fault-tolerant machine. Every microsecond a qubit waits is a microsecond of errors the code must correct, so a shorter
  timetable is also a less noisy one. Three further requirements constrain the search:</p>
  <ul><li><b>Keep pace.</b> Syndromes arrive every round. The decoders must finish them at least as fast as they arrive, or the
  backlog grows without bound (§ 2.4).</li>
  <li><b>Be fair.</b> When several programs share a machine, none may wait forever (§ 2.3).</li>
  <li><b>Never deadlock.</b> A program that holds ancillas and waits for more must not wait on another that does the same (§ 2.2).</li></ul>`;

  html += h3("watch", "Watch the scheduler");
  html += `<p>The OS schedules by <b>list scheduling</b>. Time moves from event to event: a statement becomes ready, starts, or ends.
  At every event the scheduler looks at the statements that are <span style="color:#c62828">ready</span> (all their predecessors done),
  takes them in the policy's order, and starts each one whose services all fit. A statement that does not fit waits, and with
  backfill a later one may pass it. Below, the OS's own scheduler (<code>riscq/os/schedule.mjs</code>) runs in your browser on ten
  small programs, one idea each. Step with ▶|, play with ▶, change the policy or a capacity, or edit the program.</p>
  <div class="legend" style="margin-bottom:6px"><span><i style="background:#8a9a9c"></i>waiting for a predecessor</span><span><i style="background:#c62828"></i>ready, waiting for a service</span>
  <span><i style="background:#4338ca"></i>running</span><span><i style="background:#1baf7a"></i>done</span><span><i style="background:#fde2e2;border:1px dashed #e9a0a0"></i>time spent waiting</span></div>
  <div id="stepper">Loading the scheduler…</div>`;
  const H = P.hardness;
  html += h3("hardness", "2.1 How hard it is");
  html += `<p>This is the resource-constrained project scheduling problem. It is NP-hard in the strong sense
  (Blazewicz, Lenstra and Rinnooy Kan, <i>Discrete Applied Mathematics</i> 5, 1983). No algorithm is known that finds the optimum in
  time polynomial in the number of statements. Without capacities, the critical path is the optimum and is easy to compute. One
  gate slot shared by independent checks is already enough to make the order matter.</p>
  <p>QuantumOS schedules by <b>list scheduling</b>: whenever a statement becomes ready, it offers the free services to the ready
  statements in a priority order, and starts every statement that fits. The program below has ${H.statements} statements on a machine
  with one gate slot and one decoder. The study tried all ${num(H.orders)} priority orders:</p>
  <pre class="code">${esc(H.text.trim())}</pre>`;
  html += table(["Makespan", "Priority orders that reach it", "Share"], H.distribution.map((d) => [us(d.makespanNs), num(d.orders), num((100 * d.orders) / H.orders, 1) + " %"]), { numeric: [0, 1, 2] });
  html += `<div class="facts"><div><b>${us(H.best.makespanNs)}</b><span>the optimum over all ${num(H.orders)} orders</span></div>
    <div><b>${us(H.programOrder.makespanNs)}</b><span>program order (the weight-3 check written first)</span></div>
    <div><b>${us(H.greedy.makespanNs)}</b><span>first ready, first served, with backfill</span></div></div>`;
  const hRows = (sim) => statementsOf(H.text).map((t, i) => {
    const o = sim.ops.find((x) => x.uid === i);
    return { label: (i + 1) + " " + shortOf(t), bars: o?.start !== null && o?.start !== undefined ? [{ t0: o.start, t1: o.end, color: kindColor(statementKind(t)), title: t + ": " + o.start + "–" + o.end + " ns" }] : [] };
  });
  const hEnd = Math.max(H.programOrder.makespanNs, H.best.makespanNs);
  html += `<figure class="fig">${gantt(hRows(H.programOrder), { t1: hEnd, note: "Program order: the weight-1 check's CNOT waits for the gate slot behind all three CNOTs of the other check, and its decode waits for the decoder." })}</figure>
  <figure class="fig">${gantt(hRows(H.best), { t1: hEnd, note: "The optimum: the short check goes first, so its measurement and decode overlap the long check's gates." })}</figure>
  <p>Two statements more would mean ${num(H.orders * 90)} orders, and real programs have thousands of statements. Exhaustive search is
  out of the question; the OS uses fixed rules (program order, readiness, listed deadlines) and the static timetable the compiler
  produced, and measures how far they land from what the hardware allows.</p>`;

  const Dl = P.deadlock;
  html += h3("deadlock", "2.2 Deadlock");
  html += `<p>A deadlock needs four conditions at once (Coffman, Elphick and Shoshani, <i>Computing Surveys</i> 3, 1971), and ancilla qubits meet all four:</p>
  <ul><li><b>mutual exclusion</b>: an ancilla serves one program at a time;</li>
  <li><b>hold and wait</b>: <code>request_ancilla</code> holds its qubits until <code>release_ancilla</code>, and a program may ask for more meanwhile;</li>
  <li><b>no preemption</b>: an ancilla in the middle of a circuit cannot be taken back without destroying its state;</li>
  <li><b>circular wait</b>: two programs can each hold what the other needs.</li></ul>
  <p>Two tenants, each compiled alone against the whole machine, share a pool of 2 ancillas:</p>
  <pre class="code">${esc(Dl.text.trim())}</pre>`;
  html += table(["Policy", "Outcome", "Statements finished", "Makespan"], [
    ["First ready, first served", Dl.greedy.deadlock ? `<span class="no">deadlock at ${ns(Dl.greedy.deadlock.atNs)}</span>` : "completes", Dl.greedy.completed + " of " + Dl.greedy.total, Dl.greedy.deadlock ? "–" : us(Dl.greedy.makespanNs)],
    ["Ancillas granted in program order", Dl.ordered.deadlock ? '<span class="no">deadlock</span>' : '<span class="yes">completes</span>', Dl.ordered.completed + " of " + Dl.ordered.total, us(Dl.ordered.makespanNs)],
  ], { numeric: [3] });
  if (Dl.greedy.deadlock) html += `<p>At ${ns(Dl.greedy.deadlock.atNs)}: ${Dl.holds.map((h) => "line " + h.line + " holds " + h.qubits.map(code).join(", ")).join("; ")}, and
    ${Dl.greedy.deadlock.blocked.map((b) => "line " + b.line + "'s " + code(b.kind) + " waits for " + b.waitingFor).join("; ")}. Nothing is
    running and nothing can start: each tenant waits for the qubit the other holds. Granting the ancilla pool in program order breaks
    the circular wait: tenant A's second request is granted before tenant B's first, so B waits until A releases. The resource VM
    avoids the problem in another way: it admits one timetable for the whole machine, in which no request can ever wait.</p>`;

  const S = P.starvation;
  html += h3("starvation", "2.3 Starvation");
  html += `<p>Backfill lets a statement that fits pass one that waits, which keeps services busy. It also lets a large request
  wait forever while small ones keep passing it. Tenant L needs the whole pool of 4 ancillas at 100 ns; three small tenants take one
  ancilla each, again and again, staggered so that one of them always holds a qubit:</p>
  <details class="block"><summary>The four timetables (${statementsOf(S.text).length} statements)</summary><pre class="code">${esc(S.text.trim())}</pre></details>`;
  const L = (s) => s.ops[0];
  html += table(["Policy", "L's request starts", "L waited", "Times later statements passed it", "Finished", "Makespan"], [
    ["Backfill (first ready, first served)", ns(L(S.backfill).start), us(L(S.backfill).waitNs), num(L(S.backfill).bypassed), S.backfill.completed + " / " + S.backfill.total, us(S.backfill.makespanNs)],
    ["Ancillas granted in program order", ns(L(S.ordered).start), us(L(S.ordered).waitNs), num(L(S.ordered).bypassed), S.ordered.completed + " / " + S.ordered.total, us(S.ordered.makespanNs)],
    ["Strict order for every statement", L(S.strict).start === null ? '<span class="no">never</span>' : ns(L(S.strict).start), "–", num(L(S.strict).bypassed), S.strict.completed + " / " + S.strict.total, S.strict.deadlock ? `<span class="no">deadlock at ${ns(S.strict.deadlock.atNs)}</span>` : us(S.strict.makespanNs)],
  ], { numeric: [1, 2, 3, 5] });
  html += `<p>With backfill, L is passed ${num(L(S.backfill).bypassed)} times and waits ${us(L(S.backfill).waitNs)}: it starts only when every small
  tenant has finished. Granting the pool in program order serves L at once, because L is written first. The small tenants wait instead,
  and the makespan grows from ${us(S.backfill.makespanNs)} to ${us(S.ordered.makespanNs)}. Fairness costs throughput. Strict order for
  <i>every</i> statement is worse than both: the gates and releases of the tenants that hold the qubits L needs may not pass L either,
  so nothing moves (head-of-line blocking).</p>`;

  const B1 = P.backlog.decoders1, B2 = P.backlog.decoders2;
  html += h3("pace", "2.4 Keeping pace with the syndrome");
  html += `<p>A memory produces a syndrome every round, and every syndrome must be decoded. If one decode takes longer than one round,
  a single decoder falls behind by the difference every round, and the delay before a correction is known grows without bound.
  Here a round takes ${ns(1000)} of measurement and a decode ${ns(1600)}:</p>`;
  const lagRows = [["1 decoder", B1], ["2 decoders", B2]].flatMap(([label, b]) => [{ label: label + ", lag", bars: b.lag.map((l) => ({ t0: l.syndromeAtNs, t1: l.decodedAtNs, color: label.startsWith("1") ? COLOR.decode : COLOR.frame, thin: true, title: "round " + l.round + ": syndrome at " + l.syndromeAtNs + " ns, decoded at " + l.decodedAtNs + " ns" })) }]);
  html += table(["Round", ...B1.lag.map((l) => l.round + 1)], [["Lag, 1 decoder", ...B1.lag.map((l) => num(l.lagNs))], ["Lag, 2 decoders", ...B2.lag.map((l) => num(l.lagNs))]], { numeric: B1.lag.map((_, i) => i + 1) });
  html += `<p>Lag is the time from a round's syndrome to its decoded result, in ns. With one decoder it grows by
  ${num(B1.lag[1].lagNs - B1.lag[0].lagNs)} ns per round, the decode time minus the round time. With two decoders it stays at
  ${num(B2.lag.at(-1).lagNs)} ns. The condition is decoders × (1 / decode time) ≥ rounds per µs: the OS must provision decoders from
  the calibrated decode time (§ 4), not from a guess. <a href="/examples/decoder-backlog">The decoder backlog study</a> measures the same
  effect with compiled decoders on whole programs.</p>`;
  html += `<p class="muted">At the scale of whole programs: <a href="/examples/deadlock">deadlock and scheduling policy</a> runs every
  program of the corpus under these policies on six hardware designs, and <a href="/examples/factories">magic-state factories</a> shows
  the same queueing for <code>request_magic</code>.</p>`;

  // 3 ── Compilation ───────────────────────────────────────────────────────────────────────────
  html += h2("compile", "3", "From a timetable to RISC-Q firmware: one parity round");
  html += `<p>One round of the 3-qubit bit-flip code: two parity checks, a decode and a frame update, followed all the way down to the
  instructions RISC-Q's cores execute.</p>`;
  html += h3("watch-machine", "Watch the machine run");
  html += `<p>Three programs, each scheduled by the OS and run on its own generated chip in the cycle-exact model. On top, the real
  hardware in 3D, as on the <a href="/reproduce">Reproduce</a> pages: the transmon chip, the coax from each converter, and the RISC-Q
  board with its cores; every operation glows over the interval the trace shows for it, and each core lights while it plays a pulse.
  Below it, the same moment as a diagram, on the same clock. Play the run, or
  drag the time: the core whose pulse is playing lights its wire and its transmon (blue drive, violet coupler, orange readout),
  a CZ lights its coupler, a measured bit travels from its core through the board hub to the decoder core, and the frame core
  writes the Pauli frame. The left list highlights the statements whose window contains the moment; the right list shows the
  firmware of the core you select, with the code of its current operation highlighted. Every time drawn is a time of the trace.</p>
  <div id="machine-player">Loading the runs…</div>`;
  html += h3("machine", "3.1 The machine");
  const ctl = F.cores.filter((c) => c.role === "control");
  html += `<p>The OS places the program on a generated transmon chip: ${F.sites.filter((s) => s.kind === "data").length} data transmons in a row and
  ${F.sites.filter((s) => s.kind === "ancilla").length} ancillas between them, with a coupler for every pair the program gates. A RISC-Q board at
  ${num(1000 / F.periodNs)} MHz (one batch = ${F.periodNs} ns) runs one control core per transmon, a frame core that keeps the Pauli frame, and a decoder core.</p>`;
  html += table(["Core", "Role", "Drives", "Channels"], F.cores.map((c) => [code(c.name), c.role, c.drives ? code(c.drives) : "–", c.channels.map(code).join(" ")]));
  html += `<p class="muted">Channels: <code>gate</code> plays drive pulses, <code>cz…</code> the coupler's flux pulses, <code>ro</code> the
  readout tone, <code>demod</code> integrates the returning signal into a bit.</p>`;

  html += h3("program", "3.2 The program, and what it depends on");
  html += `<pre class="code">${esc(R.source.trim())}</pre>`;
  html += `<figure class="fig">${dag(st, R.edges)}<figcaption>Dependencies the OS derives (grey: qubit order, orange: a record a measurement
  wrote, red: a syndrome that must be decoded first). ${R.edges.length} edges among ${st.length} statements. Hover an edge for its reason.</figcaption></figure>`;

  html += h3("calibrate-loop", "3.3 Scheduling against what the hardware needs");
  html += `<p>The first timetable uses typical transmon figures, declared before anything was measured. The OS schedules the program
  against them, runs it, and reads from the trace what each kind of statement actually needed:</p>`;
  html += table(["Machine field", ...R.iterations.flatMap((it, k) => ["Declared, run " + (k + 1), "Needed, run " + (k + 1)])],
    fields.map((f) => [code(f), ...R.iterations.flatMap((it) => [num(it.machine[f]), it.needed[f] === undefined ? "–" : (it.needed[f] > it.machine[f] ? `<span class="no">${num(it.needed[f])}</span>` : num(it.needed[f]))])]),
    { numeric: R.iterations.flatMap((_, k) => [1 + 2 * k, 2 + 2 * k]) });
  html += `<p>Run 1 ${it0.conforms ? "conformed" : `did <span class="no">not</span> conform`}: ${Object.keys(it0.raise).length} latencies were too short
  (in red). A CNOT on this chip is H · CZ · H, with a ${ns(400)} CZ pulse. A measurement's bit reaches its core well after the readout
  window closes. The frame update touches three frame words one after another. The OS raised each field to what was measured,
  scheduled again, and run ${R.iterations.length} ${itN.conforms ? '<span class="yes">conforms</span>' : "does not conform"}: every statement finished inside its
  window. The makespan went from ${us(it0.makespanNs)} to ${us(itN.makespanNs)}. That is the honest cost of the round.</p>`;
  html += `<p>The timetable the OS produced, again a QSysASM program:</p><pre class="code">${esc(F.text.trim())}</pre>`;

  html += h3("timeline", "3.4 What the hardware did");
  const stRows = st.map((s) => {
    const r = row(s.uid), bars = [{ t0: s.start, t1: Math.max(s.end, s.start + 1), color: kindColor(s.kind), outline: true, title: "window " + s.start + "–" + s.end + " ns" }];
    if (r?.hw) bars.push({ t0: r.hw[0], t1: Math.max(r.hw[1], r.hw[0] + 1), color: kindColor(s.kind), title: "hardware " + r.hw[0] + "–" + r.hw[1] + " ns" });
    if (r?.bitNs) bars.push({ t0: r.bitNs, tick: true, color: COLOR.measure, title: "bit stored at " + r.bitNs + " ns" });
    return { label: s.uid + 1 + " " + shortOf(s.text), bars };
  });
  html += `<figure class="fig">${gantt(stRows, { t1: F.makespanNs })}<div class="legend"><span><i style="background:${COLOR.window};border:1px dashed #888"></i>window the timetable gives</span>
    <span><i style="background:${COLOR.gate}"></i>pulses and classical work the trace shows</span><span><i style="background:${COLOR.measure}"></i>| the measured bit in its core's memory</span></div>
    <figcaption>One row per statement, numbered as in the program. Every solid bar lies inside its dashed window: the run conforms.</figcaption></figure>`;
  const cores = F.cores.map((c) => c.name);
  const coreRows = cores.map((c) => ({ label: c + (F.cores.find((x) => x.name === c).drives ? " · " + F.cores.find((x) => x.name === c).drives : ""),
    bars: [...F.pulses.filter((p) => p.core === c).map((p) => ({ t0: p.opens, t1: p.closes, color: p.channel === "gate" ? COLOR.gate : /^cz/.test(p.channel) ? COLOR.cz : p.channel === "ro" ? COLOR.measure : p.channel === "demod" ? COLOR.demod : COLOR.other, title: c + "." + p.channel + " → " + p.converter + ": " + p.opens + "–" + p.closes + " ns" })),
      ...F.stores.filter((w) => w.core === c).map((w) => ({ t0: w.atNs, tick: true, color: c === "decoder" ? COLOR.frame : COLOR.measure, title: "word stored at " + w.atNs + " ns (value " + w.value + ")" })),
      ...(c === "dec0.0" && job ? [{ t0: job.startNs, t1: job.endNs, color: COLOR.decode, title: "lookup decode " + job.startNs + "–" + job.endNs + " ns" }] : [])] }));
  html += `<figure class="fig">${gantt(coreRows, { t1: F.makespanNs })}<div class="legend"><span><i style="background:${COLOR.gate}"></i>drive (gate)</span><span><i style="background:${COLOR.cz}"></i>coupler (cz)</span>
    <span><i style="background:${COLOR.measure}"></i>readout tone (ro)</span><span><i style="background:${COLOR.demod}"></i>demodulation window</span><span><i style="background:${COLOR.decode}"></i>decode</span><span><i style="background:${COLOR.frame}"></i>| frame word stored</span></div>
    <figcaption>The same run by core: ${F.pulses.length} pulses on ${new Set(F.pulses.map((p) => p.core)).size} cores, the lookup decode on the decoder core, and the frame core's three frame-word updates.</figcaption></figure>`;

  html += h3("lowering", "3.5 How each statement becomes hardware");
  const fwBy = (uid) => F.firmware.map((f) => ({ core: f.core, n: f.rows.filter((r) => r[4] === uid).length })).filter((x) => x.n);
  const natBy = (uid) => { const c = {}; for (const n of F.natives.filter((x) => x.uid === uid)) c[n.op] = (c[n.op] ?? 0) + 1; return Object.entries(c).map(([k, v]) => v + "× " + k).join(", "); };
  html += table(["#", "Statement", "Native operations", "Pulses", "Firmware (core: instructions)"], st.map((s) => [s.uid + 1, code(strip(s.text)), natBy(s.uid) || (s.kind === "decode_syndrome" ? "lookup on the decoder core" : "none"),
    num(F.pulses.filter((p) => p.uid === s.uid).length), fwBy(s.uid).map((x) => code(x.core) + ": " + x.n).join(", ") || (s.kind === "decode_syndrome" ? "decoder core (§ 3.7)" : "–")]), { numeric: [3] });
  html += `<ul>
    <li><b>Gates.</b> A one-qubit gate is a drive pulse on the qubit's <code>gate</code> channel. A Z rotation is free: it changes the phase of
    later pulses ("frame" operations, no pulse). A CNOT is H on the target, a CZ pulse on the coupler, and H again.</li>
    <li><b><code>measure</code></b> is a readout tone on <code>ro</code> and an integration window on <code>demod</code>. The core then stores
    the bit in its memory and publishes it through the board hub, so every other core can read it.</li>
    <li><b><code>request_ancilla</code></b> is a reset pulse on every requested transmon, all in parallel. <b><code>release_ancilla</code></b>
    plays nothing: the transmon is free for the next qubit placed on it.</li>
    <li><b><code>route</code></b> plays nothing on this chip, because a fixed coupler joins every pair the program gates. On trapped ions it is
    an electrode-voltage shuttle; on neutral atoms an AOD move (§ 4.2).</li>
    <li><b><code>decode_syndrome</code></b> runs on a decoder core: it reads the syndrome bits from the hub and looks up the correction (§ 3.7). Larger codes run the Helios union-find, compiled from C for a core.</li>
    <li><b><code>pauli_frame_update</code></b> plays nothing. The frame core flips a bit in its frame word for each named qubit, at the statement's time.</li></ul>`;

  html += h3("firmware", "3.6 The firmware");
  html += `<p>Each core runs RV32I machine code the OS generated. Every native operation compiles to the same pattern: compute its issue
  time from the segment's time base <code>s0</code>, write it to <code>TIME_CMP</code>, stall on <code>WAIT</code> until the batch counter
  reaches it, write the pulse's start time to the channel's <code>start_time</code> register, and write <code>fire</code>. The channel then
  plays the pulse at exactly that batch, whatever the core does next. Registers: <code>s0</code> time base, <code>s1</code> the timer
  block (0x4000), <code>s2</code> the bit table in RAM. Every comment below is derived from the address map.</p>`;
  const fwHtml = (f, open) => {
    let last = null, body = "";
    for (const r of f.rows) {
      const lab = r[3];
      if (lab !== last) {
        const s = r[4] !== null && r[4] !== undefined ? st.find((x) => x.uid === r[4]) : null;
        body += s ? `<tr class="grp"><td colspan="4">statement ${s.uid + 1} · ${esc(strip(s.text))} <span style="font-weight:400">(native ${esc(lab)}: ${esc(F.natives.find((n) => n.id === lab)?.op ?? "")})</span></td></tr>`
          : `<tr class="sec"><td colspan="4">${esc(lab || "issue loop")}</td></tr>`;
        last = lab;
      }
      body += `<tr><td class="pc">${r[0]}</td><td class="hex">${r[1]}</td><td>${esc(r[2])}</td><td class="cm">${esc(r[5] ?? "")}</td></tr>`;
    }
    const c = F.cores.find((x) => x.name === f.core);
    return `<details class="fw"${open ? " open" : ""}><summary>${esc(f.core)} <span>· ${c?.drives ? "drives " + esc(c.drives) + " · " : ""}${f.words} words</span></summary><div class="asm"><table>${body}</table></div></details>`;
  };
  const first = F.firmware.find((f) => f.core === F.cores.find((c) => c.drives === "ancilla[0]")?.name) ?? F.firmware[3];
  html += fwHtml(first, true) + F.firmware.filter((f) => f !== first).map((f) => fwHtml(f, false)).join("");

  const Dc = D.decoder, Sm = Dc.sample;
  html += h3("decoder", "3.7 decode_syndrome on a decoder core");
  html += `<p>The decode reads two syndrome bits and looks up which data qubit to correct. The study runs the same two-bit lookup on
  RISC-Q's transmon ring with a decoder core, with outcome s0 = ${Dc.outcomes.s0}, s1 = ${Dc.outcomes.s1}. Times are from the close of the
  later measurement window:</p>
  <div class="facts"><div><b>${ns(Sm.inputAtDecoderNs)}</b><span>both bits are in the decoder core's board inbox</span></div>
  <div><b>${ns(Sm.decodeStartNs)}</b><span>the core reads the inbox</span></div>
  <div><b>${ns(Sm.decodedNs)}</b><span>the correction is in its bit table (${ns(Sm.decodeNs)} of lookup)</span></div>
  <div><b>${ns(Sm.frameUpdates?.[0]?.storedNs)}</b><span>the frame word of data[0] is flipped</span></div></div>`;
  const dRows = Dc.rows.filter((r) => /^h\d+$/.test(r[3]) || /segment1/.test(r[3]));
  html += `<div class="fig asm" style="max-height:none"><table>${dRows.map((r) => `<tr><td class="pc">${r[0]}</td><td>${esc(r[2])}</td><td class="cm">${esc(r[5] ?? "")}</td></tr>`).join("")}</table></div>
  <p>The board inbox holds every published bit. <code>andi … 3</code> keeps the two syndrome bits, which index a four-word table placed right
  after the code (<code>auipc</code>). The entry's bits are the corrections for data[0], data[1] and data[2]. Each is stored to the bit
  table and reported to the host. The frame update that follows flips the X bit of data[0]'s frame word only if its correction is 1
  (<code>beq</code>). No pulse is played: the correction is applied to later measurement results in software.</p>`;

  html += h3("bit", "3.8 The life of one measured bit");
  const m0 = meas[0], r0 = row(m0.uid), m1 = meas[1], r1 = row(m1.uid);
  html += table(["When", "What"], [
    [ns(m0.start), "statement " + (m0.uid + 1) + ": " + code(strip(m0.text)) + " starts; the readout tone plays on " + code(F.pulses.find((p) => p.uid === m0.uid && p.channel === "ro")?.core + ".ro")],
    [ns(r0.bitNs), "s[0] is in the memory of its core (" + code(F.stores[0]?.core) + "), and is published through the board hub"],
    [ns(m1.start), "statement " + (m1.uid + 1) + " measures ancilla[1]"],
    [ns(r1.bitNs), "s[1] is in its core's memory"],
    [ns(job?.readyNs), "both bits have reached the decoder core (the hub adds its publish latency)"],
    [ns(job?.startNs) + " – " + ns(job?.endNs), "the lookup decode runs (" + ns(job?.computeNs) + ")"],
    [ns(frame.start), "statement " + (frame.uid + 1) + ": the frame core starts the frame update, at its time in the timetable"],
    ...F.stores.filter((w) => w.core === "decoder").map((w) => [ns(w.atNs), "a frame word is stored (value " + w.value + ")"]),
  ]);
  html += `<p class="muted">The frame update starts at the time the timetable gives it, after the decode's declared latency. On a machine where
  decoding is slower than a round, this is where § 2.4's backlog would appear.</p>`;

  // 4 ── Calibration ──────────────────────────────────────────────────────────────────────────
  html += h2("calibration", "4", "Calibrating every system call");
  html += `<p>A machine line is only as good as its numbers. QuantumOS measures them instead of assuming them. Each system call, and each
  physical instruction, runs alone and k at a time on one chip of eleven transmons, each with its own core. The <b>latency</b> is the
  time from the statement's start to its last effect on the hardware: the last pulse, or for a measurement its bit in the core's
  memory. The <b>rate</b> is k statements divided by the time until all k are done: what one service sustains when it is busy.</p>`;
  html += h3("bench", "4.1 On the chip, one service at a time");
  const kinds = [...new Set(C.microbenchmarks.map((b) => b.kind))];
  html += table(["Statement", "k at once", "Latency of each (ns)", "All done after", "Rate"], C.microbenchmarks.map((b) => [code(b.kind), b.k,
    b.latencyNs.min === b.latencyNs.max ? num(b.latencyNs.min) : num(b.latencyNs.min) + " – " + num(b.latencyNs.max), ns(b.spanNs), num(b.ratePerUs, 1) + " /µs"]), { numeric: [1, 2, 3, 4] });
  const rr = (k) => benchRate(k);
  html += `<ul>
    <li><b><code>request_ancilla</code></b>: ${ns(rr("request_ancilla").latencyNs.max)} at any k. Every transmon has its own reset pulse, so the
    ancilla service scales with the number of transmons.</li>
    <li><b>Gates</b>: H ${ns(rr("H").latencyNs.max)}, CNOT ${ns(rr("CNOT").latencyNs.max)} at any k. Every transmon has its own drive channel, so the
    gate slots are the transmons (<code>max_parallel_gates</code> = number of transmons).</li>
    <li><b><code>measure</code></b>: ${ns(Math.min(...bench("measure").map((b) => b.latencyNs.min)))} to ${ns(Math.max(...bench("measure").map((b) => b.latencyNs.max)))}, depending on the
    transmon: each resonator has its own readout length. Measurements in parallel do not slow each other down.</li>
    <li><b><code>decode_syndrome</code></b>: ${ns(bench("decode_syndrome")[0].latencyNs.min)} per two-bit lookup after its bits arrive. Decodes on one decoder run
    one after another: k at once take k × ${ns(bench("decode_syndrome")[0].latencyNs.min)}, a rate of ${num(rr("decode_syndrome").ratePerUs, 1)} decodes per µs per decoder.
    That is the number § 2.4 needs.</li>
    <li><b><code>pauli_frame_update</code></b>: ${ns(bench("pauli_frame_update")[0].latencyNs.min)} for the first, then
    ${ns(bench("pauli_frame_update").at(-1).latencyNs.max - bench("pauli_frame_update").at(-1).latencyNs.min > 0 ? (bench("pauli_frame_update").at(-1).latencyNs.max - bench("pauli_frame_update").at(-1).latencyNs.min) / (bench("pauli_frame_update").at(-1).k - 1) : 0)}
    more for each: one frame core updates one word at a time, ${num(rr("pauli_frame_update").ratePerUs, 1)} updates per µs.</li></ul>
  <p class="muted">Three H pulses at 0 ns on spare transmons fix the run's time origin in each benchmark. The trace check takes as origin
  the offset most pulses share, and with only one or two pulses that choice can be a tie.</p>`;

  html += h3("corpus", "4.2 In whole programs, on every platform");
  html += `<p><code>route</code> and <code>request_magic</code> do nothing on this chip, so they are calibrated where they act. Ion
  shuttles and AOD moves run on the trapped-ion and neutral-atom designs; factory circuits run on their twins. The
  <a href="/examples/system-calls">system-call study</a> runs eleven programs on six designs and reports, for every machine field, what
  the operations needed against the one number the machine declares:</p>`;
  if (C.corpus.systemCalls) html += table(C.corpus.systemCalls.head, C.corpus.systemCalls.rows.map((r) => r.map((c, i) => (i === 2 ? code(c) : esc(c)))), { numeric: [3, 4, 6], cls: "scroll" });
  html += `<p>Further calibrations:</p><ul>${C.corpus.studies.filter((s) => s.id !== "system-calls").map((s) => `<li><a href="/examples/${s.id}">${esc(s.title)}</a>: ${esc(s.summary)}</li>`).join("")}</ul>`;

  html += h2("scope", "5", "What is measured, and what is assumed");
  html += `<ul>
    <li><b>Measured on the model</b>: every time on this page. The Lean model executes each core's firmware instruction by instruction,
    with the hub, the converters' timed queues and the decoder cores. It is checked against RISC-Q's RTL cycle for cycle.</li>
    <li><b>Generated</b>: the transmon chips. Their pulse shapes and readout lengths come from the design generator, not from a
    particular laboratory device. The <a href="/reproduce">reproductions</a> evaluate the OS on digital twins of published devices instead.</li>
    <li><b>Assumed</b>: measurement outcomes, which are inputs. Physical errors, heating and loss are outside the model, so these
    numbers are costs, not fidelities.</li>
    <li><b>Scheduling experiments</b> (§ 2) run on the operating system's executor with the declared latencies. They show behaviour
    (deadlock, starvation, lag), which the cycle-exact runs of the <a href="/examples">Examples</a> confirm at scale.</li></ul>
    <p class="muted">Reproduce: <code>node riscq/os/schedule-study.mjs</code> (about a minute). QSysASM's grammar and its parser:
    <code>qsysasm.mjs</code>; the scheduler: <code>schedule.mjs</code>.</p>`;

  root.innerHTML = html;
  // The interactive parts: the OS's own scheduler, and the cycle-exact runs on their chips.
  try {
    const [{ mountStepper, mountMachine }, { EXAMPLES, POLICIES }] = await Promise.all([import("/schedule-anim.js"), import("/riscq/os/teaching-examples.mjs")]);
    mountStepper(document.getElementById("stepper"), { examples: EXAMPLES, policies: POLICIES });
    mountMachine(document.getElementById("machine-player"), [R, ...(D.machineRuns ?? [])]);
  } catch (error) {
    for (const id of ["stepper", "machine-player"]) document.getElementById(id).innerHTML = `<p class="no">The animation could not load: ${esc(error.message)}</p>`;
  }
  toc.innerHTML = sections.map(([id, title, level]) => `<li><a href="#${id}" style="${level === 3 ? "padding-left:20px;font-size:12.5px" : ""}">${esc(title)}</a></li>`).join("");
  const links = [...toc.querySelectorAll("a")];
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id));
  }, { rootMargin: "0px 0px -70% 0px" });
  sections.forEach(([id]) => observer.observe(document.getElementById(id)));
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
