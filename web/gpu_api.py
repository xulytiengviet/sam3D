"""Optional SAM 3D Objects GPU endpoint (Linux + NVIDIA required)."""
import io, os, sys, threading, tempfile
from pathlib import Path
import numpy as np
from PIL import Image, UnidentifiedImageError
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"notebook"))
app=FastAPI(title="SAM3D GPU")
origins=[v.strip() for v in os.getenv("SAM3D_ALLOWED_ORIGINS","").split(",") if v.strip()]
app.add_middleware(CORSMiddleware,allow_origins=origins,allow_methods=["GET","POST"],allow_headers=["Authorization","Content-Type"])
_lock=threading.Lock()
_model=None

def decode(data):
    if len(data)>20*1024*1024: raise HTTPException(413,"Ảnh vượt 20 MB.")
    try:
        img=Image.open(io.BytesIO(data));img.load()
        if img.width*img.height>32_000_000: raise HTTPException(413,"Ảnh vượt 32 MP.")
        return img
    except (OSError,UnidentifiedImageError,ValueError) as e: raise HTTPException(422,"Không đọc được ảnh.") from e

def model():
    global _model
    if _model is None:
        from inference import Inference
        path=os.getenv("SAM3D_CONFIG",str(ROOT/"checkpoints/hf/pipeline.yaml"))
        if not Path(path).exists(): raise RuntimeError("Chưa tải checkpoint.")
        _model=Inference(path,compile=False)
    return _model

@app.get("/health")
def health(): return {"status":"ok","loaded":_model is not None}

@app.post("/api/reconstruct")
def reconstruct(image:UploadFile=File(...),mask:UploadFile|None=File(default=None),seed:int=Form(42),authorization:str|None=Header(default=None)):
    key=os.getenv("SAM3D_API_KEY")
    if not key: raise HTTPException(503,"Máy chủ chưa cấu hình SAM3D_API_KEY.")
    if authorization!="Bearer "+key: raise HTTPException(401,"API key không hợp lệ.")
    orig=decode(image.file.read())
    rgb=np.asarray(orig.convert("RGB"),dtype=np.uint8)
    if mask:
        mask_img=decode(mask.file.read()).convert("L")
        if mask_img.size!=orig.size: raise HTTPException(422,"Mask không khớp kích thước.")
        m=np.asarray(mask_img,dtype=np.uint8)>127
    elif orig.mode in ("RGBA","LA") or "transparency" in orig.info:
        m=np.asarray(orig.convert("RGBA").getchannel("A"),dtype=np.uint8)>127
    else: raise HTTPException(422,"Cần mask PNG hoặc ảnh có alpha.")
    if not np.any(m) or np.all(m): raise HTTPException(422,"Mask phải khoanh vùng vật thể.")
    if not _lock.acquire(blocking=False): raise HTTPException(429,"GPU đang bận.")
    try:
        try:
            output=model()(rgb,m,seed=seed)
            gaussian=output.get("gs")
            if gaussian is None: gaussian=output["gaussian"][0]
            with tempfile.NamedTemporaryFile(suffix=".ply",delete=False) as f: tmp=f.name
            try:
                gaussian.save_ply(tmp)
                data=Path(tmp).read_bytes()
            finally: Path(tmp).unlink(missing_ok=True)
            return Response(data,media_type="application/octet-stream",headers={"Cache-Control":"no-store"})
        except Exception as exc:
            raise HTTPException(500,"Suy luận GPU thất bại; kiểm tra log máy chủ.") from exc
    finally: _lock.release()
