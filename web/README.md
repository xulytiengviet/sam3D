# SAM3D Studio — Image to Web 2.5D + optional GPU

The root index.html is an independent HTML/CSS/JS interface; original SAM 3D Objects code and SAM License are preserved.

## GitHub Pages
Settings → Pages → Deploy from a branch → main → /(root).
Site: https://xulytiengviet.github.io/sam3D/

Upload PNG/JPG/WEBP or paste a CORS-enabled image URL. Modes: original, estimated depth mesh, wireframe. Uploading a grayscale depth map gives a better relief mesh. Exports: ZIP with HTML/CSS/JS, single HTML, GLB 2.5D, PNG.

IMPORTANT: the browser-only relief mesh is heuristic and NOT the real SAM 3D model. One 2D photo cannot guarantee exact hidden geometry. The export is textured 2.5D, not semantic HTML reconstructed from a screenshot.

## Optional GPU API
Follow the ORIGINAL doc/setup.md for CUDA Linux, at least 32 GB NVIDIA VRAM, gated checkpoints and SAM License.
After installation:

    pip install -r web/requirements-api.txt
    export SAM3D_API_KEY=change-this-long-random-secret
    export SAM3D_ALLOWED_ORIGINS=https://xulytiengviet.github.io
    export SAM3D_CONFIG=checkpoints/hf/pipeline.yaml
    uvicorn web.gpu_api:app --host 0.0.0.0 --port 8000

Use a properly secured HTTPS proxy. The browser key is visible to its user, so do NOT treat a shared client-side key as protection for a public inference API. Add upstream rate limits/authentication.

POST /api/reconstruct form-data: image, mask (optional only if image alpha isolates the object), seed. Authorization: Bearer <key>. Returns Gaussian-splat PLY. Frontend PLYLoader shows a simple point preview, not true Gaussian splat rendering. Incompatible splat PLY attributes may need conversion.

Remote images require valid CORS headers. Exported pages load Three.js from a CDN and need Internet. Original Meta model and code retain their SAM License.