// Replay the gates synthesized from the unmodified Helios neighbor_link.
// Every input row drives a low phase and a rising edge. Registers sample their
// D inputs simultaneously before the combinational graph settles again.
export const linkProgram = [
  {reset:1},
  {a_increase:1,a_old_root_in:3,b_old_root_in:9},
  {b_increase:1,a_is_odd_cluster:1},
  {a_is_odd_cluster:1},
  {initialize:1}
];

function logic(kind, inputs) {
  const {A,B,S} = inputs;
  switch (kind) {
    case "$_NOT_": return A==="X" ? "X" : 1-A;
    case "$_AND_": return A===0 || B===0 ? 0 : A===1 && B===1 ? 1 : "X";
    case "$_OR_": return A===1 || B===1 ? 1 : A===0 && B===0 ? 0 : "X";
    case "$_XOR_": return A==="X" || B==="X" ? "X" : A^B;
    case "$_MUX_": return S===0 ? A : S===1 ? B : A===B ? A : "X";
    default: throw Error("Unsupported synthesized gate "+kind);
  }
}

export function runLink(program, netlist) {
  const mod=netlist.modules.neighbor_link;
  const ports=Object.entries(mod.ports).filter(([,p])=>p.direction==="input");
  const names=new Map();
  for (const [name,net] of Object.entries(mod.netnames).filter(([,n])=>!n.hide_name))
    net.bits.forEach((bit,i)=>names.set(bit,net.bits.length===1 ? name : name+"["+i+"]"));
  const nameOf=bit=>names.get(bit) ?? "net"+bit;
  const nodes=new Map(), parts=[], cells=Object.values(mod.cells);
  const register = cell => cell.type==="$_DFF_P_";
  function add(bit,kind,group) {
    const index=parts.filter(p=>p.group===group).length;
    parts.push({id:nameOf(bit),kind,group,position:[-6+group*4.4+(index%5)*0.58,0, -5+Math.floor(index/5)*0.63]});
  }
  for (const [,p] of ports) for (const bit of p.bits) add(bit,"Input pin",0);
  for (const cell of cells) {
    const bit=(cell.connections.Q ?? cell.connections.Y)[0];
    nodes.set(bit,cell);
    add(bit,register(cell) ? "Clocked bit" : cell.type.slice(2,-1)+" gate",register(cell)?2:1);
  }
  const machine={name:"Helios neighbour link",unit:"phase",parts};
  if (!Array.isArray(program) || !program.length || program.length>64 || program[0]?.reset!==1)
    throw Error("Begin with a reset row and enter at most 64 cycles.");
  const allowed=new Map(ports.filter(([name])=>name!=="clk"));
  const frames=[];
  for(const [rowIndex,row] of program.entries()) {
    if (!row || typeof row!=="object" || Array.isArray(row)) throw Error("Each input row must be an object.");
    for (const [key,value] of Object.entries(row)) {
      const width=allowed.get(key)?.bits.length;
      if (!width || !Number.isInteger(value) || value<0 || value>=2**width)
        throw Error("Unknown input or out-of-range value at row "+(rowIndex+1)+": "+key);
    }
    for (const clk of [0,1]) {
      const index=frames.length, prev=frames.at(-1), state={}, events=[];
      const ref=(part,at=index)=>at+"/"+part;
      function set(bit,value,causes) {
        const part=nameOf(bit);
        state[part]=value;
        events.push({id:ref(part),part,before:prev?.state[part] ?? null,after:value,causes});
        return value;
      }
      for (const [name,p] of ports) {
        const value=name==="clk"?clk:row[name]??0;
        p.bits.forEach((bit,i)=>set(bit,(value>>i)&1,[]));
      }
      for (const [bit,cell] of nodes) if(register(cell)) {
        const src=nameOf(cell.connections.D[0]), id=nameOf(bit);
        if(clk) set(bit,prev.state[src],[ref(src,index-1),ref("clk")]);
        else set(bit,prev?.state[id]??"X",prev?[ref(id,index-1)]:[]);
      }
      function evaluate(bit) {
        if(typeof bit==="string") return Number(bit);
        if(Object.hasOwn(state,nameOf(bit))) return state[nameOf(bit)];
        const cell=nodes.get(bit), args={}, causes=[];
        for (const [port,[source]] of Object.entries(cell.connections)) {
          if(port==="Y") continue;
          args[port]=evaluate(source);
          if(typeof source==="number") causes.push(ref(nameOf(source)));
        }
        return set(bit,logic(cell.type,args),causes);
      }
      for(const bit of nodes.keys()) evaluate(bit);
      frames.push({at:index,label:"Cycle "+(rowIndex+1)+(clk?" · rising edge":" · drive inputs"),state,events});
    }
  }
  return {machine,frames};
}
