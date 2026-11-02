import * as THREE from "three";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { downloadBundle, downloadSingleHTML } from "./exporter.js";

const $ = id => document.getElementById(id);
const host = $("canvasHost");
const state = {
  mode: "original", image: null, sourceData: "", objectURL: null,
  imageCanvas: null, depthPixels: null, depthWidth: 0, depthHeight: 0,
  sourceName: "Demo Scene", strength: .65, resolution: 128,
  autoRotate: false, rotX: -.04, rotY: .0, zoom: 1, kind: "image",
  currentObject: null, maskFile: null
};
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-4,4,3,-3,.01,100);
camera.position.set(0,0,12);
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
host.appendChild(renderer.domElement);
const mainGroup = new THREE.Group();
scene.add(mainGroup);

function message(text, error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
  $("status").textContent = error ? "CÓ LỖI" : "SẴN SÀNG";
}
function busy(on, label = "ĐANG XỬ LÝ...") {
  $("working").hidden = !on;
  $("working").querySelector("span").textContent = label;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const imageExt = (blob) => blob.type === "image/jpeg" ? ".jpg" : blob.type === "image/webp" ? ".webp" : ".png";
function readAsDataURL(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.onerror = () => rej(new Error("Không đọc được tệp ảnh."));
    reader.readAsDataURL(blob);
  });
}
async function imageFromBlob(blob) {
  const uri = URL.createObjectURL(blob);
  const img = new Image();
  try {
    img.src = uri;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(uri);
  }
}
function parseUpload(file) {
  if (!file || !["image/png","image/jpeg","image/webp"].includes(file.type)) throw new Error("Chỉ hỗ trợ ảnh PNG, JPG hoặc WEBP.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Ảnh vượt quá 20 MB.");
  if (!file.size) throw new Error("Tệp ảnh trống.");
  return file;
}
function clearObject() {
  if (!state.currentObject) return;
  mainGroup.remove(state.currentObject);
  state.currentObject.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of materials) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
  state.currentObject = null;
}
function buildDemoBlob() {
  const c = document.createElement("canvas");
  c.width = 1120; c.height = 760;
  const x = c.getContext("2d");
  let g = x.createLinearGradient(0,0,1120,760);
  g.addColorStop(0,"#e4e8ec"); g.addColorStop(.49,"#a0a9b7"); g.addColorStop(1,"#353d4b");
  x.fillStyle = g; x.fillRect(0,0,1120,760);
  x.fillStyle = "#dce1e8";
  for (let i=0;i<25;i++){ x.globalAlpha=.09; x.fillRect(0, i*42,1120,1); }
  x.globalAlpha=1;
  const drawFace=(pts,fill)=>{x.beginPath();x.moveTo(...pts[0]);for(let i=1;i<pts.length;i++)x.lineTo(...pts[i]);x.closePath();x.fillStyle=fill;x.fill();};
  x.fillStyle="#616c7c";x.beginPath();x.ellipse(572,650,330,55,0,0,Math.PI*2);x.fill();
  drawFace([[255,254],[585,135],[897,256],[560,386]],"#f4f6f8");
  drawFace([[255,254],[560,386],[560,656],[255,505]],"#a1abb8");
  drawFace([[560,386],[897,256],[897,508],[560,656]],"#525d6e");
  drawFace([[315,311],[515,401],[515,579],[315,485]],"#d9dfe6");
  drawFace([[605,417],[837,328],[837,465],[605,564]],"#838e9f");
  x.strokeStyle="#ffffffac";x.lineWidth=5;x.beginPath();x.moveTo(255,254);x.lineTo(585,135);x.lineTo(897,256);x.stroke();
  x.fillStyle="#334155";x.font="700 33px ui-monospace, monospace";x.fillText("SAM / 3D",75,92);
  x.font="17px ui-monospace, monospace";x.fillText("SILVER ARCHITECTURAL STUDY",75,128);
  return new Promise(res=>c.toBlob(res,"image/png"));
}
function sampleAt(data,w,h,u,v) {
  const x=Math.max(0,Math.min(w-1,u*(w-1))), y=Math.max(0,Math.min(h-1,v*(h-1)));
  const a=Math.floor(x),b=Math.floor(y),cx=Math.min(w-1,a+1),cy=Math.min(h-1,b+1);
  const fx=x-a,fy=y-b;
  return (data[b*w+a]*(1-fx)+data[b*w+cx]*fx)*(1-fy)+(data[cy*w+a]*(1-fx)+data[cy*w+cx]*fx)*fy;
}
function computeDepth(depthImage) {
  const image = state.imageCanvas;
  const w=128,h=Math.max(48, Math.round(128*image.height/image.width));
  const c=document.createElement("canvas"); c.width=w;c.height=h;
  const ctx=c.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(depthImage || image,0,0,w,h);
  const pix=ctx.getImageData(0,0,w,h).data;
  const depth=new Float32Array(w*h);
  if(depthImage) {
    for(let i=0;i<w*h;i++) depth[i]=(.2126*pix[i*4]+.7152*pix[i*4+1]+.0722*pix[i*4+2])/255;
  } else {
    const bg=[0,0,0];
    const corners=[[0,0],[w-1,0],[0,h-1],[w-1,h-1]];
    for(const [cx,cy] of corners) {
      const k=(cy*w+cx)*4; bg[0]+=pix[k]/4;bg[1]+=pix[k+1]/4;bg[2]+=pix[k+2]/4;
    }
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const k=(y*w+x)*4, u=x/(w-1), v=y/(h-1);
      const contrast=Math.min(1, Math.hypot(pix[k]-bg[0],pix[k+1]-bg[1],pix[k+2]-bg[2])/310);
      const center=Math.exp(-((u-.5)**2/.085+(v-.52)**2/.18));
      const local=(pix[k]+pix[k+1]+pix[k+2])/765;
      depth[y*w+x]=Math.max(0,Math.min(1,.17+.48*center+.30*contrast+.05*local));
    }
  }
  // Smooth small-scale luminance noise to reduce spiky geometry.
  const smoothed=new Float32Array(depth.length);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let sum=0,weight=0;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      const yy=Math.max(0,Math.min(h-1,y+dy)), xx=Math.max(0,Math.min(w-1,x+dx));
      const wt=(dx===0&&dy===0)?4:1;
      sum+=depth[yy*w+xx]*wt;weight+=wt;
    }
    smoothed[y*w+x]=sum/weight;
  }
  state.depthPixels=smoothed;state.depthWidth=w;state.depthHeight=h;
}
function adjustCamera(width,height) {
  const bounds=host.getBoundingClientRect();
  const ratio=Math.max(.2,bounds.width/Math.max(1,bounds.height));
  const vHeight=Math.max(4.2,height*1.35,width*1.35/ratio);
  camera.left= -vHeight*ratio/2;camera.right=vHeight*ratio/2;
  camera.top=vHeight/2;camera.bottom=-vHeight/2;
  camera.zoom=state.zoom;camera.updateProjectionMatrix();
}
function rebuildMesh() {
  if(!state.imageCanvas||!state.depthPixels)return;
  state.kind="image";
  clearObject();
  const aspect=state.imageCanvas.width/state.imageCanvas.height;
  const height=Math.min(3.8,5.25/aspect),width=height*aspect;
  const segX=state.resolution, segY=Math.max(32,Math.round(segX/aspect));
  const geometry=new THREE.PlaneGeometry(width,height,segX,segY);
  const arr=geometry.attributes.position.array;
  let i=0;
  for(let y=0;y<=segY;y++)for(let x=0;x<=segX;x++,i++){
    arr[i*3+2]=(sampleAt(state.depthPixels,state.depthWidth,state.depthHeight,x/segX,y/segY)-.5)*state.strength*1.7;
  }
  geometry.attributes.position.needsUpdate=true;
  geometry.computeVertexNormals();
  const texture=new THREE.CanvasTexture(state.imageCanvas);
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  const mat=new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(geometry,mat);
  mainGroup.add(mesh);state.currentObject=mesh;
  adjustCamera(width,height);
  setMode(state.mode);
}
function setMode(mode) {
  state.mode=mode;
  document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));
  $("originalPhoto").classList.toggle("hidden",mode!=="original");
  host.style.visibility=mode==="original"?"hidden":"visible";
  $("modeTag").textContent={original:"ORIGINAL / 2D",depth:"DEPTH MESH / 3D",wire:"WIREFRAME / 3D"}[mode];
  $("stampMode").textContent={original:"IMAGE MODE",depth:"INTERACTIVE 3D",wire:"MESH INSPECTION"}[mode];
  $("metaEngine").textContent=mode==="original"?"PIXEL PERFECT":state.kind==="ply"?"SAM3D PLY POINTS":"DEPTH MESH";
  if(state.currentObject && state.kind==="image"){
    state.currentObject.material.wireframe=mode==="wire";
    state.currentObject.material.color.set(mode==="wire"?"#d6dce6":"#ffffff");
  }
}
async function loadSource(blob,name) {
  busy(true,"ĐANG NẠP HÌNH ẢNH...");
  try {
    parseUpload(blob);
    const img=await imageFromBlob(blob);
    if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth*img.naturalHeight>32000000)
      throw new Error("Kích thước ảnh không hợp lệ hoặc vượt 32 megapixel.");
    state.sourceData=await readAsDataURL(blob);
    if(state.objectURL)URL.revokeObjectURL(state.objectURL);
    state.objectURL=URL.createObjectURL(blob);
    state.image=img;
    state.sourceName=name;
    state.rotX=-.04;state.rotY=0;state.zoom=1;
    $("originalPhoto").src=state.objectURL;
    const cv=document.createElement("canvas");
    const scale=Math.min(1,2048/Math.max(img.naturalWidth,img.naturalHeight));
    cv.width=Math.max(1,Math.round(img.naturalWidth*scale));cv.height=Math.max(1,Math.round(img.naturalHeight*scale));
    cv.getContext("2d",{willReadFrequently:true}).drawImage(img,0,0,cv.width,cv.height);
    state.imageCanvas=cv;
    computeDepth(null);
    rebuildMesh();
    state.maskFile=null;
    $("maskInput").value="";$("depthInput").value="";
    $("maskName").textContent="Chưa chọn mask. Ảnh PNG trong suốt có thể dùng kênh alpha.";
    $("metaFile").textContent=name.toUpperCase();
    $("metaSize").textContent=img.naturalWidth+" × "+img.naturalHeight+" PX";
    $("metaOutput").textContent="READY FOR EXPORT";
    message("Đã nhập "+name+". Ảnh gốc vẫn nguyên vẹn ở chế độ 2D. Chọn “3D chiều sâu” để xem dạng 2.5D.");
  } finally {busy(false);}
}
async function loadUrl(raw) {
  const u=new URL(raw);
  if(!["http:","https:"].includes(u.protocol))throw new Error("URL phải bắt đầu bằng https:// hoặc http://.");
  busy(true,"ĐANG TẢI ẢNH TỪ URL...");
  try {
    const rsp=await fetch(u.href,{mode:"cors",redirect:"follow"});
    if(!rsp.ok)throw new Error("Máy chủ ảnh trả về HTTP "+rsp.status);
    const type=rsp.headers.get("content-type")?.split(";")[0]?.trim();
    if(!["image/jpeg","image/png","image/webp"].includes(type))throw new Error("URL không trỏ tới PNG, JPG hoặc WEBP.");
    const size=Number(rsp.headers.get("content-length")||0);
    if(size>20*1024*1024)throw new Error("Ảnh vượt 20 MB.");
    const blob=await rsp.blob();
    await loadSource(blob,u.pathname.split("/").pop()||"remote-image"+imageExt(blob));
  }catch(err){
    if(err instanceof TypeError)throw new Error("Không tải được URL do CORS hoặc kết nối. Hãy tải ảnh về máy rồi dùng “Thả ảnh vào đây”.");
    throw err;
  }finally{busy(false);}
}
function handleError(e){console.error(e);message(e?.message||"Đã xảy ra lỗi.",true);}
const drop=$("dropzone");
drop.addEventListener("click",()=>$("fileInput").click());
drop.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$("fileInput").click();}});
$("fileInput").addEventListener("change",e=>{const f=e.target.files?.[0];if(f)loadSource(f,f.name).catch(handleError);});
for(const name of ["dragenter","dragover"]){drop.addEventListener(name,e=>{e.preventDefault();drop.classList.add("drag");});}
for(const name of ["dragleave","drop"]){drop.addEventListener(name,e=>{e.preventDefault();drop.classList.remove("drag");});}
drop.addEventListener("drop",e=>{const f=e.dataTransfer.files?.[0];if(f)loadSource(f,f.name).catch(handleError);});
$("urlForm").addEventListener("submit",e=>{e.preventDefault();loadUrl($("imageURL").value.trim()).catch(handleError);});
document.querySelectorAll("[data-mode]").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.mode)));
$("strength").addEventListener("input",e=>{state.strength=Number(e.target.value);$("strengthValue").textContent=state.strength.toFixed(2);if(state.kind==="image")rebuildMesh();});
$("resolution").addEventListener("input",e=>{state.resolution=Number(e.target.value);$("resolutionValue").textContent=String(state.resolution);if(state.kind==="image")rebuildMesh();});
$("depthInput").addEventListener("change",async e=>{
  try {
    const f=e.target.files?.[0];if(!f)return;
    parseUpload(f);const img=await imageFromBlob(f);
    computeDepth(img);rebuildMesh();setMode("depth");
    message("Đã dùng depth map: giá trị sáng = gần, tối = xa. Đây là lưới chiều sâu điều khiển bằng ảnh.");
  }catch(err){handleError(err);}
});
$("maskInput").addEventListener("change",e=>{
  state.maskFile=e.target.files?.[0]||null;
  $("maskName").textContent=state.maskFile?"Mask đã chọn: "+state.maskFile.name:"Chưa chọn mask.";
});
$("autoRotate").addEventListener("change",e=>state.autoRotate=e.target.checked);
$("resetBtn").addEventListener("click",()=>{state.rotX=-.04;state.rotY=0;state.zoom=1;camera.zoom=1;camera.updateProjectionMatrix();});
let dragging=false,lastX=0,lastY=0;
renderer.domElement.addEventListener("pointerdown",e=>{dragging=true;lastX=e.clientX;lastY=e.clientY;renderer.domElement.setPointerCapture(e.pointerId);});
renderer.domElement.addEventListener("pointermove",e=>{
  if(!dragging)return;
  state.rotY=Math.max(-1.3,Math.min(1.3,state.rotY+(e.clientX-lastX)*.006));
  state.rotX=Math.max(-1.1,Math.min(1.1,state.rotX+(e.clientY-lastY)*.006));
  lastX=e.clientX;lastY=e.clientY;
});
renderer.domElement.addEventListener("pointerup",()=>dragging=false);
renderer.domElement.addEventListener("pointercancel",()=>dragging=false);
host.addEventListener("wheel",e=>{
  if(state.mode==="original")return;
  e.preventDefault();
  state.zoom=Math.max(.55,Math.min(3,state.zoom*Math.exp(-e.deltaY*.001)));
  camera.zoom=state.zoom;camera.updateProjectionMatrix();
},{passive:false});
function resize(){
  const width=Math.max(1,host.clientWidth),height=Math.max(1,host.clientHeight);
  renderer.setSize(width,height,false);
  if(state.kind==="ply")adjustCamera(4,4);
  else if(state.imageCanvas){const a=state.imageCanvas.width/state.imageCanvas.height;const h=Math.min(3.8,5.25/a);adjustCamera(h*a,h);}
}
window.addEventListener("resize",resize);
const observer=new ResizeObserver(resize);observer.observe(host);
function animate(t){
  requestAnimationFrame(animate);
  if(state.currentObject){
    mainGroup.rotation.x=state.rotX;
    mainGroup.rotation.y=state.rotY+(state.autoRotate?Math.sin(t*.00045)*.3:0);
  }
  renderer.render(scene,camera);
}
requestAnimationFrame(animate);
$("snapshot").addEventListener("click",()=>{
  try {
    if(state.mode==="original"){
      const cv=document.createElement("canvas");
      cv.width=state.image.naturalWidth;cv.height=state.image.naturalHeight;
      cv.getContext("2d").drawImage(state.image,0,0);
      cv.toBlob(b=>download(b,"sam3d-original.png"),"image/png");
    }else{
      renderer.domElement.toBlob(b=>download(b,"sam3d-view.png"),"image/png");
    }
    message("Đã tạo ảnh PNG của chế độ hiện tại.");
  }catch(err){handleError(err);}
});
function ensureImageExport(){
  if(!state.sourceData||!state.depthPixels||state.kind!=="image")throw new Error("Hãy nạp ảnh để xuất HTML/CSS/JS dạng 3D.");
}
$("exportZip").addEventListener("click",async()=>{
  try{ensureImageExport();await downloadBundle(state);message("Đã xuất bộ ba index.html, style.css, app.js thành ZIP.");}catch(e){handleError(e);}
});
$("exportHTML").addEventListener("click",()=>{
  try{ensureImageExport();downloadSingleHTML(state);message("Đã xuất một tệp HTML tự chứa ảnh và mã CSS/JS.");}catch(e){handleError(e);}
});
$("exportGLB").addEventListener("click",async()=>{
  try{
    ensureImageExport();
    busy(true,"ĐANG TẠO GLB...");
    const exporter=new GLTFExporter();
    const glb=await new Promise((resolve,reject)=>exporter.parse(state.currentObject,resolve,reject,{binary:true}));
    download(new Blob([glb],{type:"model/gltf-binary"}),"sam3d-depth-mesh.glb");
    message("Đã xuất GLB dạng lưới chiều sâu 2.5D, không phải hình học kín của vật thể.");
  }catch(err){handleError(err);}finally{busy(false);}
});
$("reconstruct").addEventListener("click",async()=>{
  const endpoint=$("apiURL").value.trim().replace(/\/+$/,"");
  try {
    if(!state.image)throw new Error("Cần chọn ảnh đầu vào.");
    const url=new URL(endpoint);
    if(url.protocol!=="https:" && !(url.protocol==="http:"&&["localhost","127.0.0.1"].includes(url.hostname)))throw new Error("API cần HTTPS (hoặc localhost).");
    if(!state.maskFile && !state.sourceData.startsWith("data:image/png"))throw new Error("Hãy cung cấp mask PNG cho ảnh JPG/WEBP để khoanh vùng vật thể.");
    busy(true,"GPU SAM 3D ĐANG SUY LUẬN...");
    const form=new FormData();
    const originalBlob=await (await fetch(state.objectURL)).blob();
    form.append("image",originalBlob,"source"+imageExt(originalBlob));
    if(state.maskFile)form.append("mask",state.maskFile,"mask.png");
    form.append("seed","42");
    const headers={};
    if($("apiKey").value)headers["Authorization"]="Bearer "+$("apiKey").value;
    const response=await fetch(endpoint+"/api/reconstruct",{method:"POST",headers,body:form});
    if(!response.ok){
      const err=await response.json().catch(()=>({detail:"HTTP "+response.status}));
      throw new Error(typeof err.detail==="string"?err.detail:"Máy chủ GPU trả về HTTP "+response.status);
    }
    const ply=await response.arrayBuffer();
    download(new Blob([ply],{type:"application/octet-stream"}),"sam3d-gaussian-splat.ply");
    // PLYLoader shows positions as points, not full Gaussian splat rendering.
    const pointsGeometry=new PLYLoader().parse(ply);
    pointsGeometry.computeBoundingBox();
    const b=pointsGeometry.boundingBox;
    const center=b.getCenter(new THREE.Vector3()),size=b.getSize(new THREE.Vector3());
    pointsGeometry.translate(-center.x,-center.y,-center.z);
    const scale=3/Math.max(size.x,size.y,size.z,0.001);
    pointsGeometry.scale(scale,scale,scale);
    clearObject();
    const vertexColors=!!pointsGeometry.getAttribute("color");
    const points=new THREE.Points(pointsGeometry,new THREE.PointsMaterial({size:.013,sizeAttenuation:true,vertexColors,color:vertexColors?"#ffffff":"#dbe4f2"}));
    mainGroup.add(points);state.currentObject=points;state.kind="ply";
    state.rotX=0;state.rotY=0;state.zoom=1;
    adjustCamera(4,4);setMode("depth");
    $("metaEngine").textContent="SAM3D PLY POINTS";
    $("metaOutput").textContent="PLY DOWNLOADED";
    message("SAM 3D đã trả về PLY. Đã tải tệp splat; màn hình chỉ xem point cloud, không phải trình render Gaussian Splat đầy đủ.");
  }catch(err){handleError(err);}finally{busy(false);}
});
buildDemoBlob().then(blob=>loadSource(blob,"silver-demo.png")).catch(handleError);
