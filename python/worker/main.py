"""
Stem Monitor Desktop 鈥?Python Worker

JSON-line stdio 鍗忚瀹炵幇 + Demucs 鍒嗙寮曟搸鎺ュ叆銆?
鍗忚瑙勮寖锛?- stdin: 鎺ユ敹 JSON-line 璇锋眰锛堟瘡琛屼竴涓?JSON 瀵硅薄锛?- stdout: 杈撳嚭 JSON-line 鍝嶅簲/浜嬩欢锛堟瘡琛屼竴涓?JSON 瀵硅薄锛?- stderr: 鏃ュ織杈撳嚭锛圼LEVEL] 鍓嶇紑鏍煎紡锛?
鏀寔鐨勫懡浠わ細
- health_check: 鍋ュ悍妫€鏌?ping/pong
- start_separation: 璋冪敤 Demucs 鍒嗙闊抽

娑堟伅鏍煎紡涓ユ牸鍏煎 TS 渚?WorkerMessageType / WorkerCommand / WorkerEventName 鏋氫妇銆?"""

import json
import sys
import os
import shlex
import subprocess
import threading
import traceback
import time
import tempfile
import wave
import shutil
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple, Optional, Protocol, Set
from stem_routing import build_stem_routing_plan
from runtime_profiles import (
    ExecutionRequest,
    ExecutionResult,
    ProcessLauncher,
    RuntimeHealthChecker,
    RuntimeProfile,
    RuntimeProfileRegistry,
    RuntimeResolution,
    RuntimeResolver,
)

try:
    import psutil  # type: ignore
except Exception:
    psutil = None  # type: ignore

# Phase 2 defaults to stable 4-stem htdemucs.
# Phase 2.5 can switch by env DEMUCS_MODEL=htdemucs_6s without protocol changes.
DEFAULT_DEMUCS_MODEL = "htdemucs"
ALLOWED_DEMUCS_MODELS = {"htdemucs", "htdemucs_6s"}
MODEL_OUTPUT_FILENAMES = {
    "htdemucs": ["vocals.wav", "drums.wav", "bass.wav", "other.wav"],
    "htdemucs_6s": ["vocals.wav", "drums.wav", "bass.wav", "guitar.wav", "piano.wav", "other.wav"],
}
MODEL_SUPPORTED_STEM_TYPES = {
    "htdemucs": ["vocal", "drums", "bass", "other"],
    "htdemucs_6s": ["vocal", "drums", "bass", "guitar", "keyboard", "other"],
}

DEFAULT_SEPARATION_ENGINE = "demucs"
ALLOWED_SEPARATION_ENGINES = {"demucs", "bs_roformer_sw"}
ENV_WORKER_PYTHON_EXE = "WORKER_PYTHON_EXE"
ENV_DEMUCS_PYTHON_EXE = "DEMUCS_PYTHON_EXE"
ENV_DEMUCS_6S_PILOT_PYTHON_EXE = "DEMUCS_6S_PILOT_PYTHON_EXE"
ENV_DEMUCS_6S_PILOT_ENV_ROOT = "DEMUCS_6S_PILOT_ENV_ROOT"
ENV_DEMUCS_RUNTIME_PROFILE = "DEMUCS_RUNTIME_PROFILE"
ENV_ANALYSIS_RUNTIME_PROFILE = "ANALYSIS_RUNTIME_PROFILE"
ENV_STEM_ROUTING_CONFIG_JSON = "STEM_ROUTING_CONFIG_JSON"
ENV_CHORD_ANALYZER = "CHORD_ANALYZER"
ENV_TEMPO_ANALYZER = "TEMPO_ANALYZER"

DEFAULT_CHORD_ANALYZER_ID = "chord_rule_chroma_v1"
DEFAULT_TEMPO_ANALYZER_ID = "tempo_rule_onset_v1"
DEFAULT_ANALYSIS_RUNTIME_PROFILE_ID = "analysis_default"
DEFAULT_DEMUCS_RUNTIME_PROFILE_ID = "demucs_env_override"
PILOT_DEMUCS_RUNTIME_PROFILE_ID = "demucs_6s_pilot"

BS_OUTPUT_CANONICAL_FILENAMES = {
    "vocals": "vocals.wav",
    "drums": "drums.wav",
    "bass": "bass.wav",
    "guitar": "guitar.wav",
    "piano": "piano.wav",
    "other": "other.wav",
}
BS_SUPPORTED_STEM_TYPES = ["vocal", "drums", "bass", "guitar", "keyboard", "other"]

ANALYSIS_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
KEY_PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KEY_PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

# Chord/Key stability thresholds (Phase: minimal stability enhancement, easy rollback).
KEY_CONFIDENCE_MARGIN = 0.035
CHORD_MIN_SEGMENT_MS = 160
CHORD_MERGE_THRESHOLD_MS = 220
CHORD_DEJITTER_CONFIDENCE_MAX = 0.45
CHORD_SHORT_SEGMENT_CONFIDENCE_MAX = 0.60


def log(level: str, message: str) -> None:
    """Write structured log to stderr."""
    print(f"[{level}] {message}", file=sys.stderr, flush=True)


def send_response(request_id: str, success: bool, data: dict = None, error: dict = None) -> None:
    """Send one JSON-line response to stdout."""
    msg = {
        "type": "response",
        "id": request_id,
        "success": success,
    }
    if data is not None:
        msg["data"] = data
    if error is not None:
        msg["error"] = error
    data_keys = sorted(list(data.keys())) if isinstance(data, dict) else []
    stems_count = len(data.get("stems", [])) if isinstance(data, dict) and isinstance(data.get("stems"), list) else 0
    error_code = error.get("code", "") if isinstance(error, dict) else ""
    log(
        "INFO",
        f"[REAL_CHAIN] ipc_sending_response requestId={request_id} success={success} "
        f"data_keys={data_keys} stems_count={stems_count} error_code={error_code}",
    )
    print(json.dumps(msg, ensure_ascii=False), flush=True)


def send_event(event_name: str, payload: dict) -> None:
    """Send one JSON-line event to stdout."""
    msg = {
        "type": "event",
        "eventName": event_name,
        "payload": payload,
    }
    print(json.dumps(msg, ensure_ascii=False), flush=True)


def handle_health_check(request_id: str, payload: dict) -> None:
    """Handle health_check command."""
    send_response(request_id, True, data={})


def get_file_info(file_path: str) -> dict:
    """Get basic file info."""
    stat = os.stat(file_path)
    ext = os.path.splitext(file_path)[1].lstrip(".").lower()
    codec = ext if ext else "wav"
    return {
        "sizeBytes": stat.st_size,
        "codec": codec,
    }


def get_audio_duration_ms(file_path: str) -> int:
    """
    Best-effort duration reader.
    - WAV: stdlib wave
    - Others: torchaudio.info when available
    Returns 0 on failure.
    """
    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".wav":
        try:
            with wave.open(file_path, "rb") as wav:
                frame_rate = wav.getframerate()
                frame_count = wav.getnframes()
                if frame_rate > 0:
                    return int((frame_count / frame_rate) * 1000)
        except Exception:
            return 0

    try:
        import torchaudio  # type: ignore
        info = torchaudio.info(file_path)
        if info and info.sample_rate and info.num_frames:
            return int((info.num_frames / info.sample_rate) * 1000)
    except Exception:
        return 0

    return 0


def resolve_source_duration_ms(engine_result: dict) -> int:
    """
    Resolve source duration without probing original input again.
    Priority:
    1) engine_result.sourceDurationMs
    2) max(stem.durationMs)
    3) 0
    """
    try:
        direct = engine_result.get("sourceDurationMs")
        if isinstance(direct, (int, float)) and direct > 0:
            return int(direct)
    except Exception:
        pass

    stems = engine_result.get("stems", [])
    if isinstance(stems, list):
        max_duration = 0
        for stem in stems:
            if not isinstance(stem, dict):
                continue
            duration = stem.get("durationMs")
            if isinstance(duration, (int, float)) and duration > max_duration:
                max_duration = int(duration)
        if max_duration > 0:
            return max_duration
    return 0


def load_audio_mono(file_path: str, target_sr: Optional[int] = None) -> Tuple["List[float]", int]:
    """
    Load audio as mono float samples.
    Priority:
    1) torchaudio (usually available with demucs env)
    2) librosa fallback
    Raises RuntimeError if both backends are unavailable.
    """
    try:
        import torch  # type: ignore
        import torchaudio  # type: ignore

        waveform, sr = torchaudio.load(file_path)
        # waveform shape: [channels, samples]
        if waveform.ndim == 2 and waveform.size(0) > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        if waveform.ndim == 2:
            waveform = waveform.squeeze(0)

        if target_sr and sr != target_sr:
            waveform = torchaudio.functional.resample(waveform, sr, target_sr)
            sr = target_sr

        # torch tensor -> python list
        if isinstance(waveform, torch.Tensor):
            return waveform.detach().cpu().float().tolist(), int(sr)
        return list(waveform), int(sr)
    except Exception:
        pass

    try:
        import librosa  # type: ignore

        y, sr = librosa.load(file_path, sr=target_sr, mono=True)
        return y.astype("float32").tolist(), int(sr)
    except Exception as exc:
        raise RuntimeError(
            "No usable audio backend found (torchaudio/librosa). "
            "Please install analysis dependencies."
        ) from exc


def build_waveform_peaks(samples: List[float], peak_count: int) -> List[float]:
    if peak_count <= 0:
        peak_count = 1200
    if not samples:
        return []

    total = len(samples)
    if total <= peak_count:
        # Keep direct shape when very short.
        return [float(max(-1.0, min(1.0, x))) for x in samples]

    try:
        import numpy as np  # type: ignore
    except Exception:
        # Pure-python fallback (slower, but keeps command available)
        window = max(1, total // peak_count)
        peaks: List[float] = []
        i = 0
        while i < total:
            chunk = samples[i:i + window]
            if not chunk:
                break
            abs_vals = [abs(v) for v in chunk]
            abs_vals.sort()
            p95 = abs_vals[int((len(abs_vals) - 1) * 0.95)] if abs_vals else 0.0
            rms = (sum((v * v) for v in chunk) / max(len(chunk), 1)) ** 0.5
            # Conservative blend:
            # - RMS tracks sustained energy
            # - p95 keeps onset/transient events without max-abs over-saturation
            amp = max(rms * 1.45, p95 * 0.50)
            peaks.append(float(max(0.0, min(1.0, amp))))
            i += window
        return peaks

    arr = np.asarray(samples, dtype=np.float32)
    window = max(1, int(arr.shape[0] // peak_count))
    peaks: List[float] = []
    for i in range(0, arr.shape[0], window):
        chunk = arr[i:i + window]
        if chunk.size == 0:
            continue
        p95 = float(np.percentile(np.abs(chunk), 95))
        rms = float(np.sqrt(np.mean(np.square(chunk))))
        amp = max(rms * 1.45, p95 * 0.50)
        peaks.append(max(0.0, min(1.0, amp)))
    return peaks


def handle_generate_waveform(request_id: str, payload: dict) -> None:
    file_path = payload.get("filePath", "")
    project_id = payload.get("projectId", "")
    peak_count_raw = payload.get("peakCount", 1200)
    peak_count = int(peak_count_raw) if isinstance(peak_count_raw, (int, float)) else 1200

    if not file_path or not os.path.isfile(file_path):
        send_response(request_id, False, error={
            "code": "INPUT_FILE_NOT_FOUND",
            "message": f"Source file not found: {file_path}",
        })
        return

    started_at = time.time()
    log("INFO", f"[REAL_CHAIN] generate_waveform begin request_id={request_id} project_id={project_id} file_path={file_path}")

    try:
        samples, sr = load_audio_mono(file_path)
        peaks = build_waveform_peaks(samples, peak_count)
        duration_ms = int((len(samples) / sr) * 1000) if sr > 0 else 0
        reduced_sr = int(round((len(peaks) / max(duration_ms, 1)) * 1000)) if duration_ms > 0 else 100
        elapsed_ms = int((time.time() - started_at) * 1000)

        send_response(request_id, True, data={
            "id": "master",
            "channels": 1,
            "length": len(peaks),
            "sampleRate": max(1, reduced_sr),
            "peaks": peaks,
            "durationMs": duration_ms,
            "elapsedMs": elapsed_ms,
            "analysisVersion": "waveform-v1",
        })
        log("INFO", f"[REAL_CHAIN] generate_waveform complete request_id={request_id} peaks={len(peaks)} elapsed_ms={elapsed_ms}")
    except Exception as exc:
        message = str(exc)
        code = "ANALYSIS_DEPENDENCY_MISSING" if "audio backend" in message.lower() else "ENGINE_CRASH"
        log("ERROR", f"[REAL_CHAIN] generate_waveform failed request_id={request_id} error={message}")
        send_response(request_id, False, error={
            "code": code,
            "message": message,
        })


def estimate_key_from_chroma(chroma_mean: "List[float]") -> Tuple[str, float]:
    try:
        import numpy as np  # type: ignore
    except Exception:
        return "Unknown", 0.0

    if not chroma_mean or len(chroma_mean) != 12:
        return "Unknown", 0.0

    chroma = np.asarray(chroma_mean, dtype=np.float32)
    if np.allclose(chroma.sum(), 0.0):
        return "Unknown", 0.0
    chroma = chroma / max(float(chroma.sum()), 1e-8)

    major = np.asarray(KEY_PROFILE_MAJOR, dtype=np.float32)
    minor = np.asarray(KEY_PROFILE_MINOR, dtype=np.float32)
    major = major / major.sum()
    minor = minor / minor.sum()

    scored_keys: List[Tuple[str, float]] = []
    for i, note in enumerate(ANALYSIS_NOTE_NAMES):
        major_score = float(np.dot(chroma, np.roll(major, i)))
        scored_keys.append((f"{note} major", major_score))
        minor_score = float(np.dot(chroma, np.roll(minor, i)))
        scored_keys.append((f"{note} minor", minor_score))

    if not scored_keys:
        return "Unknown", 0.0

    scored_keys.sort(key=lambda x: x[1], reverse=True)
    top1_label, top1_score = scored_keys[0]
    top2_score = scored_keys[1][1] if len(scored_keys) > 1 else 0.0
    margin = float(top1_score - top2_score)
    return top1_label, margin


def extract_chord_segments_from_chroma(
    chroma: "List[List[float]]",
    sr: int,
    hop_length: int,
) -> Tuple[List[dict], List[str]]:
    """
    Very small rule-based chord framework:
    - triad templates (major/minor)
    - frame-wise classification
    - consecutive merge
    """
    try:
        import numpy as np  # type: ignore
    except Exception as exc:
        raise RuntimeError("numpy is required for chord extraction") from exc

    arr = np.asarray(chroma, dtype=np.float32)  # [12, frames]
    if arr.ndim != 2 or arr.shape[0] != 12 or arr.shape[1] == 0:
        return [], ["和弦特征不足，未生成片段"]

    templates: List[Tuple[str, np.ndarray]] = []
    for i, note in enumerate(ANALYSIS_NOTE_NAMES):
        major = np.zeros((12,), dtype=np.float32)
        major[i] = 1.0
        major[(i + 4) % 12] = 0.85
        major[(i + 7) % 12] = 0.85
        templates.append((note, major))

        minor = np.zeros((12,), dtype=np.float32)
        minor[i] = 1.0
        minor[(i + 3) % 12] = 0.85
        minor[(i + 7) % 12] = 0.85
        templates.append((f"{note}m", minor))

    labels: List[str] = []
    confidences: List[float] = []

    for frame_idx in range(arr.shape[1]):
        frame = arr[:, frame_idx]
        energy = float(np.sum(frame))
        if energy <= 1e-8:
            labels.append("N")
            confidences.append(0.0)
            continue
        frame_norm = frame / energy

        scored: List[Tuple[str, float]] = []
        for name, tpl in templates:
            tpl_norm = tpl / max(float(np.sum(tpl)), 1e-8)
            score = float(np.dot(frame_norm, tpl_norm))
            scored.append((name, score))

        scored.sort(key=lambda x: x[1], reverse=True)
        best_label, best_score = scored[0]
        second_score = scored[1][1] if len(scored) > 1 else 0.0
        conf = max(0.0, min(1.0, (best_score - second_score) / max(best_score, 1e-8)))
        labels.append(best_label)
        confidences.append(conf)

    # Merge consecutive labels into segments
    frame_ms = (hop_length / max(sr, 1)) * 1000.0
    segments: List[dict] = []
    start_idx = 0
    current = labels[0]

    def append_segment(seg_label: str, seg_start: int, seg_end: int) -> None:
        if seg_end <= seg_start:
            return
        start_ms = int(round(seg_start * frame_ms))
        end_ms = int(round(seg_end * frame_ms))
        mean_conf = float(sum(confidences[seg_start:seg_end]) / max(seg_end - seg_start, 1))
        segments.append({
            "startMs": max(0, start_ms),
            "endMs": max(0, end_ms),
            "label": seg_label,
            "simplifiedLabel": seg_label,
            "confidence": max(0.0, min(1.0, mean_conf)),
            "sourceFlags": ["mixed"],
        })

    for i in range(1, len(labels)):
        if labels[i] != current:
            append_segment(current, start_idx, i)
            start_idx = i
            current = labels[i]
    append_segment(current, start_idx, len(labels))

    # Phase 1 minimal stability enhancement:
    # 1) de-jitter tiny bridge segment between same-labeled neighbors
    smoothed: List[dict] = []
    i = 0
    while i < len(segments):
        if i == 0 or i >= len(segments) - 1:
            smoothed.append(segments[i])
            i += 1
            continue

        prev_seg = smoothed[-1]
        curr_seg = segments[i]
        next_seg = segments[i + 1]
        curr_duration = curr_seg["endMs"] - curr_seg["startMs"]
        curr_conf = float(curr_seg.get("confidence", 0.0))
        if (
            curr_duration <= CHORD_MERGE_THRESHOLD_MS
            and curr_conf <= CHORD_DEJITTER_CONFIDENCE_MAX
            and prev_seg["label"] == next_seg["label"]
        ):
            prev_seg["endMs"] = next_seg["endMs"]
            prev_seg["confidence"] = max(
                float(prev_seg.get("confidence", 0.0)),
                curr_conf,
                float(next_seg.get("confidence", 0.0)),
            )
            i += 2
            continue

        smoothed.append(curr_seg)
        i += 1

    # 2) remove very short low-confidence segments (conservative)
    compact: List[dict] = []
    for seg in smoothed:
        duration = seg["endMs"] - seg["startMs"]
        if (
            compact
            and duration < CHORD_MIN_SEGMENT_MS
            and float(seg.get("confidence", 0.0)) <= CHORD_SHORT_SEGMENT_CONFIDENCE_MAX
        ):
            compact[-1]["endMs"] = seg["endMs"]
            compact[-1]["confidence"] = max(
                float(compact[-1].get("confidence", 0.0)),
                float(seg.get("confidence", 0.0)),
            )
        else:
            compact.append(seg)

    warnings: List[str] = []
    low_conf_ratio = 0.0
    if compact:
        low_conf_count = sum(1 for s in compact if float(s["confidence"]) < 0.2)
        low_conf_ratio = low_conf_count / len(compact)
    if low_conf_ratio > 0.35:
        warnings.append("和弦结果中低置信度片段较多，建议人工复核")

    return compact, warnings


def compute_chroma_fallback(
    samples: List[float],
    sr: int,
    hop_length: int,
) -> "List[List[float]]":
    """
    librosa unavailable fallback:
    - numpy STFT magnitude
    - map frequency bins to 12 pitch classes
    """
    try:
        import numpy as np  # type: ignore
    except Exception as exc:
        raise RuntimeError("numpy is required for fallback chroma extraction") from exc

    if sr <= 0:
        return [[0.0] for _ in range(12)]

    arr = np.asarray(samples, dtype=np.float32)
    if arr.size == 0:
        return [[0.0] for _ in range(12)]

    n_fft = 4096
    if arr.size < n_fft:
        arr = np.pad(arr, (0, n_fft - arr.size), mode="constant")

    frame_count = max(1, int((arr.size - n_fft) / max(hop_length, 1)) + 1)
    window = np.hanning(n_fft).astype(np.float32)
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / float(sr))
    valid_mask = (freqs >= 55.0) & (freqs <= 5000.0)
    if not np.any(valid_mask):
        return [[0.0] * frame_count for _ in range(12)]

    valid_freqs = freqs[valid_mask]
    midi = 69.0 + 12.0 * np.log2(np.maximum(valid_freqs, 1e-6) / 440.0)
    pitch_classes = np.mod(np.round(midi).astype(np.int32), 12)

    chroma = np.zeros((12, frame_count), dtype=np.float32)
    for frame_idx in range(frame_count):
        start = frame_idx * hop_length
        frame = arr[start:start + n_fft]
        if frame.size < n_fft:
            frame = np.pad(frame, (0, n_fft - frame.size), mode="constant")
        spectrum = np.abs(np.fft.rfft(frame * window))
        weights = np.sqrt(np.maximum(spectrum[valid_mask], 0.0))
        bins = np.bincount(pitch_classes, weights=weights, minlength=12).astype(np.float32)
        total = float(np.sum(bins))
        if total > 1e-8:
            bins = bins / total
        chroma[:, frame_idx] = bins

    return chroma.tolist()


def estimate_bpm_fallback(
    samples: List[float],
    sr: int,
    hop_length: int,
) -> Tuple[Optional[float], bool, List[str]]:
    """
    librosa unavailable fallback:
    - spectral-flux onset envelope
    - autocorrelation tempo pick
    """
    try:
        import numpy as np  # type: ignore
    except Exception:
        return None, False, ["BPM 估计依赖缺失，已隐藏该字段"]

    arr = np.asarray(samples, dtype=np.float32)
    if arr.size < max(2048, hop_length * 8) or sr <= 0:
        return None, False, ["音频过短，BPM 估计不可用"]

    n_fft = 2048
    if arr.size < n_fft:
        arr = np.pad(arr, (0, n_fft - arr.size), mode="constant")
    frame_count = max(1, int((arr.size - n_fft) / max(hop_length, 1)) + 1)
    window = np.hanning(n_fft).astype(np.float32)

    onset_vals: List[float] = []
    prev = None
    for frame_idx in range(frame_count):
        start = frame_idx * hop_length
        frame = arr[start:start + n_fft]
        if frame.size < n_fft:
            frame = np.pad(frame, (0, n_fft - frame.size), mode="constant")
        mag = np.log1p(np.abs(np.fft.rfft(frame * window)))
        if prev is None:
            onset_vals.append(0.0)
        else:
            flux = np.maximum(0.0, mag - prev)
            onset_vals.append(float(np.sum(flux) / max(flux.size, 1)))
        prev = mag

    onset_env = np.asarray(onset_vals, dtype=np.float32)
    if onset_env.size < 8:
        return None, False, ["音频节拍特征不足，BPM 估计不可用"]

    onset_env = onset_env - float(np.mean(onset_env))
    onset_env = np.maximum(onset_env, 0.0)
    if float(np.max(onset_env)) <= 1e-8:
        return None, False, ["节拍能量不足，BPM 估计不可用"]

    min_bpm = 55.0
    max_bpm = 200.0
    min_lag = int(round((60.0 * sr) / (max_bpm * hop_length)))
    max_lag = int(round((60.0 * sr) / (min_bpm * hop_length)))
    min_lag = max(1, min_lag)
    max_lag = min(max_lag, onset_env.size - 1)
    if max_lag <= min_lag:
        return None, False, ["BPM 搜索窗口不足，已隐藏该字段"]

    ac = np.correlate(onset_env, onset_env, mode="full")[onset_env.size - 1:]
    search = ac[min_lag:max_lag + 1]
    if search.size == 0:
        return None, False, ["BPM 自相关失败，已隐藏该字段"]

    best_offset = int(np.argmax(search))
    best_lag = min_lag + best_offset
    bpm = float((60.0 * sr) / max(best_lag * hop_length, 1))
    peak = float(search[best_offset])
    baseline = float(np.median(search)) + 1e-8
    confidence_ratio = peak / baseline
    stable = confidence_ratio >= 1.35
    warnings: List[str] = []
    if not stable:
        warnings.append("BPM 估计置信度较低，请结合听感复核")

    if bpm < 40.0 or bpm > 240.0:
        return None, False, ["BPM 超出有效范围，已隐藏该字段"]

    return bpm, stable, warnings


def infer_chord_metadata_from_label(label: str) -> Dict[str, Any]:
    normalized = (label or "").strip()
    if not normalized or normalized == "N":
        return {
            "symbol": normalized or "N",
            "chordType": "no_chord",
            "bassNote": None,
            "extensions": [],
            "alterations": [],
            "omissions": [],
            "vocabularyTag": "triad",
        }

    parts = normalized.split("/", 1)
    symbol = parts[0]
    bass = parts[1].strip() if len(parts) > 1 and parts[1].strip() else None
    lowered = symbol.lower()

    chord_type = "major"
    if lowered.endswith("m") and "maj" not in lowered:
        chord_type = "minor"
    if "sus" in lowered:
        chord_type = "suspended"
    if "dim" in lowered:
        chord_type = "diminished"
    if "aug" in lowered:
        chord_type = "augmented"
    if "7" in lowered and chord_type == "major":
        chord_type = "dominant7"
    if "maj7" in lowered:
        chord_type = "major7"
    if "m7" in lowered:
        chord_type = "minor7"

    extensions: List[str] = []
    for token in ("7", "9", "11", "13"):
        if token in lowered:
            extensions.append(token)

    return {
        "symbol": normalized,
        "chordType": chord_type,
        "bassNote": bass,
        "extensions": extensions,
        "alterations": [],
        "omissions": [],
        "vocabularyTag": "triad",
    }


class ChordAnalyzer(Protocol):
    analyzer_id: str
    analyzer_type: str
    runtime_profile_id: str

    def analyze(
        self,
        *,
        chroma: List[List[float]],
        sr: int,
        hop_length: int,
    ) -> Dict[str, Any]:
        ...


class TempoAnalyzer(Protocol):
    analyzer_id: str
    analyzer_type: str
    runtime_profile_id: str

    def analyze(
        self,
        *,
        bpm_candidate: Optional[float],
        bpm_stable: bool,
        backend_method: str,
    ) -> Dict[str, Any]:
        ...


class DefaultChordAnalyzer:
    analyzer_id = DEFAULT_CHORD_ANALYZER_ID
    analyzer_type = "rule_based"
    runtime_profile_id = DEFAULT_ANALYSIS_RUNTIME_PROFILE_ID
    analysis_version = "chord-v1"
    vocabulary_version = "triad-v1"
    selected_vocabulary = "triad"
    supports_extended_chords = True
    supported_descriptors = [
        "major",
        "minor",
        "dominant7",
        "major7",
        "minor7",
        "suspended",
        "slash",
    ]

    def analyze(
        self,
        *,
        chroma: List[List[float]],
        sr: int,
        hop_length: int,
    ) -> Dict[str, Any]:
        segments, warnings = extract_chord_segments_from_chroma(chroma, sr, hop_length)
        enriched_segments: List[Dict[str, Any]] = []
        for segment in segments:
            label = str(segment.get("label", "N"))
            confidence_raw = segment.get("confidence")
            confidence = float(confidence_raw) if isinstance(confidence_raw, (int, float)) else None
            metadata = infer_chord_metadata_from_label(label)
            enriched: Dict[str, Any] = {
                **segment,
                "symbol": metadata["symbol"],
                "chordType": metadata["chordType"],
                "bassNote": metadata["bassNote"],
                "extensions": metadata["extensions"],
                "alterations": metadata["alterations"],
                "omissions": metadata["omissions"],
                "method": self.analyzer_id,
                "vocabularyTag": metadata["vocabularyTag"],
                "candidates": [
                    {
                        "label": label,
                        "confidence": confidence if confidence is not None else 0.0,
                        "method": self.analyzer_id,
                    }
                ],
            }
            enriched_segments.append(enriched)

        return {
            "segments": enriched_segments,
            "warnings": warnings,
            "analysisVersion": self.analysis_version,
            "vocabularyVersion": self.vocabulary_version,
            "chordVocabulary": {
                "selected": self.selected_vocabulary,
                "supportsExtendedChords": self.supports_extended_chords,
                "supportedDescriptors": self.supported_descriptors,
            },
        }


class DefaultTempoAnalyzer:
    analyzer_id = DEFAULT_TEMPO_ANALYZER_ID
    analyzer_type = "rule_based"
    runtime_profile_id = DEFAULT_ANALYSIS_RUNTIME_PROFILE_ID

    def analyze(
        self,
        *,
        bpm_candidate: Optional[float],
        bpm_stable: bool,
        backend_method: str,
    ) -> Dict[str, Any]:
        warnings: List[str] = []
        candidates: List[Dict[str, Any]] = []
        ambiguity = {
            "isAmbiguous": False,
            "halfTimeBpm": None,
            "doubleTimeBpm": None,
            "reason": "",
        }

        primary: Optional[float] = None
        confidence: Optional[float] = None
        if bpm_candidate is not None and 40.0 <= bpm_candidate <= 240.0:
            primary = float(bpm_candidate)
            confidence = 0.82 if bpm_stable else 0.46
            candidates.append({
                "bpm": primary,
                "confidence": confidence,
                "relation": "primary",
                "method": self.analyzer_id,
            })

            half_bpm = primary / 2.0
            if 40.0 <= half_bpm <= 240.0:
                half_conf = max(0.05, (confidence or 0.3) * 0.72)
                candidates.append({
                    "bpm": half_bpm,
                    "confidence": half_conf,
                    "relation": "half_time",
                    "method": self.analyzer_id,
                })
                ambiguity["halfTimeBpm"] = half_bpm

            double_bpm = primary * 2.0
            if 40.0 <= double_bpm <= 240.0:
                double_conf = max(0.05, (confidence or 0.3) * 0.68)
                candidates.append({
                    "bpm": double_bpm,
                    "confidence": double_conf,
                    "relation": "double_time",
                    "method": self.analyzer_id,
                })
                ambiguity["doubleTimeBpm"] = double_bpm

            if not bpm_stable and (ambiguity["halfTimeBpm"] is not None or ambiguity["doubleTimeBpm"] is not None):
                ambiguity["isAmbiguous"] = True
                ambiguity["reason"] = "tempo_instability_detected"
                warnings.append("BPM 存在 half-time / double-time 模糊性，请结合听感复核")
        elif bpm_candidate is not None:
            warnings.append("BPM 超出有效范围，已隐藏该字段")
        else:
            warnings.append("未检测到稳定 BPM，已隐藏该字段")

        tempo_payload = {
            "primaryBpm": primary,
            "confidence": confidence,
            "method": f"{self.analyzer_id}:{backend_method}",
            "candidates": candidates,
            "ambiguity": ambiguity,
        }
        return {
            "tempo": tempo_payload,
            "estimatedBpm": primary,
            "warnings": warnings,
        }


CHORD_ANALYZER_REGISTRY: Dict[str, ChordAnalyzer] = {
    DEFAULT_CHORD_ANALYZER_ID: DefaultChordAnalyzer(),
}

TEMPO_ANALYZER_REGISTRY: Dict[str, TempoAnalyzer] = {
    DEFAULT_TEMPO_ANALYZER_ID: DefaultTempoAnalyzer(),
}


def select_chord_analyzer(request_id: str) -> ChordAnalyzer:
    requested = os.environ.get(ENV_CHORD_ANALYZER, DEFAULT_CHORD_ANALYZER_ID).strip().lower()
    analyzer = CHORD_ANALYZER_REGISTRY.get(requested)
    if analyzer is None:
        log(
            "WARN",
            f"[REAL_CHAIN] execute_chord_analysis invalid_chord_analyzer request_id={request_id} "
            f"requested={requested} fallback={DEFAULT_CHORD_ANALYZER_ID}",
        )
        return CHORD_ANALYZER_REGISTRY[DEFAULT_CHORD_ANALYZER_ID]
    return analyzer


def select_tempo_analyzer(request_id: str) -> TempoAnalyzer:
    requested = os.environ.get(ENV_TEMPO_ANALYZER, DEFAULT_TEMPO_ANALYZER_ID).strip().lower()
    analyzer = TEMPO_ANALYZER_REGISTRY.get(requested)
    if analyzer is None:
        log(
            "WARN",
            f"[REAL_CHAIN] execute_chord_analysis invalid_tempo_analyzer request_id={request_id} "
            f"requested={requested} fallback={DEFAULT_TEMPO_ANALYZER_ID}",
        )
        return TEMPO_ANALYZER_REGISTRY[DEFAULT_TEMPO_ANALYZER_ID]
    return analyzer


PROCESS_LAUNCHER = ProcessLauncher()
TASK_CANCELLED_CODE = "TASK_CANCELLED"

_ACTIVE_TASK_LOCK = threading.Lock()
_ACTIVE_TASK_THREAD: Optional[threading.Thread] = None
_ACTIVE_TASK_REQUEST_ID: Optional[str] = None
_ACTIVE_TASK_COMMAND: Optional[str] = None
_ACTIVE_TASK_CANCEL_REQUESTED = False
_ACTIVE_SEPARATION_PROCESS: Optional[subprocess.Popen[str]] = None
_TASK_TRACE_START_MS: Dict[str, float] = {}


class TaskCancelledError(RuntimeError):
    pass


def _set_active_task_context(request_id: str, command: str, thread: threading.Thread) -> None:
    global _ACTIVE_TASK_THREAD, _ACTIVE_TASK_REQUEST_ID, _ACTIVE_TASK_COMMAND
    global _ACTIVE_TASK_CANCEL_REQUESTED, _ACTIVE_SEPARATION_PROCESS
    with _ACTIVE_TASK_LOCK:
        _ACTIVE_TASK_THREAD = thread
        _ACTIVE_TASK_REQUEST_ID = request_id
        _ACTIVE_TASK_COMMAND = command
        _ACTIVE_TASK_CANCEL_REQUESTED = False
        _ACTIVE_SEPARATION_PROCESS = None


def _clear_active_task_context(request_id: str) -> None:
    global _ACTIVE_TASK_THREAD, _ACTIVE_TASK_REQUEST_ID, _ACTIVE_TASK_COMMAND
    global _ACTIVE_TASK_CANCEL_REQUESTED, _ACTIVE_SEPARATION_PROCESS
    with _ACTIVE_TASK_LOCK:
        if _ACTIVE_TASK_REQUEST_ID == request_id:
            _ACTIVE_TASK_THREAD = None
            _ACTIVE_TASK_REQUEST_ID = None
            _ACTIVE_TASK_COMMAND = None
            _ACTIVE_TASK_CANCEL_REQUESTED = False
            _ACTIVE_SEPARATION_PROCESS = None
    _TASK_TRACE_START_MS.pop(request_id, None)


def _trace_elapsed_ms(request_id: str) -> int:
    started = _TASK_TRACE_START_MS.get(request_id)
    if started is None:
        return 0
    return max(0, int((time.time() - started) * 1000))


def _log_demucs_stage(
    *,
    request_id: str,
    stage: str,
    status: str,
    output_dir: Optional[str] = None,
    stems_dir: Optional[str] = None,
    runtime_profile_id: Optional[str] = None,
    detail: Optional[str] = None,
) -> None:
    parts = [
        f"[REAL_CHAIN] {stage}",
        f"request_id={request_id}",
        f"status={status}",
        f"elapsed_ms={_trace_elapsed_ms(request_id)}",
    ]
    if runtime_profile_id:
        parts.append(f"runtime_profile_id={runtime_profile_id}")
    if output_dir:
        parts.append(f"output_dir={output_dir}")
    if stems_dir:
        parts.append(f"stems_dir={stems_dir}")
    if detail:
        parts.append(f"detail={detail}")
    log("INFO" if status not in {"failed", "timeout", "suspicious_stall"} else "WARN", " ".join(parts))


def _truncate_for_log(text: str, max_len: int = 280) -> str:
    if len(text) <= max_len:
        return text
    return f"{text[:max_len]}...(+{len(text) - max_len} chars)"


def _read_text_file(path: str, *, max_bytes: int = 300_000) -> str:
    if not path or not os.path.isfile(path):
        return ""
    try:
        with open(path, "rb") as fp:
            fp.seek(0, os.SEEK_END)
            size = fp.tell()
            if size > max_bytes:
                fp.seek(-max_bytes, os.SEEK_END)
            else:
                fp.seek(0, os.SEEK_SET)
            data = fp.read()
        return data.decode("utf-8", errors="replace")
    except Exception:
        return ""


def _read_text_file_head(path: str, *, max_bytes: int = 512) -> str:
    if not path or not os.path.isfile(path):
        return ""
    try:
        with open(path, "rb") as fp:
            data = fp.read(max_bytes)
        return data.decode("utf-8", errors="replace")
    except Exception:
        return ""


def _scan_files_snapshot(root_dir: str, *, max_preview: int = 8) -> Tuple[int, List[str]]:
    if not root_dir or not os.path.isdir(root_dir):
        return 0, []
    count = 0
    preview: List[str] = []
    for base, _dirs, files in os.walk(root_dir):
        for filename in files:
            count += 1
            if len(preview) < max_preview:
                abs_path = os.path.join(base, filename)
                try:
                    rel_path = os.path.relpath(abs_path, root_dir)
                except Exception:
                    rel_path = filename
                preview.append(rel_path.replace("\\", "/"))
    return count, preview


DEMUCS_SILENT_STALL_THRESHOLD_MS = 60_000
DEMUCS_SILENT_STALL_LOG_INTERVAL_MS = 30_000
DEMUCS_LOW_CPU_DELTA_THRESHOLD_MS = 100


def _get_process_runtime_snapshot_with_psutil(
    proc_ps: Any,
    previous_cpu_total_ms: Optional[int],
) -> Tuple[Optional[int], Optional[int], Optional[int], Optional[str]]:
    cpu_total_ms = None
    cpu_delta_ms = None
    rss_kb = None
    error = None
    try:
        cpu_times = proc_ps.cpu_times()
        cpu_total_ms = int((float(cpu_times.user) + float(cpu_times.system)) * 1000)
        if previous_cpu_total_ms is not None:
            cpu_delta_ms = max(0, cpu_total_ms - previous_cpu_total_ms)
    except Exception as exc:
        error = f"psutil_cpu_error={exc}"
    try:
        mem_info = proc_ps.memory_info()
        rss_kb = int(getattr(mem_info, "rss", 0) / 1024)
    except Exception as exc:
        mem_err = f"psutil_mem_error={exc}"
        error = f"{error};{mem_err}" if error else mem_err
    return cpu_total_ms, cpu_delta_ms, rss_kb, error


def _get_process_runtime_snapshot_windows(
    pid: int,
    previous_cpu_total_ms: Optional[int],
) -> Tuple[Optional[int], Optional[int], Optional[int], Optional[str]]:
    try:
        import ctypes
        from ctypes import wintypes

        class FILETIME(ctypes.Structure):
            _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        PROCESS_VM_READ = 0x0010
        kernel32 = ctypes.windll.kernel32
        psapi = ctypes.windll.psapi
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, int(pid))
        if not handle:
            return None, None, None, "winapi_open_process_failed"
        try:
            creation = FILETIME()
            exit_ft = FILETIME()
            kernel_ft = FILETIME()
            user_ft = FILETIME()
            ok_times = kernel32.GetProcessTimes(
                handle,
                ctypes.byref(creation),
                ctypes.byref(exit_ft),
                ctypes.byref(kernel_ft),
                ctypes.byref(user_ft),
            )
            cpu_total_ms = None
            cpu_delta_ms = None
            if ok_times:
                kernel_100ns = (int(kernel_ft.dwHighDateTime) << 32) + int(kernel_ft.dwLowDateTime)
                user_100ns = (int(user_ft.dwHighDateTime) << 32) + int(user_ft.dwLowDateTime)
                cpu_total_ms = int((kernel_100ns + user_100ns) / 10_000)
                if previous_cpu_total_ms is not None:
                    cpu_delta_ms = max(0, cpu_total_ms - previous_cpu_total_ms)

            pmc = PROCESS_MEMORY_COUNTERS()
            pmc.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
            rss_kb = None
            mem_ok = psapi.GetProcessMemoryInfo(handle, ctypes.byref(pmc), pmc.cb)
            if mem_ok:
                rss_kb = int(int(pmc.WorkingSetSize) / 1024)
            if not ok_times and not mem_ok:
                return None, None, None, "winapi_times_and_mem_unavailable"
            return cpu_total_ms, cpu_delta_ms, rss_kb, None
        finally:
            kernel32.CloseHandle(handle)
    except Exception as exc:
        return None, None, None, f"winapi_probe_error={exc}"


def _get_process_runtime_snapshot(
    *,
    pid: int,
    proc_ps: Any,
    previous_cpu_total_ms: Optional[int],
) -> Tuple[Optional[int], Optional[int], Optional[int], str, Optional[str]]:
    if proc_ps is not None:
        cpu_total_ms, cpu_delta_ms, rss_kb, error = _get_process_runtime_snapshot_with_psutil(proc_ps, previous_cpu_total_ms)
        if cpu_total_ms is not None or rss_kb is not None:
            return cpu_total_ms, cpu_delta_ms, rss_kb, "psutil", error
        if os.name != "nt":
            return cpu_total_ms, cpu_delta_ms, rss_kb, "psutil", error

    if os.name == "nt":
        cpu_total_ms, cpu_delta_ms, rss_kb, error = _get_process_runtime_snapshot_windows(pid, previous_cpu_total_ms)
        if cpu_total_ms is not None or rss_kb is not None:
            return cpu_total_ms, cpu_delta_ms, rss_kb, "winapi", error
        return cpu_total_ms, cpu_delta_ms, rss_kb, "winapi", error

    return None, None, None, "unavailable", "process_runtime_probe_unavailable"


def _is_cancel_requested() -> bool:
    with _ACTIVE_TASK_LOCK:
        return _ACTIVE_TASK_CANCEL_REQUESTED


def _set_active_separation_process(proc: Optional[subprocess.Popen[str]]) -> None:
    global _ACTIVE_SEPARATION_PROCESS
    with _ACTIVE_TASK_LOCK:
        _ACTIVE_SEPARATION_PROCESS = proc


def _terminate_process(proc: subprocess.Popen[str], request_id: str, reason: str) -> None:
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
        log("INFO", f"[REAL_CHAIN] cancel_task terminate_sent request_id={request_id} reason={reason} pid={proc.pid}")
    except Exception as exc:
        log("WARN", f"[REAL_CHAIN] cancel_task terminate_failed request_id={request_id} reason={reason} error={exc}")
        return

    try:
        proc.wait(timeout=3)
        return
    except subprocess.TimeoutExpired:
        pass

    if proc.poll() is None:
        try:
            proc.kill()
            log("WARN", f"[REAL_CHAIN] cancel_task kill_sent request_id={request_id} reason={reason} pid={proc.pid}")
            proc.wait(timeout=2)
        except Exception as exc:
            log("ERROR", f"[REAL_CHAIN] cancel_task kill_failed request_id={request_id} reason={reason} error={exc}")


def _raise_if_cancel_requested(request_id: str, stage: str) -> None:
    if not _is_cancel_requested():
        return
    log("INFO", f"[REAL_CHAIN] start_separation cancel_short_circuit request_id={request_id} stage={stage}")
    raise TaskCancelledError(f"Separation cancelled during {stage}")


def _run_subprocess_cancellable(
    *,
    request_id: str,
    command: str | List[str],
    shell: bool,
    cwd: Optional[str],
    env: Dict[str, str],
    timeout_sec: Optional[int],
    stdio_mode: str = "pipe_line_reader",
    on_spawn: Optional[Callable[[int], None]] = None,
    on_first_stdout: Optional[Callable[[str], None]] = None,
    on_first_stderr: Optional[Callable[[str], None]] = None,
    on_first_output: Optional[Callable[[str, str], None]] = None,
    on_heartbeat: Optional[Callable[[int, int, int, int, int, Optional[int], Optional[int], Optional[int], str, Optional[str]], None]] = None,
    heartbeat_interval_sec: Optional[float] = None,
    on_exit: Optional[Callable[[int, int, Optional[int], Optional[int], str, Optional[str]], None]] = None,
    on_launch_config: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> subprocess.CompletedProcess[str]:
    started = time.time()
    normalized_stdio_mode = (stdio_mode or "").strip().lower() or "pipe_line_reader"
    use_pipe_reader = normalized_stdio_mode == "pipe_line_reader"
    spool_mode = normalized_stdio_mode == "spool_files"
    inherit_stdio_mode = normalized_stdio_mode == "inherit_stdio"
    if normalized_stdio_mode not in {"pipe_line_reader", "spool_files", "inherit_stdio"}:
        normalized_stdio_mode = "pipe_line_reader"
        use_pipe_reader = True
        spool_mode = False
        inherit_stdio_mode = False

    stdout_spool_dir: Optional[str] = None
    stdout_spool_path: Optional[str] = None
    stderr_spool_path: Optional[str] = None
    stdout_spool_fp = None
    stderr_spool_fp = None
    if spool_mode:
        stdout_spool_dir = tempfile.mkdtemp(prefix=f"demucs_stdio_{request_id[:8]}_")
        stdout_spool_path = os.path.join(stdout_spool_dir, "stdout.log")
        stderr_spool_path = os.path.join(stdout_spool_dir, "stderr.log")
        stdout_spool_fp = open(stdout_spool_path, "wb")
        stderr_spool_fp = open(stderr_spool_path, "wb")

    popen_stdin = subprocess.DEVNULL if (use_pipe_reader or spool_mode) else None
    popen_stdout = subprocess.PIPE if use_pipe_reader else (stdout_spool_fp if spool_mode else None)
    popen_stderr = subprocess.PIPE if use_pipe_reader else (stderr_spool_fp if spool_mode else None)
    popen_text = use_pipe_reader
    popen_close_fds = False if inherit_stdio_mode else True
    popen_creationflags = 0
    popen_startupinfo = None

    if on_launch_config is not None:
        try:
            inherits_parent_stdio = popen_stdin is None and popen_stdout is None and popen_stderr is None
            on_launch_config({
                "stdio_mode": normalized_stdio_mode,
                "stdin": "DEVNULL" if popen_stdin is subprocess.DEVNULL else "inherit",
                "stdout": "PIPE" if use_pipe_reader else ("spool_file" if spool_mode else "inherit"),
                "stderr": "PIPE" if use_pipe_reader else ("spool_file" if spool_mode else "inherit"),
                "text": popen_text,
                "shell": shell,
                "cwd": cwd or "",
                "close_fds": popen_close_fds,
                "creationflags": popen_creationflags,
                "startupinfo": "none",
                "inherits_parent_stdio": inherits_parent_stdio,
                "likely_ipc_pipe_inherited": inherits_parent_stdio,
                "handle_inheritance_mode": ("minimal" if popen_close_fds else "inherited"),
                "cancel_monitor_attached_after_spawn": True,
            })
        except Exception:
            pass

    proc = subprocess.Popen(
        command,
        stdin=popen_stdin,
        stdout=popen_stdout,
        stderr=popen_stderr,
        text=popen_text,
        shell=shell,
        cwd=cwd,
        env=env,
        creationflags=popen_creationflags,
        startupinfo=popen_startupinfo,
        close_fds=popen_close_fds,
    )
    if on_spawn is not None:
        try:
            on_spawn(proc.pid)
        except Exception:
            pass

    stdout_chunks: List[str] = []
    stderr_chunks: List[str] = []
    output_state_lock = threading.Lock()
    first_output_sent = False
    first_stdout_sent = False
    first_stderr_sent = False
    stdout_lines = 0
    stderr_lines = 0
    last_output_at = started

    def stream_reader(stream, chunks: List[str], source: str) -> None:
        nonlocal first_output_sent, first_stdout_sent, first_stderr_sent
        nonlocal stdout_lines, stderr_lines, last_output_at
        if stream is None:
            return
        try:
            for line in iter(stream.readline, ""):
                if line == "":
                    break
                chunks.append(line)
                with output_state_lock:
                    last_output_at = time.time()
                    if source == "stdout":
                        stdout_lines += 1
                        if on_first_stdout is not None and not first_stdout_sent:
                            first_stdout_sent = True
                            try:
                                on_first_stdout(line.strip())
                            except Exception:
                                pass
                    else:
                        stderr_lines += 1
                        if on_first_stderr is not None and not first_stderr_sent:
                            first_stderr_sent = True
                            try:
                                on_first_stderr(line.strip())
                            except Exception:
                                pass
                    if on_first_output is not None and not first_output_sent:
                        first_output_sent = True
                        try:
                            on_first_output(source, line.strip())
                        except Exception:
                            pass
        finally:
            try:
                stream.close()
            except Exception:
                pass

    stdout_thread: Optional[threading.Thread] = None
    stderr_thread: Optional[threading.Thread] = None
    if use_pipe_reader:
        stdout_thread = threading.Thread(
            target=stream_reader,
            args=(proc.stdout, stdout_chunks, "stdout"),
            daemon=True,
            name=f"sep-stdout-{request_id}",
        )
        stderr_thread = threading.Thread(
            target=stream_reader,
            args=(proc.stderr, stderr_chunks, "stderr"),
            daemon=True,
            name=f"sep-stderr-{request_id}",
        )
        stdout_thread.start()
        stderr_thread.start()

    last_stdout_spool_size = 0
    last_stderr_spool_size = 0

    _set_active_separation_process(proc)
    proc_ps = None
    last_cpu_total_ms: Optional[int] = None
    if psutil is not None:
        try:
            proc_ps = psutil.Process(proc.pid)  # type: ignore[attr-defined]
        except Exception:
            proc_ps = None

    last_heartbeat_at = started
    heartbeat_interval = heartbeat_interval_sec if heartbeat_interval_sec and heartbeat_interval_sec > 0 else None
    try:
        while True:
            _raise_if_cancel_requested(request_id, "engine_wait")
            now = time.time()
            rc = proc.poll()
            if rc is not None:
                cpu_total_ms, _cpu_delta_ms, rss_kb, stats_source, stats_error = _get_process_runtime_snapshot(
                    pid=proc.pid,
                    proc_ps=proc_ps,
                    previous_cpu_total_ms=last_cpu_total_ms,
                )
                if on_exit is not None:
                    try:
                        on_exit(
                            rc,
                            max(0, int((now - started) * 1000)),
                            cpu_total_ms,
                            rss_kb,
                            stats_source,
                            stats_error,
                        )
                    except Exception:
                        pass
                break
            if heartbeat_interval and on_heartbeat is not None and (now - last_heartbeat_at) >= heartbeat_interval:
                with output_state_lock:
                    no_output_ms = max(0, int((now - last_output_at) * 1000))
                    out_lines = stdout_lines
                    err_lines = stderr_lines
                if spool_mode and stdout_spool_path and stderr_spool_path:
                    stdout_size = 0
                    stderr_size = 0
                    try:
                        stdout_size = os.path.getsize(stdout_spool_path)
                    except Exception:
                        stdout_size = 0
                    try:
                        stderr_size = os.path.getsize(stderr_spool_path)
                    except Exception:
                        stderr_size = 0

                    with output_state_lock:
                        if stdout_size > last_stdout_spool_size:
                            last_output_at = now
                            if on_first_stdout is not None and not first_stdout_sent:
                                first_stdout_sent = True
                                try:
                                    on_first_stdout(_truncate_for_log(_read_text_file_head(stdout_spool_path), max_len=180))
                                except Exception:
                                    pass
                            if on_first_output is not None and not first_output_sent:
                                first_output_sent = True
                                try:
                                    on_first_output("stdout", _truncate_for_log(_read_text_file_head(stdout_spool_path), max_len=180))
                                except Exception:
                                    pass
                        if stderr_size > last_stderr_spool_size:
                            last_output_at = now
                            if on_first_stderr is not None and not first_stderr_sent:
                                first_stderr_sent = True
                                try:
                                    on_first_stderr(_truncate_for_log(_read_text_file_head(stderr_spool_path), max_len=180))
                                except Exception:
                                    pass
                            if on_first_output is not None and not first_output_sent:
                                first_output_sent = True
                                try:
                                    on_first_output("stderr", _truncate_for_log(_read_text_file_head(stderr_spool_path), max_len=180))
                                except Exception:
                                    pass
                        no_output_ms = max(0, int((now - last_output_at) * 1000))
                        out_lines = 1 if stdout_size > 0 else 0
                        err_lines = 1 if stderr_size > 0 else 0
                    last_stdout_spool_size = stdout_size
                    last_stderr_spool_size = stderr_size
                cpu_total_ms, cpu_delta_ms, rss_kb, stats_source, stats_error = _get_process_runtime_snapshot(
                    pid=proc.pid,
                    proc_ps=proc_ps,
                    previous_cpu_total_ms=last_cpu_total_ms,
                )
                if cpu_total_ms is not None:
                    last_cpu_total_ms = cpu_total_ms
                try:
                    on_heartbeat(
                        proc.pid,
                        max(0, int((now - started) * 1000)),
                        no_output_ms,
                        out_lines,
                        err_lines,
                        cpu_total_ms,
                        cpu_delta_ms,
                        rss_kb,
                        stats_source,
                        stats_error,
                    )
                except Exception:
                    pass
                last_heartbeat_at = now
            if timeout_sec and timeout_sec > 0 and (time.time() - started) > timeout_sec:
                _terminate_process(proc, request_id, "timeout")
                raise subprocess.TimeoutExpired(command, timeout_sec)
            time.sleep(0.1)

        if stdout_thread is not None:
            stdout_thread.join(timeout=1.5)
        if stderr_thread is not None:
            stderr_thread.join(timeout=1.5)
        if spool_mode and stdout_spool_fp is not None and stderr_spool_fp is not None:
            try:
                stdout_spool_fp.flush()
                stderr_spool_fp.flush()
            except Exception:
                pass
            stdout = _read_text_file(stdout_spool_path or "")
            stderr = _read_text_file(stderr_spool_path or "")
        else:
            stdout = "".join(stdout_chunks)
            stderr = "".join(stderr_chunks)
        return subprocess.CompletedProcess(command, proc.returncode, stdout, stderr)
    except TaskCancelledError:
        _terminate_process(proc, request_id, "cancel_requested")
        raise
    finally:
        try:
            if stdout_spool_fp is not None:
                stdout_spool_fp.close()
        except Exception:
            pass
        try:
            if stderr_spool_fp is not None:
                stderr_spool_fp.close()
        except Exception:
            pass
        if stdout_spool_dir:
            try:
                shutil.rmtree(stdout_spool_dir, ignore_errors=True)
            except Exception:
                pass
        _set_active_separation_process(None)


def _launch_profile_command_cancellable(
    profile: RuntimeProfile,
    request: ExecutionRequest,
    *,
    request_id: str,
    stdio_mode: str = "pipe_line_reader",
    on_spawn: Optional[Callable[[int], None]] = None,
    on_first_stdout: Optional[Callable[[str], None]] = None,
    on_first_stderr: Optional[Callable[[str], None]] = None,
    on_first_output: Optional[Callable[[str, str], None]] = None,
    on_heartbeat: Optional[Callable[[int, int, int, int, int, Optional[int], Optional[int], Optional[int], str, Optional[str]], None]] = None,
    heartbeat_interval_sec: Optional[float] = None,
    on_exit: Optional[Callable[[int, int, Optional[int], Optional[int], str, Optional[str]], None]] = None,
    on_command_prepared: Optional[Callable[[str, List[str], Optional[str]], None]] = None,
    on_launch_config: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> "ExecutionResult":
    env = dict(os.environ)
    env.update(profile.env)
    env.update(request.extra_env)

    command = [str(arg) for arg in request.args]
    if request.prepend_executable and not request.shell:
        command = [profile.executable] + command
    if request.shell:
        cmd_obj: str | List[str] = command[0] if len(command) == 1 else " ".join(shlex.quote(x) for x in command)
    else:
        cmd_obj = command

    display = cmd_obj if isinstance(cmd_obj, str) else " ".join(shlex.quote(x) for x in cmd_obj)
    if on_command_prepared is not None:
        try:
            argv_for_log = [str(x) for x in command]
            on_command_prepared(display, argv_for_log, profile.working_directory or None)
        except Exception:
            pass
    started = time.time()
    timeout_sec = request.timeout_sec if request.timeout_sec and request.timeout_sec > 0 else profile.default_timeout_sec
    completed = _run_subprocess_cancellable(
        request_id=request_id,
        command=cmd_obj,
        shell=request.shell,
        cwd=profile.working_directory or None,
        env=env,
        timeout_sec=timeout_sec,
        stdio_mode=stdio_mode,
        on_spawn=on_spawn,
        on_first_stdout=on_first_stdout,
        on_first_stderr=on_first_stderr,
        on_first_output=on_first_output,
        on_heartbeat=on_heartbeat,
        heartbeat_interval_sec=heartbeat_interval_sec,
        on_exit=on_exit,
        on_launch_config=on_launch_config,
    )
    elapsed_ms = int((time.time() - started) * 1000)
    return ExecutionResult(
        command_display=display,
        returncode=completed.returncode,
        stdout=completed.stdout or "",
        stderr=completed.stderr or "",
        elapsed_ms=elapsed_ms,
    )


def _resolve_executable_candidate(candidate: str) -> str:
    value = (candidate or "").strip()
    if not value:
        return ""
    if os.path.isfile(value):
        return value
    found = shutil.which(value)
    return found or value


def _resolve_environment_root(executable: str) -> str:
    resolved = _resolve_executable_candidate(executable)
    if not resolved:
        return ""
    executable_path = os.path.abspath(resolved)
    executable_dir = os.path.dirname(executable_path)
    lower_dir = executable_dir.lower()
    if lower_dir.endswith("\\scripts") or lower_dir.endswith("/scripts"):
        return os.path.dirname(executable_dir)
    if lower_dir.endswith("\\bin") or lower_dir.endswith("/bin"):
        return os.path.dirname(executable_dir)
    return executable_dir


def _create_demucs_profile(
    *,
    profile_id: str,
    executable: str,
    environment_root: str,
    demucs_device: str,
    demucs_model_dir: str,
) -> RuntimeProfile:
    resolved_executable = _resolve_executable_candidate(executable)
    return RuntimeProfile(
        id=profile_id,
        model_id="demucs",
        executable=resolved_executable,
        environment_root=environment_root,
        env={"DEMUCS_DEVICE": demucs_device},
        required_modules=["demucs"],
        health_check=[resolved_executable, "-c", "import demucs"] if resolved_executable else None,
        model_paths={"demucsModelDir": demucs_model_dir} if demucs_model_dir else {},
        device_preference=demucs_device,
        isolation_mode="subprocess",
        default_timeout_sec=1800,
        allow_fallback=False,
        fallback_profile_id=None,
        admission_approved=True,
    )


def _build_runtime_profile_registry() -> RuntimeProfileRegistry:
    exe_name = "python.exe" if os.name == "nt" else "python3"
    scripts_dir = "Scripts" if os.name == "nt" else "bin"
    repo_root = str(Path(__file__).resolve().parents[2])
    env_override = (
        os.environ.get(ENV_DEMUCS_PYTHON_EXE, "").strip()
        or os.environ.get(ENV_WORKER_PYTHON_EXE, "").strip()
    )
    env_override_executable = _resolve_executable_candidate(env_override) or _resolve_executable_candidate(sys.executable)
    pilot_override = os.environ.get(ENV_DEMUCS_6S_PILOT_PYTHON_EXE, "").strip()
    pilot_override_executable = _resolve_executable_candidate(pilot_override)
    pilot_env_root = os.environ.get(ENV_DEMUCS_6S_PILOT_ENV_ROOT, "").strip()
    if pilot_override_executable and not pilot_env_root:
        pilot_env_root = _resolve_environment_root(pilot_override_executable)
    demucs_device = os.environ.get("DEMUCS_DEVICE", "auto").strip() or "auto"
    demucs_model_dir = os.environ.get("DEMUCS_MODEL_DIR", "").strip()

    profiles: List[RuntimeProfile] = [
        RuntimeProfile(
            id=DEFAULT_ANALYSIS_RUNTIME_PROFILE_ID,
            model_id="analysis",
            executable=sys.executable,
            environment_root="inprocess://analysis_default",
            required_modules=[],
            isolation_mode="inprocess",
            default_timeout_sec=120,
            allow_fallback=False,
            admission_approved=True,
        ),
    ]
    demucs_candidates = [
        (
            "demucs_env_override",
            env_override_executable,
            _resolve_environment_root(env_override_executable),
        ),
        (
            "demucs_sys",
            _resolve_executable_candidate(sys.executable),
            _resolve_environment_root(sys.executable),
        ),
        (
            "demucs_cwd_venv",
            os.path.join(os.getcwd(), ".venv", scripts_dir, exe_name),
            _resolve_environment_root(os.path.join(os.getcwd(), ".venv", scripts_dir, exe_name)),
        ),
        (
            "demucs_repo_venv",
            os.path.join(repo_root, ".venv", scripts_dir, exe_name),
            _resolve_environment_root(os.path.join(repo_root, ".venv", scripts_dir, exe_name)),
        ),
    ]
    used_roots: Set[str] = set()
    main_demucs_profiles: List[RuntimeProfile] = []
    for profile_id, executable, environment_root in demucs_candidates:
        normalized_root = os.path.normcase(os.path.realpath(os.path.abspath(environment_root))) if environment_root else ""
        if not normalized_root:
            continue
        if normalized_root in used_roots:
            continue
        main_demucs_profiles.append(
            _create_demucs_profile(
                profile_id=profile_id,
                executable=executable,
                environment_root=environment_root,
                demucs_device=demucs_device,
                demucs_model_dir=demucs_model_dir,
            ),
        )
        used_roots.add(normalized_root)

    for index, profile in enumerate(main_demucs_profiles):
        next_profile = main_demucs_profiles[index + 1] if index + 1 < len(main_demucs_profiles) else None
        profile.fallback_profile_id = next_profile.id if next_profile else None
        profile.allow_fallback = next_profile is not None

    profiles.extend(main_demucs_profiles)

    if pilot_override_executable and pilot_env_root:
        profiles.append(
            _create_demucs_profile(
                profile_id=PILOT_DEMUCS_RUNTIME_PROFILE_ID,
                executable=pilot_override_executable,
                environment_root=pilot_env_root,
                demucs_device=demucs_device,
                demucs_model_dir=demucs_model_dir,
            ),
        )
    elif pilot_override or pilot_env_root:
        log(
            "WARN",
            "[REAL_CHAIN] runtime_registry pilot_profile_skipped "
            f"reason=incomplete_config executable_set={str(bool(pilot_override_executable)).lower()} "
            f"environment_root_set={str(bool(pilot_env_root)).lower()}",
        )

    return RuntimeProfileRegistry(profiles)


def _resolve_runtime_profile(
    *,
    request_id: str,
    requested_profile_id: str,
    default_profile_id: str,
    context: str,
    command_name: str,
    allowed_model_ids: Set[str],
) -> RuntimeResolution:
    skip_required_modules_probe = command_name == "start_separation"
    skip_import_probe = command_name == "start_separation"

    def health_trace(stage: str, runtime_profile_id: str, status: str, detail: str) -> None:
        log(
            "INFO",
            f"[REAL_CHAIN] {stage} request_id={request_id} runtime_profile_id={runtime_profile_id} "
            f"status={status} detail={detail} elapsed_ms={_trace_elapsed_ms(request_id)}",
        )

    log(
        "INFO",
        f"[REAL_CHAIN] runtime_profile_resolve_start context={context} request_id={request_id} "
        f"requested={requested_profile_id or 'none'} default={default_profile_id} "
        f"skip_required_modules_probe={str(skip_required_modules_probe).lower()} "
        f"skip_import_probe={str(skip_import_probe).lower()} "
        f"elapsed_ms={_trace_elapsed_ms(request_id)}",
    )
    resolve_started_at = time.time()
    registry = _build_runtime_profile_registry()
    resolver = RuntimeResolver(registry=registry, health_checker=RuntimeHealthChecker())
    resolution = resolver.resolve(
        requested_profile_id=requested_profile_id,
        default_profile_id=default_profile_id,
        trace_cb=health_trace,
        skip_required_modules_probe=skip_required_modules_probe,
        skip_import_probe=skip_import_probe,
    )
    resolve_elapsed_ms = max(0, int((time.time() - resolve_started_at) * 1000))
    registry.validate_for_command(
        resolution.profile,
        command_name=command_name,
        allowed_model_ids=allowed_model_ids,
    )
    fallback = resolution.fallback_reason or "none"
    health = "|".join(resolution.health.checks) if resolution.health.checks else "none"
    outcome = (
        "rejected"
        if not resolution.health.healthy
        else ("fallback" if resolution.requested_profile_id != resolution.actual_profile_id else "hit")
    )
    level = "WARN" if outcome != "hit" else "INFO"
    log(
        level,
        f"[REAL_CHAIN] runtime_resolution context={context} request_id={request_id} "
        f"requested={resolution.requested_profile_id} actual={resolution.actual_profile_id} "
        f"fallback_reason={fallback} checks={health} "
        f"allow_fallback={str(resolution.profile.allow_fallback).lower()} outcome={outcome} "
        f"resolve_elapsed_ms={resolve_elapsed_ms} elapsed_ms={_trace_elapsed_ms(request_id)}",
    )
    log(
        "INFO",
        f"[REAL_CHAIN] runtime_profile_resolve_end context={context} request_id={request_id} "
        f"actual={resolution.actual_profile_id} healthy={str(resolution.health.healthy).lower()} "
        f"resolve_elapsed_ms={resolve_elapsed_ms} elapsed_ms={_trace_elapsed_ms(request_id)}",
    )
    if not resolution.health.healthy:
        raise RuntimeError(
            f"Runtime profile unavailable: requested={resolution.requested_profile_id}, "
            f"actual={resolution.actual_profile_id}, reason={fallback}, checks={health}"
        )
    return resolution


def handle_execute_chord_analysis(request_id: str, payload: dict) -> None:
    file_path = payload.get("filePath", "")
    project_id = payload.get("projectId", "")
    if not file_path or not os.path.isfile(file_path):
        send_response(request_id, False, error={
            "code": "INPUT_FILE_NOT_FOUND",
            "message": f"Source file not found: {file_path}",
        })
        return

    started_at = time.time()
    log("INFO", f"[REAL_CHAIN] execute_chord_analysis begin request_id={request_id} project_id={project_id} file_path={file_path}")

    try:
        import numpy as np  # type: ignore
    except Exception as exc:
        send_response(request_id, False, error={
            "code": "ANALYSIS_DEPENDENCY_MISSING",
            "message": f"Chord analysis dependencies missing (numpy): {exc}",
        })
        return

    librosa = None
    try:
        import librosa as librosa_module  # type: ignore
        librosa = librosa_module
    except Exception as exc:
        log(
            "WARN",
            f"[REAL_CHAIN] execute_chord_analysis librosa_unavailable request_id={request_id} error={exc}",
        )

    try:
        warnings: List[str] = []
        hop_length = 512
        chord_analyzer = select_chord_analyzer(request_id)
        tempo_analyzer = select_tempo_analyzer(request_id)
        tempo_backend_method = "unknown"
        analysis_runtime_override = os.environ.get(ENV_ANALYSIS_RUNTIME_PROFILE, "").strip()
        chord_runtime_requested = analysis_runtime_override or chord_analyzer.runtime_profile_id
        tempo_runtime_requested = analysis_runtime_override or tempo_analyzer.runtime_profile_id
        chord_runtime = _resolve_runtime_profile(
            request_id=request_id,
            requested_profile_id=chord_runtime_requested,
            default_profile_id=DEFAULT_ANALYSIS_RUNTIME_PROFILE_ID,
            context="execute_chord_analysis.chord",
            command_name="execute_chord_analysis",
            allowed_model_ids={"analysis"},
        )
        tempo_runtime = _resolve_runtime_profile(
            request_id=request_id,
            requested_profile_id=tempo_runtime_requested,
            default_profile_id=DEFAULT_ANALYSIS_RUNTIME_PROFILE_ID,
            context="execute_chord_analysis.tempo",
            command_name="execute_chord_analysis",
            allowed_model_ids={"analysis"},
        )
        if chord_runtime.profile.isolation_mode != "inprocess" or tempo_runtime.profile.isolation_mode != "inprocess":
            rejected_runtime = chord_runtime if chord_runtime.profile.isolation_mode != "inprocess" else tempo_runtime
            rejected_checks = "|".join(rejected_runtime.health.checks) if rejected_runtime.health.checks else "none"
            send_response(request_id, False, error={
                "code": "ANALYSIS_RUNTIME_UNSUPPORTED",
                "message": "Chord/tempo analysis currently supports inprocess runtime only",
            })
            log(
                "WARN",
                f"[REAL_CHAIN] runtime_resolution context=execute_chord_analysis.reject request_id={request_id} "
                f"requested={rejected_runtime.requested_profile_id} actual={rejected_runtime.actual_profile_id} "
                f"fallback_reason={rejected_runtime.fallback_reason or 'none'} checks={rejected_checks} "
                f"allow_fallback={str(rejected_runtime.profile.allow_fallback).lower()} outcome=rejected_non_inprocess",
            )
            return

        if librosa is not None:
            y, sr = librosa.load(file_path, sr=22050, mono=True)
            if y.size == 0:
                send_response(request_id, False, error={
                    "code": "ANALYSIS_AUDIO_INVALID",
                    "message": "Audio is empty or unreadable",
                })
                return

            chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
            onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
            tempo_raw, beats = librosa.beat.beat_track(
                onset_envelope=onset_env,
                sr=sr,
                hop_length=hop_length,
            )
            tempo_backend_method = "librosa.beat_track"
            tempo = float(tempo_raw[0]) if isinstance(tempo_raw, np.ndarray) else float(tempo_raw)
            bpm_candidate = tempo if tempo > 0 else None
            bpm_stable = True
            beat_count = int(len(beats)) if beats is not None else 0
            if beat_count < 8:
                bpm_stable = False
            else:
                beat_times = librosa.frames_to_time(beats, sr=sr, hop_length=hop_length)
                ibis = np.diff(beat_times)
                if ibis.size < 6:
                    bpm_stable = False
                else:
                    mean_ibi = float(np.mean(ibis))
                    std_ibi = float(np.std(ibis))
                    cv = std_ibi / max(mean_ibi, 1e-6)
                    if cv > 0.23:
                        bpm_stable = False

            if bpm_candidate is not None and bpm_candidate >= 110.0:
                lag = int(round((60.0 * sr) / max(bpm_candidate, 1e-6) / hop_length))
                if lag > 0:
                    max_size = max(2, min(len(onset_env), lag * 3))
                    ac = librosa.autocorrelate(onset_env, max_size=max_size)
                    base_score = float(ac[lag]) if lag < len(ac) else 0.0
                    half_tempo_lag = lag * 2
                    half_score = float(ac[half_tempo_lag]) if half_tempo_lag < len(ac) else 0.0
                    half_bpm = bpm_candidate / 2.0
                    if 58.0 <= half_bpm <= 120.0 and half_score >= base_score * 0.95:
                        bpm_candidate = half_bpm
                        warnings.append("检测到节拍倍频，BPM 已按半速校正")
        else:
            samples, sr = load_audio_mono(file_path, target_sr=22050)
            y = np.asarray(samples, dtype=np.float32)
            if y.size == 0:
                send_response(request_id, False, error={
                    "code": "ANALYSIS_AUDIO_INVALID",
                    "message": "Audio is empty or unreadable",
                })
                return
            chroma = np.asarray(compute_chroma_fallback(samples, sr, hop_length), dtype=np.float32)
            bpm_candidate, bpm_stable, bpm_warnings = estimate_bpm_fallback(samples, sr, hop_length)
            tempo_backend_method = "numpy.autocorrelation_fallback"
            warnings.extend(bpm_warnings)

        if y.size == 0:
            send_response(request_id, False, error={
                "code": "ANALYSIS_AUDIO_INVALID",
                "message": "Audio is empty or unreadable",
            })
            return

        chroma_mean = np.mean(chroma, axis=1).tolist() if chroma.size > 0 else [0.0] * 12
        estimated_key, key_margin = estimate_key_from_chroma(chroma_mean)
        chord_result = chord_analyzer.analyze(
            chroma=chroma.tolist(),
            sr=sr,
            hop_length=hop_length,
        )
        segments = chord_result.get("segments", [])
        warnings.extend(chord_result.get("warnings", []))

        tempo_result = tempo_analyzer.analyze(
            bpm_candidate=bpm_candidate,
            bpm_stable=bpm_stable,
            backend_method=tempo_backend_method,
        )
        normalized_bpm = tempo_result.get("estimatedBpm")
        warnings.extend(tempo_result.get("warnings", []))

        normalized_key: Optional[str] = None
        if estimated_key != "Unknown" and key_margin >= KEY_CONFIDENCE_MARGIN:
            normalized_key = estimated_key
        else:
            warnings.append(
                f"调性估计低置信（margin={key_margin:.3f}），已隐藏 key 结果"
            )
        if not any("仅供参考" in w for w in warnings):
            warnings.append("和弦、调性与 BPM 为算法估计值，仅供参考")

        duration_ms = int((len(y) / sr) * 1000) if sr > 0 else 0
        elapsed_ms = int((time.time() - started_at) * 1000)
        log(
            "INFO",
            f"[REAL_CHAIN] execute_chord_analysis analyzers request_id={request_id} "
            f"chord={chord_analyzer.analyzer_id}@{chord_runtime.actual_profile_id} "
            f"tempo={tempo_analyzer.analyzer_id}@{tempo_runtime.actual_profile_id}",
        )

        send_response(request_id, True, data={
            "projectId": project_id,
            "source": "mixed",
            "analyzerType": chord_analyzer.analyzer_type,
            "analysisMethods": {
                "chordAnalyzer": chord_analyzer.analyzer_id,
                "tempoAnalyzer": tempo_analyzer.analyzer_id,
            },
            "segments": segments,
            "elapsedMs": elapsed_ms,
            "analyzedAt": int(time.time() * 1000),
            "audioDurationMs": duration_ms,
            "estimatedKey": normalized_key,
            "estimatedBpm": normalized_bpm,
            "tempo": tempo_result.get("tempo"),
            "analysisVersion": chord_result.get("analysisVersion", "chord-v1"),
            "vocabularyVersion": chord_result.get("vocabularyVersion", "triad-v1"),
            "chordVocabulary": chord_result.get("chordVocabulary"),
            "warnings": warnings,
            "generatedAt": int(time.time() * 1000),
        })
        log(
            "INFO",
            f"[REAL_CHAIN] execute_chord_analysis complete request_id={request_id} "
            f"segments={len(segments)} key_margin={key_margin:.4f} key_hidden={normalized_key is None} elapsed_ms={elapsed_ms}",
        )
    except Exception as exc:
        log("ERROR", f"[REAL_CHAIN] execute_chord_analysis failed request_id={request_id} error={traceback.format_exc()}")
        send_response(request_id, False, error={
            "code": "ENGINE_CRASH",
            "message": str(exc),
        })


def _resolve_separation_engine(request_id: str) -> str:
    requested = os.environ.get("SEPARATION_ENGINE", DEFAULT_SEPARATION_ENGINE).strip().lower()
    if requested not in ALLOWED_SEPARATION_ENGINES:
        log(
            "WARN",
            f"[REAL_CHAIN] start_separation invalid_engine request_id={request_id} requested={requested} fallback={DEFAULT_SEPARATION_ENGINE}",
        )
        return DEFAULT_SEPARATION_ENGINE
    return requested


def _cleanup_existing_stems(stems_dir: str) -> None:
    if not os.path.isdir(stems_dir):
        return
    for entry in os.listdir(stems_dir):
        file_path = os.path.join(stems_dir, entry)
        if os.path.isfile(file_path):
            try:
                os.remove(file_path)
            except Exception:
                pass


def _run_demucs_engine(
    request_id: str,
    file_path: str,
    output_dir: str,
    stems_dir: str,
    model_override: Optional[str] = None,
    runtime_profile_override: Optional[str] = None,
) -> dict:
    requested_model = (model_override or os.environ.get("DEMUCS_MODEL", DEFAULT_DEMUCS_MODEL)).strip() or DEFAULT_DEMUCS_MODEL
    model_name = requested_model
    if model_name not in ALLOWED_DEMUCS_MODELS:
        log(
            "WARN",
            f"[REAL_CHAIN] start_separation invalid_model request_id={request_id} requested={requested_model} fallback={DEFAULT_DEMUCS_MODEL}",
        )
        model_name = DEFAULT_DEMUCS_MODEL
    expected_stems = MODEL_OUTPUT_FILENAMES.get(model_name, MODEL_OUTPUT_FILENAMES[DEFAULT_DEMUCS_MODEL])
    supported_stem_types = MODEL_SUPPORTED_STEM_TYPES.get(model_name, MODEL_SUPPORTED_STEM_TYPES[DEFAULT_DEMUCS_MODEL])
    _log_demucs_stage(
        request_id=request_id,
        stage="demucs_run_start",
        status="success",
        output_dir=output_dir,
        stems_dir=stems_dir,
        detail=f"model={model_name}",
    )
    _log_demucs_stage(
        request_id=request_id,
        stage="demucs_function_enter",
        status="skipped",
        output_dir=output_dir,
        stems_dir=stems_dir,
        detail="mode=subprocess",
    )

    source_audio_path = os.path.abspath(str(file_path))
    output_root_path = os.path.abspath(str(output_dir))
    source_basename = Path(source_audio_path).stem
    requested_runtime_profile = (
        (runtime_profile_override or os.environ.get(ENV_DEMUCS_RUNTIME_PROFILE, "")).strip()
        or DEFAULT_DEMUCS_RUNTIME_PROFILE_ID
    )
    default_runtime_profile = (
        PILOT_DEMUCS_RUNTIME_PROFILE_ID
        if requested_runtime_profile == PILOT_DEMUCS_RUNTIME_PROFILE_ID
        else DEFAULT_DEMUCS_RUNTIME_PROFILE_ID
    )
    demucs_runtime = _resolve_runtime_profile(
        request_id=request_id,
        requested_profile_id=requested_runtime_profile,
        default_profile_id=default_runtime_profile,
        context="start_separation.demucs",
        command_name="start_separation",
        allowed_model_ids={"demucs"},
    )
    log(
        "INFO",
        f"[REAL_CHAIN] start_separation demucs_selection request_id={request_id} "
        f"model={model_name} requested_profile={requested_runtime_profile} actual_profile={demucs_runtime.actual_profile_id}",
    )
    send_event("stage_progress", {
        "stage": "PREPROCESS",
        "progress": 0.08,
    })

    cmd = [
        "-m", "demucs",
        "-n", model_name,
        "-o", output_root_path,
        source_audio_path,
    ]
    requested_stdio_mode = (os.environ.get("DEMUCS_SUBPROCESS_STDIO_MODE", "spool_files").strip().lower() or "spool_files")
    allow_experimental_stdio = os.environ.get("DEMUCS_ALLOW_EXPERIMENTAL_STDIO", "").strip().lower() in {"1", "true", "yes", "on"}
    demucs_stdio_mode = requested_stdio_mode
    if demucs_stdio_mode not in {"inherit_stdio", "spool_files", "pipe_line_reader"}:
        demucs_stdio_mode = "spool_files"
    if demucs_stdio_mode != "spool_files" and not allow_experimental_stdio:
        log(
            "WARN",
            f"[REAL_CHAIN] start_separation stdio_mode_forced_stable request_id={request_id} "
            f"requested={requested_stdio_mode} effective=spool_files",
        )
        demucs_stdio_mode = "spool_files"
    env_snapshot = {
        "DEMUCS_DEVICE": (demucs_runtime.profile.env.get("DEMUCS_DEVICE") or os.environ.get("DEMUCS_DEVICE") or ""),
        "DEMUCS_MODEL_DIR": os.environ.get("DEMUCS_MODEL_DIR", ""),
        "CUDA_VISIBLE_DEVICES": os.environ.get("CUDA_VISIBLE_DEVICES", ""),
        "PYTORCH_ENABLE_MPS_FALLBACK": os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK", ""),
        "DEMUCS_ALLOW_EXPERIMENTAL_STDIO": "true" if allow_experimental_stdio else "false",
        "DEMUCS_SUBPROCESS_STDIO_MODE": demucs_stdio_mode,
    }
    env_overlay_keys = sorted(demucs_runtime.profile.env.keys())
    _log_demucs_stage(
        request_id=request_id,
        stage="demucs_subprocess_spawn_start",
        status="pending",
        output_dir=output_dir,
        stems_dir=stems_dir,
        runtime_profile_id=demucs_runtime.actual_profile_id,
        detail=f"stdio_mode={demucs_stdio_mode}",
    )
    _raise_if_cancel_requested(request_id, "before_demucs_launch")
    first_output_seen = False
    first_stdout_seen = False
    first_stderr_seen = False
    last_output_file_count = 0
    last_stems_file_count = 0
    first_observed_file: Optional[str] = None
    last_suspicious_stall_logged_no_output_ms = 0
    demucs_cli_output_hint_logged = False

    def on_spawn(pid: int) -> None:
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_spawn_end",
            status="success",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail=f"pid={pid}",
        )
        send_event("stage_progress", {
            "stage": "INFER",
            "progress": 0.2,
        })

    def on_first_stdout(sample: str) -> None:
        nonlocal first_output_seen, first_stdout_seen
        first_output_seen = True
        first_stdout_seen = True
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_first_stdout",
            status="success",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail=f"sample={sample[:180]}",
        )

    def on_first_stderr(sample: str) -> None:
        nonlocal first_output_seen, first_stderr_seen
        first_output_seen = True
        first_stderr_seen = True
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_first_stderr",
            status="success",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail=f"sample={sample[:180]}",
        )

    def on_first_output(source: str, sample: str) -> None:
        nonlocal first_output_seen
        first_output_seen = True
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_first_output",
            status="success",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail=f"source={source} sample={sample[:180]}",
        )

    def on_heartbeat(
        pid: int,
        subprocess_elapsed_ms: int,
        no_output_ms: int,
        stdout_lines: int,
        stderr_lines: int,
        cpu_total_ms: Optional[int],
        cpu_delta_ms: Optional[int],
        rss_kb: Optional[int],
        stats_source: str,
        stats_error: Optional[str],
    ) -> None:
        nonlocal last_output_file_count, last_stems_file_count, first_observed_file
        nonlocal last_suspicious_stall_logged_no_output_ms, demucs_cli_output_hint_logged
        output_file_count, output_preview = _scan_files_snapshot(output_dir, max_preview=1)
        stems_file_count, stems_preview = _scan_files_snapshot(stems_dir, max_preview=1)
        last_output_file_count = output_file_count
        last_stems_file_count = stems_file_count

        detected_file = None
        if stems_preview:
            detected_file = stems_preview[0]
        elif output_preview:
            detected_file = output_preview[0]
        if detected_file and first_observed_file is None:
            first_observed_file = detected_file
            _log_demucs_stage(
                request_id=request_id,
                stage="demucs_subprocess_first_output_file",
                status="success",
                output_dir=output_dir,
                stems_dir=stems_dir,
                runtime_profile_id=demucs_runtime.actual_profile_id,
                detail=f"file={_truncate_for_log(detected_file, max_len=220)}",
            )

        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_heartbeat",
            status="running",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail=(
                f"pid={pid} subprocess_elapsed_ms={subprocess_elapsed_ms} "
                f"no_output_ms={no_output_ms} still_running=true stdout_lines={stdout_lines} stderr_lines={stderr_lines} "
                f"output_files={output_file_count} stems_files={stems_file_count} "
                f"cpu_total_ms={cpu_total_ms if cpu_total_ms is not None else 'na'} "
                f"cpu_delta_ms={cpu_delta_ms if cpu_delta_ms is not None else 'na'} "
                f"rss_kb={rss_kb if rss_kb is not None else 'na'} "
                f"stats_source={stats_source}"
                + (f" stats_error={_truncate_for_log(stats_error, max_len=160)}" if stats_error else "")
            ),
        )

        if (
            no_output_ms >= DEMUCS_SILENT_STALL_THRESHOLD_MS
            and output_file_count == 0
            and stems_file_count == 0
            and (no_output_ms - last_suspicious_stall_logged_no_output_ms) >= DEMUCS_SILENT_STALL_LOG_INTERVAL_MS
        ):
            cpu_low = cpu_delta_ms is not None and cpu_delta_ms <= DEMUCS_LOW_CPU_DELTA_THRESHOLD_MS
            stall_status = "suspicious_stall" if cpu_low else "silent_watch"
            _log_demucs_stage(
                request_id=request_id,
                stage="demucs_subprocess_suspicious_stall",
                status=stall_status,
                output_dir=output_dir,
                stems_dir=stems_dir,
                runtime_profile_id=demucs_runtime.actual_profile_id,
                detail=(
                    f"pid={pid} no_output_ms={no_output_ms} output_files=0 stems_files=0 "
                    f"cpu_delta_ms={cpu_delta_ms if cpu_delta_ms is not None else 'na'} "
                    f"cpu_total_ms={cpu_total_ms if cpu_total_ms is not None else 'na'} "
                    f"rss_kb={rss_kb if rss_kb is not None else 'na'} "
                    f"stats_source={stats_source}"
                    + (f" stats_error={_truncate_for_log(stats_error, max_len=160)}" if stats_error else "")
                ),
            )
            last_suspicious_stall_logged_no_output_ms = no_output_ms

        if (
            not demucs_cli_output_hint_logged
            and stdout_lines == 0
            and stderr_lines == 0
            and no_output_ms >= 30_000
        ):
            demucs_cli_output_hint_logged = True
            _log_demucs_stage(
                request_id=request_id,
                stage="demucs_cli_output_hint",
                status="info",
                output_dir=output_dir,
                stems_dir=stems_dir,
                runtime_profile_id=demucs_runtime.actual_profile_id,
                detail=(
                    "demucs_cli_may_be_quiet_in_non_tty_or_progress_bar_suppressed; "
                    f"current_stream_capture_mode={demucs_stdio_mode}"
                ),
            )

    def on_exit(
        returncode: int,
        subprocess_elapsed_ms: int,
        cpu_total_ms: Optional[int],
        rss_kb: Optional[int],
        stats_source: str,
        stats_error: Optional[str],
    ) -> None:
        signal_name = "none"
        if returncode < 0:
            signal_name = str(-returncode)
        output_file_count, _output_preview = _scan_files_snapshot(output_dir, max_preview=1)
        stems_file_count, _stems_preview = _scan_files_snapshot(stems_dir, max_preview=1)
        final_output_files = max(last_output_file_count, output_file_count)
        final_stems_files = max(last_stems_file_count, stems_file_count)
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_exit",
            status="success" if returncode == 0 else "failed",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail=(
                f"exit_code={returncode} signal={signal_name} subprocess_elapsed_ms={subprocess_elapsed_ms} "
                f"final_output_files={final_output_files} final_stems_files={final_stems_files} "
                f"cpu_total_ms={cpu_total_ms if cpu_total_ms is not None else 'na'} "
                f"rss_kb={rss_kb if rss_kb is not None else 'na'} "
                f"stats_source={stats_source}"
                + (f" stats_error={_truncate_for_log(stats_error, max_len=160)}" if stats_error else "")
            ),
        )

    def on_command_prepared(display: str, argv: List[str], cwd: Optional[str]) -> None:
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_command",
            status="success",
            output_dir=output_root_path,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail=json.dumps(
                {
                    "pythonExecutable": demucs_runtime.profile.executable,
                    "entry": "-m demucs",
                    "command": _truncate_for_log(display, max_len=1000),
                    "args": [_truncate_for_log(x, max_len=220) for x in argv],
                    "actualInputFileArg": argv[-1] if len(argv) > 0 else "",
                    "workingDirectory": cwd or os.getcwd(),
                    "env": env_snapshot,
                    "expectedInputFileArg": source_audio_path,
                },
                ensure_ascii=False,
            ),
        )

    def on_launch_config(config: Dict[str, Any]) -> None:
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_launch_config",
            status="success",
            output_dir=output_root_path,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail=json.dumps(
                {
                    "stdin": config.get("stdin"),
                    "stdout": config.get("stdout"),
                    "stderr": config.get("stderr"),
                    "stdioMode": config.get("stdio_mode"),
                    "shell": bool(config.get("shell")),
                    "cwd": config.get("cwd") or os.getcwd(),
                    "closeFds": bool(config.get("close_fds")),
                    "creationFlags": int(config.get("creationflags", 0)),
                    "startupInfo": config.get("startupinfo", "none"),
                    "inheritsParentStdio": bool(config.get("inherits_parent_stdio")),
                    "likelyIpcPipeInherited": bool(config.get("likely_ipc_pipe_inherited")),
                    "handleInheritanceMode": config.get("handle_inheritance_mode", "unknown"),
                    "envStrategy": "inherit_then_overlay",
                    "envOverlayKeys": env_overlay_keys,
                    "cancelMonitorAttachedAfterSpawn": bool(config.get("cancel_monitor_attached_after_spawn")),
                },
                ensure_ascii=False,
            ),
        )

    try:
        execution = _launch_profile_command_cancellable(
            demucs_runtime.profile,
            ExecutionRequest(
                args=cmd,
                timeout_sec=1800,
                prepend_executable=True,
            ),
            request_id=request_id,
            stdio_mode=demucs_stdio_mode,
            on_spawn=on_spawn,
            on_first_stdout=on_first_stdout,
            on_first_stderr=on_first_stderr,
            on_first_output=on_first_output,
            on_heartbeat=on_heartbeat,
            heartbeat_interval_sec=15.0,
            on_exit=on_exit,
            on_command_prepared=on_command_prepared,
            on_launch_config=on_launch_config,
        )
    except subprocess.TimeoutExpired as exc:
        timeout_output_files, _timeout_output_preview = _scan_files_snapshot(output_dir, max_preview=1)
        timeout_stems_files, _timeout_stems_preview = _scan_files_snapshot(stems_dir, max_preview=1)
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_exit",
            status="timeout",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail=(
                f"exit_code=timeout signal=none subprocess_elapsed_ms={_trace_elapsed_ms(request_id)} "
                f"final_output_files={timeout_output_files} final_stems_files={timeout_stems_files} "
                f"timeout_sec={getattr(exc, 'timeout', 'unknown')}"
            ),
        )
        raise
    except Exception as exc:
        failure_output_files, _failure_output_preview = _scan_files_snapshot(output_dir, max_preview=1)
        failure_stems_files, _failure_stems_preview = _scan_files_snapshot(stems_dir, max_preview=1)
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_exit",
            status="failed",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail=(
                f"exit_code=exception signal=none subprocess_elapsed_ms={_trace_elapsed_ms(request_id)} "
                f"final_output_files={failure_output_files} final_stems_files={failure_stems_files} "
                f"error={exc}"
            ),
        )
        raise

    if not first_stdout_seen:
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_first_stdout",
            status="missing",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail="no_stdout_captured",
        )
    if not first_stderr_seen:
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_first_stderr",
            status="missing",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail="no_stderr_captured",
        )
    if not first_output_seen:
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_subprocess_first_output",
            status="missing",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail="no_stdout_or_stderr_captured",
        )
    log(
        "INFO",
        f"[REAL_CHAIN] start_separation demucs_cmd request_id={request_id} "
        f"profile={demucs_runtime.actual_profile_id} cmd={execution.command_display}",
    )
    log(
        "INFO",
        f"[REAL_CHAIN] start_separation demucs_return request_id={request_id} "
        f"profile={demucs_runtime.actual_profile_id} returncode={execution.returncode} elapsed_ms={execution.elapsed_ms}",
    )

    if execution.returncode != 0:
        stderr_tail = execution.stderr[-1200:]
        raise RuntimeError(
            f"Demucs exited with code {execution.returncode}; "
            f"runtime={demucs_runtime.actual_profile_id}; stderr={stderr_tail}"
        )

    _raise_if_cancel_requested(request_id, "after_demucs_return")

    demucs_output_dir = os.path.join(output_dir, model_name, source_basename)
    _log_demucs_stage(
        request_id=request_id,
        stage="demucs_outputs_scan_start",
        status="pending",
        output_dir=output_dir,
        stems_dir=stems_dir,
        runtime_profile_id=demucs_runtime.actual_profile_id,
        detail=f"demucs_output_dir={demucs_output_dir}",
    )
    if not os.path.isdir(demucs_output_dir):
        model_dir = os.path.join(output_dir, model_name)
        if os.path.isdir(model_dir):
            subdirs = os.listdir(model_dir)
            if len(subdirs) == 1:
                demucs_output_dir = os.path.join(model_dir, subdirs[0])

    if not os.path.isdir(demucs_output_dir):
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_outputs_scan_end",
            status="failed",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail=f"output_not_found={demucs_output_dir}",
        )
        raise RuntimeError(f"Demucs output directory not found: {demucs_output_dir}")

    stems = []
    for stem_filename in expected_stems:
        src = os.path.join(demucs_output_dir, stem_filename)
        dst = os.path.join(stems_dir, stem_filename)
        if os.path.isfile(src):
            if os.path.exists(dst):
                os.remove(dst)
            os.rename(src, dst)
            info = get_file_info(dst)
            duration_ms = get_audio_duration_ms(dst)
            stems.append({
                "filename": stem_filename,
                "codec": "wav",
                "sizeBytes": info["sizeBytes"],
                "durationMs": duration_ms,
                "sampleRate": 44100,
            })
        else:
            log("WARN", f"[REAL_CHAIN] start_separation demucs_expected_stem_missing request_id={request_id} path={src}")

    if len(stems) == 0:
        _log_demucs_stage(
            request_id=request_id,
            stage="demucs_outputs_scan_end",
            status="failed",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail="produced_files_count=0",
        )
        _log_demucs_stage(
            request_id=request_id,
            stage="produced_filenames",
            status="success",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail="[]",
        )
        _log_demucs_stage(
            request_id=request_id,
            stage="stems_validation_result",
            status="failed",
            output_dir=output_dir,
            stems_dir=stems_dir,
            runtime_profile_id=demucs_runtime.actual_profile_id,
            detail="reason=no_stem_files",
        )
        raise RuntimeError("No stem files produced by Demucs")

    _log_demucs_stage(
        request_id=request_id,
        stage="produced_files_count",
        status="success",
        output_dir=output_dir,
        stems_dir=stems_dir,
        runtime_profile_id=demucs_runtime.actual_profile_id,
        detail=str(len(stems)),
    )
    produced_filenames = [stem.get("filename", "") for stem in stems if stem.get("filename", "")]
    if len(produced_filenames) > 12:
        preview = produced_filenames[:12] + [f"...(+{len(produced_filenames) - 12} more)"]
    else:
        preview = produced_filenames
    _log_demucs_stage(
        request_id=request_id,
        stage="produced_filenames",
        status="success",
        output_dir=output_dir,
        stems_dir=stems_dir,
        runtime_profile_id=demucs_runtime.actual_profile_id,
        detail=json.dumps(preview, ensure_ascii=False),
    )
    _log_demucs_stage(
        request_id=request_id,
        stage="demucs_outputs_scan_end",
        status="success",
        output_dir=output_dir,
        stems_dir=stems_dir,
        runtime_profile_id=demucs_runtime.actual_profile_id,
        detail=f"demucs_output_dir={demucs_output_dir}",
    )
    _log_demucs_stage(
        request_id=request_id,
        stage="stems_validation_result",
        status="success",
        output_dir=output_dir,
        stems_dir=stems_dir,
        runtime_profile_id=demucs_runtime.actual_profile_id,
        detail=f"validated={len(stems)}",
    )
    _log_demucs_stage(
        request_id=request_id,
        stage="demucs_function_return",
        status="skipped",
        output_dir=output_dir,
        stems_dir=stems_dir,
        detail="mode=subprocess",
    )

    # cleanup temp demucs tree
    try:
        if os.path.isdir(demucs_output_dir):
            shutil.rmtree(demucs_output_dir, ignore_errors=True)
        model_dir = os.path.join(output_dir, model_name)
        if os.path.isdir(model_dir) and not os.listdir(model_dir):
            os.rmdir(model_dir)
    except Exception:
        pass

    return {
        "engineVersion": f"demucs-{model_name}-v4",
        "modelName": model_name,
        "supportedStemTypes": supported_stem_types,
        "stems": stems,
    }


def _resolve_bs_stem_key(filename: str) -> Optional[str]:
    name = os.path.splitext(os.path.basename(filename))[0].lower()
    tokens = name.replace("-", "_").replace(" ", "_").split("_")

    if "vocals" in tokens or "vocal" in tokens or "vox" in tokens:
        return "vocals"
    if "drums" in tokens or "drum" in tokens or "percussion" in tokens:
        return "drums"
    if "bass" in tokens:
        return "bass"
    if "guitar" in tokens:
        return "guitar"
    if "piano" in tokens or "keys" in tokens or "keyboard" in tokens:
        return "piano"
    if "other" in tokens or "instrumental" in tokens:
        return "other"
    return None


def _run_bs_roformer_engine(
    request_id: str,
    file_path: str,
    output_dir: str,
    stems_dir: str,
) -> dict:
    """
    Experimental runner for bs-roformer-sw.
    Supports:
    1) BS_ROFORMER_CMD template (recommended):
       e.g. BS_ROFORMER_CMD=\"python -m bs_roformer.inference --input \\\"{input}\\\" --output-dir \\\"{output}\\\" --model bs_roformer_sw\"
    2) Built-in candidate commands (best effort).
    """
    bs_cmd_template = os.environ.get("BS_ROFORMER_CMD", "").strip()

    candidates: List[Tuple[List[str], bool]] = []
    if bs_cmd_template:
        rendered = bs_cmd_template.replace("{input}", file_path).replace("{output}", output_dir)
        candidates.append(([rendered], True))
    else:
        candidates.extend([
            (
                [
                    sys.executable, "-m", "bs_roformer.inference",
                    "--input", file_path,
                    "--output-dir", output_dir,
                    "--model", "bs_roformer_sw",
                ],
                False,
            ),
            (
                [
                    "bs-roformer-infer",
                    "--input", file_path,
                    "--output-dir", output_dir,
                    "--model", "bs_roformer_sw",
                ],
                False,
            ),
            (
                [
                    "bs_roformer_infer",
                    "--input", file_path,
                    "--output-dir", output_dir,
                    "--model", "bs_roformer_sw",
                ],
                False,
            ),
        ])

    last_error = "unknown"
    for cmd, use_shell in candidates:
        try:
            _raise_if_cancel_requested(request_id, "before_bs_launch")
            if use_shell:
                log("INFO", f"[REAL_CHAIN] start_separation bs_cmd request_id={request_id} cmd={cmd[0]}")
                result = _run_subprocess_cancellable(
                    request_id=request_id,
                    command=cmd[0],
                    shell=True,
                    cwd=None,
                    env=dict(os.environ),
                    timeout_sec=2400,
                )
            else:
                log("INFO", f"[REAL_CHAIN] start_separation bs_cmd request_id={request_id} cmd={' '.join(cmd)}")
                result = _run_subprocess_cancellable(
                    request_id=request_id,
                    command=cmd,
                    shell=False,
                    cwd=None,
                    env=dict(os.environ),
                    timeout_sec=2400,
                )
            if result.returncode == 0:
                break
            last_error = (result.stderr or result.stdout or f"returncode={result.returncode}")[-1200:]
            log("WARN", f"[REAL_CHAIN] start_separation bs_cmd_failed request_id={request_id} returncode={result.returncode} detail={last_error}")
        except Exception as exc:
            last_error = str(exc)
            log("WARN", f"[REAL_CHAIN] start_separation bs_cmd_exception request_id={request_id} error={last_error}")
    else:
        raise RuntimeError(f"BS-RoFormer command failed: {last_error}")

    # Scan output audio files and normalize names to canonical stems.
    candidates_by_key: dict = {}
    for root, _dirs, files in os.walk(output_dir):
        for filename in files:
            ext = os.path.splitext(filename)[1].lower()
            if ext not in {".wav", ".flac", ".mp3", ".m4a"}:
                continue
            full_path = os.path.join(root, filename)
            key = _resolve_bs_stem_key(filename)
            if not key:
                continue
            size = 0
            try:
                size = os.path.getsize(full_path)
            except Exception:
                pass
            prev = candidates_by_key.get(key)
            if not prev or size > prev["size"]:
                candidates_by_key[key] = {"path": full_path, "size": size}

    stems = []
    for key, canonical_name in BS_OUTPUT_CANONICAL_FILENAMES.items():
        selected = candidates_by_key.get(key)
        if not selected:
            continue
        src = selected["path"]
        dst = os.path.join(stems_dir, canonical_name)
        try:
            if os.path.abspath(src) != os.path.abspath(dst):
                shutil.copy2(src, dst)
        except Exception:
            continue

        if os.path.isfile(dst):
            info = get_file_info(dst)
            stems.append({
                "filename": canonical_name,
                "codec": "wav",
                "sizeBytes": info["sizeBytes"],
                "durationMs": get_audio_duration_ms(dst),
                "sampleRate": 44100,
            })

    if len(stems) == 0:
        raise RuntimeError("BS-RoFormer produced no recognizable stem files")

    return {
        "engineVersion": "bs-roformer-sw-experimental",
        "modelName": "bs_roformer_sw",
        "supportedStemTypes": BS_SUPPORTED_STEM_TYPES,
        "stems": stems,
    }


def handle_start_separation(request_id: str, payload: dict) -> None:
    """
    start_separation: 璋冪敤 Demucs CLI 鍒嗙闊抽

    payload 瀛楁锛?    - filePath: 婧愰煶棰戞枃浠剁粷瀵硅矾寰?    - outputDir: 杈撳嚭鐩綍缁濆璺緞锛坰tems 鍐欏叆 outputDir/stems/锛?
    Demucs htdemucs 榛樿杈撳嚭 4 杞? vocals.wav, drums.wav, bass.wav, other.wav
    """
    file_path = payload.get("filePath", "")
    output_dir = payload.get("outputDir", "")
    model_override = str(payload.get("modelName", "") or "").strip() or None
    runtime_profile_override = str(payload.get("runtimeProfileId", "") or "").strip() or None
    _TASK_TRACE_START_MS[request_id] = time.time()
    _raise_if_cancel_requested(request_id, "before_validate_inputs")

    if not file_path or not os.path.isfile(file_path):
        send_response(request_id, False, error={
            "code": "INPUT_FILE_NOT_FOUND",
            "message": f"Source file not found: {file_path}",
        })
        return

    if not output_dir:
        send_response(request_id, False, error={
            "code": "INVALID_OUTPUT_DIR",
            "message": "outputDir is required",
        })
        return

    # 纭繚 stems 瀛愮洰褰曞瓨鍦?
    stems_dir = os.path.join(output_dir, "stems")
    os.makedirs(stems_dir, exist_ok=True)
    _cleanup_existing_stems(stems_dir)

    log(
        "INFO",
        f"[REAL_CHAIN] start_separation begin request_id={request_id} "
        f"file_path={file_path} output_dir={output_dir} stems_dir={stems_dir} "
        f"model_override={model_override or 'none'} runtime_profile_override={runtime_profile_override or 'none'} "
        f"elapsed_ms={_trace_elapsed_ms(request_id)}",
    )

    try:
        _raise_if_cancel_requested(request_id, "before_engine_select")
        selected_engine = _resolve_separation_engine(request_id)
        log("INFO", f"[REAL_CHAIN] start_separation engine_selected request_id={request_id} engine={selected_engine}")

        used_fallback = False
        engine_result: Optional[dict] = None

        if selected_engine == "bs_roformer_sw":
            try:
                _raise_if_cancel_requested(request_id, "before_bs_runner")
                engine_result = _run_bs_roformer_engine(
                    request_id=request_id,
                    file_path=file_path,
                    output_dir=output_dir,
                    stems_dir=stems_dir,
                )
            except Exception as bs_exc:
                used_fallback = True
                log(
                    "WARN",
                    f"[REAL_CHAIN] start_separation bs_failed_fallback_demucs request_id={request_id} error={bs_exc}",
                )
                _raise_if_cancel_requested(request_id, "before_demucs_fallback")
                engine_result = _run_demucs_engine(
                    request_id=request_id,
                    file_path=file_path,
                    output_dir=output_dir,
                    stems_dir=stems_dir,
                    model_override=model_override,
                    runtime_profile_override=runtime_profile_override,
                )
        else:
            _raise_if_cancel_requested(request_id, "before_demucs_runner")
            engine_result = _run_demucs_engine(
                request_id=request_id,
                file_path=file_path,
                output_dir=output_dir,
                stems_dir=stems_dir,
                model_override=model_override,
                runtime_profile_override=runtime_profile_override,
            )

        if not engine_result or len(engine_result.get("stems", [])) == 0:
            raise RuntimeError("No stems produced by selected separation engine")
        _raise_if_cancel_requested(request_id, "after_engine_output")

        # Build stem-level route metadata (base-only execution this round).
        engine_version = str(engine_result.get("engineVersion", ""))
        effective_base_runner = "demucs" if engine_version.startswith("demucs-") else selected_engine
        routing_plan = build_stem_routing_plan(
            request_id=request_id,
            base_runner=effective_base_runner,
            base_model=str(engine_result.get("modelName", DEFAULT_DEMUCS_MODEL)),
            base_supported_stems=engine_result.get("supportedStemTypes", []),
            requested_config_json=os.environ.get(ENV_STEM_ROUTING_CONFIG_JSON, ""),
        )
        for warning in routing_plan.get("warnings", []):
            log("WARN", f"[REAL_CHAIN] start_separation routing_warning request_id={request_id} detail={warning}")
        deferred_count = 0
        for assignment in routing_plan.get("assignments", []):
            if (
                assignment.get("requestedRunner") != assignment.get("effectiveRunner")
                or assignment.get("requestedModel") != assignment.get("effectiveModel")
            ):
                deferred_count += 1
        log(
            "INFO",
            f"[REAL_CHAIN] start_separation routing_plan request_id={request_id} "
            f"mode={routing_plan.get('routingMode', 'base_only')} "
            f"assignments={len(routing_plan.get('assignments', []))} deferred={deferred_count}",
        )

        # 鍙戦€?progress: postprocessing
        send_event("stage_progress", {
            "stage": "POSTPROCESS",
            "progress": 0.9,
        })

        # 鍙戦€?progress: done
        send_event("stage_progress", {
            "stage": "DONE",
            "progress": 1.0,
        })

        # Build final response payload. Avoid re-probing original file duration here,
        # because it can block in some environments and prevent response emission.
        try:
            source_duration_ms = resolve_source_duration_ms(engine_result)
            response_data = {
                "engineVersion": engine_result.get("engineVersion", "demucs-htdemucs-v4"),
                "modelName": engine_result.get("modelName", "htdemucs"),
                "supportedStemTypes": engine_result.get("supportedStemTypes", MODEL_SUPPORTED_STEM_TYPES[DEFAULT_DEMUCS_MODEL]),
                "sourceDurationMs": source_duration_ms,
                "stems": engine_result.get("stems", []),
                "stemRoutingVersion": routing_plan.get("version", "stem-routing-v1"),
                "routingMode": routing_plan.get("routingMode", "base_only"),
                "stemRoutingAssignments": routing_plan.get("assignments", []),
            }
            if used_fallback:
                response_data["fallbackFromEngine"] = "bs_roformer_sw"
                response_data["fallbackToEngine"] = "demucs"
        except Exception as response_build_exc:
            log(
                "ERROR",
                f"[REAL_CHAIN] start_separation response_build_failed request_id={request_id} "
                f"error={response_build_exc} traceback={traceback.format_exc()}",
            )
            send_response(request_id, False, error={
                "code": "ENGINE_OUTPUT_INVALID",
                "message": f"Failed to build separation response payload: {response_build_exc}",
            })
            return

        send_response(request_id, True, data={**response_data})

        log(
            "INFO",
            f"[REAL_CHAIN] start_separation complete request_id={request_id} engine={selected_engine} fallback={used_fallback} stems_count={len(response_data['stems'])}",
        )

    except TaskCancelledError as cancelled:
        log("WARN", f"[REAL_CHAIN] start_separation cancelled request_id={request_id} message={cancelled}")
        send_response(request_id, False, error={
            "code": TASK_CANCELLED_CODE,
            "message": "Separation cancelled by user",
        })
    except subprocess.TimeoutExpired:
        log("ERROR", f"[REAL_CHAIN] start_separation timeout request_id={request_id} message=Engine process timed out")
        send_response(request_id, False, error={
            "code": "ENGINE_TIMEOUT",
            "message": "Engine process timed out",
        })
    except Exception as e:
        log("ERROR", f"[REAL_CHAIN] start_separation exception request_id={request_id} traceback={traceback.format_exc()}")
        send_response(request_id, False, error={
            "code": "ENGINE_CRASH",
            "message": str(e),
        })


def _run_start_separation_async(request_id: str, payload: dict) -> None:
    try:
        handle_start_separation(request_id, payload)
    except Exception:
        log("ERROR", f"Handler error for start_separation: {traceback.format_exc()}")
        send_response(request_id, False, error={
            "code": "ENGINE_CRASH",
            "message": "Unhandled worker exception during separation",
        })
    finally:
        _clear_active_task_context(request_id)


def handle_cancel_task(request_id: str, payload: dict) -> None:
    global _ACTIVE_TASK_CANCEL_REQUESTED
    del payload
    proc_to_stop: Optional[subprocess.Popen[str]] = None
    active_request_id: Optional[str] = None
    active_command: Optional[str] = None
    with _ACTIVE_TASK_LOCK:
        _ACTIVE_TASK_CANCEL_REQUESTED = True
        proc_to_stop = _ACTIVE_SEPARATION_PROCESS
        active_request_id = _ACTIVE_TASK_REQUEST_ID
        active_command = _ACTIVE_TASK_COMMAND
    log(
        "INFO",
        f"[REAL_CHAIN] cancel_task received request_id={request_id} "
        f"active_request_id={active_request_id or 'none'} active_command={active_command or 'none'} "
        f"has_active_process={proc_to_stop is not None}",
    )
    if proc_to_stop is not None:
        _terminate_process(proc_to_stop, active_request_id or "unknown", "cancel_task")

    send_response(request_id, True, data={
        "accepted": active_request_id is not None,
        "activeRequestId": active_request_id,
    })


# ============================================================================
# 涓诲惊鐜細璇?stdin JSON-line锛屽垎鍙戝埌 handler
# ============================================================================

COMMAND_HANDLERS = {
    "health_check": handle_health_check,
    "start_separation": handle_start_separation,
    "cancel_task": handle_cancel_task,
    "generate_waveform": handle_generate_waveform,
    "execute_chord_analysis": handle_execute_chord_analysis,
}


def main() -> None:
    try:
        registry = _build_runtime_profile_registry()
        profile_ids = ",".join(sorted([profile.id for profile in registry.list()]))
        log(
            "INFO",
            f"[REAL_CHAIN] runtime_profiles_validated profile_count={len(registry.list())} profile_ids={profile_ids}",
        )
    except Exception as exc:
        log("ERROR", f"[REAL_CHAIN] runtime_profiles_invalid error={exc}")
        raise

    log("INFO", "Stem Monitor Python Worker started")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            log("ERROR", f"Invalid JSON received: {e}")
            continue

        msg_type = msg.get("type")
        if msg_type != "request":
            log("WARN", f"Ignoring non-request message type: {msg_type}")
            continue

        request_id = msg.get("id", "")
        command = msg.get("command", "")
        payload = msg.get("payload", {})

        log("INFO", f"[REAL_CHAIN] main_loop received_request request_id={request_id} command={command}")
        handler = COMMAND_HANDLERS.get(command)
        if handler is None:
            log("WARN", f"Unknown command: {command}")
            send_response(request_id, False, error={
                "code": "UNKNOWN_COMMAND",
                "message": f"Unknown command: {command}",
            })
            continue

        if command == "start_separation":
            with _ACTIVE_TASK_LOCK:
                active_running = _ACTIVE_TASK_THREAD is not None and _ACTIVE_TASK_THREAD.is_alive()
            if active_running:
                send_response(request_id, False, error={
                    "code": "INVALID_STATE_TRANSITION",
                    "message": "Another separation task is already running",
                })
                continue

            thread = threading.Thread(
                target=_run_start_separation_async,
                args=(request_id, payload),
                daemon=True,
                name=f"start_separation_{request_id}",
            )
            _set_active_task_context(request_id, command, thread)
            thread.start()
            continue

        try:
            handler(request_id, payload)
        except Exception as e:
            log("ERROR", f"Handler error for {command}: {traceback.format_exc()}")
            send_response(request_id, False, error={
                "code": "ENGINE_CRASH",
                "message": str(e),
            })

    log("INFO", "Stem Monitor Python Worker shutting down (stdin closed)")


if __name__ == "__main__":
    main()



