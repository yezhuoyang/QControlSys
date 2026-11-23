import {apparatusWire as wire} from "./wiring.mjs";

// Millimetres about the atom register. +Y is vertical. The footprints and
// folds below are reference design choices. The source fixes the optical roles.
export const neutralSources = {
  apparatus: "https://arxiv.org/html/2312.03982v1#Sx1.F1",
  paper: "https://doi.org/10.1038/s41586-023-06927-3",
  movingAod: "https://aaoptoelectronic.com/dtsx-400-850/",
  camera: "https://www.hamamatsu.com/content/dam/hamamatsu-photonics/sites/documents/99_SALES_LIBRARY/sys/SCAS0154E_C15550-20UP_tec.pdf",
};

export const neutralSteeringLanes = ["moving-x", "moving-y", "rearrange-x", "rearrange-y", "raman-x", "raman-y"];

export function neutralInstallation({ device, inputs, chip, add, route, electronics = [] }) {
  const byProbe = new Map(device.drives.map((d) => [d.probe, d]));
  const local = inputs.filter((p) => byProbe.get(p).targets.length === 1);
  const pair = inputs.filter((p) => byProbe.get(p).targets.length > 1);
  const points = new Map([[chip, [0, 0, 0]]]);
  const packages = new Map(electronics.map(p => [p.id,p]));
  const panelPorts = new Map();
  function focusOf(probes) {
    const ids = new Set(probes.flatMap((p) => byProbe.get(p).targets));
    const qubits = ids.size ? device.qubits.filter((q) => ids.has(q.id)) : device.qubits;
    return [0, 1, 2].map((i) =>
      qubits.reduce((sum, q) => sum + q.positionMm[i], 0) / qubits.length);
  }
  const basis = "Reference placement and envelope in mm. Optical roles from Bluvstein et al., Extended Data Fig. 1. ";
  function part(key, label, form, center, size, note = "", src = neutralSources.apparatus) {
    const id = add(key, label, "na-" + form, center, size, basis + note + " " + src);
    points.set(id, center);
    packages.set(id,{form,sizeMm:size});
    // Pedestal height follows the component's lower surface. The science
    // cell and objectives are side mounted to keep their optical axis clear.
    if (["laser", "aom", "aod-x", "aod-y", "pbs", "profile", "slm", "fold", "lens-z", "lens-x"].includes(form)
        && center[1] <= 0 && (center[0] !== 0 || center[2] !== 0)) {
      const bottom = center[1] - size[1] / 2;
      const height = bottom + 136;
      if (height > 0) add(key + "-post", label + " mounting post", "na-stand",
        [center[0], -136 + height / 2, center[2]], [12, height, 12],
        "Assumed post from the optical shelf to the component mount, in millimetres.");
    }
    return id;
  }
  function world(id, port) {
    return points.get(id).map((n, axis) => device.centerMm[axis] + n + (port?.[axis] ?? 0));
  }
  function beam(from, to, wavelengthNm, arm, probes = [], forProbes = [], fromPort, toPort) {
    if (to === chip && !toPort) toPort = focusOf(probes.length ? probes : forProbes);
    if (from === chip && !fromPort) fromPort = focusOf([]);
    const fluorescence = arm === "Fluorescence collection";
    const kind = fluorescence ? arm : probes.length ? "Optical delivery" : "Optical carrier";
    // Guide diameters are display annotations. Neither the laser waist nor
    // the solid angle subtended by the imaging objective is inferred here.
    const guide = { diameterMm: 0.7 };
    if (from === chip || to === chip) {
      guide.registerEnd = from === chip ? "from" : "to";
      guide.registerTipDiameterMm = 0.00013;
    }
    route(from, to, kind, probes, fromPort, toPort, {
      signal: "optical", wavelengthNm, arm, carrier: !probes.length && !fluorescence, forProbes,
      transportKind:"beam", fromPort:from === chip ? "fluorescence" : "exit aperture",
      toPort:to === chip ? "atom plane" : "entrance aperture",
      held:!probes.length && !forProbes.length,
      ...guide,
      basis: probes.length
        ? "Executable source-referred envelope along the optical path. The voltage represents the upstream command."
        : fluorescence
          ? "Collection geometry for 780 nm fluorescence. Photon counts are outside this pulse replay."
          : "Optical carrier path. Laser phase, power and the timing of independent light gates are unspecified.",
      pointsMm: [world(from, fromPort), world(to, toPort)],
    });
  }
  function connector(id, port) {
    const component=packages.get(id);
    if (!component?.sizeMm) return undefined;
    const {form,sizeMm:[w,h,d]}=component;
    if (form === "contact") return [0,0,0];
    if (form === "dac" && port === "RF.out") return [0,0,d*0.45];
    if (port === "transducer.RF") return form === "aod-y" ? [0,h/2,0] : [0,0,d/2];
    if (form === "rf-amp") {
      if (port === "RF.out") return [0,0,-d/2];
      if (port === "RF.in" || port === "RF.key") return [0,0,d/2];
    }
    if (form === "rf-switch") {
      if (port === "RF.common") return [0,0,-d/2];
      if (port.endsWith(".enable")) return [w/2,0,d*(port.startsWith("moving") ? 0.2 : -0.2)];
    }
    // Independent rear-panel contacts on a reference rectangular grid. Reuse
    // an endpoint only when the same named port actually appears twice.
    if (!panelPorts.has(id)) panelPorts.set(id,new Map());
    const ports=panelPorts.get(id);
    if (!ports.has(port)) {
      const i=ports.size;
      ports.set(port,[w*((i%6)/7-0.36),h*(Math.floor(i/6)/4-0.25),d/2]);
    }
    return ports.get(port);
  }
  function cable(from, to, label, transportKind, fromPort, toPort, opt = {}) {
    const {probes = [], fromOffset, toOffset, ...properties} = opt;
    return route(from, to, label, probes, fromOffset ?? connector(from,fromPort), toOffset ?? connector(to,toPort), {
      signal: "electrical", arm: label, carrier: false, transportKind, fromPort, toPort,
      held: probes.length === 0,
      basis:"Reference interconnect with functional signal names. Manufacturer pin assignments are unspecified.", ...properties,
    });
  }
  function instrument(key, label, x, z, note = "") {
    return part(key, label, "instrument", [x, -124, z], [60, 18, 34], note);
  }
  function awgDac(controller, lane) {
    const [x,,z] = points.get(controller), axis = lane.at(-1), offset = axis === "x" ? -15 : 15;
    const dac = part(lane+"-dac", lane+" · 16-bit direct-RF DAC", "dac", [x+offset,-111,z], [21,7,19],
      "Reference exposed DAC card. Independent signed RF samples and a source-synchronous clock per axis.");
    cable(controller, dac, lane+" PCM sample bus", "parallel", axis+".D[15:0]", "D[15:0]", {
      fromOffset:[offset,8,1], toOffset:[0,-3.5,1], lane, role:"pcm", payloadBits:16,
      transportOptions:{beatNs:1.6,transferWidthBits:16,
        timingBasis:"625 MS/s data bus. The CLK in the data bundle strobes each word as valid. A separate differential reference clocks conversion."}});
    const clkOut=part(lane+"-clock", lane+" · sample clock output", "contact", [x+offset+5,-115,z-5], [1.5,1,1.5]);
    const clkIn=part(lane+"-clock-in", lane+" · DAC clock pad", "contact", [x+offset+5,-114.5,z-5], [1,0.5,1]);
    cable(clkOut, clkIn, lane+" sample clock pair", "differential", "CLK±", "CLK±", {
      lane, role:"clock", clockOwner:controller, clockSink:dac, payloadBits:1,
      transportOptions:{encoding:"logic-level", transferWidthBits:1, timingBasis:"One differential reference-clock transition; no frame or serialization."}});
    return dac;
  }

  // Upper level, glass cell and readout. The fold keeps the full-size camera
  // off the vertical axis so a scale view has a sightline to the atom plane.
  const chamber = part("chamber", "Glass vacuum science cell", "cell", [0, 0, 0], [86, 28, 46],
    "Opposed side ports admit the two Rydberg beams. The cell walls are shown in cutaway.");
  const lower = part("trap-objective", "Trapping and local Raman objective", "objective-up",
    [0, -39, 0], [36, 44, 36], "Tweezer light and local Raman enter from below.");
  const upper = part("imaging-objective", "NA 0.65 fluorescence objective", "objective-down",
    [0, 42, 0], [38, 48, 38], "Imaging objective numerical aperture reported in Methods.");
  const imageFold = part("imaging-fold", "Imaging relay fold", "fold", [0, 82, 0], [16, 16, 20]);
  const tubeLens = part("tube-lens", "Imaging tube lens", "lens-z", [0, 82, -48], [25, 25, 7]);
  const camera = part("camera", "ORCA-Quest fluorescence camera", "camera", [0, 82, -160],
    [110, 110, 141.6], "C15550-20UP catalogue housing 110 × 110 × 141.6 mm; C-mount faces +Z.",
    neutralSources.camera);
  const sequencer = instrument("command", "AWG trigger and feedback interface", 180, -145,
    "Example host interface. In the experiment a ZCU102 processes images and signals the Raman AOD controller.");
  const fpga = electronics.find((p) => p.model?.fpga);
  if (fpga) cable(fpga.id, sequencer, "FPGA command word", "serial", "command.tx±", "host.rx±", {
    role:"host-command",payloadBits:16,transportOptions:{bitRateGbps:2.5,frameOverheadBits:2}});
  beam(chip, upper, 780, "Fluorescence collection");
  beam(upper, imageFold, 780, "Fluorescence collection");
  beam(imageFold, tubeLens, 780, "Fluorescence collection");
  beam(tubeLens, camera, 780, "Fluorescence collection", [], [], undefined, [0, 0, 70.8]);
  cable(camera, sequencer, "Camera image data", "serial", "frame.tx", "image.rx");

  // Tweezer light and addressing light are combined underneath the trapping objective.
  const trapPbs = part("trap-pbs", "Tweezer combining PBS", "pbs", [0, -93, 0], [14, 14, 14]);
  const dichroic = part("raman-dichroic", "Raman/tweezer dichroic", "fold",
    [0, -76, 0], [14, 16, 20]);
  const trapSource = part("slm-source", "852 nm static tweezer laser", "laser",
    [193, -93, 73], [60, 22, 30]);
  const slm = part("trap-slm", "Static trapping SLM", "slm", [193, -93, 0], [29, 26, 27],
    "Phase hologram defines the static array.");
  const slmControl = instrument("slm-control", "SLM phase-pattern controller", 175, 128);
  cable(sequencer, slmControl, "Static hologram data", "serial", "slm.tx", "pattern.rx");
  cable(slmControl, slm, "SLM pixel data", "serial", "pixels.tx", "pixels.rx");
  cable(sequencer, trapSource, "Static light blanking TTL", "logic", "slm.enable", "light.enable");
  beam(trapSource, slm, 852, "Static trapping");
  beam(slm, trapPbs, 852, "Static trapping");
  beam(trapPbs, dichroic, 852, "Static trapping");
  beam(dichroic, lower, 852, "Static trapping");
  beam(lower, chip, 852, "Static trapping", [], [], [0, 22, 0]);

  const mobileSource = part("moving-source", "850 nm mobile tweezer laser", "laser",
    [-243, -109, 106], [60, 22, 30]);
  const movingX = part("moving-x", "Moving AOD · X", "aod-x", [-154, -109, 106], [26, 22, 36],
    "DTSX-400 family on the moving 850 nm arm; housing envelope assumed.", neutralSources.movingAod);
  const movingY = part("moving-y", "Moving AOD · Y", "aod-y", [-98, -109, 106], [26, 36, 22],
    "Orthogonal acoustic axis. The setting is held in the gate reference.", neutralSources.movingAod);
  const movingFold = part("moving-fold", "Tweezer relay fold", "fold", [0, -109, 106], [14, 16, 20]);
  const upwardFold = part("upward-fold", "Upward tweezer fold", "fold", [0,-109,0], [13,13,13]);
  const movingAwg = instrument("moving-awg", "Moving waveform FPGA · X/Y", -220, 171);
  const rearrange = instrument("rearrange-awg", "Rearrangement waveform FPGA · X/Y", -144, 171);
  cable(sequencer, movingAwg, "Moving tone table selection", "parallel", "moving.word", "select.word", {armId:"moving",role:"select-table"});
  cable(sequencer, rearrange, "Rearrangement tone table selection", "parallel", "rearrange.word", "select.word", {armId:"rearrange",role:"select-table"});
  cable(sequencer, mobileSource, "Moving light blanking TTL", "logic", "moving.enable", "light.enable");
  for (const [axis, cell, x] of [["x", movingX, -66], ["y", movingY, -36]]) {
    const select = part("rf-select-"+axis, "Moving/rearrange RF selector · "+axis, "rf-switch", [x,-125,173], [23,13,25]);
    const amp = part("moving-"+axis+"-amp", "Moving AOD RF amplifier · "+axis, "rf-amp", [x,-124,137], [23,15,26]);
    for (const [arm, controller] of [["moving", movingAwg],["rearrange", rearrange]]) {
      const lane = arm+"-"+axis, dac = awgDac(controller,lane);
      cable(sequencer, select, "RF leg enable · "+lane, "logic", "enable."+lane, arm+".enable", {lane,role:"rf-select"});
      cable(dac, select, lane+" RF output", "coax", "RF.out", arm+".RF.in", {lane,role:"dac-rf",toOffset:[arm==="moving"?-5:5,0,12.5]});
    }
    cable(select, amp, axis+" selected RF to amplifier", "coax", "RF.common", "RF.in", {axis,role:"switch-rf"});
    cable(amp, cell, "Amplified tweezer "+axis+" RF", "coax", "RF.out", "transducer.RF", {axis,armId:"tweezer",role:"transducer-rf"});
  }
  for (const [a,b] of [[mobileSource,movingX],[movingX,movingY],[movingY,movingFold],
    [movingFold,upwardFold],[upwardFold,trapPbs],[trapPbs,dichroic],[dichroic,lower],[lower,chip]])
    beam(a, b, 850, "Mobile trapping", [], [], a === lower ? [0,22,0] : undefined);

  // A calibrated machine output is a source-referred pulse envelope. Local
  // Raman gates share optics; independent pointing words come from the X/Y AWG.
  const ramanSource = part("raman-source", "795 nm Raman laser and 6.8 GHz sidebands", "laser",
    [-241, -76, -78], [63, 22, 32], "The local and global paths share Raman light.");
  const localAom = part("raman-aom", "Local Raman pulse AOM", "aom", [-169, -76, -78], [24, 20, 28]);
  const ramanX = part("raman-x", "Local Raman addressing AOD · X", "aod-x",
    [-111, -76, -78], [26, 22, 36]);
  const ramanY = part("raman-y", "Local Raman addressing AOD · Y", "aod-y",
    [-55, -76, -78], [26, 36, 22]);
  const ramanFold = part("raman-fold", "Local Raman relay fold", "fold", [0,-76,-78], [14,16,20]);
  const ramanAwg = instrument("raman-aod-awg", "Raman pointing FPGA · X/Y", -78, -145,
    "The site selection is configured separately from the executed pulse envelopes.");
  cable(sequencer, ramanAwg, "Raman tone table selection", "parallel", "raman.word", "select.word", {armId:"raman",role:"select-table"});
  for (const [axis,cell,x] of [["x",ramanX,-111],["y",ramanY,-55]]) {
    const lane="raman-"+axis, dac=awgDac(ramanAwg,lane);
    const amp=part(lane+"-amp", "Raman "+axis+" RF amplifier", "rf-amp", [x,-124,-111],[23,15,26]);
    cable(dac,amp,lane+" DAC to amplifier", "coax", "RF.out", "RF.in", {lane,role:"dac-rf"});
    cable(amp,cell,lane+" transducer drive", "coax", "RF.out", "transducer.RF", {axis,armId:"raman",role:"transducer-rf"});
  }
  beam(ramanSource, localAom, 795, "Local Raman source", [], local);
  const ramanRf=part("local-rf", "Local Raman RF gate driver", "rf-amp", [-175,-123,-108],[22,14,24],
    "Carrier source, envelope multiplier and RF output stage represented by this connector-level instrument.");
  for (const p of local) cable(p, ramanRf, "Raman source envelope", "coax", "envelope.out", p+".envelope.in", {probes:[p]});
  cable(ramanRf,localAom,"Local Raman gated RF", "coax", "RF.out", "transducer.RF", {probes:local});
  for (const [a,b] of [[localAom,ramanX],[ramanX,ramanY],[ramanY,ramanFold],
    [ramanFold,dichroic],[dichroic,lower],[lower,chip]])
    beam(a, b, 795, "Addressed Raman envelope", local, [], a === lower ? [0,22,0] : undefined);

  // Side-launched Rydberg beams enter from opposite sides. The 420 nm
  // envelope receives the traced pair drive. The infrared carrier has its
  // own source, AOM and tophat phase optics, spatially overlapping at the atoms.
  const blue = part("blue-source", "420 nm Rydberg laser", "laser", [-250,0,0], [64,26,36]);
  const blueAom = part("blue-aom", "420 nm pulse AOM", "aom", [-181,0,0], [26,20,28]);
  const blueProfile = part("blue-profile", "420 nm tophat relay", "profile", [-107,0,0], [30,34,30],
    "Represents the shaped entangling-zone illumination; internal phase shaping is aggregated.");
  beam(blue, blueAom, 420, "Rydberg blue source", [], pair, [32,0,0]);
  const blueRf=part("blue-rf", "420 nm RF gate driver", "rf-amp", [-178,-124,31],[22,14,24]);
  for (const p of pair) cable(p, blueRf, "Rydberg source envelope", "coax", "envelope.out", p+".envelope.in", {probes:[p]});
  cable(blueRf,blueAom,"420 nm gated RF", "coax", "RF.out", "transducer.RF", {probes:pair});
  beam(blueAom, blueProfile, 420, "Rydberg blue envelope", pair);
  beam(blueProfile, chip, 420, "Rydberg blue envelope", pair, [], [15,0,0]);
  const ir = part("ir-source", "1013 nm Rydberg laser", "laser", [247,0,80], [64,26,36]);
  const irAom = part("ir-aom", "1013 nm gate AOM", "aom", [179,0,80], [26,20,28],
    "Independently gated companion colour. The gate replay times the 420 nm source-referred envelope.");
  const irProfile = part("ir-profile", "1013 nm tophat relay", "profile", [106,0,80], [30,34,30]);
  const irMix = part("side-dichroic", "Rydberg / Raman side dichroic", "fold", [106,0,0], [14,16,20]);
  const irRf=part("ir-rf", "1013 nm keyed RF source", "rf-amp", [200,-124,80],[23,15,26]);
  cable(sequencer, irRf, "Infrared gate timing", "logic", "ir.enable", "RF.key");
  cable(irRf, irAom, "Infrared gate transducer RF", "coax", "RF.out", "transducer.RF");
  for (const [a,b] of [[ir,irAom],[irAom,irProfile],[irProfile,irMix],[irMix,chip]])
    beam(a, b, 1013, "Rydberg infrared carrier", [], pair);

  const globalAom = part("global-aom", "Global Raman AOM", "aom", [253,0,0], [26,20,28]);
  const globalPbs = part("side-pbs", "Global Raman / imaging PBS", "pbs", [181,0,0], [16,16,16]);
  const readSource = part("readout-source", "780 nm local imaging source", "laser",
    [181,0,-77], [42,23,28]);
  const globalRelay = part("global-relay", "Global Raman relay lens", "lens-x", [215,0,0], [8,18,18]);
  const globalRf=part("global-rf", "Global Raman keyed RF source", "rf-amp", [228,-124,30],[23,15,26]);
  cable(sequencer, globalRf, "Global Raman gate", "logic", "global.enable", "RF.key");
  cable(globalRf, globalAom, "Global Raman transducer RF", "coax", "RF.out", "transducer.RF");
  route(ramanSource, globalAom, "Raman optical fiber", [], undefined, undefined,
    { signal:"optical", carrier:true, forProbes:[], wavelengthNm:795, arm:"Global Raman", held:true,
      transportKind:"fiber", fromPort:"global fiber out", toPort:"collimator in" });
  beam(globalAom, globalRelay, 795, "Global Raman");
  beam(globalRelay, globalPbs, 795, "Global Raman");
  for (const [source, wavelength, arm] of [[globalPbs,795,"Global Raman"],
    [readSource,780,"Local readout"]]) {
    if (source === readSource) beam(readSource, globalPbs, wavelength, arm);
    beam(globalPbs, irMix, wavelength, arm);
    beam(irMix, chip, wavelength, arm);
  }
  cable(sequencer, readSource, "Readout illumination trigger", "logic", "readout.enable", "light.enable");
  // An open optics shelf makes the FPGA below visible. There is a clear
  // axial opening beneath the register and separate risers for the camera arm.
  part("optical-shelf", "Open optical support frame", "shelf", [0,-144,15], [575,16,358],
    "Assumed optical support frame with an open central aperture and corner legs.");
  // Keep metal out of both the vertical objective axis and horizontal beams.
  // One off-axis upright supports the cell, both objectives and imaging relay.
  part("objective-post", "Science cell and objective column", "stand", [14,-25,30], [10,222,10]);
  part("cell-clamp", "Science cell support clamp", "beam", [14,-14,26], [8,5,12]);
  for (const [key, y] of [["trap", -39],["imaging", 42]])
    part(key + "-clamp", "Objective barrel clamp · " + key, "beam", [14,y,19], [8,5,23]);
  part("image-rail", "Imaging relay mounting rail", "beam", [14,78,-30], [6,6,122]);
  for (const [key, z] of [["fold",0],["lens",-48]])
    part("image-" + key + "-clamp", "Imaging " + key + " mount", "beam", [9,78,z], [12,5,5]);
  part("camera-post", "Camera and objective stand", "stand", [57,-3,-88], [12,269,12]);
  part("camera-arm", "Camera support arm", "beam", [38,72,-95], [45,9,18]);
  return chamber;
}

// Reference steering exercise. PCM words are a phase-continuous RF waveform,
// not voltage tuning commands. A calibrated instrument would need its own
// measured displacement, acoustic delay and optical efficiency per arm.
const samplePs = 1600, samplesPerTone = 128, carrierHz = 80_000_000;
const calibratedSlopeNmPerKHz = 10, acousticNs = 120;
const align = (ps, tick) => Math.ceil(ps / tick) * tick;

export function neutralSteeringProgram(device, lane, frequenciesHz, electronics, equipment) {
  if (!neutralSteeringLanes.includes(lane)) throw Error("Select one of the six neutral AOD DAC lanes.");
  if (!Array.isArray(frequenciesHz) || !frequenciesHz.length || frequenciesHz.length > 8 ||
      frequenciesHz.some(f => !Number.isSafeInteger(f) || f < 70e6 || f > 90e6 || f % 1000 !== 0))
    throw Error("Use 1–8 frequencies from 70 to 90 MHz on a 1 kHz grid.");
  const [arm,axis] = lane.split("-"), moving = arm !== "raman";
  const all = new Map([...electronics,...equipment.parts].map(p => [p.id,p]));
  function link(role, extra) {
    const hits=equipment.links.filter(l => l.role === role && Object.entries(extra ?? {}).every(([k,v]) => l[k] === v));
    if (hits.length !== 1) throw Error("Missing or ambiguous AOD route: "+lane+" / "+role);
    return hits[0];
  }
  const hostLink=link("host-command"), select=link("select-table",{armId:arm});
  const data=link("pcm",{lane}), clockLink=link("clock",{lane}), rf=link("dac-rf",{lane});
  const amplifierLink=moving ? link("switch-rf",{axis}) : null;
  const launch=link("transducer-rf",{axis,armId:moving ? "tweezer" : "raman"});
  const host=hostLink.from, router=hostLink.to, awg=select.to, dac=data.to;
  const hostTick=all.get(host)?.model?.fpga?.clockPs;
  if (!Number.isSafeInteger(hostTick) || hostTick <= 0) throw Error("The neutral installation needs a clocked host FPGA.");
  function part(id, model) {
    const {label,centerMm,sizeMm} = all.get(id);
    return {id,label,centerMm,sizeMm,model};
  }
  const management=wire(hostLink,"tx","rx"), selection=wire(select,"tx","rx"),
    samples=wire(data,"tx","in"), edges=wire(clockLink,"out","in");
  const latency = w => w.delayPs + (w.servicePs ?? 0);
  if (samples.servicePs > samplePs || edges.servicePs)
    throw Error("The steering program requires a 625 MS/s PCM lane and a differential transition clock.");
  const wires=[management,selection,samples,edges,wire(rf,"out","in")];
  const amp={affine:{input:"voltageUv",output:"voltageUv",numerator:2,denominator:1,offset:0}};
  const parts=[part(host,{fpga:{clockPs:hostTick}}),part(router,{fpga:{clockPs:hostTick}}),
    part(awg,{fpga:{clockPs:samplePs}}),part(dac,{dac:{bits:16,fullScaleUv:1_000_000}}),
    part(launch.from,amp),part(launch.to,{probe:{signal:"voltageUv"}})];
  const send=[],forward=[],play=[];
  const source=(n,op)=>"steer/"+lane+"/"+n+"/"+op;
  if (moving) {
    const enable=link("rf-select",{lane});
    parts.push(part(rf.to,{switch:{signal:"voltageUv"}}));
    wires.push(wire(enable,"flag","enable"),wire(amplifierLink,"out","in"));
    forward.push({source:source("init","enable-rf-leg"),atPs:0,op:{write:{port:"flag",value:1}}});
  }
  wires.push(wire(launch,"out","in"));
  const arriving = align(latency(management),hostTick) + hostTick;
  const readTone = arriving + hostTick + latency(selection);
  const spacing = align(readTone + 8*(samplePs+hostTick),hostTick);
  // Firmware checks each preloaded segment's signed kHz offset against the
  // packet physically received. Any mismatch ends playback before enabling a tone.
  for (const [n,f] of frequenciesHz.entries()) {
    const base=n*spacing, word=(f-carrierHz)/1000, test=play.length;
    send.push({source:source(n,"command-kHz-offset"),atPs:base,op:{write:{port:"tx",value:word}}});
    forward.push({source:source(n,"receive-command"),atPs:base+arriving,op:{read:{port:"rx"}}},
      {source:source(n,"forward-command"),op:{writeAcc:{port:"tx"}}});
    play.push({source:source(n,"read-table-select"),atPs:align(base+readTone,samplePs),op:{read:{port:"rx"}}},
      {source:source(n,"compare-kHz-offset"),op:{add:{value:-word}}},
      {source:source(n,"validate-table"),op:{jz:{target:test+4}}},
      {source:source(n,"reject-table"),op:"halt"});
  }
  const start=align(frequenciesHz.length*spacing+2*hostTick,samplePs), clocks=[];
  let phase=0;
  for (const [n,f] of frequenciesHz.entries()) {
    for (let i=0;i<samplesPerTone;i++) {
      const time=start+(n*samplesPerTone+i)*samplePs;
      const word=Math.round(24000*Math.sin(phase));
      play.push({source:source(n,"pcm/"+i),atPs:time,op:{write:{port:"tx",value:word}}});
      phase=(phase+2*Math.PI*f*samplePs*1e-12)%(2*Math.PI);
      // Independent source-synchronous clock pad. The Fabric DAC latches the
      // parallel word atomically at its arrival. Nominal pad skew is zero.
      const launchPs=time+latency(samples)-latency(edges);
      clocks.push({atPs:launchPs,value:1},{atPs:launchPs+samplePs/2,value:0});
    }
  }
  parts.push(part(clockLink.from,{stimulus:{signal:"bit",samples:clocks}}),
    part(clockLink.to,{probe:{signal:"bit"}}));
  play.push({source:source("end","rf-off"),op:{write:{port:"tx",value:0}}});
  for (const code of [send,forward,play]) code.push({source:source("end","done"),op:"halt"});
  return {kind:"component-machine",version:1,parts,wires,
    images:[{controller:host,code:send},{controller:router,code:forward},{controller:awg,code:play}],
    maxEvents:19000};
}

/** Measure the voltage actually received by the AOD transducer. A single
 * sinusoid obeys x[n-1]+x[n+1] = 2 cos(2πfΔt) x[n]. Fit its cosine by least
 * squares on an interior window. Position is a distinct optical observable.
 * The 120 ns acoustic delay is a reference 75 µm / 0.625 mm/µs transit. */
export function neutralSteeringResult(program, trace) {
  if (trace.stop !== "completed") throw Error("The steering program did not finish.");
  const receiver=program.parts.find(p=>p.model?.probe?.signal === "voltageUv")?.id;
  const clk=program.parts.find(p=>p.model?.probe?.signal === "bit")?.id;
  const dac=program.parts.find(p=>p.model?.dac)?.id;
  const groups=new Map(), rising=new Set();
  let lane, rfOffAtPs;
  for (const frame of trace.frames) {
    if (frame.part===clk && frame.received?.[1]===1) rising.add(frame.atPs);
    if (frame.part!==receiver || frame.received?.[0]!=="in") continue;
    const m=/^steer\/([^/]+)\/(\d+)\/pcm\/(\d+)$/.exec(frame.source);
    if (!m) { if (frame.source.endsWith("/end/rf-off")) rfOffAtPs=frame.atPs; continue; }
    if (lane && m[1]!==lane) throw Error("Mixed steering lanes at the AOD probe.");
    lane=m[1];
    const slot=Number(m[2]), frames=groups.get(slot) ?? [];
    if (frames.length!==Number(m[3])) throw Error("Missing or out-of-order transducer sample.");
    frames.push(frame); groups.set(slot,frames);
  }
  const expected=program.images.flatMap(i=>i.code).filter(i=>i.source.endsWith("/command-kHz-offset"));
  if (!expected.length || groups.size!==expected.length || !neutralSteeringLanes.includes(lane) || !rfOffAtPs)
    throw Error("No complete RF capture for the requested steering table.");
  const conversions=trace.frames.filter(f=>f.part===dac && /\/pcm\/\d+$/.test(f.source));
  if (conversions.length!==expected.length*samplesPerTone || rising.size!==conversions.length)
    throw Error("The sample-clock edge count and requested PCM conversion count must match.");
  for (const f of conversions)
    if (!rising.has(f.atPs)) throw Error("PCM arrival has no matching sample-clock edge at the DAC.");
  const observations=[];
  for (const [slot,frames] of groups) {
    if (frames.length!==samplesPerTone) throw Error("An RF segment was truncated.");
    const period=frames[1].atPs-frames[0].atPs;
    if (period<=0 || frames.some((f,i)=>f.atPs!==frames[0].atPs+i*period)) throw Error("Irregular RF sampling interval.");
    // Estimate early enough that the acoustic transit resolves inside the
    // same known finite RF segment; subsequent records define its validity.
    const window=frames.slice(0,32), v=window.map(f=>f.received[1]);
    let cross=0, power=0;
    for (let i=1;i<v.length-1;i++) { cross+=(v[i-1]+v[i+1])*v[i]; power+=v[i]*v[i]; }
    const cosine=cross/(2*power);
    if (!power || !Number.isFinite(cosine) || Math.abs(cosine)>=1) throw Error("The AOD samples do not resolve an RF tone.");
    const frequencyHz=Math.acos(cosine)/(2*Math.PI*period*1e-12);
    let residual=0;
    for (let i=1;i<v.length-1;i++) residual+=(v[i-1]+v[i+1]-2*cosine*v[i])**2;
    if (residual/power > 1e-6) throw Error("RF capture fails the single-tone recurrence tolerance.");
    const frequencyKHz=Math.round(frequencyHz/1000);
    const acquiredAtPs=window.at(-1).atPs;
    const commitNs=Math.ceil(acquiredAtPs/1000), resolvedAtNs=commitNs+acousticNs;
    if (resolvedAtNs*1000>frames.at(-1).atPs) throw Error("The tone ends before the acoustic response settles.");
    observations.push({slot,commandedHz:carrierHz+1000*expected[slot].op.write.value,frequencyHz,
      frequencyKHz,positionNm:(frequencyKHz-carrierHz/1000)*calibratedSlopeNmPerKHz,
      acquiredAtPs,resolvedAtNs,firstEvent:frames[0].id,measurementEvent:window.at(-1).id,lastEvent:frames.at(-1).id});
  }
  const axis=lane.at(-1), transport=!lane.startsWith("raman-");
  // One loaded reference trap is an explicit initial condition for this lab
  // exercise. None of the ZAC snapshot's static traps are assumed picked up.
  const neutralProgram=transport ? {kind:"neutral-aod",version:1,clockNs:1,acousticNs,
    referenceKHz:carrierHz/1000,nmPerKHz:calibratedSlopeNmPerKHz,columnsKHz:[carrierHz/1000],rowsKHz:[carrierHz/1000],
    atoms:[{id:"steering-test",column:0,row:0}],moves:observations.map(o=>({id:"tone-"+o.slot,axis,tone:0,
      targetKHz:o.frequencyKHz,startNs:Math.ceil(o.acquiredAtPs/1000)-1,durationNs:1,steps:1}))} : null;
  return {lane,axis,receiver,observations,neutralProgram,rfOffAtPs,samplePeriodPs:samplePs,
    acousticNs,nmPerKHz:calibratedSlopeNmPerKHz,referenceHz:carrierHz,
    observable:transport ? "Projected center of one loaded reference tweezer" : "Raman address displacement",
    basis:"16-bit direct RF at 625 MS/s with a reference 2× voltage gain, a 120 ns acoustic delay, and a 10 nm/kHz design slope. Positions use the received tone rounded to kHz. RF is blanked after the final segment."};
}
