import * as THREE from "/three/three.module.js";
import {drawPublishedScene} from "./published-scene.js";

// All positions in this cutaway are schematic display coordinates. Each object
// carries the stable ID of the part in the executable machine.
export function drawScene(canvas, machine, pick) {
  if(!machine.apparatus)return drawControlScene(canvas,machine,pick);
  const published=drawPublishedScene(canvas,machine,pick);
  const other=document.createElement("canvas"),button=document.createElement("button");
  other.setAttribute("aria-label","Schematic control hardware");other.hidden=true;
  canvas.setAttribute("aria-label","Rotatable published apparatus with trace overlays");
  button.type="button";button.textContent="Show schematic control hardware";
  const note=document.createElement("p");note.className="src";
  note.textContent=machine.apparatus==="h2"?
    "The gold pairs mark the sites illustrated in Fig. 2d. Their height uses the 70 µm dimension in Fig. 2c and the 750 µm gate spacing. Bead size is enlarged.":
    "The published panel sets the floor plan. Overlay height and thickness are for display.";
  canvas.after(other,button,note);
  let cutaway,last;
  function paint(){if(last)(canvas.hidden?cutaway:published)(...last);}
  button.onclick=()=>{
    const showControl=other.hidden;
    if(showControl && !cutaway)cutaway=drawControlScene(other,machine,pick);
    canvas.hidden=showControl;other.hidden=!showControl;
    note.hidden=showControl;
    button.textContent=showControl?"Show published apparatus":"Show schematic control hardware";
    paint();
  };
  return (...args)=>{last=args;paint();};
}

function drawControlScene(canvas, machine, pick) {
  const renderer = new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf1f5f5);
  scene.add(new THREE.HemisphereLight(0xffffff,0x84919a,2.6));
  const light = new THREE.DirectionalLight(0xffffff,2.3);
  light.position.set(2,8,5);
  scene.add(light);
  const camera = new THREE.OrthographicCamera(-9,9,6,-6,0.1,100);
  const objects = new Map(), geo = new THREE.BoxGeometry(0.66,0.46,0.66);
  const atom = new THREE.SphereGeometry(0.14,18,12);
  const transistor = new THREE.BoxGeometry(0.46,0.28,0.58);
  const register = new THREE.BoxGeometry(0.44,0.52,0.44);
  const pin = new THREE.CylinderGeometry(0.18,0.18,0.34,12);
  const legGeometry=new THREE.BoxGeometry(0.22,0.13,0.09);
  const metal=new THREE.MeshStandardMaterial({color:0xc1c9cd,metalness:0.55,roughness:0.4});
  const glass=new THREE.MeshStandardMaterial({color:0x215b62,roughness:0.25});
  const gate = new THREE.BoxGeometry(0.43,0.26,0.43);
  const labels = new THREE.Group();
  scene.add(labels);
  function labelFor(part) {
    const bitmap = document.createElement("canvas");
    bitmap.width = 256; bitmap.height = 64;
    const ctx = bitmap.getContext("2d");
    ctx.font = "bold 38px sans-serif"; ctx.textAlign = "center";
    ctx.fillStyle = "#173443"; ctx.fillText(part.id,128,44);
    const texture = new THREE.CanvasTexture(bitmap);
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:false}));
    tag.scale.set(2.2,0.55,1);
    labels.add(tag);
    return tag;
  }
  for (const part of machine.parts) {
    let geometry=geo;
    if (part.kind === "Rubidium-87") geometry=atom;
    else if (part.kind.includes("MOS")) geometry=transistor;
    else if (part.kind === "Clocked bit" || part.kind === "Stored level") geometry=register;
    else if (part.kind.startsWith("Input ")) geometry=pin;
    else if (part.kind.endsWith(" gate")) geometry=gate;
    const obj = new THREE.Mesh(geometry,new THREE.MeshStandardMaterial());
    obj.position.fromArray(part.position);
    obj.userData.id=part.id;
    if(part.model==="probe"){
      const screen=new THREE.Mesh(new THREE.BoxGeometry(0.7,0.5,0.12),glass);
      obj.scale.set(1.45,1.4,1);screen.position.set(0,0.27,0.18);obj.add(screen);
    }else if(part.model || /register|converter|multiplier|memory|storage word|pointer/i.test(part.kind)){
      for(const side of [-1,1]) for(const offset of [-0.22,-0.07,0.07,0.22]){
        const leg=new THREE.Mesh(legGeometry,metal);
        leg.position.set(side*0.39,-0.1,offset);obj.add(leg);
      }
    }
    if (part.kind === "Transmon") {
      // Two capacitor pads joined across a narrow gap. Layout is schematic.
      obj.scale.set(0.5,0.35,1.3);
      const pad=new THREE.Mesh(geo,obj.material);
      pad.position.x=0.81;
      obj.add(pad);
    }
    if (part.kind === "Rubidium-87") {
      const lightWell=new THREE.Mesh(new THREE.ConeGeometry(0.25,1.45,20),
        new THREE.MeshBasicMaterial({color:0x2fa59c,transparent:true,opacity:0.23,depthWrite:false}));
      lightWell.rotation.z=Math.PI;
      lightWell.position.y=0.74;
      obj.add(lightWell);
    }
    if (!part.id.includes(".") && (machine.unit !== "dt" || part.kind === "Transmon") &&
        (machine.unit !== "phase" || ["clk","reset","is_fully_grown","is_odd_cluster"].includes(part.id)))
      obj.userData.tag = labelFor(part);
    objects.set(part.id,obj);
    scene.add(obj);
  }
  const grid = new THREE.GridHelper(17,17,0xa1b0bc,0xd1dadc);
  grid.position.y=-0.32;
  scene.add(grid);
  // Physical connectivity in the archive is discrete. The line lengths below
  // have no electrical-delay interpretation.
  for(const part of machine.parts.filter(p => p.qubits)) {
    for(const q of part.qubits) {
      const ends=[objects.get(part.id).position,objects.get("q"+q).position];
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ends),
        new THREE.LineBasicMaterial({color:0xa2b7b4})));
    }
  }
  // In the logic and optical cutaways even the wiring comes from the active
  // dependencies of the selected transition. Self-links represent prior state.
  const dependencies = new THREE.LineSegments(new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({color:0xc16722}));
  scene.add(dependencies);
  const wires=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0x65928e}));
  scene.add(wires);
  let wiredMachine;
  let angle=0.35, origin;
  function paint() {
    const w=canvas.clientWidth,h=canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w,h,false);
    const span=Math.max(5.7,8.6*h/w);
    camera.left=-span*w/h; camera.right=-camera.left;
    camera.top=span; camera.bottom=-span;
    camera.position.set(16*Math.sin(angle),14,16*Math.cos(angle));
    camera.lookAt(0,0,-0.7);
    camera.updateProjectionMatrix();
    renderer.render(scene,camera);
  }
  new ResizeObserver(paint).observe(canvas);
  canvas.onpointerdown=e=>{origin={x:e.clientX,angle};canvas.setPointerCapture(e.pointerId);};
  canvas.onpointermove=e=>{if(origin){angle=origin.angle+(e.clientX-origin.x)/120;paint();}};
  canvas.onpointerup=e=>{
    if(origin && Math.abs(e.clientX-origin.x)<5) {
      const box=canvas.getBoundingClientRect(), ray=new THREE.Raycaster();
      ray.setFromCamera({x:2*(e.clientX-box.left)/box.width-1,y:1-2*(e.clientY-box.top)/box.height},camera);
      const hit=ray.intersectObjects([...objects.values()])[0];
      if(hit){
        let root=hit.object;
        while(root && !root.userData.id)root=root.parent;
        if(root)pick(root.userData.id);
      }
    }
    origin=null;
  };
  canvas.onpointercancel=()=>{origin=null;};
  return (frame,selected,currentMachine,eventLocations)=>{
    if(wiredMachine!==currentMachine){
      const ends=[];
      for(const link of currentMachine.wires??[]){
        const a=objects.get(link.src.part),b=objects.get(link.dst.part);
        if(a && b)ends.push(a.position,b.position);
      }
      wires.geometry.dispose();wires.geometry=new THREE.BufferGeometry().setFromPoints(ends);
      wiredMachine=currentMachine;
    }
    const changed=new Set(frame.events.filter(e=>JSON.stringify(e.before)!==JSON.stringify(e.after)).map(e=>e.part));
    for(const [id,obj] of objects) {
      const value=frame.state[id];
      const active = machine.unit==="dt" ? value?.signal && value.signal!=="idle" : changed.has(id);
      obj.material.color.set(id===selected?0xdc762e:active?0x118579:0x93a2b5);
      if(value?.yUm!==undefined) obj.position.z=value.yUm/currentMachine.displayUmPerUnit;
      if (obj.userData.tag) {
        obj.userData.tag.position.copy(obj.position);
        obj.userData.tag.position.y += id === "atom0" ? 1.3 : 0.65;
      }
    }
    const points = [];
    for (const event of frame.events.filter(e => e.part === selected)) {
      for (const cause of event.causes) {
        const source = objects.get(eventLocations?.get(cause)?.event.part ?? cause.split("/")[1]);
        if (source && source !== objects.get(selected)) points.push(source.position, objects.get(selected).position);
      }
    }
    dependencies.geometry.dispose();
    dependencies.geometry = new THREE.BufferGeometry().setFromPoints(points);
    paint();
  };
}
