import * as T from "/three/three.module.js";
import {hardwareLayout,componentState,planY,references} from "./hardware-layout.mjs";

function legend(text){
  const canvas=document.createElement("canvas"),ctx=canvas.getContext("2d");
  ctx.font="600 40px sans-serif";
  canvas.width=Math.ceil(ctx.measureText(text).width)+22;canvas.height=58;
  ctx.font="600 40px sans-serif";ctx.fillStyle="#fafdfb";ctx.fillRect(0,0,canvas.width,58);
  ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillStyle="#263e47";ctx.fillText(text,canvas.width/2,30);
  const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;
  const sprite=new T.Sprite(new T.SpriteMaterial({map:texture,depthTest:false}));
  sprite.scale.set(canvas.width*0.35,20.3,1);sprite.renderOrder=2;return sprite;
}
function makeSolid(s,mat){
  if(s.type==="polygon"){
    const path=new T.Shape();s.points.forEach(([x,y],i)=>i?path.lineTo(x,-y):path.moveTo(x,-y));path.closePath();
    const geom=new T.ExtrudeGeometry(path,{depth:s.h,bevelEnabled:false});
    geom.rotateX(-Math.PI/2);
    const mesh=new T.Mesh(geom,mat);mesh.position.y=s.base;return mesh;
  }
  if(s.type==="line"){
    const line=new T.Group();
    for(let i=1;i<s.points.length;i++){
      const [x,y]=s.points[i-1],[u,v]=s.points[i],delta=new T.Vector3(u-x,0,v-y);
      const segment=new T.Mesh(new T.CylinderGeometry(s.r,s.r,delta.length(),7),mat);
      segment.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());
      segment.position.set((x+u)/2,s.base,(y+v)/2);line.add(segment);
    }
    return line;
  }
  const geom=s.type==="sphere"?new T.SphereGeometry(s.r,20,14):
    s.type==="lens"?new T.CylinderGeometry(s.r,s.r,s.h,36):
    s.type==="well"?new T.ConeGeometry(s.r,s.h,24):new T.CylinderGeometry(s.r,s.r,s.h,16);
  const mesh=new T.Mesh(geom,mat);
  mesh.position.set(s.x,s.type==="sphere"||s.type==="lens"?s.base:s.base+s.h/2,s.y);
  if(s.type==="well")mesh.rotation.x=Math.PI;
  if(s.type==="lens")mesh.rotation.z=Math.PI/2;
  return mesh;
}

export function drawHardwareScene(canvas,machine,pick){
  canvas.setAttribute("aria-label",references[machine.apparatus].title+" · native 3D control hardware");
  canvas.classList.add("native-hardware");
  const renderer=new T.WebGLRenderer({canvas,antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  const scene=new T.Scene();scene.background=new T.Color(0xf4f7f6);
  scene.add(new T.HemisphereLight(0xffffff,0xa1afb7,2.15));
  const sun=new T.DirectionalLight(0xfff7e6,2.1);sun.position.set(-120,400,210);scene.add(sun);
  const camera=new T.OrthographicCamera(-400,400,175,-175,1,2700);
  const model=new T.Group();scene.add(model);
  const selectable=[],drawables=[],movers=[],materials=new Map();
  let layout,current;
  function build(m){
    for(const child of model.children)child.traverse(obj=>{
      obj.geometry?.dispose();if(obj.isSprite){obj.material.map.dispose();obj.material.dispose();}
    });
    for(const entry of materials.values())entry.mat.dispose();
    materials.clear();model.clear();selectable.length=0;drawables.length=0;movers.length=0;
    current=m;layout=hardwareLayout(m);model.position.set(-layout.width/2,0,-layout.height/2);
    for(const s of layout.solids){
      const key=[s.color,s.owner,s.type==="well"].join("|");
      if(!materials.has(key)){
        const mat=new T.MeshStandardMaterial({color:s.color,roughness:0.64,metalness:0.18,
          transparent:s.type==="well",opacity:s.type==="well"?0.30:1,depthWrite:s.type!=="well"});
        materials.set(key,{owner:s.owner,mat,base:new T.Color(s.color)});
      }
      const obj=makeSolid(s,materials.get(key).mat);obj.name=s.key;model.add(obj);
      if(s.owner){obj.userData.part=s.owner;selectable.push(obj);}
      if(s.motion)movers.push({s,obj});
    }
    for(const label of layout.labels){
      const sprite=legend(label.text);sprite.position.set(label.x,17,label.y);model.add(sprite);
      if(label.owner){sprite.userData.part=label.owner;selectable.push(sprite);}
    }
    drawables.push(...materials.values());
  }
  let yaw=0.06,tilt=0.68,drag;
  function paint(){
    const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h||!layout)return;
    renderer.setSize(w,h,false);
    const aspect=w/h,ax=Math.abs(Math.cos(yaw)),az=Math.abs(Math.sin(yaw));
    const wide=ax*layout.width+az*layout.height,deep=az*layout.width+ax*layout.height;
    const half=Math.max(wide/2+10,(deep*Math.cos(tilt)/2+28)*aspect);
    camera.left=-half;camera.right=half;camera.top=half/aspect;camera.bottom=-camera.top;
    camera.position.set(820*Math.sin(yaw)*Math.sin(tilt),820*Math.cos(tilt),820*Math.cos(yaw)*Math.sin(tilt));
    camera.lookAt(0,0,0);camera.updateProjectionMatrix();renderer.render(scene,camera);
  }
  new ResizeObserver(paint).observe(canvas);
  canvas.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,yaw,tilt};canvas.setPointerCapture(e.pointerId);};
  canvas.onpointermove=e=>{if(drag){yaw=drag.yaw+(e.clientX-drag.x)/180;tilt=Math.max(0.02,Math.min(1.24,drag.tilt+(e.clientY-drag.y)/200));paint();}};
  canvas.onpointerup=e=>{
    if(drag&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5){
      const box=canvas.getBoundingClientRect(),ray=new T.Raycaster();
      ray.setFromCamera({x:(e.clientX-box.left)*2/box.width-1,y:1-(e.clientY-box.top)*2/box.height},camera);
      const hit=ray.intersectObjects(selectable,true)[0];let obj=hit?.object;
      while(obj&&!obj.userData.part)obj=obj.parent;
      if(obj)pick(obj.userData.part);
    }
    drag=null;
  };canvas.onpointercancel=()=>{drag=null;};
  const amber=new T.Color("#de983e"),teal=new T.Color("#20a294");
  return (frame,selected,m)=>{
    if(current!==m)build(m);
    const {active,chosen}=componentState(m,frame,selected);
    for(const entry of drawables){
      const {mat,owner,base}=entry;mat.color.copy(base);
      if(chosen.has(owner))mat.color.lerp(amber,.45);
      else if(active.has(owner))mat.color.lerp(teal,.58);
    }
    for(const {s,obj} of movers)obj.position.z=planY(s,frame);
    paint();
  };
}
