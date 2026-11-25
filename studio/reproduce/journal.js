// A reproduced paper (or an Examples study) as one box across the page's column, set like an article in
// a journal: a figure that plays the run in miniature (studio/reproduce/miniature.js), the journal's
// masthead, the citation, the summary and what the reproduction found. Used by /reproduce and /examples.
import { mountMiniature, MINIATURE_LEGEND } from "/reproduce/miniature.js";

// Its stylesheet, once per page.
if (!document.querySelector('link[href="/reproduce/journal.css"]'))
  document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/reproduce/journal.css" }));

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const code = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

/**
 * The journal of a citation's venue ("Nature 638, 920 (2025)", "Nature Physics 22, 189 (2026)",
 * "arXiv:2404.16728 (2024)"): its name, the rest of the reference, its year, and its tier for the
 * masthead (nature, nature-family, science, science-family, preprint, journal).
 */
export function journalOf(venue = "") {
  const first = venue.split(/,\s*arXiv|;/)[0].trim();
  const year = /\((\d{4})\)/.exec(venue)?.[1] ?? "";
  if (/^arXiv/i.test(first)) return { name: "arXiv", ref: first.replace(/\s*\(\d{4}\)$/, ""), year, tier: "preprint" };
  const m = /^([A-Za-z][A-Za-z .&-]*?)\s+(\d.*)$/.exec(first);
  const name = m ? m[1].trim() : first, ref = m ? m[2].replace(/\s*\(\d{4}\)$/, "") : "";
  const tier = name === "Nature" ? "nature" : /^Nature\b/.test(name) ? "nature-family" : name === "Science" ? "science" : /^Science\b/.test(name) ? "science-family" : "journal";
  return { name, ref, year, tier };
}

/**
 * One box. item = { href, title, summary, kicker?, paper?: { authors, title, venue, url }, status?,
 * stats?: [text], links?: [[text, href]], figure caption? }.
 */
export function journalCard(item, index) {
  const j = item.paper ? journalOf(item.paper.venue) : null;
  const tier = j ? j.tier : "study";
  const status = item.status ? `<span class="jstatus ${/^reproduced$/.test(item.status) ? "done" : /reproduced/.test(item.status) ? "partial" : "todo"}">${esc(item.status)}</span>` : "";
  return `<article class="jcard tier-${tier}" data-card="${index}">
    <a class="jfig" href="${esc(item.href)}" aria-label="${esc(item.title)}">
      <canvas aria-hidden="true"></canvas>
      <span class="jfig-cap">${esc(item.caption ?? "The run, in miniature: its opening operations as the twin's control system played them")}</span>
    </a>
    <div class="jbody">
      <div class="jmast">${j
        ? `<span class="jjournal">${esc(j.name)}</span>${j.ref ? `<span class="jref">${esc(j.ref)}</span>` : ""}${j.year ? `<span class="jyear">${esc(j.year)}</span>` : ""}`
        : `<span class="jjournal">${esc(item.number ? "Example " + item.number : "Example")}</span>`}
        ${item.kicker ? `<span class="jkicker">${esc(item.kicker)}</span>` : ""}
      </div>
      <h3><a href="${esc(item.href)}">${esc(item.title)}</a></h3>
      ${item.paper ? `<p class="jpaper"><a href="${esc(item.paper.url)}">${esc(item.paper.title)}</a><span class="jauthors">${esc(item.paper.authors)}</span></p>` : ""}
      <p class="jsum">${code(item.summary)}</p>
      <div class="jfoot">
        ${status}
        ${(item.stats ?? []).map((s) => `<span class="jstat">${esc(s)}</span>`).join("")}
        <span class="jlinks">${(item.links ?? []).map(([t, h], k) => `<a class="${k === 0 ? "primary" : ""}" href="${esc(h)}">${esc(t)}</a>`).join("")}</span>
      </div>
    </div>
  </article>`;
}

/** Start each card's miniature from `previews` (id → preview), and add the legend once. */
export function mountCards(el, items, previews, { machine = "twin" } = {}) {
  items.forEach((item, i) => {
    const card = el.querySelector(`[data-card="${i}"]`), preview = previews[item.id]?.preview;
    if (!card) return;
    if (preview) mountMiniature(card.querySelector("canvas"), preview);
    else card.querySelector(".jfig").classList.add("empty");
  });
  const legend = document.createElement("p");
  legend.className = "jlegend";
  legend.innerHTML = "In each figure: " + MINIATURE_LEGEND.map(([c, t]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join("") +
    `<small>Qubits sit where the ${esc(machine)} places them. The figure plays one step per start or end of an operation, so it shows the order of what the run did, not its durations; the 3D view on each page plays machine time.</small>`;
  el.prepend(legend);
}
