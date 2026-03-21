from __future__ import annotations

import gc
import json
import os
import tempfile
import urllib.request
from collections.abc import Generator
from typing import Any

import torch
import whisper
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

router = APIRouter()

SUPPORTED_MODELS = ("tiny", "base", "small", "large-v3")
UPLOAD_CHUNK_SIZE = 1024 * 1024
FORCE_CPU_FOR_LARGE_V3 = os.getenv("VOXORA_FORCE_CPU_FOR_LARGE_V3", "1") == "1"


def detect_whisper_device() -> str:
    # Prefer CUDA, then Apple Metal (MPS), then CPU.
    if torch.cuda.is_available():
        return "cuda"

    mps_backend = getattr(torch.backends, "mps", None)
    if mps_backend and mps_backend.is_available():
        return "mps"

    return "cpu"


def whisper_cache_dir() -> str:
    default_cache = os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(os.getenv("XDG_CACHE_HOME", default_cache), "whisper")


def model_download_target(model_name: str, download_root: str) -> str | None:
    model_url = whisper._MODELS.get(model_name)  # type: ignore[attr-defined]
    if not model_url:
        return None
    return os.path.join(download_root, os.path.basename(model_url))


def is_model_downloaded(model_name: str, download_root: str | None = None) -> bool:
    root = download_root or whisper_cache_dir()
    target = model_download_target(model_name, root)
    return bool(target and os.path.isfile(target))


def pick_transcription_device(model_name: str) -> str:
    detected = detect_whisper_device()
    if model_name == "large-v3" and detected == "mps" and FORCE_CPU_FOR_LARGE_V3:
        return "cpu"
    return detected


def seconds_to_srt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def build_srt(segments: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for idx, segment in enumerate(segments, start=1):
        lines.append(str(idx))
        lines.append(
            f"{seconds_to_srt_time(segment['start'])} --> {seconds_to_srt_time(segment['end'])}"
        )
        lines.append(segment["text"].strip())
        lines.append("")
    return "\n".join(lines).strip()


def line_segments_from_words(words: list[dict[str, Any]], max_chars: int) -> list[dict[str, Any]]:
    if not words:
        return []

    grouped: list[dict[str, Any]] = []
    current_words: list[dict[str, Any]] = [words[0]]

    for word in words[1:]:
        prev = current_words[-1]
        current_text = " ".join(w["word"].strip() for w in current_words).strip()
        candidate_text = (current_text + " " + word["word"].strip()).strip()
        natural_pause = float(word["start"]) - float(prev["end"])

        if len(candidate_text) > max_chars or natural_pause > 0.5:
            grouped.append(
                {
                    "start": float(current_words[0]["start"]),
                    "end": float(current_words[-1]["end"]),
                    "text": " ".join(w["word"].strip() for w in current_words).strip(),
                    "words": current_words.copy(),
                }
            )
            current_words = [word]
        else:
            current_words.append(word)

    if current_words:
        grouped.append(
            {
                "start": float(current_words[0]["start"]),
                "end": float(current_words[-1]["end"]),
                "text": " ".join(w["word"].strip() for w in current_words).strip(),
                "words": current_words.copy(),
            }
        )

    return grouped


def _sse(step: str, label: str, pct: int, extra: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {"step": step, "label": label, "pct": pct}
    if extra:
        payload.update(extra)
    return f"data: {json.dumps(payload)}\n\n"


def stream_model_download_events(
    model_name: str,
    start_pct: int,
    end_pct: int,
    download_root: str,
) -> Generator[str, None, None]:
    target = model_download_target(model_name, download_root)
    if not target:
        return

    if os.path.isfile(target):
        yield _sse(
            "model_download",
            f"Whisper '{model_name}' model already available locally.",
            end_pct,
            {"download_pct": 100, "model": model_name, "model_cached": True},
        )
        return

    model_url = whisper._MODELS[model_name]  # type: ignore[attr-defined]
    os.makedirs(download_root, exist_ok=True)

    yield _sse(
        "model_download",
        f"Downloading Whisper '{model_name}' model…",
        start_pct,
        {"download_pct": 0, "model": model_name, "model_cached": False},
    )

    with urllib.request.urlopen(model_url) as source, open(target, "wb") as output:
        total = int(source.info().get("Content-Length") or 0)
        downloaded = 0
        last_sent_pct = -1

        while True:
            chunk = source.read(1024 * 256)
            if not chunk:
                break

            output.write(chunk)
            downloaded += len(chunk)

            download_pct = int(downloaded * 100 / total) if total > 0 else 0
            if download_pct == last_sent_pct and downloaded != total:
                continue
            last_sent_pct = download_pct

            overall_pct = start_pct + int((end_pct - start_pct) * (download_pct / 100))
            if total > 0:
                label = (
                    f"Downloading Whisper '{model_name}' model… "
                    f"{downloaded / (1024 * 1024):.1f} / {total / (1024 * 1024):.1f} MB"
                )
            else:
                label = (
                    f"Downloading Whisper '{model_name}' model… "
                    f"{downloaded / (1024 * 1024):.1f} MB"
                )

            yield _sse(
                "model_download",
                label,
                overall_pct,
                {
                    "download_pct": download_pct,
                    "downloaded_bytes": downloaded,
                    "total_bytes": total,
                    "model": model_name,
                    "model_cached": False,
                },
            )

    yield _sse(
        "model_download",
        f"Whisper '{model_name}' model download complete.",
        end_pct,
        {"download_pct": 100, "model": model_name, "model_cached": False},
    )


@router.get("/caption/models/status")
def caption_model_status() -> dict[str, Any]:
    cache_root = whisper_cache_dir()
    return {
        "cache_dir": cache_root,
        "models": {name: is_model_downloaded(name, cache_root) for name in SUPPORTED_MODELS},
    }


@router.post("/caption")
async def caption_audio(
    file: UploadFile = File(...),
    language: str = Form("auto"),
    granularity: str = Form("line"),
    max_chars: int = Form(50),
    model: str = Form("small"),
) -> StreamingResponse:
    if language not in {"id", "en", "auto"}:
        raise HTTPException(status_code=400, detail="Unsupported language")

    if granularity not in {"word", "line"}:
        raise HTTPException(status_code=400, detail="Unsupported granularity")

    if model not in SUPPORTED_MODELS:
        raise HTTPException(status_code=400, detail="Unsupported model")

    filename = file.filename or "audio"
    temp_input_path = ""
    total_bytes = 0

    with tempfile.NamedTemporaryFile(delete=False, suffix=f"_{filename}") as tmp:
        temp_input_path = tmp.name
        while True:
            chunk = await file.read(UPLOAD_CHUNK_SIZE)
            if not chunk:
                break
            total_bytes += len(chunk)
            tmp.write(chunk)

    if total_bytes == 0:
        try:
            os.remove(temp_input_path)
        except OSError:
            pass
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    await file.close()

    def generate() -> Generator[str, None, None]:
        try:
            yield _sse("read", "Reading audio file…", 10)
            cache_root = whisper_cache_dir()
            if not is_model_downloaded(model, cache_root):
                yield from stream_model_download_events(
                    model_name=model,
                    start_pct=20,
                    end_pct=50,
                    download_root=cache_root,
                )

            device = pick_transcription_device(model)
            if model == "large-v3" and device == "cpu":
                yield _sse("model", "Using CPU low-memory mode for large-v3 on this device…", 52)

            yield _sse("model", f"Loading Whisper '{model}' model on {device.upper()}…", 55)
            model_instance = whisper.load_model(
                model,
                download_root=cache_root,
                device=device,
            )

            try:
                yield _sse("transcribe", "Transcribing audio — this may take a moment…", 65)
                transcribe_opts: dict[str, Any] = {
                    "language": None if language == "auto" else language,
                    "word_timestamps": granularity == "word",
                    "task": "transcribe",
                    "beam_size": 1 if model == "large-v3" else 5,
                    "best_of": 1,
                    "temperature": (0.0,),
                    "condition_on_previous_text": False,
                }
                if device in {"cpu", "mps"}:
                    transcribe_opts["fp16"] = False

                with torch.inference_mode():
                    result = model_instance.transcribe(
                        temp_input_path,
                        **transcribe_opts,
                    )
            except RuntimeError as exc:
                out_of_memory = "out of memory" in str(exc).lower() or "mps" in str(exc).lower()
                if out_of_memory and device != "cpu":
                    yield _sse("model", "Memory pressure detected, retrying on CPU low-memory mode…", 60)
                    del model_instance
                    if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
                        torch.mps.empty_cache()
                    gc.collect()

                    model_instance = whisper.load_model(
                        model,
                        download_root=cache_root,
                        device="cpu",
                    )
                    transcribe_opts = {
                        "language": None if language == "auto" else language,
                        "word_timestamps": granularity == "word",
                        "task": "transcribe",
                        "beam_size": 1,
                        "best_of": 1,
                        "temperature": (0.0,),
                        "condition_on_previous_text": False,
                        "fp16": False,
                    }
                    with torch.inference_mode():
                        result = model_instance.transcribe(
                            temp_input_path,
                            **transcribe_opts,
                        )
                else:
                    raise
            finally:
                del model_instance
                if device == "cuda":
                    torch.cuda.empty_cache()
                if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
                    torch.mps.empty_cache()
                gc.collect()

            yield _sse("segments", "Building caption segments…", 85)
            detected = str(result.get("language") or "unknown")
            raw_segments = result.get("segments", [])

            words: list[dict[str, Any]] = []
            for segment in raw_segments:
                for word in segment.get("words", []):
                    words.append(
                        {
                            "word": str(word.get("word", "")).strip(),
                            "start": float(word.get("start", segment.get("start", 0.0))),
                            "end": float(word.get("end", segment.get("end", 0.0))),
                        }
                    )

            if not words:
                segments = [
                    {
                        "start": float(seg.get("start", 0.0)),
                        "end": float(seg.get("end", 0.0)),
                        "text": str(seg.get("text", "")).strip(),
                        "words": [],
                    }
                    for seg in raw_segments
                ]
            elif granularity == "word":
                segments = [
                    {"start": w["start"], "end": w["end"], "text": w["word"], "words": [w]}
                    for w in words
                ]
            else:
                segments = line_segments_from_words(words, max(30, min(80, int(max_chars))))

            srt = build_srt(segments)

            yield _sse("done", "Captions ready!", 100, {
                "result": {
                    "segments": segments,
                    "language_detected": detected,
                    "srt": srt,
                }
            })

        except Exception as exc:  # noqa: BLE001
            yield _sse("error", f"Transcription failed: {exc}", 0, {"error": str(exc)})
        finally:
            try:
                os.remove(temp_input_path)
            except OSError:
                pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
