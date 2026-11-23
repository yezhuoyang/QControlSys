import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as T from "three";
import { referenceDevice } from "../machine/reference-devices.mjs";
import { ionInstallation, ionDcProgram } from "../machine/ion-installation.mjs";
import { apparatus } from "../machine/apparatus.mjs";
import { examples } from "../machine/examples.mjs";
import { drawIonHardware, drawStudioTrap } from "../studio/ion-hardware.js";

const read = (name) => readFileSync(new URL("../"+name,import.meta.url));

test("Gate-ready H2 trap inventory binds both driven ions to the native MS instruction", () => {
  const f=JSON.parse(read("physical/h2-gate-register.json"));
  const bytes=read(f.program);
  assert.equal(createHash("sha256").update(bytes).digest("hex"),f.programSha256);
  const source=JSON.parse(bytes.toString().replaceAll("Infinity","null"));
  const gate=source.instructions[f.frame.sourceIndex];
  assert.equal(gate.gate,"MS");
  assert.equal(gate.id,f.sourceId);
  assert.deepEqual(gate.pairs,[["q0","q1"]]);
  assert.deepEqual(gate.sites,[f.site]);
  assert.equal(f.placement.q0,"DG01");
  assert.equal(f.placement.q1,"DG01");
  assert.equal(Object.keys(f.placement).length,32);
});

test("Optical envelopes reach DG01 and transport wiring ends on chip metal", () => {
  const device=referenceDevice("QCCD"), made=[], links=[];
  const inputs=device.drives.map((d)=>d.probe), chip="chip";
  const add=(id,label,form,centerMm,sizeMm,basis)=>{
    made.push({id,label,form,centerMm,sizeMm,basis});
    return id;
  };
  const route=(from,to,kind,probes=[],start,end,options={})=>links.push({from,to,probes,kind,start,end,...options});
  const main=ionInstallation({device,inputs,chip,add,route});
  assert.equal(made.find(p=>p.id===main).form,"ion-chamber");
  const dg=device.layout.sites.find(s=>s.id==="DG01");
  for(const probe of inputs){
    const path=links.filter(l=>l.probes.includes(probe));
    assert.equal(path[0].from,probe);
    assert.equal(path.at(-1).to,chip);
    assert.deepEqual(path.at(-1).end,[dg.x,-0.07,-dg.z]);
    assert.deepEqual(path.slice(1).map(l=>l.from),path.slice(0,-1).map(l=>l.to));
    assert.deepEqual(path.map(l=>l.signal),["electrical","electrical","optical","optical","optical"]);
  }
  const target=links.find(l=>l.kind==="Raman beat at DG01");
  assert.deepEqual(target.end,[dg.x,-0.07,-dg.z]);
  assert.deepEqual(target.forProbes,device.drives.filter(d=>d.targets.length>1).map(d=>d.probe));
  const bond=links.find(l=>l.from==="package" && l.to===chip);
  assert.equal(bond.end[1],0);
  assert.deepEqual(bond.probes,[]);
  for(const part of made) {
    const s=Object.fromEntries(["mesh","box","disc","ring","line"].map(k=>[k,()=>new T.Object3D()]));
    assert.equal(drawIonHardware(s,part),true,part.form);
  }
});

test("Published H2 metal plane has its RF loops, load aperture and calibrated extent", () => {
  const meshes=[];
  const s={box(){},mesh(geom){const m=new T.Mesh(geom);meshes.push(m);return m;}};
  drawStudioTrap(s,referenceDevice("QCCD"));
  assert.deepEqual(new Set(meshes.map(m=>m.userData.surfaceRole)),new Set(["aux","gate","conveyor","rf","load","outlines"]));
  for(const m of meshes) {
    m.geometry.computeBoundingBox();
    assert.ok(m.geometry.index.count>0);
    assert.equal(m.geometry.boundingBox.min.y,0);
    assert.equal(m.geometry.boundingBox.max.y,0);
    const normals=m.geometry.attributes.normal;
    assert.ok([...normals.array].every(Number.isFinite));
  }
  const ext=meshes.find(m=>m.userData.surfaceRole==="conveyor").geometry.boundingBox;
  assert.ok(Math.abs(ext.max.x-ext.min.x-6.58)<0.025);
  const load=meshes.find(m=>m.userData.surfaceRole==="load").geometry.boundingBox;
  assert.ok(load.min.x < -2.979 && load.max.x > -2.979);
});

test("All 268 independent DC sources have an FPGA bus and individually identifiable feedthrough and socket contacts",()=>{
  const d=examples.find(e=>e.id==="QCCD").design;
  const eq=apparatus(d.device,d.parts,d.wires);
  const control=eq.links.find(l=>l.controlBus);
  assert.equal(d.parts.find(p=>p.id===control.from).model.fpga.clockPs,6000);
  const socketContacts=new Set(),feedContacts=new Set();
  for(let n=1;n<=268;n++) {
    const [a,b,c]=eq.links.filter(l=>l.dcLane===n);
    assert.equal(a.from,control.to);
    assert.equal(a.to,b.from);
    assert.equal(b.to,c.from);
    assert.ok(eq.parts.some(p=>p.id===a.to && p.form==="ion-dc-lane"));
    assert.ok(eq.parts.some(p=>p.id===b.to && p.form==="ion-feedthrough"));
    assert.ok(eq.parts.some(p=>p.id===c.to && p.form==="ion-socket"));
    assert.ok(b.held && c.held && !a.probes.length && !b.probes.length && !c.probes.length);
    feedContacts.add(JSON.stringify(b.toOffsetMm));
    socketContacts.add(JSON.stringify(c.toOffsetMm));
  }
  assert.equal(feedContacts.size,268);
  assert.equal(socketContacts.size,268);
});

test("A selected native DAC latch updates on matching FPGA addresses and holds on a different address",()=>{
  const d=structuredClone(examples.find(e=>e.id==="QCCD").design);
  d.parts.push({...structuredClone(d.parts[0]),id:"@device/occupied"});
  const eq=apparatus(d.device,d.parts,d.wires);
  const program=ionDcProgram(d.device,268,[-32768,{channel:17,word:111},32767],d.parts,eq);
  assert.equal(program.parts[0].id,"sequencer");
  assert.ok(program.parts.slice(1).every(p=>p.id.startsWith("@@device/")));
  assert.ok(program.wires.every(w=>eq.links.some(l=>l.id===w.id)));
  const executable=fileURLToPath(new URL("../.lake/build/bin/qcontrol"+(process.platform==="win32"?".exe":""),import.meta.url));
  const result=spawnSync(executable,[],{input:JSON.stringify(program),encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  const trace=JSON.parse(result.stdout);
  const arrivals=trace.frames.filter(f=>f.part===program.parts.at(-1).id);
  assert.deepEqual(arrivals.map(f=>f.received),[["in",-10000000],["in",9999694]]);
  assert.ok(arrivals[1].atPs>arrivals[0].atPs);
  assert.ok(trace.frames.some(f=>f.source.endsWith("/hold-other-lane")));
  const bus=eq.links.find(l=>l.dcLane===268 && l.interconnect.kind==="parallel");
  const [low,high]=["D0","D7"].map(id=>bus.interconnect.conductors.find(c=>c.id===id));
  [low.toPin,high.toPin]=[high.toPin,low.toPin];
  [low.destinationBitIndex,high.destinationBitIndex]=[7,0];
  high.skewPs=80;
  const changed=ionDcProgram(d.device,268,[1],d.parts,eq);
  assert.equal(changed.wires[1].delayPs-program.wires[1].delayPs,80);
  const crossed=spawnSync(executable,[],{input:JSON.stringify(changed),encoding:"utf8"});
  assert.equal(crossed.status,0,crossed.stderr);
  const sample=JSON.parse(crossed.stdout).frames.find(f=>f.wire===bus.id);
  assert.deepEqual([sample.transmittedValue,sample.received[1]],[1,128]);
});
