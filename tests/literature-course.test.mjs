import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {runCell} from "../studio/course/labs/cell.mjs";
import {runManila, manilaProgram, sampleEnvelope} from "../studio/course/labs/manila.mjs";
import {runTransport, transportProgram, compareParity} from "../studio/course/labs/lukin.mjs";
import {linkProgram, runLink} from "../studio/course/labs/helios.mjs";
import {hardwareLayout,componentState,planY} from "../studio/course/labs/hardware-layout.mjs";

const read = name => readFileSync(new URL("../studio/course/labs/manila/"+name+"_manila.json", import.meta.url));
const archive = Object.fromEntries(["conf","props","defs"].map(k => [k,JSON.parse(read(k))]));

test("Manila hardware represents every archive channel and highlights the scheduled targets",()=>{
  const {machine,frames}=runManila([{gate:"sx",qubits:[3]},{gate:"measure",qubits:[0]}],archive);
  const owners=new Set(hardwareLayout(machine).solids.map(s=>s.owner));
  for(const p of machine.parts)assert.ok(owners.has(p.id),p.id);
  const state=componentState(machine,frames[0],"d3");
  assert.deepEqual([...state.active].sort(),["d3","q3"]);
  assert.deepEqual([...state.chosen].sort(),["d3","q3"]);
  const waiting=frames.find(f=>f.state.m0?.instruction?.name==="delay" && f.state.acquire0?.signal==="idle");
  assert.ok(waiting);
  assert.equal(componentState(machine,waiting,"m0").active.has("q0"),false);
});

test("native tweezer wells and atoms follow the executed trajectory on one fixed scale",()=>{
  for(const moving of [false,true]){
    const {machine,frames}=runTransport({...transportProgram,moving});
    const layout=hardwareLayout(machine);
    const [lower,upper]=["atom0","atom1"].map(id=>layout.solids.find(s=>s.key===id));
    for(const f of frames){
      assert.ok(Math.abs((planY(lower,f)-planY(upper,f))/lower.motion.units-(f.state.atom1.yUm-f.state.atom0.yUm))<1e-10);
      assert.equal(planY(upper,f),planY(layout.solids.find(s=>s.key==="well1"),f));
    }
  }
});

function verifyTrace({machine, frames}) {
  const parts = new Set(machine.parts.map(p => p.id)), seen = new Set(), state = {};
  for (const frame of frames) {
    for (const event of frame.events) {
      assert.ok(parts.has(event.part),event.part);
      assert.ok(!seen.has(event.id),event.id);
      for (const cause of event.causes) assert.ok(seen.has(cause),cause);
      if (Object.hasOwn(state,event.part)) assert.deepEqual(event.before,state[event.part]);
      state[event.part] = event.after;
      seen.add(event.id);
    }
    assert.deepEqual(frame.state,state);
  }
}

test("all sixteen cell configurations capture each row and hold through high-clock data changes", () => {
  for (let m=0;m<16;m++) {
    const lut = m.toString(2).padStart(4,"0");
    const pins = ["000"];
    for (const row of ["00","01","10","11"]) pins.push("0"+row,"1"+row,"1"+row.replace(/[01]/g,x=>x==="0"?"1":"0"),"0"+row.replace(/[01]/g,x=>x==="0"?"1":"0"));
    const run = runCell({lut,pins});
    verifyTrace(run);
    let q=0;
    for (const [i,frame] of run.frames.entries()) {
      const d=Number(lut[parseInt(pins[i].slice(1),2)]);
      if (i && pins[i][0]==="1" && pins[i-1][0]==="0") q=d;
      assert.equal(frame.state.d,d);
      assert.equal(frame.state.q,q);
    }
  }
  assert.throws(()=>runCell({lut:"0110",pins:["000","101"]}),/clock edge/);
});

test("IBM calibration files are the pinned unmodified upstream bytes", () => {
  const hashes = {
    conf:"f73e604ae003fb189cfdb35f7bafa818707cb8b80ff590fb07aa0ae032b636d9",
    defs:"37d320a54a396c04a5cb2c0574556997e4138586b5c4aacbdc84b09e51d084ed",
    props:"5c1e0fe721a8e2fc00584007740db1b3d14cdf0c03cd033369187d4d4e2b1c24"
  };
  for (const [key,expected] of Object.entries(hashes))
    assert.equal(createHash("sha256").update(read(key)).digest("hex"),expected);
});

test("every Manila command preserves native starts, ends, channels and frame updates", () => {
  for (const native of archive.defs.cmd_def) {
    const args = [0.3,-0.7,1.2].slice(0,({rz:1,u1:1,u2:2,u3:3})[native.name] ?? 0);
    const run = runManila([{gate:native.name,qubits:native.qubits,params:args}],archive);
    verifyTrace(run);
    const events = new Map(run.frames.flatMap(f=>f.events.map(e=>[e.id,{...e,at:f.at}])));
    for (const [i,op] of native.sequence.entries()) {
      const length=op.duration ?? op.parameters?.duration ?? archive.defs.pulse_library.find(x=>x.name===op.name)?.samples.length;
      for(const ch of op.ch ? [op.ch] : op.qubits.map(q=>"acquire"+q)) {
        const prefix="0."+i+"/"+ch;
        const start=events.get(prefix+"/start");
        assert.equal(start.at,op.t0);
        if(length) {
          assert.deepEqual(start.after.instruction,op);
          assert.equal(events.get(prefix+"/end").at,op.t0+length);
        } else {
          const phase=typeof op.phase==="number"?op.phase:-args[Number(op.phase.match(/P(\d)/)[1])];
          assert.ok(Math.abs(start.after.phaseRad-start.before.phaseRad-phase)<1e-12);
        }
      }
    }
  }
  verifyTrace(runManila(manilaProgram,archive));
  assert.throws(()=>runManila([{gate:"cx",qubits:[0,4]}],archive),/no matching/);
});

test("Manila sample grid matches the archive plateau and conjugate DRAG shape", () => {
  const sx=runManila([{gate:"sx",qubits:[0]}],archive).frames[0].state.d0;
  const a=sampleEnvelope(sx,0), b=sampleEnvelope(sx,159);
  const [re,im]=sx.instruction.parameters.amp;
  const normalized=([i,q])=>[(i*re+q*im)/(re*re+im*im),(q*re-i*im)/(re*re+im*im)];
  const l=normalized(a), r=normalized(b);
  assert.ok(Math.abs(l[0]-r[0])<1e-12 && Math.abs(l[1]+r[1])<1e-12 && l[1]!==0);
  assert.equal(sampleEnvelope(sx,160),null);
  const m=runManila([{gate:"measure",qubits:[0]}],archive).frames[0].state.m0;
  assert.deepEqual(sampleEnvelope(m,11000),m.instruction.parameters.amp);
});

test("moving and stationary atom cases share eight pulses with distinct trajectory endpoints", () => {
  const run=runTransport(transportProgram);
  const still=runTransport({...transportProgram,moving:false});
  verifyTrace(run); verifyTrace(still);
  const separation=f=>f.state.atom1.yUm-f.state.atom0.yUm;
  assert.equal(separation(run.frames[0]),3);
  assert.equal(separation(run.frames.at(-1)),110);
  assert.equal(run.frames.at(-1).at,300);
  assert.ok(still.frames.every(f=>separation(f)===3));
  assert.deepEqual(run.frames.map(f=>f.state.raman),still.frames.map(f=>f.state.raman));
  const edges=run.frames.filter((f,i)=>i && f.state.raman.axis!==run.frames[i-1].state.raman.axis);
  assert.deepEqual(edges.filter((_,i)=>i%2===0).map(f=>f.state.raman.axis),["X","Y","X","Y","Y","X","Y","X"]);
  for(let i=0;i<edges.length;i+=2) assert.equal(edges[i+1].at-edges[i].at,0.5);
});

test("the stationary calibration predicts the transported scan without fitting its markers", () => {
  const data=JSON.parse(readFileSync(new URL("../studio/course/labs/atom-parity.json",import.meta.url)));
  const fit=compareParity(data);
  assert.equal(fit.rows.length,41);
  assert.ok(Math.abs(fit.transportedRmse-0.037718)<0.000001);
  const changed=compareParity({...data,transported:data.transported.map(v=>-v)});
  assert.deepEqual(changed.rows.map(r=>r.predicted),fit.rows.map(r=>r.predicted));
});

test("synthesized Helios gates reproduce the upstream RTL testbench on each edge", () => {
  const source=readFileSync(new URL("../studio/course/labs/helios/neighbor_link.sv",import.meta.url));
  assert.equal(createHash("sha256").update(source).digest("hex"),"0d80e57a1b9aa286193b53cf93b502c0ac9247292e8c9b7a9faf65708f3da952");
  const netlist=JSON.parse(readFileSync(new URL("../studio/course/labs/helios/netlist.json",import.meta.url)));
  const run=runLink(linkProgram,netlist);
  verifyTrace(run);
  const word=(state,id,width)=>Array.from({length:width},(_,i)=>state[id+"["+i+"]"]*2**i).reduce((a,b)=>a+b);
  const outputs=run.frames.filter(f=>f.state.clk).map(({state:s})=>[
    word(s,"increased",2),s.is_fully_grown,s.is_odd_cluster,word(s,"a_old_root_out",15),word(s,"b_old_root_out",15)
  ]);
  assert.deepEqual(outputs,[[0,0,0,0,0],[1,0,0,3,9],[2,1,0,0,0],[2,1,1,0,0],[0,0,0,0,0]]);
  assert.equal(run.frames[0].state.is_odd_cluster,"X");
});
