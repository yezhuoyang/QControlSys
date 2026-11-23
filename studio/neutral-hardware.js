// Local geometry in millimetres. Optical apertures remain open in cutaway.
const graphite = 0x334852, metal = 0x9faeb2, black = 0x23353f;
const glass = 0x88cec5, brass = 0xc3a16b, rail = 0x718691;

function opticRing(s, center, radius, color, axis) {
  const ring = s.ring(center, radius, color);
  if (axis === "x") ring.rotation.set(0, Math.PI / 2, 0);
  if (axis === "z") ring.rotation.set(0, 0, 0);
  return ring;
}

function glassCell(s, w, h, d) {
  // The thin outline shows walls and optical faces without obscuring the register.
  for (const y of [-h / 2, h / 2]) {
    for (const z of [-d / 2, d / 2]) s.line([-w/2,y,z], [w/2,y,z], 0.65, glass);
    for (const x of [-w / 2, w / 2]) s.line([x,y,-d/2], [x,y,d/2], 0.65, glass);
  }
  for (const x of [-w/2,w/2]) for (const z of [-d/2,d/2])
    s.line([x,-h/2,z], [x,h/2,z], 0.65, glass);
  for (const x of [-w/2,w/2]) opticRing(s, [x,0,0], h * 0.38, metal, "x");
}

function objective(s, w, h, side) {
  // The narrower working end faces the atoms above or below the barrel.
  s.disc([0,-side*h*0.12,0], w*0.48, h*0.69, graphite);
  s.disc([0, side*h*0.28,0], w*0.36, h*0.19, metal);
  s.disc([0, side*h*0.415,0], w*0.29, h*0.11, graphite);
  s.disc([0, side*h*0.478,0], w*0.235, h*0.018, glass);
  for (const y of [-0.38,-0.29,-0.20,0.10])
    opticRing(s, [0,side*h*y,0], w*0.46, metal, "y");
}

function deflector(s, w, h, d, vertical) {
  const boreH = vertical ? h * 0.31 : h * 0.45;
  const boreD = vertical ? d * 0.44 : d * 0.32;
  const top = (h-boreH)/2, side = (d-boreD)/2;
  for (const sign of [-1,1]) {
    s.box([0, sign*(boreH+top)/2, 0], [w,top,d], graphite);
    s.box([0, 0, sign*(boreD+side)/2], [w,boreH,side], graphite);
  }
  for (const x of [-w/2,w/2]) opticRing(s, [x,0,0], Math.min(boreD,boreH)*0.44, glass, "x");
  if (vertical) s.disc([0,h*0.45,0], w*0.12, h*0.10, brass);
  else s.line([0,0,d*0.39],[0,0,d*0.5],w*0.12,brass);
}

export function drawNeutralHardware(s, p) {
  if (!p.form.startsWith("na-")) return false;
  const [w,h,d] = p.sizeMm;
  switch (p.form) {
    case "na-cell":
      glassCell(s, w, h, d);
      break;
    case "na-objective-up":
    case "na-objective-down":
      objective(s, w, h, p.form === "na-objective-up" ? 1 : -1);
      break;
    case "na-laser": {
      const blue = p.id.endsWith("/blue-source");
      const side = p.id.endsWith("/ir-source") ? -1 : 1;
      s.box([0, -h*0.05, 0], [w,h*0.9,d], graphite);
      for (let n=-3; n<=3; n++)
        s.box([w*n/8, h*0.445, 0], [w/28, h*0.085, d*0.85], metal);
      // Source housings use a coloured aperture bezel as a wavelength guide.
      const toZ = p.id.endsWith("/slm-source") || p.id.endsWith("/readout-source");
      if (toZ) {
        const sign = p.id.endsWith("/slm-source") ? -1 : 1;
        opticRing(s,[0,0,d*0.5*sign], Math.min(w,h)*0.23, glass, "z");
      } else opticRing(s,[side*w*0.5,0,0],h*0.22,blue ? 0x90a5f2 : glass,"x");
      break;
    }
    case "na-aod-x":
    case "na-aod-y":
    case "na-aom":
      deflector(s, w, h, d, p.form === "na-aod-y");
      break;
    case "na-fold": {
      s.box([0,-h*0.45,0],[w,h*0.1,d], graphite);
      const mirror = s.box([0,0,0],[w*0.06,h*0.91,d*0.83], glass);
      // A relay fold connects straight chief-ray segments; the optical face
      // has the bisecting normal for the two directions in this fixture.
      const tag = p.id.split("/").pop();
      if (tag === "imaging-fold" || tag === "upward-fold") mirror.rotation.set(0,Math.PI/2,-Math.PI/4);
      else if (tag === "raman-dichroic") mirror.rotation.set(0,Math.PI/2,Math.PI/4);
      else mirror.rotation.y = (tag === "moving-fold" ? -1 : 1) * Math.PI/4;
      break;
    }
    case "na-pbs": {
      glassCell(s, w*0.88, h*0.88, d*0.88);
      const interfacePlane = s.box([0,0,0],[0.65,h*0.8,d*0.79], glass);
      if (p.id.endsWith("/trap-pbs")) interfacePlane.rotation.z = Math.PI/4;
      else interfacePlane.rotation.y = -Math.PI/4;
      break;
    }
    case "na-profile":
    case "na-slm":
      s.box([0,-h*0.46,0], [w,h*0.08,d], graphite);
      if (p.form === "na-slm") {
        const panel = s.box([0,0,0], [w*0.10,h*0.81,d*0.9], metal);
        panel.rotation.y = Math.PI/4;
        for (const y of [-0.2,0,0.2])
          s.line([-w*0.20,h*y,-d*0.2],[w*0.20,h*y,d*0.2],0.42,glass);
      } else {
        for (const x of [-0.36,0.36]) opticRing(s, [x*w,0,0], h*0.34, metal, "x");
        for (const z of [-0.29,0.29]) s.line([-w*0.45,-h*0.28,z*d],[w*0.45,-h*0.28,z*d],1.15,graphite);
      }
      break;
    case "na-lens-z":
      for (const z of [-d*0.4,d*0.4]) opticRing(s,[0,0,z],Math.min(w,h)*0.41,metal,"z");
      break;
    case "na-lens-x":
      for (const x of [-w*0.4,w*0.4]) opticRing(s,[x,0,0],Math.min(d,h)*0.41,metal,"x");
      break;
    case "na-camera":
      s.box([0,0,-d*0.035], [w,h,d*0.93], graphite);
      s.line([0,0,d*0.42],[0,0,d*0.49], w*0.23, metal);
      opticRing(s,[0,0,d*0.49],w*0.165,glass,"z");
      for (let n=-3; n<=3; n++)
        s.box([n*w/9,h*0.501,-d*0.08],[w*0.047,0.8,d*0.54],black);
      break;
    case "na-instrument":
      s.box([0,0,0],[w,h,d],graphite);
      s.box([0,0,d*0.49],[w*0.94,h*0.83,d*0.02],metal);
      for (const x of [-0.27,0.27])
        opticRing(s,[x*w,0,d*0.5],h*0.14,brass,"z");
      break;
    case "na-dac":
      s.box([0,-h*0.26,0],[w,h*0.18,d],0x357968);
      s.box([0,0.05*h,0],[w*0.39,h*0.40,d*0.45],black);
      for (let bit=0;bit<16;bit++)
        s.box([w*(bit/18-0.42),-h*0.12,-d*0.42],[w*0.025,h*0.16,d*0.12],brass);
      opticRing(s,[0,0,d*0.45],h*0.30,brass,"z");
      break;
    case "na-contact":
      s.box([0,0,0],[w,h,d],brass);
      break;
    case "na-rf-switch":
    case "na-rf-amp":
      s.box([0,0,0],[w,h*0.8,d],graphite);
      if (p.form === "na-rf-switch") {
        for (const x of [-0.22,0.22]) opticRing(s,[x*w,0,d*0.5],h*0.17,brass,"z");
      } else {
        for (const k of [-2,-1,0,1,2]) s.box([k*w/6,h*0.415,0],[w/15,h*0.15,d*0.82],metal);
        opticRing(s,[0,0,d*0.5],h*0.17,brass,"z");
      }
      opticRing(s,[0,0,-d*0.5],h*0.17,brass,"z");
      break;
    case "na-stand":
      s.disc([0,0,0],w*0.31,h,metal);
      for (const sign of [-1,1]) s.disc([0,sign*h*0.46,0],w*0.48,h*0.08,graphite);
      break;
    case "na-beam":
      s.box([0,0,0],[w,h,d], rail);
      break;
    case "na-shelf":
      for (const z of [-0.48,0.48]) s.box([0,0,z*d],[w,h,d*0.028],rail);
      for (const x of [-0.48,0.48]) s.box([x*w,0,0],[w*0.018,h,d],rail);
      // Rails for each optical row carry post feet while exposing the electronics.
      for (const row of [-145,-88,-78,0,30,80,106,128,171])
        s.box([0,h*0.25,row-15],[w*0.96,h*0.5,8],rail);
      break;
    default:
      return false;
  }
  return true;
}

// Outline the addressable areas supplied by the machine's native SLM layout.
// The program owns occupancy. Each mesh here marks a region and creates no atom.
export function drawNeutralZones(s, device) {
  for (const slm of device.layout.slms) {
    const [ox,oz] = slm.originMm, [dx,dz] = slm.pitchMm;
    const y = -Math.min(dx,dz) * 0.16, radius = Math.min(dx,dz) * 0.032;
    const x0 = ox - dx/2, x1 = ox + (slm.cols-0.5)*dx;
    const z0 = oz - dz/2, z1 = oz + (slm.rows-0.5)*dz;
    const color = slm.zone === "entanglement" || slm.zone === "entanglement_zones" ? 0xbb9762 : 0x659794;
    const corners = [[x0,y,z0],[x1,y,z0],[x1,y,z1],[x0,y,z1]];
    for (let n=0; n<4; n++) s.line(corners[n],corners[(n+1)%4],radius,color);
  }
}
