import * as T from "three";
import { electrodeContoursUm } from "./h2-electrode-face.js";

const metal = 0x9caaab, alloy = 0x667783, black = 0x293b48;
const ceramic = 0xe2d6bb, brass = 0xba9955, glass = 0x66a8ad;
const substrate = 0x4c514f;
const roles = {
  aux: 0xbab6ac, gate: 0x7595bb, conveyor: 0x91aa82, rf: 0x606d74, load: 0x18262c,
};
const arc = new T.CylinderGeometry(1, 1, 1, 40, 1, true, Math.PI * 0.64, Math.PI * 1.03);
const tubeRing = new T.TorusGeometry(1, 0.084, 8, 40);
const globe = new T.SphereGeometry(1, 20, 12);

// Group coplanar contours by electrode role. The number of submitted meshes
// stays constant as the paper's display polygons become more detailed.
function faceGeometry(polygons) {
  const positions = [], indices = [];
  for (const polygon of polygons) {
    const rings = polygon.map((ring) => {
      const points = ring.map(([x, z]) => new T.Vector2(x / 1000, z / 1000));
      if (points[0].equals(points.at(-1))) points.pop();
      return points;
    });
    const faces = T.ShapeUtils.triangulateShape(rings[0], rings.slice(1));
    const start = positions.length / 3;
    const flattened = rings.flat();
    for (const p of flattened) positions.push(p.x, 0, p.y);
    for (const [a,b,c] of faces) {
      const p = flattened[a], q = flattened[b], r = flattened[c];
      const cross = (q.x-p.x)*(r.y-p.y) - (q.y-p.y)*(r.x-p.x);
      if (cross < 0) indices.push(start+a,start+b,start+c);
      else if (cross > 0) indices.push(start+a,start+c,start+b);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}
const metalFace = Object.fromEntries(Object.entries(electrodeContoursUm).map(([role, regions]) => [role, faceGeometry(regions)]));

function contourGeometry() {
  const positions = [], ids = [];
  // Engraved seam overlay. Its 4 µm stroke makes neighbouring equal-colour
  // electrodes readable; it does not specify a measured fabrication gap.
  for (const polygons of Object.values(electrodeContoursUm))
    for (const rings of polygons) for (const ring of rings)
      for (let i=0;i<ring.length;i++) {
        const [a,b] = ring[i], [c,d] = ring[(i+1)%ring.length];
        const len=Math.hypot(c-a,d-b);
        if (!len) continue;
        const ox=2*(d-b)/len, oz=-2*(c-a)/len;
        const base=positions.length/3;
        for (const [x,z] of [[a+ox,b+oz],[a-ox,b-oz],[c-ox,d-oz],[c+ox,d+oz]]) positions.push(x/1000,0,z/1000);
        ids.push(base,base+1,base+2,base,base+2,base+3);
      }
  const g=new T.BufferGeometry();
  g.setAttribute("position",new T.Float32BufferAttribute(positions,3));
  g.setIndex(ids);
  g.computeVertexNormals();
  return g;
}
const surfaceSeams = contourGeometry();

function pinField() {
  const vertices = [], indices = [];
  // An example 19 by 19 array with a 9 by 9 unpopulated centre gives
  // the published total of 280 contacts. H2's pin map is unavailable.
  for (let row = -9; row <= 9; row++) for (let col = -9; col <= 9; col++) {
    if (Math.max(Math.abs(row), Math.abs(col)) < 5) continue;
    const start = vertices.length / 3, x = col * 1.39, z = row * 1.39;
    for (const y of [-1, 1]) for (let n = 0; n < 6; n++) {
      const a = n * Math.PI / 3;
      vertices.push(x + 0.17 * Math.cos(a), y, z + 0.17 * Math.sin(a));
    }
    for (let n = 0; n < 6; n++) {
      const j = (n+1)%6;
      indices.push(start+n,start+n+6,start+j+6, start+n,start+j+6,start+j);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(vertices,3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}
const pins = pinField();

export function drawStudioTrap(s, device) {
  const l = device.layout;
  s.box([0,-0.19,0], [l.spanMm,0.38,l.widthMm], substrate);
  const sites = new Map(l.sites.map((p) => [p.id,p]));
  // Accept the original Studio file and the gate-ready native snapshot, both
  // of which use this exact site-coordinate convention. Custom traps use
  // their own topology and never inherit the H2 metal footprint.
  const h2 = l.sites.length === 59 && l.edges.length === 59 &&
    Math.abs(l.spanMm-6.58) < 0.02 && Math.abs(l.widthMm-2.02) < 0.02 &&
    [["DG01",-1.125,-0.375],["DG04",1.125,-0.375],["UG01",1.125,0.375],["LOAD",-2.979,0]]
      .every(([id,x,z]) => sites.has(id) && Math.abs(sites.get(id).x-x)<0.02 && Math.abs(sites.get(id).z-z)<0.02);
  if (h2) {
    for (const [role,geometry] of Object.entries(metalFace)) {
      const m=s.mesh(geometry,[0,0.00025,0],[1,1,1],roles[role]);
      m.userData.surfaceRole=role;
      m.userData.readout="H2 top metal · "+role+" · Moses et al., Fig. 2(d)";
    }
    const seams=s.mesh(surfaceSeams,[0,0.00042,0],[1,1,1],0x344047);
    seams.userData.surfaceRole="outlines";
    return;
  }
  for (const [a,b] of l.edges) {
    const p=sites.get(a), q=sites.get(b);
    if (!p || !q) continue;
    s.line([p.x,0.002,p.z],[q.x,0.002,q.z],0.007,roles.rf);
  }
  for (const p of l.sites) {
    const color = p.zone==="dg" || p.zone==="ug" || p.zone==="gate" ? roles.gate : roles[p.zone] ?? roles.aux;
    s.box([p.x,0.004,p.z],[0.045,0.008,0.025],color);
  }
}

function flange(s, center, radius, axis) {
  const m=s.mesh(tubeRing,center,[radius,radius,radius],metal);
  if (axis==="x") m.rotation.y=Math.PI/2;
  if (axis==="y") m.rotation.x=Math.PI/2;
  for (let i=0;i<8;i++) {
    const a=(i+0.5)*Math.PI/4,u=radius*Math.cos(a),v=radius*Math.sin(a);
    const p=axis==="x"?[0,u,v]:axis==="y"?[u,0,v]:[u,v,0];
    s.mesh(globe,center.map((n,i)=>n+p[i]),[1,1,1],black);
  }
}

export function drawIonHardware(s, part) {
  const [w,h,d]=part.sizeMm;
  switch (part.form) {
    case "ion-frame": {
      // Use the mounting centres in ionInstallation. Members meet the actual
      // component undersides while the central optical volume stays open.
      const frame=(x,y,z,w,h,d,c=alloy)=>s.box([x+15,y+103,z+11],[w,h,d],c);
      for (const z of [-96,74]) frame(-14,-189,z,316,5,5);
      for (const x of [-170,142]) {
        frame(x,-189,-11,5,5,174);
        for (const z of [-96,74]) frame(x,-198,z,9,12,9,black);
      }
      // Chamber shoes and posts sit at the corners rather than under the ions.
      for (const x of [-49,49]) {
        for (const z of [-31,31]) frame(x,-114,z,5,149,5);
        frame(x,-39,-1,7,4,70);
        frame(x,-187,-10,6,4,170);
      }
      // Two small shelves hold the laser and AOM above the RF electronics.
      for (const x of [-158,-74]) {
        frame(x,-137,-44,4,103,4);
        frame(x,-187,-10,5,4,170);
      }
      frame(-122,-88,-42,99,4,33);
      frame(-86,-80,-37,16,12,15,black);
      for (const x of [-151,-109]) frame(x,-154,12,3,68,3);
      frame(-130,-121.5,12,50,4,28);
      // DAC shelf supports the rear of the module and exposes the front pins.
      for (const x of [63,131]) {
        frame(x,-173,-40,4,28,4);
        frame(x,-159.5,-41,5,2,54);
        frame(x,-187,-10,5,4,170);
      }
      // Fiber launcher and PMT posts.
      for (const x of [-44.125,41.875]) {
        frame(x,-99,-82.625,4,181,4);
        frame(x,-8.95,-82.625,20,1,20);
        frame(x,-187,-53,5,4,85);
      }
      frame(23,-137,53,4,102,4);
      frame(23,-86,53,21,2,20);
      frame(23,-187,8,5,4,134);
      break;
    }
    case "ion-chamber": {
      s.mesh(arc,[0,0,0],[w*0.48,h*0.83,d*0.47],alloy);
      for (const y of [-.43*h,.43*h]) {
        s.mesh(arc,[0,y,0],[w*.49,4,d*.48],metal);
        for (const a of [2.05,2.7,3.35,4.0,4.62,5.18]) {
          const p=[w*.47*Math.sin(a),y,d*.45*Math.cos(a)];
          s.disc(p,1.8,4.6,black);
        }
      }
      break;
    }
    case "ion-pga": {
      s.box([0,-h*.37,0],[w,1.9,d],ceramic);
      s.box([0,-4.08,0],[6.60,0.29,2.05],alloy);
      s.mesh(pins,[0,1.15,0],[1,2.65,1],brass);
      // Wire-bond loops along both sides of the package face leave the
      // downward-facing electrode surface and its optical access exposed.
      for (const z of [-1,1]) for (let i=0;i<15;i++) {
        const x=(i-7)*0.39;
        const a=[x,-4.60,z*0.91], b=[x,-4.88,z*2.15], c=[x*1.25,-h*.49,z*3.5];
        s.box(a,[0.12,0.012,0.11],brass);
        s.line(a,b,0.023,brass);s.line(b,c,0.023,brass);
      }
      break;
    }
    case "ion-socket":
      s.box([0,0,0],[w,h,d],0x34554c);
      for (let i=0;i<4;i++) {
        const x=(i-1.5)*8;
        s.box([x,2,-d*.35],[5,1.5,5],black);
        s.box([x,1,d*.4],[3,.4,3],brass);
      }
      break;
    case "ion-dc":
    case "ion-amplifier":
    case "ion-laser": {
      s.box([0,0,0],[w,h,d],part.form==="ion-laser"?0x557470:alloy);
      s.box([0,0,d*.495],[w*.94,h*.83,1.4],black);
      const n=part.form==="ion-dc"?8:3;
      for (let i=0;i<n;i++) {
        const x=w*.82*((i+.5)/n-.5);
        s.line([x,0,d*.51],[x,0,d*.55],1.25,brass);
        s.box([x,h*.25,d*.52],[1.8,.8,.8],0x8bc8a6);
      }
      for (let i=-3;i<=3;i++) s.box([i*w/10,h*.51,0],[w*.035,h*.06,d*.65],black);
      break;
    }
    case "ion-dc-lane":
      s.box([0,0,0],[w,h,d],brass);
      break;
    case "ion-resonator":
      s.disc([0,0,0],w*.42,h*.85,brass);
      for (const y of [-.44*h,.44*h]) s.disc([0,y,0],w*.5,1.8,alloy);
      s.disc([0,h*.45,0],w*.12,h*.12,black);
      break;
    case "ion-feedthrough":
      flange(s,[0,0,0],h*.44,"x");
      s.line([-w*.45,0,0],[w*.45,0,0],h*.29,ceramic);
      for (let i=-2;i<=2;i++) for (const j of [-1,0,1])
        s.line([w*.35,i*1.8,j*2.4],[w*.53,i*1.8,j*2.4],.37,brass);
      break;
    case "ion-aom":
      s.box([0,0,0],[w,h,d],alloy);
      s.box([0,1,0],[w*.78,h*.65,d*1.02],black);
      s.line([-w*.51,1,0],[w*.51,1,0],1.8,glass);
      s.line([0,-h*.35,d*.18],[0,-h*.52,d*.18],1.2,brass);
      break;
    case "ion-launch": {
      const side=part.id.endsWith("/pair-head")?-1:1;
      s.line([-side*5.5,0,-10.6],[side*5.6,0,10.8],w*.24,black);
      s.line([side*5.6,0,10.8],[side*6.2,0,12],w*.23,glass);
      s.box([0,-h*.38,0],[w*.75,h*.2,d*.7],alloy);
      break;
    }
    case "ion-window":
      flange(s,[0,0,0],h*.46,"z");
      s.line([0,0,-1.1],[0,0,1.1],h*.38,glass);
      break;
    case "ion-detection":
      s.mesh(globe,[0,0,0],[w*.43,h*.23,d*.42],glass);
      s.ring([0,0,0],w*.46,black);
      break;
    case "ion-pmt":
      s.box([0,0,0],[w,h,d],black);
      for (const x of [-1,1]) for (const z of [-1,1])
        s.box([x*w*.18,h*.51,z*d*.18],[w*.27,1,d*.27],glass);
      break;
    default:
      return false;
  }
  return true;
}
