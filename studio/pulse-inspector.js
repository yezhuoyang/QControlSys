import { pulseProvenance } from "/provenance.mjs";

const byId = (id) => document.getElementById(id);
const time = (ps) => ps.toLocaleString("en") + " ps";
function el(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

export function createPulseInspector(jump, inspect) {
  const panel = byId("pulsePanel"),
    choice = byId("pulseChoice");
  let run,
    pulse,
    samples = [],
    cursor = 0,
    following = false,
    rows = [];
  function step(hop) {
    following = true;
    byId("pulseDetails").open = true;
    jump(hop.event);
  }
  function hopButton(hop) {
    const b = el("button", time(hop.atPs));
    b.type = "button";
    b.title = "Inspect event #" + hop.event;
    b.onclick = () => step(hop);
    return b;
  }
  function populate(sample) {
    if (!sample) return;
    choice.value = String(sample.event);
    byId("pulseFollow").disabled = false;
    pulse = pulseProvenance(run, sample.event);
    const gate = pulse.calibration;
    const source =
      typeof run.source === "string" && /line (\d+)/.exec(pulse.origin);
    const line =
      source && run.source.split(/\r?\n/)[Number(source[1]) - 1]?.trim();
    byId("pulseOrigin").textContent = [
      pulse.sourceName,
      pulse.origin,
      line,
      gate && gate[1] + "(" + gate[2].join(", ") + ")",
      "Physical endpoint " + pulse.target,
    ]
      .filter(Boolean)
      .join(" · ");
    const list = byId("pulseHops");
    rows = pulse.chain.map((hop) => {
      const item = el("li", "");
      const data = hop.received ?? hop.emitted;
      const text = [
        hop.label,
        hop.pc != null ? "PC " + hop.pc : null,
        hop.op,
        data ? data[0] + " = " + data[1] : null,
        hop.native ? "board " + hop.native : null,
      ]
        .filter(Boolean)
        .join(" · ");
      item.append(hopButton(hop), el("span", text));
      if (hop.wire) {
        const b = el("button", hop.wire + " · " + hop.connection);
        b.className = "wire-ref";
        b.onclick = () => {
          step(hop);
          inspect(hop.wire);
        };
        item.append(b);
      }
      return item;
    });
    list.replaceChildren(...rows);
    const causes = byId("pulseCauses");
    causes.replaceChildren(
      ...pulse.controls.map((branch) => {
        const row = el("p", branch.label + " ");
        for (const h of branch.hops) {
          const b = hopButton(h);
          b.textContent =
            h.label + " · " + (h.wire ?? h.op) + " · " + time(h.atPs);
          b.onclick = () => {
            step(h);
            if (h.wire) inspect(h.wire);
          };
          row.append(b);
        }
        return row;
      }),
    );
    const carriers = byId("pulseCarriers");
    carriers.replaceChildren();
    if (pulse.carriers.length) {
      carriers.append(el("h3", "Optical carrier paths"));
      for (const c of pulse.carriers) {
        const b = el(
          "button",
          [
            c.wavelengthNm && c.wavelengthNm + " nm",
            c.fromLabel + " → " + c.toLabel,
          ]
            .filter(Boolean)
            .join(" · "),
        );
        b.onclick = () => inspect(c.id);
        b.title = "Inspect the physical carrier · " + c.id;
        carriers.append(b);
      }
      carriers.append(
        el(
          "p",
          "These paths supply the light. The timed hops above follow the modulation envelope.",
        ),
      );
    }
  }
  function update(pos) {
    const moved = cursor !== pos;
    cursor = pos;
    const current = pos - 1;
    const delivered = samples.find((s) => s.event === current);
    if (moved && !following && delivered && delivered.event !== pulse?.event)
      populate(delivered);
    if (!pulse) return;
    const index = pulse.chain.findIndex((h) => h.event === current);
    rows.forEach((row, i) =>
      row.setAttribute("aria-current", String(i === index)),
    );
    byId("pulseAt").textContent =
      index >= 0
        ? "Hop " +
          (index + 1) +
          " of " +
          pulse.chain.length +
          " · " +
          pulse.chain[index].label
        : "";
    byId("pulseNext").disabled = !pulse.chain.some((h) => h.event > current);
  }
  function load(replay) {
    run = replay;
    following = false;
    pulse = null;
    rows = [];
    samples = run?.terminalActivity ?? [];
    panel.hidden = !samples.length;
    if (panel.hidden) {
      choice.replaceChildren();
      return;
    }
    choice.replaceChildren(
      ...samples.map(
        (s) =>
          new Option(
            s.targets.join(", ") +
              " · " +
              s.probe +
              " · " +
              s.valueUv +
              " µV · " +
              time(s.atPs),
            s.event,
          ),
      ),
    );
    populate(samples.find((s) => s.valueUv !== 0) ?? samples[0]);
    byId("pulseDetails").open = false;
    update(0);
  }
  choice.onchange = () => {
    populate(samples.find((s) => s.event === Number(choice.value)));
    step(pulse.chain[0]);
  };
  byId("pulseFollow").onclick = () => step(pulse.chain[0]);
  byId("pulseNext").onclick = () => {
    const h = pulse?.chain.find((h) => h.event >= cursor);
    if (h) step(h);
  };
  return {
    load,
    update,
    inspectQubit(id) {
      following = false;
      const events = samples.filter((s) => s.targets.includes(id));
      if (events.length) {
        populate(
          events.findLast((s) => s.event < cursor && s.valueUv !== 0) ??
            events.find((s) => s.valueUv !== 0) ??
            events[0],
        );
        return;
      }
      pulse = null;
      rows = [];
      choice.selectedIndex = -1;
      byId("pulseOrigin").textContent =
        "No gate pulse in this run addresses " + id + ".";
      for (const key of [
        "pulseHops",
        "pulseCauses",
        "pulseCarriers",
        "pulseAt",
      ])
        byId(key).replaceChildren();
      byId("pulseFollow").disabled = true;
      byId("pulseNext").disabled = true;
    },
    pathAt(event) {
      if (!pulse || (!following && event !== pulse.event)) return;
      const hops = pulse.chain.filter((h) => h.event <= event);
      return {
        parts: hops.map((h) => h.hardware),
        wires: hops
          .flatMap((h) => [h.wire, ...(h.alsoWires ?? [])])
          .filter(Boolean),
        carriers: pulse.carriers.map((c) => c.id),
      };
    },
  };
}
