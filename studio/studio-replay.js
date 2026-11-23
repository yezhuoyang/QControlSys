import { createTopologyScene } from "./topology-scene.js";
import { createPhysicalViews } from "./metric-stage.js";
import {
  buildQccdInstallation,
  studioCycleParts,
} from "./qccd-installation.js";

const $ = (id) => document.getElementById(id);
const number = (n) =>
  Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 });
let run,
  files,
  index = -1,
  chosen = null,
  timer,
  request = 0;
let checkpoints,
  positions,
  rowByIndex = new Map();
const pageSize = 80;
let matching = [],
  pageNumber = 0;
const scene = createTopologyScene($("viewport"), (pick) => {
  chosen = pick;
  paint();
});
const metric = createPhysicalViews(
  $("viewport"),
  buildQccdInstallation,
  (part) => {
    chosen = part ? { kind: "part", id: part } : null;
    paint();
  },
  () => {
    if (run && positions) scene.show(run.frames[index], positions, chosen);
  },
);
const button = (label, action) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.onclick = action;
  return b;
};
function note(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}
function stop() {
  clearInterval(timer);
  timer = null;
  $("play").textContent = "Play";
}
function save(name, text) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function applyDelta(map, frame) {
  for (const [ion, site] of Object.entries(frame.positions)) map.set(ion, site);
}
function buildCheckpoints() {
  const p = new Map(Object.entries(run.initial.positions));
  checkpoints = [new Map(p)];
  run.frames.forEach((f, i) => {
    applyDelta(p, f);
    if ((i + 1) % 32 === 0) checkpoints.push(new Map(p));
  });
}
function jump(i, fromPlayer = false) {
  if (!fromPlayer) stop();
  const old = rowByIndex.get(index);
  if (old) old.removeAttribute("aria-current");
  const next = Math.min(run.frames.length - 1, Math.max(-1, i));
  if (next === index + 1 && positions && next >= 0)
    applyDelta(positions, run.frames[next]);
  else {
    const base = Math.floor((next + 1) / 32);
    positions = new Map(checkpoints[base]);
    for (let j = base * 32; j <= next; j++)
      applyDelta(positions, run.frames[j]);
  }
  index = next;
  if (index >= 0 && !rowByIndex.has(index)) {
    const position = matching.indexOf(index);
    if (position >= 0) renderRows(Math.floor(position / pageSize));
  }
  paint();
}
function paint() {
  if (!run) return;
  const f = run.frames[index],
    ids = f?.ions ?? [];
  $("eventTime").replaceChildren(
    document.createTextNode(number(f?.end ?? 0) + " "),
    Object.assign(document.createElement("small"), {
      textContent: run.timing.unit,
    }),
  );
  $("eventTitle").textContent = f?.label ?? "Initial state";
  $("sourceRef").textContent = f
    ? "TSIR #" +
      f.sourceId +
      " · cycle " +
      (index + 1) +
      " · " +
      number(f.start) +
      " to " +
      number(f.end) +
      " " +
      run.timing.unit
    : "Before the first instruction.";
  $("moves").replaceChildren();
  const lines = f?.moves?.length
    ? f.moves.map((m) => m.ion + " · " + m.from + " → " + m.to)
    : ids.map((id) => id + " · " + (positions.get(id) ?? "unplaced"));
  for (const line of lines)
    $("moves").append(
      Object.assign(document.createElement("div"), { textContent: line }),
    );
  if (!lines.length)
    $("moves").textContent = f?.targets?.join(", ") || "No addressed ions.";
  const c = f?.control;
  $("driver").textContent = c
    ? [
        c.driver,
        c.action,
        c.channelsEngaged != null && c.channelsTotal != null
          ? c.channelsEngaged + " / " + c.channelsTotal + " channels"
          : null,
        c.feasible === false ? "Infeasible dispatch" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "No control dispatch recorded.";
  $("bankDetail").hidden = !c?.banks?.length;
  $("banks").replaceChildren(
    ...(c?.banks ?? []).map((bank) =>
      Object.assign(document.createElement("p"), {
        textContent:
          bank.channels.join(", ") +
          " · " +
          bank.action +
          " · " +
          bank.actingPerChannel +
          " / " +
          bank.fanoutPerChannel +
          " recipients per channel",
      }),
    ),
  );
  $("causes").replaceChildren();
  if (f?.parents?.length)
    for (const parent of f.parents)
      $("causes").append(
        button(parent, () =>
          jump(run.frames.findIndex((s) => s.id === parent)),
        ),
      );
  else $("causes").textContent = "Program start";
  if (chosen) {
    const isIon = chosen.kind === "ion",
      id = chosen.id;
    const occupants = [...positions]
      .filter(([, site]) => site === id)
      .map(([ion]) => ion);
    const info =
      chosen.kind === "part"
        ? (run.system.parts.find((p) => p.id === id)?.label ?? id)
        : isIon
          ? "Ion " + id + " · " + (positions.get(id) ?? "unplaced")
          : "Site " + id + " · " + (occupants.join(", ") || "empty");
    $("selection").replaceChildren(
      document.createTextNode(info),
      document.createElement("br"),
    );
    const matches = run.frames
      .map((fr, i) =>
        (chosen.kind === "part"
          ? studioCycleParts(fr)
          : isIon
            ? fr.ions
            : fr.targets
        ).includes(id)
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    if (matches.length)
      $("selection").append(
        button("Next associated cycle", () =>
          jump(matches.find((i) => i > index) ?? matches[0]),
        ),
      );
    $("selection").append(
      button("Clear selection", () => {
        chosen = null;
        paint();
      }),
    );
  } else
    $("selection").textContent =
      "Select a component in the physical system or an ion in the trap topology.";
  $("instruction").textContent = f
    ? JSON.stringify(run.sourceInstructions[f.sourceIndex], null, 2)
    : "Before the first instruction.";
  $("counter").textContent = index + 1 + " / " + run.frames.length;
  $("step").value = index + 1;
  $("back").disabled = index < 0;
  $("next").disabled = index === run.frames.length - 1;
  rowByIndex.get(index)?.setAttribute("aria-current", "true");
  if (!metric.active) scene.show(f, positions, chosen);
  metric.show(f, chosen?.kind === "part" ? chosen.id : null, positions);
}
function renderRows(page) {
  pageNumber = page;
  const start = page * pageSize,
    fragment = document.createDocumentFragment();
  rowByIndex = new Map();
  matching.slice(start, start + pageSize).forEach((i) => {
    const f = run.frames[i];
    const values = [
      String(i + 1),
      String(f.sourceId),
      f.label,
      f.targets.join(", "),
      number(f.end),
    ];
    const row = document.createElement("tr");
    values.forEach((value, j) => {
      const td = document.createElement("td");
      if (j === 2) td.append(button(value, () => jump(i)));
      else td.textContent = value;
      row.append(td);
    });
    row.onclick = (e) => {
      if (e.target.tagName !== "BUTTON") jump(i);
    };
    if (index === i) row.setAttribute("aria-current", "true");
    rowByIndex.set(i, row);
    fragment.append(row);
  });
  if (!rowByIndex.size) {
    const row = document.createElement("tr"),
      cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No matching cycles.";
    row.append(cell);
    fragment.append(row);
  }
  $("rows").replaceChildren(fragment);
  $("prevRows").disabled = page === 0;
  $("nextRows").disabled = start + pageSize >= matching.length;
  $("rowRange").textContent = matching.length
    ? start +
      1 +
      "–" +
      Math.min(matching.length, start + pageSize) +
      " of " +
      matching.length
    : "0 matches";
}
function rows() {
  const text = $("filter").value.trim().toLowerCase();
  matching = [];
  run.frames.forEach((f, i) => {
    if (
      !text ||
      [
        String(i + 1),
        String(f.sourceId),
        f.label,
        f.id,
        ...f.targets,
        ...f.ions,
      ].some((v) => v.toLowerCase().includes(text))
    )
      matching.push(i);
  });
  renderRows(0);
}
function evidence() {
  $("metrics").replaceChildren();
  const stats = [
    ["Trap sites", run.machine.nodes.length],
    ["Ions", run.summary.ions],
    ["TSIR instructions", run.program.instructions],
    ["Replay cycles", run.frames.length],
    ["Two-qubit gates", run.summary.gatePairs],
    ["Measurements", run.summary.measurements],
  ];
  for (const [label, value] of stats) {
    const d = document.createElement("div");
    d.append(
      Object.assign(document.createElement("dt"), { textContent: label }),
      Object.assign(document.createElement("dd"), {
        textContent: number(value),
      }),
    );
    $("metrics").append(d);
  }
  $("geometryNote").textContent = run.machine.geometryNote;
  $("timeNote").textContent = run.timing.note;
  $("rules").replaceChildren();
  for (const key of ["passed", "failed", "partial", "skipped"]) {
    const raw = run.rules[key] ?? [],
      items = Array.isArray(raw) ? raw : Object.keys(raw);
    const p = document.createElement("p");
    p.textContent =
      key[0].toUpperCase() +
      key.slice(1) +
      " · " +
      (items.join(", ") || "none");
    $("rules").append(p);
    if (!Array.isArray(raw))
      for (const [id, why] of Object.entries(raw)) {
        if (typeof why === "string")
          $("rules").append(
            Object.assign(document.createElement("p"), {
              className: "subtle",
              textContent: id + " · " + why,
            }),
          );
      }
  }
  for (const detail of run.rules.details || []) {
    const p = document.createElement("p");
    p.append(
      document.createTextNode(detail.rule + " · " + detail.message + " "),
    );
    const at = run.frames.findIndex((f) => f.sourceId === detail.sourceId);
    if (at >= 0)
      p.append(button("Inspect #" + detail.sourceId, () => jump(at)));
    $("rules").append(p);
  }
}
async function response(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function load(readFiles, demo = false) {
  const serial = ++request;
  stop();
  $("runState").textContent = "Running Studio replay…";
  note("alert", "");
  note("importError", "");
  try {
    const source = await readFiles();
    const result = await response("/api/studio/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        architecture: source.architecture,
        program: source.program,
      }),
    });
    if (serial !== request) return;
    run = result;
    files = source;
    positions = null;
    chosen = null;
    index = -1;
    $("machineTitle").textContent = demo
      ? "H2 racetrack · 32-qubit GHZ"
      : run.machine.name + " · " + run.program.name;
    $("filter").value = "";
    $("step").max = run.frames.length;
    $("step").disabled = $("play").disabled = !run.frames.length;
    $("export").disabled = $("saveArch").disabled = false;
    $("saveTSIR").disabled = !source.program;
    $("native").disabled = false;
    $("saveArch").textContent = source.program
      ? "Save machine file"
      : "Save Studio design";
    $("sourceNames").textContent = [source.archName, source.progName]
      .filter(Boolean)
      .join(" · ");
    buildCheckpoints();
    scene.setMachine(run.machine);
    metric.load(run);
    evidence();
    rows();
    jump(
      demo
        ? run.frames.findIndex((f) => f.op === "simd")
        : run.frames.length
          ? 0
          : -1,
    );
    $("runState").textContent = run.summary.ruleViolations
      ? "Studio rule violations · " + run.summary.ruleViolations
      : "Placement replay checked";
    $("runState").classList.toggle(
      "fault",
      Boolean(run.summary.ruleViolations),
    );
    $("importer").close();
  } catch (err) {
    if (serial !== request) return;
    note($("importer").open ? "importError" : "alert", err.message);
    $("runState").textContent = run
      ? "Showing previous replay"
      : "Replay unavailable";
    if (!run)
      $("machineTitle").textContent =
        "Open a QCCD Studio machine and program to inspect its trap topology.";
  }
}
const demoFiles = async () => ({
  ...(await response("/api/studio/h2")),
  archName: "h2.arch.json",
  progName: "ghz32.tsir.json",
});
$("bench").onchange = (e) => location.assign(e.target.value);
$("open").onclick = () => {
  stop();
  note("importError", "");
  $("importer").showModal();
};
$("demo").onclick = () => load(demoFiles, true);
$("importForm").onsubmit = (e) => {
  e.preventDefault();
  const a = $("archFile").files[0],
    p = $("progFile").files[0];
  const read = async (file) =>
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await file.arrayBuffer(),
    );
  load(async () => ({
    architecture: await read(a),
    program: p ? await read(p) : undefined,
    archName: a.name,
    progName: p?.name,
  }));
};
$("resetView").onclick = () => (metric.active ? metric.home() : scene.home());
$("filter").oninput = () => {
  if (run) rows();
};
$("prevRows").onclick = () => renderRows(pageNumber - 1);
$("nextRows").onclick = () => renderRows(pageNumber + 1);
$("step").oninput = (e) => jump(Number(e.target.value) - 1);
$("back").onclick = () => jump(index - 1);
$("next").onclick = () => jump(index + 1);
$("play").onclick = () => {
  if (timer) {
    stop();
    return;
  }
  if (index >= run.frames.length - 1) jump(-1);
  $("play").textContent = "Pause";
  timer = setInterval(() => {
    jump(index + 1, true);
    if (index === run.frames.length - 1) stop();
  }, 420);
};
$("export").onclick = () =>
  save("qccd-studio-trace.json", JSON.stringify(run, null, 2));
$("saveArch").onclick = () => save(files.archName, files.architecture);
$("saveTSIR").onclick = () => save(files.progName, files.program);
let nativeRequest = 0;
$("native").onclick = async () => {
  stop();
  const serial = ++nativeRequest;
  $("nativeDialog").showModal();
  $("nativePage").hidden = true;
  note("nativeStatus", "Opening the local QCCD Studio editor…");
  try {
    const { html } = await response("/api/studio/editor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        architecture: files.architecture,
        program: files.program,
      }),
    });
    if (serial !== nativeRequest) return;
    // A sandboxed Studio cannot retain file-system handles. Use its built-in
    // file-input and download path, including for the native Save project action.
    const useDownloads = "<script>window.showSaveFilePicker=undefined;window.showOpenFilePicker=undefined;<\/script>";
    const policy =
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; worker-src blob:; form-action 'none'; base-uri 'none'";
    $("nativePage").srcdoc = html.replace(
      /<head\b[^>]*>/i,
      (head) =>
        head +
        '<meta http-equiv="Content-Security-Policy" content="' +
        policy +
        '">' + useDownloads,
    );
    $("nativePage").hidden = false;
    note("nativeStatus", "");
  } catch (err) {
    if (serial === nativeRequest) note("nativeStatus", err.message);
  }
};
$("closeNative").onclick = () => $("nativeDialog").close();
$("nativeDialog").onclose = () => {
  nativeRequest++;
  $("nativePage").removeAttribute("srcdoc");
};
document.addEventListener("keydown", (e) => {
  if (
    !run ||
    $("importer").open ||
    e.target.closest("input,select,button,textarea")
  )
    return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    jump(index + (e.key === "ArrowLeft" ? -1 : 1));
  }
});
if (new URLSearchParams(location.search).get("experiment")==="h2-parity") {
  await load(async () => {
    const phase=new URLSearchParams(location.search).get("phase") || "1";
    const [files,record,program]=await Promise.all([demoFiles(),response("/api/validation/qccd/h2-design"),
      fetch("/api/validation/qccd/h2-tsir")]);
    const source=record.phases?.[phase];
    if(!program.ok || !source)throw Error("Unknown H2 analysis phase.");
    let tsir=await program.text();
    for(const [before,after] of source.replacements)tsir=tsir.replaceAll(before,after);
    // The native TSIR uses extended numeric literals. Check the exact published export as text.
    const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(tsir));
    const hex=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
    if(hex!==source.programSha256)throw Error("The compiled H2 phase program does not match its recorded digest.");
    return {...files,program:tsir,progName:"h2-theta"+phase+".tsir.json"};
  });
} else {
  await load(demoFiles, true);
}
