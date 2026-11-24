import {layouts,apparatusMarkers,apparatusReading} from "./published-layout.mjs";

const ns="http://www.w3.org/2000/svg";
function node(tag,attrs={}){
  const n=document.createElementNS(ns,tag);
  for(const [key,value] of Object.entries(attrs))n.setAttribute(key,value);
  return n;
}
function link(text,url){
  const a=document.createElement("a");a.textContent=text;a.href=url;return a;
}
function label(svg,x,y,text){
  const t=node("text",{x,y,"text-anchor":"middle"});t.textContent=text;svg.append(t);
}

export function publishedView(machine,pick){
  const info=layouts[machine.apparatus],figure=document.createElement("figure");
  figure.className="apparatus-figure";
  const heading=document.createElement("h4");heading.textContent=info.title;
  const svg=node("svg",{viewBox:"0 0 "+info.width+" "+info.height,role:"group","aria-label":info.title});
  svg.append(node("image",{href:"/course/figures/"+info.file,width:info.imageWidth,height:info.height}));
  if(machine.apparatus==="lukin"){
    svg.append(node("rect",{x:695,y:0,width:168,height:276,fill:"#eef6f4"}));
    label(svg,778,48,"Model pair");
    svg.append(node("path",{d:"M759 19h22 M770 19V259 M759 259h22",class:"model-axis"}));
  }
  const caption=document.createElement("figcaption"),reading=document.createElement("p"),note=document.createElement("p");
  reading.className="apparatus-reading";note.textContent=info.note;
  caption.append(reading,note,link(info.source,info.url)," · cropped panel · ",link("CC BY 4.0","https://creativecommons.org/licenses/by/4.0/"));
  figure.append(heading,svg,caption);
  if(machine.apparatus==="h2"){
    const controls=document.createElement("div"),explanation=document.createElement("p");
    controls.className="figure-controls";explanation.setAttribute("aria-live","polite");
    const region=node("g",{"pointer-events":"none","aria-hidden":"true"});svg.append(region);
    const landmarks=[
      ["Find the conveyor",[[39,119,149,198]],"Small repeated electrode segments steer the wells around the bend and onto the opposite straight."],
      ["Find the four gate zones",[429,576,722,867].map(x=>[x-26,275,52,52]),"At each highlighted site, laser paths cross a pair of ions. Several pairs can undergo gates in parallel."],
      ["Read the zone spacing",[[565,348,173,47]],"The dimension line gives 750 µm between neighbouring gate zones. This is a distance on the device."]
    ];
    for(const [name,areas,description] of landmarks){
      const b=document.createElement("button");b.type="button";b.textContent=name;b.setAttribute("aria-pressed","false");
      b.onclick=()=>{
        for(const item of controls.children)item.setAttribute("aria-pressed",String(item===b));
        region.replaceChildren(...areas.map(([x,y,width,height])=>node("rect",{x,y,width,height,rx:5,class:"paper-feature"})));
        explanation.textContent=description;
      };
      controls.append(b);
    }
    caption.prepend(controls,explanation);
  }
  const nodes=new Map();
  function update(frame,selected){
    for(const m of apparatusMarkers(machine,frame,selected)){
      let g=nodes.get(m.id);
      if(!g){
        g=node("g",{role:"button",tabindex:"0","data-machine-part":m.id,"aria-label":"Inspect "+m.label});
        const title=node("title");title.textContent="Inspect "+m.label;
        const shape=m.shape==="track"?"rect":"circle";
        // Broad transparent hit target keeps the paper visible beneath the rings.
        g.append(title,node(shape,{class:"target"}),node(shape,{class:"activity-ring"}),node(shape,{class:"selection-ring"}));
        g.onclick=()=>pick(m.id);
        g.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();pick(m.id);}};
        svg.append(g);nodes.set(m.id,g);
      }
      g.dataset.active=String(m.active);g.setAttribute("aria-pressed",String(m.selected));
      for(const [i,shape] of [...g.children].slice(1).entries()){
        const pad=i===2?(machine.apparatus==="manila"?11:3):0;
        const attrs=m.shape==="track"?{x:m.x-pad,y:m.y-pad,width:m.w+2*pad,height:m.h+2*pad,rx:m.r+pad}:
          {cx:m.x,cy:m.y,r:m.r+pad};
        for(const [key,value] of Object.entries(attrs))shape.setAttribute(key,value);
        if(machine.apparatus==="lukin" && i===0)shape.classList.add("model-atom");
      }
    }
    reading.textContent=apparatusReading(machine,frame,selected);
  }
  return {element:figure,update};
}
