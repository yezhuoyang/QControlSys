// The Examples section: the system-call calibration and runtime studies. Each study's content
// (text and tables) is assembled offline by riscq/calib/site.mjs into /examples/data/<id>.json;
// this module renders the index and one study page.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const code = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\b(decode_syndrome|request_magic|request_ancilla|release_ancilla|pauli_frame_update|route|[a-z0-9]+_ns)\b/g, "<code>$1</code>");
const json = async (url) => { const r = await fetch(url); if (!r.ok) throw Error(url + ": " + r.status); return r.json(); };

function table(t) {
  return `<div class="tbl"><table><thead><tr>${t.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
    t.rows.map((r) => `<tr>${r.map((c) => `<td>${code(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

/** The list: one box per study across the column, its first run playing in miniature (studio/reproduce/journal.js). */
export async function renderIndex(el) {
  try {
    const [list, previews] = await Promise.all([json("/examples/data/index.json"), json("/examples/data/previews.json").catch(() => ({}))]);
    const { journalCard, mountCards } = await import("/reproduce/journal.js");
    const items = list.map((s, i) => {
      const p = previews[s.id];
      return {
        id: s.id, number: i + 1, href: "/examples/" + s.id, title: s.title, summary: s.summary, kicker: s.kicker,
        stats: [p?.sites && p.sites + " qubits", p?.runs && p.runs + " run" + (p.runs > 1 ? "s" : "") + " in 3D"].filter(Boolean),
        links: [["Read the study", "/examples/" + s.id], ["Design", "/examples/" + s.id + "/design"]],
      };
    });
    el.classList.remove("cards");
    el.classList.add("jlist");
    el.innerHTML = items.map(journalCard).join("");
    mountCards(el, items, previews, { machine: "machine" });
  } catch (error) {
    el.textContent = "The examples could not be loaded: " + error.message;
  }
}

export async function renderStudy(el, id) {
  let s, list;
  try {
    [s, list] = await Promise.all([json("/examples/data/" + id + ".json"), json("/examples/data/index.json")]);
  } catch (error) {
    el.textContent = "This example could not be loaded: " + error.message;
    return;
  }
  document.title = s.title + " · Examples · QuantumOS";
  const at = list.findIndex((x) => x.id === id), prev = list[at - 1], next = list[at + 1];
  const rows = s.rows ?? [];
  const runButtons = rows.map((r, i) => `<button type="button" data-run="${i}" aria-pressed="false">${esc(r.label)}</button>`).join("");
  el.innerHTML = `
    <p class="kicker"><a href="/examples">Examples</a> · ${esc(s.kicker)}</p>
    <h1>${esc(s.title)}</h1>
    <p class="lead">${code(s.summary)}</p>
    <p><a class="btn design" href="/examples/${esc(id)}/design">Open the design: run it on a machine you choose</a> <a class="btn design" data-hw href="/hw/design?doc=example:${esc(id)}:0">Build this machine in 3D</a></p>
    ${rows.length ? `<h2>The machine, running it</h2>
    <p>The hardware design below runs the program on the cycle-exact model of its RISC-Q control system: every pulse, move, readout and decode appears at the time the model executed it, and every board and core of the controller lights up when it plays. Drag to turn the view, scroll to zoom.</p>
    <div class="runpick" role="group" aria-label="Run">${runButtons}</div>
    <div id="twin" class="twin"></div>
    <div id="run"></div>` : ""}
    <h2>How it is measured</h2>${s.method.map((p) => `<p>${code(p)}</p>`).join("")}
    ${s.sections.map((x) => `<h2>${esc(x.heading)}</h2>${x.text ? `<p>${code(x.text)}</p>` : ""}${x.table ? table(x.table) : ""}`).join("")}
    <h2>What it shows</h2><ul>${s.findings.map((f) => `<li>${code(f)}</li>`).join("")}</ul>
    <div class="note">${esc(s.note)}</div>
    <h2>Reproduce it yourself</h2><pre class="code">${esc(s.command)}</pre>
    <p class="cite">Generated ${esc((s.generated ?? "").slice(0, 10))}.</p>
    <p class="pager">${prev ? `<a href="/examples/${esc(prev.id)}">← ${esc(prev.title)}</a>` : ""}${next ? `<a href="/examples/${esc(next.id)}">${esc(next.title)} →</a>` : ""}</p>`;
  if (!rows.length) return;
  const twin = el.querySelector("#twin"), detail = el.querySelector("#run");
  let viewer, shown = -1;
  const show = async (i) => {
    shown = i;
    el.querySelectorAll(".runpick button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.run) === i)));
    viewer?.dispose();
    viewer = undefined;
    // A large run (its track and listing) is loaded when it is opened.
    if (rows[i].detail) {
      twin.innerHTML = `<p class="no">Loading this run…</p>`;
      detail.innerHTML = "";
      try {
        rows[i] = await json(rows[i].detail);
      } catch (error) {
        if (shown === i) twin.innerHTML = `<p class="no">This run could not be loaded: ${esc(error.message)}</p>`;
        return;
      }
      if (shown !== i) return;
    }
    const r = rows[i];
    detail.innerHTML = runDetail(r);
    if (!r.track) { twin.innerHTML = `<p class="no">No track was recorded for this run.</p>`; return; }
    const { mountTwin } = await import("/reproduce/twin3d.js");
    if (shown !== i) return;
    const tr = r.track;
    el.querySelector("[data-hw]")?.setAttribute("href", "/hw/design?doc=" + encodeURIComponent("example:" + id + ":" + i));
    viewer = mountTwin(twin, tr, { caption: `${tr.device.sites.length} qubits, ${tr.events.length} operations${tr.moves?.length ? ", " + tr.moves.length + " moves" : ""}${tr.controller ? ", " + tr.controller.cores.length + " control cores" : " (the runtime simulator's schedule; no control system ran it)"}, ${(tr.endNs / 1000).toFixed(1)} µs of machine time. The machine is this run's hardware document, the one the design page builds; positions and times are the run's, and the room-scale parts are illustrative envelopes.` });
  };
  el.querySelectorAll(".runpick button").forEach((b) => b.addEventListener("click", () => show(Number(b.dataset.run))));
  show(0);
}

/** One run's facts: its verdict, its columns, every kind of operation against its window, what was late. */
function runDetail(r) {
  const verdict = r.deadlock ? `<p class="dverdict bad">✗ The runtime deadlocked: the program never completes.</p>`
    : r.conforms ? `<p class="dverdict ok">✓ Every operation ran inside its window on this machine.</p>` : `<p class="dverdict bad">✗ Some operations did not fit their windows on this machine.</p>`;
  const cols = Object.entries(r.columns ?? {});
  const kinds = Object.entries(r.byKind ?? {});
  return `${verdict}
    ${cols.length ? table({ head: ["", ""], rows: cols }) : ""}
    ${kinds.length ? `<h3>Every kind of operation against its window</h3>${table({ head: ["Operation", "In window", "Longest hardware time (ns)", "Longest overrun (ns)"], rows: kinds.map(([k, v]) => [k, v.ok + " / " + v.count, String(v.maxHardwareNs ?? "–"), String(v.maxOverrunNs ?? 0)]) })}` : ""}
    ${r.failures?.length ? `<h3>${r.deadlock ? "Operations waiting at the deadlock" : "First operations outside their window"}</h3>${table({ head: ["Operation", "Listing line", "Window (ns)", "Hardware (ns)", "Why"], rows: r.failures.map((f) => [f.kind, String(f.line ?? "–"), f.start !== undefined ? Math.round(f.start) + " – " + Math.round(f.end) : "–", f.hardwareNs ? Math.round(f.hardwareNs[0]) + " – " + Math.round(f.hardwareNs[1]) : "–", f.reason ?? ""]) })}` : ""}
    ${timetable(r.program)}`;
}

/** The QSysASM timetable a run played (the operating system's schedule), folded. */
export function timetable(text) {
  if (!text) return "";
  const n = text.split("\n").filter((l) => /^@/.test(l)).length;
  return `<details class="qsys"><summary>The timetable the operating system produced: ${n} timed QSysASM statements</summary><pre class="code">${esc(text)}</pre></details>`;
}
