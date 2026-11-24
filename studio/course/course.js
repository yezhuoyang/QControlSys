// The QuantumOS course: one module for every lesson, background chapter and the course index.
//
// A page loads it with
//   <script type="module">import { course } from "/course/course.js"; course({ answers });</script>
// and course() draws the page frame from /course/curriculum.json, wires the exercises, the
// glossary terms and the live figures, and keeps progress in this browser.
//
// Page markup it understands
//   <body data-lesson="B2">            a lesson. data-chapter="timing" for a background chapter,
//                                      data-index for the course index.
//   <article> … <h2 id="…">…</h2> …     the h2 headings become the table of contents.
//   <span class="term" data-term="batch">batch</span>        a glossary term (glossary.json).
//   <figure class="live" data-src="/riscq-studio?example=…&step=…"><figcaption>…</figcaption></figure>
//                                      a run of the real workspace, loaded when clicked.
//   <div class="ex" data-id="B2.1" data-stars="2" data-kind="choice|number|text" …>
//     <p>The question.</p>
//     choice: <ol class="choices"><li data-k="a">…</li>…</ol> and data-answer="a"
//     number: data-unit="ns" data-tolerance="0.5" and data-answer="192" or an answer function
//     text:   data-answer="lw|load" (a regular expression, case-insensitive)
//     <div class="why">The explanation, shown once it is solved or revealed.</div>
//   </div>
//
// Answers that depend on the simulator are not written into the page. They are functions
// passed to course({ answers: { "B2.1": async (api) => number } }) that run the program on the
// server (api.run) and read the result from the trace (api.model), so an exercise always agrees
// with what the simulator does today.

const STORE = "qcontrol-course-v1";
const nav = [
  ["Course", "/course/"],
  ["Background", "/course/background/"],
  ["Workspace", "/riscq-studio"],
  ["Design", "/riscq-design"],
  ["Debugger", "/riscq"],
  ["Workbench", "/machines"],
];

// ───────────────────────────── progress ─────────────────────────────

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) ?? { done: {} };
  } catch {
    return { done: {} };
  }
}
function save(state) {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {}
}
/** { exercises, stars } solved, over everything or over the ids that start with `prefix`. */
export function solved(prefix = "") {
  const done = load().done;
  const ids = Object.keys(done).filter((id) => id.startsWith(prefix));
  return { exercises: ids.length, stars: ids.reduce((n, id) => n + done[id], 0) };
}

// ───────────────────────────── simulator access ─────────────────────────────

const cache = new Map();
let modelModule;
export const api = {
  /**
   * Run a program on the server, as the workspace does: { example, outcomes?, trace? },
   * { platform, qasm }, { platform: "superconducting", calls } or with `design`.
   * Returns the run bundle. Results are cached for the page.
   */
  run(request) {
    const key = JSON.stringify(request);
    if (!cache.has(key)) {
      const simple = request.example && Object.keys(request).every((k) => ["example", "outcomes", "trace"].includes(k));
      let url = "/api/riscq/run", init = { method: "POST", headers: { "Content-Type": "application/json" }, body: key };
      if (simple) {
        const q = new URLSearchParams({ example: request.example });
        for (const [bit, v] of Object.entries(request.outcomes ?? {})) q.append("outcome", bit + "=" + v);
        if (request.trace) q.set("trace", request.trace);
        url += "?" + q;
        init = undefined;
      }
      cache.set(key, fetch(url, init).then(async (r) => {
        const text = await r.text();
        if (!r.ok) throw Error(text);
        return JSON.parse(text);
      }));
    }
    return cache.get(key);
  },
  /** The pure trace functions of the debugger (studio/riscq-model.js). */
  async model() {
    modelModule ??= import("/riscq-model.js");
    return modelModule;
  },
  /** The hardware design service: a template design, the rules, or a rule check with wire timing. */
  design: {
    async template(name = "ring") {
      return (await fetch("/api/riscq/design?template=" + name)).json();
    },
    async check(document) {
      const r = await fetch("/api/riscq/design/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(document) });
      return r.json();
    },
  },
};

// ───────────────────────────── page frame ─────────────────────────────

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
};

/**
 * The product's menu bar is /site-nav.js, shared by every page of QuantumOS. It inserts
 * itself at the top of <body>. If it cannot be loaded, the course draws its own small bar.
 */
async function menuBar(current) {
  try {
    await import("/site-nav.js");
    if (document.querySelector("body > .qn, body > nav, body > header")) return;
  } catch {}
  document.body.prepend(topBar(current));
}

function topBar(current) {
  const { exercises, stars } = solved();
  return el("header", { class: "cbar" },
    el("a", { class: "brand", href: "/course/", html: "QuantumOS" }),
    el("nav", { "aria-label": "Site" }, nav.map(([label, href]) => el("a", { href, ...(label === current ? { "aria-current": "page" } : {}) }, label))),
    el("span", { class: "me", title: "Kept in this browser" }, exercises + " exercises · " + stars + " ★"));
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sideBar(article, extra) {
  const heads = [...article.querySelectorAll("h2")];
  for (const h of heads) if (!h.id) h.id = slug(h.textContent);
  const label = (h) => {
    const num = h.querySelector(".num")?.textContent.trim();
    const title = [...h.childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains("num"))).map((n) => n.textContent).join("").trim();
    return (num ? num + " · " : "") + title;
  };
  const links = heads.map((h) => el("li", {}, el("a", { href: "#" + h.id, text: label(h) })));
  const side = el("aside", { class: "side" }, extra, el("h5", { text: "On this page" }), el("ol", {}, links));
  // Highlight the section in view.
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries)
      if (e.isIntersecting) {
        for (const a of side.querySelectorAll("li a")) a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id);
      }
  }, { rootMargin: "-70px 0px -70% 0px" });
  heads.forEach((h) => spy.observe(h));
  return side;
}

function lessonContext(curriculum, id) {
  const all = curriculum.parts.flatMap((part) => part.lessons.map((lesson) => ({ ...lesson, part })));
  const k = all.findIndex((l) => l.id === id);
  return { lesson: all[k], prev: all[k - 1], next: all[k + 1] };
}
function chapterContext(curriculum, id) {
  const all = curriculum.background;
  const k = all.findIndex((c) => c.id === id);
  return { chapter: all[k], prev: all[k - 1], next: all[k + 1] };
}

function pager(prev, next, prevLabel, nextLabel) {
  return el("nav", { class: "pager" },
    prev ? el("a", { href: prev.href }, el("small", { text: prevLabel }), (prev.id && prev.part ? prev.id + " · " : "") + prev.title) : el("span"),
    next ? el("a", { class: "next", href: next.href }, el("small", { text: nextLabel }), (next.id && next.part ? next.id + " · " : "") + next.title) : el("span"));
}

// ───────────────────────────── glossary ─────────────────────────────

async function terms() {
  const spans = document.querySelectorAll(".term[data-term]");
  if (!spans.length) return;
  const glossary = await (await fetch("/course/glossary.json")).json();
  for (const span of spans) {
    const entry = glossary[span.dataset.term];
    if (entry) span.dataset.def = entry.short;
    else console.warn("No glossary entry " + span.dataset.term);
  }
}

// ───────────────────────────── live figures ─────────────────────────────

function liveFigures() {
  for (const fig of document.querySelectorAll("figure.live[data-src]")) {
    const src = fig.dataset.src;
    const caption = fig.querySelector("figcaption");
    const frame = el("div", { class: "frame" });
    const start = el("div", { class: "start", role: "button", tabindex: "0" },
      el("b", { text: fig.dataset.title ?? "A live run of the simulator" }),
      el("span", { text: "The program is compiled to firmware and executed when you start it." }),
      el("span", { class: "btn small", text: "Run it here" }));
    const go = () => frame.replaceChildren(el("iframe", { src, title: fig.dataset.title ?? "Live run", loading: "lazy" }));
    start.addEventListener("click", go);
    start.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && go());
    frame.append(start);
    // The caption is one flex item, so inline markup such as <code> stays in its sentence.
    const cap = el("div", { class: "cap" }, el("span", {}, caption ? [...caption.childNodes] : []), el("a", { href: src, target: "_blank", rel: "noopener", text: "Open in the workspace →" }));
    caption?.remove();
    fig.replaceChildren(frame, cap);
  }
}

// ───────────────────────────── exercises ─────────────────────────────

function exercises(answers) {
  const state = load();
  const list = [...document.querySelectorAll(".ex[data-id]")];
  list.forEach((box, k) => {
    const id = box.dataset.id, stars = Number(box.dataset.stars ?? 1), kind = box.dataset.kind ?? "choice";
    const status = el("span", { class: "state", text: "open" });
    box.prepend(el("h4", {}, el("span", { text: "Exercise " + (k + 1) }), el("span", { class: "stars", text: "★".repeat(stars) }), status));
    const feedback = el("div", { class: "feedback", "aria-live": "polite" });
    const computed = el("div", { class: "computed" });
    let tries = 0;
    const finish = (ok, message) => {
      feedback.className = "feedback " + (ok ? "ok" : "no");
      feedback.textContent = message;
      box.classList.toggle("wrong", !ok);
      if (ok) {
        box.classList.add("done");
        status.textContent = "solved";
        const s = load();
        s.done[id] = Math.max(s.done[id] ?? 0, stars);
        save(s);
        document.dispatchEvent(new CustomEvent("course-progress"));
      } else {
        status.textContent = "try again";
        tries++;
        if (tries >= 2 && !box.querySelector(".reveal")) box.append(el("button", { class: "reveal", text: "Show the answer", onclick: reveal }));
      }
    };
    const expected = async () => {
      if (answers[id]) return answers[id](api);
      return box.dataset.answer;
    };
    const reveal = async () => {
      box.classList.add("revealed");
      status.textContent = "revealed";
      try {
        const value = await expected();
        feedback.className = "feedback";
        feedback.textContent = "The answer is " + format(value, box.dataset.unit) + ".";
      } catch (error) {
        feedback.textContent = "The simulator could not be reached: " + error.message;
      }
    };
    if (kind === "choice") {
      const items = [...box.querySelectorAll(".choices li")];
      for (const li of items) {
        const button = el("button", { type: "button" }, ...li.childNodes);
        button.addEventListener("click", async () => {
          for (const b of box.querySelectorAll(".choices button")) b.classList.remove("picked", "ok", "no");
          const right = String(await expected()) === li.dataset.k;
          button.classList.add("picked", right ? "ok" : "no");
          finish(right, right ? "Correct." : "Not this one.");
        });
        li.replaceChildren(button);
      }
    } else {
      const input = el("input", { type: "text", inputmode: kind === "number" ? "decimal" : "text", "aria-label": "Your answer", autocomplete: "off" });
      const check = el("button", { class: "btn small", type: "button", text: "Check" });
      const run = async () => {
        const given = input.value.trim();
        if (!given) return;
        check.disabled = true;
        feedback.className = "feedback";
        feedback.textContent = answers[id] ? "Running the program on the simulator…" : "";
        try {
          const want = await expected();
          if (kind === "number") {
            const value = Number(given.replace(/[, _]/g, ""));
            const tolerance = Number(box.dataset.tolerance ?? 0);
            const ok = Number.isFinite(value) && Math.abs(value - Number(want)) <= tolerance + 1e-9;
            finish(ok, ok ? "Correct." : Number.isFinite(value) ? "Not quite." : "Enter a number.");
            if (ok && answers[id]) computed.textContent = "Read from the run the simulator just made: " + format(want, box.dataset.unit) + ".";
          } else {
            const ok = new RegExp("^(" + want + ")$", "i").test(given);
            finish(ok, ok ? "Correct." : "Not quite.");
          }
        } catch (error) {
          feedback.className = "feedback no";
          feedback.textContent = "The simulator could not be reached: " + error.message;
        } finally {
          check.disabled = false;
        }
      };
      check.addEventListener("click", run);
      input.addEventListener("keydown", (e) => e.key === "Enter" && run());
      const row = el("div", { class: "answer" }, input, box.dataset.unit ? el("span", { class: "unit", text: box.dataset.unit }) : null, check);
      const why = box.querySelector(".why");
      box.insertBefore(row, why);
    }
    const why = box.querySelector(".why");
    box.insertBefore(feedback, why);
    box.append(computed);
    if (state.done[id]) {
      box.classList.add("done");
      status.textContent = "solved";
    }
  });
  return list;
}

function format(value, unit) {
  if (typeof value === "number") value = Number.isInteger(value) ? value.toLocaleString("en-US") : String(Math.round(value * 1000) / 1000);
  return value + (unit ? " " + unit : "");
}

// ───────────────────────────── entry ─────────────────────────────

export async function course({ answers = {} } = {}) {
  const curriculum = await (await fetch("/course/curriculum.json")).json();
  const body = document.body;
  const article = document.querySelector("article");
  if (body.dataset.lesson && article) {
    const { lesson, prev, next } = lessonContext(curriculum, body.dataset.lesson);
    await menuBar("Course");
    const crumb = el("div", { class: "crumb" }, el("a", { href: "/course/", text: "Course" }), " › ",
      el("a", { href: "/course/#part-" + lesson.part.id, text: "Part " + lesson.part.id + " · " + lesson.part.title }), " › " + lesson.id);
    article.prepend(crumb);
    const boxes = exercises(answers);
    const meter = el("div", { class: "meter" }, el("i"));
    const count = el("div", { class: "src" });
    const paint = () => {
      const n = boxes.filter((b) => load().done[b.dataset.id]).length;
      meter.firstChild.style.width = (boxes.length ? (100 * n) / boxes.length : 0) + "%";
      count.textContent = n + " of " + boxes.length + " exercises";
    };
    document.addEventListener("course-progress", paint);
    paint();
    const page = el("div", { class: "page" }, sideBar(article, [el("h5", { text: lesson.id + " · " + lesson.title }), meter, count, el("br")]));
    article.replaceWith(page);
    page.append(article);
    article.append(pager(prev, next, "Previous lesson", "Next lesson"));
  } else if (body.dataset.chapter && article) {
    const { chapter, prev, next } = chapterContext(curriculum, body.dataset.chapter);
    await menuBar("Background");
    article.prepend(el("div", { class: "crumb" }, el("a", { href: "/course/background/", text: "Background" }), " › " + chapter.title));
    exercises(answers);
    const page = el("div", { class: "page" }, sideBar(article, null));
    article.replaceWith(page);
    page.append(article);
    article.append(pager(prev, next, "Previous chapter", "Next chapter"));
  } else {
    await menuBar(body.dataset.index === "background" ? "Background" : "Course");
    exercises(answers);
  }
  liveFigures();
  await terms();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  return curriculum;
}

export { el, load as progress };
