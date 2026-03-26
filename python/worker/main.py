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
import re
import subprocess
import traceback
import time
import wave
import shutil
from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional, Protocol, Set
from stem_routing import build_stem_routing_plan
from runtime_profiles import (
    ExecutionRequest,
    ProcessLauncher,
    RuntimeHealthChecker,
    RuntimeProfile,
    RuntimeProfileRegistry,
    RuntimeResolution,
    RuntimeResolver,
)

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
GUITAR_SPECIALIST_MODEL_IDS = {"mel_roformer_guitar", "bs_roformer_sw_guitar"}
ENV_WORKER_PYTHON_EXE = "WORKER_PYTHON_EXE"
ENV_DEMUCS_PYTHON_EXE = "DEMUCS_PYTHON_EXE"
ENV_DEMUCS_6S_PILOT_PYTHON_EXE = "DEMUCS_6S_PILOT_PYTHON_EXE"
ENV_DEMUCS_6S_PILOT_ENV_ROOT = "DEMUCS_6S_PILOT_ENV_ROOT"
ENV_DEMUCS_RUNTIME_PROFILE = "DEMUCS_RUNTIME_PROFILE"
ENV_ANALYSIS_RUNTIME_PROFILE = "ANALYSIS_RUNTIME_PROFILE"
ENV_STEM_ROUTING_CONFIG_JSON = "STEM_ROUTING_CONFIG_JSON"
ENV_CHORD_ANALYZER = "CHORD_ANALYZER"
ENV_TEMPO_ANALYZER = "TEMPO_ANALYZER"
ENV_ANALYZER_STRICT_MODE = "ANALYZER_STRICT_MODE"
ENV_ORCH_GUITAR_SPECIALIST_CMD = "ORCH_GUITAR_SPECIALIST_CMD"
ENV_ORCH_GUITAR_SPECIALIST_CHECKPOINT = "ORCH_GUITAR_SPECIALIST_CHECKPOINT"

LEGACY_CHORD_ANALYZER_ID = "chord_rule_chroma_v1"
PILOT_CHORD_ANALYZER_ID = "chord_rule_chroma_v2_pilot"
DEFAULT_CHORD_ANALYZER_ID = PILOT_CHORD_ANALYZER_ID
LEGACY_TEMPO_ANALYZER_ID = "tempo_rule_onset_v1"
PILOT_TEMPO_ANALYZER_ID = "tempo_rule_onset_v2_pilot"
DEFAULT_TEMPO_ANALYZER_ID = PILOT_TEMPO_ANALYZER_ID
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
CHORD_FRAME_SCORE_MIN = 0.24
CHORD_BASS_SLASH_RATIO = 0.88
CHORD_ROOT_TIE_MARGIN = 0.035

CHORD_TEMPLATE_DEFINITIONS: List[Dict[str, Any]] = [
    {"suffix": "", "chordType": "major", "intervals": [0, 4, 7], "weights": [1.00, 0.92, 0.90]},
    {"suffix": "m", "chordType": "minor", "intervals": [0, 3, 7], "weights": [1.00, 0.92, 0.90]},
    {"suffix": "6", "chordType": "major6", "intervals": [0, 4, 7, 9], "weights": [1.00, 0.88, 0.86, 0.64]},
    {"suffix": "m6", "chordType": "minor6", "intervals": [0, 3, 7, 9], "weights": [1.00, 0.88, 0.86, 0.64]},
    {"suffix": "7", "chordType": "dominant7", "intervals": [0, 4, 7, 10], "weights": [1.00, 0.88, 0.86, 0.72]},
    {"suffix": "maj7", "chordType": "major7", "intervals": [0, 4, 7, 11], "weights": [1.00, 0.88, 0.86, 0.70]},
    {"suffix": "m7", "chordType": "minor7", "intervals": [0, 3, 7, 10], "weights": [1.00, 0.88, 0.86, 0.72]},
    {"suffix": "m7b5", "chordType": "half_diminished", "intervals": [0, 3, 6, 10], "weights": [1.00, 0.88, 0.78, 0.70]},
    {"suffix": "dim", "chordType": "diminished", "intervals": [0, 3, 6], "weights": [1.00, 0.90, 0.82]},
    {"suffix": "dim7", "chordType": "diminished7", "intervals": [0, 3, 6, 9], "weights": [1.00, 0.88, 0.80, 0.68]},
    {"suffix": "aug", "chordType": "augmented", "intervals": [0, 4, 8], "weights": [1.00, 0.90, 0.80]},
    {"suffix": "9", "chordType": "dominant9", "intervals": [0, 4, 7, 10, 2], "weights": [1.00, 0.86, 0.84, 0.70, 0.62]},
    {"suffix": "maj9", "chordType": "major9", "intervals": [0, 4, 7, 11, 2], "weights": [1.00, 0.86, 0.84, 0.70, 0.62]},
    {"suffix": "m9", "chordType": "minor9", "intervals": [0, 3, 7, 10, 2], "weights": [1.00, 0.86, 0.84, 0.70, 0.62]},
    {"suffix": "add9", "chordType": "added_tone", "intervals": [0, 4, 7, 2], "weights": [1.00, 0.90, 0.88, 0.64]},
    {"suffix": "sus2", "chordType": "suspended", "intervals": [0, 2, 7], "weights": [1.00, 0.90, 0.88]},
    {"suffix": "sus4", "chordType": "suspended", "intervals": [0, 5, 7], "weights": [1.00, 0.92, 0.88]},
    {"suffix": "7sus4", "chordType": "suspended7", "intervals": [0, 5, 7, 10], "weights": [1.00, 0.88, 0.84, 0.70]},
]


class AnalyzerSelectionError(RuntimeError):
    def __init__(
        self,
        *,
        analyzer_type: str,
        requested_id: str,
        available_ids: List[str],
        strict_mode: bool,
    ) -> None:
        self.analyzer_type = analyzer_type
        self.requested_id = requested_id
        self.available_ids = available_ids
        self.strict_mode = strict_mode
        super().__init__(
            f"{analyzer_type} analyzer not configured: requested={requested_id}, available={','.join(available_ids)}"
        )


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
    print(json.dumps(msg, ensure_ascii=False), flush=True)


def send_event(event_name: str, payload: dict) -> None:
    """Send one JSON-line event to stdout."""
    msg = {
        "type": "event",
        "eventName": event_name,
        "payload": payload,
    }
    print(json.dumps(msg, ensure_ascii=False), flush=True)


def _is_analyzer_strict_mode_enabled() -> bool:
    raw = os.environ.get(ENV_ANALYZER_STRICT_MODE, "1").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def _validate_tempo_analysis_result(payload: Any) -> Tuple[bool, str]:
    if not isinstance(payload, dict):
        return False, "tempo_result_not_dict"
    tempo_payload = payload.get("tempo")
    if not isinstance(tempo_payload, dict):
        return False, "tempo_payload_missing"
    method = tempo_payload.get("method")
    if not isinstance(method, str) or not method.strip():
        return False, "tempo_method_missing"
    candidates = tempo_payload.get("candidates")
    if candidates is None or not isinstance(candidates, list):
        return False, "tempo_candidates_missing"
    return True, "ok"


def _validate_chord_analysis_result(payload: Any) -> Tuple[bool, str]:
    if not isinstance(payload, dict):
        return False, "chord_result_not_dict"
    segments = payload.get("segments")
    if not isinstance(segments, list):
        return False, "chord_segments_missing"
    if len(segments) == 0:
        return False, "chord_segments_empty"
    valid_count = 0
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        if not isinstance(segment.get("label"), str):
            continue
        if not isinstance(segment.get("startMs"), (int, float)):
            continue
        if not isinstance(segment.get("endMs"), (int, float)):
            continue
        valid_count += 1
    if valid_count == 0:
        return False, "chord_segments_invalid"
    return True, "ok"


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


def extract_chord_segments_from_chroma_legacy(
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


def _build_enhanced_chord_templates(np_module: Any) -> List[Dict[str, Any]]:
    templates: List[Dict[str, Any]] = []
    for root_pc, note in enumerate(ANALYSIS_NOTE_NAMES):
        for spec in CHORD_TEMPLATE_DEFINITIONS:
            suffix = str(spec["suffix"])
            intervals = [int(v) for v in spec["intervals"]]
            weights = [float(v) for v in spec["weights"]]
            if len(intervals) != len(weights):
                continue
            tone_set = {(root_pc + interval) % 12 for interval in intervals}
            template = np_module.zeros((12,), dtype=np_module.float32)
            for interval, weight in zip(intervals, weights):
                template[(root_pc + interval) % 12] = weight
            template_sum = float(np_module.sum(template))
            template_norm = template / max(template_sum, 1e-8)
            templates.append({
                "label": f"{note}{suffix}",
                "rootPc": root_pc,
                "suffix": suffix,
                "chordType": spec["chordType"],
                "toneSet": tone_set,
                "templateNorm": template_norm,
            })
    return templates


def _score_chord_template(
    frame_norm: Any,
    template_spec: Dict[str, Any],
) -> Tuple[float, float]:
    tone_set = template_spec["toneSet"]
    template_norm = template_spec["templateNorm"]
    root_pc = int(template_spec["rootPc"])
    suffix = str(template_spec["suffix"])
    tone_energy = float(sum(float(frame_norm[idx]) for idx in tone_set))
    non_tone_energy = max(0.0, 1.0 - tone_energy)
    root_energy = float(frame_norm[root_pc])
    template_match = float(sum(float(frame_norm[idx]) * float(template_norm[idx]) for idx in range(12)))
    score = (
        template_match * 0.62
        + tone_energy * 0.28
        + root_energy * 0.10
        - non_tone_energy * 0.22
    )

    if suffix in {"7", "maj7", "m7"}:
        seventh_interval = 11 if suffix == "maj7" else 10
        seventh_pc = (root_pc + seventh_interval) % 12
        if float(frame_norm[seventh_pc]) < 0.03:
            score -= 0.05
    if suffix in {"9", "maj9", "m9", "add9"}:
        ninth_pc = (root_pc + 2) % 12
        if float(frame_norm[ninth_pc]) < 0.03:
            score -= 0.06
    if suffix in {"6", "m6", "dim7"}:
        sixth_pc = (root_pc + 9) % 12
        if float(frame_norm[sixth_pc]) < 0.03:
            score -= 0.05
    if suffix in {"sus2"}:
        sus2_pc = (root_pc + 2) % 12
        if float(frame_norm[sus2_pc]) < 0.04:
            score -= 0.05
    if suffix == "sus4":
        sus4_pc = (root_pc + 5) % 12
        if float(frame_norm[sus4_pc]) < 0.04:
            score -= 0.05
    if suffix == "7sus4":
        sus4_pc = (root_pc + 5) % 12
        seventh_pc = (root_pc + 10) % 12
        if float(frame_norm[sus4_pc]) < 0.04:
            score -= 0.05
        if float(frame_norm[seventh_pc]) < 0.03:
            score -= 0.05
    if suffix in {"dim", "dim7", "m7b5"}:
        flat5_pc = (root_pc + 6) % 12
        if float(frame_norm[flat5_pc]) < 0.04:
            score -= 0.05
    if suffix == "aug":
        sharp5_pc = (root_pc + 8) % 12
        if float(frame_norm[sharp5_pc]) < 0.04:
            score -= 0.05

    return score, tone_energy


def extract_chord_segments_from_chroma_enhanced(
    chroma: "List[List[float]]",
    sr: int,
    hop_length: int,
) -> Tuple[List[dict], List[str]]:
    try:
        import numpy as np  # type: ignore
    except Exception as exc:
        raise RuntimeError("numpy is required for chord extraction") from exc

    arr = np.asarray(chroma, dtype=np.float32)
    if arr.ndim != 2 or arr.shape[0] != 12 or arr.shape[1] == 0:
        return [], ["和弦特征不足，未生成片段"]

    # Mild temporal smoothing reduces jitter while preserving transitions.
    if arr.shape[1] >= 3:
        smoothed = arr.copy()
        smoothed[:, 1:-1] = (arr[:, :-2] + arr[:, 1:-1] + arr[:, 2:]) / 3.0
        arr = smoothed

    templates = _build_enhanced_chord_templates(np)
    labels: List[str] = []
    confidences: List[float] = []
    frame_candidates: List[List[Dict[str, Any]]] = []
    ambiguous_frame_count = 0

    for frame_idx in range(arr.shape[1]):
        frame = arr[:, frame_idx]
        energy = float(np.sum(frame))
        if energy <= 1e-8:
            labels.append("N")
            confidences.append(0.0)
            frame_candidates.append([])
            continue
        frame_norm = frame / energy
        bass_pc = int(np.argmax(frame))

        scored: List[Tuple[Dict[str, Any], float, float]] = []
        for template in templates:
            score, tone_energy = _score_chord_template(frame_norm, template)
            scored.append((template, score, tone_energy))
        scored.sort(key=lambda item: item[1], reverse=True)

        best_tpl, best_score, best_tone_energy = scored[0]
        near_best = [
            item for item in scored
            if (best_score - item[1]) <= CHORD_ROOT_TIE_MARGIN
        ]
        if len(near_best) > 1:
            near_best.sort(
                key=lambda item: (
                    1 if int(item[0]["rootPc"]) == bass_pc else 0,
                    item[1],
                ),
                reverse=True,
            )
            best_tpl, best_score, best_tone_energy = near_best[0]

        second_score = next(
            (item[1] for item in scored if item[0] is not best_tpl),
            -1.0,
        )
        third_score = scored[2][1] if len(scored) > 2 else second_score
        if best_score < CHORD_FRAME_SCORE_MIN:
            labels.append("N")
            confidences.append(0.0)
            frame_candidates.append([])
            continue

        margin = max(0.0, best_score - second_score)
        margin_norm = margin / max(abs(best_score), 1e-8)
        conf = max(0.0, min(1.0, 0.14 + 0.54 * margin_norm + 0.32 * best_tone_energy))
        if margin_norm < 0.12:
            ambiguous_frame_count += 1

        best_label = str(best_tpl["label"])
        root_pc = int(best_tpl["rootPc"])
        bass_ratio = float(frame_norm[bass_pc]) / max(float(frame_norm[root_pc]), 1e-8)
        if (
            bass_pc != root_pc
            and bass_pc in best_tpl["toneSet"]
            and float(frame_norm[bass_pc]) >= 0.10
            and bass_ratio >= CHORD_BASS_SLASH_RATIO
        ):
            best_label = f"{best_label}/{ANALYSIS_NOTE_NAMES[bass_pc]}"

        labels.append(best_label)
        confidences.append(conf)

        top_candidates: List[Dict[str, Any]] = []
        for template, score, _tone_energy in scored[:4]:
            rel = max(0.0, score - third_score)
            rel_norm = rel / max(abs(best_score - third_score), 1e-8)
            candidate_conf = max(0.05, min(1.0, conf * (0.55 + 0.45 * rel_norm)))
            top_candidates.append({
                "label": str(template["label"]),
                "confidence": candidate_conf,
                "method": "template_rank",
            })
        frame_candidates.append(top_candidates)

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

        candidate_scores: Dict[str, float] = {}
        candidate_counts: Dict[str, int] = {}
        for bucket in frame_candidates[seg_start:seg_end]:
            for candidate in bucket:
                label = str(candidate.get("label", "")).strip()
                if not label:
                    continue
                confidence = float(candidate.get("confidence", 0.0))
                candidate_scores[label] = candidate_scores.get(label, 0.0) + confidence
                candidate_counts[label] = candidate_counts.get(label, 0) + 1
        candidate_hints: List[Dict[str, Any]] = []
        for label, score_sum in candidate_scores.items():
            count = max(candidate_counts.get(label, 1), 1)
            candidate_hints.append({
                "label": label,
                "confidence": max(0.0, min(1.0, score_sum / count)),
                "method": "template_rank",
            })
        candidate_hints.sort(key=lambda item: float(item.get("confidence", 0.0)), reverse=True)

        segments.append({
            "startMs": max(0, start_ms),
            "endMs": max(0, end_ms),
            "label": seg_label,
            "simplifiedLabel": seg_label.split("/", 1)[0],
            "confidence": max(0.0, min(1.0, mean_conf)),
            "sourceFlags": ["mixed"],
            "candidateHints": candidate_hints[:4],
        })

    for idx in range(1, len(labels)):
        if labels[idx] != current:
            append_segment(current, start_idx, idx)
            start_idx = idx
            current = labels[idx]
    append_segment(current, start_idx, len(labels))

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
            continue
        compact.append(seg)

    warnings: List[str] = []
    if compact:
        low_conf_count = sum(1 for seg in compact if float(seg.get("confidence", 0.0)) < 0.2)
        low_conf_ratio = low_conf_count / len(compact)
        if low_conf_ratio > 0.32:
            warnings.append("和弦结果中低置信度片段较多，建议人工复核")
    if len(labels) > 0:
        ambiguous_ratio = ambiguous_frame_count / len(labels)
        if ambiguous_ratio > 0.28:
            warnings.append("复杂和弦候选分歧较大，建议关注 candidates 字段")

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


def infer_chord_metadata_from_label_v2(label: str) -> Dict[str, Any]:
    normalized = (label or "").strip()
    if not normalized or normalized == "N":
        return {
            "symbol": normalized or "N",
            "chordType": "no_chord",
            "bassNote": None,
            "extensions": [],
            "alterations": [],
            "omissions": [],
            "vocabularyTag": "extended_v2.1",
        }

    parts = normalized.split("/", 1)
    symbol = parts[0].strip()
    bass = parts[1].strip() if len(parts) > 1 and parts[1].strip() else None
    lowered = symbol.lower()

    chord_type = "major"
    if "m7b5" in lowered or "ø" in lowered:
        chord_type = "half_diminished"
    elif "7sus" in lowered:
        chord_type = "suspended7"
    elif "sus" in lowered:
        chord_type = "suspended"
    elif "add" in lowered:
        chord_type = "added_tone"
    elif "maj9" in lowered:
        chord_type = "major9"
    elif "m9" in lowered or "min9" in lowered:
        chord_type = "minor9"
    elif "9" in lowered:
        chord_type = "dominant9"
    elif "maj7" in lowered:
        chord_type = "major7"
    elif "dim7" in lowered:
        chord_type = "diminished7"
    elif "m7" in lowered or "min7" in lowered:
        chord_type = "minor7"
    elif "dim" in lowered:
        chord_type = "diminished"
    elif "aug" in lowered:
        chord_type = "augmented"
    elif re.search(r"(^|[^a-z])m6($|[^0-9a-z])", lowered):
        chord_type = "minor6"
    elif re.search(r"(^|[^a-z])6($|[^0-9a-z])", lowered):
        chord_type = "major6"
    elif "7" in lowered:
        chord_type = "dominant7"
    elif lowered.endswith("m") and "maj" not in lowered:
        chord_type = "minor"

    extension_tokens = re.findall(r"(?:add|maj)?(6|7|9|11|13)", lowered)
    extensions = sorted(set(extension_tokens), key=lambda token: int(token))
    alterations = sorted(set(re.findall(r"([#b](?:5|9|11|13))", lowered)))
    omission_numbers = re.findall(r"(?:omit|no)(3|5|7|9|11|13)", lowered)
    omissions = [f"no{token}" for token in sorted(set(omission_numbers), key=lambda token: int(token))]

    return {
        "symbol": normalized,
        "chordType": chord_type,
        "bassNote": bass,
        "extensions": extensions,
        "alterations": alterations,
        "omissions": omissions,
        "vocabularyTag": "extended_v2.1",
    }


def build_chord_candidates_v2(
    label: str,
    confidence: Optional[float],
    analyzer_id: str,
    template_hints: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    normalized = (label or "").strip()
    candidates: List[Dict[str, Any]] = []
    if not normalized:
        return candidates

    base_conf = confidence if confidence is not None else 0.45
    candidates.append({
        "label": normalized,
        "confidence": max(0.0, min(1.0, base_conf)),
        "method": analyzer_id,
    })

    if "/" in normalized:
        slashless = normalized.split("/", 1)[0].strip()
        if slashless and slashless != normalized:
            candidates.append({
                "label": slashless,
                "confidence": max(0.0, min(1.0, base_conf * 0.92)),
                "method": analyzer_id,
            })

    root_match = re.match(r"^([A-G](?:#|b)?)(.*)$", normalized)
    if root_match:
        root = root_match.group(1)
        suffix = root_match.group(2)
        if "sus" in suffix.lower():
            fallback = f"{root}"
            if fallback != normalized:
                candidates.append({
                    "label": fallback,
                    "confidence": max(0.0, min(1.0, base_conf * 0.86)),
                    "method": analyzer_id,
                })

    if template_hints:
        for hint in template_hints:
            if not isinstance(hint, dict):
                continue
            hint_label = str(hint.get("label", "")).strip()
            if not hint_label:
                continue
            hint_conf_raw = hint.get("confidence")
            hint_conf = (
                float(hint_conf_raw)
                if isinstance(hint_conf_raw, (int, float))
                else max(0.05, min(1.0, base_conf * 0.82))
            )
            hint_method = str(hint.get("method", "")).strip() or analyzer_id
            candidates.append({
                "label": hint_label,
                "confidence": max(0.0, min(1.0, hint_conf)),
                "method": hint_method,
            })

    dedup: Dict[str, Dict[str, Any]] = {}
    for candidate in candidates:
        key = str(candidate.get("label", "")).strip()
        if not key:
            continue
        prev = dedup.get(key)
        if prev is None or float(candidate.get("confidence", 0.0)) > float(prev.get("confidence", 0.0)):
            dedup[key] = candidate
    return list(dedup.values())


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


class LegacyChordAnalyzer:
    analyzer_id = LEGACY_CHORD_ANALYZER_ID
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
        segments, warnings = extract_chord_segments_from_chroma_legacy(chroma, sr, hop_length)
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


class LegacyTempoAnalyzer:
    analyzer_id = LEGACY_TEMPO_ANALYZER_ID
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


class PilotChordAnalyzer:
    analyzer_id = PILOT_CHORD_ANALYZER_ID
    analyzer_type = "rule_based"
    runtime_profile_id = DEFAULT_ANALYSIS_RUNTIME_PROFILE_ID
    analysis_version = "chord-v2.2-pilot"
    vocabulary_version = "extended-v2.1"
    selected_vocabulary = "extended"
    supports_extended_chords = True
    supported_descriptors = [
        "major",
        "minor",
        "dominant7",
        "major7",
        "minor7",
        "major6",
        "minor6",
        "half_diminished",
        "diminished",
        "diminished7",
        "augmented",
        "major9",
        "minor9",
        "add9",
        "sus2",
        "sus4",
        "suspended7",
        "slash",
        "altered",
        "omitted",
    ]

    def analyze(
        self,
        *,
        chroma: List[List[float]],
        sr: int,
        hop_length: int,
    ) -> Dict[str, Any]:
        segments, warnings = extract_chord_segments_from_chroma_enhanced(chroma, sr, hop_length)
        enriched_segments: List[Dict[str, Any]] = []
        for segment in segments:
            label = str(segment.get("label", "N"))
            confidence_raw = segment.get("confidence")
            confidence = float(confidence_raw) if isinstance(confidence_raw, (int, float)) else None
            template_hints = segment.get("candidateHints")
            metadata = infer_chord_metadata_from_label_v2(label)
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
                "candidates": build_chord_candidates_v2(
                    label,
                    confidence,
                    self.analyzer_id,
                    template_hints=template_hints if isinstance(template_hints, list) else None,
                ),
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


class PilotTempoAnalyzer:
    analyzer_id = PILOT_TEMPO_ANALYZER_ID
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
            candidate = float(bpm_candidate)
            half_bpm = candidate / 2.0
            double_bpm = candidate * 2.0

            # Pilot heuristic:
            # prefer 70~150 BPM window when confidence is unstable to reduce倍频误判.
            if not bpm_stable and 70.0 <= half_bpm <= 150.0:
                primary = half_bpm
                ambiguity["isAmbiguous"] = True
                ambiguity["reason"] = "pilot_half_time_preferred_for_unstable_tempo"
                warnings.append("Pilot tempo analyzer: 不稳定节拍已优先选择 half-time 候选")
            elif 70.0 <= candidate <= 150.0:
                primary = candidate
            elif 70.0 <= half_bpm <= 150.0:
                primary = half_bpm
                ambiguity["isAmbiguous"] = True
                ambiguity["reason"] = "pilot_half_time_window_fit"
            elif 70.0 <= double_bpm <= 150.0:
                primary = double_bpm
                ambiguity["isAmbiguous"] = True
                ambiguity["reason"] = "pilot_double_time_window_fit"
            else:
                primary = candidate

            confidence = 0.76 if bpm_stable else 0.40
            candidates.append({
                "bpm": candidate,
                "confidence": 0.74 if bpm_stable else 0.38,
                "relation": "detected",
                "method": self.analyzer_id,
            })
            if 40.0 <= half_bpm <= 240.0:
                ambiguity["halfTimeBpm"] = half_bpm
                candidates.append({
                    "bpm": half_bpm,
                    "confidence": max(0.05, (confidence or 0.3) * 0.72),
                    "relation": "half_time",
                    "method": self.analyzer_id,
                })
            if 40.0 <= double_bpm <= 240.0:
                ambiguity["doubleTimeBpm"] = double_bpm
                candidates.append({
                    "bpm": double_bpm,
                    "confidence": max(0.05, (confidence or 0.3) * 0.66),
                    "relation": "double_time",
                    "method": self.analyzer_id,
                })
            if ambiguity["isAmbiguous"] and not ambiguity["reason"]:
                ambiguity["reason"] = "tempo_instability_detected"
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
    LEGACY_CHORD_ANALYZER_ID: LegacyChordAnalyzer(),
    PILOT_CHORD_ANALYZER_ID: PilotChordAnalyzer(),
}

TEMPO_ANALYZER_REGISTRY: Dict[str, TempoAnalyzer] = {
    LEGACY_TEMPO_ANALYZER_ID: LegacyTempoAnalyzer(),
    PILOT_TEMPO_ANALYZER_ID: PilotTempoAnalyzer(),
}


def select_chord_analyzer(request_id: str) -> ChordAnalyzer:
    requested_raw = os.environ.get(ENV_CHORD_ANALYZER, "").strip().lower()
    requested = requested_raw or DEFAULT_CHORD_ANALYZER_ID
    analyzer = CHORD_ANALYZER_REGISTRY.get(requested)
    if analyzer is None:
        strict_mode = _is_analyzer_strict_mode_enabled()
        available_ids = sorted(CHORD_ANALYZER_REGISTRY.keys())
        if strict_mode:
            log(
                "ERROR",
                f"[REAL_CHAIN] execute_chord_analysis invalid_chord_analyzer_strict request_id={request_id} "
                f"requested={requested} available={','.join(available_ids)}",
            )
            raise AnalyzerSelectionError(
                analyzer_type="chord",
                requested_id=requested,
                available_ids=available_ids,
                strict_mode=True,
            )
        log(
            "WARN",
            f"[REAL_CHAIN] execute_chord_analysis invalid_chord_analyzer request_id={request_id} "
            f"requested={requested} fallback={DEFAULT_CHORD_ANALYZER_ID}",
        )
        return CHORD_ANALYZER_REGISTRY[DEFAULT_CHORD_ANALYZER_ID]
    return analyzer


def select_tempo_analyzer(request_id: str) -> TempoAnalyzer:
    requested_raw = os.environ.get(ENV_TEMPO_ANALYZER, "").strip().lower()
    requested = requested_raw or DEFAULT_TEMPO_ANALYZER_ID
    analyzer = TEMPO_ANALYZER_REGISTRY.get(requested)
    if analyzer is None:
        strict_mode = _is_analyzer_strict_mode_enabled()
        available_ids = sorted(TEMPO_ANALYZER_REGISTRY.keys())
        if strict_mode:
            log(
                "ERROR",
                f"[REAL_CHAIN] execute_chord_analysis invalid_tempo_analyzer_strict request_id={request_id} "
                f"requested={requested} available={','.join(available_ids)}",
            )
            raise AnalyzerSelectionError(
                analyzer_type="tempo",
                requested_id=requested,
                available_ids=available_ids,
                strict_mode=True,
            )
        log(
            "WARN",
            f"[REAL_CHAIN] execute_chord_analysis invalid_tempo_analyzer request_id={request_id} "
            f"requested={requested} fallback={DEFAULT_TEMPO_ANALYZER_ID}",
        )
        return TEMPO_ANALYZER_REGISTRY[DEFAULT_TEMPO_ANALYZER_ID]
    return analyzer


PROCESS_LAUNCHER = ProcessLauncher()


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
    registry = _build_runtime_profile_registry()
    resolver = RuntimeResolver(registry=registry, health_checker=RuntimeHealthChecker())
    resolution = resolver.resolve(
        requested_profile_id=requested_profile_id,
        default_profile_id=default_profile_id,
    )
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
        f"allow_fallback={str(resolution.profile.allow_fallback).lower()} outcome={outcome}",
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
        analysis_runtime_override = os.environ.get(ENV_ANALYSIS_RUNTIME_PROFILE, "").strip()
        try:
            chord_analyzer = select_chord_analyzer(request_id)
            tempo_analyzer = select_tempo_analyzer(request_id)
        except AnalyzerSelectionError as selection_error:
            runtime_hint = analysis_runtime_override or DEFAULT_ANALYSIS_RUNTIME_PROFILE_ID
            send_response(request_id, False, error={
                "code": "ANALYZER_SELECTION_FAILED",
                "message": (
                    "Analyzer selection failed: "
                    f"type={selection_error.analyzer_type}, "
                    f"requested={selection_error.requested_id}, "
                    f"strict_mode={str(selection_error.strict_mode).lower()}, "
                    f"runtime_profile={runtime_hint}, "
                    f"available={','.join(selection_error.available_ids)}"
                ),
            })
            return

        tempo_backend_method = "unknown"
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
        chord_result_valid, chord_result_reason = _validate_chord_analysis_result(chord_result)
        if not chord_result_valid:
            send_response(request_id, False, error={
                "code": "ANALYSIS_CHORD_RESULT_EMPTY",
                "message": (
                    f"Chord analyzer returned invalid/empty payload: analyzer={chord_analyzer.analyzer_id}, "
                    f"runtime_profile={chord_runtime.actual_profile_id}, reason={chord_result_reason}"
                ),
            })
            return
        segments = chord_result.get("segments", [])
        warnings.extend(chord_result.get("warnings", []))

        tempo_result = tempo_analyzer.analyze(
            bpm_candidate=bpm_candidate,
            bpm_stable=bpm_stable,
            backend_method=tempo_backend_method,
        )
        tempo_result_valid, tempo_result_reason = _validate_tempo_analysis_result(tempo_result)
        if not tempo_result_valid:
            send_response(request_id, False, error={
                "code": "ANALYSIS_TEMPO_RESULT_EMPTY",
                "message": (
                    f"Tempo analyzer returned invalid/empty payload: analyzer={tempo_analyzer.analyzer_id}, "
                    f"runtime_profile={tempo_runtime.actual_profile_id}, reason={tempo_result_reason}"
                ),
            })
            return
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


def _resolve_separation_engine(request_id: str, model_override: Optional[str] = None) -> str:
    normalized_model = (model_override or "").strip().lower()
    if normalized_model in GUITAR_SPECIALIST_MODEL_IDS:
        log(
            "INFO",
            f"[REAL_CHAIN] start_separation specialist_engine_override request_id={request_id} "
            f"model={normalized_model} engine=bs_roformer_sw",
        )
        return "bs_roformer_sw"
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

    source_basename = Path(file_path).stem
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

    cmd = [
        "-m", "demucs",
        "-n", model_name,
        "-o", output_dir,
        file_path,
    ]
    execution = PROCESS_LAUNCHER.launch(
        demucs_runtime.profile,
        ExecutionRequest(
            args=cmd,
            timeout_sec=1800,
            prepend_executable=True,
        ),
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

    demucs_output_dir = os.path.join(output_dir, model_name, source_basename)
    if not os.path.isdir(demucs_output_dir):
        model_dir = os.path.join(output_dir, model_name)
        if os.path.isdir(model_dir):
            subdirs = os.listdir(model_dir)
            if len(subdirs) == 1:
                demucs_output_dir = os.path.join(model_dir, subdirs[0])

    if not os.path.isdir(demucs_output_dir):
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
        raise RuntimeError("No stem files produced by Demucs")

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
    specialist_model_id: Optional[str] = None,
) -> dict:
    """
    Experimental runner for bs-roformer-sw.
    Supports:
    1) BS_ROFORMER_CMD template (recommended):
       e.g. BS_ROFORMER_CMD=\"python -m bs_roformer.inference --input \\\"{input}\\\" --output-dir \\\"{output}\\\" --model bs_roformer_sw\"
    2) Built-in candidate commands (best effort).
    """
    specialist_model = (specialist_model_id or "").strip().lower()
    bs_cmd_template = os.environ.get("BS_ROFORMER_CMD", "").strip()
    specialist_cmd_template = os.environ.get(ENV_ORCH_GUITAR_SPECIALIST_CMD, "").strip()
    specialist_checkpoint = os.environ.get(ENV_ORCH_GUITAR_SPECIALIST_CHECKPOINT, "").strip()

    candidates: List[Tuple[List[str], bool]] = []
    if specialist_model in GUITAR_SPECIALIST_MODEL_IDS:
        if not specialist_cmd_template:
            raise RuntimeError(
                "Guitar specialist command missing: set ORCH_GUITAR_SPECIALIST_CMD"
            )
        if "{checkpoint}" in specialist_cmd_template and not specialist_checkpoint:
            raise RuntimeError(
                "Guitar specialist checkpoint missing: set ORCH_GUITAR_SPECIALIST_CHECKPOINT"
            )
        rendered = (
            specialist_cmd_template
            .replace("{input}", file_path)
            .replace("{output}", output_dir)
            .replace("{checkpoint}", specialist_checkpoint)
            .replace("{model}", specialist_model)
        )
        candidates.append(([rendered], True))
    elif bs_cmd_template:
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
            if use_shell:
                log("INFO", f"[REAL_CHAIN] start_separation bs_cmd request_id={request_id} cmd={cmd[0]}")
                result = subprocess.run(
                    cmd[0],
                    capture_output=True,
                    text=True,
                    timeout=2400,
                    shell=True,
                )
            else:
                log("INFO", f"[REAL_CHAIN] start_separation bs_cmd request_id={request_id} cmd={' '.join(cmd)}")
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=2400,
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
        "modelName": specialist_model if specialist_model else "bs_roformer_sw",
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
        f"model_override={model_override or 'none'} runtime_profile_override={runtime_profile_override or 'none'}",
    )

    # 鍙戦€?progress: preprocessing
    send_event("stage_progress", {
        "stage": "PREPROCESS",
        "progress": 0.1,
    })

    try:
        selected_engine = _resolve_separation_engine(request_id, model_override=model_override)
        log("INFO", f"[REAL_CHAIN] start_separation engine_selected request_id={request_id} engine={selected_engine}")

        # 鍙戦€?progress: infer starting
        send_event("stage_progress", {
            "stage": "INFER",
            "progress": 0.2,
        })

        used_fallback = False
        engine_result: Optional[dict] = None

        if selected_engine == "bs_roformer_sw":
            try:
                engine_result = _run_bs_roformer_engine(
                    request_id=request_id,
                    file_path=file_path,
                    output_dir=output_dir,
                    stems_dir=stems_dir,
                    specialist_model_id=model_override,
                )
            except Exception as bs_exc:
                used_fallback = True
                log(
                    "WARN",
                    f"[REAL_CHAIN] start_separation bs_failed_fallback_demucs request_id={request_id} error={bs_exc}",
                )
                engine_result = _run_demucs_engine(
                    request_id=request_id,
                    file_path=file_path,
                    output_dir=output_dir,
                    stems_dir=stems_dir,
                    model_override=model_override,
                    runtime_profile_override=runtime_profile_override,
                )
        else:
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

        # 鍙戦€佹垚鍔?response 鈥?缁撴瀯鍖归厤 RawSeparationResult
        response_data = {
            "engineVersion": engine_result.get("engineVersion", "demucs-htdemucs-v4"),
            "modelName": engine_result.get("modelName", "htdemucs"),
            "supportedStemTypes": engine_result.get("supportedStemTypes", MODEL_SUPPORTED_STEM_TYPES[DEFAULT_DEMUCS_MODEL]),
            "sourceDurationMs": get_audio_duration_ms(file_path),
            "stems": engine_result.get("stems", []),
            "stemRoutingVersion": routing_plan.get("version", "stem-routing-v1"),
            "routingMode": routing_plan.get("routingMode", "base_only"),
            "stemRoutingAssignments": routing_plan.get("assignments", []),
        }
        if used_fallback:
            response_data["fallbackFromEngine"] = "bs_roformer_sw"
            response_data["fallbackToEngine"] = "demucs"

        send_response(request_id, True, data={
            **response_data,
        })

        log(
            "INFO",
            f"[REAL_CHAIN] start_separation complete request_id={request_id} engine={selected_engine} fallback={used_fallback} stems_count={len(response_data['stems'])}",
        )

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


# ============================================================================
# 涓诲惊鐜細璇?stdin JSON-line锛屽垎鍙戝埌 handler
# ============================================================================

COMMAND_HANDLERS = {
    "health_check": handle_health_check,
    "start_separation": handle_start_separation,
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



