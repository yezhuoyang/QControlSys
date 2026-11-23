import { defineInterconnect } from "./interconnect.mjs";
// A waveform board is an atomic Fabric part with a nested clocked controller trace.
// These on-board nets name transfers already present in that trace.
export function boardLayout(design) {
  let prefix = "@pcb/";
  const taken = [...design.parts, ...design.wires].map((p) => p.id);
  while (taken.some((id) => id.startsWith(prefix))) prefix = "@" + prefix;
  const id = (board, key) => prefix + encodeURIComponent(board) + "/" + key;
  const parts = [],
    links = [];
  for (const board of design.parts.filter((p) => p.model.waveformBoard)) {
    const [w, h, d] = board.sizeMm,
      [x, y, z] = board.centerMm;
    const specs = [
      ["controller", "Waveform FPGA", -0.29, -0.1],
      ["dac-bus", "DMA, waveform RAM and FIFO", 0, -0.1],
      ["dac", "Waveform DAC", 0.29, -0.1],
    ];
    const centers = {};
    for (const [key, label, dx, dz] of specs) {
      const centerMm = [x + dx * w, y + h * 0.23, z + dz * d];
      centers[key] = centerMm;
      parts.push({
        id: id(board.id, key),
        board: board.id,
        local: key,
        label: board.label + " · " + label,
        centerMm,
        sizeMm: [w * 0.2, h * 0.53, d * 0.42],
        form: "board-chip",
        basis:
          "Schematic package on the waveform board. State is recorded by the clocked waveform executor.",
      });
    }
    centers.input = [x - w / 2, y, z];
    centers.output = [x + w / 2, y, z];
    for (const [key, from, to, label] of [
      ["trigger", "input", "controller", "External trigger to waveform FPGA"],
      ["request", "controller", "dac-bus", "DMA request and address"],
      ["word", "dac-bus", "dac", "FIFO sample word"],
      ["play", "controller", "dac", "DAC playback enable"],
      ["analog", "dac", "output", "DAC analog output"],
    ]) {
      const a = centers[from],
        b = centers[to],
        pointsMm = [a];
      if (key === "play")
        pointsMm.push([a[0], a[1], z + d * 0.25], [b[0], b[1], z + d * 0.25]);
      pointsMm.push(b);
      const linkId = id(board.id, key);
      const kind =
        key === "analog" ? "planar" : key === "play" ? "logic" : "parallel";
      links.push({
        id: linkId,
        interconnect: defineInterconnect(linkId, kind, {
          fromPort: from + "." + key,
          toPort: to + "." + key,
          ...(kind === "parallel"
            ? {
                transferWidthBits:
                  key === "word"
                    ? board.model.waveformBoard.profile.busBits
                    : 16,
                beatNs: board.model.waveformBoard.profile.clockNs,
              }
            : {}),
          timingBasis:
            "On-board transfers use the waveform controller clock and the recorded DMA or DAC event.",
        }),
        payloadBits: kind === "parallel" ? 16 : kind === "logic" ? 1 : 0,
        from: from === "input" ? board.id : id(board.id, from),
        to: to === "output" ? board.id : id(board.id, to),
        board: board.id,
        kind: label,
        pointsMm,
        signal: key === "analog" ? "analog" : "digital",
      });
    }
  }
  return { id, parts, links };
}

export function pulseProvenance(run, event) {
  const frames = run.trace.frames,
    stages = new Map((run.delivery?.stages ?? []).map((s) => [s.id, s]));
  const end = stages.get(frames[event]?.part);
  if (!end?.target) throw Error("Choose a recorded qubit arrival event.");
  const pcb = boardLayout(run.design),
    equipment = run.apparatus;
  const parts = new Map(
    [...run.design.parts, ...equipment.parts, ...pcb.parts].map((p) => [
      p.id,
      p,
    ]),
  );
  const links = new Map(
    [...run.design.wires, ...equipment.links, ...pcb.links].map((l) => [
      l.id,
      l,
    ]),
  );
  const chain = [],
    controls = [],
    seenControls = new Set();
  const frame = (id) => frames[id];
  function row(f, overrideLink) {
    const stage = stages.get(f.part);
    const hardware =
      stage?.hardware ?? (f.native ? pcb.id(f.part, f.native.part) : f.part);
    const wire = overrideLink ?? stage?.link ?? f.wire;
    const link = links.get(wire);
    return {
      event: f.id,
      atPs: f.atPs,
      hardware,
      label: stage?.target ?? parts.get(hardware)?.label ?? hardware,
      wire: wire ?? null,
      connection:
        link?.kind ??
        (link?.src
          ? link.src.part +
            "." +
            link.src.port +
            " → " +
            link.dst.part +
            "." +
            link.dst.port
          : null),
      source: f.source,
      pc: f.native?.sourcePc ?? f.pc,
      op: f.op,
      received: f.received,
      emitted: f.emitted,
      ...(f.outputs ? {outputs:f.outputs} : {}),
      parents: f.parents,
      ...(stage
        ? {
            delayPs: stage.delayPs,
            lengthMm: stage.lengthMm,
            wavelengthNm: link?.wavelengthNm,
          }
        : {}),
      ...(f.native
        ? {
            native: f.native.id,
            pcm: f.native.state.pcm,
            code: f.native.state.dacCode,
          }
        : {}),
      ...(f.native?.part === "dac" && f.emitted
        ? { alsoWires: [pcb.id(f.part, "analog")] }
        : {}),
    };
  }
  function branch(label, first, link) {
    if (!first || seenControls.has(first.id)) return;
    seenControls.add(first.id);
    const hops = [];
    for (let f = first; f; f = frame(f.parents[0])) {
      hops.push(row(f, f === first ? link : undefined));
      if (f.native || f.pc != null) break;
    }
    controls.push({ label, hops: hops.reverse() });
  }
  for (let f = frame(event); f; ) {
    let parent = frame(f.parents[0]),
      localWire;
    if (parts.get(f.part)?.model?.switch) {
      const enable = frame(f.state.senseEvent),
        data = frame(f.state.dataEvent);
      branch("Channel selection", enable);
      if (data && data.id !== f.id) parent = data;
    }
    if (f.native?.part === "dac") {
      const parents = f.parents.map(frame);
      const data = parents.find(
        (p) =>
          p.native?.part === "dac-bus" &&
          f.native.parents.includes(p.native.id) &&
          p.op === "beat",
      );
      const play = parents.find(
        (p) =>
          p.native?.part === "controller" &&
          ["play", "playTriggered"].includes(p.op),
      );
      branch("DAC playback enable", play, pcb.id(f.part, "play"));
      if (data) {
        localWire = pcb.id(f.part, "word");
        parent = data;
      }
    } else if (f.native?.part === "dac-bus") {
      const request = f.parents
        .map(frame)
        .find(
          (p) =>
            p.native?.op === "dma" && f.native.parents.includes(p.native.id),
        );
      if (request) {
        localWire = pcb.id(f.part, "request");
        parent = request;
      }
    } else if (f.native && parent?.received?.[0] === "start")
      localWire = pcb.id(f.part, "trigger");
    chain.push(row(f, localWire));
    if (f.pc != null && !f.native) break;
    f = parent;
  }
  chain.reverse();
  const source = run.sourceMap.findLast(
    (s) =>
      s.origin &&
      (frames[event].source === s.id ||
        frames[event].source.startsWith(s.id + "/")),
  );
  const carriers = equipment.links
    .filter((l) => l.carrier && l.forProbes?.includes(end.probe))
    .map((l) => ({
      id: l.id,
      from: l.from,
      to: l.to,
      fromLabel: parts.get(l.from).label,
      toLabel: parts.get(l.to).label,
      wavelengthNm: l.wavelengthNm,
      arm: l.arm,
      kind: l.kind,
    }));
  return {
    event,
    probe: end.probe,
    target: end.target,
    atPs: frames[event].atPs,
    valueUv: frames[event].received[1],
    sourceName:
      run.sourceName ??
      (typeof run.source === "string" ? "OpenQASM editor" : "Control IR"),
    origin: source?.origin ?? frames[event].source,
    calibration: source?.binding ? JSON.parse(source.binding) : null,
    chain,
    controls,
    carriers,
  };
}
