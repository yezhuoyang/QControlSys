import { createScene, parts } from "./scene.js";
import { createScope } from "./scope.js";
import { createTrapScene } from "./trap-scene.js";
import * as trap from "./qccd.js";
import { createAtomScene } from "./atom-scene.js";
import * as atom from "./neutral.js";
import * as stream from "./controller.js";
import { createPhysicalViews } from "./metric-stage.js";

const $ = (id) => document.getElementById(id);
const qccd = location.pathname === "/qccd";
const neutral = location.pathname === "/neutral";
const controller = location.pathname === "/controller";
const modality = qccd ? trap : neutral ? atom : controller ? stream : null;
const benchFile = qccd
  ? "qccd-broadcast"
  : neutral
    ? "neutral-aod"
    : controller ? "waveform-controller" : "feedforward";
const vocabulary = modality?.operations ?? {
  acquire: [
    "Open acquisition window",
    "The readout converter begins the scripted two-channel acquisition.",
  ],
  markerOn: [
    "Raise start marker",
    "Board B raises its reference output at the start of the experiment.",
  ],
  markerOff: [
    "Lower start marker",
    "The 20 ns reference marker returns to its idle level.",
  ],
  digitize: [
    "Close acquisition window",
    "The readout emulator supplies the two-bit observation at the end of the window.",
  ],
  classify: [
    "Commit measurement word",
    "Board A commits the classified word after the configured processing delay.",
  ],
  pack: [
    "Load transmit register",
    "The optical transmitter accepts the classified word for transmission.",
  ],
  transmit: [
    "Transmit measurement",
    "The transmitter places the two measurement bits on the digital fiber link.",
  ],
  receive: [
    "Receive measurement",
    "The remote transceiver commits the word to the receiver register.",
  ],
  sample: [
    "Sample receiver register",
    "The receiver samples once on its programmed clock edge.",
  ],
  lookup: [
    "Read waveform memory",
    "The latched word selects a list of conditional RF pulse amplitudes.",
  ],
  drive: [
    "Drive RF envelope",
    "The output converter begins the selected pulse at its stored amplitude.",
  ],
  release: [
    "Return output to idle",
    "The selected envelope ends and the output amplitude returns to zero.",
  ],
  finish: [
    "Complete program",
    "All scheduled events have retired. The final registers remain available for inspection.",
  ],
};
const regNames = {
  acquiring: "Acquisition gate",
  digitized: "Observation",
  classified: "Classified word",
  packet: "Transmit register",
  inFlight: "Link payload",
  received: "Receive register",
  latched: "Branch register",
  bank: "Waveform bank",
  marker: "Start marker",
  outputMv: "DAC envelope",
  emitted: "Emitted pulses",
  fault: "Deadline fault",
  done: "Program complete",
};
function value(k, v) {
  if (v === null) return "empty";
  if (typeof v === "boolean") return v ? "high" : "low";
  if (Array.isArray(v)) return v.length ? v.join(", ") + " mV" : "[]";
  if (
    [
      "received",
      "latched",
      "digitized",
      "classified",
      "packet",
      "inFlight",
    ].includes(k)
  )
    return v.toString(2).padStart(2, "0");
  if (k === "outputMv") return v + " mV";
  return String(v);
}
function textNode(cls, text) {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}
function btn(text, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.addEventListener("click", fn);
  return b;
}
let run,
  index = -1,
  chosen = null,
  timer = null,
  moving = false,
  serial = 0,
  busy = false;
$("bench").value = location.pathname;
$("bench").onchange = () => location.assign($("bench").value);
if (qccd) {
  document.title = "QCCD broadcast · QControl Studio";
  document.querySelector("h1").textContent = "QCCD broadcast bench";
  document.querySelector(".heading p").textContent =
    "Shared electrode transport and independently addressed gate light";
  $("move").textContent = "Edit wiring";
  $("move").removeAttribute("aria-pressed");
  $("wiring").hidden = false;
  $("signalLegend").hidden = false;
  $("bits").closest(".config").hidden = true;
  document.querySelector(".instrument:has(#scope) p").textContent =
    "Shared drive voltage, lane displacements and optical gate timing";
  document.querySelector("#editor p").textContent =
    "Times are in nanoseconds, voltages in millivolts and ion displacement in micrometres.";
  document.querySelector("#editor a").href = "/model/QCCD.lean";
}
if (neutral) {
  document.title = "Neutral-atom AOD · QControl Studio";
  document.querySelector("h1").textContent = "Neutral-atom steering bench";
  document.querySelector(".heading p").textContent =
    "FPGA tone commands, acoustic propagation and shared optical traps";
  $("move").textContent = "Edit tones";
  $("move").removeAttribute("aria-pressed");
  $("neutralControls").hidden = false;
  $("signalLegend").hidden = false;
  [...$("signalLegend").children].forEach(
    (el, i) => (el.textContent = ["X steering", "Y steering", "Trap site"][i]),
  );
  $("bits").closest(".config").hidden = true;
  document.querySelector(".instrument:has(#scope) p").textContent =
    "RF command and acoustic delivery for each moved tone. Each pair spans its programmed range (Δ in kHz).";
  document.querySelector("#editor p").textContent =
    "Time is in nanoseconds, frequency in kilohertz and trap position in nanometres.";
  document.querySelector("#editor a").href = "/model/Neutral.lean";
}
if (controller) {
  document.title = "FPGA waveform controller · QControl Studio";
  document.querySelector("h1").textContent = "FPGA waveform controller";
  document.querySelector(".heading p").textContent = "Instruction issue, waveform RAM and buffered DAC playback on the reference control rack";
  $("controllerPanel").hidden = false;
  $("move").hidden = true;
  $("bits").closest(".config").hidden = true;
  document.querySelector(".instrument:has(#scope) p").textContent = "FIFO occupancy, signed DAC samples and filtered output voltage. Inspect a strobe for exact values.";
  document.querySelector("#editor p").textContent = "Edit the sequencer instructions, signed 16-bit waveform RAM or timing profile. Branch targets and RAM addresses start at zero.";
  document.querySelector("#editor a").href = "/model/Controller.lean";
}
const scene = controller ? null : (
  qccd ? createTrapScene : neutral ? createAtomScene : createScene
)(
  $("viewport"),
  (part) => {
    chosen = part;
    render();
  },
  async (role, position) => {
    if (!run) return;
    await load({ ...run.program, [role]: position }, run.frames[index]?.id);
  },
);
const scope = createScope($("scope"), (i) => jump(i), modality?.channels);
const metric = modality
  ? createPhysicalViews(
      $("viewport"),
      neutral
        ? (await import("./atom-installation.js")).buildAtomInstallation
        : (await import("./qccd-installation.js")).buildQccdInstallation,
      (part) => {
        chosen = part;
        render();
      },
      controller ? null : () => {
        if (run) scene.setFrame(run.frames[index], chosen);
      },
    )
  : null;
function stop() {
  clearInterval(timer);
  timer = null;
  $("play").textContent = "Play";
  $("play").setAttribute("aria-label", "Play trace");
}
function jump(i) {
  stop();
  if (!metric?.active) chosen = null;
  index = Math.max(-1, Math.min(i, run.frames.length - 1));
  render();
}
function alertMessage(msg) {
  $("alert").textContent = msg;
  $("alert").hidden = !msg;
}
function render() {
  if (!run) return;
  const frame = run.frames[index],
    s = frame?.state || run.initial,
    prior = index > 0 ? run.frames[index - 1].state : run.initial;
  const faultAtEdge = frame?.op === "sample" && s.fault;
  const stale = qccd ? s.lanes.filter((l) => l.stale).map((l) => l.id) : [];
  $("runState").textContent = stale.length
    ? "Stale selector · " + stale.join(", ")
    : s.fault
      ? "Deadline missed"
      : s.done
        ? "Run complete"
        : "Replay paused";
  if (timer && !s.fault && !s.done && !stale.length)
    $("runState").textContent = "Replaying";
  $("runState").classList.toggle("fault", Boolean(s.fault || stale.length));
  if (controller && (s.underruns || (s.reason && s.reason !== "halted"))) {
    $("runState").textContent = s.reason && s.reason !== "halted" ? s.reason : s.underruns + " DAC underrun" + (s.underruns === 1 ? "" : "s");
    $("runState").classList.add("fault");
  }
  $("eventTime").replaceChildren(
    document.createTextNode((frame?.atNs || 0).toLocaleString("en-US") + " "),
    Object.assign(document.createElement("small"), { textContent: "ns" }),
  );
  $("eventTitle").textContent = faultAtEdge
    ? "Sample deadline missed"
    : frame
      ? vocabulary[frame.op][0]
      : "Initial state";
  $("description").textContent = faultAtEdge
    ? "The receive register was empty at the sample edge. The fault is latched and conditional output is inhibited."
    : frame
      ? vocabulary[frame.op][1]
      : qccd
        ? "Ions occupy their origin wells. Each local selector holds its programmed reset value."
        : neutral
          ? "The initial RF tones define every trap intersection. The program assigns atoms to selected intersections."
          : controller ? "The input word is in the accumulator, the FIFO is empty and the DAC output is zero."
          : "Both boards are idle. Measurement and receiver registers are empty.";
  if (controller && frame?.sourcePc != null)
    $("description").textContent += "  PC " + frame.sourcePc + " · " + JSON.stringify(run.program.code[frame.sourcePc]);
  if (frame?.op === "strobe" && stale.length)
    $("description").textContent =
      "The selector update for " +
      stale.join(", ") +
      " missed the edge. The switch retained its previous setting for this waveform.";
  const rowsFor = (state, event) =>
    modality
      ? modality.registers(state, event)
      : Object.fromEntries(
          Object.entries(regNames).map(([k, name]) => [k, [name, state[k]]]),
        );
  if (frame?.op === "light") {
    const well = "Lane " + run.program.gateZone + "’s destination well";
    $("description").textContent =
      s.exposedIon === null
        ? well + " is illuminated and empty."
        : well +
          " is illuminated. Ion " +
          s.exposedIon +
          " occupies the addressed spot.";
  }
  const currentRows = rowsFor(s, frame),
    priorRows = rowsFor(prior, run.frames[index - 1]);
  const differences = Object.keys(currentRows).filter(
    (k) =>
      JSON.stringify(currentRows[k][1]) !== JSON.stringify(priorRows[k][1]),
  );
  $("changes").replaceChildren(
    ...differences.map((k) => {
      const d = document.createElement("div");
      d.className = "change";
      d.append(
        textNode("", currentRows[k][0] + " "),
        textNode("subtle", value(k, priorRows[k][1]) + " → "),
        Object.assign(document.createElement("b"), {
          textContent: value(k, currentRows[k][1]),
        }),
      );
      return d;
    }),
  );
  if (!differences.length)
    $("changes").append(
      textNode(
        "subtle",
        frame ? "Registers retain their values." : "Reset values.",
      ),
    );
  $("registers").replaceChildren(
    ...Object.entries(currentRows).flatMap(([key, [name, current]]) => {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = name;
      dd.textContent = value(key, current);
      return [dt, dd];
    }),
  );
  const parents = frame?.parents || [];
  $("causes").replaceChildren(
    ...parents.map((id) =>
      btn(id, () => jump(run.frames.findIndex((f) => f.id === id))),
    ),
  );
  if (!parents.length)
    $("causes").append(
      textNode("subtle", frame ? "Program start" : "No event selected."),
    );
  const showRecipients = (neutral || controller)
    ? Boolean(frame?.targets?.length)
    : qccd &&
      [
        "strobe",
        "knot",
        "settle",
        "launch",
        "endLaunch",
        "light",
        "dark",
      ].includes(frame?.op);
  $("recipientSection").hidden = !showRecipients;
  const targets = frame?.targets || [];
  $("recipients").replaceChildren(
    ...targets.map((id) =>
      btn(parts[id], () => {
        chosen = id;
        render();
      }),
    ),
  );
  if (!targets.length) $("recipients").textContent = "None";
  const part = chosen || frame?.part || (modality ? "controller" : "adc");
  $("selection").replaceChildren(textNode("selection-name", parts[part]));
  if (chosen) {
    const related = run.frames
      .map((f, i) =>
        f.part === chosen || f.targets?.includes(chosen) ? i : -1,
      )
      .filter((i) => i >= 0);
    $("selection").append(document.createElement("br"));
    if (related.length)
      $("selection").append(
        btn("Next associated event", () =>
          jump(related.find((i) => i > index) ?? related[0]),
        ),
      );
    else
      $("selection").append(
        textNode("subtle", "No associated event in this program."),
      );
    $("selection").append(
      btn("Follow event", () => {
        chosen = null;
        render();
      }),
    );
  }
  $("counter").textContent = index + 1 + " / " + run.frames.length;
  $("step").max = run.frames.length;
  $("step").value = index + 1;
  $("back").disabled = index < 0;
  $("next").disabled = index === run.frames.length - 1;
  for (const row of $("rows").children)
    row.setAttribute("aria-current", Number(row.dataset.index) === index);
  if (!metric?.active) scene?.setFrame(frame, chosen);
  metric?.show(frame, chosen);
  scope(run, index);
}
function buildRows() {
  const rows = run.frames.map((f, i) => {
    const tr = document.createElement("tr");
    tr.dataset.index = i;
    for (const v of [
      i + 1,
      f.atNs + " ns",
      vocabulary[f.op][0],
      parts[f.part],
      f.id,
    ]) {
      const cell = document.createElement("td");
      if (tr.children.length === 2) cell.append(btn(v, () => jump(i)));
      else cell.textContent = v;
      tr.append(cell);
    }
    tr.addEventListener("click", (e) => {
      if (e.target.tagName !== "BUTTON") jump(i);
    });
    return tr;
  });
  $("rows").replaceChildren(...rows);
}
async function load(program, startId = "acquire", editor = false) {
  const request = ++serial;
  stop();
  busy = true;
  try {
    if (program?.kind !== (modality ? benchFile : undefined))
      throw new Error("Open the matching bench before applying this program.");
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(program),
    });
    if (!res.ok) throw new Error(await res.text());
    const next = await res.json();
    if (request !== serial) return false;
    run = next;
    chosen = null;
    index = run.frames.findIndex((f) => f.id === startId);
    if (controller) {
      if(index<0) index=run.frames.findIndex(f=>f.op==="underrun");
      if(index<0) index=run.frames.findIndex(f=>f.op==="convert" && f.state.pcm!==0);
      if(index<0) index=0;
      stream.panel(run, next=>load(next));
    } else if (qccd) {
      trap.wiringEditor(run.program, (next) =>
        load(next, run.frames[index]?.id ?? "issue"),
      );
    } else if (neutral) {
      atom.neutralEditor(run.program, (next) =>
        load(next, run.frames[index]?.id),
      );
    } else {
      $("bits").value = run.program.word.toString(2).padStart(2, "0");
      const delay = run.program.linkNs;
      const late =
        run.program.sampleNs +
        run.program.clockNs -
        run.program.demodNs -
        run.program.readoutNs;
      $("arrival").value =
        delay === 450 ? "nominal" : delay === late ? "late" : "custom";
      $("arrival").querySelector("[value=custom]").hidden =
        $("arrival").value !== "custom";
    }
    scene?.setProgram(run.program, run.assemblies, run.initial);
    metric?.load(run);
    for (const p of run.system?.parts ?? []) parts[p.id] ??= p.label;
    for (const link of run.system?.links ?? []) parts[link.id] ??= link.kind;
    buildRows();
    render();
    alertMessage("");
    return true;
  } catch (e) {
    if (request !== serial) return false;
    if (editor) $("programError").textContent = e.message;
    else alertMessage(e.message);
    if (run && !modality) {
      $("bits").value = run.program.word.toString(2).padStart(2, "0");
    }
    return false;
  } finally {
    if (request === serial) busy = false;
  }
}
function save(name, data) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("bits").onchange = () => {
  if (run)
    load({ ...run.program, word: parseInt($("bits").value, 2) }, "sample");
};
$("arrival").onchange = () => {
  if (!run) return;
  const p = run.program;
  const linkNs =
    $("arrival").value === "nominal"
      ? 450
      : p.sampleNs + p.clockNs - p.readoutNs - p.demodNs;
  if (linkNs < 0) {
    alertMessage(
      "The current acquisition already extends beyond the next receiver edge. Edit the sample time to use this preset.",
    );
    $("arrival").value = "custom";
    return;
  }
  load({ ...p, linkNs }, "sample");
};
$("step").oninput = () => {
  if (run) jump(Number($("step").value) - 1);
};
$("back").onclick = () => {
  if (run) jump(index - 1);
};
$("next").onclick = () => {
  if (run) jump(index + 1);
};
$("play").onclick = () => {
  if (!run || busy) return;
  if (timer) {
    stop();
    render();
    return;
  }
  if (index === run.frames.length - 1) index = -1;
  chosen = null;
  $("play").textContent = "Pause";
  $("play").setAttribute("aria-label", "Pause trace");
  timer = setInterval(() => {
    index++;
    const current = run.frames[index];
    if (
      index >= run.frames.length - 1 ||
      (current.op === "sample" && current.state.fault) ||
      current.op === "underrun" ||
      (current.op === "strobe" && current.state.lanes.some((l) => l.stale))
    )
      stop();
    render();
  }, 480);
  render();
};
$("resetView").onclick = () => (metric?.active ? metric.home() : scene?.home());
$("move").onclick = () => {
  if (neutral) {
    $("neutralControls").scrollIntoView({ block: "center" });
    $("toneFields")
      .querySelector("select, input, button")
      ?.focus({ preventScroll: true });
    return;
  }
  if (qccd) {
    $("wiring").scrollIntoView({ block: "center" });
    $("addLane").focus({ preventScroll: true });
    return;
  }
  moving = !moving;
  scene.setMoving(moving);
  $("move").setAttribute("aria-pressed", moving);
  $("viewhint").textContent = moving
    ? "Drag a board to place it · Release to validate"
    : "Drag to orbit · Scroll to zoom · Click to inspect";
};
$("edit").onclick = () => {
  if (!run) return;
  stop();
  render();
  $("programText").value = JSON.stringify(run.program, null, 2);
  $("programError").textContent = "";
  $("editor").showModal();
};
$("apply").onclick = async () => {
  try {
    const p = JSON.parse($("programText").value);
    const start = qccd
      ? "issue"
      : neutral
        ? p.moves?.length
          ? p.moves[0].id + "-issue"
          : "finish"
        : "acquire";
    if (await load(p, start, true)) $("editor").close();
  } catch (e) {
    $("programError").textContent = e.message;
  }
};
$("export").onclick = () => {
  if (run) save(benchFile + "-trace.json", run);
};
$("downloadProgram").onclick = () => {
  if (run) save(benchFile + ".json", run.program);
};
document.addEventListener("keydown", (e) => {
  if (
    !run ||
    $("editor").open ||
    ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(e.target.tagName)
  )
    return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    jump(index + (e.key === "ArrowLeft" ? -1 : 1));
  }
});
try {
  const fixture = await fetch("/examples/" + benchFile + ".json");
  if (!fixture.ok) throw new Error("Unable to read the bench program.");
  const program = await fixture.json();
  const start = qccd
    ? "knot-2"
    : neutral
      ? program.moves.length
        ? program.moves[0].id + "-deliver-1"
        : "finish"
      : "transmit";
  await load(program, start);
} catch (e) {
  alertMessage(e.message);
}
