// Small executable teaching fixtures. Each instruction commits named port values in
// dependency order. Positions are schematic display units. Times and signal units are
// explicit on the machine. The same interpreter is used by the lesson and headless run.
function instrument(name, unit, ports, calibration) {
  const parts = ports.map(([id, kind, signalUnit], i) => ({
    id, kind, signalUnit, position: [-5 + (i % 5) * 2.4, 0, Math.floor(i/5)*3 + (i % 2)*0.7]
  }));
  const frames = [], last = new Map();
  function step(at, label, execute) {
    const previous = frames.at(-1)?.state ?? {};
    const state = {...previous}, events = [];
    function write(part, value, dependencies = []) {
      const id = frames.length + "/" + part;
      const causes = [...new Set(dependencies.map(source => last.get(source)).filter(Boolean))];
      events.push({id, part, before: previous[part] ?? null, after: value, causes});
      state[part] = value;
      last.set(part, id);
      return value;
    }
    execute(write, previous);
    frames.push({at, label, state, events});
  }
  return {step, result: {machine: {name, unit, parts, calibration,geometry:"Schematic display units"}, frames}};
}

export function tone(program) {
  const {increment, envelope} = program;
  if (![1,2,4].includes(increment) || !["flat","burst","mute"].includes(envelope)) throw Error("Choose a supported phase step and envelope.");
  const bench = instrument("16-position digital tone generator", "ns", [
    ["increment","Frequency control word","positions/tick"], ["phase","Four-bit phase register","positions"],
    ["carrier","Sine lookup output","normalized"], ["envelope","Waveform memory output","normalized"],
    ["product","Digital multiplier output","normalized"]
  ],{samplePeriodNs:62.5,phasePositions:16,lookup:"ideal sine",amplitudeUnit:"normalized"});
  for (let i=0; i<17; i++) bench.step(i*62.5, "Sample " + i, (write, previous) => {
    const k = write("increment",increment);
    const phase = write("phase", i ? (previous.phase+k)%16 : 0, i ? ["phase","increment"] : []);
    const carrier = write("carrier", Math.sin(phase*Math.PI/8), ["phase"]);
    const gain = write("envelope", envelope==="flat" ? 1 : Number(envelope==="burst" && i>=4 && i<12));
    write("product", carrier*gain, ["carrier","envelope"]);
  });
  return bench.result;
}

export function receiver({gain, bits, threshold, wait}) {
  if (![0.5,1,2].includes(gain) || ![2,4,8].includes(bits) || ![-0.5,0,0.5].includes(threshold) || ![1,3,8].includes(wait))
    throw Error("Invalid receiver setting.");
  const bench = instrument("Pulsed readout receiver", "ns", [
    ["preparation","Prepared state","bit"],["drive","Probe envelope","normalized"], ["field","Returned quadrature","V"],
    ["adc","Signed converter output","codes"], ["average","Window average","V"], ["bit","Discriminator output","bit"]
  ],{periodNs:10,retainedFieldFraction:0.5,steadyMagnitudeV:0.4*gain,
    inputRangeV:[-1,1],codeStepV:1/2**(bits-1),drivenSamples:4,thresholdV:threshold});
  // Two independently initialized preparations, with opposite quadrature response.
  // One-pole baseband response, half the remaining distance per 10 ns. Ideal ADC
  // spans [-1,1) V. Compare the mean of the four driven samples for each trial.
  const mid = 2**(bits-1);
  for (let trial=0;trial<2;trial++) {
    let total=0;
    for (let tick=0;tick<4+wait;tick++) {
      const driven=tick<4;
      bench.step(10*(trial*(4+wait)+tick), "Prepared " + trial + " · " + (driven ? "probe on" : "ring-down"), (write, previous) => {
        const prepared=write("preparation",trial),drive=write("drive", Number(driven));
        const old=tick ? previous.field : 0;
        const field=write("field", (old + drive*(prepared ? 1 : -1)*0.4*gain)/2, tick ? ["drive","preparation","field"] : ["drive","preparation"]);
        const code=write("adc",Math.max(-mid,Math.min(mid-1,Math.round(field*mid))),["field"]);
        if (driven) total+=code/mid;
        const average=write("average",total/Math.min(tick+1,4), driven ? (tick ? ["average","adc"] : ["adc"]) : ["average"]);
        write("bit",Number(average>=threshold),["average"]);
      });
    }
  }
  return bench.result;
}

export function counter({windowUs, threshold}) {
  if (![2,5,8].includes(windowUs) || ![1,2,4].includes(threshold)) throw Error("Invalid counting window or threshold.");
  const bench=instrument("Timed photon counter", "µs", [
    ["detector","Detector pulse","event"],["gate","Window enable","bit"],["count","Count register","photons"],["bright","Threshold decision","bit"]
  ],{arrivalTimesUs:[[1],[1,3,4,6]],openIntervalUs:[0,windowUs],closingEdge:"excluded",thresholdPhotons:threshold});
  const arrivals=[[1],[1,3,4,6]]; // Fixed illustrative timestamps for two independently prepared trials.
  for (const [trial,times] of arrivals.entries()) for(let t=0;t<=8;t++)
    bench.step(trial*10+t, (trial ? "Bright" : "Dark") + " preparation · " + t + " µs", (write,last) => {
      const pulse=write("detector",Number(times.includes(t)));
      const gate=write("gate",Number(t<windowUs));
      const n=write("count",(t ? last.count : 0)+pulse*gate,t ? ["count","detector","gate"] : ["detector","gate"]);
      write("bright",Number(n>=threshold),["count"]);
    });
  return bench.result;
}

export function fifo({release}) {
  if (![1,3,5].includes(release)) throw Error("Choose a receiver release cycle.");
  const slots=[0,0,0,0];
  const bench=instrument("Four-word synchronous queue", "cycle", [
    ["input","Offered word","word"],["ready","Receiver ready","bit"],
    ...slots.map((_,i)=>["slot"+i,"Storage word "+i,"word"]),
    ["read","Read pointer","address"],["write","Write pointer","address"],["used","Occupancy","words"],["output","Accepted output","word"]
  ],{depthWords:4,offeredWords:[1,2,3,4,5],emptyTransfer:0,fullPolicy:"Reject writes using pre-edge occupancy"});
  let read=0, writeIndex=0, used=0;
  for(let i=0;i<9;i++) bench.step(i,"Rising edge " + i,(write)=>{
    const word=write("input",i<5 ? i+1 : 0), ready=write("ready",Number(i>=release));
    const take=Boolean(ready && used), put=Boolean(word && used<4);
    const oldWord=slots[read], source="slot"+read;
    write("output", take ? oldWord : 0, ["ready","used","read",source]);
    for(let j=0;j<4;j++){
      const selected=put && j===writeIndex;
      if(selected) slots[j]=word;
      write("slot"+j,slots[j],selected ? ["input","write","used"] : ["slot"+j]);
    }
    read=write("read",(read+Number(take))%4,["read","used","ready"]);
    writeIndex=write("write",(writeIndex+Number(put))%4,["write","input","used"]);
    used=write("used",used+Number(put)-Number(take),["used","input","ready"]);
  });
  return bench.result;
}
