from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import torch
import os

from captioner import router as caption_router
from processor import router as processor_router

# Optimize PyTorch for M2 Mac with limited RAM
if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
    # Enable MPS fallback for operations not yet supported
    os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    # Set thread count for optimal performance on M2
    torch.set_num_threads(min(os.cpu_count() or 1, 4))
    torch.set_num_interop_threads(min(os.cpu_count() or 1, 2))

app = FastAPI(title="Voxora API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(processor_router)
app.include_router(caption_router)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}
