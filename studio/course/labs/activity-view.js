import {activities,circuits,settingsFor,executeActivity} from "./activities.mjs";
import {el} from "../course.js";
import {hardwarePlan} from "./hardware-plan.js";
import {references,hardwareReading} from "./hardware-layout.mjs";

const fmt=v=>typeof v==="number" ? Number(v.toPrecision(6)).toString() : String(v);
const svg=(name,attrs={})=>{
  const node=document.createElementNS("http://www.w3.org/2000/svg",name);
  for(const [key,value] of Object.entries(attrs)) node.setAttribute(key,value);
  return node;
};
const button=(label,onclick)=>el("button",{type:"button",text:label,onclick});
const requests=new Map();
async function request(url,body) {
  const res=await fetch(url,body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{});
  if (!res.ok) throw Error((await res.text()).slice(0,260));
  return res.json();
}
const io={request,json:async url=>{
  const key=String(url);
  if(!requests.has(key)) requests.set(key,request(url).catch(e=>{requests.delete(key);throw e;}));
  return requests.get(key);
}};

function signalDiagram(circuit,select,connected) {
  const {ports,wires}=circuit;
  const edges=wires.filter(([a,b])=>!(b==="scope" && connected===false));
  const rank=new Map(ports.map(p=>[p.id,0]));
  for(let pass=0;pass<ports.length;pass++) for(const [a,b] of wires)
    rank.set(b,Math.max(rank.get(b),rank.get(a)+1));
  if (!wires.length) ports.forEach((p,i)=>rank.set(p.id,i));
  const vertical=matchMedia("(max-width:600px)").matches;
  const layers=new Map(), pos=new Map();
  for(const p of ports){
    const col=rank.get(p.id),row=layers.get(col)??0;
    pos.set(p.id,vertical ? [12+row*138,12+col*53] : [12+col*165,12+row*68]);layers.set(col,row+1);
  }
  const columns=Math.max(...rank.values())+1,rows=Math.max(...layers.values());
  const w=vertical ? 138*rows+8 : 165*(columns-1)+144,h=vertical ? columns*53+12 : rows*68;
  const diagram=svg("svg",{viewBox:"0 0 "+w+" "+h,width:w,height:h,role:"group","aria-label":"Signal diagram. Choose a component to inspect."});
  for(const [a,b,label] of edges){
    const [x,y]=pos.get(a),[u,v]=pos.get(b);
    const d=vertical ? "M"+(x+59)+" "+(y+40)+" C"+(x+59)+" "+(y+48)+" "+(u+59)+" "+(v-10)+" "+(u+59)+" "+(v-2) :
      "M"+(x+118)+" "+(y+20)+" C"+(x+149)+" "+(y+20)+" "+(u-31)+" "+(v+20)+" "+(u-3)+" "+(v+20);
    const path=svg("path",{d,class:"wire"});
    const title=svg("title");title.textContent=label;path.append(title);
    const tip=vertical ? "M"+(u+55)+" "+(v-8)+" l4 6 4 -6" : "M"+(u-8)+" "+(v+16)+" l6 4 -6 4";
    diagram.append(path,svg("path",{d:tip,class:"wire"}));
  }
  for(const p of ports){
    const [x,y]=pos.get(p.id),g=svg("g",{transform:"translate("+x+" "+y+")",tabindex:0,role:"button","aria-label":"Probe "+p.label,"data-port":p.id});
    g.append(svg("rect",{x:0,y:0,width:118,height:40,rx:5}));
    const t=svg("text",{x:59,y:24,"text-anchor":"middle"});t.textContent=p.label;g.append(t);
    g.onclick=()=>select(p.id);
    g.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();select(p.id);}};
    diagram.append(g);
  }
  return diagram;
}

function plotSignal(plot,frames,part,read,index,unit) {
  const samples=frames.map((f,i)=>({at:f.at,i,value:read(f.state[part])})).filter(s=>Number.isFinite(s.value));
  plot.replaceChildren();plot.hidden=!samples.length;
  if(!samples.length)return;
  const low=Math.min(...samples.map(s=>s.value)),high=Math.max(...samples.map(s=>s.value));
  const start=frames[0].at,duration=frames.at(-1).at-start;
  const x=at=>55+(at-start)*493/(duration||1);
  const y=v=>high===low?45:73-56*(v-low)/(high-low);
  const graph=svg("svg",{viewBox:"0 0 562 105",role:"img","aria-label":part+" readings across the run, from "+fmt(low)+" to "+fmt(high)});
  function label(x,y,t){const n=svg("text",{x,y});n.textContent=t;graph.append(n);}
  graph.append(svg("path",{d:"M55 12 V79 H548",class:"axis"}));
  label(2,19,fmt(high));if(high!==low)label(2,73,fmt(low));
  label(55,99,fmt(start)+" "+unit);const end=svg("text",{x:548,y:99,"text-anchor":"end"});end.textContent=fmt(frames.at(-1).at)+" "+unit;graph.append(end);
  let d="";
  for(const [i,s] of samples.entries())d+=i?" H"+x(s.at)+" V"+y(s.value):"M"+x(s.at)+" "+y(s.value);
  graph.append(svg("path",{d,class:"wave"}),svg("line",{x1:x(frames[index].at),x2:x(frames[index].at),y1:9,y2:79,class:"cursor"}));
  plot.append(graph);
}

function download(name,doc) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(doc,null,2)],{type:"application/json"}));
  const a=el("a",{href:url,download:name});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function mountActivity(article,id) {
  const spec=activities[id];if(!spec)return;
  const circuit=circuits[spec.engine],params=new URL(location.href).searchParams;
  let settings,initialError;
  try {settings=settingsFor(id,params);}catch(e){settings=settingsFor(id);initialError=e.message;}
  let execution,step=0,part=spec.focus,sequence=0,dirty=false,draw,scenePending=false;
  let locations=new Map(), selectedEvent, lastResult, syncHandoff, completed=false;
  try {completed=localStorage.getItem("quantumos-lab-"+id)==="passed";}catch{}
  const box=el("section",{class:"activity",id:"workshop","aria-label":"Guided component lab"});
  const heading=el("h2",{id:"build-and-test",text:spec.title});
  const top=el("div",{class:"lab-head"},el("p",{class:"lab-kicker",text:"QuantumOS component lab"}),heading,el("p",{text:spec.task}));
  const hint=el("details",{class:"lab-hint"},el("summary",{text:"Get a troubleshooting hint"}),el("p",{text:spec.hint}));
  const controls=el("div",{class:"lab-controls"});
  const status=el("span",{role:"status",class:"lab-status"});
  const runButton=button("Run and test",()=>execute(true));
  const form=el("section",{class:"lab-block"},el("h3",{text:"Build the experiment"}),controls,el("div",{class:"lab-actions"},runButton,status));
  const links=el("div",{class:"lab-actions"});
  const source=el("pre");
  const sourceBox=el("details",{},el("summary",{text:"Read the executable program"}),source,
    el("p",{class:"src",text:"Download the experiment to replay it from the project folder with node studio/course/labs/run.mjs experiment <file.json>. Machine and validation experiments use the running QuantumOS server."}));
  const diagram=el("div",{class:"lab-diagram",tabindex:0});
  const apparatus=el("div");
  const hardwareOutput=el("output",{class:"lab-reading"});
  let plan;
  const planDetails=el("details",{},el("summary",{text:"Inspect the hardware in plan view"}));
  const planHolder=el("div",{class:"hardware-plan"});
  planDetails.append(planHolder);
  const description=el("p",{class:"lab-port-note"});
  const range=el("input",{type:"range",min:0,max:0,value:0,"aria-label":"Trace step"});
  const time=el("output",{class:"lab-time"});
  const traceControls=el("div",{class:"lab-step"});
  const select=el("select",{"aria-label":"Inspect a physical component"});
  const prev=button("←",()=>seek(step-1)),next=button("→",()=>seek(step+1));
  prev.setAttribute("aria-label","Previous trace step");next.setAttribute("aria-label","Next trace step");
  traceControls.append(prev,range,next);
  const reading=el("output",{class:"lab-reading"});
  const plot=el("div",{class:"lab-plot"});
  const causes=el("div",{class:"lab-causes"}),raw=el("pre");
  const canvas=el("canvas",{"aria-label":"Rotatable schematic of the active machine"});
  const sceneStatus=el("p",{class:"src"});
  const scene=el("details",{class:"lab-scene"},el("summary",{text:"Locate this component in 3D"}),canvas,sceneStatus);
  const data=el("details",{},el("summary",{text:"Inspect the state and its inputs"}),causes,raw);
  const traceTitle=el("h3",{text:"Read the signal path"});
  const traceBox=el("section",{class:"lab-block"},traceTitle,apparatus,diagram,description,
    el("label",{class:"lab-probe"},"Probe ",select),reading,plot,traceControls,time,data,scene);
  const verdict=el("strong"),evidence=el("p"),compare=el("p",{class:"lab-previous"});
  const grade=el("div",{class:"lab-eval","aria-live":"polite"},verdict,evidence,compare);
  const resultBox=el("section",{class:"lab-block"},el("h3",{text:"Evaluate the result"}),grade,hint,links,sourceBox,
    el("p",{class:"lab-boundary",text:circuit.boundary}));
  box.append(top,form,traceBox,resultBox);
  const insert=article.querySelector("[data-replay], .ex, .remember");
  if(insert)insert.before(box);else article.append(box);
  article.querySelector(".lead")?.after(el("p",{class:"lab-jump"},el("a",{href:"#workshop",text:"Open the lab · "+spec.title})));
  const inputs=new Map();
  function updateFields(){
    for(const f of spec.fields){
      const matches=rule=>Object.entries(rule).every(([k,v])=>inputs.get(k)?.value===String(v));
      inputs.get(f.id).parentElement.hidden=Boolean((f.when&&!matches(f.when))||(f.unless&&matches(f.unless)));
    }
  }
  for(const field of spec.fields){
    const input=field.type==="integer"?el("input",{type:"number",min:field.min,max:field.max,step:1,required:""}):
      field.type==="bits"?el("input",{type:"text",maxlength:4,pattern:"[01]{4}",required:""}):el("select");
    for(const [value,label] of field.choices??[]) input.add(new Option(label,String(value)));
    input.value=String(settings[field.id]); inputs.set(field.id,input);
    input.addEventListener(field.type?"input":"change",()=>{
      updateFields();
      sequence++;dirty=true;runButton.disabled=false;
      status.textContent="Build changed. Run to test these settings.";
      grade.dataset.pass="";verdict.textContent="Awaiting this build";evidence.textContent="";compare.textContent="";
      traceBox.hidden=true;sourceBox.hidden=true;links.replaceChildren();
    });
    controls.append(el("label",{},el("span",{text:field.label}),input));
  }
  updateFields();
  function probe(id,event){part=id;selectedEvent=event;select.value=id;paint();}
  function seek(i){step=Math.max(0,Math.min(execution.run.frames.length-1,i));selectedEvent=null;paint();}
  range.oninput=()=>seek(range.valueAsNumber);
  select.onchange=()=>probe(select.value);
  box.addEventListener("figure-probe",e=>{
    if(execution && !dirty)probe(e.detail);
  });
  function paint(){
    if(!execution || dirty)return;
    const {run}=execution,f=run.frames[step];
    if(plan){
      plan.update(f,part);
      hardwareOutput.textContent=hardwareReading(run.machine,f,part);
    }
    const meta=run.machine.parts.find(p=>p.id===part), p=circuit.ports.find(p=>p.id===part);
    const read=p?.read??(v=>typeof v==="number"?v:null);
    const origin=selectedEvent ? locations.get(selectedEvent) : lastEvent(part,step);
    const current=read(selectedEvent ? origin.event.after : f.state[part]),unit=p?.unit??meta?.signalUnit;
    const wires=circuit.wires.filter(([a,b])=>(a===part||b===part) && !(b==="scope" && execution.program.connected===false));
    const label=id=>circuit.ports.find(n=>n.id===id)?.label??id;
    description.textContent=(p?.meaning??meta?.kind??"")+(wires.length?" "+wires.map(([a,b,tag])=>label(a)+" → "+label(b)+" ("+tag+")").join(" · "):"");
    for(const g of diagram.querySelectorAll("[data-port]"))g.setAttribute("aria-pressed",String(g.dataset.port===part));
    const fallback=!origin ? "No event yet" : typeof f.state[part]==="object" ? "See event state" : String(f.state[part]);
    reading.textContent=(p?.label??part)+" · "+(current!=null?fmt(current)+(unit?" "+unit:""):fallback);
    range.value=step;prev.disabled=!step;next.disabled=step===run.frames.length-1;
    time.textContent="Step "+(step+1)+" / "+run.frames.length+" · "+fmt(f.at)+" "+run.machine.unit+" · "+f.label;
    causes.replaceChildren();
    raw.textContent=JSON.stringify({part,state:f.state[part]??null,transition:origin?.event??null},(key,v)=>key==="samples"&&Array.isArray(v)&&v.length>16?"See executable pulse archive ("+v.length+" samples)":v,2);
    for(const cause of origin?.event.causes??[]){
      const dest=locations.get(cause);
      if(dest)causes.append(button(dest.event.part+" · step "+(dest.index+1),()=>{step=dest.index;probe(dest.event.part,cause);}));
    }
    plotSignal(plot,run.frames,part,read,step,run.machine.unit);
    if(scene.open)draw?.(f,part,run.machine,locations);
    syncHandoff?.();
  }
  function lastEvent(id,at) {
    for(let i=at;i>=0;i--){
      const ev=execution.run.frames[i].events.findLast(e=>e.part===id);
      if(ev)return {event:ev,index:i};
    }
  }
  async function ensureScene(){
    if(!scene.open||!execution||dirty||scenePending)return;
    if(draw){paint();return;}
    scenePending=true;
    try{
      const {drawScene}=await import("./scene.js");
      draw=drawScene(canvas,execution.run.machine,probe);sceneStatus.textContent="Drag to rotate. Select a component to inspect its trace.";
      paint();
    }catch{sceneStatus.textContent="3D rendering is unavailable in this browser. The diagram and probe show the same trace.";
      if(plan){planDetails.open=true;canvas.hidden=true;}}
    finally{scenePending=false;}
  }
  scene.ontoggle=ensureScene;
  function shareParams(snapshot) {
    const query=new URLSearchParams(Object.entries(snapshot));return query;
  }
  async function execute(manual) {
    try{settings=settingsFor(id,new URLSearchParams([...inputs].map(([key,node])=>[key,node.parentElement.hidden ? String(spec.fields.find(f=>f.id===key).initial) : node.value])));}
    catch(error){status.textContent=error.message;return;}
    const token=++sequence,snapshot={...settings};
    runButton.disabled=true;status.textContent="Executing program…";traceBox.hidden=true;links.replaceChildren();
    try{
      const next=await executeActivity(id,snapshot,io);
      if(token!==sequence)return;
      execution=next;dirty=false;const {run,program,evaluation}=next;
      const executable=run.document??program;
      source.textContent=JSON.stringify({machine:run.machine.name,
        ...(run.machine.calibration?{calibration:run.machine.calibration}:{}),program:executable},null,2);
      sourceBox.hidden=false;
      const query=shareParams(snapshot);
      const replayURL="/course/"+id+"?"+query+"#workshop";
      select.replaceChildren();
      for(const p of run.machine.parts)select.add(new Option(p.id+" · "+p.kind,p.id));
      locations=new Map(run.frames.flatMap((f,index)=>f.events.map(event=>[event.id,{event,index}])));
      step=evaluation.index;part=spec.focus;selectedEvent=null;select.value=part;range.max=run.frames.length-1;
      const signal=signalDiagram(circuit,probe,program.connected);
      if(run.machine.apparatus){
        const ref=references[run.machine.apparatus];
        traceTitle.textContent=ref.title;
        if(!plan){
          scene.querySelector("summary").textContent="Schematic control hardware · 3D";
          apparatus.append(scene,hardwareOutput,planDetails,el("p",{class:"src"},ref.note," ",el("a",{href:ref.url,text:ref.source})));
          scene.open=true;
        }
        plan=hardwarePlan(run.machine,probe);
        planHolder.replaceChildren(plan.element);
        diagram.replaceChildren(el("details",{class:"signal-detail"},el("summary",{text:"Inspect the control signal path"}),signal));
      }else diagram.replaceChildren(signal);
      traceBox.hidden=false;
      paint();ensureScene();
      status.textContent=manual?"Build executed.":"Starter trace loaded.";
      verdict.textContent=evaluation.pass?"Target met":"Target missed";grade.dataset.pass=String(evaluation.pass);
      evidence.textContent=evaluation.reading;
      compare.textContent=lastResult && lastResult!==evaluation.reading ? "Previous run · "+lastResult : "";
      lastResult=evaluation.reading;
      if(evaluation.pass && manual){completed=true;try{localStorage.setItem("quantumos-lab-"+id,"passed");}catch{}}
      if(completed)status.textContent+=" Lab completed.";
      if(manual)history.replaceState(null,"","/course/"+id+"?"+query+location.hash);
      const workspace=run.workspace ?? (["waveform","strobe","electrode"].includes(spec.engine)?"/machines?lesson="+id+"&"+query:null);
      if(workspace){
        const handoff=el("a",{href:workspace,text:"Open this build in "+(workspace.startsWith("/machines")?"Machine Workbench":workspace.startsWith("/validation")?"Validation":"RISC-Q Studio")});
        syncHandoff=()=>{const url=new URL(workspace,location.origin);
          if(url.pathname==="/machines"){url.searchParams.set("event",String(step));url.searchParams.set("probe",part);}
          if(url.pathname==="/riscq-studio")url.searchParams.set("step",String(step));
          handoff.setAttribute("href",url.pathname+url.search);};
        syncHandoff();links.append(handoff);
      }
      const advanced=article.querySelector("[data-replay]");
      if(advanced)links.append(button("Inspect this program in the full debugger",()=>{
        advanced.dispatchEvent(new CustomEvent("lesson-program",{detail:{program,part,step}}));advanced.scrollIntoView({block:"start"});
      }));
      links.append(el("a",{href:replayURL,text:"Link to this build"}),button("Download experiment",()=>download(id+"-experiment.json",{lesson:id,settings:snapshot,program:run.document??program})));
    }catch(error){
      if(token!==sequence)return;
      status.textContent="Run failed. "+error.message;verdict.textContent="Run again to evaluate";grade.dataset.pass="";
      evidence.textContent="";compare.textContent="";
    }finally{if(token===sequence)runButton.disabled=false;}
  }
  traceBox.hidden=true;
  if(initialError){status.textContent="Invalid saved build. "+initialError+" A fresh starter is ready.";sourceBox.hidden=true;}
  else execute(false);
}
