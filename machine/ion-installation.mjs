import {apparatusWire, pathLengthMm} from "./wiring.mjs";
// Coordinates in mm relative to the exposed face of the trap, with +y up.
// The hardware paper specifies the trap and optical geometry. Enclosure sizes,
// routing, and fiber / RF signal conditioning below describe the reference bench.
export const ionHardwareSources = [
  { title: "Moses et al. (2023), H2, Figs. 1–2 and Sec. II.A–E", url: "https://doi.org/10.1103/PhysRevX.13.041052" },
  { title: "QCCD Studio H2 geometry, channels and timing limits", url: "https://www.qccd.academy/reproduce/moses2023/" },
];

export const ionDcLaneCount = 268;
const dcChassis = [97,-145,-41], feedCenter = [60,11,-9], socketCenter = [0,10,0];
const contacts = [];
for (let row=-9;row<=9;row++) for (let col=-9;col<=9;col++)
  if (Math.max(Math.abs(row),Math.abs(col))>=5) contacts.push([row,col]);
const sum = (a,b) => a.map((v,i)=>v+b[i]);
function dcLane(channel) {
  if (!Number.isInteger(channel) || channel<1 || channel>ionDcLaneCount) throw Error("Choose DC channel 1–268.");
  const slot=channel-1, bank=Math.floor(slot/16), lane=slot%16;
  const [row,col]=contacts[slot];
  return {key:"dc-"+String(channel).padStart(3,"0"), bank, lane,
    pad:[-36+4.5*bank,-9+1.2*lane,30.4],
    feed:[5.6,0.47*row,0.47*col], socket:[1.39*col,-1.5,1.39*row]};
}

export function ionInstallation({device, inputs, chip, add, route, electronics=[]}) {
  const gate = device.layout.sites.find((site) => site.id === "DG01");
  const x = gate?.x ?? 0, z = -(gate?.z ?? 0), ionY = -0.07;
  const chamber = add("chamber", "Trap vacuum chamber · cutaway", "ion-chamber",
    [0, 0, 0], [124, 90, 106],
    "Illustrative UHV body with open front and bottom optical access. The H2 trap face points down.");
  add("frame","Open optical bench and rack supports","ion-frame",
    [-15,-103,-11],[334,202,208],
    "Example open rail frame, optics posts and rack shelves. A clear aperture beneath the inverted trap provides access to the electrodes and ions.");
  const carrier = add("package", "280-pin ceramic PGA", "ion-pga",
    [0, 4.6, 0], [29, 8, 29],
    "H2 uses a 280-pin ceramic PGA. The pin pitch, package dimensions and pin placement shown are illustrative. The mounting plane sits above the face-down trap.");
  const socket = add("socket", "PGA socket and vacuum PCB", "ion-socket",
    socketCenter, [46, 3, 40],
    "Example in-vacuum fan-out board above the ceramic package; 280 pin contacts are shown without an inferred channel-to-pin map.");
  const transport = add("transport", "DC transport supply and filter bank", "ion-dc",
    dcChassis, [89, 27, 60],
    "H2 connects 376 electrodes to 268 independent DC sources and one RF drive. This reference supply represents the DC channels. The pulse-envelope programs leave them idle.");
  const rf = add("rf-trap", "Trap RF resonator", "ion-resonator",
    [80, 14, -28], [22, 30, 22],
    "The confinement RF is distinct from the optical gate controls. The resonator package and RF cabling are illustrative.");
  const feed = add("feedthrough", "Vacuum electrical feedthrough", "ion-feedthrough",
    feedCenter, [12, 23, 24],
    "Reference bulkhead and vacuum-side harness. Wiring terminates on the trap electrodes.");
  // The RF-null and trapping potential confine the ion without a galvanic
  // connection. These paths have no drive probe in an optical gate program.
  const manager=electronics.find(p=>p.id==="sequencer" && p.model?.fpga) ?? electronics.find(p=>p.model?.fpga);
  if (manager) route(manager.id,transport,"Transport control · address and setpoint bus",[],undefined,[-41,-3,12],
    {signal:"electrical",diameterMm:2.4,controlBus:true});
  for (let channel=1;channel<=ionDcLaneCount;channel++) {
    const {key,bank,lane,pad,feed:pin,socket:contact}=dcLane(channel);
    const output=add(key,"DC "+String(channel).padStart(3,"0")+" · output contact","ion-dc-lane",
      sum(dcChassis,pad),[0.66,0.66,0.7],
      "Independent DC source "+channel+" of 268. Reference bank "+(bank+1)+", lane "+(lane+1)+
      ". The gate program holds its previous setpoint. The separate channel exercise uses a signed 16-bit ±10 V reference conversion. H2 biases and physical pin assignments are unknown.");
    route(transport,output,"Bank "+(bank+1)+" · DC "+channel+" latch",[],[pad[0],pad[1],28.6],[0,0,-0.30],
      {dcLane:channel,signal:"electrical",diameterMm:0.16});
    route(output,feed,"DC "+channel+" · analog feedthrough pin",[],[0,0,0.3],pin,
      {dcLane:channel,contactIndex:channel,signal:"analog",diameterMm:0.12,held:true});
    route(feed,socket,"DC "+channel+" · socket contact",[],[-pin[0],pin[1],pin[2]],contact,
      {dcLane:channel,contactIndex:channel,signal:"analog",diameterMm:0.12,held:true});
  }
  const common={transportKind:"contact",sharedNet:"DC common",signal:"analog",held:true,
    transportOptions:{sharedReturn:"rack reference"},basis:"Reference-design common return on a spare contact. The H2 ground pin assignment is unpublished."};
  route(transport,feed,"DC common return strap",[],[-39,-11,30],[5.6,4.23,4.23],{...common,fromPort:"DC common",toPort:"COM bulkhead"});
  route(feed,socket,"DC common vacuum return",[],[-5.6,4.23,4.23],[12.51,-1.5,12.51],{...common,fromPort:"COM bulkhead",toPort:"COM socket"});
  route(rf, feed, "RF electrode supply", [], [-8, -4, 4], [5, -3, -5]);
  route(feed, socket, "Vacuum RF conductor", [], [-5, 0, 0], [22, 1, -8]);
  route(socket, carrier, "PGA contact pins", [], [9, -1.5, 8], [9, 4, 8]);
  route(carrier, chip, "Package bonds to trap electrodes", [], [4.2, -3.8, 0.95],
    [device.layout.spanMm / 2 - 0.1, 0, 0.75]);

  const laser = add("laser", "Raman laser source", "ion-laser",
    [-138, -76, -49], [57, 20, 31],
    "Gate light drives stimulated Raman transitions on H2. The source enclosure and external fiber routing are illustrative.");
  const amplifier = add("rf-gate", "Gate-envelope RF driver", "ion-amplifier",
    [-130, -112, 12], [55, 15, 35],
    "Reference mixer and RF amplifier connect the delivered waveform to the acousto-optic modulator.");
  const aom = add("raman-aom", "Raman beam modulator", "ion-aom",
    [-86, -66, -37], [25, 16, 18],
    "Reference acousto-optic gate-light modulation; fiber couplings and driver latency are design assumptions.");
  const launcher = add("gate-head", "Raman fiber launcher", "ion-launch",
    [x-43, ionY, z-83], [24, 17, 27],
    "H2 uses co-propagating 1Q light and beam pairs with axial momentum difference for 2Q gates. This launcher is an illustrative envelope path.");
  const viewport = add("gate-window", "Raman input viewport", "ion-window",
    [x-27, ionY, z-52], [32, 24, 9],
    "Example anti-reflection viewport providing optical access below the chip. Its exact location and optical prescription are unspecified.");
  const detector = add("pmt", "Fluorescence collection · PMT array", "ion-pmt",
    [23, -66, 53], [25, 38, 22],
    "H2 uses a photomultiplier array to detect state-dependent fluorescence. This bench includes the detector as passive apparatus during gate playback.");
  const detection = add("collection", "Fluorescence collection lens", "ion-detection",
    [13, -34, 32], [18, 16, 19],
    "Illustrative collection optics below the trap surface. Detection requires a distinct measurement operation.");
  route(chip, detection, "Fluorescence collection axis", [], [x,ionY,z], [0, 5, 0], {signal:"optical"});
  route(detection, detector, "Fluorescence detection path", [], [0, -5, 0], [0, 12, 0], {signal:"optical"});
  if (inputs.length) {
    route(laser, aom, "Unmodulated Raman carrier", [], [28, 1, 3], [-12, 1, 0],
      {carrier:true, forProbes:inputs, signal:"optical"});
    for (const probe of inputs) route(probe, amplifier, "Electrical gate envelope", [probe], undefined, [-25, 0, 0], {signal:"electrical"});
    route(amplifier, aom, "RF coax to transducer", inputs, [25, 1, 0], [0, -7, 5], {signal:"electrical"});
    route(aom, launcher, "Modulated Raman optical fiber", inputs, [12, 1, 0], [-10, -2, -8], {signal:"optical"});
    route(launcher, viewport, "Collimated Raman gate light", inputs, [6.2,0,12], [-2.08,0,-4], {signal:"optical"});
    route(viewport, chip, "Raman field at addressed ions", inputs, [2.08,0,4], [x,ionY,z], {signal:"optical"});
    const pairProbes = device.drives.filter((d) => d.targets.length > 1).map((d) => d.probe);
    if (pairProbes.length) {
      const partner = add("pair-head", "Second Raman beam · two-ion gates", "ion-launch",
        [x+43,ionY,z-83], [24,17,27],
        "Second beam for a Raman pair at DG01. Its distinct wavevector supplies an axial momentum difference. Reference mounting angles and fiber lengths are illustrative.");
      const partnerWindow = add("pair-window", "Second Raman viewport", "ion-window",
        [x+27,ionY,z-52], [32,24,9], "Illustrative second optical aperture at trap height.");
      const carrierPath = {carrier:true, forProbes:pairProbes, signal:"optical"};
      route(laser, partner, "Second Raman carrier fiber", [], [22,2,-13], [8,0,-11], carrierPath);
      route(partner, partnerWindow, "Second Raman beam", [], [-6.2,0,12], [2.08,0,-4], carrierPath);
      route(partnerWindow, chip, "Raman beat at DG01", [], [-2.08,0,4], [x,ionY,z], carrierPath);
    }
  }
  return chamber;
}

/** A sparse, executable view of one of the 268 DAC latches. Each input can
 * address any of the 268 lanes. Unselected words leave this latch unchanged.
 * The pictured board, lane and contacts remain the actual part and wire IDs.
 * Its two-word packet, transfer clock, ±10 V scale and cable velocity are
 * reference assumptions; H2's pinout and its transport tables are unpublished.
 */
export function ionDcProgram(device,channel,words,electronics,equipment) {
  dcLane(channel);
  if (!Array.isArray(words) || !words.length || words.length>128)
    throw Error("Supply 1–128 signed DC setpoints.");
  const packets=words.map(w=>{
    const data=Number.isInteger(w)?{channel,word:w}:w;
    if (!data || !Number.isInteger(data.word) || data.word< -32768 || data.word>32767)
      throw Error("DC setpoints must be signed 16-bit words.");
    dcLane(data.channel);
    return data;
  });
  const management=equipment.links.find(l=>l.controlBus);
  const links=[management,...equipment.links.filter(l=>l.dcLane===channel)];
  if (!management || links.length!==4 || links.slice(1).some((l,i)=>l.from!==links[i].to))
    throw Error("The selected transport lane is missing its FPGA or physical wiring.");
  const [host,bank,output,feed,socket]=[management.from,...links.map(l=>l.to)];
  const locations=new Map([...electronics,...equipment.parts].map(p=>[p.id,p]));
  const clock=locations.get(host)?.model?.fpga?.clockPs;
  if (!Number.isSafeInteger(clock) || clock<=0) throw Error("Select an installation with an FPGA management clock.");
  function part(id,model) {
    const {centerMm,sizeMm,label}=locations.get(id);
    return {id,label,centerMm,sizeMm,model};
  }
  function wire(link,inPort,outPort) {
    if (link.interconnect) return apparatusWire(link,outPort,inPort);
    const length=pathLengthMm(link.pointsMm);
    const speed=device.propagation?.electricalMmPerNs ?? 200;
    if (!Number.isFinite(speed) || speed<=0) throw Error("Invalid electrical propagation speed.");
    return {id:link.id,src:{part:link.from,port:outPort},dst:{part:link.to,port:inPort},
      delayPs:Math.max(1,Math.ceil(1000*length/speed))};
  }
  const wires=[
    wire(links[0],"rx","tx"), wire(links[1],"in","tx"),
    wire(links[2],"in","out"), wire(links[3],"in","out"),
  ];
  const parts=[part(host,{fpga:{clockPs:clock}}),part(bank,{fpga:{clockPs:clock}}),
    part(output,{dac:{bits:16,fullScaleUv:10_000_000}}),
    part(feed,{affine:{input:"voltageUv",output:"voltageUv",numerator:1,denominator:1,offset:0}}),
    part(socket,{probe:{signal:"voltageUv"}})];
  // Address and payload share the management bus. The physical wire delay
  // sets the minimum setup window for the selected bank's clock.
  const unit=clock*(Math.ceil((wires[0].delayPs+(wires[0].servicePs??0))/clock)+2);
  const send=[], receive=[];
  for (const [n,p] of packets.entries()) {
    const base=n*10*unit,pc=receive.length;
    const ins=(stage,slot,op)=>({source:"dc-"+channel+"/packet-"+n+"/"+stage,atPs:base+slot*unit,op});
    send.push(ins("send-address",0,{write:{port:"tx",value:p.channel-1}}),
      ins("send-setpoint",4,{write:{port:"tx",value:p.word}}));
    receive.push(ins("read-address",2,{read:{port:"rx"}}),
      ins("compare-address",3,{add:{value:-(channel-1)}}),
      ins("select-latch",4,{jz:{target:pc+4}}),
      ins("hold-other-lane",5,{jump:{target:pc+6}}),
      ins("read-setpoint",6,{read:{port:"rx"}}),
      ins("write-dac",7,{writeAcc:{port:"tx"}}));
  }
  const end=packets.length*10*unit;
  send.push({source:"dc-management/done",atPs:end,op:"halt"});
  receive.push({source:"dc-"+channel+"/done",atPs:end,op:"halt"});
  return {kind:"component-machine",version:1,parts,wires,
    images:[{controller:host,code:send},{controller:bank,code:receive}],
    maxEvents:32*packets.length+32};
}
