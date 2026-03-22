from __future__ import annotations

import gc
import json
import multiprocessing as mp
import mimetypes
import os
import re
import subprocess
import tempfile
import urllib.request
from base64 import b64encode
from collections.abc import Generator
from typing import Any

import librosa
import requests
import torch
import whisper
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

router = APIRouter()

SUPPORTED_MODELS = ("tiny", "base", "small", "large-v3")
SUPPORTED_CAPTION_MODES = ("local", "hybrid", "cloud")
UPLOAD_CHUNK_SIZE = 1024 * 1024
FORCE_CPU_FOR_LARGE_V3 = os.getenv("VOXORA_FORCE_CPU_FOR_LARGE_V3", "1") == "1"
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")
GEMINI_BATCH_SIZE = 24
GEMINI_BATCH_CHAR_LIMIT = 2200
GEMINI_CLOUD_MAX_BYTES = int(os.getenv("GEMINI_CLOUD_MAX_BYTES", str(100 * 1024 * 1024)))
TIMING_ALIGN_MODEL = os.getenv("VOXORA_TIMING_ALIGN_MODEL", "tiny")
TIMING_ALIGN_LOOKAHEAD = int(os.getenv("VOXORA_TIMING_ALIGN_LOOKAHEAD", "12"))

# Audio conversion settings (for large files)
AUDIO_CONVERSION_THRESHOLD_BYTES = int(os.getenv("AUDIO_CONVERSION_THRESHOLD_BYTES", str(5 * 1024 * 1024)))
AUDIO_CONVERSION_TARGET_SAMPLE_RATE = 16000
AUDIO_CONVERSION_TARGET_BITRATE = os.getenv("AUDIO_CONVERSION_TARGET_BITRATE", "48k")


def _should_convert_audio(file_size_bytes: int) -> bool:
    """Check if audio file should be converted/compressed."""
    return file_size_bytes > AUDIO_CONVERSION_THRESHOLD_BYTES


def _convert_audio_with_ffmpeg(input_path: str, output_path: str) -> bool:
    """
    Convert audio file using ffmpeg to reduce size.
    Converts to 16kHz mono AAC/M4A optimized for speech transcription.
    Returns True on success, False on failure.
    """
    try:
        cmd = [
            "ffmpeg",
            "-y",  # Overwrite output file
            "-i", input_path,
            "-vn",  # Drop any video track
            "-sn",  # Drop subtitle track
            "-dn",  # Drop data track
            "-c:a", "aac",  # AAC audio codec
            "-ar", str(AUDIO_CONVERSION_TARGET_SAMPLE_RATE),  # 16kHz sample rate
            "-ac", "1",  # Mono (1 channel)
            "-b:a", AUDIO_CONVERSION_TARGET_BITRATE,
            output_path,
        ]
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,  # 5 minute timeout
            check=False,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")
            print(f"FFmpeg conversion warning: {stderr}")
            return False
        return True
    except FileNotFoundError:
        print("FFmpeg not found. Skipping audio conversion.")
        return False
    except subprocess.TimeoutExpired:
        print("FFmpeg conversion timeout. Skipping conversion.")
        return False
    except Exception as e:  # noqa: BLE001
        print(f"Error during audio conversion: {e}")
        return False


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


def _extract_json_array(raw: str) -> list[dict[str, Any]]:
    cleaned = raw.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    match = re.search(r"\[.*\]", cleaned, re.DOTALL)
    if not match:
        return []
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    if isinstance(parsed, list):
        return [item for item in parsed if isinstance(item, dict)]
    return []


def _extract_json_object(raw: str) -> dict[str, Any]:
    cleaned = raw.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        # Try to rescue truncated JSON by extracting complete segment objects
        return _rescue_truncated_json(match.group(0))
    if isinstance(parsed, dict):
        return parsed
    return {}


def _rescue_truncated_json(raw: str) -> dict[str, Any]:
    """Extract language and any complete segments from a truncated JSON response."""
    detected_lang = "unknown"
    lang_match = re.search(r'"language"\s*:\s*"([^"]+)"', raw)
    if lang_match:
        detected_lang = lang_match.group(1).strip().lower()

    # Extract all complete segment objects {"start":...,"end":...,"text":"..."}
    segment_pattern = re.compile(
        r'\{\s*"start"\s*:\s*([\d.]+)\s*,\s*"end"\s*:\s*([\d.]+)\s*,\s*"text"\s*:\s*"((?:[^\\"]|\\.)*)"\s*\}',
        re.DOTALL,
    )
    segments = []
    for m in segment_pattern.finditer(raw):
        try:
            segments.append({"start": float(m.group(1)), "end": float(m.group(2)), "text": m.group(3)})
        except (ValueError, IndexError):
            continue

    if not segments:
        return {}
    return {"language": detected_lang, "segments": segments}


def _chunk_segment_indices(segments: list[dict[str, Any]]) -> list[list[int]]:
    chunks: list[list[int]] = []
    current: list[int] = []
    current_chars = 0

    for idx, seg in enumerate(segments):
        text = str(seg.get("text", "")).strip()
        if not text:
            continue

        payload_len = len(text) + 8
        would_exceed_count = len(current) >= GEMINI_BATCH_SIZE
        would_exceed_chars = current_chars + payload_len > GEMINI_BATCH_CHAR_LIMIT
        if current and (would_exceed_count or would_exceed_chars):
            chunks.append(current)
            current = []
            current_chars = 0

        current.append(idx)
        current_chars += payload_len

    if current:
        chunks.append(current)
    return chunks


def _guess_audio_mime_type(filename: str, content_type: str | None) -> str:
    if content_type and "/" in content_type:
        return content_type
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "audio/wav"


def _audio_duration_seconds(path: str) -> float:
    try:
        value = float(librosa.get_duration(path=path))
        return max(0.0, value)
    except Exception:
        return 0.0


def _sanitize_cloud_segments(raw_segments: list[dict[str, Any]], duration: float) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    cursor = 0.0
    n = max(1, len(raw_segments))
    fallback_span = max(0.35, (duration / n) if duration > 0 else 1.0)

    for item in raw_segments:
        text = str(item.get("text", item.get("t", ""))).strip()
        if not text:
            continue
        try:
            start = float(item.get("start", cursor))
        except (TypeError, ValueError):
            start = cursor
        try:
            end = float(item.get("end", start + fallback_span))
        except (TypeError, ValueError):
            end = start + fallback_span

        if start < cursor:
            start = cursor
        if end <= start:
            end = start + fallback_span
        if duration > 0:
            start = min(max(0.0, start), duration)
            end = min(max(start, end), duration)
            if end <= start:
                end = min(duration, start + 0.2)

        cleaned.append({"start": start, "end": end, "text": text, "words": []})
        cursor = end

    if not cleaned:
        return []

    if duration > 0 and cleaned[-1]["end"] < duration:
        cleaned[-1]["end"] = duration
    return cleaned


def _line_segments_to_word_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    words_out: list[dict[str, Any]] = []
    for seg in segments:
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start))
        tokens = [t for t in text.split() if t]
        if not tokens:
            continue
        span = max(0.001, end - start)
        step = span / len(tokens)
        for i, token in enumerate(tokens):
            w_start = start + i * step
            w_end = start + (i + 1) * step
            words_out.append({"start": w_start, "end": w_end, "text": token, "words": []})
    return words_out


def _normalize_token(token: str) -> str:
    lowered = token.strip().lower()
    return re.sub(r"[^a-z0-9']+", "", lowered)


def _extract_words_from_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    tokens: list[dict[str, Any]] = []
    for line_idx, seg in enumerate(segments):
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        for raw in text.split():
            token = raw.strip()
            if not token:
                continue
            tokens.append({
                "line_idx": line_idx,
                "text": token,
                "norm": _normalize_token(token),
            })
    return tokens


def _extract_local_aligned_words(
    *,
    audio_path: str,
    language: str,
    cache_root: str,
) -> list[dict[str, Any]]:
    align_model = TIMING_ALIGN_MODEL if TIMING_ALIGN_MODEL in SUPPORTED_MODELS else "tiny"
    device = pick_transcription_device(align_model)
    if device == "mps":
        device = "cpu"

    model_instance = whisper.load_model(
        align_model,
        download_root=cache_root,
        device=device,
    )

    try:
        transcribe_opts: dict[str, Any] = {
            "language": None if language == "auto" else language,
            "word_timestamps": True,
            "task": "transcribe",
            "beam_size": 3,
            "best_of": 1,
            "temperature": (0.0,),
            "condition_on_previous_text": False,
        }
        if device in {"cpu", "mps"}:
            transcribe_opts["fp16"] = False

        with torch.inference_mode():
            result = model_instance.transcribe(audio_path, **transcribe_opts)

        aligned_words: list[dict[str, Any]] = []
        for segment in result.get("segments", []):
            for word in segment.get("words", []):
                raw = str(word.get("word", "")).strip()
                norm = _normalize_token(raw)
                if not norm:
                    continue
                start = float(word.get("start", segment.get("start", 0.0)))
                end = float(word.get("end", segment.get("end", start + 0.18)))
                if end <= start:
                    end = start + 0.18
                aligned_words.append({"text": raw, "norm": norm, "start": start, "end": end})

        return aligned_words
    finally:
        del model_instance
        if device == "cuda":
            torch.cuda.empty_cache()
        if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
            torch.mps.empty_cache()
        gc.collect()


def _align_cloud_words_with_local_timing(
    *,
    cloud_line_segments: list[dict[str, Any]],
    aligned_words: list[dict[str, Any]],
    duration: float,
) -> tuple[list[dict[str, Any]], float]:
    cloud_tokens = _extract_words_from_segments(cloud_line_segments)
    if not cloud_tokens or not aligned_words:
        return [], 0.0

    mapped: list[dict[str, Any]] = []
    aligned_idx = 0
    matched = 0

    for token in cloud_tokens:
        norm = token.get("norm", "")
        if not norm:
            continue

        found_idx = -1
        end_idx = min(len(aligned_words), aligned_idx + max(1, TIMING_ALIGN_LOOKAHEAD))
        for i in range(aligned_idx, end_idx):
            if aligned_words[i].get("norm") == norm:
                found_idx = i
                break

        if found_idx >= 0:
            match = aligned_words[found_idx]
            mapped.append(
                {
                    "line_idx": token["line_idx"],
                    "text": token["text"],
                    "start": float(match["start"]),
                    "end": float(match["end"]),
                    "matched": True,
                }
            )
            aligned_idx = found_idx + 1
            matched += 1
        else:
            mapped.append(
                {
                    "line_idx": token["line_idx"],
                    "text": token["text"],
                    "start": -1.0,
                    "end": -1.0,
                    "matched": False,
                }
            )

    if not mapped:
        return [], 0.0

    coverage = matched / max(1, len(mapped))

    cursor = 0.0
    for i, item in enumerate(mapped):
        if item["matched"]:
            start = max(cursor, float(item["start"]))
            end = max(start + 0.06, float(item["end"]))
            if duration > 0:
                start = min(start, duration)
                end = min(max(start + 0.06, end), duration)
            item["start"] = start
            item["end"] = end
            cursor = end
            continue

        next_start = None
        for j in range(i + 1, len(mapped)):
            if mapped[j]["matched"]:
                next_start = float(mapped[j]["start"])
                break

        synthetic_start = cursor
        synthetic_span = 0.18
        if next_start is not None and next_start > cursor:
            remaining = j - i
            synthetic_span = max(0.08, min(0.35, (next_start - cursor) / max(1, remaining + 1)))

        synthetic_end = synthetic_start + synthetic_span
        if duration > 0:
            synthetic_start = min(synthetic_start, duration)
            synthetic_end = min(max(synthetic_start + 0.06, synthetic_end), duration)

        item["start"] = synthetic_start
        item["end"] = synthetic_end
        cursor = synthetic_end

    out = [
        {"start": float(item["start"]), "end": float(item["end"]), "text": str(item["text"]), "words": []}
        for item in mapped
    ]
    return out, coverage


def _fallback_text_to_segments(text: str, duration: float, max_chars: int) -> list[dict[str, Any]]:
    normalized = " ".join(text.replace("\r", " ").replace("\n", " ").split())
    if not normalized:
        return []

    # Sentence-first split, then length-based fallback to avoid giant single blocks.
    sentence_parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", normalized) if p.strip()]
    if not sentence_parts:
        sentence_parts = [normalized]

    chunks: list[str] = []
    limit = max(40, min(120, int(max_chars)))
    for sentence in sentence_parts:
        words = sentence.split()
        current = ""
        for word in words:
            candidate = (current + " " + word).strip()
            if current and len(candidate) > limit:
                chunks.append(current)
                current = word
            else:
                current = candidate
        if current:
            chunks.append(current)

    if not chunks:
        chunks = [normalized]

    total_chars = sum(max(1, len(c)) for c in chunks)
    cursor = 0.0
    fallback_total = duration if duration > 0 else max(3.0, len(chunks) * 1.4)
    segments: list[dict[str, Any]] = []
    for idx, chunk in enumerate(chunks):
        weight = max(1, len(chunk)) / total_chars
        span = max(0.35, fallback_total * weight)
        start = cursor
        end = start + span
        if idx == len(chunks) - 1:
            end = max(end, fallback_total)
        segments.append({"start": start, "end": end, "text": chunk, "words": []})
        cursor = end

    return segments


def _gemini_cloud_transcribe(
    *,
    audio_path: str,
    mime_type: str,
    language: str,
    granularity: str,
    max_chars: int,
) -> tuple[str, list[dict[str, Any]], str]:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is missing")

    with open(audio_path, "rb") as fp:
        audio_bytes = fp.read()

    if not audio_bytes:
        raise RuntimeError("Audio file is empty")
    if len(audio_bytes) > GEMINI_CLOUD_MAX_BYTES:
        max_mb = GEMINI_CLOUD_MAX_BYTES / (1024 * 1024)
        raise RuntimeError(f"Audio too large for cloud mode (> {max_mb:.1f} MB)")

    target_lang = "auto" if language == "auto" else language
    prompt = (
        "Transcribe the audio and return ONLY valid JSON object with this shape: "
        "{\"language\":\"id|en|...\",\"segments\":[{\"start\":number,\"end\":number,\"text\":string}]}. "
        "Use seconds for start/end, monotonic increasing, no overlaps, no extra keys. "
        "Keep original spoken style and language. "
        f"language_hint={target_lang}. "
        "If uncertain, do best effort and still return valid JSON object only."
    )

    body = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": b64encode(audio_bytes).decode("ascii"),
                        }
                    },
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.0,
            "topP": 0.1,
            "maxOutputTokens": 65536,
        },
    }

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
        f"?key={GEMINI_API_KEY}"
    )
    resp = requests.post(url, json=body, timeout=180)
    resp.raise_for_status()
    payload = resp.json()
    raw_text = (
        payload.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text", "")
    )

    duration = _audio_duration_seconds(audio_path)
    obj = _extract_json_object(raw_text)
    parsed_segments = []
    detected = "unknown"

    if obj:
        detected = str(obj.get("language") or "unknown").strip().lower() or "unknown"
        maybe_segments = obj.get("segments", [])
        if isinstance(maybe_segments, list):
            parsed_segments = [item for item in maybe_segments if isinstance(item, dict)]

    # Backward compatibility if model still returns array-only.
    if not parsed_segments:
        parsed_segments = _extract_json_array(raw_text)

    if parsed_segments:
        final_segments = _sanitize_cloud_segments(parsed_segments, duration)
    else:
        fallback_text = raw_text.strip()
        if not fallback_text:
            raise RuntimeError("Gemini cloud transcription returned empty output")
        final_segments = _fallback_text_to_segments(fallback_text, duration, max_chars)

    if granularity == "word":
        final_segments = _line_segments_to_word_segments(final_segments)

    if detected == "unknown" and target_lang != "auto":
        detected = target_lang
    note = f"Cloud transcription via {GEMINI_MODEL}."
    return detected, final_segments, note


def _gemini_correct_segments(
    segments: list[dict[str, Any]],
    language: str,
) -> tuple[list[dict[str, Any]], int, int]:
    if not GEMINI_API_KEY or not segments:
        return segments, 0, 0

    corrected = [dict(seg) for seg in segments]
    chunk_indices = _chunk_segment_indices(corrected)
    changed = 0

    for indices in chunk_indices:
        lines = []
        for idx in indices:
            text = str(corrected[idx].get("text", "")).strip().replace("\n", " ")
            lines.append(f"{idx}|{text}")

        prompt = (
            "Fix ASR errors only. Keep same language. Keep meaning, slang style, and sentence count. "
            "Do not add timestamps, speakers, or explanations. "
            "Return ONLY JSON array: [{\"i\":number,\"t\":string}]."
        )
        user_input = (
            f"language_hint={language}\n"
            "items:\n"
            + "\n".join(lines)
        )

        body = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {"text": user_input},
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0.1,
                "topP": 0.8,
                "maxOutputTokens": 1400,
            },
        }

        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
            f"?key={GEMINI_API_KEY}"
        )

        try:
            resp = requests.post(url, json=body, timeout=45)
            resp.raise_for_status()
            data = resp.json()
            text = (
                data.get("candidates", [{}])[0]
                .get("content", {})
                .get("parts", [{}])[0]
                .get("text", "")
            )
            updates = _extract_json_array(text)
            for item in updates:
                i = item.get("i")
                t = str(item.get("t", "")).strip()
                if not isinstance(i, int):
                    continue
                if i < 0 or i >= len(corrected):
                    continue
                if not t:
                    continue
                prev = str(corrected[i].get("text", ""))
                if t != prev:
                    changed += 1
                corrected[i]["text"] = t
        except Exception:
            # Keep original batch on any API/parse failure for robustness.
            continue

    return corrected, changed, len(chunk_indices)


def _run_whisper_job(
    *,
    audio_path: str,
    model: str,
    language: str,
    granularity: str,
    max_chars: int,
    cache_root: str,
    device: str,
    result_path: str,
) -> None:
    model_instance = whisper.load_model(
        model,
        download_root=cache_root,
        device=device,
    )

    try:
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
            result = model_instance.transcribe(audio_path, **transcribe_opts)

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

        payload = {
            "language_detected": detected,
            "segments": segments,
        }
        with open(result_path, "w", encoding="utf-8") as fp:
            json.dump(payload, fp)
    finally:
        del model_instance
        if device == "cuda":
            torch.cuda.empty_cache()
        if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
            torch.mps.empty_cache()
        gc.collect()


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
    max_chars: int = Form(36),
    model: str = Form("small"),
    mode: str = Form("hybrid"),
) -> StreamingResponse:
    if language not in {"id", "en", "auto"}:
        raise HTTPException(status_code=400, detail="Unsupported language")

    if granularity not in {"word", "line"}:
        raise HTTPException(status_code=400, detail="Unsupported granularity")

    if model not in SUPPORTED_MODELS:
        raise HTTPException(status_code=400, detail="Unsupported model")

    if mode not in SUPPORTED_CAPTION_MODES:
        raise HTTPException(status_code=400, detail="Unsupported caption mode")

    filename = file.filename or "audio"
    mime_type = _guess_audio_mime_type(filename, file.content_type)
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

    # Check if file should be converted to reduce size
    temp_converted_path = ""
    if _should_convert_audio(total_bytes):
        temp_converted = tempfile.NamedTemporaryFile(delete=False, suffix="_converted.m4a")
        temp_converted_path = temp_converted.name
        temp_converted.close()

    def generate() -> Generator[str, None, None]:
        converted_audio_path = temp_input_path  # Default to original file
        effective_mime_type = mime_type  # Will be updated if conversion happens

        try:
            # Convert audio if needed
            if temp_converted_path:
                yield _sse("convert", f"Converting audio ({total_bytes / 1024 / 1024:.1f}MB) to optimize…", 15)
                if _convert_audio_with_ffmpeg(temp_input_path, temp_converted_path):
                    converted_size = os.path.getsize(temp_converted_path)
                    yield _sse("convert", f"Audio optimized ({converted_size / 1024 / 1024:.1f}MB)…", 18)
                    converted_audio_path = temp_converted_path
                    effective_mime_type = "audio/mp4"  # Converted output is M4A container
                else:
                    yield _sse("convert", "Audio optimization skipped, using original…", 18)

            yield _sse("read", "Reading audio file…", 20)

            if mode == "cloud":
                yield _sse("model", f"Using Gemini cloud transcription ({GEMINI_MODEL})…", 45)
                yield _sse("transcribe", "Uploading audio to Gemini cloud…", 70)
                detected, segments, cloud_note = _gemini_cloud_transcribe(
                    audio_path=converted_audio_path,
                    mime_type=effective_mime_type,
                    language=language,
                    granularity="line",
                    max_chars=max_chars,
                )
                if not segments:
                    raise RuntimeError("Cloud transcription produced no segments")

                timing_source = "cloud_segment_estimate"
                timing_quality = "estimated"
                if granularity == "word":
                    yield _sse("align", "Aligning word timings locally…", 82)
                    cache_root = whisper_cache_dir()
                    try:
                        aligned_words = _extract_local_aligned_words(
                            audio_path=converted_audio_path,
                            language=language,
                            cache_root=cache_root,
                        )
                        duration = _audio_duration_seconds(converted_audio_path)
                        aligned_segments, coverage = _align_cloud_words_with_local_timing(
                            cloud_line_segments=segments,
                            aligned_words=aligned_words,
                            duration=duration,
                        )
                        if aligned_segments and coverage >= 0.55:
                            segments = aligned_segments
                            timing_source = "cloud_text_local_word_align"
                            timing_quality = "high" if coverage >= 0.8 else "medium"
                            cloud_note = (
                                f"{cloud_note} Word timing aligned locally "
                                f"(coverage={coverage:.2f}, model={TIMING_ALIGN_MODEL})."
                            )
                        else:
                            segments = _line_segments_to_word_segments(segments)
                            timing_source = "cloud_segment_split_fallback"
                            timing_quality = "low"
                            cloud_note = (
                                f"{cloud_note} Local timing alignment coverage too low "
                                f"(coverage={coverage:.2f}), used estimated word split."
                            )
                    except Exception as align_exc:  # noqa: BLE001
                        segments = _line_segments_to_word_segments(segments)
                        timing_source = "cloud_segment_split_fallback"
                        timing_quality = "low"
                        cloud_note = f"{cloud_note} Local timing alignment failed: {align_exc}"

                yield _sse("segments", "Building caption segments…", 90)
                srt = build_srt(segments)
                yield _sse("done", "Captions ready!", 100, {
                    "result": {
                        "segments": segments,
                        "language_detected": detected,
                        "srt": srt,
                        "refined_with": "cloud",
                        "refinement_note": cloud_note,
                        "timing_source": timing_source,
                        "timing_quality": timing_quality,
                    }
                })
                return

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

            worker_device = device
            if device == "mps" and granularity == "word":
                worker_device = "cpu"
                yield _sse(
                    "model",
                    "Word-level timestamps are more stable on CPU for this device, switching worker to CPU…",
                    54,
                )

            yield _sse("model", f"Loading Whisper '{model}' model on {worker_device.upper()}…", 55)
            yield _sse("transcribe", "Transcribing audio in isolated worker…", 65)

            with tempfile.NamedTemporaryFile(delete=False, suffix="_caption_result.json") as tmp_result:
                result_path = tmp_result.name

            try:
                ctx = mp.get_context("spawn")
                process = ctx.Process(
                    target=_run_whisper_job,
                    kwargs={
                        "audio_path": converted_audio_path,
                        "model": model,
                        "language": language,
                        "granularity": granularity,
                        "max_chars": int(max_chars),
                        "cache_root": cache_root,
                        "device": worker_device,
                        "result_path": result_path,
                    },
                )
                process.start()
                while process.is_alive():
                    process.join(timeout=0.25)

                if process.exitcode != 0:
                    if worker_device != "cpu":
                        yield _sse("model", "Worker failed on current device, retrying on CPU low-memory mode…", 60)
                        process = ctx.Process(
                            target=_run_whisper_job,
                            kwargs={
                                "audio_path": converted_audio_path,
                                "model": model,
                                "language": language,
                                "granularity": granularity,
                                "max_chars": int(max_chars),
                                "cache_root": cache_root,
                                "device": "cpu",
                                "result_path": result_path,
                            },
                        )
                        process.start()
                        while process.is_alive():
                            process.join(timeout=0.25)
                        if process.exitcode != 0:
                            raise RuntimeError("Transcription worker failed on CPU mode")
                    else:
                        raise RuntimeError("Transcription worker failed")

                with open(result_path, "r", encoding="utf-8") as fp:
                    worker_payload = json.load(fp)
            finally:
                try:
                    os.remove(result_path)
                except OSError:
                    pass

            yield _sse("segments", "Building caption segments…", 85)
            detected = str(worker_payload.get("language_detected") or "unknown")
            segments = worker_payload.get("segments", [])

            refinement_note = ""
            refined_with = "local"
            if mode == "hybrid" and granularity == "line":
                if GEMINI_API_KEY:
                    yield _sse("refine", "Refining transcript with Gemini…", 92)
                    segments, changed_count, batch_count = _gemini_correct_segments(
                        segments=segments,
                        language=language,
                    )
                    refined_with = "hybrid"
                    refinement_note = (
                        f"Gemini refinement applied on {batch_count} batch(es), "
                        f"updated {changed_count} segment(s)."
                    )
                else:
                    refinement_note = "Hybrid selected but GEMINI_API_KEY is missing, used local output only."

            srt = build_srt(segments)

            yield _sse("done", "Captions ready!", 100, {
                "result": {
                    "segments": segments,
                    "language_detected": detected,
                    "srt": srt,
                    "refined_with": refined_with,
                    "refinement_note": refinement_note,
                }
            })

        except Exception as exc:  # noqa: BLE001
            yield _sse("error", f"Transcription failed: {exc}", 0, {"error": str(exc)})
        finally:
            try:
                os.remove(temp_input_path)
            except OSError:
                pass
            if temp_converted_path:
                try:
                    os.remove(temp_converted_path)
                except OSError:
                    pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
