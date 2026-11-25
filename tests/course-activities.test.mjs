import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {activities,circuits,settingsFor,executeActivity} from "../studio/course/labs/activities.mjs";
import {debugDesign} from "../validation/board/bench.mjs";
import {runMachine} from "../server.mjs";
import {run as runController} from "../riscq/examples.mjs";
import {hardwareLayout} from "../studio/course/labs/hardware-layout.mjs";

const json=async url=>JSON.parse(await readFile(url,"utf8"));
const io={json,request:async(path,data)=>{
  if(path==="/api/machines/run")return runMachine(data);
  if(path.startsWith("/api/board-validation/design?"))return debugDesign(new URL(path,"http://localhost").searchParams.get("case"));
  if(path==="/api/riscq/run")return runController(data);
  assert.equal(path,"/api/validation/replay");
  return JSON.parse(execFileSync(process.env.QCONTROL_PYTHON??"python",["-B","-X","utf8","validation/run.py","--replay"],
    {input:JSON.stringify(data),maxBuffer:16000000}));
}};

const repaired={
  P1:{readout:true},P2:{moving:true,finalSeparationUm:110},P3:{gate:"sx"},P4:{sign:-1},
  S1:{word:16384,connected:true},S2:{increment:4},S8:{word:16384,shape:"hill"},S3:{envelope:"burst"},
  S6:{durationUs:300},S7:{moving:true},S4:{observation:"durham-fig4a-row-3"},S5:{direction:"rising"},
  R4:{wait:8},R1:{bits:8},R2:{threshold:0},R3:{windowUs:5,threshold:2},
  F5:{timing:"early"},F1:{bit3:1},F2:{edge:true},F3:{literal:"0110"},F6:{release:3},F4:{pulse:true},
  K1:{bits:"11"},K2:{second:1},K3:{second:1,odd:1},
  M1:{pair:true,readout:true},M2:{moving:true,finalSeparationUm:110,durationUs:300},M3:{observation:"h2-ghz32-theta04"}
};
test("hand-written memory words survive a shared URL and produce the measured sequence",async()=>{
  const params=new URLSearchParams({shape:"custom",sample0:"0",sample1:"8192",sample2:"16384",sample3:"8192",sample4:"0"});
  const settings=settingsFor("S8",params);
  const {evaluation,run}=await executeActivity("S8",settings,io);
  assert.ok(evaluation.pass);
  assert.deepEqual(run.document.source.tracks[0].body[0].stream.words,[0,8192,16384,8192,0]);
  assert.deepEqual(settings,settingsFor("S8",new URLSearchParams(settings)));
  assert.throws(()=>settingsFor("S8",new URLSearchParams({sample0:32768})),/integer/);
  assert.throws(()=>settingsFor("F3",new URLSearchParams({literal:"001x"})),/binary/);
});
test("every component and published-machine lesson has its own executable challenge",async()=>{
  const curriculum=await json(new URL("../studio/course/curriculum.json",import.meta.url));
  const ids=curriculum.parts.slice(0,6).flatMap(p=>p.lessons.map(l=>l.id)).sort();
  assert.deepEqual(Object.keys(activities).sort(),ids);
  assert.deepEqual(Object.keys(repaired).sort(),ids);
});
for(const [id,fix] of Object.entries(repaired)){
  test(id+" starter fails, the repaired program passes and its evidence can be inspected",async()=>{
    const settings=settingsFor(id),first=await executeActivity(id,settings,io);
    assert.equal(first.evaluation.pass,false,first.evaluation.reading);
    const built=settingsFor(id,new URLSearchParams({...settings,...fix}));
    const {run,evaluation}=await executeActivity(id,built,io);
    assert.equal(evaluation.pass,true,evaluation.reading);
    const frame=run.frames[evaluation.index];
    assert.ok(frame && evaluation.reading);
    const parts=new Set(run.machine.parts.map(p=>p.id));
    if(id==="M3"){
      const {chipModel}=await json(new URL("../physical/qccd-installation.json",import.meta.url));
      assert.deepEqual(run.machine.trapGeometry,{spanMm:chipModel.electrodeSpanMm,widthMm:chipModel.isthmusWidthMm,
        pitchMm:chipModel.h2PitchMm,ionHeightMm:chipModel.ionHeightMm});
      const solids=hardwareLayout(run.machine).solids;
      assert.equal(new Set(solids.map(s=>s.key)).size,solids.length);
      solids.filter(s=>s.owner).forEach(s=>assert.ok(parts.has(s.owner),s.owner));
      const gates=solids.filter(s=>/^gate\d$/.test(s.key));
      assert.equal(gates.length,4);
      assert.equal((gates[1].points[0][0]-gates[0].points[0][0])/94,0.75);
      assert.ok(Math.abs((solids.find(s=>s.key.startsWith("reference-ion")).base-3)/94-0.07)<1e-12);
    }
    for(const port of circuits[activities[id].engine].ports)assert.ok(parts.has(port.id),port.id);
    const seen=new Set(run.frames.flatMap(f=>f.events.map(e=>e.id)));
    for(const f of run.frames)for(const event of f.events){
      assert.ok(parts.has(event.part),event.part);
      for(const cause of event.causes)assert.ok(seen.has(cause),cause);
      const finalTransition=f.events.findLast(e=>e.part===event.part);
      if(event===finalTransition)assert.deepEqual(f.state[event.part],event.after);
    }
  });
}
