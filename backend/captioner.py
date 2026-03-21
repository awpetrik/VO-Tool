from __future__ import annotations

import json
import tempfile
from collections.abc import Generator
from typing import Any

import whisper
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

router = APIRouter()


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


@router.post("/caption")
async def caption_audio(
    file: UploadFile = File(...),
    language: str = Form("auto"),
    granularity: str = Form("line"),
    max_chars: int = Form(50),
    model: str = Form("small"),
) -> StreamingResponse:
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    if language not in {"id", "en", "auto"}:
        raise HTTPException(status_code=400, detail="Unsupported language")

    if granularity not in {"word", "line"}:
        raise HTTPException(status_code=400, detail="Unsupported granularity")

    filename = file.filename or "audio"

    def generate() -> Generator[str, None, None]:
        try:
            yield _sse("read", "Reading audio file…", 10)
            with tempfile.NamedTemporaryFile(delete=True, suffix=f"_{filename}") as tmp:
                tmp.write(contents)
                tmp.flush()

                yield _sse("model", f"Loading Whisper '{model}' model…", 25)
                model_instance = whisper.load_model(model)

                yield _sse("transcribe", "Transcribing audio — this may take a moment…", 45)
                result = model_instance.transcribe(
                    tmp.name,
                    language=None if language == "auto" else language,
                    word_timestamps=True,
                    task="transcribe",
                )

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

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
