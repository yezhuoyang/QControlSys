import {replay, programs} from "./replay.mjs";
import {tone,receiver,counter,fifo} from "./instruments.mjs";
import {runNative} from "./platform.mjs";

const setting=(id,label,choices)=>({id,label,choices});
const choice=(value,label)=>[value,label];
const yesNo=[choice(false,"Disconnected"),choice(true,"Connected")];
const options=(...items)=>items.map(item=>choice(item,String(item)));
const port=(id,label,read,meaning,unit)=>({id,label,read,meaning,unit});
const identity=v=>v;
const signal=(id,label,meaning)=>port(id,label,identity,meaning);
const valueOf=field=>v=>v?.[field]??null;
const voltage=v=>v?.received ? v.received[1]/1e6 : null;
const last=r=>r.frames.at(-1);
const rounded=n=>Number(n.toPrecision(5));
const result=(pass,reading,index)=>({pass:Boolean(pass),reading,index});
const at=(r,n)=>r.frames.findIndex(f=>f.at>=n);
const high=(r,id)=>r.frames.findIndex(f=>f.state[id]===1);
const graph=(ports,wires,boundary)=>({ports,wires,boundary});

export const circuits={
  waveform:graph([
    port("memory","Sample memory",v=>v?.emitted?.[1],"Stores signed words. Each address selects the next height in the waveform."),
    port("bus","Sample bus",v=>v?.emitted?.[1],"Carries the selected word to the converter after the transfer delay."),
    port("dac","Converter",v=>v?.emitted ? v.emitted[1]/1e6 : null,"Converts the signed word to volts. A positive half-scale word requests +0.5 V here.","V"),
    port("scope","Voltage probe",voltage,"Receives the voltage through the cable. An unwired probe has no receipt.","V")],
    [["memory","bus","sample word"],["bus","dac","16-bit payload"],["dac","scope","analog cable · V"]],
    "QuantumOS Machine Workbench executes these memory, bus and converter models. The 14-bit converter has a 1 V positive full-scale reference. Its output is ideal and the physical layout is schematic."),
  tone:graph([signal("increment","Phase step","Positions to advance on each sample tick."),signal("phase","Phase register","Counts around a ring of 16 positions. Watch the value wrap to zero."),
    signal("carrier","Carrier","The sine of the stored angle."),signal("envelope","Envelope","The multiplier’s second input sets the size of each sample."),signal("product","Mixer output","The product of the two inputs. Compare it with the carrier while the envelope is zero.")],
    [["increment","phase","positions per tick"],["phase","carrier","lookup address"],["carrier","product","signed carrier"],["envelope","product","gain"]],
    "Executable teaching circuit with an ideal four-bit phase accumulator and normalized samples at 16 MHz. The trace ends before analog upconversion."),
  receiver:graph([signal("drive","Probe switch","Opens for four samples per preparation."),signal("field","Returned field","One quadrature of the returning signal in volts. It builds and decays over time."),
    signal("adc","Sample code","A signed integer obtained by rounding the voltage onto the converter grid."),signal("average","Window average","Convert the codes back to volts and average the four driven samples."),signal("bit","Decision bit","One when the window average equals or exceeds the boundary.")],
    [["drive","field","probe envelope"],["field","adc","voltage"],["adc","average","signed codes"],["average","bit","mean · V"]],
    "Two synthetic preparations drive opposite quadratures. Every 10 ns the field travels halfway toward its driven value. This ideal one-pole receiver omits noise, resonator multiplexing and qubit dynamics."),
  counter:graph([signal("detector","Photon detector","A one marks a photon arrival at this time."),signal("gate","Window enable","Events at the closing time fall outside the window."),
    signal("count","Count register","Accumulates arrivals accepted while the window is open."),signal("bright","Bright decision","Compare the accumulated count with the threshold.")],
    [["detector","count","arrival pulse"],["gate","count","enable"],["count","bright","photons"]],
    "Fixed teaching input. Dark arrivals occur at 1 µs and bright arrivals at 1, 3, 4 and 6 µs relative to each preparation. Two example trials cannot estimate a laboratory error rate."),
  cell:graph([signal("bit1","Table bit 1","B=0 and A=1 selects this configuration bit."),signal("low","First selector","A selects between bit 0 and bit 1 on this branch."),
    signal("d","D input","B selects a branch. D can change while the stored output remains fixed."),signal("master","Master latch","Samples D while the clock is low."),signal("q","Q output","Receives the stored master value on the rising edge.")],
    [["bit1","low","pass switches"],["low","d","B selects branch"],["d","master","low clock"],["master","q","high clock"]],
    "QuantumOS executes ideal complementary transistor switches and storage nodes. The drawing shows one path through the lookup table. Propagation delay and metastability are outside this cell model."),
  fifo:graph([signal("input","Producer","Offers words 1 through 5 on successive cycles."),signal("slot0","Storage word 0","The first physical storage word. It can be reused after the write pointer wraps."),
    signal("used","Occupancy","Accepted writes add one and accepted reads remove one."),signal("ready","Receiver ready","The receiver may take a word when it is ready and the queue was nonempty at the edge."),signal("output","Accepted word","Zero denotes no transfer. A nonzero value is a word actually removed.")],
    [["input","slot0","write when addressed"],["input","used","accepted write"],["ready","used","accepted read"],["slot0","output","when read address = 0"],["ready","output","read enable"]],
    "Four register words and two modulo-four pointers update on rising edges. A full queue rejects a new write at that edge, even if it also reads. A producer offers each word once."),
  helios:graph([signal("a_increase","Grow from A","One request from endpoint A."),signal("b_increase","Grow from B","A second endpoint can issue its own growth request."),
    signal("is_fully_grown","Link full","The synthesized circuit announces when the link has accumulated its required growth."),signal("is_odd_cluster","Odd flag","The registered flag can update on a later rising edge.")],
    [["a_increase","is_fully_grown","through growth logic"],["b_increase","is_fully_grown","through growth logic"],["is_fully_grown","is_odd_cluster","enables cluster update"]],
    "Replay uses the synthesized gates of the published Helios neighbour link. The arrows summarize paths through those gates. Follow event inputs to inspect individual gates and clocked bits."),
  lukin:graph([port("awg","Waveform source",valueOf("requestedSeparationUm"),"The command specifies the separation between two moving spots.","µm"),
    port("aod","Deflectors",valueOf("spotSeparationUm"),"Two deflectors steer the focused spots. This model executes their commanded separation.","µm"),
    port("atom1","Upper atom",valueOf("yUm"),"One atom rides the upper spot. Double its distance from the centre to recover the pair separation.","µm"),
    port("raman","Raman beam",valueOf("axis"),"An independent beam applies X or Y pulses during transport. Off means the pulse is between edges.")],
    [["awg","aod","separation command"],["aod","atom1","spot position"]],
    "Bluvstein et al., Fig. 1. The replay samples an ideal cubic trajectory and the XY8 control schedule. Capture, loss and fidelity require separate observations."),
  manila:graph([port("d0","Drive line 0",valueOf("signal"),"A scheduled envelope on this line drives the first transmon."),port("m0","Probe line 0",valueOf("signal"),"A readout envelope starts on the outgoing measurement line."),
    port("acquire0","Acquisition 0",valueOf("signal"),"A timed acquisition window asks the digitizer to capture. Its presence establishes timing.")],
    [],"IBM Manila’s archived gate calls expand into native pulse instructions on separate channels. The channels share a schedule. Analog distortion and measured bit outcomes are outside this replay."),
  electrode:graph([port("dac","Converter pin",v=>v?.value===undefined ? null : v.value/1e6,"The SPI word sets the pin’s target. The model limits the rate of its voltage change."),
    port("filter","Output filter",v=>v?.value===undefined ? null : v.value/1e6,"Stored charge slows the connector response."),port("output","Connector probe",voltage,"The probe records voltage after the filter. The paper’s scope trace was taken at this end.")],
    [["dac","filter","pin voltage"],["filter","output","filtered voltage"]],"QuantumOS replays a Duke electrode-module reconstruction fitted to the published voltage step. The probe below reports the simulated connector voltage. The paper figure supplies the measured trace."),
  strobe:graph([port("fpga","FPGA pins",v=>v?.emitted?.join(" "),"Writes an address and data word, then changes the output strobe."),port("buffer","Bus buffer",v=>v?.emitted?.join(" "),"Transfers the pin levels to the converter interface with a modeled delay."),
    port("dac","DAC latch",v=>v?.value===undefined ? null : v.value/1e6,"A rising strobe latches the pending word at the matching address."),port("output","Output probe",voltage,"Receives only committed voltages. Check the first receipt to see which word latched.")],
    [["fpga","buffer","data and strobe"],["buffer","dac","addressed latch"],["dac","output","volts"]],
    "Uses the INO bus replay in Machine Workbench. Changing the first strobe modifies its executable control program. Waveform timings describe the model."),
  syndrome:graph([port("q1","First check",v=>v?.text,"The controller for the first neighbouring pair produces the first syndrome bit."),
    port("q3","Second check",v=>v?.text,"The other pair supplies the second bit."),port("decoder","Decoder core",v=>v?.text,"Firmware reads the checks and stores three correction bits. Inspect its stores to the host.")],
    [["q1","decoder","s0"],["q3","decoder","s1"]],"Runs the actual RISC-Q repetition program with chosen measurement bits. The single-error assumption lets two checks locate one of three data bits."),
};
const observationGraph=(quantity,unit)=>graph([
  port("drive","Delivered drive",v=>v?.samples,"The validation replay reconstructs the drive from executed converter strobes."),
  port("endpoint","Device prediction",valueOf("predicted"),"The calibrated response model maps that drive to "+quantity+".",unit),
  port("readout","Measurement",valueOf("observed"),"Compare the archived observation with the response model in "+unit+".",unit)],
  [["drive","endpoint","calibrated response"],["endpoint","readout","prediction vs observation"]],
  "QuantumOS Validation executes the archived case and compares with a held-out observation. Analysis steps are ordered after the timed controller events. The lesson’s acceptance criterion is a practice target.");
circuits.h2=observationGraph("parity","parity units");
circuits.spot=observationGraph("spot position","µm");
circuits.rabi=observationGraph("receiver cross-power","archived cross-power units");

const activities={};
function activity(id,engine,title,task,fields,build,judge,hint,focus) {
  activities[id]={id,engine,title,task,fields,build,judge,hint,focus};
}
const received=(r,id)=>r.frames.flatMap((f,i)=>f.events.filter(e=>e.part===id && e.after.received).map(e=>({v:e.after.received[1]/1e6,i})));
const words={id:"word",label:"Peak memory word (signed 16-bit)",type:"integer",initial:8192,min:-32768,max:32767};
const cable=setting("connected","Cable from DAC output to scope input",yesNo);
const shapes=setting("shape","Five stored heights",[choice("flat","Square pulse"),choice("hill","Stepped hill"),choice("custom","Write individual memory words")]);
const memoryWords=Array.from({length:5},(_,i)=>({id:"sample"+i,label:"Address "+i,type:"integer",initial:0,min:-32768,max:32767,when:{shape:"custom"}}));
activity("S1","waveform","Wire a converter to a scope","Connect the voltage probe and produce a peak of +0.5 V. Start with the cable unplugged. Where does the number stop being a number?",[words,cable],v=>({...v,shape:"hill"}),r=>{
  const s=received(r,"scope"), peak=s.reduce((a,b)=>a.v>b.v?a:b,{v:-Infinity,i:0});
  return result(peak.v===0.5,s.length?"Probe peak "+peak.v+" V across "+s.length+" receipts":"No voltage receipts at the probe",s.length?peak.i:r.frames.findIndex(f=>f.events[0].part==="dac"));
},"Inspect the converter before the probe. If the cable is connected, compare the memory word with half of 32768.","scope");
activity("S8","waveform","Program a five-sample hill","Make the probe receive five voltages in order: 0, 0.25, 0.5, 0.25, 0 V. Try a preset, then write your own five words into memory.",[shapes,{...words,unless:{shape:"custom"}},...memoryWords],
  v=>({word:v.word,shape:v.shape,connected:true,...(v.shape==="custom"?{samples:memoryWords.map(f=>v[f.id])}:{})}),r=>{
  const s=received(r,"scope");return result(s.map(x=>x.v).join()==="0,0.25,0.5,0.25,0","Probe samples ["+s.map(x=>x.v).join(", ")+"] V",s[1]?.i??0);
},"Choose the shape in memory first. Then set its peak using the signed word.","scope");
const increment=setting("increment","Phase increment",options(1,2,4));
const envelope=setting("envelope","Envelope program",[choice("flat","Always on"),choice("burst","Open samples 4–11"),choice("mute","Always zero")]);
activity("S2","tone","Build a 4 MHz carrier","At 16 million samples per second, make the phase register complete a turn every four samples. Inspect the register just as it wraps.",[increment],v=>({...v,envelope:"flat"}),r=>{
  const i=r.frames.findIndex((f,i)=>i>0 && f.state.phase===0);return result(i===4,"First wrap after "+i+" samples · "+16/i+" MHz",i);
},"Count the positions around the ring and compare the phase at two consecutive samples.","phase");
activity("S3","tone","Gate a continuous carrier","Keep the phase advancing while silencing the output outside samples 4–11. Deliver a nonzero burst inside the window.",[envelope,increment],v=>v,r=>{
  const samples=r.frames.map(f=>Math.abs(f.state.product)>1e-8);
  const outside=samples.filter((v,i)=>v && (i<4||i>=12)).length, inside=samples.slice(4,12).filter(Boolean).length;
  return result(!outside&&inside>0,outside+" nonzero samples outside · "+inside+" inside",13);
},"Probe the two multiplier inputs separately. A muted output can still have a running carrier.","product");
const rx={gain:1,bits:4,threshold:0,wait:3};
const receiverBuild=v=>({...rx,...v});
activity("R4","receiver","Wait for the resonator to empty","Turn off the probe after four samples. Allow enough idle time for the remaining field to fall below 0.01 V before the next preparation.",[setting("wait","Idle samples after drive",options(1,3,8))],receiverBuild,r=>{
  const i=r.frames.length/2-1, v=Math.abs(r.frames[i].state.field);return result(v<0.01,"Residual field "+rounded(v)+" V at "+r.frames[i].at+" ns",i);
},"Select the returned field. Compare successive samples after the probe switch goes low.","field");
activity("R1","receiver","Resolve a small returning voltage","Choose the sampling resolution so the final driven sample of the bright preparation can be reconstructed within 0.01 V. The input range runs from −1 V to just below +1 V.",[setting("bits","Signed converter width",options(2,4,8))],receiverBuild,(r,p)=>{
  const i=r.frames.length/2+3,{adc,field}=r.frames[i].state,recovered=adc/2**(p.bits-1);
  return result(Math.abs(recovered-field)<0.01,"Code "+adc+" reconstructs "+rounded(recovered)+" V · input "+rounded(field)+" V",i);
},"A wider word gives more voltage levels in the same range. Compare the code with the field at the same instant.","adc");
activity("R2","receiver","Calibrate the decision boundary","Classify a prepared zero and a prepared one using one boundary. Each decision integrates four samples. Which preparation does a poor threshold mislabel?",[setting("threshold","Decision boundary (V)",options(-0.5,0,0.5))],receiverBuild,r=>{
  const i=r.frames.length/2+3, a=r.frames[3].state,b=r.frames[i].state;
  return result(a.bit===0 && b.bit===1,"Prepared 0 → "+a.bit+" at "+a.average+" V · prepared 1 → "+b.bit+" at "+b.average+" V",a.bit!==0?3:i);
},"Place the boundary between the two measured averages.","bit");
activity("R3","counter","Build a gated photon counter","Assign the dark trial to zero and the bright trial to one. Use a window that captures enough bright arrivals without treating the dark trial’s single arrival as bright.",
 [setting("windowUs","Open window (µs)",options(2,5,8)),setting("threshold","Minimum bright count",options(1,2,4))],v=>v,r=>{
  const a=r.frames[8].state,b=last(r).state;return result(!a.bright && b.bright,"Dark "+a.count+" → "+a.bright+" · bright "+b.count+" → "+b.bright,17);
},"Count the accepted arrivals first, then choose a boundary strictly above the dark count.","count");
activity("F6","fifo","Keep every offered command","The producer offers words 1–5 once each. Start the receiver early enough to deliver all five in order. Watch what happens when the fifth word arrives at a full queue.",
 [setting("release","Receiver becomes ready on cycle",options(5,3,1))],v=>v,r=>{
  const output=r.frames.map(f=>f.state.output).filter(Boolean);return result(output.join()==="1,2,3,4,5","Accepted output ["+output.join(", ")+"]",4);
},"Compare the occupancy just before the fifth edge with the four physical slots.","used");

const inputVectors=["00","01","10","11"].flatMap(bits=>["0"+bits,"1"+bits,"0"+bits]);
const binary=options(0,1);
activity("F1","cell","Wire a two-input AND table","Set the four configuration bits. Only input 11 should raise D. Run all four addresses and inspect the path through the pass switches.",
  [0,1,2,3].map(i=>setting("bit"+i,"Entry for BA = "+i.toString(2).padStart(2,"0"),binary)),
  v=>({lut:[v.bit0,v.bit1,v.bit2,v.bit3].join(""),pins:inputVectors}),r=>{
    const out=[0,3,6,9].map(i=>r.frames[i].state.d);const mismatch=out.findIndex((b,i)=>b!==Number(i===3));
    return result(mismatch<0,"D at addresses 00, 01, 10, 11 → "+out.join(", "),mismatch<0?9:mismatch*3);
  },"Trace the selected table entry for the failing address. A high table bit drives a high D for that row.","d");
const edge=setting("edge","Clock sequence",[choice(false,"Hold low"),choice(true,"Low → high")]);
activity("F2","cell","Capture a bit and hold it","Drive A high while the clock is low, capture a one, then return A to zero. At the end D must be zero and Q must still remember one.",[edge],
  v=>({lut:"0101",pins:v.edge?["000","001","101","100"]:["000","001","001","000"]}),r=>{
    const s=last(r).state;return result(s.d===0&&s.q===1,"Final D = "+s.d+" · master = "+s.master+" · Q = "+s.q,3);
  },"Look at the master latch one step before the rising edge. Then change data while the clock stays high.","q");
activity("F5","cell","Separate launch from capture","Place the data change before the rising edge so the receiving register samples a one. Compare Q on the edge with D one step earlier.",
  [setting("timing","When A changes",[choice("late","After the rising edge"),choice("early","While the clock is low")])],
  v=>({lut:"0101",pins:v.timing==="late"?["000","000","100","101"]:["000","001","101","101"]}),r=>{
    const s=r.frames[2].state;return result(s.q===1,"D before edge = "+r.frames[1].state.d+" · Q on edge = "+s.q,2);
  },"Clocks align the sampling instant. The selected data must already be present in the low phase.","master");
activity("F3","cell","Test a Verilog parameter","Choose the TABLE literal for an LED that lights when exactly one of A and B is high. The testbench drives all four combinations and checks Q after each rising edge.",
  [{id:"literal",label:"TABLE in 4'b____ (bits 3 to 0)",type:"bits",initial:"1000"}],
  v=>({lut:[...v.literal].reverse().join(""),pins:inputVectors}),r=>{
    const seen=[1,4,7,10].map(i=>r.frames[i].state.q),expected=[0,1,1,0],i=seen.findIndex((v,i)=>v!==expected[i]);
    return result(i===-1,"Captured LED values "+seen.join(", ")+" · expected "+expected.join(", "),i<0?7:i*3+1);
  },"The rightmost Verilog digit is table entry zero. Inspect the capture for the first mismatching input.","q");
const grow=setting("second","Growth request on cycle 3",[choice(0,"No request"),choice(1,"B requests growth")]);
const link=v=>[{reset:1},{a_increase:1},{b_increase:v.second,a_is_odd_cluster:1},{a_is_odd_cluster:1}];
activity("K2","helios","Grow a link from both ends","Supply enough growth requests for the link to announce that it is full by cycle 3. Probe each endpoint before the clock rises.",[grow],link,r=>{
  const i=5;return result(r.frames[i].state.is_fully_grown===1,"Full flag after cycle 3 = "+r.frames[i].state.is_fully_grown,i);
},"One request from A leaves the link partly grown. Check what B drives on the next low phase.","is_fully_grown");
activity("K3","helios","Pass an odd-cluster flag","Build a link that reaches full growth and forwards the odd flag on a later edge. Compare the first edge with full=1 to the first edge with odd=1.",
  [grow,setting("odd","A declares an odd cluster",binary)],v=>[...link(v).slice(0,2),{b_increase:v.second,a_is_odd_cluster:v.odd},{a_is_odd_cluster:v.odd}],r=>{
    const a=high(r,"is_fully_grown"),b=high(r,"is_odd_cluster");
    return result(a>=0&&b>a,"First full phase "+(a<0?"never":a)+" · first odd phase "+(b<0?"never":b),b<0?7:b);
  },"Follow the clocked input to the odd flag. The link must first be full and its neighbour must report an odd cluster.","is_odd_cluster");
activity("K1","syndrome","Program a two-check test vector","Inject the two neighbouring parity outcomes that request correction of the middle data qubit. Watch the decoder core publish its decision.",
  [setting("bits","First and second check",options("00","10","01","11"))],v=>v,r=>{
    const b=r.bits,i=r.frames.findIndex(f=>f.label==="host"&&f.events[0].part==="decoder"&&f.events[0].after.offset===4);
    return result(b.e1===1,"Checks "+b.s0+b.s1+" · correction bits "+[b.e0,b.e1,b.e2].join(" "),i);
  },"A flip in the middle changes both neighbour comparisons. Look at the decoder’s store to offset 4.","decoder");

const measure=setting("readout","Final instruction",[choice(false,"End after drive"),choice(true,"Measure qubit 0")]);
const gates=setting("gate","First native instruction",[choice("rz","Change frame by π/2"),choice("sx","Quarter-turn pulse (√X)"),choice("x","Half-turn pulse (X)")]);
const gateCall=gate=>({gate,qubits:[0],...(gate==="rz"?{params:[Math.PI/2]}:{})});
const acquisition=r=>r.frames.findIndex(f=>f.state.acquire0?.instruction);
activity("P1","manila","Ask the chip for a result","Start by driving qubit 0. Add the operation that opens an acquisition window, then find the outgoing probe and the receiver in the same step.",[measure],
  v=>[gateCall("sx"),...(v.readout?[gateCall("measure")]:[])],r=>{
    const i=acquisition(r);return result(i>=0,i<0?"Drive finished without an acquisition window":"Acquisition starts at "+r.frames[i].at+" dt and spans "+r.frames[i].state.acquire0.length+" dt",i<0?0:i);
  },"A drive changes the control field. Measurement schedules both an outgoing probe and a timed input window.","acquire0");
activity("P3","manila","Turn a gate call into a drive pulse","Schedule a square root of X on qubit 0 and inspect the drive envelope’s duration. Try the virtual phase change first and see which channel state changes.",
  [gates],v=>[gateCall(v.gate)],r=>{
    const f=r.frames[0],s=f.state.d0;return result(f.label.endsWith("· sx")&&Boolean(s?.length),"Drive "+(s?.signal??"idle")+" · length "+(s?.length??0)+" dt · phase "+rounded(s?.phaseRad??0)+" rad",0);
  },"A virtual Z changes the phase used for future pulses. Select √X to emit the archived half-angle X rotation.","d0");
activity("M1","manila","Assemble the Manila measurement schedule","Build a √X drive, a controlled X on neighbours 0 and 1, then acquire qubit 0. Check the order against the archived schedule boundaries.",
  [setting("pair","Insert the neighbour gate",[choice(false,"Skip controlled X"),choice(true,"CX 0 → 1")]),measure],
  v=>[gateCall("sx"),...(v.pair?[{gate:"cx",qubits:[0,1]}]:[]),...(v.readout?[gateCall("measure")]:[])],r=>{
    const i=acquisition(r), pair=r.frames.findIndex(f=>f.label.endsWith("· cx"));
    return result(pair>=0&&i>pair,"Controlled X "+(pair<0?"absent":"at "+r.frames[pair].at+" dt")+" · acquisition "+(i<0?"absent":"at "+r.frames[i].at+" dt"),Math.max(i,pair,0));
  },"The first call drives one transmon. The middle call consumes time on the calibrated pair before the measurement starts.","acquire0");
const moving=setting("moving","Moving traps",[choice(false,"Remain stationary"),choice(true,"Play transport ramp")]);
const spacing=setting("finalSeparationUm","Requested final separation (µm)",options(55,110));
const duration=setting("durationUs","Transport duration (µs)",options(150,300));
const transport=v=>({...programs.lukin,...v});
const separation=f=>f.state.atom1.yUm-f.state.atom0.yUm;
activity("P2","lukin","Carry the pair apart","Move the atoms from 3 µm to 110 µm apart. Compare the deflector command with the atom coordinates halfway through the journey.",[moving,spacing],transport,r=>{
  const sep=separation(last(r)),i=at(r,last(r).at/2);return result(sep===110,"Midpoint separation "+separation(r.frames[i])+" µm · final "+sep+" µm",i);
},"A requested endpoint only changes the two trajectories when the moving traps execute the ramp.","aod");
activity("S6","lukin","Time the Raman light","Place the first X pulse across 18.75 µs while the traps carry the pair. Change the transport duration and inspect the independent beam schedule.",[duration],transport,r=>{
  const i=r.frames.findIndex(f=>f.state.raman.axis==="X"),start=r.frames[i].at,end=r.frames[i+1].at;
  return result(start<=18.75&&end>18.75,"First X interval ["+start+", "+end+") µs",i);
},"The eight pulse centres are evenly spaced. The first is at one sixteenth of the transport duration.","raman");
activity("S7","lukin","Place a moving tweezer","Place the upper tweezer at +27.5 µm at the end of the move. Its partner moves symmetrically below the centre. Read the position of one atom, then check the spot separation.",
  [moving,spacing],transport,r=>{const f=last(r),v=f.state.atom1.yUm;return result(v===27.5,"Upper atom "+v+" µm · spot separation "+f.state.aod.spotSeparationUm+" µm",r.frames.length-1);},
  "The command sets the distance between the two spots. Each atom travels half that distance from the centre at the endpoint.","atom1");
activity("M2","lukin","Rebuild the published transport interval","Recreate the 300 µs motion from 3 to 110 µm and count the eight Raman pulses. Then use the measured parity plot below to investigate coherence.",
  [moving,spacing,duration],transport,r=>{
    const sep=separation(last(r)),time=last(r).at, pulses=r.frames.filter(f=>f.events.some(e=>e.part==="raman" && e.after.axis!=="off" && e.before?.axis!==e.after.axis)).length;
    return result(sep===110&&time===300&&pulses===8,"Final separation "+sep+" µm · "+time+" µs · "+pulses+" pulses",r.frames.length-1);
  },"Reproducing the trajectory checks motion and timing. The archived parity observations give a separate test of the transported state.","atom1");

activity("F4","strobe","Latch the first INO bus word","The first word is 10922. Make its addressed converter latch the word, then find the first +3.33 V receipt at the probe.",
  [setting("pulse","First strobe",[choice(false,"Hold low"),choice(true,"Send rising edge")])],v=>v,r=>{
    const s=received(r,"output"),first=s[0];return result(Math.abs(first.v-3.33)<0.01,"First receipt "+rounded(first.v)+" V at "+rounded(r.frames[first.i].at)+" ns · "+s.length+" receipts",first.i);
  },"Data can be present on the pins for a long time. Follow the DAC’s input to find the separate latch edge.","output");
activity("S5","electrode","Follow an electrode voltage step","Choose the waveform that settles above +9 V at the connector. Compare the converter pin with the filtered output as the voltage crosses zero.",
  [setting("direction","Electrode transition",[choice("falling","Positive to negative"),choice("rising","Negative to positive")])],v=>v,r=>{
    const samples=received(r,"output"),end=samples.at(-1);
    const crossing=samples.find((s,i)=>i && (samples[i-1].v<0&&s.v>=0 || samples[i-1].v>0&&s.v<=0));
    return result(end.v>9,"Final connector "+rounded(end.v)+" V · crossing at "+rounded(r.frames[crossing?.i??end.i].at/1000)+" µs",crossing?.i??end.i);
  },"Use the later crossing between the two rails. The output filter adds a lag between pin and connector.","output");
function comparison(r,pass,unit) {
  const {predicted,observed}=r.comparison;
  return result(pass(predicted,observed),"Model "+rounded(predicted)+" · observed "+rounded(observed)+" · difference "+rounded(predicted-observed)+" "+unit,r.frames.length-1);
}
activity("S4","spot","Aim at the 5.65 µm site","Select a drive frequency from the Durham experiment. Land within 0.2 µm of the 5.65 µm site in both the model and the held-out position measurement.",
  [setting("observation","Deflector drive",[choice("durham-fig4a-row-1","135 MHz"),choice("durham-fig4a-row-3","155 MHz"),choice("durham-fig4a-row-5","175 MHz")])],v=>v,
  r=>comparison(r,(p,m)=>Math.abs(p-5.65)<0.2&&Math.abs(m-5.65)<0.2,"µm"),"Compare the measured positions as you step up the drive frequency. Inspect the delivered drive before checking the endpoint.","readout");
activity("P4","rabi","Test a prediction against a held-out signal","Replay the Labranca cross-power measurement at a drive setting withheld from calibration. Predict whether the model overestimates or underestimates the observation, then inspect the difference.",
  [setting("observation","Held-out drive setting",[choice("labranca-fig6c-column-01","Column 1 · 7.17 dB"),choice("labranca-fig6c-column-09","Column 9 · 8.65 dB")]),
   setting("sign","Your prediction",[choice(1,"Model is higher"),choice(-1,"Model is lower")])],v=>v,
  (r,p)=>comparison(r,(a,b)=>Math.sign(a-b)===p.sign,"cross-power units"),"Read model minus observation. A negative difference means the replay underestimates the recorded signal.","readout");
activity("M3","h2","Reproduce a positive H2 parity point","Select an archived analysis rotation for the 32-ion circuit. Find a held-out point with positive parity where the prediction agrees within 0.1 parity units.",
  [setting("observation","Final analysis phase",[choice("h2-ghz32-theta03","3π/32 rad"),choice("h2-ghz32-theta04","4π/32 rad"),choice("h2-ghz32-theta07","7π/32 rad")])],v=>v,
  r=>comparison(r,(p,m)=>m>0&&Math.abs(p-m)<0.1,"parity"),"Change the analysis phase while keeping the prepared state fixed. A sign change is visible in the measured even-minus-odd fraction.","readout");

export {activities};
export function settingsFor(id,params) {
  return Object.fromEntries(activities[id].fields.map(field=>{
    const raw=params?.get(field.id);
    let value=field.initial;
    if(field.type==="integer"){
      if(raw!=null){
        const n=Number(raw);
        if(!raw.trim() || !Number.isInteger(n)||n<field.min||n>field.max)throw Error(field.label+" must be an integer from "+field.min+" to "+field.max+".");
        value=n;
      }
    }else if(field.type==="bits"){
      if(raw!=null && !/^[01]{4}$/.test(raw))throw Error("Enter four binary digits for TABLE.");
      value=raw??field.initial;
    }else value=(field.choices.find(([v])=>raw===String(v))??field.choices[0])[0];
    return [field.id,value];
  }));
}
export async function executeActivity(id,settings,io) {
  const spec=activities[id], program=spec.build(settings);
  const local={tone,receiver,counter,fifo}[spec.engine];
  const run=local ? local(program) : Object.hasOwn(programs,spec.engine)
    ? await replay(spec.engine,program,io.json) : await runNative(spec.engine,program,io.request);
  const evaluation=spec.judge(run,program);
  if (!Number.isInteger(evaluation.index)||!run.frames[evaluation.index]) throw Error("Missing evaluation step.");
  return {run,program,evaluation};
}
