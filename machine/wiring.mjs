import {
  defineInterconnect,
  validateInterconnect,
  transportTiming,
  payloadPermutation,
  payloadSkewPs,
} from "./interconnect.mjs";

export const pathLengthMm = (points) =>
  points
    .slice(1)
    .reduce(
      (sum, p, i) => sum + Math.hypot(...p.map((v, k) => v - points[i][k])),
      0,
    );

export function sourceSignal(part, port) {
  const m = part?.model;
  if (!m) return;
  if (m.fpga) return { flag: "bit", sclk: "bit", sdi: "bit", csN: "bit", address: "address", tx: "word" }[port];
  if (m.ram || m.bus) return "word";
  if (m.busBuffer) return { out: "word", address: "address", strobe: "bit" }[port];
  if (m.dmaBurst) return "bit";
  if (m.dac || m.clockedDac || m.spiDac81416 || m.rcFilter || m.waveformBoard) return "voltageUv";
  if (m.threshold) return "bit";
  return m.affine?.output ?? m.switch?.signal ?? m.stimulus?.signal;
}
export const payloadWidth = (signal) =>
  ({ bit: 1, word: 16, address: 16 })[signal] ?? 0;
export const defaultMedium = (signal) =>
  signal === "bit" ? "logic" : payloadWidth(signal) ? "parallel" : "coax";

// Ports move with the component. User-supplied bends remain in the lab coordinate frame.
export function electronicRoute(a, b, w) {
  const start = [...a.centerMm],
    end = [...b.centerMm];
  const dx = end[0] - start[0],
    dz = end[2] - start[2],
    axis = Math.abs(dx) >= Math.abs(dz) ? 0 : 2;
  const sign = Math.sign(end[axis] - start[axis]) || 1;
  start[axis] += (sign * a.sizeMm[axis]) / 2;
  end[axis] -= (sign * b.sizeMm[axis]) / 2;
  if (a.model.waveformBoard)
    start.splice(
      0,
      3,
      a.centerMm[0] + a.sizeMm[0] / 2,
      a.centerMm[1],
      a.centerMm[2],
    );
  if (b.model.waveformBoard)
    end.splice(
      0,
      3,
      b.centerMm[0] - b.sizeMm[0] / 2,
      b.centerMm[1],
      b.centerMm[2],
    );
  for (const [key, endpoint, component] of [["fromOffsetMm",start,a],["toOffsetMm",end,b]]) {
    if(w[key]===undefined) continue;
    if(!Array.isArray(w[key]) || w[key].length!==3 || !w[key].every(Number.isFinite))
      throw Error("Invalid port offset in mm: "+w.id);
    for(let i=0;i<3;i++) endpoint[i]=component.centerMm[i]+w[key][i];
  }
  const middle = start.map((n, i) => (n + end[i]) / 2);
  middle[1] += Math.max(2, Math.min(12, Math.hypot(dx, dz) * 0.05));
  if (
    w.viaMm !== undefined &&
    (!Array.isArray(w.viaMm) ||
      w.viaMm.length > 1024 ||
      !w.viaMm.every(
        (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite),
      ))
  )
    throw Error("Invalid wire bends in mm: " + w.id);
  return [start, ...(w.viaMm ?? [middle]), end];
}

export function defineBoardWire(
  w,
  signal,
  kind = defaultMedium(signal),
  options = {},
) {
  return defineInterconnect(w.id, kind, {
    fromPort: w.src.port,
    toPort: w.dst.port,
    ...options,
  });
}

function wireTransfer(spec, pointsMm, payloadBits) {
  const timing = transportTiming(spec, pathLengthMm(pointsMm), payloadBits);
  return {
    timing,
    skewPs: payloadSkewPs(spec, payloadBits),
    servicePs: timing.serializationPs,
    wordPinMap: payloadPermutation(spec, payloadBits),
  };
}

export function apparatusWire(link, output, input) {
  const {timing, skewPs, servicePs, wordPinMap} =
    wireTransfer(link.interconnect, link.pointsMm, link.payloadBits);
  return {
    id: link.id,
    src: {part: link.from, port: output},
    dst: {part: link.to, port: input},
    delayPs: Math.max(1, timing.flightPs + skewPs),
    ...(servicePs ? {servicePs} : {}),
    ...(wordPinMap ? {wordPinMap} : {}),
  };
}

export function wireExecution(w, parts) {
  const a = parts.get(w.src.part),
    b = parts.get(w.dst.part);
  if (!a || !b) throw Error(w.id + ": unknown source or destination.");
  const pointsMm = electronicRoute(a, b, w);
  const signal = sourceSignal(a, w.src.port);
  const payloadBits = w.addressBits ?? payloadWidth(signal);
  if (w.addressBits !== undefined && (signal!=="address" || !Number.isInteger(payloadBits) ||
    payloadBits<1 || payloadBits>16 || !w.interconnect)) throw Error("Invalid address bus width on "+w.id);
  if (!w.interconnect) return { pointsMm, payloadBits };
  validateInterconnect(w.interconnect);
  if (
    w.interconnect.id !== w.id ||
    w.interconnect.fromPort !== w.src.port ||
    w.interconnect.toPort !== w.dst.port
  )
    throw Error("Wire endpoints differ from the physical connector on " + w.id);
  const digital =
    ["logic", "parallel", "differential"].includes(w.interconnect.kind) ||
    ["serial-nrz", "logic-level"].includes(w.interconnect.encoding);
  if (Boolean(payloadBits) !== digital)
    throw Error(
      "Physical interface does not encode the source signal on " + w.id,
    );
  if (w.interconnect.encoding === "logic-level" && payloadBits !== 1)
    throw Error("A logic wire carries a single bit on " + w.id);
  if (!Number.isSafeInteger(w.delayPs) || w.delayPs < 1)
    throw Error(w.id + ": each wire needs positive delayPs.");
  const transfer = wireTransfer(w.interconnect, pointsMm, payloadBits);
  if(signal==="address" && payloadBits<16) {
    const map=transfer.wordPinMap;
    transfer.wordPinMap=Array.from({length:16},(_,i)=>{
      const src=map?.[i] ?? i;
      return i<payloadBits && src<payloadBits ? src : 16;
    });
  }
  return {
    pointsMm,
    payloadBits,
    ...transfer,
    delayPs: w.delayPs + transfer.timing.flightPs + transfer.skewPs,
  };
}

export function physicalRoute(link, device) {
  let kind = link.transportKind,
    bits = 0;
  if (kind === "serial") kind = "differential";
  if (!kind && device.kind === "transmon")
    kind = link.to.endsWith("/register") ? "planar" : "coax";
  if (!kind && device.kind === "ion") {
    if (link.controlBus || (link.dcLane && link.signal === "electrical"))
      kind = "parallel";
    else if (link.dcLane) kind = "dc";
    else if (link.signal === "optical")
      kind = /fiber/i.test(link.kind) ? "fiber" : "beam";
    else if (
      ["PGA contact pins", "Package bonds to trap electrodes"].includes(
        link.kind,
      )
    )
      kind = "planar";
    else if (
      [
        "RF electrode supply",
        "Vacuum RF conductor",
        "RF coax to transducer",
        "Electrical gate envelope",
      ].includes(link.kind)
    )
      kind = "coax";
  }
  if (!kind) throw Error("Physical medium is undeclared for " + link.kind);
  if (kind === "parallel") bits = link.payloadBits ?? 16;
  if (kind === "logic") bits = 1;
  if (kind === "differential") bits = link.payloadBits ?? 16;
  let spec = defineInterconnect(link.id, kind, {
    fromPort:
      link.fromPort ??
      link.kind + " out" + (link.contactIndex ? " " + link.contactIndex : ""),
    toPort:
      link.toPort ??
      link.kind + " in" + (link.contactIndex ? " " + link.contactIndex : ""),
    ...(kind === "dc" && link.dcLane ? { sharedReturn: "DC common" } : {}),
    ...(kind === "fiber"
      ? { speedMmPerNs: device.propagation?.fiberMmPerNs ?? 200 }
      : {}),
    ...(kind === "beam"
      ? { speedMmPerNs: device.propagation?.opticalMmPerNs ?? 299.792458 }
      : {}),
    ...(!["fiber", "beam", "planar"].includes(kind)
      ? { speedMmPerNs: device.propagation?.electricalMmPerNs ?? 200 }
      : {}),
    ...(["fiber", "beam"].includes(kind)
      ? {
          opticalMode: {
            wavelengthNm:
              link.wavelengthNm ??
              (/fluorescence/i.test(link.kind) ? 369.5 : 355),
          },
          provenance: link.wavelengthNm
            ? "Wavelength from the reference optical arm. Guide widths are drawing parameters."
            : "Illustrative ytterbium laser wavelength. This parameter is not an H2 laser measurement.",
        }
      : {}),
    ...link.transportOptions,
  });
  if (link.diameterMm && spec.conductors.length) {
    const width = Math.max(
      ...spec.conductors.map(
        (c) => Math.abs(c.offsetMm) * 2 + (c.diameterMm ?? c.widthMm),
      ),
    );
    const scale = link.diameterMm / width;
    spec = {
      ...spec,
      conductors: spec.conductors.map((c) => {
        const part = { ...c };
        for (const key of [
          "offsetMm",
          "diameterMm",
          "innerDiameterMm",
          "widthMm",
          "thicknessMm",
        ])
          if (c[key] !== undefined) part[key] *= scale;
        return part;
      }),
    };
    validateInterconnect(spec);
  }
  return { interconnect: spec, payloadBits: bits };
}
