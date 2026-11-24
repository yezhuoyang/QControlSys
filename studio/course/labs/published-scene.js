import * as THREE from "/three/three.module.js";
import {layouts,apparatusMarkers} from "./published-layout.mjs";

// A registered source plane is the ground layer. Marker height and plate
// thickness are display geometry. The ground texture contains static artwork.
export function drawPublishedScene(canvas,machine,pick){
  const info=layouts[machine.apparatus],scale=14/info.width,depth=info.height*scale;
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  const scene=new THREE.Scene();scene.background=new THREE.Color(0xf0f5f5);
  const camera=new THREE.OrthographicCamera(-8,8,5,-5,0.1,80);
  const lights=new THREE.HemisphereLight(0xffffff,0xb6c5ce,2.5);scene.add(lights);
  const plate=new THREE.Mesh(new THREE.BoxGeometry(14,0.08,depth),new THREE.MeshStandardMaterial({color:0xe3efeb}));plate.position.y=-0.05;scene.add(plate);
  const paper=new THREE.Mesh(new THREE.PlaneGeometry(info.imageWidth*scale,depth),new THREE.MeshBasicMaterial({color:0xffffff}));
  paper.rotation.x=-Math.PI/2;paper.position.x=(info.imageWidth-info.width)*scale/2;scene.add(paper);
  const pickable=[],markers=new Map();
  if(machine.apparatus==="h2"){
    // Static pairs drawn in Fig. 2d. The 146-pixel gate pitch is 750 µm.
    // Fig. 2c supplies the 70 µm height perpendicular to the surface.
    const bead=new THREE.SphereGeometry(0.072,18,12);
    const gold=new THREE.MeshStandardMaterial({color:0xc69a37});
    for(const x of [423,435,569,582,716,729,861,875]){
      const ion=new THREE.Mesh(bead,gold);
      ion.position.set((x-info.width/2)*scale,70*146/750*scale,(302-info.height/2)*scale);
      ion.userData.part="endpoint";scene.add(ion);pickable.push(ion);
    }
  }
  const ink=new THREE.MeshBasicMaterial({color:0x14756a});
  const amber=new THREE.MeshBasicMaterial({color:0xde752a});
  const invisible=new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false});
  function loop(m){
    const path=new THREE.CurvePath();
    const r=m.r*scale,half=(m.w/2-m.r)*scale;
    const a=new THREE.Vector3(-half,0,-r),b=new THREE.Vector3(half,0,-r);
    const c=new THREE.Vector3(half,0,r),d=new THREE.Vector3(-half,0,r);
    path.add(new THREE.LineCurve3(a,b));
    const end=(cx,start)=>Array.from({length:33},(_,i)=>{
      const t=start+i*Math.PI/32;return new THREE.Vector3(cx+r*Math.cos(t),0,r*Math.sin(t));
    });
    for(const [i,points] of [end(half,-Math.PI/2),end(-half,Math.PI/2)].entries()){
      if(i)path.add(new THREE.LineCurve3(c,d));
      for(let j=1;j<points.length;j++)path.add(new THREE.LineCurve3(points[j-1],points[j]));
    }
    return new THREE.TubeGeometry(path,128,0.025,6,true);
  }
  function make(m){
    const group=new THREE.Group(),r=m.r*scale;
    const isTrack=m.shape==="track",isAtom=machine.apparatus==="lukin";
    const shape=isTrack ? loop(m) : isAtom ? new THREE.SphereGeometry(Math.max(0.11,r),20,12) : new THREE.TorusGeometry(r,0.045,10,48);
    const highlight=new THREE.Mesh(shape,ink);
    if(!isTrack&&!isAtom)highlight.rotation.x=-Math.PI/2;
    group.add(highlight);
    if(isAtom){
      const well=new THREE.Mesh(new THREE.ConeGeometry(0.22,0.6,20),new THREE.MeshBasicMaterial({
        color:0x48ad9f,transparent:true,opacity:0.23,depthWrite:false
      }));
      well.rotation.z=Math.PI;well.position.y=0.31;group.add(well);
    }
    const hit=new THREE.Mesh(isTrack?new THREE.BoxGeometry(m.w*scale,0.05,m.h*scale):new THREE.CylinderGeometry(r,r,0.1,28),invisible);
    hit.userData.part=m.id;group.add(hit);pickable.push(hit);scene.add(group);
    return {group,highlight,isAtom};
  }
  let angle=0,tilt=0.60,drag;
  function render(){
    const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
    renderer.setSize(w,h,false);
    const extent=Math.max(7.65, (7*Math.abs(Math.sin(angle))+depth/2*Math.abs(Math.cos(angle))+0.7)*w/h);
    camera.left=-extent;camera.right=extent;camera.top=extent*h/w;camera.bottom=-camera.top;
    camera.position.set(16*Math.sin(angle)*Math.sin(tilt),16*Math.cos(tilt),16*Math.cos(angle)*Math.sin(tilt));
    camera.lookAt(0,0,0);camera.updateProjectionMatrix();renderer.render(scene,camera);
  }
  new THREE.TextureLoader().load("/course/figures/"+info.file,texture=>{
    texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=renderer.capabilities.getMaxAnisotropy();
    paper.material.map=texture;paper.material.needsUpdate=true;render();
  });
  new ResizeObserver(render).observe(canvas);
  canvas.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,angle,tilt};canvas.setPointerCapture(e.pointerId);};
  canvas.onpointermove=e=>{if(drag){angle=drag.angle+(e.clientX-drag.x)/150;tilt=Math.max(0.02,Math.min(1.25,drag.tilt+(e.clientY-drag.y)/200));render();}};
  canvas.onpointerup=e=>{
    if(drag&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5){
      const b=canvas.getBoundingClientRect(),ray=new THREE.Raycaster();
      ray.setFromCamera({x:(e.clientX-b.left)*2/b.width-1,y:1-(e.clientY-b.top)*2/b.height},camera);
      const hit=ray.intersectObjects(pickable,false)[0];if(hit)pick(hit.object.userData.part);
    }
    drag=null;
  };
  canvas.onpointercancel=()=>{drag=null;};
  return (frame,selected,currentMachine)=>{
    for(const m of apparatusMarkers(currentMachine,frame,selected)){
      if(!markers.has(m.id))markers.set(m.id,make(m));
      const {group,highlight,isAtom}=markers.get(m.id);
      const x=m.shape==="track"?m.x+m.w/2:m.x,y=m.shape==="track"?m.y+m.h/2:m.y;
      group.position.set((x-info.width/2)*scale,isAtom?0.14:0.06,(y-info.height/2)*scale);
      highlight.material=m.selected?amber:ink;highlight.visible=isAtom||m.active||m.selected;
    }
    render();
  };
}
