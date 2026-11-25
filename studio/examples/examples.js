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

export async function renderIndex(el) {
  try {
    const list = await json("/examples/data/index.json");
    el.innerHTML = list.map((s, i) => `<a class="card" href="/examples/${esc(s.id)}">
      <span class="badge done">${i + 1}</span> <span class="cite">${esc(s.kicker)}</span>
      <h3>${esc(s.title)}</h3><p>${code(s.summary)}</p></a>`).join("");
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
  el.innerHTML = `
    <p class="kicker"><a href="/examples">Examples</a> · ${esc(s.kicker)}</p>
    <h1>${esc(s.title)}</h1>
    <p class="lead">${code(s.summary)}</p>
    <h2>How it is measured</h2>${s.method.map((p) => `<p>${code(p)}</p>`).join("")}
    ${s.sections.map((x) => `<h2>${esc(x.heading)}</h2>${x.text ? `<p>${code(x.text)}</p>` : ""}${x.table ? table(x.table) : ""}`).join("")}
    <h2>What it shows</h2><ul>${s.findings.map((f) => `<li>${code(f)}</li>`).join("")}</ul>
    <div class="note">${esc(s.note)}</div>
    <h2>Reproduce it yourself</h2><pre class="code">${esc(s.command)}</pre>
    <p class="cite">Generated ${esc((s.generated ?? "").slice(0, 10))}.</p>
    <p class="pager">${prev ? `<a href="/examples/${esc(prev.id)}">← ${esc(prev.title)}</a>` : ""}${next ? `<a href="/examples/${esc(next.id)}">${esc(next.title)} →</a>` : ""}</p>`;
}
