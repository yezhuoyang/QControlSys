export const operations = {
  launch: [
    "Launch gate light",
    "The modulator launches the leading optical edge into the gate-light fiber.",
  ],
  endLaunch: [
    "End source pulse",
    "The trailing optical edge leaves the modulator and travels to the optical head.",
  ],
  issue: [
    "Issue transport program",
    "The FPGA issues the selector command and schedules the latch edge and optical pulse.",
  ],
  sendMask: [
    "Send selector word",
    "The digital fiber carries the per-lane selector bits to the remote electronics.",
  ],
  writeMask: [
    "Write local selector",
    "The addressed lane commits its incoming bit to its pending register. Its sampled switch retains its value.",
  ],
  strobe: [
    "Latch all selectors",
    "The same receiver edge samples every lane. A lane whose update has yet to arrive samples its reset bit.",
  ],
  knot: [
    "Deliver waveform knot",
    "The DAC applies one differential voltage to the connected, enabled electrodes. Ion positions follow the configured displacement calibration.",
  ],
  settle: [
    "Complete settling interval",
    "The final electrode biases hold the destination wells through the programmed settling interval.",
  ],
  light: [
    "Open optical gate",
    "The optical head illuminates the selected lane’s destination well. An ion is exposed only if it occupies that well.",
  ],
  dark: [
    "Close optical gate",
    "The addressed light pulse ends. The exposure register retains its result.",
  ],
  finish: [
    "Complete program",
    "The optical pulse and all scheduled selector deliveries have completed.",
  ],
};

export function registers(s, frame) {
  const rows = {
    sourceOn: ["Laser modulator", s.sourceOn],
    opticalHead: [
      "Optical leading edge",
      (frame?.opticalHeadPermille ?? 0) / 10 + "% of fiber",
    ],
    opticalTail: [
      "Optical trailing edge",
      (frame?.opticalTailPermille ?? 0) / 10 + "% of fiber",
    ],
    issued: ["Command issued", s.issued],
    sent: ["Selector sent", s.sent],
    strobed: ["Latch strobed", s.strobed],
    bus: ["Shared DAC", s.busMv + " mV"],
    settled: ["Transport settled", s.settled],
    light: ["Optical pulse", s.lightOn],
    hit: ["Last exposed ion", s.exposedIon ?? "none"],
    done: ["Complete", s.done],
  };
  for (const l of s.lanes) {
    const add = (k, name, value) =>
      (rows[l.id + "." + k] = [l.id + " · " + name, value]);
    add("wired", "source", l.wired ? "Shared DAC" : "Hold bias");
    add("pending", "pending bit", Number(l.pending));
    add("arrived", "word arrived", l.arrived);
    add("latched", "sampled bit", Number(l.latched));
    add("stale", "stale at edge", l.stale);
    add("voltage", "electrodes", l.electrodeMv + " mV");
    add("position", "ion position", l.ionUm + " µm");
  }
  return rows;
}

export function channels(p) {
  return [
    {
      label: "DAC · " + p.fullScaleMv + " mV",
      color: "#8d6828",
      read: (s) => s.busMv / p.fullScaleMv,
    },
    ...p.zones.map((z, i) => ({
      label: "Ion " + z.id + " · " + p.travelUm + " µm",
      color: i % 2 ? "#8f62a5" : "#217b70",
      read: (s) => s.lanes[i].ionUm / p.travelUm,
    })),
    {
      label: "Optical source",
      color: "#a17da9",
      read: (s) => Number(s.sourceOn),
    },
    { label: "Gate light", color: "#75529c", read: (s) => Number(s.lightOn) },
  ];
}

function select(label, choices, current, change) {
  const field = document.createElement("label");
  field.textContent = label;
  const input = document.createElement("select");
  input.setAttribute("aria-label", label);
  for (const [value, text] of choices) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    input.append(opt);
  }
  input.value = current;
  input.onchange = () => change(input.value);
  field.append(input);
  return field;
}

// All UI edits produce an ordinary program and pass the same Lean validator as imported JSON.
export function wiringEditor(p, apply) {
  const panel = document.getElementById("wiring"),
    cards = document.getElementById("laneCards");
  const edit = async (next) => {
    panel.inert = true;
    try {
      await apply(next);
    } finally {
      panel.inert = false;
    }
  };
  const update = (id, patch) =>
    edit({
      ...p,
      zones: p.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)),
    });
  const gate = document.getElementById("opticalTarget");
  gate.replaceChildren(
    select(
      "Optical target",
      p.zones.map((z) => [z.id, "Lane " + z.id]),
      p.gateZone,
      (gateZone) => edit({ ...p, gateZone }),
    ),
  );
  const clock = p.clockNs,
    late = p.latchNs + clock,
    early = p.latchNs - clock;
  cards.replaceChildren(
    ...p.zones.map((z) => {
      const card = document.createElement("div");
      card.className = "lane-card";
      const heading = document.createElement("h3");
      heading.textContent = "Lane " + z.id;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", "Remove lane " + z.id);
      remove.disabled = p.zones.length === 1;
      remove.onclick = () => {
        const zones = p.zones.filter((l) => l.id !== z.id);
        edit({
          ...p,
          zones,
          gateZone: p.gateZone === z.id ? zones[0].id : p.gateZone,
        });
      };
      const head = document.createElement("div");
      head.className = "lane-head";
      head.append(heading, remove);
      const prefix = z.id + " · ";
      const timing = [
        [String(early), "One edge before"],
        [String(p.latchNs), "On the edge"],
        [String(late), "One edge late"],
      ];
      if (!timing.some(([v]) => Number(v) === z.arrivalNs))
        timing.push([String(z.arrivalNs), z.arrivalNs + " ns"]);
      card.append(
        head,
        select(
          prefix + "Wire",
          [
            ["dac", "Shared DAC"],
            ["hold", "Hold bias"],
          ],
          z.wired ? "dac" : "hold",
          (v) => update(z.id, { wired: v === "dac" }),
        ),
        select(
          prefix + "Reset",
          [
            ["0", "Hold"],
            ["1", "Enable"],
          ],
          String(+z.initialEnable),
          (v) => update(z.id, { initialEnable: v === "1" }),
        ),
        select(
          prefix + "Request",
          [
            ["0", "Hold"],
            ["1", "Enable"],
          ],
          String(+z.requestEnable),
          (v) => update(z.id, { requestEnable: v === "1" }),
        ),
        select(prefix + "Arrival", timing, String(z.arrivalNs), (v) =>
          update(z.id, { arrivalNs: Number(v) }),
        ),
      );
      card.ondragover = (e) => {
        if (e.dataTransfer.types.includes("application/x-qcontrol-wire")) {
          e.preventDefault();
          card.classList.add("drop-ready");
        }
      };
      card.ondragleave = () => card.classList.remove("drop-ready");
      card.ondrop = (e) => {
        e.preventDefault();
        card.classList.remove("drop-ready");
        const src = e.dataTransfer.getData("application/x-qcontrol-wire");
        if (src === "dac" || src === "hold")
          update(z.id, { wired: src === "dac" });
      };
      return card;
    }),
  );
  const add = document.getElementById("addLane");
  add.disabled = p.zones.length === 6;
  add.onclick = () => {
    const id = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find(
      (c) => !p.zones.some((z) => z.id === c),
    );
    edit({
      ...p,
      zones: [
        ...p.zones,
        {
          id,
          wired: true,
          initialEnable: false,
          requestEnable: true,
          arrivalNs: early,
        },
      ],
    });
  };
  for (const source of panel.querySelectorAll("[data-wire]")) {
    source.ondragstart = (e) => {
      panel.classList.add("dragging-wire");
      e.dataTransfer.setData(
        "application/x-qcontrol-wire",
        source.dataset.wire,
      );
      e.dataTransfer.effectAllowed = "copy";
    };
    source.ondragend = () => panel.classList.remove("dragging-wire");
  }
}
