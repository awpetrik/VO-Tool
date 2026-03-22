from __future__ import annotations

import json
import os
import re
import threading
from typing import Any

import librosa
import numpy as np
import requests
import whisper
from pydub import AudioSegment, silence

DEFAULT_FILLERS = {"umm", "uhh", "ehh", "eee", "hmm", "uh", "um", "eh"}
DEFAULT_TARGET_PAUSE_MS = 800
MIN_CUT_MS = 20
MIN_PADDING_MS = 30
MAX_PADDING_MS = 50
DEFAULT_CROSSFADE_MS = 12
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")

_MODEL_LOCK = threading.Lock()
_TINY_MODEL: Any = None


def parse_custom_fillers(custom_fillers: str) -> set[str]:
    if not custom_fillers:
        return set()
    return {_normalize_word(token) for token in custom_fillers.split(",") if _normalize_word(token)}


def _normalize_word(value: str) -> str:
    return re.sub(r"[^\w']+", "", (value or "").strip().lower())


def _is_unambiguous_filler(token: str) -> bool:
    """Allow stretched variants of the strict default filler family.

    Examples: ummm, uhhh, ehhh, eeee, hmmm.
    """
    if token in DEFAULT_FILLERS:
        return True
    return bool(re.fullmatch(r"u+h+m+|u+h+|u+m+|e+h+|e+|h+m+", token))


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


def _gemini_validate_ambiguous_fillers(
    word_segments: list[dict[str, Any]],
    candidate_indices: list[int],
    language_hint: str | None,
) -> tuple[set[int], dict[str, Any]]:
    if not GEMINI_API_KEY or not candidate_indices:
        return set(candidate_indices), {
            "used": False,
            "status": "skipped_no_api_key_or_candidates",
            "ambiguous_candidates": len(candidate_indices),
            "approved": len(candidate_indices),
        }

    lines: list[str] = []
    for idx in candidate_indices:
        left = max(0, idx - 3)
        right = min(len(word_segments), idx + 4)
        context = " ".join(str(word_segments[i].get("text", "")).strip() for i in range(left, right)).strip()
        token = str(word_segments[idx].get("text", "")).strip()
        lines.append(f"{idx}|token={token}|context={context}")

    prompt = (
        "Decide if each token is an unnecessary spoken filler to remove. "
        "Remove only if dropping it keeps sentence meaning and grammatical flow. "
        "Be conservative for Indonesian discourse markers. "
        "Return ONLY JSON array: [{\"i\":number,\"remove\":boolean}]."
    )
    user_input = (
        f"language_hint={(language_hint or 'auto').strip()}\n"
        "candidates:\n"
        + "\n".join(lines)
    )

    body = {
        "contents": [{"parts": [{"text": prompt}, {"text": user_input}]}],
        "generationConfig": {
            "temperature": 0.0,
            "topP": 0.8,
            "maxOutputTokens": 1200,
        },
    }

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
        f"?key={GEMINI_API_KEY}"
    )

    try:
        resp = requests.post(url, json=body, timeout=35)
        resp.raise_for_status()
        data = resp.json()
        text = (
            data.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        )
        parsed = _extract_json_array(text)
        approved: set[int] = set()
        for item in parsed:
            i = item.get("i")
            remove = bool(item.get("remove", False))
            if isinstance(i, int) and remove:
                approved.add(i)
        # If parsing fails or model returns nothing usable, fallback to conservative no-removal.
        return approved, {
            "used": True,
            "status": "ok",
            "ambiguous_candidates": len(candidate_indices),
            "approved": len(approved),
        }
    except Exception:
        # Fallback behavior: keep original custom behavior if API fails.
        return set(candidate_indices), {
            "used": True,
            "status": "fallback_on_error",
            "ambiguous_candidates": len(candidate_indices),
            "approved": len(candidate_indices),
        }


def _get_tiny_model() -> Any:
    global _TINY_MODEL
    if _TINY_MODEL is not None:
        return _TINY_MODEL
    with _MODEL_LOCK:
        if _TINY_MODEL is None:
            _TINY_MODEL = whisper.load_model("tiny")
    return _TINY_MODEL


def get_word_timestamps(audio_path: str, language_hint: str | None = None) -> list[dict[str, Any]]:
    model = _get_tiny_model()
    hint = (language_hint or "").strip().lower()
    language = None if hint in {"", "auto"} else hint
    result = model.transcribe(
        audio_path,
        word_timestamps=True,
        language=language,
        verbose=False,
        fp16=False,
    )

    words: list[dict[str, Any]] = []
    for segment in result.get("segments", []):
        for word in segment.get("words", []):
            start = int(max(0.0, float(word.get("start", 0.0))) * 1000)
            end = int(max(0.0, float(word.get("end", 0.0))) * 1000)
            text = (word.get("word") or "").strip()
            if text and end > start:
                words.append({"text": text, "start_ms": start, "end_ms": end})
    return words


def numpy_to_pydub(audio_np: np.ndarray, sr: int) -> AudioSegment:
    clipped = np.clip(audio_np, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16).tobytes()
    return AudioSegment(data=pcm, sample_width=2, frame_rate=int(sr), channels=1)


def pydub_to_numpy(audio_segment: AudioSegment, target_sr: int) -> np.ndarray:
    arr = np.array(audio_segment.get_array_of_samples(), dtype=np.float32)
    if audio_segment.channels > 1:
        arr = arr.reshape((-1, audio_segment.channels)).mean(axis=1)

    scale = float(1 << (8 * audio_segment.sample_width - 1))
    audio_np = arr / scale
    source_sr = int(audio_segment.frame_rate)
    if source_sr != int(target_sr):
        audio_np = librosa.resample(audio_np, orig_sr=source_sr, target_sr=int(target_sr))
    return audio_np.astype(np.float32)


def detect_fillers(
    word_segments: list[dict[str, Any]],
    audio_len_ms: int,
    custom_fillers: set[str] | None = None,
    language_hint: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    custom = set(custom_fillers or set())
    ambiguous_candidate_indices: list[int] = []
    approved_ambiguous: set[int] = set()
    gemini_meta: dict[str, Any] = {
        "used": False,
        "status": "not_needed",
        "ambiguous_candidates": 0,
        "approved": 0,
    }

    cuts: list[dict[str, Any]] = []
    for idx, item in enumerate(word_segments):
        token = _normalize_word(str(item.get("text", "")))
        if not token:
            continue

        is_default = _is_unambiguous_filler(token)
        is_custom_ambiguous = token in custom and not is_default

        if not is_default and not is_custom_ambiguous:
            continue

        if is_custom_ambiguous:
            ambiguous_candidate_indices.append(idx)
            continue

        start = int(item.get("start_ms", 0))
        end = int(item.get("end_ms", 0))
        if end <= start:
            continue

        raw_len = end - start
        dynamic_pad = int(max(MIN_PADDING_MS, min(MAX_PADDING_MS, raw_len * 0.25)))

        # Keep safety margin around neighboring speech to avoid robotic, surgical cuts.
        cut_start = max(0, start + dynamic_pad)
        cut_end = min(audio_len_ms, end - dynamic_pad)

        if cut_end - cut_start < MIN_CUT_MS:
            continue

        cuts.append(
            {
                "type": "filler",
                "text": str(item.get("text", "")).strip(),
                "start_ms": cut_start,
                "end_ms": cut_end,
            }
        )

    if ambiguous_candidate_indices:
        approved_ambiguous, gemini_meta = _gemini_validate_ambiguous_fillers(
            word_segments,
            ambiguous_candidate_indices,
            language_hint=language_hint,
        )

    for idx in ambiguous_candidate_indices:
        if idx not in approved_ambiguous:
            continue

        item = word_segments[idx]
        start = int(item.get("start_ms", 0))
        end = int(item.get("end_ms", 0))
        if end <= start:
            continue

        raw_len = end - start
        dynamic_pad = int(max(MIN_PADDING_MS, min(MAX_PADDING_MS, raw_len * 0.25)))
        cut_start = max(0, start + dynamic_pad)
        cut_end = min(audio_len_ms, end - dynamic_pad)
        if cut_end - cut_start < MIN_CUT_MS:
            continue

        cuts.append(
            {
                "type": "filler",
                "text": str(item.get("text", "")).strip(),
                "start_ms": cut_start,
                "end_ms": cut_end,
            }
        )

    return cuts, gemini_meta


def detect_long_pauses(audio_segment: AudioSegment, max_pause_sec: float = 0.8) -> list[dict[str, Any]]:
    target_pause_ms = int(max(0.2, min(2.5, float(max_pause_sec))) * 1000)

    if audio_segment.duration_seconds <= 0:
        return []

    silence_thresh = audio_segment.dBFS - 18 if audio_segment.dBFS != float("-inf") else -50
    silence_regions = silence.detect_silence(
        audio_segment,
        min_silence_len=160,
        silence_thresh=silence_thresh,
        seek_step=10,
    )

    if not silence_regions:
        return []

    cuts: list[dict[str, Any]] = []
    for region in silence_regions:
        start_ms = int(region[0])
        end_ms = int(region[1])
        gap = end_ms - start_ms

        if gap <= target_pause_ms:
            continue

        excess = gap - target_pause_ms
        cut_start = start_ms + (excess // 2)
        cut_end = end_ms - (excess // 2)

        if cut_end - cut_start < MIN_CUT_MS:
            continue

        cuts.append({"type": "pause", "start_ms": cut_start, "end_ms": cut_end})

    return cuts


def merge_overlapping_cuts(cuts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not cuts:
        return []

    ordered = sorted(cuts, key=lambda c: (int(c["start_ms"]), int(c["end_ms"])))
    merged: list[dict[str, Any]] = []

    for cut in ordered:
        start = int(cut["start_ms"])
        end = int(cut["end_ms"])
        if end <= start:
            continue

        if not merged:
            merged.append({"start_ms": start, "end_ms": end})
            continue

        prev = merged[-1]
        if start <= int(prev["end_ms"]):
            prev["end_ms"] = max(int(prev["end_ms"]), end)
        else:
            merged.append({"start_ms": start, "end_ms": end})

    return merged


def apply_cuts(
    audio_segment: AudioSegment,
    cuts: list[dict[str, Any]],
    crossfade_ms: int = DEFAULT_CROSSFADE_MS,
) -> AudioSegment:
    merged = merge_overlapping_cuts(cuts)
    if not merged:
        return audio_segment

    output = audio_segment
    for cut in sorted(merged, key=lambda c: int(c["start_ms"]), reverse=True):
        start = int(max(0, cut["start_ms"]))
        end = int(min(len(output), cut["end_ms"]))
        if end <= start:
            continue

        left = output[:start]
        right = output[end:]

        # Avoid crossfading ultra-short segments to prevent crashes/artifacts.
        if len(left) <= crossfade_ms or len(right) <= crossfade_ms:
            output = left + right
        else:
            output = left.append(right, crossfade=crossfade_ms)

    return output


def run_clean_speech(
    audio_np: np.ndarray,
    sr: int,
    audio_path: str,
    *,
    filler_removal: bool,
    silence_trim: bool,
    max_pause_sec: float,
    custom_fillers: str,
    language_hint: str | None = None,
) -> tuple[np.ndarray, dict[str, Any]]:
    segment = numpy_to_pydub(audio_np, sr)

    cuts: list[dict[str, Any]] = []
    filler_cuts: list[dict[str, Any]] = []
    pause_cuts: list[dict[str, Any]] = []
    gemini_meta: dict[str, Any] = {
        "used": False,
        "status": "not_needed",
        "ambiguous_candidates": 0,
        "approved": 0,
    }

    if filler_removal:
        words = get_word_timestamps(audio_path, language_hint=language_hint)
        filler_cuts, gemini_meta = detect_fillers(
            words,
            audio_len_ms=len(segment),
            custom_fillers=parse_custom_fillers(custom_fillers),
            language_hint=language_hint,
        )
        cuts.extend(filler_cuts)

    if silence_trim:
        pause_cuts = detect_long_pauses(segment, max_pause_sec=max_pause_sec)
        cuts.extend(pause_cuts)

    if not cuts:
        return audio_np.astype(np.float32), {
            "enabled": {"filler_removal": filler_removal, "silence_trim": silence_trim},
            "filler_removed": 0,
            "pause_trimmed": 0,
            "removed_ms": 0,
            "cuts_report": [],
            "gemini": gemini_meta,
        }

    cleaned = apply_cuts(segment, cuts, crossfade_ms=DEFAULT_CROSSFADE_MS)

    cuts_report = sorted(
        [
            {
                "type": item.get("type", "unknown"),
                "start_ms": int(item.get("start_ms", 0)),
                "end_ms": int(item.get("end_ms", 0)),
                "text": item.get("text", "") or "",
            }
            for item in cuts
        ],
        key=lambda row: (row["start_ms"], row["end_ms"]),
    )

    removed_ms = max(0, len(segment) - len(cleaned))
    return pydub_to_numpy(cleaned, sr), {
        "enabled": {"filler_removal": filler_removal, "silence_trim": silence_trim},
        "filler_removed": len(filler_cuts),
        "pause_trimmed": len(pause_cuts),
        "removed_ms": removed_ms,
        "cuts_report": cuts_report,
        "gemini": gemini_meta,
    }
