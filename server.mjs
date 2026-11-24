import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "./machine/compiler.mjs";
import { deviceActivity } from "./machine/device.mjs";
import { terminalActivity } from "./machine/delivery.mjs";
import { apparatus } from "./machine/apparatus.mjs";
import { examples as machineExamples } from "./machine/examples.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const executable = path.join(
  root,
  ".lake",
  "build",
  "bin",
  process.platform === "win32" ? "qcontrol.exe" : "qcontrol",
);
const routes = new Map([
  ["/riscq", "studio/riscq.html"],
  ["/riscq.js", "studio/riscq.js"],
  ["/riscq-model.js", "studio/riscq-model.js"],
  ["/riscq.css", "studio/riscq.css"],
  ["/riscq-studio", "studio/riscq-studio.html"],
  ["/riscq-studio.js", "studio/riscq-studio.js"],
  ["/riscq-studio.css", "studio/riscq-studio.css"],
  ["/riscq-stage.js", "studio/riscq-stage.js"],
  ["/riscq-layers.js", "studio/riscq-layers.js"],
  ["/riscq-disasm.js", "studio/riscq-disasm.js"],
  ["/riscq-glossary.js", "studio/riscq-glossary.js"],
  ["/riscq-design", "studio/riscq-design.html"],
  ["/riscq-design.js", "studio/riscq-design.js"],
  ["/riscq-design.css", "studio/riscq-design.css"],
  ["/riscq-design-doc.js", "studio/riscq-design-doc.js"],
  // Home page, tutorial and the menu bar every page loads.
  ["/home.css", "studio/home.css"],
  ["/learn", "studio/learn.html"],
  ["/site-nav.js", "studio/site-nav.js"],
  // Optics: Gaussian beams through each platform's optical bench, and the world the stage draws.
  ["/riscq-optics.js", "studio/riscq-optics.js"],
  ["/riscq-benches.js", "studio/riscq-benches.js"],
  ["/riscq-world.js", "studio/riscq-world.js"],
  ["/riscq-light.js", "studio/riscq-light.js"],
  ["/riscq-beamview.js", "studio/riscq-beamview.js"],
  ["/docs/riscq-workspace.md", "docs/riscq-workspace.md"],
  ["/docs/media/riscq-ions.gif", "docs/media/riscq-ions.gif"],
  ["/docs/media/riscq-atoms.gif", "docs/media/riscq-atoms.gif"],
  ["/docs/media/riscq-feedforward.gif", "docs/media/riscq-feedforward.gif"],
  ["/docs/media/riscq-decoder.gif", "docs/media/riscq-decoder.gif"],
  ["/docs/media/riscq-design.png", "docs/media/riscq-design.png"],
  ["/model/RiscQ/Soc.lean", "QControl/RiscQ/Soc.lean"],
  ["/model/RiscQ/Timing.lean", "QControl/RiscQ/Timing.lean"],
  ["/model/RiscQ/Rv32.lean", "QControl/RiscQ/Rv32.lean"],
  ["/docs/riscq-controller.md", "docs/riscq-controller.md"],
  ["/machines", "studio/machines.html"],
  ["/machines.js", "studio/machines.js"],
  ["/machine-scene.js", "studio/machine-scene.js"],
  ["/device-scene.js", "studio/device-scene.js"],
  ["/h2-electrode-face.js", "studio/h2-electrode-face.js"],
  ["/apparatus.js", "machine/apparatus.mjs"],
  ["/machine/interconnect.mjs","machine/interconnect.mjs"],
  ...["ion-installation", "neutral-installation", "cryo-installation", "provenance", "installation-display","interconnect","wiring"].map(name => ["/" + name + ".mjs", "machine/" + name + ".mjs"]),
  ...["ion-hardware", "neutral-hardware", "cryo-hardware", "pulse-inspector","wire-inspector","wire-section"].map(name => ["/" + name + ".js", "studio/" + name + ".js"]),
  ["/installation-display.js", "machine/installation-display.mjs"],
  ["/installation-lens.js", "studio/installation-lens.js"],
  ["/register-view.js", "studio/register-view.js"],
  ["/machines.css", "studio/machines.css"],
  ["/", "studio/home.html"],
  ["/feedforward", "studio/index.html"],
  ["/style.css", "studio/style.css"],
  ["/app.js", "studio/app.js"],
  ["/scene.js", "studio/scene.js"],
  ["/scope.js", "studio/scope.js"],
  ["/qccd", "studio/index.html"],
  ["/controller", "studio/index.html"],
  ["/validation", "studio/validation.html"],
  ["/board-validation", "studio/board-validation.html"],
  ["/board-validation.js", "studio/board-validation.js"],
  ["/board-deadlines.mjs", "validation/board/deadlines.mjs"],
  ["/board-validation.css", "studio/board-validation.css"],
  ["/board-capture-format", "docs/controller-capture.md"],
  ["/api/board-validation/results", "validation/board/results.json"],
  ["/validation.js", "studio/validation.js"],
  ["/validation.css", "studio/validation.css"],
  ["/validation-scene.js", "studio/validation-scene.js"],
  ["/api/validation/results", "validation/results.json"],
  ["/api/validation/neutral/design", "validation/neutral/design.json"],
  ["/api/validation/qccd/design", "validation/qccd/design.json"],
  ["/api/validation/qccd/h2-design", "validation/qccd/h2-design.json"],
  ["/api/validation/qccd/h2-tsir", "validation/qccd/h2-theta1.tsir.json"],
  ["/api/validation/superconducting/design", "validation/superconducting/metal-layout.json"],
  ["/controller.js", "studio/controller.js"],
  ["/examples/waveform-controller.json", "examples/waveform-controller.json"],
  ["/model/Controller.lean", "QControl/Controller.lean"],
  ["/neutral", "studio/index.html"],
  ["/neutral.js", "studio/neutral.js"],
  ["/atom-scene.js", "studio/atom-scene.js"],
  ["/metric-stage.js", "studio/metric-stage.js"],
  ["/atom-installation.js", "studio/atom-installation.js"],
  ["/qccd-installation.js", "studio/qccd-installation.js"],
  ["/model/NeutralLayout.lean", "QControl/NeutralLayout.lean"],
  ["/examples/neutral-aod.json", "examples/neutral-aod.json"],
  ["/model/Neutral.lean", "QControl/Neutral.lean"],
  ["/qccd-studio", "studio/studio-replay.html"],
  ["/studio-replay.js", "studio/studio-replay.js"],
  ["/topology-scene.js", "studio/topology-scene.js"],
  ["/studio-replay.css", "studio/studio-replay.css"],
  ["/model/StudioPlacement.lean", "QControl/StudioPlacement.lean"],
  ["/qccd.js", "studio/qccd.js"],
  ["/trap-scene.js", "studio/trap-scene.js"],
  ["/examples/qccd-broadcast.json", "examples/qccd-broadcast.json"],
  ["/model/QCCD.lean", "QControl/QCCD.lean"],
  ["/examples/feedforward.json", "examples/feedforward.json"],
  ["/model/QControl.lean", "QControl.lean"],
  ["/three/three.module.js", "node_modules/three/build/three.module.js"],
  ["/three/three.core.js", "node_modules/three/build/three.core.js"],
  [
    "/three/OrbitControls.js",
    "node_modules/three/examples/jsm/controls/OrbitControls.js",
  ],
]);
const mime = {
  ".mjs": "text/javascript",
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".md": "text/markdown",
  ".lean": "text/plain",
  ".gif": "image/gif",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * The course: /course/… is served from studio/course/. A folder gives its index.html, a name
 * without an extension its .html file. Names are letters, digits, "-", "_" and "." only.
 */
function courseAsset(pathname) {
  if (pathname !== "/course" && !pathname.startsWith("/course/")) return undefined;
  const rest = pathname.slice("/course".length).replace(/^\//, "");
  if (rest.split("/").some((part) => part === ".." || !/^[A-Za-z0-9._-]*$/.test(part))) return undefined;
  const file = rest === "" || rest.endsWith("/") ? rest + "index.html" : path.extname(rest) ? rest : rest + ".html";
  return path.join("studio", "course", file);
}

function jsonProcess(command, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { windowsHide: true, ...options },
      (error, stdout, stderr) => {
        if (error) {
          let diagnostic;
          try {
            diagnostic = JSON.parse(stdout).error;
          } catch {}
          reject(new Error(diagnostic || stderr.trim() || error.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

const leanOptions = { timeout: 15000, maxBuffer: 16000000 };
const machineOptions = { timeout: 45000, maxBuffer: 64000000 };
export async function runMachine(
  { design, source, sourceName, exercise },
  compileOnly = false,
  apparatusVersion = 2,
) {
  if (
    sourceName !== undefined &&
    (typeof sourceName !== "string" ||
      !sourceName.length ||
      sourceName.length > 300)
  )
    throw Error("Invalid source name.");
  let { program, sourceMap, delivery } = compile(design, source);
  const equipment =
    design.device &&
    apparatus(design.device, design.parts, design.wires, apparatusVersion);
  let steeringModel;
  if (exercise !== undefined) {
    if (
      exercise?.kind === "neutral-steering" &&
      design.device?.kind === "atom" &&
      design.device.mounting
    ) {
      const { neutralSteeringProgram, neutralSteeringResult } = await import(
        "./machine/neutral-installation.mjs"
      );
      program = neutralSteeringProgram(
        design.device,
        exercise.lane,
        exercise.frequenciesHz,
        design.parts,
        equipment,
      );
      steeringModel = neutralSteeringResult;
    } else {
      if (
        exercise?.kind !== "h2-dc" ||
        design.device?.kind !== "ion" ||
        !design.device.mounting ||
        !Number.isInteger(exercise.channel) ||
        exercise.channel < 1 ||
        exercise.channel > 268 ||
        !Array.isArray(exercise.words) ||
        exercise.words.length < 1 ||
        exercise.words.length > 128 ||
        !exercise.words.every(
          (n) => Number.isInteger(n) && n >= -32768 && n <= 32767,
        )
      )
        throw Error(
          "Supply an H2 reference DC channel from 1 to 268 and 1–128 signed 16-bit sample words.",
        );
      const { ionDcProgram } = await import("./machine/ion-installation.mjs");
      program = ionDcProgram(
        design.device,
        exercise.channel,
        exercise.words,
        design.parts,
        equipment,
      );
    }
    sourceMap = program.images.flatMap((im) =>
      im.code.map((ins, i) => ({
        id: ins.source,
        controller: im.controller,
        operation: typeof ins.op === "string" ? ins.op : Object.keys(ins.op)[0],
        origin:
          (steeringModel
            ? "AOD " + exercise.lane
            : "DC channel " + exercise.channel) +
          " · instruction " +
          i,
      })),
    );
    delivery = undefined;
  }
  const result = await jsonProcess(
    executable,
    compileOnly ? ["--check-machine"] : [],
    JSON.stringify(program),
    machineOptions,
  );
  if (compileOnly)
    return { program, sourceMap, ...(delivery ? { delivery } : {}) };
  const steering =
    steeringModel && result.stop === "completed"
      ? steeringModel(program, result)
      : null;
  if (steering) {
    const q =
      design.device.qubits.find((q) => q.id === "q[0]") ??
      design.device.qubits[0];
    steering.originMm = q.positionMm.map((v, i) => v + (i === 2 ? 0.012 : 0));
    steering.basis +=
      " The exercise coordinate origin is 12 µm along device z from " +
      q.id +
      ".";
  }
  if (steering?.neutralProgram) {
    const run = await simulate(JSON.stringify(steering.neutralProgram));
    steering.placement = { initial: run.initial, frames: run.frames };
  }
  return {
    design,
    source,
    ...(sourceName ? { sourceName } : {}),
    ...(exercise ? { exercise } : {}),
    sourceMap,
    trace: result,
    ...(steering ? { steering } : {}),
    ...(delivery
      ? {
          delivery,
          terminalActivity: terminalActivity(delivery, result.frames),
        }
      : {}),
    ...(design.device
      ? {
          deviceActivity: deviceActivity(design.device, result.frames),
          apparatus: equipment,
        }
      : {}),
  };
}
export function simulate(input, { checkTrace = false } = {}) {
  return jsonProcess(
    executable,
    checkTrace ? ["--check-trace"] : [],
    input,
    leanOptions,
  );
}

function studioBridge(input, flags = []) {
  const python = process.env.QCONTROL_PYTHON || "python";
  return jsonProcess(
    python,
    ["-B", "-X", "utf8", path.join(root, "bridge", "qccd_studio.py"), ...flags],
    input,
    { timeout: flags.includes("--studio-html") ? 120000 : 45000, maxBuffer: 32000000 },
  );
}

export async function replayStudio(input) {
  const run = await studioBridge(input);
  const witness = await jsonProcess(
    executable,
    ["--check-studio-placement"],
    JSON.stringify(run),
    leanOptions,
  );
  return { ...run, placementCheck: witness };
}

async function readInput(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(
        new Error("Input exceeds " + limit / 1024 + " KiB."),
        { status: 413 },
      );
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(res, status, type, body) {
  res.writeHead(status, {
    "Content-Type": type + "; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.QCONTROL_PORT || 7432);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && ["/api/board-validation/design", "/api/board-validation/capture"].includes(url.pathname)) {
        const bench = await import("./validation/board/bench.mjs");
        const id = url.searchParams.get("case");
        const result = url.pathname.endsWith("/design")
          ? bench.debugDesign(id, Number(url.searchParams.get("row") ?? 0))
          : await bench.replayCapture(id, runMachine);
        return reply(res, 200, "application/json", JSON.stringify(result));
      }
      if (req.method === "GET" && url.pathname === "/api/machines/examples")
        return reply(res, 200, "application/json", JSON.stringify(machineExamples));
      if (req.method === "POST" && ["/api/machines/run", "/api/machines/compile", "/api/machines/ports"].includes(url.pathname)) {
        const input = await readInput(req, 1024 * 1024);
        const result = url.pathname.endsWith("/ports")
          ? await jsonProcess(executable, ["--component-ports"], input, leanOptions)
          : await runMachine(JSON.parse(input), url.pathname.endsWith("/compile"));
        return reply(res, 200, "application/json", JSON.stringify(result));
      }
      if (req.method === "POST" && url.pathname === "/api/validation/replay") {
        const input = await readInput(req, 32768);
        const result = await jsonProcess(process.env.QCONTROL_PYTHON || "python",
          ["-B", "-X", "utf8", path.join(root, "validation", "run.py"), "--replay"], input,
          {timeout: 90000, maxBuffer: 16000000});
        return reply(res, 200, "application/json", JSON.stringify(result));
      }
      if (url.pathname === "/api/riscq/examples" && req.method === "GET") {
        const { examples } = await import("./riscq/examples.mjs");
        return reply(res, 200, "application/json", JSON.stringify(
          examples.map(({ id, platform, title, description, source }) => ({ id, platform, title, description, language: source.language }))));
      }
      if (url.pathname.startsWith("/api/riscq/design")) {
        // Hardware designs (riscq/design.mjs). GET /api/riscq/design?template=ring|ring-decoder
        // gives a design to edit and the program the editor runs on it, GET …/rules the allowed
        // components and wire media, and POST …/check a design's rule check, its derived wire
        // timing and, when it breaks no rule, the delay of every calibrated pulse.
        const { designService } = await import("./riscq/design-service.mjs");
        const body = req.method === "POST" ? JSON.parse(await readInput(req, 4 * 1024 * 1024)) : undefined;
        return reply(res, 200, "application/json", JSON.stringify(
          designService(url.pathname.slice("/api/riscq/design".length) || "/", Object.fromEntries(url.searchParams), body)));
      }
      if (url.pathname === "/api/riscq/run" && ["GET", "POST"].includes(req.method)) {
        // GET ?example=<id>&outcome=<bit>=<0|1>… runs a reference program. POST takes
        // { example }, { platform: "superconducting" | "qccd", qasm } or
        // { platform: "superconducting", calls } with optional outcomes and trace.
        const { run } = await import("./riscq/examples.mjs");
        const request = req.method === "POST" ? JSON.parse(await readInput(req, 4 * 1024 * 1024))
          : { example: url.searchParams.get("example"), trace: url.searchParams.get("trace") ?? undefined,
              outcomes: Object.fromEntries(url.searchParams.getAll("outcome").map((o) => [o.split("=")[0], Number(o.split("=")[1])])) };
        return reply(res, 200, "application/json", JSON.stringify(await run(request)));
      }
      if (req.method === "POST" && url.pathname === "/api/run") {
        const result = await simulate(await readInput(req, 1024 * 1024));
        return reply(res, 200, "application/json", JSON.stringify(result));
      }
      if (req.method === "GET" && url.pathname === "/api/studio/h2") {
        return reply(
          res,
          200,
          "application/json",
          JSON.stringify(await studioBridge("", ["--demo"])),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/studio/replay") {
        const run = await replayStudio(await readInput(req, 4 * 1024 * 1024));
        return reply(res, 200, "application/json", JSON.stringify(run));
      }
      if (req.method === "POST" && url.pathname === "/api/studio/editor") {
        const page = await studioBridge(await readInput(req, 4 * 1024 * 1024), [
          "--studio-html",
        ]);
        return reply(res, 200, "application/json", JSON.stringify(page));
      }
      const asset = routes.get(url.pathname) ?? courseAsset(url.pathname);
      if (req.method !== "GET" || !asset)
        return reply(res, 404, "text/plain", "Unknown resource.");
      const body = await readFile(path.join(root, asset));
      reply(res, 200, mime[path.extname(asset)] || "text/plain", body);
    } catch (error) {
      reply(res, error.status || 400, "text/plain", error.message);
    }
  });
  server.listen(port, "127.0.0.1", () =>
    console.log("QControl Studio at http://127.0.0.1:" + port),
  );
}
