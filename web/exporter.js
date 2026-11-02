const THREE_URL="https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js";
const enc=new TextEncoder();
function crc32(buf){let c=~0;for(const b of buf){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (~c)>>>0;}
function zipStore(files){
 const chunks=[],directory=[];let offset=0;
 const u16=(dv,off,v)=>dv.setUint16(off,v,true),u32=(dv,off,v)=>dv.setUint32(off,v>>>0,true);
 for(const [name,contents] of Object.entries(files)){
  const filename=enc.encode(name),data=typeof contents==="string"?enc.encode(contents):contents,crc=crc32(data);
  const local=new Uint8Array(30+filename.length),v=new DataView(local.buffer);
  u32(v,0,0x04034b50);u16(v,4,20);u16(v,6,0x800);u16(v,8,0);u32(v,14,crc);u32(v,18,data.length);u32(v,22,data.length);u16(v,26,filename.length);local.set(filename,30);
  chunks.push(local,data);
  const central=new Uint8Array(46+filename.length),d=new DataView(central.buffer);
  u32(d,0,0x02014b50);u16(d,4,20);u16(d,6,20);u16(d,8,0x800);u32(d,16,crc);u32(d,20,data.length);u32(d,24,data.length);u16(d,28,filename.length);u32(d,42,offset);central.set(filename,46);directory.push(central);offset+=local.length+data.length;
 }
 const centralSize=directory.reduce((n,c)=>n+c.length,0),end=new Uint8Array(22),d=new DataView(end.buffer);
 u32(d,0,0x06054b50);u16(d,8,directory.length);u16(d,10,directory.length);u32(d,12,centralSize);u32(d,16,offset);
 return new Blob([...chunks,...directory,end],{type:"application/zip"});
}
function configFor(s){
 const bytes=Uint8Array.from(s.depthPixels,n=>Math.round(n*255));
 let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return {image:s.sourceData,depth:btoa(binary),depthWidth:s.depthWidth,depthHeight:s.depthHeight,strength:s.strength,resolution:s.resolution};
}
async function standaloneViewer(cfg){
 const THREE=await import("https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js");
 const host=document.getElementById("scene");
 const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});
 renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.outputColorSpace=THREE.SRGBColorSpace;host.appendChild(renderer.domElement);
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(42,1,.01,100);camera.position.set(0,0,7);
 const img=new Image();img.src=cfg.image;await img.decode();
 const canvas=document.createElement("canvas");canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;canvas.getContext("2d").drawImage(img,0,0);
 const depth=Uint8Array.from(atob(cfg.depth),x=>x.charCodeAt(0));
 function sample(u,v) {
  const x=Math.max(0,Math.min(cfg.depthWidth-1,Math.round(u*(cfg.depthWidth-1))));
  const y=Math.max(0,Math.min(cfg.depthHeight-1,Math.round(v*(cfg.depthHeight-1))));
  return depth[y*cfg.depthWidth+x]/255;
 }
 const aspect=img.width/img.height,h=Math.min(3.8,5.25/aspect),w=h*aspect;
 const nx=cfg.resolution,ny=Math.max(32,Math.round(nx/aspect));
 const geo=new THREE.PlaneGeometry(w,h,nx,ny),p=geo.attributes.position;
 for(let y=0;y<=ny;y++)for(let x=0;x<=nx;x++){p.setZ(y*(nx+1)+x,(sample(x/nx,y/ny)-.5)*cfg.strength*1.7);}
 geo.computeVertexNormals();
 const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;
 const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({map:tex,side:THREE.DoubleSide}));scene.add(mesh);
 let yaw=0,pitch=0,zoom=1,drag=false,last=[0,0];
 host.addEventListener("pointerdown",e=>{drag=true;last=[e.clientX,e.clientY];host.setPointerCapture(e.pointerId)});
 host.addEventListener("pointerup",()=>drag=false);host.addEventListener("pointercancel",()=>drag=false);
 host.addEventListener("pointermove",e=>{if(!drag)return;yaw+=(e.clientX-last[0])*.006;pitch+=(e.clientY-last[1])*.006;last=[e.clientX,e.clientY]});
 host.addEventListener("wheel",e=>{e.preventDefault();zoom=Math.max(.6,Math.min(2.5,zoom*Math.exp(-e.deltaY*.001)));camera.position.z=7/zoom},{passive:false});
 document.getElementById("reset").onclick=()=>{yaw=0;pitch=0;zoom=1;camera.position.z=7;};
 document.getElementById("wire").onchange=e=>mesh.material.wireframe=e.target.checked;
 function resize(){const r=host.getBoundingClientRect();renderer.setSize(r.width,r.height,false);camera.aspect=r.width/Math.max(1,r.height);camera.updateProjectionMatrix();}
 new ResizeObserver(resize).observe(host);resize();
 renderer.setAnimationLoop(()=>{mesh.rotation.y=Math.max(-1.4,Math.min(1.4,yaw));mesh.rotation.x=Math.max(-1.2,Math.min(1.2,pitch));renderer.render(scene,camera)});
}
function project(s){
 const script="("+standaloneViewer.toString()+")("+JSON.stringify(configFor(s))+");";
 const css="*{box-sizing:border-box}body{margin:0;background:#0a0c11;color:#e5eaf1;font:14px Arial,sans-serif}header{height:64px;display:flex;justify-content:space-between;align-items:center;padding:0 24px;border-bottom:1px solid #363d4a}header strong{letter-spacing:2px}header small{color:#9da7b5}.viewport{height:calc(100vh - 64px);min-height:360px;background:radial-gradient(ellipse at center,#384150,#10141c 72%)}canvas{display:block}label{margin-right:12px}";
 const html='<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SAM3D Export</title><link rel="stylesheet" href="./style.css"></head><body><header><strong>SAM3D / EXPORT</strong><div><label><input id="wire" type="checkbox"> Khung lưới</label><button id="reset">Đặt lại góc nhìn</button></div><small>2.5D DEPTH MESH</small></header><main class="viewport" id="scene"></main><script type="module" src="./app.js"></script></body></html>';
 const single=html.replace('<link rel="stylesheet" href="./style.css">',"<style>"+css+"</style>").replace('<script type="module" src="./app.js"></script>',"<script type=\"module\">"+script+"</script>");
 return {html,css,script,single};
}
function save(blob,name){const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export async function downloadBundle(state){
 const p=project(state);
 save(zipStore({"index.html":p.html,"style.css":p.css,"app.js":p.script,"README.txt":"SAM3D Studio 2.5D export. Serve over HTTP, e.g. python -m http.server. Uses Three.js CDN. This does not execute the SAM 3D AI model."}),"sam3d-html-css-js.zip");
}
export function downloadSingleHTML(state){
 const p=project(state);save(new Blob([p.single],{type:"text/html;charset=utf-8"}),"sam3d-standalone.html");
}
