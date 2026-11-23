export const operations = {
  issue: [
    "Issue steering move",
    "The FPGA schedules the RF tuning words for the selected AOD tone.",
  ],
  rf: [
    "Write RF tuning word",
    "The DDS steps the commanded frequency. The acoustic delay separates this write from its effect at the illuminated aperture.",
  ],
  deliver: [
    "Deliver acoustic step",
    "The frequency step reaches the illuminated AOD aperture. Every trap on the addressed tone shifts along its axis, carrying any atom assigned to that trap.",
  ],
  finish: [
    "Complete program",
    "All scheduled frequency steps have reached the apertures. The trap array holds its final coordinates.",
  ],
};

const frequencies = (p, axis) => (axis === "x" ? p.columnsKHz : p.rowsKHz);
const toneName = (axis, tone) => axis.toUpperCase() + tone;
const position = (site) => "(" + site.xNm + ", " + site.yNm + ") nm";

export function registers(s) {
  const rows = {
    issued: ["Moves issued", s.issued],
    done: ["Program complete", s.done],
  };
  for (const axis of ["X", "Y"]) {
    s["rf" + axis + "KHz"].forEach((khz, tone) => {
      const name = axis + tone;
      rows[name + ".rf"] = [name + " · DDS command", khz + " kHz"];
      rows[name + ".aod"] = [
        name + " · at aperture",
        s["delivered" + axis + "KHz"][tone] + " kHz",
      ];
    });
  }
  for (const trap of s.traps) {
    rows["trap." + trap.id] = [
      "X" +
        trap.column +
        " × Y" +
        trap.row +
        (trap.atom === null ? " · empty" : " · occupied"),
      position(trap),
    ];
  }
  for (const atom of s.atoms)
    rows["atom." + atom.id] = ["Atom " + atom.id, position(atom)];
  return rows;
}

export function channels(p) {
  if (!p.moves.length)
    return [
      {
        label: "Program complete",
        color: "#177565",
        read: (s) => Number(s.done),
      },
    ];
  const signals = [];
  for (const axis of ["x", "y"]) {
    frequencies(p, axis).forEach((initial, tone) => {
      const moves = p.moves.filter((m) => m.axis === axis && m.tone === tone);
      if (!moves.length) return;
      const values = [initial, ...moves.map((m) => m.targetKHz)];
      const floor = Math.min(...values);
      const span = Math.max(...values) - floor;
      for (const [field, label, color] of [
        ["rf", "RF", "#795b30"],
        ["delivered", "AOD", "#177565"],
      ]) {
        const key = field + axis.toUpperCase() + "KHz";
        signals.push({
          label: toneName(axis, tone) + " " + label + " · Δ" + span,
          color,
          read: (state) => (span ? (state[key][tone] - floor) / span : 0),
        });
      }
    });
  }
  return signals;
}

function field(name, input) {
  const label = document.createElement("label");
  label.append(name, input);
  input.setAttribute("aria-label", name);
  return label;
}

function option(value, name) {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = name;
  return el;
}

export function neutralEditor(p, apply) {
  const panel = document.getElementById("neutralControls");
  const fields = document.getElementById("toneFields");
  const previous = fields.querySelector("[data-move]")?.value;
  const move = document.createElement("select");
  move.dataset.move = "";
  for (const item of p.moves)
    move.append(option(item.id, item.id + " · " + item.startNs + " ns"));
  if (p.moves.some((item) => item.id === previous)) move.value = previous;

  const tone = document.createElement("select");
  const palette = document.createElement("div");
  palette.className = "wire-sources lane-head";
  palette.setAttribute("aria-label", "Draggable tones");
  const target = document.createElement("input");
  target.type = "number";
  target.min = "1";
  target.max = "1000000";
  target.step = "1";
  target.required = true;
  target.style.minWidth = "0";
  for (const axis of ["x", "y"]) {
    frequencies(p, axis).forEach((khz, i) => {
      const name = toneName(axis, i);
      tone.append(option(name, name + (axis === "x" ? " · column" : " · row")));
      const chip = document.createElement("span");
      chip.textContent = name;
      chip.title = name + " · initially " + khz + " kHz";
      chip.draggable = true;
      chip.ondragstart = (e) => {
        e.dataTransfer.setData("application/x-qcontrol-tone", name);
        e.dataTransfer.effectAllowed = "copy";
      };
      palette.append(chip);
    });
  }

  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Apply move";
  const message = document.createElement("span");
  message.className = "lane-head";
  message.setAttribute("role", "status");
  function selectMove() {
    const selected = p.moves.find((item) => item.id === move.value);
    tone.value = toneName(selected.axis, selected.tone);
    target.value = selected.targetKHz;
    message.textContent = "";
  }
  fields.ondragover = (e) => {
    if (!e.dataTransfer.types.includes("application/x-qcontrol-tone")) return;
    e.preventDefault();
    fields.classList.add("drop-ready");
  };
  fields.ondragleave = () => fields.classList.remove("drop-ready");
  fields.ondrop = (e) => {
    fields.classList.remove("drop-ready");
    const name = e.dataTransfer.getData("application/x-qcontrol-tone");
    if (![...tone.options].some((opt) => opt.value === name)) return;
    e.preventDefault();
    tone.value = name;
    target.focus();
  };
  move.onchange = selectMove;
  save.onclick = async () => {
    if (!target.reportValidity()) return;
    const edited = p.moves.map((item) =>
      item.id === move.value
        ? {
            ...item,
            axis: tone.value[0].toLowerCase(),
            tone: Number(tone.value.slice(1)),
            targetKHz: target.valueAsNumber,
          }
        : item,
    );
    panel.inert = true;
    try {
      if (!(await apply({ ...p, moves: edited })))
        message.textContent =
          document.getElementById("alert")?.textContent ||
          "The program rejected this move.";
    } finally {
      panel.inert = false;
    }
  };
  if (!p.moves.length) {
    fields.replaceChildren("Add a move in the program editor.");
    return;
  }
  fields.replaceChildren(
    palette,
    field("Move", move),
    field("Shared tone", tone),
    field("Target (kHz)", target),
    save,
    message,
  );
  selectMove();
}
