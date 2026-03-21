import io
import json
import tempfile
import threading
import time
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

# Temporary in-memory store with safeguards: token -> (wav_bytes, created_at_monotonic)
_result_store: dict[str, tuple[bytes, float]] = {}
_result_store_lock = threading.Lock()
RESULT_TTL_SECONDS = 15 * 60
MAX_RESULT_STORE_ITEMS = 32
MAX_UPLOAD_BYTES = 100 * 1024 * 1024


def _clamp_percent(value: Any, default: int) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = float(default)
    return max(0.0, min(1.0, number / 100.0))


def _cleanup_result_store(now: float | None = None) -> None:
    current = now if now is not None else time.monotonic()
    expired = [
        token
        for token, (_, created_at) in _result_store.items()
        if current - created_at > RESULT_TTL_SECONDS
    ]
    for token in expired:
        _result_store.pop(token, None)

    if len(_result_store) <= MAX_RESULT_STORE_ITEMS:
        return

    oldest_first = sorted(_result_store.items(), key=lambda item: item[1][1])
    overflow = len(_result_store) - MAX_RESULT_STORE_ITEMS
    for token, _ in oldest_first[:overflow]:
        _result_store.pop(token, None)


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
    await file.close()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Uploaded file is too large")

    filename = file.filename or "audio"
    noise_reduction = _clamp_percent(parsed_settings.get("noise_reduction", 80), 80)
    clarity = _clamp_percent(parsed_settings.get("clarity", 70), 70)
    de_reverb = _clamp_percent(parsed_settings.get("de_reverb", 30), 30)
    compression = _clamp_percent(parsed_settings.get("compression", 70), 70)
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
            payload = buf.getvalue()
            now = time.monotonic()
            with _result_store_lock:
                _cleanup_result_store(now)
                _result_store[token] = (payload, now)
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
    with _result_store_lock:
        _cleanup_result_store()
        item = _result_store.pop(token, None)

    if item is None:
        raise HTTPException(status_code=404, detail="Result not found or already downloaded")

    wav, _created_at = item
    return StreamingResponse(
        io.BytesIO(wav),
        media_type="audio/wav",
        headers={"Content-Disposition": "attachment; filename=enhanced.wav"},
    )
