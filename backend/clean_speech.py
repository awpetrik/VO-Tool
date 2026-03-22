from __future__ import annotations

import re
import threading
from typing import Any

import librosa
import numpy as np
import whisper
from pydub import AudioSegment, silence

DEFAULT_FILLERS = {"umm", "uhh", "ehh", "eee", "hmm", "uh", "um", "eh"}
DEFAULT_TARGET_PAUSE_MS = 800
MIN_CUT_MS = 20
MIN_PADDING_MS = 30
MAX_PADDING_MS = 50
DEFAULT_CROSSFADE_MS = 12

_MODEL_LOCK = threading.Lock()
_TINY_MODEL: Any = None


def parse_custom_fillers(custom_fillers: str) -> set[str]:
    if not custom_fillers:
        return set()
    return {_normalize_word(token) for token in custom_fillers.split(",") if _normalize_word(token)}


def _normalize_word(value: str) -> str:
    return re.sub(r"[^\w']+", "", (value or "").strip().lower())


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
) -> list[dict[str, Any]]:
    fillers = set(DEFAULT_FILLERS)
    if custom_fillers:
        fillers.update(custom_fillers)

    cuts: list[dict[str, Any]] = []
    for item in word_segments:
        token = _normalize_word(str(item.get("text", "")))
        if token not in fillers:
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

    return cuts


def detect_long_pauses(audio_segment: AudioSegment, max_pause_sec: float = 0.8) -> list[dict[str, Any]]:
    target_pause_ms = int(max(0.2, min(2.5, float(max_pause_sec))) * 1000)

    if audio_segment.duration_seconds <= 0:
        return []

    silence_thresh = audio_segment.dBFS - 16 if audio_segment.dBFS != float("-inf") else -50
    nonsilent = silence.detect_nonsilent(
        audio_segment,
        min_silence_len=120,
        silence_thresh=silence_thresh,
        seek_step=10,
    )

    if len(nonsilent) < 2:
        return []

    cuts: list[dict[str, Any]] = []
    for idx in range(len(nonsilent) - 1):
        left_end = int(nonsilent[idx][1])
        right_start = int(nonsilent[idx + 1][0])
        gap = right_start - left_end

        if gap <= target_pause_ms:
            continue

        excess = gap - target_pause_ms
        cut_start = left_end + (excess // 2)
        cut_end = right_start - (excess // 2)

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

    if filler_removal:
        words = get_word_timestamps(audio_path, language_hint=language_hint)
        filler_cuts = detect_fillers(words, audio_len_ms=len(segment), custom_fillers=parse_custom_fillers(custom_fillers))
        cuts.extend(filler_cuts)

    if silence_trim:
        pause_cuts = detect_long_pauses(segment, max_pause_sec=max_pause_sec)
        cuts.extend(pause_cuts)

    if not cuts:
        return audio_np.astype(np.float32), {
            "filler_removed": 0,
            "pause_trimmed": 0,
            "removed_ms": 0,
            "cuts_report": [],
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
        "filler_removed": len(filler_cuts),
        "pause_trimmed": len(pause_cuts),
        "removed_ms": removed_ms,
        "cuts_report": cuts_report,
    }
