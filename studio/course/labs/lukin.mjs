// Bluvstein et al., Fig. 1b,c. One representative pair and the transport
// interval. Sample a rest-to-rest cubic at probe times AND at every pulse edge.
export const transportProgram = {initialSeparationUm:3, finalSeparationUm:110, durationUs:300, moving:true};

// Use one complete stationary sweep, excluding its repeated 2π endpoint.
// Orthogonality on the uniform phase grid gives the three fit coefficients.
// All transported observations are held out of the fit.
export function compareParity(data) {
  const train = data.stationary.slice(0,-1);
  const mean = values => values.reduce((a,b)=>a+b,0)/values.length;
  const angle = k => 2*Math.PI*k/train.length;
  const offset = mean(train);
  const cosine = 2*mean(train.map((v,k)=>v*Math.cos(2*angle(k))));
  const sine = 2*mean(train.map((v,k)=>v*Math.sin(2*angle(k))));
  const rows = data.transported.map((measured,k)=>({
    phaseRad:angle(k), stationary:data.stationary[k], transported:measured,
    predicted:offset+cosine*Math.cos(2*angle(k))+sine*Math.sin(2*angle(k))
  }));
  return {figure:data.figure,offset,cosine,sine,rows,
    transportedRmse:Math.sqrt(mean(rows.map(row=>(row.transported-row.predicted)**2)))};
}
export const transportMachine = {
  name:"Bluvstein moving-atom apparatus",apparatus:"lukin",unit:"µs",
  calibration:{staticWavelengthNm:830,mobileWavelengthNm:828,ramanWavelengthNm:795,rabiMHz:1},
  parts:[
    {id:"awg",kind:"Spectrum M4i.6631-x8 waveform source",position:[-4,0,-2]},
    {id:"aod",kind:"Crossed deflectors and objective",position:[-1,0,-2]},
    {id:"atom0",kind:"Rubidium-87",position:[0,0,0]},
    {id:"atom1",kind:"Rubidium-87",position:[0,0,0]},
    {id:"raman",kind:"Global Raman beam",position:[4,0,-2]}
  ]
};
export function runTransport(program) {
  const {initialSeparationUm:a, finalSeparationUm:b, durationUs:T, moving} = program;
  if (![a,b,T].every(Number.isFinite) || a <= 0 || b <= 0 || T < 8 || T > 100000 ||
      Math.max(a,b) > 1000 || typeof moving !== "boolean") throw Error("Use positive separations up to 1,000 µm and 8–100,000 µs for this teaching replay.");
  const axes = ["X","Y","X","Y","Y","X","Y","X"];
  const width = 1/(2*transportMachine.calibration.rabiMHz);
  const pulses = axes.map((axis,i) => ({axis, on:(i+0.5)*T/8-width/2,off:(i+0.5)*T/8+width/2}));
  const times = new Set([0,T,...pulses.flatMap(p=>[p.on,p.off])]);
  for(let k=1;k<40;k++) times.add(T*k/40);
  const frames = [], last = {};
  for (const at of [...times].sort((x,y)=>x-y)) {
    const s = at/T;
    const sep = a + (moving ? b-a : 0)*s*s*(3-2*s);
    const pulse = pulses.find(p => p.on <= at && at < p.off);
    const state = {}, events = [], frame = frames.length;
    function set(id,value,dependencies) {
      state[id]=value;
      const eventId=frame+"/"+id;
      events.push({id:eventId,part:id,before:frames.at(-1)?.state[id] ?? null,after:value,
        causes:[...(last[id] ? [last[id]] : []),...dependencies.map(d=>last[d])]});
      last[id]=eventId;
    }
    set("awg",{requestedSeparationUm:sep},[]);
    set("aod",{spotSeparationUm:state.awg.requestedSeparationUm},["awg"]);
    set("atom0",{yUm:-state.aod.spotSeparationUm/2},["aod"]);
    set("atom1",{yUm:state.aod.spotSeparationUm/2},["aod"]);
    set("raman",{axis:pulse?.axis ?? "off"},[]);
    frames.push({at,label:pulse ? "Protect the phase · "+pulse.axis+" pulse" : "Transport interval",state,events});
  }
  return {machine:{...transportMachine,transportSpanUm:Math.max(a,moving?b:a),displayUmPerUnit:Math.max(14,a/8,b/8)},frames};
}
