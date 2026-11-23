const titles = {
  ion: "Trapped-ion register",
  atom: "Optical tweezer register",
  transmon: "Superconducting chip",
};
const counts = { ion: "ions", atom: "neutral atoms", transmon: "transmons" };
const format = new Intl.NumberFormat("en", { maximumSignificantDigits: 6 });

// The inspector holds the trace cursor. All drawing and picking use the installation's camera.
export function createRegisterView(
  el,
  { onJump, onInspect, onScale, onFocus, onHome },
) {
  const find = (id) => document.getElementById(id);
  let device,
    registerId,
    selected,
    activity = [],
    cursor = -1,
    latched = new Map();
  let qubits = new Map(),
    buttons = new Map(),
    levels = new Set(),
    activeProbes = new Set();
  const enlarge = find("enlargeRegister");
  function inspect(id) {
    selected = id;
    updateInspector();
    onInspect();
  }
  function updateInspector() {
    if (!device) return;
    const q = qubits.get(selected);
    const samples = [...latched.values()].filter((e) =>
      e.targets.includes(selected),
    );
    const signal = samples
      .map((e) => e.probe + " " + format.format(e.valueUv) + " µV")
      .join(" / ");
    find("focusQubit").disabled = !q;
    find("qubitInspector").textContent = q
      ? [
          q.id,
          q.site,
          "Device coordinates (" +
            q.positionMm.map((n) => format.format(n * 1000)).join(", ") +
            ") µm",
          signal,
        ]
          .filter(Boolean)
          .join(" · ")
      : "Select a qubit to inspect its physical site.";
    for (const [id, b] of buttons) {
      b.setAttribute("aria-pressed", String(id === selected));
      b.classList.toggle("driven", levels.has(id));
    }
  }
  function update(next) {
    if (!device || cursor === next) return;
    if (next < cursor) latched.clear();
    const start = next < cursor ? 0 : Math.max(0, cursor);
    for (const e of activity) {
      if (e.event >= next) break;
      if (e.event >= start) latched.set(e.receiver ?? e.probe, e);
    }
    cursor = next;
    const active = [...latched.values()].filter((e) => e.valueUv !== 0);
    activeProbes = new Set(active.map((e) => e.probe));
    levels = new Set(active.flatMap((e) => e.targets));
    find("driveReadout").textContent = levels.size
      ? "Driven · " + [...levels].join(", ")
      : "Drive idle";
    find("nextDrive").disabled = !activity.some(
      (e) => e.event >= cursor && e.valueUv !== 0,
    );
    updateInspector();
  }
  function setActivity(events) {
    activity = events ?? [];
    cursor = -1;
    latched.clear();
    levels.clear();
    activeProbes.clear();
    update(0);
  }
  function load(d, id) {
    device = d;
    registerId = id;
    selected = null;
    el.hidden = find("sceneControls").hidden = !d;
    if (!d) {
      setActivity([]);
      return;
    }
    enlarge.checked = true;
    qubits = new Map(d.qubits.map((q) => [q.id, q]));
    buttons.clear();
    find("registerTitle").textContent = titles[d.kind];
    find("registerCount").textContent = d.qubits.length + " " + counts[d.kind];
    find("registerBasis").textContent =
      (d.basis ?? "Coordinates supplied by the machine design.") +
      " The cutaway enlarges the register in place. Uncheck Enlarge qubits to use one physical scale throughout. " +
      (d.propagation
        ? "Each receiving stage and each addressed site has a timed event. The level is the source-referred control envelope in µV."
        : "Timing ends at the simulated drive probe.");
    const link = find("transportReplay");
    link.hidden = d.kind === "transmon";
    if (d.kind === "ion") {
      link.href = "/qccd-studio";
      link.textContent = "Open H2 transport replay";
    }
    if (d.kind === "atom") {
      link.href = "/validation?platform=neutral";
      link.textContent = "Explore ZAC transport";
    }
    const sorted = d.qubits
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    find("qubitList").replaceChildren(
      ...sorted.map((q) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = q.id;
        b.title = q.site;
        b.onclick = () => inspect(q.id);
        buttons.set(q.id, b);
        return b;
      }),
    );
    setActivity([]);
  }
  enlarge.onchange = () => onScale(enlarge.checked);
  find("fitRegister").onclick = () => {
    enlarge.checked = false;
    onFocus(registerId);
  };
  find("focusQubit").onclick = () => {
    if(!selected) return;
    enlarge.checked=false;
    onFocus(registerId+"/"+selected);
  };
  find("wholeSystem").onclick = () => {
    enlarge.checked = true;
    onHome();
  };
  find("nextDrive").onclick = () => {
    const next = activity.find((e) => e.event >= cursor && e.valueUv !== 0);
    if (next) {
      selected = next.targets[0];
      onJump(next.event + 1);
    }
  };
  return {
    load,
    setActivity,
    update,
    inspect,
    get state() {
      const activeBindings = new Set();
      for (const e of latched.values())
        if (e.valueUv !== 0)
          for (const target of e.targets)
            activeBindings.add(JSON.stringify([e.probe, target]));
      return { levels, activeProbes, activeBindings, selected };
    },
  };
}
