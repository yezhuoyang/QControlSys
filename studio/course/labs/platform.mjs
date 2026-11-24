// Adapters preserve native event IDs, parents, component IDs and state. This only
// projects the committed trace into the stepping interface used by course labs.
function project(name, unit, rows, geometry, initial = {}, extra = {}) {
  const parts = [...new Set([...geometry.map(p=>p.id), ...rows.map(r=>r.part)])].map((id,i)=>{
    const p=geometry.find(p=>p.id===id);
    return {id, kind:p?.label ?? p?.kind ?? id, position:p?.position ?? [(i%5-2)*2,0,Math.floor(i/5)*1.4],
      ...(p?.model ? {model:Object.keys(p.model)[0]} : {})};
  });
  let state={...initial};
  const frames=rows.map((r,i)=>{
    const event={id:String(r.id), part:r.part, before:state[r.part]??null, after:r.state, causes:r.parents.map(String)};
    state={...state,[r.part]:r.state};
    return {at:unit==="step" ? i+1 : r.atPs/1000,label:r.op,events:[event],state};
  });
  return {machine:{name,unit,parts}, frames, ...extra};
}

export function waveformDocument({word,shape,connected,samples}) {
  const geometry=(id,label,model,x)=>({id,label,model,centerMm:[x,5,0],sizeMm:[20,10,18]});
  const wire=(id,src,out,dst,input)=>({id,src:{part:src,port:out},dst:{part:dst,port:input},delayPs:100});
  const shoulder=Math.trunc(word/2);
  const words=shape==="custom" ? samples : shape==="hill" ? [0,shoulder,word,shoulder,0] : [0,word,word,word,0];
  return {sourceName:"Tutorial waveform", design:{kind:"machine-design",version:1,
    parts:[geometry("clock","Sequencer",{fpga:{clockPs:4000}},-60),
      geometry("memory","Waveform memory",{ram:{words:[0],accessPs:1200}},-30),
      geometry("bus","Sample bus",{bus:{widthBits:16,beatPs:1000}},0),
      geometry("dac","Drive converter",{dac:{bits:14,fullScaleUv:1000000}},30),
      geometry("scope","Voltage probe",{probe:{signal:"voltageUv"}},60)],
    wires:[wire("address","clock","address","memory","address"),wire("sample","memory","out","bus","a"),
      wire("payload","bus","out","dac","in"),...(connected ? [wire("coax","dac","out","scope","in")] : [])],
    roles:{control:"clock"},calibrations:[],maxEvents:150},source:{language:"control-ir",version:1,
    tracks:[{role:"control",body:[{stream:{ram:"memory",words,periodTicks:2}}]}]}};
}

export async function machineDocument(engine, options, request) {
  if (engine==="waveform") return waveformDocument(options);
  const id=engine==="electrode" ? "peaks-"+options.direction : "rtl-bus";
  const doc=await request("/api/board-validation/design?case="+id);
  if (engine==="strobe") {
    const body=doc.source.tracks[0].body;
    const firstHigh=body.map(item=>item.at?.body[0]).find(op=>op?.write?.value===1);
    firstHigh.write.value=Number(options.pulse);
    firstHigh.origin=options.pulse ? "Tutorial first strobe high" : "Tutorial first strobe held low";
  }
  return doc;
}

export async function runNative(engine, options, request) {
  if (["waveform","electrode","strobe"].includes(engine)) {
    const doc=await machineDocument(engine,options,request);
    const {trace}=await request("/api/machines/run",doc);
    const parts=doc.design.parts.map(p=>({...p,position:p.centerMm.map(n=>n/22)}));
    // Fit the display to the apparatus. Electrical delays come from the design.
    const largest=Math.max(1,...parts.flatMap(p=>p.position.map(Math.abs)));
    for(const part of parts) part.position=part.position.map(n=>6*n/largest);
    const rows=trace.frames.map(f=>({...f,state:{...f.state,received:f.received,emitted:f.emitted}}));
    const initial=Object.fromEntries(trace.program.parts.map((p,i)=>[p.id,trace.initial[i]]));
    const result=project(doc.sourceName,"ns",rows,parts,initial,{document:doc});
    result.machine.wires=doc.design.wires;
    return result;
  }
  if(engine==="syndrome"){
    const outcomes={s0:Number(options.bits[0]),s1:Number(options.bits[1])};
    const program={example:"superconducting-repetition",outcomes};
    const r=await request("/api/riscq/run",program);
    const parts=r.system.parts.map(p=>({...p,position:[p.position[0]/9-4,0,p.position[1]/8-2]}));
    return project(r.example.title,"ns",r.frames,parts,{}, {document:program,bits:r.derived.bits,
      workspace:"/riscq-studio?example="+program.example+"&outcome=s0="+outcomes.s0+"&outcome=s1="+outcomes.s1});
  }
  const benchmark={h2:["qccd","qccd-h2"],spot:["neutral","neutral"],rabi:["superconducting","superconducting"]}[engine];
  if (!benchmark) throw Error("Unknown platform experiment.");
  const [platform,experiment]=benchmark, program={platform,experiment,case:options.observation};
  const r=await request("/api/validation/replay",program);
  const parts=r.system.parts.map(p=>({...p,position:p.centerMm.map(n=>n/130)}));
  // Analysis follows execution. Its index orders observations without assigning
  // a fictitious physical time to fitting or comparison.
  const result=project(r.system.name,"step",[...r.trace.frames,...r.analysisSteps],parts,{},{
    document:program,comparison:{observed:r.observed,predicted:r.predicted,unit:r.source.unit},
    workspace:"/validation?"+new URLSearchParams(program)
  });
  if(engine==="h2")result.machine.apparatus="h2";
  return result;
}
