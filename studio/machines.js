import { createPhysicalViews } from "./metric-stage.js";
import { buildMachine, installation } from "./machine-scene.js";
import { createRegisterView } from "./register-view.js";
import { producingParts } from "/installation-display.js";
import { createScope } from "./scope.js";
import { createPulseInspector } from "./pulse-inspector.js";
import { createWireInspector } from "./wire-inspector.js";
import { defineBoardWire, defaultMedium, payloadWidth } from "/wiring.mjs";
import { neutralSteeringLanes } from "/neutral-installation.mjs";
const $ = (id) => document.getElementById(id);
let scopeRun,
  exercisePorts,
  playback,
  deliveryStages = new Map(),
  deliveryWireLinks = new Map();
const scope = createScope(
  $("signalPlot"),
  (i) => {
    stopPlayback();
    cursor = i + 1;
    selected = null;
    show();
  },
  (p) => [
    {
      label: p.unit,
      color: "#267967",
      read: (s) => (s.value - p.low) / (p.high - p.low),
      ticks: [
        [0, p.low.toLocaleString()],
        [1, p.high.toLocaleString()],
      ],
    },
  ],
);
function portValues(frame,side) {
  return (side === "emitted" && frame.outputs) || (frame[side] ? [frame[side]] : []);
}
function selectSignal() {
  const choice = JSON.parse($("signal").value);
  let value = 0,
    low = 0,
    high = 0;
  const [part, side, port, unit] = choice;
  const frames = replay.trace.frames.map((f) => {
    const update = f.part === part && portValues(f,side).find(([name])=>name===port);
    if (update) {
      value = update[1];
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    return { atNs: f.atPs / 1000, state: { value } };
  });
  scopeRun = {
    program: {
      unit:
        { voltageUv: "µV", frequencyHz: "Hz", positionNm: "nm" }[unit] ?? unit,
      low,
      high: high === low ? low + 1 : high,
    },
    initial: { value: 0 },
    frames,
  };
  scope(scopeRun, cursor - 1);
}
function availableSignals() {
  const seen = new Set(),
    options = [];
  const candidates = replay.exercise
    ? replay.trace.program.parts
    : design.parts;
  const index = new Map(candidates.map((p, i) => [p.id, i]));
  for (const f of replay.trace.frames)
    for (const side of ["received", "emitted"]) for (const [port] of portValues(f,side)) {
      const i = index.get(f.part);
      const stage = deliveryStages.get(f.part);
      const sig =
        (replay.exercise ? exercisePorts : ports)[i]?.[
          side === "received" ? "inputs" : "outputs"
        ].find(([name]) => name === port)?.[1] ??
        (stage || design.device?.drives.some((d) => d.probe === f.part)
          ? "voltageUv"
          : null);
      if (!sig) continue;
      const key = JSON.stringify([f.part, side, port, sig]);
      if (seen.has(key)) continue;
      seen.add(key);
      options.push([
        (candidates[i]?.label ??
          (stage.target ??
            activeInstallation.parts.find((p) => p.id === stage.hardware)
              .label) +
            " · " +
            stage.probe) +
          " · " +
          port,
        key,
        Boolean(candidates[i]?.model.probe || stage?.target),
      ]);
    }
  options.sort((a, b) => Number(b[2]) - Number(a[2]));
  optionList("signal", options);
  $("signalPanel").hidden = !options.length;
  if (options.length) selectSignal();
}
$("signal").onchange = selectSignal;
const palette = {
  fpga: { clockPs: 4000 },
  ram: { words: [0], accessPs: 1200 },
  bus: { widthBits: 16, beatPs: 1000 },
  dac: { bits: 14, fullScaleUv: 1000000 },
  clockedDac: { bits: 16, fullScaleUv: 1000000, address: null },
  spiDac81416: { channel: 0, stepPs: 100000, slewStepUv: 400000 },
  rcFilter: { stepPs: 100000, alphaPpm: 29843 },
  busBuffer: { inputRailMv: 3300, outputRailMv: 5000 },
  dmaBurst: { samples: 256, primed: 4, clockPs: 20000, steadySamplePs: 35000, observe: 5 },
  affine: {
    input: "voltageUv",
    output: "voltageUv",
    numerator: 1,
    denominator: 1,
    offset: 0,
  },
  threshold: { levelUv: 100000 },
  switch: { signal: "voltageUv" },
  probe: { signal: "voltageUv" },
  stimulus: {
    signal: "voltageUv",
    samples: [
      { atPs: 0, value: 0 },
      { atPs: 10000, value: 100000 },
    ],
  },
};
let examples,
  sourceName,
  design,
  activeInstallation,
  ports,
  replay,
  selected,
  cursor = 0,
  revision = 0,
  editVersion = 0,
  request = 0,
  designDirty = false;
const platforms = {
  superconducting: "Superconducting",
  neutral: "Neutral atom",
  qccd: "QCCD",
};
const registerView = createRegisterView($("devicePanel"), {
  onJump(n) {
    stopPlayback();
    cursor = n;
    selected = null;
    show();
  },
  onInspect: () => {
    pulseView.inspectQubit(registerView.state.selected);
    show();
  },
  onScale: (v) => view.setEnlarged(v),
  onFocus: (id) => {
    view.focusOn(id);
    view.setEnlarged(false);
  },
  onHome: () => {
    view.focusOn("");
    view.setEnlarged(true);
  },
});
const pulseView = createPulseInspector(
  (id) => {
    stopPlayback();
    cursor = id + 1;
    selected = null;
    show();
  },
  (id) => {
    selected = id;
    show();
  },
);
const wireView = createWireInspector($("wirePanel"), (id, conductor) => {
  selected = id;
  if (conductor) {
    $("enlargeRegister").checked = false;
    view.openWire(id, conductor);
  } else {
    view.closeWire();
  }
  show();
});
const view = createPhysicalViews($("viewport"), buildMachine, (id) => {
  selected = id;
  if (design.parts.some((p) => p.id === id)) {
    $("component").value = id;
    editPart();
  }
  if (design.wires.some((w) => w.id === id)) $("connection").value = id;
  show();
});
function error(message = "") {
  $("alert").textContent = message;
  $("alert").hidden = !message;
}
function action(fn) {
  return async (...args) => {
    try {
      error();
      await fn(...args);
    } catch (e) {
      error(e.message);
    }
  };
}
async function post(url, data) {
  const r = await fetch("/api/machines/" + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
}
function optionList(id, entries) {
  const prior = $(id).value;
  $(id).replaceChildren(
    ...entries.map(([label, value]) => new Option(label, value)),
  );
  if (entries.some(([, v]) => v === prior)) $(id).value = prior;
}
function invalidate() {
  stopPlayback();
  deliveryStages.clear();
  registerView.setActivity([]);
  scopeRun = null;
  $("signalPanel").hidden = true;
  revision++;
  replay = null;
  pulseView.load(null);
  cursor = 0;
  $("export").disabled = true;
  $("step").max = 0;
  $("status").textContent = "Edited · compile to trace";
  $("asm").textContent = "";
  show();
}
function show() {
  if (!design) return;
  const frames = replay?.trace.frames ?? [],
    f = frames[cursor - 1];
  const compiled = replay?.trace.program.parts ?? design.parts;
  const stage = f && deliveryStages.get(f.part);
  let inspected = selected ?? f?.part;
  if (
    selected &&
    deliveryStages.size &&
    activeInstallation.equipment?.parts.some((p) => p.id === selected)
  ) {
    const channels = [...deliveryStages.values()].filter(
      (s) => s.hardware === selected,
    );
    const ids = new Set(channels.map((s) => s.id));
    inspected = channels[0]?.id ?? selected;
    for (let i = cursor - 1; i >= 0; i--)
      if (ids.has(frames[i].part)) {
        inspected = frames[i].part;
        break;
      }
  }
  const part = compiled.find((p) => p.id === inspected);
  const index = part ? compiled.indexOf(part) : -1;
  let last = null;
  if (part && replay) {
    for (let i = cursor - 1; i >= 0; i--)
      if (frames[i].part === part.id) {
        last = frames[i];
        break;
      }
  }
  const state = last?.state ?? replay?.trace.initial[index];
  registerView.update(cursor);
  pulseView.update(cursor);
  const stateAtQubits = registerView.state;
  const arrival =
    f?.received &&
    (stage?.target
      ? { probe: stage.probe, targets: [stage.target] }
      : !replay?.delivery &&
        design.device?.drives.find(
          (d) => d.probe === f.part && f.received[0] === "in",
        ));
  if (arrival && f.received[1] !== 0)
    stateAtQubits.path = producingParts(frames, f.id);
  const path = stateAtQubits.path;
  $("drivePath").hidden = !path;
  if (path) {
    const system = activeInstallation;
    const partName = (id) => {
      const s = deliveryStages.get(id);
      return (
        s?.target ??
        system.parts.find((p) => p.id === (s?.hardware ?? id))?.label ??
        id
      );
    };
    const delivery = system.links.filter((l) =>
      l.probes?.includes(arrival.probe),
    );
    const stages = delivery
      .map((l) => l.to)
      .filter((id) => id !== system.equipment.chip);
    $("drivePath").textContent = (
      replay.delivery
        ? path.parts.map(partName)
        : [
            ...path.parts.map(partName),
            ...stages.map(partName),
            ...arrival.targets,
          ]
    ).join(" → ");
    path.parts = path.parts.map((id) => deliveryStages.get(id)?.hardware ?? id);
    path.wires = path.wires.map((id) => deliveryWireLinks.get(id) ?? id);
  }
  stateAtQubits.arrivingTarget = stage?.target;
  const pulsePath = pulseView.pathAt(cursor - 1);
  if (pulsePath) {
    stateAtQubits.path = {
      parts: [...(stateAtQubits.path?.parts ?? []), ...pulsePath.parts],
      wires: [...(stateAtQubits.path?.wires ?? []), ...pulsePath.wires],
    };
    stateAtQubits.carriers = pulsePath.carriers;
  }
  stateAtQubits.timed = Boolean(replay?.delivery);
  const steering = replay?.steering;
  if (steering) {
    const ps = f?.atPs ?? 0;
    const command = steering.observations.findLast(
      (o) => o.resolvedAtNs * 1000 <= ps,
    );
    const placement =
      steering.placement?.frames.findLast((p) => p.atNs * 1000 <= ps)?.state ??
      steering.placement?.initial;
    const atom = placement?.atoms[0];
    const on = ps < (steering.rfOffAtPs ?? Infinity);
    stateAtQubits.steering =
      on &&
      (atom
        ? { xNm: atom.xNm, yNm: atom.yNm }
        : command
          ? {
              xNm: steering.axis === "x" ? command.positionNm : 0,
              yNm: steering.axis === "y" ? command.positionNm : 0,
            }
          : null);
    if (stateAtQubits.steering)
      Object.assign(stateAtQubits.steering, {
        originMm: steering.originMm,
        label: atom ? "Steering test atom" : "Raman address",
      });
    $("steerReading").textContent = !on
      ? "RF off"
      : command
        ? steering.observable +
          " · " +
          (command.frequencyHz / 1e6).toFixed(6) +
          " MHz · " +
          command.positionNm / 1000 +
          " µm"
        : "Waiting for the first settled RF tone";
    $("nextTone").disabled = !steering.observations.some(
      (o) => o.resolvedAtNs * 1000 > ps,
    );
  } else $("steerReading").textContent = "";
  const visualFrame = stage
    ? {
        ...f,
        part: stage.hardware,
        wire: stage.link,
        deliveryTarget: stage.target,
        deliveryProbe: stage.probe,
      }
    : f;
  wireView.update(visualFrame, selected);
  view.show(visualFrame, selected, stateAtQubits);
  if (scopeRun) scope(scopeRun, cursor - 1);
  $("step").value = cursor;
  $("step").disabled = !frames.length;
  $("back").disabled = !cursor;
  $("next").disabled = cursor >= frames.length;
  $("playTrace").disabled = !frames.length;
  $("count").textContent = cursor + " / " + frames.length;
  $("when").textContent = f ? f.atPs.toLocaleString("en") + " ps" : "0 ps";
  $("op").textContent = f?.op ?? (replay ? "Initial state" : "Machine design");
  $("part").textContent = f
    ? f.part + " · " + f.source + (f.detail ? " · " + f.detail : "")
    : "Select a component to inspect its state.";
  const rows = [];
  const wire = activeInstallation.links.find((l) => l.id === selected);
  if (wire) {
    const label = (id) =>
      activeInstallation.parts.find((p) => p.id === id)?.label ?? id;
    rows.push(
      ["Selected connection", wire.id],
      ["From", label(wire.from)],
      ["To", label(wire.to)],
      ["Carries", wire.kind],
    );
    if (wire.arm) rows.push(["Optical or RF path", wire.arm]);
    if (wire.wavelengthNm) rows.push(["Wavelength", wire.wavelengthNm + " nm"]);
    if (wire.carrier) rows.push(["Role", "Light supplied by the optical arm"]);
  }
  if (f?.wire) rows.push(["Arriving wire", f.wire]);
  if (f?.transport)
    rows.push(
      ["Transmitter ready", f.transport.issuedPs + " ps"],
      ["Transmission begins", f.transport.startPs + " ps"],
      ["Final bit launched", f.transport.releasePs + " ps"],
      ["Queue wait", f.transport.startPs - f.transport.issuedPs + " ps"],
    );
  if (stage)
    rows.push(
      ["Drive channel", stage.probe],
      ["Physical path", stage.lengthMm.toPrecision(4) + " mm"],
      ["Modeled delay", stage.delayPs + " ps"],
    );
  if (f?.pc != null) rows.push(["Instruction address", f.pc]);
  if (f?.scheduledPs != null)
    rows.push(["Scheduled issue", f.scheduledPs + " ps"]);
  if (f && replay) {
    const source = replay.sourceMap.findLast(
      (s) => s.origin && (f.source === s.id || f.source.startsWith(s.id + "/")),
    );
    if (source) rows.push(["Source location", source.origin]);
    if (f.received) rows.push(["Input · " + f.received[0], f.received[1]]);
    for (const [port,value] of f.outputs ?? (f.emitted ? [f.emitted] : []))
      rows.push(["Output · "+port, value]);
    if (f.native)
      rows.push(
        ["Board component", f.native.part],
        ["Board event", f.native.id],
        ["Board instruction", f.native.sourcePc ?? "—"],
        ["FIFO words", f.native.state.fifo.length],
        ["DAC output (µV)", f.native.state.outputUv],
      );
  }
  if (part) {
    rows.push(
      ["Inspecting", part.label],
      ["Primitive", Object.keys(part.model)[0]],
      ["Center (mm)", part.centerMm.join(", ")],
    );
    if (state)
      rows.push(
        ["Last port value", state.value],
        ["Last event", last ? "#" + last.id : "Reset"],
      );
    if (state && part.model.fpga)
      rows.push(
        ["Next PC", state.pc],
        ["Accumulator", state.acc],
        ["Feedback bit", state.sense],
        [
          "Stored bits",
          state.bits.map(([i, v]) => i + "=" + Number(v)).join(", ") || "none",
        ],
      );
    if (state && part.model.bus)
      rows.push(["Bus reserved until", state.freePs + " ps"]);
    if (part.model.busBuffer)
      rows.push(["Nominal logic supply", part.model.busBuffer.inputRailMv + " mV input · " + part.model.busBuffer.outputRailMv + " mV output"]);
    if (state && part.model.clockedDac)
      rows.push(["Pending sample word", state.rx], ["Selected bus address", state.acc], ["Strobe level", state.sense], ["Held output", state.value + " µV"]);
    if (state && part.model.spiDac81416) {
      const spi = state.spi;
      if (spi) rows.push(["Chip select", spi.selected ? "asserted" : "idle"],
        ["Sampled bits", spi.clocks + " / 24"], ["Shift register", "0x" + spi.shift.toString(16).padStart(6, "0")],
        ["SDI / SCLK", spi.dataBit + " / " + Number(spi.clockHigh)]);
    }
    if (state && (part.model.spiDac81416 || part.model.rcFilter))
      rows.push(["Target voltage", state.rx + " µV"], ["Output voltage", state.value + " µV"]);
    if (state && part.model.dmaBurst)
      rows.push(["Last observed record", state.acc], ["Burst completes at", state.freePs + " ps"]);
  }
  $("values").replaceChildren(
    ...rows.flatMap(([k, v]) =>
      ["dt", "dd"].map((tag, i) => {
        const n = document.createElement(tag);
        n.textContent = i ? v : k;
        return n;
      }),
    ),
  );
  $("parents").replaceChildren(
    ...(f?.parents ?? []).map((id) => {
      const b = document.createElement("button");
      b.textContent = "Cause #" + id;
      b.onclick = () => {
        stopPlayback();
        cursor = id + 1;
        selected = null;
        show();
      };
      return b;
    }),
  );
}
function editPart() {
  const p = design?.parts.find((p) => p.id === $("component").value);
  if (!p) return;
  $("partLabel").value = p.label;
  $("center").value = p.centerMm.join(", ");
  $("size").value = p.sizeMm.join(", ");
  $("model").value = JSON.stringify(p.model, null, 2);
}
function updatePorts() {
  const used = new Set(
    design.wires.map((w) => JSON.stringify([w.dst.part, w.dst.port])),
  );
  const output = JSON.parse($("outputPort").value || "null");
  const sig = output?.[2];
  const preferred = defaultMedium(sig);
  const kinds =
    sig === "bit"
      ? ["logic", "coax", "differential", "fiber"]
      : payloadWidth(sig)
        ? ["parallel", "differential", "fiber"]
        : ["coax", "dc", "planar"];
  const names = {
    logic: "Logic + return",
    parallel: "Parallel data bus",
    differential: "Differential serial pair",
    fiber: "Serial optical fiber",
    coax: sig === "bit" ? "Logic over coax" : "Analog coax",
    dc: "DC pair",
    planar: "Coplanar trace",
  };
  optionList(
    "wireMedium",
    kinds.map((k) => [names[k], k]),
  );
  if (!$("wireMedium").value) $("wireMedium").value = preferred;
  $("wireRateLabel").hidden = !["differential", "fiber"].includes(
    $("wireMedium").value,
  );
  const inputs = [];
  design.parts.forEach((p, i) => {
    for (const [port, sig] of ports[i].inputs) {
      if (sig === output?.[2] && !used.has(JSON.stringify([p.id, port])))
        inputs.push([p.label + " · " + port, JSON.stringify([p.id, port])]);
    }
  });
  optionList("inputPort", inputs);
  $("wire").disabled = !inputs.length;
}
async function setDesign(d) {
  const ticket = ++editVersion;
  if (!Array.isArray(d?.parts) || !d.parts.length || !Array.isArray(d.wires))
    throw Error("Expected machine parts and wires.");
  const signature = await post(
    "ports",
    d.parts.map((p) => p.model),
  );
  // Compile an idle image to check ports, units and geometry while a design is being assembled.
  await post("compile", {
    design: d,
    source: {
      language: "control-ir",
      version: 1,
      tracks: [],
    },
  });
  if (ticket !== editVersion) return false;
  const system = installation(d);
  design = d;
  ports = signature;
  selected = null;
  designDirty = false;
  $("design").value = JSON.stringify(d, null, 2);
  optionList(
    "component",
    d.parts.map((p) => [p.label, p.id]),
  );
  optionList(
    "connection",
    d.wires.map((w) => [
      w.src.part + "." + w.src.port + " → " + w.dst.part + "." + w.dst.port,
      w.id,
    ]),
  );
  $("unwire").disabled = !d.wires.length;
  optionList(
    "outputPort",
    d.parts.flatMap((p, i) =>
      ports[i].outputs.map(([port, sig]) => [
        p.label + " · " + port + " (" + sig + ")",
        JSON.stringify([p.id, port, sig]),
      ]),
    ),
  );
  updatePorts();
  $("viewport")
    .closest(".workbench")
    .classList.toggle("has-device", Boolean(d.device));
  for (const b of $("machinePlatforms").querySelectorAll("button")) {
    const kind = { superconducting: "transmon", neutral: "atom", qccd: "ion" }[
      b.dataset.platform
    ];
    b.setAttribute("aria-pressed", String(kind === d.device?.kind));
  }
  activeInstallation = system;
  $("dcPanel").hidden = d.device?.kind !== "ion" || !d.device?.mounting;
  $("steerPanel").hidden = d.device?.kind !== "atom" || !d.device?.mounting;
  optionList(
    "steerLane",
    neutralSteeringLanes.map((s) => [s, s]),
  );
  registerView.load(d.device, system.equipment?.chip);
  wireView.load(system);
  view.load({
    system,
    probeValue(id) {
      const frames = replay?.trace.frames;
      if (frames) for (let i = cursor - 1; i >= 0; i--)
        if (frames[i].part === id && frames[i].received) return frames[i].received[1];
      return null;
    },
    pickQubit: registerView.inspect,
    pickConductor: (id, lane) => {
      selected = id;
      wireView.selectConductor?.(id, lane);
      view.openWire(id, lane);
      show();
    },
  });
  invalidate();
  return true;
}
function getSource() {
  return $("language").value === "qasm"
    ? $("source").value
    : JSON.parse($("source").value);
}
function bundle() {
  if (designDirty) throw Error("Apply the machine text before continuing.");
  return { design, source: getSource(), ...(sourceName ? { sourceName } : {}) };
}
async function execute(exercise) {
  stopPlayback();
  const ticket = ++request,
    rev = revision;
  const doc = bundle();
  if (exercise) doc.exercise = exercise;
  $("status").textContent = "Compiling…";
  try {
    const result = await post("run", doc);
    const signatures = result.exercise
      ? await post(
          "ports",
          result.trace.program.parts.map((p) => p.model),
        )
      : null;
    if (rev !== revision || ticket !== request) return;
    replay = result;
    exercisePorts = signatures;
    $("gateRun").hidden = result.exercise?.kind !== "h2-dc";
    $("steerGate").hidden = $("nextTone").hidden = !result.steering;
    selected = null;
    const frames = result.trace.frames;
    cursor = 0;
    deliveryStages = new Map(result.delivery?.stages.map((s) => [s.id, s]));
    deliveryWireLinks = new Map(
      result.delivery?.stages.map((s) => [s.wire, s.link]),
    );
    registerView.setActivity(result.terminalActivity ?? result.deviceActivity);
    pulseView.load(result);
    availableSignals();
    $("step").max = frames.length;
    $("export").disabled = false;
    $("status").textContent =
      result.trace.stop + " · " + frames.length + " events";
    $("asm").textContent = result.trace.program.images
      .map(
        (im) =>
          im.controller +
          "\n" +
          im.code
            .map(
              (ins, i) =>
                String(i).padStart(4) +
                "   " +
                JSON.stringify(ins.op) +
                "   " +
                ins.source,
            )
            .join("\n"),
      )
      .join("\n\n");
    show();
  } catch (e) {
    if (rev === revision && ticket === request) {
      invalidate();
      $("status").textContent = "Compilation failed";
      throw e;
    }
  }
}
async function load(doc) {
  if (!(await setDesign(structuredClone(doc.design)))) return;
  sourceName =
    doc.sourceName ?? (doc.title ? doc.title + " example" : undefined);
  $("language").value = typeof doc.source === "string" ? "qasm" : "ir";
  $("source").value =
    typeof doc.source === "string"
      ? doc.source
      : JSON.stringify(doc.source, null, 2);
  if (doc.exercise?.kind === "h2-dc") {
    $("dcChannel").value = doc.exercise.channel;
    $("dcWords").value = doc.exercise.words.join(", ");
    $("dcPanel").open = true;
  } else if (doc.exercise?.kind === "neutral-steering") {
    $("steerLane").value = doc.exercise.lane;
    $("steerTones").value = doc.exercise.frequenciesHz
      .map((f) => f / 1e6)
      .join(", ");
    $("steerPanel").open = true;
  }
  await execute(doc.exercise);
}
function nextId(d, prefix) {
  const ids = new Set([...d.parts, ...d.wires].map((p) => p.id));
  let n = 1;
  while (ids.has(prefix + n)) n++;
  return prefix + n;
}
function cleanDraft() {
  if (designDirty)
    throw Error("Apply the machine text before editing its assembly.");
}
async function add(position = null) {
  cleanDraft();
  const d = structuredClone(design),
    kind = $("primitive").value,
    id = nextId(d, kind);
  const center = position ?? [0, 5, 60 + d.parts.length * 3];
  d.parts.push({
    id,
    label: id,
    model: { [kind]: structuredClone(palette[kind]) },
    centerMm: center,
    sizeMm: [28, 10, 22],
  });
  if (await setDesign(d)) {
    selected = id;
    $("component").value = id;
    editPart();
    show();
  }
}
$("add").onclick = action(() => add());
$("component").onchange = () => {
  selected = $("component").value;
  editPart();
  show();
};
$("connection").onchange = () => {
  selected = $("connection").value;
  show();
};
for (const [id, mode] of [
  ["add", "add"],
  ["move", "move"],
])
  $(id).ondragstart = (e) => {
    if (design.device && $("enlargeRegister").checked) {
      $("enlargeRegister").checked = false;
      view.setEnlarged(false);
    }
    e.dataTransfer.setData("application/x-qcontrol-part", mode);
  };
$("viewport").ondragover = (e) => e.preventDefault();
$("viewport").ondrop = action(async (e) => {
  e.preventDefault();
  cleanDraft();
  const mode = e.dataTransfer.getData("application/x-qcontrol-part");
  if (!["add", "move"].includes(mode)) return;
  const part = design.parts.find((p) => p.id === $("component").value);
  const point = view.pointOnPlane(
    e.clientX,
    e.clientY,
    mode === "add" ? 5 : part.centerMm[1],
  );
  if (!point) return;
  const pos = point.map((n) => Math.round(n * 1000) / 1000);
  if (mode === "add") await add(pos);
  else {
    const d = structuredClone(design);
    d.parts.find((p) => p.id === part.id).centerMm = pos;
    await setDesign(d);
  }
});
$("move").onclick = () => {
  $("partEditor").open = true;
  editPart();
  $("center").focus();
};
$("partEditor").ontoggle = () => {
  if ($("partEditor").open) editPart();
};
$("applyPart").onclick = action(async () => {
  cleanDraft();
  const d = structuredClone(design),
    p = d.parts.find((p) => p.id === $("component").value);
  function xyz(id) {
    const values = $(id)
      .value.split(",")
      .map((x) => x.trim());
    if (
      values.length !== 3 ||
      values.some((x) => !x || !Number.isFinite(Number(x)))
    )
      throw Error("Enter three comma-separated coordinates.");
    return values.map(Number);
  }
  p.centerMm = xyz("center");
  p.sizeMm = xyz("size");
  p.label = $("partLabel").value;
  p.model = JSON.parse($("model").value);
  if (await setDesign(d)) {
    selected = p.id;
    editPart();
    show();
  }
});
$("wire").onclick = action(async () => {
  cleanDraft();
  const d = structuredClone(design),
    [a, out, signal] = JSON.parse($("outputPort").value),
    [b, input] = JSON.parse($("inputPort").value);
  const net = {
    id: nextId(d, "wire"),
    src: { part: a, port: out },
    dst: { part: b, port: input },
    delayPs: $("delay").valueAsNumber,
  };
  const medium = $("wireMedium").value;
  const serial = ["fiber", "differential"].includes(medium);
  net.interconnect = defineBoardWire(
    net,
    signal,
    medium,
    serial
      ? { encoding: "serial-nrz", bitRateGbps: $("wireRate").valueAsNumber }
      : medium === "coax" && signal === "bit" ? { encoding: "logic-level" } : {},
  );
  d.wires.push(net);
  await setDesign(d);
});
$("unwire").onclick = action(async () => {
  cleanDraft();
  const d = structuredClone(design);
  d.wires = d.wires.filter((w) => w.id !== $("connection").value);
  await setDesign(d);
});
$("outputPort").onchange = updatePorts;
$("wireMedium").onchange = () => {
  $("wireRateLabel").hidden = !["differential", "fiber"].includes(
    $("wireMedium").value,
  );
};
$("design").oninput = () => {
  designDirty = true;
  invalidate();
};
$("apply").onclick = action(() => setDesign(JSON.parse($("design").value)));
$("run").onclick = action(() => execute());
$("dcRun").onclick = action(() => {
  const words = $("dcWords")
    .value.split(",")
    .map((s) => s.trim());
  if (words.some((s) => !/^[-+]?\d+$/.test(s)))
    throw Error("Enter signed integer sample words separated by commas.");
  return execute({
    kind: "h2-dc",
    channel: $("dcChannel").valueAsNumber,
    words: words.map(Number),
  });
});
$("gateRun").onclick = action(() => execute());
$("steerRun").onclick = action(() =>
  execute({
    kind: "neutral-steering",
    lane: $("steerLane").value,
    frequenciesHz: $("steerTones")
      .value.split(",")
      .map((f) => Number(f.trim()) * 1e6),
  }),
);
$("steerGate").onclick = action(() => execute());
$("nextTone").onclick = () => {
  const frames = replay?.trace.frames ?? [],
    ps = frames[cursor - 1]?.atPs ?? 0;
  const next = replay?.steering?.observations.find(
    (o) => o.resolvedAtNs * 1000 > ps,
  );
  if (next) {
    stopPlayback();
    cursor = frames.findIndex((f) => f.atPs >= next.resolvedAtNs * 1000) + 1;
    selected = null;
    show();
  }
};
$("source").oninput = () => {
  sourceName = undefined;
  invalidate();
};
$("language").onchange = invalidate;
function stopPlayback() {
  clearInterval(playback);
  playback = null;
  $("playTrace").textContent = "Play trace";
}
$("playTrace").onclick = () => {
  if (playback) {
    stopPlayback();
    return;
  }
  if (!replay?.trace.frames.length) return;
  if (cursor >= replay.trace.frames.length) {
    cursor = 0;
    show();
  }
  $("playTrace").textContent = "Pause";
  playback = setInterval(() => {
    cursor++;
    selected = null;
    show();
    if (cursor >= replay.trace.frames.length) stopPlayback();
  }, 130);
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPlayback();
});
$("step").oninput = () => {
  stopPlayback();
  cursor = Number($("step").value);
  selected = null;
  show();
};
$("back").onclick = () => {
  stopPlayback();
  cursor--;
  selected = null;
  show();
};
$("next").onclick = () => {
  stopPlayback();
  cursor++;
  selected = null;
  show();
};
function save(filename, obj) {
  const a = document.createElement("a"),
    url = URL.createObjectURL(
      new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }),
    );
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("save").onclick = action(() =>
  save("machine-and-source.json", {
    ...bundle(),
    ...(replay?.exercise ? { exercise: replay.exercise } : {}),
  }),
);
$("export").onclick = () => save("machine-replay.json", replay);
$("open").onclick = () => $("file").click();
$("newMachine").onclick = action(async () => {
  $("example").selectedIndex = -1;
  await load({
    design: {
      kind: "machine-design",
      version: 1,
      roles: { control: "controller" },
      calibrations: [],
      maxEvents: 4000,
      parts: [
        {
          id: "controller",
          label: "Control FPGA",
          model: { fpga: { clockPs: 4000 } },
          centerMm: [0, 5, 0],
          sizeMm: [54, 10, 46],
        },
      ],
      wires: [],
    },
    source: {
      language: "control-ir",
      version: 1,
      tracks: [{ role: "control", body: [] }],
    },
  });
});
$("file").onchange = action(async () => {
  const file = $("file").files[0];
  $("file").value = "";
  if (file) {
    const text = await file.text();
    if (/\.qasm3?$/i.test(file.name)) {
      cleanDraft();
      await load({ design, source: text, sourceName: file.name });
      return;
    }
    const document = JSON.parse(text);
    if (document.language === "control-ir") {
      cleanDraft();
      await load({ design, source: document, sourceName: file.name });
      return;
    }
    $("example").selectedIndex = -1;
    await load(
      document.kind === "machine-design"
        ? { design: document, source: getSource() }
        : document,
    );
  }
});
function chooseExample(id) {
  if(id==="measured-case" || id==="lesson-build")return;
  $("example").querySelector('option[value="lesson-build"]')?.remove();
  $("example").querySelector('option[value="measured-case"]')?.remove();
  const url = new URL(location.href);
  url.searchParams.delete("boardCase");
  url.searchParams.delete("lesson");
  url.searchParams.delete("row");
  url.searchParams.delete("inspect");
  const platform = Object.keys(platforms).find((k) => platforms[k] === id);
  if (platform) url.searchParams.set("platform", platform);
  else url.searchParams.delete("platform");
  history.replaceState(null, "", url);
  $("example").value = id;
  return load(examples.find((x) => x.id === id));
}
$("example").onchange = action(() => chooseExample($("example").value));
for (const b of $("machinePlatforms").querySelectorAll("button"))
  b.onclick = action(() => chooseExample(platforms[b.dataset.platform]));
await action(async () => {
  examples = await (await fetch("/api/machines/examples")).json();
  palette.waveformBoard = examples
    .find((e) => e.id === "Waveform board")
    .design.parts.find((p) => p.model.waveformBoard).model.waveformBoard;
  optionList(
    "example",
    examples.map((d) => [d.id + " · " + d.title, d.id]),
  );
  optionList(
    "primitive",
    Object.keys(palette).map((t) => [t, t]),
  );
  const params=new URL(location.href).searchParams;
  if (params.has("lesson")) {
    const {activities,settingsFor}=await import("/course/labs/activities.mjs");
    const {machineDocument}=await import("/course/labs/platform.mjs");
    const id=params.get("lesson"), spec=activities[id];
    if(!spec || !["waveform","electrode","strobe"].includes(spec.engine)) throw Error("Unknown machine lesson.");
    const options=spec.build(settingsFor(id,params));
    const doc=await machineDocument(spec.engine,options,async url=>{
      const response=await fetch(url);
      if(!response.ok)throw Error(await response.text());
      return response.json();
    });
    $("example").append(new Option(spec.title,"lesson-build",true,true));
    await load(doc);
    const index=Number(params.get("event"));
    if(replay && params.has("event") && Number.isInteger(index) && replay.trace.frames[index]){
      cursor=index+1;
      selected=doc.design.parts.find(p=>p.id===params.get("probe"))?.id??replay.trace.frames[index].part;
      show();
    }
    return;
  }
  if (params.has("boardCase")) {
    const query=new URLSearchParams({case:params.get("boardCase"),row:params.get("row")??"0"});
    const res=await fetch("/api/board-validation/design?"+query);
    if(!res.ok)throw Error(await res.text());
    const doc=await res.json();
    $("example").append(new Option(doc.sourceName,"measured-case",true,true));
    await load(doc);
    if(replay){
      const receipts=replay.trace.frames.filter(f=>f.received && (doc.inspectionPart ? f.part===doc.inspectionPart : ["output","receiver"].includes(f.part)));
      const spiCommit = params.get("inspect")==="spi-commit" &&
        replay.trace.frames.findLast(f=>f.op==="commit SPI DAC word");
      const f=spiCommit || (doc.inspectionOp ? replay.trace.frames.find(f=>f.op===doc.inspectionOp) :
        receipts.findLast(f=>f.atPs<=(doc.inspectionPs??Infinity)));
      if(f){
        cursor=f.id+1; selected=f.part; show();
        const board = spiCommit && doc.design.parts.find(p=>p.id===f.part)?.pcbGroup;
        if (board) view.focusOn("pcb/" + board);
      }
    }
    return;
  }
  const initial =
    platforms[new URL(location.href).searchParams.get("platform")] ??
    examples[0].id;
  $("example").value = initial;
  await load(examples.find((e) => e.id === initial));
})();
