"""Render CPU gateway for a separate SAM 3D Objects GPU service.

No model weights are installed on Render. This proxy never claims to run GPU inference.
"""
import asyncio
import os
import time
from collections import defaultdict, deque
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI(title="SAM3D Render Gateway", version="1.1.0")
ORIGINS = ["https://xulytiengviet.github.io"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
MAX_IMAGE = 20 * 1024 * 1024
MAX_RESULT = 100 * 1024 * 1024
BURST_WINDOW = 600
MAX_REQUESTS = 3
request_times = defaultdict(deque)
rate_lock = asyncio.Lock()
gpu_lock = asyncio.Lock()


def upstream_url():
    raw = os.getenv("SAM3D_GPU_URL", "").strip().rstrip("/")
    if not raw:
        return ""
    parts = urlparse(raw)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise RuntimeError("SAM3D_GPU_URL phải là URL HTTPS hợp lệ, không chứa credentials/query.")
    return raw


def enabled():
    return os.getenv("SAM3D_ENABLE_PUBLIC_INFERENCE", "false").lower() == "true"


async def gpu_health():
    url = upstream_url()
    if not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=False, trust_env=False) as client:
            r = await client.get(url + "/health")
            return r.status_code == 200
    except httpx.HTTPError:
        return False


@app.get("/health")
async def health():
    return {"status": "ok", "role": "cpu-api-gateway", "gpu_inference_here": False}


@app.get("/api/status")
async def status():
    url = upstream_url()
    reachable = await gpu_health() if url else False
    return {
        "gateway_online": True,
        "gpu_configured": bool(url),
        "gpu_reachable": reachable,
        "inference_enabled": enabled(),
        "ready": bool(url and reachable and enabled()),
        "model": "SAM 3D Objects (external GPU)",
    }


@app.post("/api/reconstruct")
async def reconstruct(
    request: Request,
    image: UploadFile = File(...),
    mask: UploadFile | None = File(default=None),
    seed: int = Form(42),
):
    url = upstream_url()
    if not url:
        raise HTTPException(503, "Render đã kết nối, nhưng chưa cấu hình máy chủ GPU SAM 3D (SAM3D_GPU_URL).")
    if not enabled():
        raise HTTPException(503, "GPU chưa được bật cho người dùng công khai (SAM3D_ENABLE_PUBLIC_INFERENCE=false).")
    if not await gpu_health():
        raise HTTPException(503, "Máy chủ GPU không phản hồi; kiểm tra checkpoint, HTTPS và /health.")
    if image.content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(415, "Chỉ chấp nhận PNG, JPEG hoặc WEBP.")
    if mask and mask.content_type != "image/png":
        raise HTTPException(415, "Mask phải là PNG.")
    if seed < 0 or seed > 2**31 - 1:
        raise HTTPException(422, "Seed không hợp lệ.")

    peer = request.client.host if request.client else "anonymous"
    async with rate_lock:
        now = time.monotonic()
        q = request_times[peer]
        while q and q[0] < now - BURST_WINDOW:
            q.popleft()
        if len(q) >= MAX_REQUESTS:
            raise HTTPException(429, "Quá 3 lần tái dựng trong 10 phút; hãy thử sau.")
        q.append(now)

    if gpu_lock.locked():
        raise HTTPException(429, "GPU đang xử lý ảnh khác; thử lại sau.")
    async with gpu_lock:
        raw = await image.read(MAX_IMAGE + 1)
        if not raw or len(raw) > MAX_IMAGE:
            raise HTTPException(413, "Ảnh phải nhỏ hơn 20 MB.")
        files = {"image": (image.filename or "image.png", raw, image.content_type)}
        if mask is not None:
            mask_data = await mask.read(MAX_IMAGE + 1)
            if not mask_data or len(mask_data) > MAX_IMAGE:
                raise HTTPException(413, "Mask phải nhỏ hơn 20 MB.")
            files["mask"] = (mask.filename or "mask.png", mask_data, "image/png")
        headers = {}
        token = os.getenv("SAM3D_GPU_KEY", "").strip()
        if token:
            headers["Authorization"] = "Bearer " + token
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(connect=15, read=210, write=60, pool=20), follow_redirects=False, trust_env=False) as client:
                async with client.stream(
                    "POST", url + "/api/reconstruct", files=files, data={"seed": str(seed)}, headers=headers,
                ) as response:
                    if response.status_code != 200:
                        raise HTTPException(
                            502 if response.status_code >= 500 else response.status_code,
                            f"GPU upstream trả về HTTP {response.status_code}; kiểm tra nhật ký máy chủ GPU.",
                        )
                    result = bytearray()
                    async for chunk in response.aiter_bytes():
                        result.extend(chunk)
                        if len(result) > MAX_RESULT:
                            raise HTTPException(502, "Tệp PLY vượt quá 100 MB; cần lưu trữ ngoài và trả URL có thời hạn.")
                    if not result:
                        raise HTTPException(502, "GPU trả về dữ liệu trống.")
                    return Response(
                        content=bytes(result),
                        media_type="application/octet-stream",
                        headers={
                            "Content-Disposition": 'attachment; filename="sam3d-gaussian-splat.ply"',
                            "Cache-Control": "no-store",
                        },
                    )
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise HTTPException(502, "Không thể kết nối GPU upstream hoặc suy luận quá thời gian chờ.") from exc
