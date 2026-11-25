// Plan coordinates (x, y) map to world (x, elevation, y). Labels and component
// thicknesses are display geometry. Both renderers consume this same assembly.
const metal="#c7aa74", substrate="#23444c", silver="#bfced0", ink="#213c43";
const teal="#38a79b", optic="#80c5cd", laser="#ba746b";
export const references={
  manila:{title:"Manila transmon chip",source:"Manila topology · Pomarico et al., Fig. 5a",url:"https://doi.org/10.3390/e25040608",
    note:"IBM’s archive sets the five qubit positions, coupling graph and channel assignments. Capacitor pads, resonators and line routing illustrate those connections. Amber marks the selected component. Teal marks activity."},
  lukin:{title:"Movable optical tweezers",source:"Bluvstein et al., Fig. 1b and Methods",url:"https://doi.org/10.1038/s41586-022-04592-6",
    note:"The optical paths show the reported equipment and wavelengths. The enlarged focal plane shows eight pair locations. Solid beads follow the two atoms in this program. Positions along their lane use the displayed distance scale."},
  h2:{title:"H2 racetrack trap",source:"Moses et al., Fig. 2 and Sec. II.A",url:"https://doi.org/10.1103/PhysRevX.13.041052",
    note:"The trap uses the H2 electrode span, four gate zones, gate pitch and ion height. Electrode subdivisions and beam widths are schematic. The pairs mark reference sites. Activity follows the register-level parity replay."}
};
function assembly(){
  const solids=[],labels=[];
  return {width:720,height:315,solids,labels,
    plate(key,owner,x,y,w,d,color,base=0,h=3){
      solids.push({key,owner,type:"polygon",points:[[x-w/2,y-d/2],[x+w/2,y-d/2],[x+w/2,y+d/2],[x-w/2,y+d/2]],color,base,h});
    },
    poly(key,owner,points,color,base=0,h=3){solids.push({key,owner,type:"polygon",points,color,base,h});},
    line(key,owner,points,color,r=1,base=5){solids.push({key,owner,type:"line",points,color,r,base});},
    round(key,owner,x,y,r,color,base=3,h=4,type="disc"){solids.push({key,owner,type,x,y,r,color,base,h});},
    label(text,x,y,owner){labels.push({text,x,y,owner});}
  };
}
function manila(m){
  const g=assembly(),qs=m.parts.filter(p=>p.kind==="Transmon");
  const x=i=>360+qs[i].position[0]*64;
  g.plate("carrier",null,360,151,658,234,"#ad946a",-9,6);
  g.plate("die",null,360,151,630,215,substrate,-3,3);
  for(const [i,q] of qs.entries()){
    const cx=x(i),d="d"+i,ro="m"+i,ac="acquire"+i;
    g.plate(q.id+".left",q.id,cx-12,148,20,27,silver,1,3);
    g.plate(q.id+".right",q.id,cx+12,148,20,27,silver,1,3);
    g.line(q.id+".junction",q.id,[[cx-3,148],[cx+3,148]],metal,1.4,3);
    g.line(d,d,[[cx-29,47],[cx-29,90],[cx-12,106],[cx-12,128]],metal,1.8);
    g.plate(d+".pad",d,cx-29,53,12,11,metal,1,2);
    const turns=[[cx+8,166],[cx+8,176],[cx+30,176],[cx+30,182],[cx-5,182],[cx-5,188],[cx+30,188],[cx+30,194],[cx-5,194],[cx-5,200],[cx+30,200],[cx+30,211]];
    g.line(ro,ro,turns,"#b2d0d0",1.65);
    g.line(ac,ac,[[cx+31,209],[cx+43,209],[cx+43,245]],metal,1.7);
    g.label("Q"+i,cx,121,q.id);
    g.label(d,cx-9,69,d);
  }
  for(const c of m.parts.filter(p=>p.qubits?.length===2)){
    const [a,b]=c.qubits,dir=Math.sign(b-a),y=dir===1?143:155;
    g.line(c.id,c.id,[[x(a)+24*dir,y],[x(b)-24*dir,y]],"#a999c3",1.25);
  }
  g.label("Drive lines",109,26);g.label("Coupled transmons",360,26);
  g.label("Readout resonators",360,282);g.label("Acquisition",581,282);
  return g;
}

function lukin(m){
  const g=assembly();
  g.plate("optical-bench",null,208,166,362,229,"#dde4df",-7,6);
  for(let i=0;i<12;i++)for(let j=0;j<6;j++)
    g.round("mount-"+i+"-"+j,null,44+i*29,71+j*39,1.25,"#a0b4b1",0,0.7);
  g.plate("generator","awg",82,82,72,31,"#47606c",1,15);
  g.plate("awg-display","awg",72,76,28,6,"#81aca9",16,1);
  for(let i=0;i<5;i++)g.plate("awg-vent"+i,"awg",62+i*9,87,5,10,silver,16,1);
  g.label("Waveform generator",101,41,"awg");
  g.line("rf-x","awg",[[110,82],[159,82],[159,113]],"#687c90",1.8,8);
  g.line("rf-y","awg",[[110,76],[203,76],[203,113]],"#687c90",1.8,8);
  g.line("mobile-beam","aod",[[53,130],[331,130]],"#4da592",3.3,10);
  for(const [i,cx] of [159,203].entries()){
    g.plate("aod-mount"+i,"aod",cx,130,29,31,silver,0,5);
    g.poly("aod-crystal"+i,"aod",[[cx-9,118],[cx+8,122],[cx+10,142],[cx-7,138]],optic,5,13);
  }
  g.label("828 nm",78,117);g.label("X / Y deflectors",184,161,"aod");
  g.plate("slm",null,102,212,33,31,"#657f88",0,9);
  for(let i=0;i<5;i++)g.line("slm-line"+i,null,[[91,201+i*5],[113,201+i*5]],silver,0.65,10);
  g.line("static-beam",null,[[118,212],[258,212],[258,130],[315,130]],"#9f87ba",2.4,10);
  g.label("Static tweezer pattern · 830 nm",149,254);
  for(const [i,cx] of [304,315,326].entries())g.round("objective"+i,"aod",cx,130,18-i*3,i===1?optic:"#5e7884",18,8,"lens");
  g.label("Objective",320,173,"aod");
  g.line("magnify",null,[[332,130],[390,130],[413,83]],"#809493",1,6);
  g.plate("field",null,546,147,248,233,substrate,-4,4);
  g.label("Tweezer focal plane",544,17);
  const span=Math.max(110,m.transportSpanUm),units=177/span,cy=147;
  const lanes=Array.from({length:8},(_,i)=>451+i*27);
  for(const [i,cx] of lanes.entries()){
    g.line("lane"+i,null,[[cx,cy-55*units],[cx,cy+55*units]],i===3?"#567c80":"#3f5961",0.55,0.2);
    for(const [j,dy] of [-55,-1.5,1.5,55].entries()){
      g.round("site"+i+"-"+j,null,cx,cy-dy*units,2.8,"#809eac",0.2,0.8);
    }
  }
  g.line("raman-beam","raman",[[422,cy],[670,cy]],laser,1.8,9);
  g.label("795 nm Raman beam",544,291,"raman");
  g.line("scale",null,[[684,cy-55*units],[684,cy+55*units]],ink,0.8,1);
  for(const s of [-1,1])g.line("tick"+s,null,[[680,cy+s*55*units],[688,cy+s*55*units]],ink,0.9,1);
  g.label("110 µm",677,33);
  for(const [i,id] of ["atom0","atom1"].entries()){
    g.round("well"+i,id,lanes[3],cy,8.5,optic,2,19,"well");
    g.round(id,id,lanes[3],cy,4.3,"#f4bf6f",4.1,8.6,"sphere");
    for(const s of g.solids.slice(-2))s.motion={part:id,units,centre:cy};
  }
  return g;
}

// Parameterise the centreline by arc length in mm. The top and bottom
// straights and both semicircles share a tangent at their junctions.
function trapPoint(s,offset,straight,r){
  let x,y,angle;
  if(s<straight){x=-straight/2+s;y=-r;angle=0;}
  else if(s<straight+Math.PI*r){
    angle=(s-straight)/r;x=straight/2+r*Math.sin(angle);y=-r*Math.cos(angle);
  }else if(s<2*straight+Math.PI*r){
    angle=Math.PI;x=straight/2-(s-straight-Math.PI*r);y=r;
  }else{
    angle=Math.PI+(s-2*straight-Math.PI*r)/r;x=-straight/2+r*Math.sin(angle);y=-r*Math.cos(angle);
  }
  return [360+(x+offset*Math.sin(angle))*94,140+(y-offset*Math.cos(angle))*94];
}
function h2(machine){
  const g=assembly(),{spanMm,widthMm,pitchMm,ionHeightMm}=machine.trapGeometry;
  const r=0.39,straight=spanMm-2*r-0.84,perimeter=2*straight+2*Math.PI*r;
  g.plate("carrier","surface",360,140,spanMm*94+26,widthMm*94+24,"#9d927f",-12,4);
  g.plate("window-surround","chamber",360,140,spanMm*94+21,widthMm*94+19,"#657579",-8,3);
  g.plate("trap-die","endpoint",360,140,spanMm*94+17,widthMm*94+15,"#34444e",-5,2);
  g.plate("electrode-field","endpoint",360,140,spanMm*94,widthMm*94,"#476264",-3,3);
  const n=90,point=(i,offset)=>trapPoint(i/n*perimeter,offset,straight,r);
  for(let i=0;i<n;i++){
    for(const [side,inner,outer,color] of [["outer",0.095,0.27,"#b5bd8f"],["inner",-0.27,-0.095,"#b0bda3"]]){
      const vertices=[point(i+0.04,inner),point(i+0.5,inner),point(i+0.96,inner),point(i+0.96,outer),point(i+0.5,outer),point(i+0.04,outer)];
      g.poly("electrode-"+side+i,"endpoint",vertices,color,0,2.8);
    }
  }
  // The broad blades fan around the conveyor turns. The four processing zones
  // interrupt those repeating segments along the straight, as in Fig. 2d.
  const gateXs=Array.from({length:4},(_,i)=>360+(i-1.5)*pitchMm*94);
  for(let i=0;i<50;i++){
    const u=n*i/50,v=n*(i+1)/50,cx=point((u+v)/2,.32)[0];
    const atZone=gateXs.some(x=>Math.abs(x-cx)<16);
    g.poly("outer-blade"+i,"endpoint",[point(u+.05,.285),point((u+v)/2,.285),point(v-.05,.285),
      point(v-.05,.42),point((u+v)/2,.42),point(u+.05,.42)],atZone?"#8396b5":"#a6b896",0,3);
  }
  for(const [i,x] of gateXs.entries()){
    for(let j=-2;j<=2;j++)g.plate("zone-strip"+i+"-"+j,"endpoint",x+j*4.4,140,3.4,widthMm*94-12,"#8395ac",0.1,1);
  }
  for(const s of [-1,1])g.line("rf-rail"+s,"endpoint",Array.from({length:181},(_,i)=>point(i/2,s*0.053)),"#d4c9b2",2.3,2.3);
  g.label("Segmented conveyor",157,24,"endpoint");
  const ionY=140+94*r,ionH=ionHeightMm*94+3;
  for(let i=0;i<4;i++){
    const x=360+(i-1.5)*pitchMm*94;
    g.plate("gate"+i,"endpoint",x,ionY,18,34,"#8795ba",3,1.3);
    for(const s of [-1,1]){
      g.line("laser"+i+"-"+s,"drive",[[x-89*s,ionY-89],[x,ionY],[x+42*s,ionY+42]],"#cf9892",0.95,ionH);
      g.round("reference-ion"+i+"-"+s,"endpoint",x+s*3.4,ionY,2.8,"#efd196",ionH,5.6,"sphere");
    }
    g.label("G"+(i+1),x,216,"endpoint");
  }
  g.label("Gate pitch 750 µm",360,24);
  const boxes=[["controller","Sequencer"],["dac","Angle words"],["drive","Laser control"],["endpoint","Ion register"],["readout","State readout"]];
  g.plate("control-rack","frame",360,278,658,36,"#b3c3c3",-6,5);
  for(const [i,[id,label]] of boxes.entries()){
    const x=92+i*134;g.plate("control-"+id,id,x,278,112,25,"#d4dfde",0,5);
    if(i<4)g.line("connection"+i,i===0?"dac-bus":null,[[x+56,278],[x+78,278]],"#657e82",2.1,2);
    g.label(label,x,278,id);
  }
  return g;
}
export function hardwareLayout(machine){
  return {manila,lukin,h2}[machine.apparatus](machine);
}
export function componentState(machine,frame,selected){
  const active=new Set(),chosen=new Set([selected]);
  if(machine.apparatus==="manila"){
    for(const p of machine.parts.filter(p=>p.qubits)){
      const targets=p.qubits.map(i=>"q"+i);
      if(p.id===selected)targets.forEach(q=>chosen.add(q));
      const op=frame.state[p.id]?.instruction;
      if(op && op.name!=="delay"){active.add(p.id);targets.forEach(q=>active.add(q));}
    }
  }else if(machine.apparatus==="lukin"){
    for(const e of frame.events){
      if(e.part==="raman"?e.after.axis!=="off":e.before && JSON.stringify(e.before)!==JSON.stringify(e.after))active.add(e.part);
    }
  }else frame.events.forEach(e=>active.add(e.part));
  return {active,chosen};
}
export function planY(solid,frame){
  return solid.motion ? solid.motion.centre-frame.state[solid.motion.part].yUm*solid.motion.units : solid.y;
}

export function hardwareReading(machine,frame,selected){
  if(machine.apparatus==="lukin"){
    const separation=frame.state.atom1.yUm-frame.state.atom0.yUm;
    return Number(frame.at.toFixed(3))+" µs · atom separation "+Number(separation.toFixed(3))+" µm · Raman beam "+frame.state.raman.axis;
  }
  if(machine.apparatus==="manila"){
    const active=componentState(machine,frame,selected).active;
    const channels=machine.parts.filter(p=>p.qubits && active.has(p.id)).map(p=>p.id);
    const freq=machine.parts.find(p=>p.id===selected)?.calibration?.find(c=>c.name==="frequency");
    return "Tick "+frame.at+" · "+(channels.length?"Active channels "+channels.join(", "):"All channels idle")+
      (freq?" · "+selected+" at "+freq.value.toFixed(3)+" "+freq.unit:"");
  }
  const e=frame.events[0];
  if(e.part==="readout")return "Register readout · observed parity "+e.after.observed+" · predicted "+Number(e.after.predicted.toFixed(4));
  if(e.part==="endpoint")return "Register response · predicted parity "+Number(e.after.predicted.toFixed(4));
  return frame.label+" · "+e.part;
}
