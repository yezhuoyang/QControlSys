import {hardwareLayout,componentState,planY} from "./hardware-layout.mjs";

function svg(tag,attributes){
  const n=document.createElementNS("http://www.w3.org/2000/svg",tag);
  for(const [k,v] of Object.entries(attributes))n.setAttribute(k,v);
  return n;
}
export function hardwarePlan(machine,pick){
  const g=hardwareLayout(machine),root=svg("svg",{viewBox:"0 0 "+g.width+" "+g.height,role:"group","aria-label":"Native hardware plan"});
  const entries=[],printed=new Set();
  function bind(node,owner,key){
    if(!owner)return;
    node.dataset.part=owner;
    node.onclick=()=>pick(owner);
    if(!printed.has(owner)){
      node.setAttribute("role","button");node.setAttribute("tabindex","0");node.setAttribute("aria-label","Inspect "+owner);
      node.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();pick(owner);}};
      printed.add(owner);
    }
    const title=svg("title",{});title.textContent=owner+" · "+key;node.append(title);
  }
  for(const s of g.solids){
    const node=s.type==="polygon"?svg("polygon",{points:s.points.map(p=>p.join(",")).join(" "),fill:s.color}):
      s.type==="line"?svg("polyline",{points:s.points.map(p=>p.join(",")).join(" "),fill:"none",stroke:s.color,"stroke-width":s.r*2,"stroke-linejoin":"round"}):
      s.type==="lens"?svg("rect",{x:s.x-s.h/2,y:s.y-s.r,width:s.h,height:s.r*2,rx:2,fill:s.color}):
      svg("circle",{cx:s.x,cy:s.y,r:s.r,fill:s.color});
    bind(node,s.owner,s.key);root.append(node);entries.push({node,s});
  }
  for(const l of g.labels){
    const node=svg("text",{x:l.x,y:l.y,"text-anchor":"middle","dominant-baseline":"central",class:"hardware-label"});
    node.textContent=l.text;bind(node,l.owner,l.text);root.append(node);
  }
  return {element:root,update(frame,part){
    const {active,chosen}=componentState(machine,frame,part);
    for(const {node,s} of entries){
      if(s.motion)node.setAttribute("cy",planY(s,frame));
      if(s.owner){
        node.classList.toggle("hw-selected",chosen.has(s.owner));
        node.classList.toggle("hw-active",active.has(s.owner));
        if(node.hasAttribute("role"))node.setAttribute("aria-pressed",chosen.has(s.owner));
      }
    }
  }};
}
