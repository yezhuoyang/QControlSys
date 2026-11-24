// The course (studio/course): every page the curriculum names exists, its exercises are
// counted correctly in curriculum.json, every glossary term it uses is defined, every
// numeric exercise has an answer, and every internal link leads to a page that is served.
// The browser check (studio/course/check-course.mjs) goes further: it answers every exercise.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = path.join(root, "studio", "course");
const curriculum = JSON.parse(readFileSync(path.join(dir, "curriculum.json"), "utf8"));
const glossary = JSON.parse(readFileSync(path.join(dir, "glossary.json"), "utf8"));
const fileOf = (href) => {
  const rest = href.replace(/^\/course\/?/, "");
  return path.join(dir, rest === "" || rest.endsWith("/") ? rest + "index.html" : path.extname(rest) ? rest : rest + ".html");
};
const lessons = curriculum.parts.flatMap((part) => part.lessons);
const written = (entry) => existsSync(fileOf(entry.href));

/** The exercise boxes of a page: [{ id, stars, kind, answered }]. */
function exercises(html) {
  const boxes = [...html.matchAll(/<div class="ex"([^>]*)>/g)].map((m) => {
    const attr = (name) => new RegExp("data-" + name + '="([^"]*)"').exec(m[1])?.[1];
    return { id: attr("id"), stars: Number(attr("stars") ?? 1), kind: attr("kind") ?? "choice", answer: attr("answer") };
  });
  return boxes;
}

test("the curriculum names each lesson and chapter once, with its own address", () => {
  const ids = [...lessons.map((l) => l.id), ...curriculum.background.map((c) => c.id)];
  assert.equal(new Set(ids).size, ids.length);
  for (const lesson of lessons) assert.equal(lesson.href, "/course/" + lesson.id);
  for (const chapter of curriculum.background) assert.equal(chapter.href, "/course/background/" + chapter.id);
  // Glossary entries point to chapters that exist in the curriculum.
  const chapters = new Set(curriculum.background.map((c) => c.id));
  for (const [key, entry] of Object.entries(glossary)) assert.ok(chapters.has(entry.chapter), key + " → " + entry.chapter);
});

test("every written lesson matches the curriculum: exercise count, stars, ids and answers", () => {
  const done = lessons.filter(written);
  assert.ok(done.length > 0);
  for (const lesson of done) {
    const html = readFileSync(fileOf(lesson.href), "utf8");
    assert.match(html, new RegExp('<body data-lesson="' + lesson.id + '"'), lesson.id);
    const boxes = exercises(html);
    assert.equal(boxes.length, lesson.exercises, lesson.id + " exercises");
    assert.equal(boxes.reduce((n, b) => n + b.stars, 0), lesson.stars, lesson.id + " stars");
    for (const box of boxes) {
      assert.ok(box.id?.startsWith(lesson.id + "."), lesson.id + " exercise id " + box.id);
      assert.ok(box.stars >= 1 && box.stars <= 3, box.id + " stars");
      assert.ok(["choice", "number", "text"].includes(box.kind), box.id + " kind");
      // A choice names its answer. A number or text either names it or has an answer function.
      if (box.kind === "choice") assert.ok(box.answer, box.id + " needs data-answer");
      else if (box.answer === undefined) assert.match(html, new RegExp('"' + box.id.replace(".", "\\.") + '"\\s*:'), box.id + " needs an answer function");
    }
    assert.equal(new Set(boxes.map((b) => b.id)).size, boxes.length, lesson.id + " repeats an exercise id");
  }
});

test("every course page uses defined glossary terms and links only to pages that exist", () => {
  const pages = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".html")).map((f) => path.join(dir, f));
  const served = new Set(["/quantumos.svg", "/site-nav.js", "/riscq-model.js", "/home.css", "/learn", "/riscq-studio", "/riscq-design", "/riscq", "/machines", "/qccd-studio", "/qccd", "/neutral", "/feedforward", "/controller", "/validation", "/board-validation", "/"]);
  for (const file of pages) {
    const html = readFileSync(file, "utf8");
    for (const [, term] of html.matchAll(/data-term="([^"]+)"/g)) assert.ok(glossary[term], path.basename(file) + " uses undefined term " + term);
    for (const [, href] of html.matchAll(/href="(\/[^"#?]*)/g)) {
      if (href.startsWith("/course")) {
        const known = href === "/course/" || href === "/course/background/" ||
          lessons.some((l) => l.href === href) || curriculum.background.some((c) => c.href === href) || existsSync(fileOf(href));
        assert.ok(known, path.basename(file) + " links to " + href);
      } else if (href.startsWith("/docs/media/") || href.startsWith("/model/") || href.startsWith("/docs/")) continue;
      else assert.ok(served.has(href) || href.startsWith("/api/"), path.basename(file) + " links to " + href);
    }
  }
});
