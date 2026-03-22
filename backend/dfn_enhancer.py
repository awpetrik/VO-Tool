from __future__ import annotations

# pyright: reportMissingImports=false

import sys
import threading
import types
from typing import Any

import librosa
import numpy as np
import torch


def _install_torchaudio_backend_compat():
    """Inject a compatibility shim for torchaudio.backend.common.AudioMetaData.

    Newer torchaudio (>=2.0) removed torchaudio.backend.common.  DeepFilterNet 0.5.6
    still imports AudioMetaData from there.  We provide a lightweight dataclass stand-in
    so the import succeeds without requiring a torchaudio downgrade.
    """
    if "torchaudio.backend.common" in sys.modules:
        return  # already present or already patched

    try:
        import torchaudio  # noqa: F401
    except ImportError:
        return  # torchaudio not installed; nothing to patch

    import dataclasses

    @dataclasses.dataclass
    class AudioMetaData:
        sample_rate: int = 0
        num_frames: int = 0
        num_channels: int = 0
        bits_per_sample: int = 0
        encoding: str = ""

    # Create the stub submodule hierarchy: torchaudio.backend, torchaudio.backend.common
    import torchaudio as _ta

    if not hasattr(_ta, "backend"):
        backend_mod = types.ModuleType("torchaudio.backend")
        _ta.backend = backend_mod  # type: ignore[attr-defined]
        sys.modules["torchaudio.backend"] = backend_mod

    backend_common = types.ModuleType("torchaudio.backend.common")
    backend_common.AudioMetaData = AudioMetaData  # type: ignore[attr-defined]
    sys.modules["torchaudio.backend.common"] = backend_common
    _ta.backend.common = backend_common  # type: ignore[attr-defined]

    # Also patch torchaudio.info if it's missing (needed by df/io.py: ta.info())
    if not hasattr(_ta, "info"):
        import soundfile as _sf

        def _info_compat(path, **_kwargs):
            _info = _sf.info(path)
            return AudioMetaData(
                sample_rate=_info.samplerate,
                num_frames=_info.frames,
                num_channels=_info.channels,
                bits_per_sample=16,
                encoding="PCM_S",
            )

        _ta.info = _info_compat  # type: ignore[attr-defined]

_DFN_CACHE: dict[str, tuple[Any, Any, int]] = {}
_DFN_LOCK = threading.Lock()


def _preferred_devices(prefer_gpu: bool = True) -> list[str]:
    devices: list[str] = []
    if prefer_gpu:
        if torch.cuda.is_available():
            devices.append("cuda")
        mps_backend = getattr(torch.backends, "mps", None)
        if mps_backend and mps_backend.is_available():
            devices.append("mps")
    devices.append("cpu")
    return devices


def _state_sr(state: Any, fallback: int) -> int:
    try:
        sr_attr = getattr(state, "sr", None)
        if callable(sr_attr):
            return int(sr_attr())
        if isinstance(sr_attr, (int, float)):
            return int(sr_attr)
    except Exception:  # noqa: BLE001
        pass
    return int(fallback)


def _extract_model_and_state(init_output: Any) -> tuple[Any, Any]:
    if isinstance(init_output, tuple):
        if len(init_output) >= 2:
            return init_output[0], init_output[1]
        if len(init_output) == 1:
            return init_output[0], None
    return init_output, None


def _init_dfn_on_device(device: str, fallback_sr: int) -> tuple[Any, Any, int]:
    with _DFN_LOCK:
        cached = _DFN_CACHE.get(device)
        if cached is not None:
            return cached

        _install_torchaudio_backend_compat()
        from df.enhance import init_df  # Imported lazily so package stays optional at import time.

        init_output: Any
        try:
            init_output = init_df(device=device)
        except TypeError:
            init_output = init_df()

        model, state = _extract_model_and_state(init_output)
        if hasattr(model, "to"):
            try:
                model = model.to(device)
            except Exception:  # noqa: BLE001
                # If model cannot move to device, runtime call will fail and fall back to next device.
                pass

        target_sr = _state_sr(state, fallback_sr)
        payload = (model, state, target_sr)
        _DFN_CACHE[device] = payload
        return payload


def _run_enhance(model: Any, state: Any, audio_tensor: torch.Tensor) -> Any:
    from df.enhance import enhance

    try:
        return enhance(model, state, audio_tensor)
    except TypeError:
        try:
            return enhance(model, state, audio_tensor, pad=True)
        except TypeError:
            return enhance(model, state, audio_tensor, pad=True, atten_lim_db=12)


def _to_mono_numpy(output: Any) -> np.ndarray:
    if isinstance(output, tuple):
        output = output[0]

    if isinstance(output, torch.Tensor):
        arr = output.detach().cpu().float().numpy()
    elif isinstance(output, np.ndarray):
        arr = output.astype(np.float32)
    else:
        arr = np.asarray(output, dtype=np.float32)

    if arr.ndim == 0:
        return np.zeros(1, dtype=np.float32)
    if arr.ndim == 1:
        return arr.astype(np.float32)

    # Expected shape from many speech models is [C, T]. Collapse to mono safely.
    return np.mean(arr, axis=0).astype(np.float32)


def apply_dfn(signal: np.ndarray, sr: int, prefer_gpu: bool = True) -> tuple[np.ndarray, dict[str, Any]]:
    report: dict[str, Any] = {
        "requested": True,
        "applied": False,
        "device": "none",
        "reason": "",
        "tried_devices": [],
    }

    try:
        _install_torchaudio_backend_compat()
        __import__("df.enhance")
    except Exception as exc:  # noqa: BLE001
        report["reason"] = f"deepfilternet_not_available: {exc}"
        return signal.astype(np.float32), report

    devices = _preferred_devices(prefer_gpu=prefer_gpu)

    for device in devices:
        report["tried_devices"].append(device)
        try:
            model, state, dfn_sr = _init_dfn_on_device(device, fallback_sr=sr)

            work = signal.astype(np.float32)
            if dfn_sr != int(sr):
                work = librosa.resample(work, orig_sr=int(sr), target_sr=int(dfn_sr)).astype(np.float32)

            audio_tensor = torch.from_numpy(work)
            if audio_tensor.ndim == 1:
                audio_tensor = audio_tensor.unsqueeze(0)
            audio_tensor = audio_tensor.to(device)

            with torch.no_grad():
                enhanced = _run_enhance(model, state, audio_tensor)

            enhanced_np = _to_mono_numpy(enhanced)
            if dfn_sr != int(sr):
                enhanced_np = librosa.resample(enhanced_np, orig_sr=int(dfn_sr), target_sr=int(sr)).astype(np.float32)

            report.update({"applied": True, "device": device, "reason": "ok"})
            return enhanced_np.astype(np.float32), report
        except Exception as exc:  # noqa: BLE001
            report["reason"] = f"{device}_failed: {exc}"
            continue

    if not report["reason"]:
        report["reason"] = "all_devices_failed"
    return signal.astype(np.float32), report
