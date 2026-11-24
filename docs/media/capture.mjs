// Rebuilds the GIFs of the top-level README from a running QuantumOS server.
//
// Each frame is one trace step, or for the workspace scenes one batch time: the page is moved
// there, painted, and photographed.
// Nothing is recorded in real time, so the same build gives the same frames again.
//
//   PLAYWRIGHT_CORE=<playwright-core installation> node docs/media/capture.mjs            all GIFs
//   PLAYWRIGHT_CORE=<playwright-core installation> node docs/media/capture.mjs neutral-aod   one GIF
//   node docs/media/capture.mjs --list                                                    their names
//
// Environment:
//   PLAYWRIGHT_CORE     required. A playwright-core installation: the package folder, the
//                       node_modules folder that holds it, or the folder above that. The project
//                       itself does not depend on Playwright.
//   QCONTROL_URL        the running server, default http://127.0.0.1:7432
//   PLAYWRIGHT_CHANNEL  browser channel, default "chrome" (an installed Google Chrome)
//   FFMPEG              ffmpeg executable, default "ffmpeg"
//   GIF_COLORS          palette size, default 128
//   QCONTROL_MEDIA_OUT  output folder, default this folder
//   QCONTROL_MEDIA_TMP  keep the PNG frames in this folder (one subfolder per GIF). By default
//                       they go to a fresh folder in the system temp directory and are deleted.
//
// To add a GIF, add an entry to `scenes` below and name it on the command line.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = (process.env.QCONTROL_URL || "http://127.0.0.1:7432").replace(/\/+$/, "");
const outDir = path.resolve(process.env.QCONTROL_MEDIA_OUT || here);
const ffmpeg = process.env.FFMPEG || "ffmpeg";
/** Frames per second of every GIF. One tick below is one frame, a tenth of a second. */
const fps = 10;

function playwright() {
  const folder = process.env.PLAYWRIGHT_CORE;
  if (!folder) throw Error("Set PLAYWRIGHT_CORE to a folder that holds a playwright-core installation.");
  const require = createRequire(pathToFileURL(path.resolve(folder) + path.sep));
  for (const id of ["playwright-core", path.resolve(folder)])
    try {
      return require(id);
    } catch {}
  throw Error("No playwright-core found from " + folder + ".");
}

// ───────────────────────────── page helpers ─────────────────────────────

/** Wait until the page has a run loaded. A page that reports an error fails here with its message. */
async function ready(page) {
  await page.waitForFunction(() => {
    const alert = document.getElementById("alert");
    if (alert && !alert.hidden && alert.textContent.trim()) throw Error(alert.textContent.trim());
    const state = document.getElementById("runState"), step = document.getElementById("step");
    return state && !/Loading|Running|Compiling|Opening/.test(state.textContent) && step && !step.disabled && Number(step.max) > 0;
  }, null, { timeout: 240000 });
}

/** Show trace step `n` (the number left of the slash in the page's counter) and wait for the paint. */
async function seek(page, n) {
  const shown = await page.evaluate(async (n) => {
    const slider = document.getElementById("step");
    slider.value = n;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 3; i++) await new Promise((done) => requestAnimationFrame(done));
    return document.getElementById("counter").textContent;
  }, n);
  if (Number(shown.split("/")[0].replace(/[^0-9]/g, "")) !== n) throw Error("Asked for step " + n + ", the page shows " + shown + ".");
}

const press = (page, name) => page.getByRole("button", { name, exact: true }).first().click();
const focus = (page, id) => page.locator('select[aria-label="Physical camera focus"]').selectOption(id);

/**
 * Move the camera of the 3D view the way a visitor would: scroll the wheel over its middle
 * (one notch zooms in by 1/0.95), then drag with the right button to shift the picture by
 * `[dx, dy]` pixels.
 */
async function zoomIn(page, notches, [dx, dy] = [0, 0]) {
  const view = page.locator("#viewport");
  await view.scrollIntoViewIfNeeded();
  const box = await view.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(30);
  }
  if (dx || dy) {
    await page.mouse.down({ button: "right" });
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up({ button: "right" });
  }
}

/**
 * On some pages the text of the inspector sets the height of the workbench, and the 3D view is
 * refitted when it changes. All frames of a GIF need one size, so the element is given the height
 * of its tallest captured step. No content is hidden by this.
 */
async function pinHeight(page, selector, stepList) {
  let tallest = 0;
  for (const n of new Set(stepList)) {
    await seek(page, n);
    tallest = Math.max(tallest, await page.evaluate((s) => Math.ceil(document.querySelector(s).getBoundingClientRect().height), selector));
  }
  await page.addStyleTag({ content: selector + "{height:" + tallest + "px}" });
  await page.waitForTimeout(400);
}

/** Give the workspace stage the page's height by folding the dock below it, then move in on the chip. */
async function workspaceStage(page, notches, shift) {
  await page.locator("#foldDock").click();
  await page.waitForTimeout(500);
  await zoomIn(page, notches, shift);
  // Park the pointer off the stage so that no hover card covers the picture.
  await page.mouse.move(2, 2);
}

/** `[step, ticks]` for each step from `first` to `last`. Steps named in `holds` stay for that many ticks. */
function steps(first, last, each = 1, holds = {}) {
  const list = [];
  for (let n = first; n <= last; n++) list.push([n, holds[n] ?? each]);
  return list;
}

// ───────────────────────────── the GIFs ─────────────────────────────

// A scene is a page, an optional `setup`, and `frames`: a list of `[trace step, ticks]`.
// `clip` is the photographed element, by default `.workbench`: the 3D view, the transport bar and
// the inspector. `width` is the browser width. The workbench is about 64 px narrower.
const scenes = [
  {
    // Readout tone and demodulation window of q0, then every step from the result at q0's sink:
    // host store, publish through the board hub, the bit at every core, barrier release, q2's
    // writes and fire, the conditioned X pulse on DAC 2.
    name: "riscq-feedforward",
    path: "/riscq?example=superconducting-feedforward&outcome=c=1",
    width: 1100,
    frames: [[379, 5], [390, 5], ...steps(404, 451, 1, { 404: 4, 410: 4, 444: 7, 445: 3 }), [451, 6]],
  },
  {
    // Barrier release, the decoder core reads the two syndrome bits (813), stores the three
    // decoded bits for the host (830, 834, 836), publishes one (837), stores the frame word (847).
    name: "riscq-decoder",
    path: "/riscq?example=superconducting-repetition&outcome=s0=1",
    width: 1100,
    frames: [...steps(803, 849, 1, { 813: 10, 830: 6, 837: 5, 847: 10 }), [849, 6]],
  },
  {
    // Physical view of the H2 trap. Whole-register rotations (689–696, 706–716), four ions into
    // the gate zones, five gate cycles, two measurements, then single-ion shuttles (717–730).
    name: "qccd-h2-racetrack",
    path: "/qccd-studio",
    width: 1060,
    setup: async (page) => {
      await focus(page, "chip");
      await zoomIn(page, 9);
    },
    frames: [...steps(689, 696), [697, 3], ...steps(698, 702, 2), [703, 3], [704, 3], [705, 3], ...steps(706, 716),
      ...steps(717, 730, 2), [730, 6]],
  },
  {
    // Selector words, the latch edge, five waveform knots on the shared DAC that carry ion A
    // 120 µm while lane B holds, settling, the optical gate.
    name: "qccd-broadcast",
    path: "/qccd",
    width: 1060,
    setup: (page) => press(page, "Debugger detail"),
    frames: [...steps(0, 16, 4), [16, 8]],
  },
  {
    // A column tone steps five times and carries the two atoms on it. Then a row tone does the
    // same. The camera is moved in on the RF drive, both deflectors and the trap plane.
    name: "neutral-aod",
    path: "/neutral",
    width: 1060,
    setup: async (page) => {
      await press(page, "Debugger detail");
      await zoomIn(page, 5, [-93, 0]);
    },
    frames: [...steps(0, 23, 3), [23, 6]],
  },
  {
    // The RISC-Q workspace's chip view of the compiled GHZ program on QCCD Studio's H2 trap,
    // from the end of the Doppler cooling to the last detection: shuttles between gate zones,
    // rotations and Mølmer–Sørensen gates, each driven by the control cores around the trap.
    // Frames are batch times, so an ion is drawn partway along its segment between steps.
    name: "riscq-ions",
    path: "/riscq-studio?example=qccd-ghz3&outcome=q0=1&outcome=q2=1&view=chip",
    width: 1500,
    clip: "#viewport",
    setup: (page) => workspaceStage(page, 7, [0, 40]),
    batches: { from: 55000, to: 133451, frames: 90, hold: 8 },
  },
  {
    // The workspace's chip view of the ZAC program: AOD tones pick atoms up, carry them between
    // the storage and entanglement zones and set them down, then Rydberg and Raman pulses.
    name: "riscq-atoms",
    path: "/riscq-studio?example=neutral-bv14&view=chip",
    width: 1500,
    clip: "#viewport",
    setup: (page) => workspaceStage(page, 5, [0, 30]),
    batches: { from: 0, to: 70000, frames: 100, hold: 8 },
  },
  {
    // Board A measures and sends two bits over fiber. Board B samples them and plays the pulses.
    name: "feedforward-boards",
    path: "/feedforward",
    width: 1060,
    frames: [...steps(0, 15, 4), [15, 8]],
  },
];

// ───────────────────────────── capture ─────────────────────────────

async function capture(browser, scene, folder) {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const page = await browser.newPage({ viewport: { width: scene.width, height: 900 }, deviceScaleFactor: 1 });
  try {
    // The server may be rebuilding its Lean executable. A failed load is tried again.
    for (let attempt = 1; ; attempt++)
      try {
        await page.goto(base + scene.path);
        if (scene.batches) await page.waitForFunction(() => typeof window.riscqShowBatch === "function" &&
          /\d/.test(document.getElementById("counter")?.textContent ?? ""), null, { timeout: 240000 });
        else await ready(page);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await page.waitForTimeout(5000 * attempt);
      }
    if (scene.batches) {
      // Real-time frames: evenly spaced batch times, shown through the workspace's own hook.
      const { from, to, frames, hold = 1 } = scene.batches;
      await page.waitForTimeout(800);
      await scene.setup?.(page);
      await page.waitForTimeout(600);
      const target = page.locator(scene.clip).first();
      let count = 0;
      for (let k = 0; k <= frames; k++) {
        await page.evaluate((b) => window.riscqShowBatch(b), Math.round(from + ((to - from) * k) / frames));
        const image = await target.screenshot();
        const ticks = k === 0 || k === frames ? hold : 1;
        for (let i = 0; i < ticks; i++) writeFileSync(path.join(folder, "f-" + String(count++).padStart(4, "0") + ".png"), image);
      }
      return count;
    }
    const selector = scene.clip ?? ".workbench";
    await pinHeight(page, selector, scene.frames.map(([step]) => step));
    await scene.setup?.(page);
    await page.waitForTimeout(600);
    const target = page.locator(selector).first();
    let count = 0;
    for (const [step, ticks] of scene.frames) {
      await seek(page, step);
      const image = await target.screenshot();
      for (let i = 0; i < ticks; i++) writeFileSync(path.join(folder, "f-" + String(count++).padStart(4, "0") + ".png"), image);
    }
    return count;
  } finally {
    await page.close();
  }
}

/** One palette for the whole clip and no dithering: the pages are flat colour and text. */
function encode(folder, file) {
  const filter = "split[a][b];[a]palettegen=stats_mode=full:max_colors=" + (process.env.GIF_COLORS || 128) +
    "[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", path.join(folder, "f-%04d.png"),
    "-filter_complex", filter, "-loop", "0", file], { stdio: ["ignore", "inherit", "inherit"] });
}

const wanted = process.argv.slice(2);
if (wanted.includes("--list")) {
  for (const scene of scenes) console.log(scene.name + "  " + scene.path);
  process.exit(0);
}
const unknown = wanted.filter((name) => !scenes.some((s) => s.name === name));
if (unknown.length) throw Error("Unknown GIF " + unknown.join(", ") + ". Known: " + scenes.map((s) => s.name).join(", ") + ".");
const { chromium } = playwright();
const keep = process.env.QCONTROL_MEDIA_TMP;
const tmp = keep ? path.resolve(keep) : mkdtempSync(path.join(os.tmpdir(), "qcontrol-media-"));
mkdirSync(outDir, { recursive: true });
// SwiftShader gives headless Chrome a WebGL context on a machine without a usable GPU.
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true,
  args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failed = 0;
try {
  for (const scene of scenes) {
    if (wanted.length && !wanted.includes(scene.name)) continue;
    try {
      const folder = path.join(tmp, scene.name);
      const count = await capture(browser, scene, folder);
      const file = path.join(outDir, scene.name + ".gif");
      encode(folder, file);
      console.log(scene.name + ".gif  " + count + " frames  " + (count / fps).toFixed(1) + " s  " +
        (statSync(file).size / 1048576).toFixed(2) + " MiB");
    } catch (error) {
      failed++;
      console.error(scene.name + " failed: " + error.message);
    }
  }
} finally {
  await browser.close();
  if (!keep) rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
