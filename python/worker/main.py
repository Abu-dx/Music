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
import subprocess
import traceback
import time
import wave
import shutil
from pathlib import Path
from typing import List, Tuple, Optional

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
        import librosa  # type: ignore
    except Exception as exc:
        send_response(request_id, False, error={
            "code": "ANALYSIS_DEPENDENCY_MISSING",
            "message": f"Chord analysis dependencies missing: {exc}",
        })
        return

    try:
        y, sr = librosa.load(file_path, sr=22050, mono=True)
        if y.size == 0:
            send_response(request_id, False, error={
                "code": "ANALYSIS_AUDIO_INVALID",
                "message": "Audio is empty or unreadable",
            })
            return

        hop_length = 512
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
        onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
        tempo_raw, beats = librosa.beat.beat_track(
            onset_envelope=onset_env,
            sr=sr,
            hop_length=hop_length,
        )
        tempo = float(tempo_raw[0]) if isinstance(tempo_raw, np.ndarray) else float(tempo_raw)

        chroma_mean = np.mean(chroma, axis=1).tolist() if chroma.size > 0 else [0.0] * 12
        estimated_key, key_margin = estimate_key_from_chroma(chroma_mean)

        segments, warnings = extract_chord_segments_from_chroma(chroma.tolist(), sr, hop_length)

        # Conservative BPM stabilization:
        # 1) handle common double-tempo errors (e.g. 130 shown for ~65 songs),
        # 2) hide BPM when beat stability is poor.
        normalized_bpm: Optional[float] = None
        bpm_candidate = tempo if tempo > 0 else None

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

        if bpm_candidate is None or bpm_candidate < 55.0 or bpm_candidate > 200.0:
            bpm_stable = False

        if bpm_stable and bpm_candidate is not None:
            normalized_bpm = bpm_candidate
        elif tempo > 0:
            warnings.append("BPM 估计值不稳定，已隐藏该字段")

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

        send_response(request_id, True, data={
            "projectId": project_id,
            "source": "mixed",
            "analyzerType": "rule_based",
            "segments": segments,
            "elapsedMs": elapsed_ms,
            "analyzedAt": int(time.time() * 1000),
            "audioDurationMs": duration_ms,
            "estimatedKey": normalized_key,
            "estimatedBpm": normalized_bpm,
            "analysisVersion": "chord-v1",
            "vocabularyVersion": "triad-v1",
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
) -> dict:
    requested_model = os.environ.get("DEMUCS_MODEL", DEFAULT_DEMUCS_MODEL).strip() or DEFAULT_DEMUCS_MODEL
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
    cmd = [
        sys.executable, "-m", "demucs",
        "-n", model_name,
        "-o", output_dir,
        file_path,
    ]
    log("INFO", f"[REAL_CHAIN] start_separation demucs_cmd request_id={request_id} cmd={' '.join(cmd)}")

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=1800,
    )
    log("INFO", f"[REAL_CHAIN] start_separation demucs_return request_id={request_id} returncode={result.returncode}")

    if result.returncode != 0:
        stderr_tail = (result.stderr or "")[-1200:]
        raise RuntimeError(f"Demucs exited with code {result.returncode}; stderr={stderr_tail}")

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

    log("INFO", f"[REAL_CHAIN] start_separation begin request_id={request_id} file_path={file_path} output_dir={output_dir} stems_dir={stems_dir}")

    # 鍙戦€?progress: preprocessing
    send_event("stage_progress", {
        "stage": "PREPROCESS",
        "progress": 0.1,
    })

    try:
        selected_engine = _resolve_separation_engine(request_id)
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
                )
        else:
            engine_result = _run_demucs_engine(
                request_id=request_id,
                file_path=file_path,
                output_dir=output_dir,
                stems_dir=stems_dir,
            )

        if not engine_result or len(engine_result.get("stems", [])) == 0:
            raise RuntimeError("No stems produced by selected separation engine")

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



