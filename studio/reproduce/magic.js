// Sections of the two magic-state reproduction pages (riscq/ftqvm/magic.mjs): a run of the
// paper's own circuit on its twin, the noise simulation beside the paper's numbers, and the
// factory as a system call that the compiler lowers. reproduce.js loads this module only for a page
// whose rows are circuit runs (`view: "circuit"`).

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (x, d = 1) => (x === undefined || x === null ? "–" : (100 * x).toFixed(d) + "%");
const us = (ns, d = 2) => (ns === undefined || ns === null ? "–" : (ns / 1000).toFixed(d));
const sci = (x) => (x === undefined ? "–" : x === 0 ? "0" : x.toExponential(1));
const table = (head, rows) => `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
  rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

const kindRows = (r) => Object.entries(r.byKind ?? {}).map(([k, v]) => {
  const s = r.slack?.[k];
  return [`<code>${esc(k)}</code>`, `${v.ok} / ${v.count}`, s ? s.declaredNs : "–", s ? [s.minNs, s.medianNs, s.maxNs].join(" / ") : "–", v.maxOverrunNs || 0];
});

/**
 * A logical-qubit run (riscq/ftqvm/logical.mjs): the circuit, then decode_syndrome on the decoder
 * core in the same Lean run, then the pulse conditioned on its result; the compiled decoder on
 * noisy shots; the noise statistics.
 */
function logicalDetail(r) {
  const i = r.decoder.inRun ?? {}, b = r.decoder.bench ?? {}, st = r.stats ?? {};
  const ms = r.circuitNs >= 1e6;
  const facts = [
    ["Qubits", r.qubits], ["Hardware operations", r.ops], ["Measurements", r.measurements], ["Detectors", r.detectors], ["Edges of the decoding graph", r.edges],
    ["Time on the twin", ms ? (r.circuitNs / 1e6).toFixed(2) + " ms" : us(r.circuitNs) + " µs"], ...(r.cores ? [["RISC-Q cores", r.cores], ["Pulses the Lean model played", r.pulses]] : []),
  ];
  const path = [
    ["The last readout window closes", "0", "the readout core counts or demodulates its bit"],
    ["The decoder core starts decoding", us(i.toDecoderNs), "every measuring core published its bits to the board hub; the decoder core passed the barrier and read them"],
    ["The decoder's result is published", us((i.toDecoderNs ?? 0) + (i.computeNs ?? 0)), `the compiled union-find decoder ran ${us(i.computeNs, 1)} µs on the ${i.defects ?? "–"} detector${i.defects === 1 ? "" : "s"} that fired`],
    ["The conditioned pulse starts", i.toPulseNs ? us(i.toPulseNs) : "–", i.conditioned === 0 ? "this circuit conditions no pulse on the decoder (the paper reads the memory out)" : i.fired ? `the pulse's core read the decoded bit after the barrier (${us(i.afterDecodeNs)} µs after the result)` : "the decoded bit was 0: no pulse"],
  ];
  const ref = st.pymatching !== null && st.pymatching !== undefined;
  return `
    ${r.steps?.length ? debuggerHtml(r) : ""}
    <h3>The circuit on the twin</h3>
    ${table(["", ""], facts.map(([k, val]) => [esc(k), val]))}
    <h3>Readout → decoder → feed-forward, in the Lean run</h3>
    <p>One shot of the noisy simulation is the readout's answer. Times are from the trace, counted from the moment the last readout window closes (µs).</p>
    ${table(["Event", "µs", "What happens"], path.map(([a, t, w]) => [esc(a), t, esc(w)]))}
    <p>The decoder's correction for this shot: <code>${esc(i.mask)}</code>; PyMatching's on the same shot: <code>${esc(i.pymatching)}</code>. The decoded observable bit stored by the run: <code>${esc(i.observable)}</code>.</p>
    <h3>The compiled decoder on ${(st.compiled?.shots ?? 0).toLocaleString("en")} noisy shots</h3>
    ${table(["", ""], [
      ["Corrections equal to PyMatching's", pct(st.compiled?.agreesWithPyMatching)],
      ["Decoded ⟨observable⟩ (1 − 2 × logical error)", st.compiled ? st.compiled.decoded.toFixed(3) : "–"],
      ["Decode time, median / longest (µs)", us(b.median, 1) + " / " + us(b.max, 1)],
      ["Decoder image", (b.bytes ?? 0).toLocaleString("en") + " bytes"],
      ...(b.pruned ? [["Error mechanisms kept (RAM)", `${b.pruned.kept} of ${b.pruned.kept + b.pruned.dropped} (the dropped ones carry ${sci(b.pruned.droppedProbability)} of probability)`]] : []),
    ].map(([k, val]) => [esc(k), esc(val)]))}
    <h3>Noise simulation</h3>
    ${table(["Shots", "Raw", ref ? "Decoded (reference decoder)" : "Decoded", "Postselected", "Kept"], [[(st.shots ?? 0).toLocaleString("en"), sgn(st.raw), ref ? sgn(st.pymatching) : "–", st.postselected !== null ? sgn(st.postselected) : "–", pct(st.kept)]])}
    <p class="src">Expectation values of the observable, 1 − 2 × (error), over the paper's error model simulated with Stim.</p>
    <h3>Every operation against its window</h3>
    ${table(["Operation", "In window", "Window (ns)", "Hardware min / median / max (ns)", "Longest overrun (ns)"], kindRows(r))}`;
}
const sgn = (x) => (x === undefined || x === null ? "–" : (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(3));

/** One circuit run in detail: what ran, every kind of operation against its window, timing. */
export function runDetail(r) {
  if (r.decoder) return logicalDetail(r);
  const kinds = kindRows(r);
  const google = r.circuit !== undefined;
  const facts = google ? [
    ["Qubits", r.qubits], ["Couplers of the twin", r.couplers], ["Moments (Stim TICKs)", r.moments], ["Two-qubit gates", r.twoQubit], ["Measurements", r.measurements],
    ["Detectors", r.detectors], ["Tagged gates the hardware plays", Object.entries(r.tagged ?? {}).map(([k, n]) => `<code>${esc(k)}</code> × ${n}`).join(", ")],
    ["Time on the twin", us(r.circuitNs) + " µs"], ["RISC-Q cores", r.cores], ["Pulses the Lean model played", r.pulses],
  ] : [
    ["Atoms", r.qubits], ["Encoder layers", r.encoderLayers], ["Hardware operations", r.ops], ["Time on the twin", (r.circuitNs / 1e6).toFixed(3) + " ms"],
    ["RISC-Q cores", r.cores], ["Pulses the Lean model played", r.pulses],
  ];
  const moments = !google && r.moments ? `<h3>The factory, moment by moment</h3>
    <p>Each line is one operation of the array. A CZ layer is: pick up the moving atoms and carry them to 2 µm from their partners, one global Rydberg pulse, the echo, carry them back.</p>
    ${table(["#", "Operation", "Duration (µs)", "Longest move (µm)", "What"], r.moments.map((m) => [m.index, esc(m.kind), us(m.dur), m.moveUm ?? "–", esc(m.label ?? "")]))}` : "";
  const noise = google && r.noise ? `<h3>Noise</h3><p>SI1000 at p = ${r.noise.p} on the paper's circuit as Stim runs it (T gates as tagged identities, the Clifford proxy): ${r.noise.shots.toLocaleString("en")} shots, ${pct(r.noise.kept.value)} kept with no detector fired, ${r.noise.error.k} observable flips among ${r.noise.error.n.toLocaleString("en")} kept (${sci(r.noise.error.value)}).</p>` : "";
  const fidelity = !google && r.injected ? `<h3>Noise</h3>${table(["", "Raw", "Error-corrected", "Postselected", "Distilled", "Factory accepts"], [
    ["This twin", pct(r.injected.raw), pct(r.injected.corrected), pct(r.injected.postselected), pct(r.distilled.fidelity, 2), pct(r.distilled.acceptance.value, 2)],
  ])}<p>${r.shots.toLocaleString("en")} shots per basis; the ideal factory accepts ${pct(r.distilled.acceptance.ideal, 2)} (1/6).</p>` : "";
  return `
    ${r.steps?.length ? debuggerHtml(r) : ""}
    <h3>The circuit on the twin</h3>
    ${table(["", ""], facts.map(([k, val]) => [esc(k), val]))}
    <h3>Every operation against its window</h3>
    <p>The circuit runs time-triggered: every operation starts at its moment's time on the controller's grid. For each kind: how many ran inside their window, the window, and the hardware time the Lean trace shows (min / median / max, ns). Measured bits reached the cores' memory at most ${r.bitAfterWindowNs ?? "–"} ns after their readout windows; the paper's analysis reads them after the run.</p>
    ${table(["Operation", "In window", "Window (ns)", "Hardware min / median / max (ns)", "Longest overrun (ns)"], kinds)}
    ${moments}${noise}${fidelity}`;
}

/* ------------------------------------------------------------------ the debugger */

// One step per moment of the circuit. Everything shown is in the run's data: the moment's window
// and operations, the interval the Lean trace shows for them, and the state after the moment
// (Willow: ⟨X⟩ and ⟨Z⟩ of every transmon from the noiseless state-vector run with the real T
// gates, whose bits the twin's readout returned; Gemini: the five logical qubits through Fig. 3a).

const MAGIC_AXIS = [1, 1, 1].map((x) => x / Math.sqrt(3));

function debuggerHtml(r) {
  const data = JSON.stringify({ steps: r.steps, labels: r.qubitLabels ?? null }).replace(/</g, "\\u003c");
  const n = r.steps.length;
  return `<h3>Step through the run</h3>
    <p>One step per moment of the circuit: its window on the twin, the operations in it, the interval the Lean trace of the control system shows for them, and the state of the machine after it. Use the arrows, the slider, or the arrow keys on the slider.</p>
    <div class="dbg" data-dbg>
      <script type="application/json" class="dbg-data">${data}</script>
      <div class="dbg-bar">
        <button type="button" class="btn small alt" data-dbg-step="-1" aria-label="Previous moment">◀</button>
        <input type="range" min="0" max="${n - 1}" value="0" data-dbg-at aria-label="Moment">
        <button type="button" class="btn small alt" data-dbg-step="1" aria-label="Next moment">▶</button>
        <span class="dbg-pos" aria-live="polite"></span>
      </div>
      <div class="dbg-view">${stepHtml(r.steps, 0, r.qubitLabels)}</div>
    </div>`;
}

const bar = (v) => `<span class="dbg-v" title="${v}"><i style="left:${(50 + 50 * Math.max(-1, Math.min(1, v))).toFixed(1)}%"></i></span>`;

function stepHtml(steps, i, labels) {
  const s = steps[i], us3 = (ns) => (ns / 1000).toFixed(3);
  const head = `<p><b>Moment ${s.k}</b> · ${esc(s.label)} · window ${us3(s.t0)}–${us3(s.t1)} µs${s.hardware ? ` · the trace shows ${us3(s.hardware[0])}–${us3(s.hardware[1])} µs` : ""} · ${s.inWindow} of ${s.count} operations in their window${s.moveUm !== undefined ? ` · longest move ${s.moveUm} µm` : ""}</p>`;
  const ops = s.ops.length ? `<pre class="code dbg-ops">${esc(s.ops.join("\n"))}</pre>` : "<p>No operation is played in this moment (virtual Z or idle).</p>";
  let state = "";
  if (s.state) {
    state = `<div class="tbl"><table><thead><tr><th>Transmon (x, y)</th><th>⟨X⟩</th><th></th><th>⟨Z⟩</th><th></th></tr></thead><tbody>${
      s.state.x.map((x, q) => `<tr><td>${esc(labels?.[q] ?? q)}</td><td>${x.toFixed(2)}</td><td>${bar(x)}</td><td>${s.state.z[q].toFixed(2)}</td><td>${bar(s.state.z[q])}</td></tr>`).join("")}</tbody></table></div>`;
    if (s.bits?.length) state += `<p>Bits measured in this moment: <code>${s.bits.join(" ")}</code>.</p>`;
    if (s.detectors?.length) state += `<p>Detectors completed: ${s.detectors.map((d) => (d ? '<span class="no">fired</span>' : '<span class="yes">quiet</span>')).join(" ")}.</p>`;
  } else if (s.logical) {
    state = `<p>The logical qubits after <i>${esc(s.logical.label)}</i> (perfect inputs):</p><div class="tbl"><table><thead><tr><th>Logical qubit</th><th>⟨X⟩</th><th>⟨Y⟩</th><th>⟨Z⟩</th><th>Fidelity with (1,1,1)/√3</th></tr></thead><tbody>${
      s.logical.bloch.map((b, q) => `<tr><td>LQ${q + 1}${q === 0 ? " (output)" : ""}</td>${b.map((x) => `<td>${x.toFixed(3)}</td>`).join("")}<td>${((1 + b.reduce((a, x, k) => a + x * MAGIC_AXIS[k], 0)) / 2).toFixed(3)}</td></tr>`).join("")}</tbody></table></div>`;
  } else if (!s.state) state = "<p class=\"src\">The state after this moment is not computed for this run (more than 16 qubits for the state vector, or before encoding is complete).</p>";
  return head + ops + state;
}

function showStep(root, i) {
  const data = JSON.parse(root.querySelector(".dbg-data").textContent);
  i = Math.max(0, Math.min(data.steps.length - 1, i));
  root.querySelector("[data-dbg-at]").value = String(i);
  root.querySelector(".dbg-pos").textContent = `${i + 1} / ${data.steps.length}`;
  root.querySelector(".dbg-view").innerHTML = stepHtml(data.steps, i, data.labels);
}

if (typeof document !== "undefined" && !document.documentElement.dataset.magicDebugger) {
  document.documentElement.dataset.magicDebugger = "1";
  const style = document.createElement("style");
  style.textContent = `
    .dbg { border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; background: #fff; margin: 8px 0 20px; }
    .dbg-bar { display: flex; align-items: center; gap: 8px; }
    .dbg-bar input[type=range] { flex: 1 1 auto; }
    .dbg-pos { font: 600 12.5px/1 var(--mono); color: var(--ink3); min-width: 6ch; text-align: right; }
    .dbg-ops { max-height: 180px; }
    .dbg-v { position: relative; display: inline-block; width: 90px; height: 8px; border-radius: 4px; background: linear-gradient(90deg, #fde2e2, #f1f1f1 50%, #dcf3e5); vertical-align: middle; }
    .dbg-v i { position: absolute; top: -2px; width: 3px; height: 12px; margin-left: -1px; background: var(--navy, #1e293b); border-radius: 1px; }`;
  document.head.append(style);
  document.addEventListener("input", (e) => {
    const root = e.target.closest?.("[data-dbg]");
    if (root && e.target.matches("[data-dbg-at]")) showStep(root, Number(e.target.value));
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-dbg-step]"), root = b?.closest("[data-dbg]");
    if (root) showStep(root, Number(root.querySelector("[data-dbg-at]").value) + Number(b.dataset.dbgStep));
  });
}

/** Page sections that belong to the paper as a whole: the noise beside the paper, the system call. */
export function sections(data) {
  const out = [];
  if (data.sweep?.length) out.push(`<h2>Error against noise strength</h2>
    <p>The kickback circuit under SI1000 at four noise strengths. Cultivation makes the fault distance three, so the error among kept shots should grow as p³ (the paper's Supplementary Fig. S19).</p>
    ${table(["p", "Shots", "Kept", "Flips among kept", "Error among kept", "Error / p³"], data.sweep.map((s) =>
      [s.p, s.shots.toLocaleString("en"), pct(s.kept.value), s.error.k, sci(s.error.value) + " ± " + sci(s.error.sigma), (s.error.value / s.p ** 3).toFixed(2)]))}`);
  if (data.device?.noise) {
    const n = data.device.noise;
    out.push(`<h2>The error model</h2><p>The paper's benchmarked infidelities as depolarizing channels (average infidelity r of a d-level channel of probability p is r = p·d/(d + 1)), preparation and measurement splitting the stated 1%, and dephasing with T2 = ${n.t2_s} s over every operation's duration. The noise of the Clifford circuit is learned with Stim and applied to the exact five-qubit distillation channel, the paper's input-decoupled method; the decoder is a lookup table sampled from separate shots (the paper's MLD).</p>
      ${table(["Channel", "Probability"], [["local Raman gate", n.local1q.toExponential(2)], ["global Raman gate", n.global1q.toExponential(2)], ["CZ", n.cz.toExponential(2)], ["preparation", n.prepare], ["measurement", n.measure]])}`);
  }
  if (data.noise?.note) out.push(`<h2>The error model</h2><p>${esc(data.noise.note)}</p>`);
  if (data.calibration) out.push(calibrationHtml(data.calibration));
  const c = data.call, f = data.factory;
  if (c?.onDevice) out.push(logicalCallHtml(c));
  else if (c) {
    const spec = Object.entries(c.spec ?? {}).map(([k, val]) => [`<code>${esc(k)}</code>`, esc(val.value), esc(val.source), `<span class="src">${esc(val.note ?? "")}</span>`]);
    const rm = c.requestMagic?.[0];
    out.push(`<h2>The factory as a system call</h2>
      ${c.error ? `<p class="no">The compiler refused the program: ${esc(c.error)}</p>` : `
      <p>The compiler lowered the program below against a machine whose <code>request_magic</code> service is this factory: ${f.qubits} qubits (${c.factories.factory.output_qubits} output, ${c.factories.factory.workspace_qubits} workspace) and the factory's time on the twin as its latency. The resource VM: <b class="${c.verdict === "RESOURCE_VALIDATED" ? "yes" : "no"}">${esc(c.verdict)}</b>. The listing has ${c.ops} timed operations (${c.kinds.map((k) => `<code>${esc(k)}</code>`).join(", ")}); the factory's window is ${rm ? `[${us(rm.start)}, ${us(rm.end)}) µs` : "–"}, its whole duration on the twin.</p>
      <div class="note"><b>Postselection is not in the contract.</b> ${esc(f.note)} With the simulated acceptance of ${pct(f.acceptance, 2)}, a kept state takes ${f.expectedNs >= 1e6 ? (f.expectedNs / 1e6).toFixed(1) + " ms" : us(f.expectedNs, 1) + " µs"} on average, ${(f.expectedNs / f.latencyNs).toFixed(1)} times the latency the compiler reserves.</div>
      <details class="block" open><summary>The logical program</summary><pre class="code">${esc(c.programText)}</pre></details>
      <details class="block"><summary>The QSysASM program (first lines of ${c.listingLines} statements)</summary><pre class="code">${esc(c.listingHead)}</pre></details>
      <details class="block"><summary>The machine it compiled against</summary>${table(["Field", "Value", "Source", "Note"], spec)}<pre class="code">${esc(c.machineText)}</pre></details>`}`);
  }
  return out.join("\n");
}

/** decode_syndrome as a system call: what the decoder was measured to do, and what the compiler is told. */
function calibrationHtml(cal) {
  const fields = Object.entries(cal.fields).map(([k, x]) => [`<code>${esc(k)}</code>`, esc(x.value), esc(x.source), `<span class="src">${esc(x.note ?? "")}</span>`]);
  const w = cal.workloads.map((x) => [x.d, x.rounds, x.p, x.detectors, x.shots, us(x.ns.median, 1), us(x.ns.p99, 1), us(x.ns.max, 1), x.accuracy ? `${x.accuracy.agree} / ${x.shots}` : "–",
    x.accuracy ? `${x.accuracy.ufWrong} / ${x.accuracy.pymatchingWrong}` : "–"]);
  const r = cal.inRun ?? {};
  return `<h2>The decoder as a system call</h2>
    <p>Decoding is the <code>decode_syndrome</code> system call, served by a decoder core of the RISC-Q board. The service is a C program, <code>riscq/decoders/uf_decoder.c</code>: union-find with peeling on the circuit's own detector graph (or, when the error model is a hypergraph, cluster growth then GF(2) elimination inside each cluster), generated as C tables for each circuit, compiled with clang for the core (RV32I with a multiplier, 64 KiB), and run instruction by instruction in the Lean model of the board, the same model that plays the pulses. Nothing about the decoder is assumed: the fields the compiler is given below are measured on it.</p>
    <h3>Calibration: decode times on noisy syndromes</h3>
    <p>Rotated surface-code memories under SI1000 noise, each shot decoded by the compiled decoder in the Lean model and compared with PyMatching. Times in µs.</p>
    ${table(["d", "Rounds", "p", "Detectors", "Shots", "Median", "99th pct.", "Longest", "Same correction as PyMatching", "Logical errors: compiled / PyMatching"], w)}
    <h3>In the control program</h3>
    <p>On ${esc(r.circuit ?? "a memory circuit")}: the bits reach the decoder ${us(r.bitsInNs)} µs after the last readout window closes, the decode takes ${us(r.computeNs, 1)} µs, its result reaches another core ${us(r.resultOutNs)} µs later, and the conditioned pulse starts ${us(r.toPulseNs, 1)} µs after the readout. The board's hub shares at most 128 bits per decode, which bounds the decoding window.</p>
    <h3>What the compiler is told</h3>
    ${table(["Field", "Value", "Source", "How"], fields)}
    <p class="src">Measured on ${esc((cal.generated ?? "").slice(0, 10))} by <code>node riscq/decoders/calibrate.mjs</code>.</p>`;
}

/** The paper's logical operation as a logical program, compiled on the paper's device and, if refused there, on the least machine the resource VM admits. */
function logicalCallHtml(c) {
  const verdict = (r) => `<b class="${r.verdict === "RESOURCE_VALIDATED" ? "yes" : "no"}">${esc(r.verdict)}</b>${r.message ? ": " + esc(r.message) : ""}`;
  const listing = (r, name) => r?.listingHead ? `<details class="block"><summary>${name}: the QSysASM program (first lines of ${r.listingLines} statements)</summary><pre class="code">${esc(r.listingHead)}</pre></details>
    <details class="block"><summary>${name}: the machine it compiled against</summary><pre class="code">${esc(r.machineText)}</pre></details>` : "";
  return `<h2>The logical operation as a system call</h2>
    <p>The compiler lowered the program below against the twin: its gate, measurement and reset times, the decoder's measured latency, and the frame update as measured in this page's run.</p>
    <details class="block" open><summary>The logical program</summary><pre class="code">${esc(c.programText)}</pre></details>
    <p>On the paper's device (${c.onDevice.qubits} qubits), the resource VM: ${verdict(c.onDevice)}.</p>
    ${c.admitted ? `<p>On the smallest machine the VM admits (${c.admitted.qubits} qubits): ${verdict(c.admitted)}, ${c.admitted.ops} timed operations, ${us(c.admitted.makespanNs)} µs.</p>` : ""}
    ${listing(c.onDevice, "On the device")}${listing(c.admitted, "Admitted")}
    ${c.decoder ? `<div class="note"><b>The decoder's fields.</b> ${esc(c.decoder.note)} Calibrated latency model: <code>${esc(c.decoder.latencyModel?.value)}</code> ns for n input bits; bandwidth ${esc(c.decoder.bandwidth?.value)} bits/µs; window ${esc(c.decoder.windowRounds?.value)} rounds.</div>` : ""}`;
}
