from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from captioner import router as caption_router
from processor import router as processor_router

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
