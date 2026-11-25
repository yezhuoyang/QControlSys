// A reproduced paper (or an Examples study) as one box across the page's column, set like an article in
// a journal: its figure is the run's 3D twin exactly as its page shows it (studio/reproduce/twin3d.js,
// the same track), then the journal's masthead, the citation, the summary and what the reproduction
// found. Used by /reproduce and /examples.

// Its stylesheets, and the 3D twin's, once per page.
for (const href of ["/reproduce/twin3d.css", "/reproduce/journal.css"])
  if (!document.querySelector(`link[href="${href}"]`)) document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href }));

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
 * stats?: [text], links?: [[text, href]] }.
 */
export function journalCard(item, index) {
  const j = item.paper ? journalOf(item.paper.venue) : null;
  const tier = j ? j.tier : "study";
  const status = item.status ? `<span class="jstatus ${/^reproduced$/.test(item.status) ? "done" : /reproduced/.test(item.status) ? "partial" : "todo"}">${esc(item.status)}</span>` : "";
  return `<article class="jcard tier-${tier}" data-card="${index}">
    <div class="jfig" aria-label="${esc(item.title)}: the run's twin in 3D"><div class="jtwin"></div></div>
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

/**
 * Mount each card's twin from `cards` (id → { track: url }): the 3D twin of its page, playing. A twin is
 * mounted while its card is on screen and disposed when it leaves, so a long list holds a few WebGL
 * contexts at a time; a track is fetched once.
 */
export function mountCards(el, items, cards, { machine = "twin" } = {}) {
  const tracks = new Map();
  const load = (url) => {
    if (!tracks.has(url)) tracks.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    return tracks.get(url);
  };
  const live = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const card = entry.target, i = Number(card.dataset.card), url = cards[items[i]?.id]?.track;
      if (!url) continue;
      if (entry.isIntersecting && !live.has(card)) {
        live.set(card, null);
        Promise.all([load(url), import("/reproduce/twin3d.js")]).then(([track, { mountTwin }]) => {
          if (!live.has(card) || live.get(card)) return;
          if (!track) { card.querySelector(".jfig").classList.add("empty"); live.delete(card); return; }
          live.set(card, mountTwin(card.querySelector(".jtwin"), track, { compact: true }));
        });
      } else if (!entry.isIntersecting && live.has(card)) {
        live.get(card)?.dispose();
        live.delete(card);
        card.querySelector(".jtwin").innerHTML = "";
      }
    }
  }, { rootMargin: "200px 0px" });
  items.forEach((item, i) => {
    const card = el.querySelector(`[data-card="${i}"]`);
    if (!card) return;
    if (cards[item.id]?.track) io.observe(card);
    else card.querySelector(".jfig").classList.add("empty");
  });
  const legend = document.createElement("p");
  legend.className = "jlegend";
  legend.innerHTML = `Each figure is the run's ${esc(machine)} in 3D, as its page shows it: the device and its control system, every pulse, move, readout and decode at the time the run played it. Drag to turn it, scroll to zoom, or switch between the whole machine, the device and the control system.`;
  el.prepend(legend);
}
