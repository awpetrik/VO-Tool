import io
import json
import tempfile
import uuid
from collections.abc import Generator
from typing import Any

import librosa
import noisereduce as nr
import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pedalboard import Compressor, HighpassFilter, PeakFilter, Pedalboard

router = APIRouter()

# Temporary in-memory store: token → WAV bytes. Single-user tool — no TTL needed.
_result_store: dict[str, bytes] = {}


def _sse(step: str, label: str, pct: int, extra: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {"step": step, "label": label, "pct": pct}
    if extra:
        payload.update(extra)
    return f"data: {json.dumps(payload)}\n\n"


@router.post("/enhance")
async def enhance_audio(file: UploadFile = File(...), settings: str = Form(...)) -> StreamingResponse:
    try:
        parsed_settings: dict[str, Any] = json.loads(settings)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid settings JSON") from exc

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    filename = file.filename or "audio"
    noise_reduction = float(parsed_settings.get("noise_reduction", 80)) / 100.0
    clarity = float(parsed_settings.get("clarity", 70)) / 100.0
    de_reverb = float(parsed_settings.get("de_reverb", 30)) / 100.0
    compression = float(parsed_settings.get("compression", 70)) / 100.0
    normalize_enabled = bool(parsed_settings.get("normalize", True))

    def generate() -> Generator[str, None, None]:
        try:
            yield _sse("read", "Reading audio file…", 10)
            with tempfile.NamedTemporaryFile(delete=True, suffix=f"_{filename}") as tmp:
                tmp.write(contents)
                tmp.flush()
                signal, sr = librosa.load(tmp.name, sr=None, mono=True)

            yield _sse("noise", "Reducing background noise…", 35)
            reduced = nr.reduce_noise(
                y=signal, sr=sr, prop_decrease=max(0.0, min(1.0, noise_reduction))
            )

            yield _sse("eq", "Applying clarity and de-reverb…", 55)
            board = Pedalboard(
                [
                    HighpassFilter(cutoff_frequency_hz=80 + (de_reverb * 120)),
                    PeakFilter(
                        cutoff_frequency_hz=3000 + (clarity * 2000),
                        gain_db=2 + (clarity * 4),
                        q=0.8,
                    ),
                    Compressor(
                        threshold_db=-22 + (compression * 8),
                        ratio=2.0 + (compression * 4),
                        attack_ms=5,
                        release_ms=180,
                    ),
                ]
            )
            processed = board(reduced.astype(np.float32), sr)

            if normalize_enabled:
                yield _sse("normalize", "Normalizing loudness to -14 LUFS…", 75)
                meter = pyln.Meter(sr)
                loudness = meter.integrated_loudness(processed)
                processed = pyln.normalize.loudness(processed, loudness, -14.0)

            yield _sse("encode", "Encoding WAV output…", 90)
            buf = io.BytesIO()
            sf.write(buf, processed, sr, format="WAV")

            token = uuid.uuid4().hex
            _result_store[token] = buf.getvalue()
            yield _sse("done", "Enhancement complete!", 100, {"token": token})

        except Exception as exc:  # noqa: BLE001
            yield _sse("error", f"Processing failed: {exc}", 0, {"error": str(exc)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/enhance/result/{token}")
async def get_enhance_result(token: str) -> StreamingResponse:
    wav = _result_store.pop(token, None)
    if wav is None:
        raise HTTPException(status_code=404, detail="Result not found or already downloaded")
    return StreamingResponse(
        io.BytesIO(wav),
        media_type="audio/wav",
        headers={"Content-Disposition": "attachment; filename=enhanced.wav"},
    )
