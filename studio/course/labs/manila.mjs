// Execute serial calls to the archived Qiskit pulse schedules in integer dt ticks.
// Concurrent instructions inside a schedule retain their original offsets.
export const manilaProgram = [
  {gate:"sx", qubits:[0]}, {gate:"cx", qubits:[0,1]},
  {gate:"measure", qubits:[0,1,2,3,4]}
];

// Qiskit's lifted Gaussian, sampled at the middle of each dt interval.
// The result is a normalized baseband envelope, before the analog line.
function gaussian(t, center, zero, sigma) {
  const g = x => Math.exp(-0.5 * ((x-center)/sigma) ** 2);
  return (g(t)-g(zero))/(1-g(zero));
}

export function sampleEnvelope(channel, tick) {
  const op = channel?.instruction;
  if (!op || !Number.isInteger(tick) || tick < 0 || tick >= channel.length) return null;
  let i, q;
  if (channel.samples) [i,q] = channel.samples[tick];
  else if (op.name === "parametric_pulse") {
    const {duration,sigma,width,beta,amp} = op.parameters;
    const t=tick+0.5, center=duration/2;
    let shape, derivative=0;
    if (op.pulse_shape === "drag") {
      shape=gaussian(t,center,duration+1,sigma);
      derivative=-beta*(t-center)*shape/(sigma*sigma);
    } else if (op.pulse_shape === "gaussian_square") {
      const left=center-width/2, right=center+width/2;
      shape=t<left ? gaussian(t,left,-1,sigma) : t>right ? gaussian(t,right,duration+1,sigma) : 1;
    } else throw Error("Unknown pulse shape "+op.pulse_shape);
    i=amp[0]*shape-amp[1]*derivative;
    q=amp[1]*shape+amp[0]*derivative;
  } else return null;
  const c=Math.cos(channel.phaseRad), s=Math.sin(channel.phaseRad);
  return [i*c-q*s,i*s+q*c];
}

export function runManila(program, {conf, defs, props}) {
  if (!Array.isArray(program) || !program.length || program.length > 64) throw Error("Enter 1–64 gate calls.");
  const parts = conf.coords.map(([x,z], i) => ({
    id:"q" + i, kind:"Transmon", position:[(x-3)*2, 0, z-2],
    calibration:props.qubits[i]
  }));
  for (const [id, ch] of Object.entries(conf.channels)) {
    const [a,b] = ch.operates.qubits;
    const x = b === undefined ? a : (a+b)/2;
    const z = {drive:-2,measure:2,acquire:3.5,control:a<b?-0.8:0.8}[ch.type];
    parts.push({id, kind:ch.purpose, position:[(x-2)*2,0.25,z], qubits:ch.operates.qubits});
  }
  const machine = {name:"IBM Quantum Manila", apparatus:"manila", unit:"dt", dtNs:conf.dt, parts};
  let start = 0, previousGate = [];
  const tasks = [];
  for (const [index, call] of program.entries()) {
    const schedule = defs.cmd_def.find(c => c.name === call?.gate && JSON.stringify(c.qubits) === JSON.stringify(call.qubits));
    if (!schedule) throw Error("Call " + (index+1) + " has no matching gate and ordered qubits in this archive.");
    const argCount = {rz:1,u1:1,u2:2,u3:3}[call.gate] ?? 0;
    const args = call.params ?? [];
    if (!Array.isArray(args) || args.length !== argCount || !args.every(Number.isFinite))
      throw Error(call.gate + " needs " + argCount + " finite phase arguments in radians.");
    const ends = [];
    let span = 0;
    for (const [n, op] of schedule.sequence.entries()) {
      const library = defs.pulse_library.find(p => p.name === op.name);
      const length = op.parameters?.duration ?? op.duration ?? library?.samples.length ?? 0;
      if (!length && op.name !== "fc") throw Error("Unrecognized pulse instruction " + op.name);
      const channels = op.ch ? [op.ch] : op.qubits.map(q => "acquire" + q);
      for (const ch of channels) {
        const prefix = index + "." + n + "/" + ch, id = prefix + "/start";
        const param = typeof op.phase === "string" ? /^-\(P([012])\)$/.exec(op.phase) : null;
        const phase = param ? -args[Number(param[1])] : op.phase;
        if (op.name === "fc" && !Number.isFinite(phase)) throw Error("Invalid frame change.");
        tasks.push({at:start+op.t0,index,n,id,ch,op,phase,length,samples:library?.samples,kind:"start",causes:previousGate, gate:call.gate});
        if (length) tasks.push({at:start+op.t0+length,index,n,id:prefix+"/end",ch,op,kind:"end",causes:[id],gate:call.gate});
        ends.push(length ? prefix+"/end" : id);
      }
      span = Math.max(span, op.t0 + length);
    }
    start += span;
    previousGate = ends;
  }
  // At a boundary retire an old drive first. Within a gate apply its same-tick
  // frame changes before opening envelopes. Between gates respect source order.
  const rank = t => t.kind === "end" ? 0 : t.op.name === "fc" ? 1 : 2;
  tasks.sort((a,b) => a.at-b.at || a.index-b.index || rank(a)-rank(b) || a.n-b.n);
  const frames = [], state = {}, latest = {};
  for (const t of tasks) {
    const before = state[t.ch] ?? {phaseRad:0, signal:"idle"};
    let after;
    if (t.kind === "end") after = {phaseRad:before.phaseRad,signal:"idle"};
    else if (t.op.name === "fc") after = {...before,phaseRad:before.phaseRad+t.phase};
    else after = {phaseRad:before.phaseRad,signal:t.op.label ?? t.op.name, instruction:t.op,
      startTick:t.at,length:t.length,...(t.samples ? {samples:t.samples} : {})};
    const causes = [...new Set([...t.causes, ...(latest[t.ch] ? [latest[t.ch]] : [])])];
    const event = {id:t.id,part:t.ch,before,after,causes};
    state[t.ch] = after;
    latest[t.ch] = t.id;
    let frame = frames.at(-1);
    if (frame?.at !== t.at) {
      frame = {at:t.at,label:"",events:[],state:{}};
      frames.push(frame);
    }
    frame.events.push(event);
    frame.label = "Call " + (t.index+1) + " · " + t.gate;
    frame.state = {...state};
  }
  return {machine, frames};
}
