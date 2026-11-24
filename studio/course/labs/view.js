import {programs,replay} from "./replay.mjs";
import {sampleEnvelope} from "./manila.mjs";

for (const box of document.querySelectorAll("[data-replay]")) {
  const name=box.dataset.replay;
  const get=s=>box.querySelector(s);
  const input=get("textarea"), range=get("input[type=range]"), parts=get("select");
  const message=get("[role=status]");
  const predecessors=document.createElement("div");
  predecessors.className="cause-links";
  get("[data-reading]").after(predecessors);
  let run, draw, eventLocations, runNumber=0;
  input.value=JSON.stringify(programs[name],null,2);
  function paint() {
    const k=Number(range.value), frame=run.frames[k], part=parts.value;
    const info=run.machine.parts.find(p=>p.id===part);
    get("output").textContent=(k+1)+" / "+run.frames.length+" · "+Number(frame.at.toFixed(4))+" "+run.machine.unit+
      (run.machine.dtNs ? " ("+Number((frame.at*run.machine.dtNs).toFixed(3))+" ns)" : "")+" · "+frame.label;
    get("[data-prev]").disabled=k===0; get("[data-next]").disabled=k===run.frames.length-1;
    const events=frame.events.filter(e=>e.part===part);
    const assigned=Object.hasOwn(frame.state,part);
    get("[data-reading]").textContent=JSON.stringify({part,kind:info.kind, state:assigned ? frame.state[part] : (info.calibration ?? "idle"),
      transitions:events},null,2);
    predecessors.replaceChildren();
    const causes=[...new Set(events.flatMap(event=>event.causes))];
    if(causes.length) {
      predecessors.append("Follow an input to this transition ");
      for(const id of causes) {
        const dest=eventLocations.get(id), button=document.createElement("button");
        button.type="button"; button.textContent=dest.part+" · step "+(dest.index+1);
        button.onclick=()=>{range.value=dest.index;parts.value=dest.part;paint();};
        predecessors.append(button);
      }
    }
    draw?.(frame,part,run.machine);
    const traces = name==="cell" ? ["clk","b","a","d","master","q"] : name==="helios" ? ["clk","a_increase","b_increase","is_fully_grown","is_odd_cluster"] : name==="lukin" ? ["atom0","atom1","raman"] : [part];
    const svg=get("svg"), svgNS="http://www.w3.org/2000/svg";
    const node=(tag,attrs)=>{const n=document.createElementNS(svgNS,tag);for(const [key,v] of Object.entries(attrs))n.setAttribute(key,v);svg.append(n);return n;};
    svg.replaceChildren();
    const H=traces.length*30+14, end=run.frames.at(-1).at || 1;
    svg.setAttribute("viewBox","0 0 570 "+H);
    traces.forEach((id,row)=>{
      const base=row*30+24;
      node("text",{x:2,y:base,fill:"#344852","font-size":13}).textContent=({is_fully_grown:"full",is_odd_cluster:"odd",a_increase:"grow A",b_increase:"grow B"})[id]??id;
      const level=f=>{const v=f.state[id]; if(v==="X") return null; if(typeof v==="number")return v;
        if(v?.yUm!==undefined) return (v.yUm/Math.max(1,...run.frames.map(p=>Math.abs(p.state[id].yUm)))+1)/2;
        if(v?.axis) return Number(v.axis!=="off");
        return Number(Boolean(v?.signal && v.signal!=="idle"));};
      let d="", gap=true;
      for(const [i,f] of run.frames.entries()){
        const value=level(f);
        if(value===null) {gap=true;continue;}
        const x=70+494*f.at/end, y=base-16*value;
        d+=gap ? "M"+x+" "+y : name==="lukin" && id.startsWith("atom") ? " L"+x+" "+y : " H"+x+" V"+y;
        gap=false;
      }
      node("path",{d,stroke:"#087e73",fill:"none","stroke-width":2});
    });
    const x=70+494*frame.at/end;
    node("line",{x1:x,x2:x,y1:0,y2:H,stroke:"#b35422","stroke-dasharray":"3 3"});
    if (name==="manila") {
      const channel=frame.state[part], plot=get("[data-envelope]");
      plot.hidden=!sampleEnvelope(channel,0);
      if (!plot.hidden) {
        const chart=plot.querySelector("svg");
        const length=channel.length;
        const count=Math.min(512,length);
        const samples=Array.from({length:count},(_,i)=>sampleEnvelope(channel,Math.round(i*(length-1)/(count-1))));
        const peak=Math.max(0.000001,...samples.flat().map(Math.abs));
        chart.replaceChildren();
        for (const [axis,color] of ["#087e73","#a85425"].entries()) {
          const curve=document.createElementNS(svgNS,"path");
          curve.setAttribute("d",samples.map((v,i)=>(i?"L":"M")+(4+552*i/(count-1))+" "+(48-43*v[axis]/peak)).join(" "));
          curve.setAttribute("fill","none"); curve.setAttribute("stroke",color); curve.setAttribute("stroke-width",2);
          chart.append(curve);
        }
        plot.querySelector("figcaption").textContent="Digital envelope · I (teal) and Q (orange), 0–"+(length-1)+" sample ticks. Vertical range ±"+peak.toPrecision(3)+" normalized amplitude. At most 512 samples displayed.";
      }
    }
  }
  async function execute(selection) {
    const token=++runNumber;
    try {
      const p=JSON.parse(input.value);
      const result=await replay(name,p,async url=>{const r=await fetch(url);if(!r.ok)throw Error("Could not load calibration.");return r.json();});
      if(token!==runNumber)return;
      run=result; range.max=run.frames.length-1;range.value=0;
      eventLocations=new Map(run.frames.flatMap((f,index)=>f.events.map(e=>[e.id,{part:e.part,index}])));
      if (result.referenceComparison) showParity(result.referenceComparison);
      if(!parts.length)for(const part of run.machine.parts)parts.add(new Option(part.id+" · "+part.kind,part.id));
      parts.value=({cell:"q",lukin:"atom1",manila:"d0",helios:"is_fully_grown"})[name];
      if(selection && run.machine.parts.some(p=>p.id===selection.part)){
        parts.value=selection.part;
        range.value=Math.min(selection.step,run.frames.length-1);
      }
      message.textContent="Program loaded.";
      paint();
    } catch(e){if(token===runNumber)message.textContent="Program error. "+e.message+(run?" Showing the last successful replay.":"");}
  }
  get("[data-run]").onclick=execute;
  box.addEventListener("lesson-program",event=>{
    input.value=JSON.stringify(event.detail.program,null,2);
    execute(event.detail);
  });
  get("[data-prev]").onclick=()=>{range.stepDown();paint();};
  get("[data-next]").onclick=()=>{range.stepUp();paint();};
  range.oninput=parts.onchange=paint;
  await execute();
  try {
    const {drawScene}=await import("./scene.js");
    draw=drawScene(get("canvas"),run.machine,id=>{parts.value=id;paint();});
    paint();
  } catch {get("canvas").hidden=true;message.textContent="3D rendering unavailable here. Every part is available in the inspector.";}
}

function showParity({rows,transportedRmse}) {
  const box=document.querySelector("#parity-comparison");
  if (!box) return;
  const svg=box.querySelector("svg"), slider=box.querySelector("input");
  const x=i=>15+i*13, y=v=>72-63*v;
  // All markup values are finite coordinates computed from the checked-in observations.
  const curve=rows.map((row,i)=>(i?"L":"M")+x(i)+" "+y(row.predicted)).join(" ");
  const dots=rows.map((row,i)=>'<circle cx="'+x(i)+'" cy="'+y(row.transported)+'" r="2.8" fill="#a85425"/>').join("");
  function paint() {
    const i=Number(slider.value), row=rows[i];
    svg.innerHTML='<path fill="none" stroke="#087e73" stroke-width="2" d="'+curve+'"/>'+dots+
      '<path stroke="#495966" stroke-dasharray="2 3" d="M'+x(i)+' 4v134"/>';
    box.querySelector("output").textContent="Phase "+row.phaseRad.toFixed(3)+" rad · stationary fit "+row.predicted.toFixed(3)+
      " · observed after transport "+row.transported.toFixed(3)+" · RMS difference over the sweep "+transportedRmse.toFixed(3)+" parity units.";
  }
  slider.oninput=paint;
  paint();
}
