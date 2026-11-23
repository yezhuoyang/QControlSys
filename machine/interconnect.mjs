// Lengths are mm. Geometry is a transverse cut through a swept centerline.
// The SI vacuum speed is exact (https://www.bipm.org/en/si-base-units/metre).
const vacuumSpeed = 299.792458;
const kinds = {
  logic: ["copper signal and return", "logic-level", 1, 190],
  parallel: ["parallel copper conductors", "parallel-beats", 16, 190],
  differential: ["differential copper pair with reference", "serial-nrz", 1, 195],
  coax: ["coaxial cable", "held-analog", 0, 200],
  dc: ["copper signal and return", "held-analog", 0, 190],
  contact: ["conductive package contact", "held-analog", 0, 190],
  planar: ["coplanar microwave trace and ground", "held-analog", 0, 125],
  fiber: ["optical fiber", "optical-envelope", 0, 204],
  beam: ["free space", "optical-envelope", 0, vacuumSpeed],
};
const timing = {
  "logic-level": "One logic transition propagates at the effective line velocity. The producer schedules the next transition.",
  "held-analog": "An ideal held analog value propagates at the effective line velocity. The source program determines the waveform update interval.",
  "optical-envelope": "An ideal optical envelope propagates at the specified group velocity. Carrier cycles, dispersion and diffraction lie outside this transport model.",
  "parallel-beats": "Payload bits fill parallel beats in increasing source bit order. Connector crossovers use reference geometry. Per-pin skew is an independent timing input for actual lane differences.",
  "serial-nrz": "One serial frame per nonempty payload. Framing overhead is applied before block encoding. A partial final block is padded. The receiver completes after the last bit and flight time.",
};
const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x) &&
  (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const string = (x) => typeof x === "string" && x.trim().length > 0;
const integer = (x, lo, hi = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(x) && x >= lo && x <= hi;
function requireField(condition, message) {
  if (!condition) throw Error("Invalid interconnect: " + message);
}
const positive = (x) => Number.isFinite(x) && x > 0;
const optical = (kind) => kind === "fiber" || kind === "beam";
const lane = (id, role, offsetMm, diameterMm) => ({ id, role, offsetMm, diameterMm });

function referenceCrossSection(kind, width, sharedReturn, strobeLink) {
  if (optical(kind)) return [];
  if (kind === "planar") {
    // Width and gap match the native Quantum Metal drive pin. The finite
    // ground-strip drawing extents and film thickness are reference choices.
    const strip = (id, role, offsetMm, widthMm) => ({
      id, role, offsetMm, widthMm, thicknessMm: 0.00012, shape: "strip",
    });
    return [strip("left-ground", "return", -0.031, 0.04), strip("trace", "signal", 0, 0.010),
      strip("right-ground", "return", 0.031, 0.04)];
  }
  if (kind === "coax") return [
    lane("core", "signal", 0, 0.5),
    { ...lane("outer", "shield", 0, 2.159), innerDiameterMm: 1.65 },
  ];
  if (kind === "differential") return [
    lane("P", "positive", -0.22, 0.2), lane("N", "negative", 0.22, 0.2),
    lane("REF", "return", 0.82, 0.24),
  ];
  if (kind === "parallel") {
    requireField(integer(width, 1, 255), "parallel width must be 1–255 bits");
    const conductors = [];
    for (let i = 0; i < width + (strobeLink ? 0 : 1); i++) {
      const x = (2 * i - width - 0.5) * 0.5;
      conductors.push(i === width ? lane("CLK", "clock", x, 0.2) :
        { ...lane("D" + i, "data", x, 0.2), bitIndex: i });
      conductors.push(lane("G" + i, "return", x + 0.5, 0.2));
    }
    return conductors;
  }
  const diameter = kind === "dc" ? 0.46 : 0.23;
  if (sharedReturn !== null && (kind === "dc" || kind === "contact")) return [lane("signal", "signal", 0, diameter)];
  return [lane("signal", "signal", -0.4, diameter), lane("return", "return", 0.4, diameter)];
}

function referenceMode(kind) {
  if (kind === "fiber") return {
    id: "guided-mode", role: "guided", offsetMm: 0, wavelengthNm: 850,
    diameterMm: 0.0055, coreDiameterMm: 0.005, claddingDiameterMm: 0.125, jacketDiameterMm: 0.9,
  };
  if (kind === "beam") return {
    id: "beam-mode", role: "free-space", offsetMm: 0, wavelengthNm: 850, diameterMm: 0.6,
  };
  return null;
}

function referenceSerialFormat(overhead, dataBits, wireBits) {
  return {
    bitOrder: "lsb-first",
    prefixBits: overhead === 0 ? "" : overhead <= 2 ? "0" : null,
    suffixBits: overhead === 2 ? "1" : overhead <= 1 ? "" : null,
    paddingBit: 0,
    blockEncoding: dataBits === wireBits ? "identity" : "rate-only",
  };
}

// Physical pin labels are local to each named terminal. A package pin can be
// named independently of the logical bit received there (e.g. J4.17 → bit 0).
// Older documents infer the endpoint labels from their existing conductor IDs.
export function conductorPinout(spec) {
  requireField(Array.isArray(spec.conductors), "invalid conductor list");
  const dataIds = new Map(spec.conductors.filter(c => c?.role === "data").map(c => [c.bitIndex, c.id]));
  return spec.conductors.map(c => {
    requireField(record(c), "invalid conductor geometry");
    const data = c.role === "data";
    const destination = Object.hasOwn(c, "destinationBitIndex") ? c.destinationBitIndex : c.bitIndex;
    const destinationId = data && spec.pinRouting !== "inside-receiver" ? dataIds.get(destination) : c.id;
    return {
      ...c,
      fromPin: Object.hasOwn(c, "fromPin") ? c.fromPin : spec.fromPort + "." + c.id,
      toPin: Object.hasOwn(c, "toPin") ? c.toPin : spec.toPort + "." + destinationId,
      skewPs: Object.hasOwn(c, "skewPs") ? c.skewPs : 0,
      ...(data ? { destinationBitIndex: destination } : {}),
    };
  });
}

// Pass an explicit conductors array to replace the entire electrical cross-section.
// opticalMode accepts named overrides, e.g. {wavelengthNm: 355, diameterMm: 0.45}.
export function defineInterconnect(id, kind, options = {}) {
  requireField(string(kind) && Object.hasOwn(kinds, kind), "unknown kind");
  requireField(record(options), "options must be an object");
  const [medium, defaultEncoding, defaultWidth, speedMmPerNs] = kinds[kind];
  const encoding = Object.hasOwn(options, "encoding") ? options.encoding : defaultEncoding;
  const width = Object.hasOwn(options, "transferWidthBits") ? options.transferWidthBits :
    ["serial-nrz", "logic-level"].includes(encoding) ? 1 : defaultWidth;
  const spec = {
    id, kind, fromPort: "out", toPort: "in", medium, encoding, transferWidthBits: width, speedMmPerNs,
    lengthMm: null, timingBasis: timing[encoding], provenance:
      "Reference design assumptions for geometry, velocity and transfer parameters. Supply calibrated values for a specific installation.",
    sharedReturn: null, polarity: kind === "differential" ? "positive-follows-logical-bit" : null,
    pinRouting: kind === "parallel" ? "connector" : null,
    ...(options.strobeLink !== undefined ? {strobeLink: options.strobeLink} : {}),
    conductors: referenceCrossSection(kind, width, options.sharedReturn ?? null, options.strobeLink), opticalMode: referenceMode(kind),
    beatNs: encoding === "parallel-beats" ? 4 : null,
    bitRateGbps: encoding === "serial-nrz" ? 2.5 : null,
    frameOverheadBits: 0, lineCodeDataBits: 1, lineCodeWireBits: 1,
    serialFormat: encoding === "serial-nrz" ? referenceSerialFormat(options.frameOverheadBits ?? 0,
      options.lineCodeDataBits ?? 1, options.lineCodeWireBits ?? 1) : null,
  };
  for (const [key, value] of Object.entries(options)) {
    requireField(Object.hasOwn(spec, key) && key !== "id" && key !== "kind", "unknown option " + key);
    if (key === "opticalMode" && record(value) && optical(kind))
      spec.opticalMode = { ...spec.opticalMode, ...value };
    else if (key === "serialFormat" && record(value) && encoding === "serial-nrz")
      spec.serialFormat = { ...spec.serialFormat, ...value };
    else spec[key] = structuredClone(value);
  }
  spec.conductors = conductorPinout(spec);
  return validateInterconnect(spec);
}

function validateCrossSection(spec) {
  const { kind, conductors, opticalMode } = spec;
  requireField(Array.isArray(conductors) && conductors.length <= 512, "invalid conductor list");
  requireField(spec.sharedReturn === null || ["dc", "contact"].includes(kind) && string(spec.sharedReturn),
    "a shared return must name an external return net on a DC line or package contact");
  if (optical(kind)) {
    requireField(conductors.length === 0 && record(opticalMode), "optical links require a mode and zero conductors");
    requireField(string(opticalMode.id) && opticalMode.offsetMm === 0 &&
      positive(opticalMode.wavelengthNm) && positive(opticalMode.diameterMm), "invalid optical mode dimensions");
    if (kind === "fiber")
      requireField(opticalMode.role === "guided" && positive(opticalMode.coreDiameterMm) &&
        positive(opticalMode.claddingDiameterMm) && positive(opticalMode.jacketDiameterMm) &&
        opticalMode.claddingDiameterMm > Math.max(opticalMode.coreDiameterMm, opticalMode.diameterMm) &&
        opticalMode.jacketDiameterMm >= opticalMode.claddingDiameterMm, "invalid guided fiber cross-section");
    else requireField(opticalMode.role === "free-space" &&
      ["coreDiameterMm", "claddingDiameterMm", "jacketDiameterMm"].every(k => !(k in opticalMode)),
      "free-space mode cannot have a physical fiber jacket or core");
    return;
  }
  requireField(opticalMode === null, "electrical links cannot contain an optical mode");
  const ids = new Set(), bits = new Set(), receivedBits = new Set(), counts = new Map();
  const sourcePins = new Set(), destinationPins = new Set();
  for (const wire of conductorPinout(spec)) {
    requireField(record(wire) && string(wire.id) && !ids.has(wire.id), "invalid or duplicate conductor id");
    requireField(string(wire.fromPin) && !sourcePins.has(wire.fromPin), "invalid or duplicate source pin");
    requireField(string(wire.toPin) && !destinationPins.has(wire.toPin), "invalid or duplicate destination pin");
    requireField(integer(wire.skewPs, 0), "conductor skew must be a nonnegative integer in ps");
    sourcePins.add(wire.fromPin);
    destinationPins.add(wire.toPin);
    requireField(string(wire.role) && Number.isFinite(wire.offsetMm), "invalid conductor role or offset");
    if (kind === "planar")
      requireField(wire.shape === "strip" && positive(wire.widthMm) && positive(wire.thicknessMm) &&
        !("diameterMm" in wire), "coplanar conductors need strip width and film thickness");
    else requireField(positive(wire.diameterMm) && !("widthMm" in wire) && !("thicknessMm" in wire) &&
      (wire.shape === undefined || wire.shape === "round"), "invalid round conductor geometry");
    ids.add(wire.id);
    counts.set(wire.role, (counts.get(wire.role) ?? 0) + 1);
    if (wire.role === "data") {
      requireField(integer(wire.bitIndex, 0, spec.transferWidthBits - 1) && !bits.has(wire.bitIndex),
        "invalid or duplicate data bit index");
      requireField(integer(wire.destinationBitIndex, 0, spec.transferWidthBits - 1) && !receivedBits.has(wire.destinationBitIndex),
        "destination bit indices must form a permutation");
      bits.add(wire.bitIndex);
      receivedBits.add(wire.destinationBitIndex);
    } else requireField(!("bitIndex" in wire) && !("destinationBitIndex" in wire), "only parallel data lanes carry bit indices");
    if (wire.role !== "shield") requireField(!("innerDiameterMm" in wire), "only the coax shield has a bore");
  }
  const roles = kind === "coax" ? { signal: 1, shield: 1 } :
    kind === "parallel" ? { data: spec.transferWidthBits, ...(spec.strobeLink ? {} : {clock: 1}), return: counts.get("return") } :
    kind === "planar" ? { signal: 1, return: 2 } : spec.sharedReturn !== null ? { signal: 1 } :
    kind === "differential" ? { positive: 1, negative: 1, return: 1 } : { signal: 1, return: 1 };
  requireField(counts.size === Object.keys(roles).length &&
    Object.entries(roles).every(([key, n]) => n > 0 && counts.get(key) === n), "conductor roles do not match the medium and transfer width");
  if (kind === "coax") {
    const core = conductors.find((c) => c.role === "signal"), shield = conductors.find((c) => c.role === "shield");
    requireField(core.offsetMm === 0 && shield.offsetMm === 0 && positive(shield.innerDiameterMm) &&
      shield.innerDiameterMm > core.diameterMm && shield.diameterMm > shield.innerDiameterMm,
      "coax requires an insulated core centered inside its return shield");
  } else {
    const sorted = [...conductors].sort((a, b) => a.offsetMm - b.offsetMm);
    const width = (conductor) => kind === "planar" ? conductor.widthMm : conductor.diameterMm;
    if (kind === "planar")
      requireField(sorted[1].role === "signal", "the coplanar trace must lie between its two ground banks");
    for (let i = 1; i < sorted.length; i++)
      requireField(sorted[i].offsetMm - sorted[i - 1].offsetMm > (width(sorted[i]) + width(sorted[i - 1])) / 2,
        "conductor cross-sections touch or overlap");
    if (kind === "parallel" && spec.pinRouting !== "inside-receiver" &&
        conductors.some(c => c.role === "data" && (c.destinationBitIndex ?? c.bitIndex) !== c.bitIndex)) {
      const atBit = new Map(conductors.filter(c => c.role === "data").map(c => [c.bitIndex, c.offsetMm]));
      const end = conductors.map(c => ({ x: c.role === "data" ? atBit.get(c.destinationBitIndex ?? c.bitIndex) : c.offsetMm,
        radius: c.diameterMm / 2 })).sort((a,b) => a.x - b.x);
      requireField(end.slice(1).every((p,i) => p.x - end[i].x > p.radius + end[i].radius),
        "conductors touch or overlap at their destination connector");
    }
  }
}

export function validateInterconnect(spec) {
  requireField(record(spec) && string(spec.id) && string(spec.kind) && Object.hasOwn(kinds, spec.kind), "unknown kind or empty id");
  if(spec.strobeLink!==undefined) requireField(spec.kind==="parallel" && string(spec.strobeLink) &&
    spec.strobeLink!==spec.id, "external strobe must identify a separate wire on a parallel interface");
  for (const key of ["fromPort", "toPort", "medium", "timingBasis", "provenance"])
    requireField(string(spec[key]), "missing or invalid " + key);
  if (Object.hasOwn(spec, "polarity")) requireField(spec.kind === "differential" ?
    spec.polarity === "positive-follows-logical-bit" : spec.polarity === null, "invalid differential polarity convention");
  if (Object.hasOwn(spec, "pinRouting")) requireField(spec.kind === "parallel" ?
    ["connector", "inside-receiver"].includes(spec.pinRouting) : spec.pinRouting === null,
    "select connector or inside-receiver pin routing on a parallel bus");
  requireField(positive(spec.speedMmPerNs) && spec.speedMmPerNs <= vacuumSpeed, "invalid effective propagation speed in mm/ns");
  requireField(spec.lengthMm === null || Number.isFinite(spec.lengthMm) && spec.lengthMm >= 0, "invalid installed length in mm");
  const serial = spec.encoding === "serial-nrz", parallel = spec.kind === "parallel";
  requireField(spec.encoding === kinds[spec.kind][1] || optical(spec.kind) && serial ||
    ["differential", "coax"].includes(spec.kind) && spec.encoding === "logic-level", "encoding does not match link kind");
  requireField(parallel ? integer(spec.transferWidthBits, 1, 255) :
    spec.transferWidthBits === (serial || spec.encoding === "logic-level" ? 1 : 0), "invalid transfer width");
  requireField(parallel ? positive(spec.beatNs) : spec.beatNs === null, "parallel beat duration belongs to a parallel bus");
  requireField(serial ? positive(spec.bitRateGbps) : spec.bitRateGbps === null, "serial bit rate belongs to a serial encoding");
  requireField(integer(spec.frameOverheadBits, 0) && integer(spec.lineCodeDataBits, 1) &&
    integer(spec.lineCodeWireBits, spec.lineCodeDataBits), "invalid serial framing or code block ratio");
  requireField(serial || spec.frameOverheadBits === 0 && spec.lineCodeDataBits === 1 && spec.lineCodeWireBits === 1,
    "framing and block encoding belong to a serial link");
  if (serial) {
    const format = Object.hasOwn(spec, "serialFormat") ? spec.serialFormat :
      referenceSerialFormat(spec.frameOverheadBits, spec.lineCodeDataBits, spec.lineCodeWireBits);
    requireField(record(format) && ["lsb-first", "msb-first"].includes(format.bitOrder) &&
      [0, 1].includes(format.paddingBit), "invalid serial bit order or padding bit");
    const framed = typeof format.prefixBits === "string" && typeof format.suffixBits === "string" &&
      /^[01]*$/.test(format.prefixBits) && /^[01]*$/.test(format.suffixBits) &&
      format.prefixBits.length + format.suffixBits.length === spec.frameOverheadBits;
    requireField(framed || format.prefixBits === null && format.suffixBits === null, "prefix/suffix bits do not match frame overhead");
    requireField(format.blockEncoding === "rate-only" || format.blockEncoding === "identity" &&
      spec.lineCodeWireBits === spec.lineCodeDataBits, "identity encoding requires equal input/output block widths");
  } else requireField(spec.serialFormat == null, "serial framing symbols belong to a serial link");
  validateCrossSection(spec);
  return spec;
}

function exact(n) {
  requireField(integer(n, 0), "transport count exceeds exact arithmetic range");
  return n;
}

function blocks(bits, width) {
  return Number((BigInt(bits) + BigInt(width) - 1n) / BigInt(width));
}

// Explicit installed length overrides traced route length. A zero-length link has
// zero flight time. Scheduling rules may independently impose a minimum event delay.
export function transportTiming(spec, lengthMm, payloadBits = 0) {
  validateInterconnect(spec);
  requireField(lengthMm === undefined || Number.isFinite(lengthMm) && lengthMm >= 0, "invalid routed length in mm");
  const length = spec.lengthMm ?? lengthMm;
  requireField(Number.isFinite(length) && length >= 0, "supply an installed or routed length");
  requireField(integer(payloadBits, 0), "payloadBits must be a nonnegative integer");
  const flightPs = exact(Math.ceil(length * 1000 / spec.speedMmPerNs));
  let wireBits = 0, beats = 0, serializationPs = 0;
  if (spec.encoding === "parallel-beats") {
    beats = blocks(payloadBits, spec.transferWidthBits);
    wireBits = exact(beats * spec.transferWidthBits);
    serializationPs = exact(Math.ceil(beats * spec.beatNs * 1000));
  } else if (spec.encoding === "serial-nrz" && payloadBits > 0) {
    const dataBits = exact(payloadBits + spec.frameOverheadBits);
    wireBits = exact(blocks(dataBits, spec.lineCodeDataBits) * spec.lineCodeWireBits);
    beats = wireBits;
    serializationPs = exact(Math.ceil(wireBits * 1000 / spec.bitRateGbps));
  } else if (spec.encoding === "logic-level") {
    requireField(payloadBits <= 1, "a logic transition carries at most one bit");
    wireBits = payloadBits;
  } else requireField(payloadBits === 0, "an analog envelope carries no framed payload bits");
  return { flightPs, serializationPs, totalPs: exact(flightPs + serializationPs), beats, wireBits, payloadBits };
}

// Return the source bit at each logical destination bit, from lowest to highest.
// In a partial final beat, a source index equal to payloadBits represents padded
// zero. A signal that lands above the receiver payload width is discarded.
export function payloadPermutation(spec, payloadBits) {
  validateInterconnect(spec);
  requireField(integer(payloadBits, 0), "payloadBits must be a nonnegative integer");
  if (spec.kind !== "parallel" || !payloadBits) return null;
  const width = spec.transferWidthBits;
  const sourceOf = new Array(width);
  for (const lane of spec.conductors) {
    if (lane.role === "data") sourceOf[lane.destinationBitIndex ?? lane.bitIndex] = lane.bitIndex;
  }
  if (sourceOf.slice(0, payloadBits).every((source, dest) => source === dest)) return null;
  requireField(payloadBits <= 1_048_576, "an expanded pin permutation is limited to 1,048,576 bits");
  return Array.from({length: payloadBits}, (_, dest) => {
    const index = dest % width;
    return Math.min(payloadBits, dest - index + sourceOf[index]);
  });
}

// Latest skew amongst lanes that carry bits or the sampling clock. A referenced
// return is an electrical reference, not a second scheduled data transition.
export function payloadSkewPs(spec, payloadBits = spec.transferWidthBits) {
  validateInterconnect(spec);
  requireField(integer(payloadBits, 0), "payloadBits must be a nonnegative integer");
  if (spec.kind !== "parallel" || payloadBits === 0) return 0;
  const width = spec.transferWidthBits;
  const beats = blocks(payloadBits, width);
  const finalBits = payloadBits - (beats - 1) * width;
  const releasePs = exact(Math.ceil(beats * spec.beatNs * 1000));
  const priorReleasePs = exact(Math.ceil((beats - 1) * spec.beatNs * 1000));
  let delayPs = 0;
  for (const lane of spec.conductors) {
    if (lane.role !== "data" && lane.role !== "clock") continue;
    const skew = lane.skewPs ?? 0;
    if (lane.role === "clock" || (lane.destinationBitIndex ?? lane.bitIndex) < finalBits) {
      delayPs = Math.max(delayPs, skew);
    } else if (beats > 1) {
      // This lane's last required bit belongs to the preceding complete beat.
      delayPs = Math.max(delayPs, skew - (releasePs - priorReleasePs));
    }
  }
  return delayPs;
}

// A bit string is in wire-time order: element i occupies [i/R, (i+1)/R).
// Negative integer values use the low N bits of two's complement. Differential
// P/N are nominal logic levels; actual common-mode and swing are outside this model.
// Rate-only configurations retain exact timing without claiming a particular codeword.
export function serialSymbols(spec, value, payloadBits) {
  validateInterconnect(spec);
  if (spec.encoding !== "serial-nrz") return null;
  const format = spec.serialFormat ?? referenceSerialFormat(spec.frameOverheadBits, spec.lineCodeDataBits, spec.lineCodeWireBits);
  if (format.blockEncoding === "rate-only" || format.prefixBits === null) return null;
  requireField(integer(payloadBits, 0), "invalid serial payload width");
  const framed = payloadBits ? exact(payloadBits + spec.frameOverheadBits) : 0;
  const count = exact(blocks(framed, spec.lineCodeDataBits) * spec.lineCodeWireBits);
  // Inspect one bounded frame. transportTiming can account for longer transfers.
  requireField(count <= 1_048_576, "symbol inspection is limited to 1,048,576 symbols per frame");
  requireField(typeof value === "bigint" || Number.isSafeInteger(value) || typeof value === "boolean" && payloadBits === 1,
    "serial value must be an integer");
  const paddingBits = count - framed;
  let bits = "";
  if (payloadBits) {
    let payload = BigInt.asUintN(payloadBits, BigInt(value)).toString(2).padStart(payloadBits, "0");
    if (format.bitOrder === "lsb-first") payload = [...payload].reverse().join("");
    bits = format.prefixBits + payload + format.suffixBits + String(format.paddingBit).repeat(paddingBits);
  }
  const pair = spec.kind === "differential";
  return { bits, positive: pair ? bits : null, negative: pair ? bits.replace(/[01]/g, c => c === "0" ? "1" : "0") : null,
    bitOrder: format.bitOrder, prefixBits: format.prefixBits, suffixBits: format.suffixBits,
    paddingBits, symbolPeriodPs: 1000 / spec.bitRateGbps };
}
