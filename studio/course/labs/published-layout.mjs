// Coordinates are pixels in the cited panel crops. The live transport strip is
// a separate drawing. Its scale comes from the 110 µm arrow in Fig. 1b.
export const layouts={
  manila:{
    title:"Manila coupling map",file:"manila-topology.png",width:1460,height:263,imageWidth:1460,
    source:"Pomarico et al., Entropy 25, 608 (2023), Fig. 5a",url:"https://doi.org/10.3390/e25040608",
    note:"Select a numbered qubit. A teal ring marks a qubit addressed by a pulse or acquisition window at this tick. Amber marks the selected qubit or the qubits served by the selected channel. Node spacing is schematic."
  },
  lukin:{
    title:"Atom positions before and after transport",file:"lukin-pairs.png",width:865,height:276,imageWidth:683,
    source:"Bluvstein et al., Nature 604 (2022), Fig. 1b",url:"https://doi.org/10.1038/s41586-022-04592-6",
    note:"The two camera images are the published endpoints. The separate strip follows one simulated pair at the selected time. Its vertical scale matches the 110 µm arrow for the published journey. Marker size is enlarged."
  },
  h2:{
    title:"H2 surface-electrode racetrack",file:"h2-racetrack.png",width:1292,height:395,imageWidth:1292,
    source:"Moses et al., Phys. Rev. X 13, 041052 (2023), Fig. 2d",url:"https://doi.org/10.1103/PhysRevX.13.041052",
    note:"Follow the loop around the ends and find the four laser crossings on the lower straight. Select the track to inspect the modeled register. The parity replay records collective rotations and readout. Individual ion positions in the artwork belong to the paper."
  }
};

export function apparatusMarkers(machine,frame,selected){
  if(machine.apparatus==="manila"){
    const channels=machine.parts.filter(p=>p.qubits);
    const target=channels.find(p=>p.id===selected)?.qubits??[];
    const active=new Set(channels.filter(p=>{
      const op=frame.state[p.id]?.instruction;
      return op && op.name!=="delay";
    }).flatMap(p=>p.qubits));
    return machine.parts.filter(p=>p.kind==="Transmon").map(p=>{
      const i=Number(p.id.slice(1));
      return {id:p.id,x:92+(p.position[0]+4)*160.75,y:97,r:66,
        label:"Qubit "+i,selected:selected===p.id||target.includes(i),active:active.has(i)};
    });
  }
  if(machine.apparatus==="lukin"){
    // Preserve the paper scale across time. For longer user programs, enlarge
    // the field of view once per program, never independently at each step.
    const span=Math.max(110,machine.transportSpanUm);
    return ["atom0","atom1"].map((id,i)=>({id,x:770,y:139-frame.state[id].yUm*240/span,r:7,
      label:i?"Upper atom":"Lower atom",selected:selected===id,active:frame.events.some(e=>e.part===id && e.before?.yUm!==e.after.yUm)}));
  }
  if(machine.apparatus==="h2"){
    return [{id:"endpoint",shape:"track",x:72,y:156,w:1154,h:146,r:73,label:"H2 ion register",
      selected:selected==="endpoint",active:frame.events.some(e=>e.part==="endpoint")}];
  }
  return [];
}

export function apparatusReading(machine,frame,selected){
  if(machine.apparatus==="lukin"){
    const d=frame.state.atom1.yUm-frame.state.atom0.yUm;
    return "Model separation "+Number(d.toFixed(2))+" µm at "+Number(frame.at.toFixed(2))+" µs · Raman beam "+frame.state.raman.axis+
      (machine.transportSpanUm>110?" · expanded model scale, "+machine.transportSpanUm+" µm between reference ticks":"");
  }
  if(machine.apparatus==="manila"){
    const active=machine.parts.filter(p=>p.qubits && frame.state[p.id]?.instruction && frame.state[p.id].instruction.name!=="delay").map(p=>p.id);
    const frequency=machine.parts.find(p=>p.id===selected)?.calibration?.find(item=>item.name==="frequency");
    return "Tick "+frame.at+" · "+(active.length?"Active channels "+active.join(", "):"No pulse or acquisition window open")+
      (frequency?" · "+selected+" archived transition frequency "+frequency.value.toFixed(3)+" "+frequency.unit:"");
  }
  const e=frame.events[0];
  if(e.part==="readout")return "Register measurement · observed parity "+e.after.observed+" · predicted "+Number(e.after.predicted.toFixed(4));
  if(e.part==="endpoint")return "Register response · predicted parity "+Number(e.after.predicted.toFixed(4));
  return "Current step · "+frame.label+" · "+e.part+(selected==="endpoint"?" · inspecting the full register":"");
}
