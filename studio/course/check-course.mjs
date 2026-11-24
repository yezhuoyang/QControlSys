// Checks the course in a headless browser: every page loads without console errors, every
// glossary term resolves, every link inside the site answers, and every exercise accepts its
// correct answer. Correct answers are taken from the page itself: the choice named by
// data-answer, or the value the page's answer function computes from the simulator.
//
//   PLAYWRIGHT_CORE=<playwright-core installation> QCONTROL_URL=http://127.0.0.1:7432 node studio/course/check-course.mjs [A1 B2 …]
//
// The project does not depend on Playwright. Exit code 1 when a check fails.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = (process.env.QCONTROL_URL || "http://127.0.0.1:7432").replace(/\/+$/, "");
const folder = process.env.PLAYWRIGHT_CORE;
if (!folder) throw Error("Set PLAYWRIGHT_CORE to a folder that holds a playwright-core installation.");
const { chromium } = createRequire(pathToFileURL(path.resolve(folder) + path.sep))("playwright-core");
const curriculum = JSON.parse(readFileSync(path.join(here, "curriculum.json"), "utf8"));
const wanted = process.argv.slice(2);
const pages = [
  { id: "index", href: "/course/" },
  { id: "background", href: "/course/background/" },
  ...curriculum.parts.flatMap((p) => p.lessons),
  ...curriculum.background,
].filter((p) => !wanted.length || wanted.includes(p.id));

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true, args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
let failures = 0;
const fail = (where, message) => {
  failures++;
  console.log("  FAIL " + where + ": " + message);
};
const checkedLinks = new Map();
for (const entry of pages) {
  const problems = [];
  const onConsole = (m) => ["error", "warning"].includes(m.type()) && problems.push(m.text());
  const onError = (e) => problems.push(e.message);
  page.on("console", onConsole);
  page.on("pageerror", onError);
  const response = await page.goto(base + entry.href);
  if (!response.ok()) {
    fail(entry.id, "HTTP " + response.status());
    continue;
  }
  await page.waitForSelector(".qn, .cbar", { timeout: 30000 });
  await page.waitForTimeout(300);
  // Glossary terms carry a definition.
  const undefinedTerms = await page.$$eval(".term", (spans) => spans.filter((s) => !s.dataset.def).map((s) => s.dataset.term));
  if (undefinedTerms.length) fail(entry.id, "terms without a glossary entry: " + undefinedTerms.join(", "));
  // Links inside the site answer.
  const links = await page.$$eval("a[href^='/']", (as) => [...new Set(as.map((a) => a.getAttribute("href").split("#")[0]))]);
  for (const href of links) {
    if (!checkedLinks.has(href)) {
      const r = await page.request.get(base + href).catch(() => null);
      checkedLinks.set(href, r ? r.status() : 0);
    }
    if (checkedLinks.get(href) !== 200) fail(entry.id, "link " + href + " answers " + checkedLinks.get(href));
  }
  // Every exercise accepts its correct answer.
  const exercises = await page.$$eval(".ex[data-id]", (boxes) => boxes.map((b) => ({ id: b.dataset.id, kind: b.dataset.kind ?? "choice", answer: b.dataset.answer })));
  if (entry.lessons === undefined && curriculum.parts.some((p) => p.lessons.includes(entry))) {
    const declared = curriculum.parts.flatMap((p) => p.lessons).find((l) => l.id === entry.id);
    if (declared.exercises !== exercises.length) fail(entry.id, "curriculum.json says " + declared.exercises + " exercises, the page has " + exercises.length);
    const stars = await page.$$eval(".ex[data-id]", (boxes) => boxes.reduce((n, b) => n + Number(b.dataset.stars ?? 1), 0));
    if (declared.stars !== stars) fail(entry.id, "curriculum.json says " + declared.stars + " stars, the page has " + stars);
    if (exercises.some((x) => !x.id.startsWith(entry.id + "."))) fail(entry.id, "exercise ids must start with " + entry.id + ".");
  }
  for (const ex of exercises) {
    const box = page.locator('.ex[data-id="' + ex.id + '"]');
    if (ex.kind === "choice") {
      if (!ex.answer) {
        fail(ex.id, "a choice exercise names its answer in data-answer");
        continue;
      }
      const index = await box.locator(".choices li").evaluateAll((lis, k) => lis.findIndex((li) => li.dataset.k === k), ex.answer);
      if (index < 0) {
        fail(ex.id, "no choice " + ex.answer);
        continue;
      }
      await box.locator(".choices li").nth(index).locator("button").click();
    } else {
      // The value the page itself expects, through its answer function or data-answer.
      await box.locator(".reveal, button.btn").first().waitFor();
      let value = ex.answer;
      if (value === undefined) {
        // Ask for the answer twice wrong, then read the revealed value.
        const input = box.locator("input");
        for (let k = 0; k < 2; k++) {
          await input.fill("-123456789");
          await box.locator("button.btn").click();
          await page.waitForFunction((id) => !/Running/.test(document.querySelector('.ex[data-id="' + id + '"] .feedback').textContent), ex.id, { timeout: 240000 });
        }
        await box.locator(".reveal").click();
        await page.waitForFunction((id) => /The answer is/.test(document.querySelector('.ex[data-id="' + id + '"] .feedback').textContent), ex.id, { timeout: 240000 });
        const text = await box.locator(".feedback").innerText();
        value = text.replace(/^The answer is /, "").replace(/\.$/, "").replace(/ [^\d].*$/, "").replace(/,/g, "");
        if (!value || value === "undefined") {
          fail(ex.id, "the exercise has no answer: neither data-answer nor an answer function");
          continue;
        }
        await page.evaluate((id) => document.querySelector('.ex[data-id="' + id + '"]').classList.remove("revealed"), ex.id);
      } else if (ex.kind === "text") value = ex.answer.split("|")[0].replace(/\\/g, "");
      await box.locator("input").fill(String(value));
      await box.locator("button.btn").click();
      await page.waitForFunction((id) => !/Running/.test(document.querySelector('.ex[data-id="' + id + '"] .feedback').textContent), ex.id, { timeout: 240000 });
    }
    const state = await box.locator(".feedback").innerText();
    if (!/Correct/.test(state)) fail(ex.id, "the correct answer was not accepted: " + state);
  }
  page.off("console", onConsole);
  page.off("pageerror", onError);
  const real = problems.filter((p) => !/favicon/.test(p));
  if (real.length) fail(entry.id, "console: " + real.slice(0, 3).join(" | "));
  console.log((real.length ? "✗ " : "✓ ") + entry.id.padEnd(12) + exercises.length + " exercises, " + links.length + " links");
}
await browser.close();
console.log(failures ? failures + " failures" : "all checks passed");
process.exitCode = failures ? 1 : 0;
