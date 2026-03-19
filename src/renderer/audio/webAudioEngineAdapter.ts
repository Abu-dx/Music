/**
 * @module renderer/audio/webAudioEngineAdapter
 * @description Web Audio API 播放引擎适配器 — IAudioEngine 的具体实现
 *
 * MODULE SPEC（GPT R10 Suggested #5）：
 *
 * 1. 职责
 *    - 封装 Web Audio API 多轨同步播放
 *    - 提供 per-track GainNode 单轨音量/静音控制
 *    - rAF 循环驱动时间更新 + 轨间漂移检测
 *
 * 2. 架构
 *    HTMLAudioElement[N] → MediaElementSourceNode → trackGainNode[N] →
 *      masterGainNode → AudioContext.destination
 *
 * 3. 同步策略（MVP 已知局限）
 *    - 所有 HTMLAudioElement 统一 currentTime 实现 seek
 *    - 同时调用 play()/pause()
 *    - 以第一条轨道为时钟参考
 *    - 已知局限：HTMLAudioElement 间存在微秒级偏移
 *    - 漂移超过 DRIFT_TOLERANCE_MS → 自动重新对齐 + 回调通知
 *
 * 4. 替换条件
 *    - 漂移问题频繁影响用户体验时
 *    - 替换方案：AudioBuffer 预解码 + 精确 startTime
 *    - 替换只需实现新 IAudioEngine adapter，不影响 store/view
 *
 * 5. 依赖
 *    - IAudioEngine 接口（audioEngine.ts）
 *    - AudioEngineError DTO（shared/contracts.ts）
 *    - 浏览器原生 Web Audio API + HTMLAudioElement
 *
 * 6. 资源回收
 *    - dispose() 断开所有 SourceNode、移除事件监听、
 *      暂停并清空 HTMLAudioElement、关闭 AudioContext
 *    - 幂等：重复调用安全
 *
 * GPT R9 Must Fix #1：playbackStore 不直接 import 此文件，只通过 IAudioEngine 接口交互。
 * 实例创建放到 composition root / factory。
 */

import {
  IAudioEngine,
  AudioTrackInfo,
  DriftEvent,
  DRIFT_TOLERANCE_MS,
  MIN_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE,
} from './audioEngine';
import { AudioEngineError } from '../../shared/contracts';

// ============================================================================
// 1. 路径工具（GPT R10 Must Fix #6：受控工具函数 + 失败错误码）
// ============================================================================

/**
 * filePathToUrl 失败错误码
 */
export const FILE_PATH_ERROR_CODES = {
  EMPTY_PATH: 'FILE_PATH_EMPTY',
  RELATIVE_PATH: 'FILE_PATH_RELATIVE',
  CONVERSION_FAILED: 'FILE_PATH_CONVERSION_FAILED',
} as const;

/**
 * 本地文件路径 → file:// URL
 *
 * GPT R10 Must Fix #6：从 JSDoc 提升为受控工具函数 contract。
 *
 * 平台差异：
 * - Windows: C:\foo\bar.wav → file:///C:/foo/bar.wav
 *   （反斜杠统一为正斜杠，驱动器盘符前加 /）
 * - macOS/Linux: /foo/bar.wav → file:///foo/bar.wav
 *   （已有前导 /，直接拼 file://）
 *
 * 特殊字符处理策略：
 * - 空格：Electron file:// 协议原生支持，不额外编码
 * - 中文：Electron file:// 协议原生支持 UTF-8 路径
 * - # % ? 等 URL 保留字符：本版本暂不做 encodeURI，
 *   如果路径含这些字符导致加载失败，将在 createTrack onError 中
 *   产生结构化 AudioEngineError（code: PLAYBACK_FAILED）
 *
 * 失败路径（GPT R10 Must Fix #6）：
 * - 空路径 → 抛 AudioEngineError（code: FILE_PATH_EMPTY）
 * - 相对路径 → 抛 AudioEngineError（code: FILE_PATH_RELATIVE）
 *
 * @throws AudioEngineError 路径为空或非绝对路径时
 */
export function filePathToUrl(filePath: string): string {
  if (!filePath || filePath.trim() === '') {
    throw createEngineError(
      FILE_PATH_ERROR_CODES.EMPTY_PATH,
      'filePath is empty or whitespace-only',
      '文件路径为空',
      { filePath, operation: 'filePathToUrl' },
      false,
    );
  }

  const normalized = filePath.replace(/\\/g, '/');

  // Windows 绝对路径: C:/ D:/ etc.
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized}`;
  }

  // Unix 绝对路径: /foo/bar
  if (normalized.startsWith('/')) {
    return `file://${normalized}`;
  }

  // 相对路径 → 拒绝（桌面端应该总是绝对路径）
  throw createEngineError(
    FILE_PATH_ERROR_CODES.RELATIVE_PATH,
    `filePath "${filePath}" is not an absolute path`,
    '文件路径不是绝对路径',
    { filePath, operation: 'filePathToUrl' },
    false,
  );
}

// ============================================================================
// 2. 内部轨道结构
// ============================================================================

interface InternalTrack {
  id: string;
  element: HTMLAudioElement;
  sourceNode: MediaElementAudioSourceNode;
  /** 单轨增益节点 */
  gainNode: GainNode;
  /** 当前设定音量（不受 mute 影响） */
  volume: number;
  /** 是否被静音 */
  muted: boolean;
}

// ============================================================================
// 3. 错误工厂
// ============================================================================

function createEngineError(
  code: string,
  message: string,
  userMessage: string,
  context: AudioEngineError['context'],
  retryable = false,
): AudioEngineError {
  return { code, message, userMessage, context, retryable };
}

// ============================================================================
// 4. 适配器实现
// ============================================================================

export class WebAudioEngineAdapter implements IAudioEngine {
  private audioContext: AudioContext | null = null;
  private masterGainNode: GainNode | null = null;
  private tracks: InternalTrack[] = [];
  private playing = false;
  private loaded = false;
  private disposed = false;
  private currentPlaybackRate = 1.0;

  // 回调集合
  private timeUpdateCallbacks = new Set<(timeMs: number) => void>();
  private endedCallbacks = new Set<() => void>();
  private errorCallbacks = new Set<(error: AudioEngineError) => void>();
  private driftCallbacks = new Set<(event: DriftEvent) => void>();

  private rafHandle: number | null = null;

  async loadTracks(trackInfos: AudioTrackInfo[]): Promise<void> {
    this.cleanup();

    if (trackInfos.length === 0) {
      this.loaded = true;
      return;
    }

    this.ensureAudioContext();

    const loadPromises = trackInfos.map(info => this.createTrack(info));

    try {
      const tracks = await Promise.all(loadPromises);
      this.tracks = tracks;
      this.loaded = true;

      // 注册第一条轨道的 ended 事件
      if (this.tracks.length > 0) {
        this.tracks[0].element.addEventListener('ended', this.handleEnded);
      }
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  play(): void {
    if (!this.loaded || this.playing || this.disposed) return;

    if (this.audioContext?.state === 'suspended') {
      this.audioContext.resume();
    }

    for (const track of this.tracks) {
      track.element.play().catch(err => {
        this.emitError(createEngineError(
          'PLAYBACK_FAILED',
          `Track ${track.id} play failed: ${err}`,
          '轨道播放失败',
          { trackId: track.id, operation: 'play' },
          true,
        ));
      });
    }

    this.playing = true;
    this.startTimeUpdateLoop();
  }

  pause(): void {
    if (!this.playing) return;

    for (const track of this.tracks) {
      track.element.pause();
    }

    this.playing = false;
    this.stopTimeUpdateLoop();
  }

  seek(timeMs: number): void {
    const timeSec = Math.max(0, timeMs / 1000);

    for (const track of this.tracks) {
      const clampedTime = Math.min(timeSec, track.element.duration || 0);
      track.element.currentTime = clampedTime;
    }

    this.emitTimeUpdate(timeMs);
  }

  setMasterVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    // 指数曲线：人耳听觉为对数响应，线性滑块需要平方映射才自然
    const gain = clamped * clamped;
    if (this.masterGainNode) {
      this.masterGainNode.gain.setValueAtTime(
        gain,
        this.audioContext?.currentTime ?? 0,
      );
    }
  }

  setTrackVolume(trackId: string, volume: number): void {
    const track = this.tracks.find(t => t.id === trackId);
    if (!track) return;

    track.volume = Math.max(0, Math.min(1, volume));
    this.applyTrackGain(track);
  }

  setTrackMute(trackId: string, muted: boolean): void {
    const track = this.tracks.find(t => t.id === trackId);
    if (!track) return;

    track.muted = muted;
    this.applyTrackGain(track);
  }

  setPlaybackRate(rate: number): void {
    const clamped = Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, rate));
    this.currentPlaybackRate = clamped;

    for (const track of this.tracks) {
      track.element.playbackRate = clamped;
    }
  }

  getCurrentTimeMs(): number {
    if (this.tracks.length === 0) return 0;
    return (this.tracks[0].element.currentTime ?? 0) * 1000;
  }

  getDurationMs(): number {
    if (this.tracks.length === 0) return 0;
    let maxDuration = 0;
    for (const track of this.tracks) {
      const d = track.element.duration;
      if (!isNaN(d) && d > maxDuration) {
        maxDuration = d;
      }
    }
    return maxDuration * 1000;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  getLoadedTrackIds(): string[] {
    return this.tracks.map(t => t.id);
  }

  onTimeUpdate(callback: (timeMs: number) => void): () => void {
    this.timeUpdateCallbacks.add(callback);
    return () => { this.timeUpdateCallbacks.delete(callback); };
  }

  onEnded(callback: () => void): () => void {
    this.endedCallbacks.add(callback);
    return () => { this.endedCallbacks.delete(callback); };
  }

  onError(callback: (error: AudioEngineError) => void): () => void {
    this.errorCallbacks.add(callback);
    return () => { this.errorCallbacks.delete(callback); };
  }

  onDriftDetected(callback: (event: DriftEvent) => void): () => void {
    this.driftCallbacks.add(callback);
    return () => { this.driftCallbacks.delete(callback); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.pause();
    this.cleanup();

    if (this.audioContext) {
      this.audioContext.close().catch(() => { /* 忽略 */ });
      this.audioContext = null;
    }

    this.masterGainNode = null;
    this.timeUpdateCallbacks.clear();
    this.endedCallbacks.clear();
    this.errorCallbacks.clear();
    this.driftCallbacks.clear();
  }

  // ---- Private ----

  private ensureAudioContext(): void {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioContext();
      this.masterGainNode = this.audioContext.createGain();
      this.masterGainNode.connect(this.audioContext.destination);
    }
  }

  private createTrack(info: AudioTrackInfo): Promise<InternalTrack> {
    return new Promise((resolve, reject) => {
      const element = new Audio();
      element.crossOrigin = 'anonymous';
      element.preload = 'auto';
      element.playbackRate = this.currentPlaybackRate;

      const onCanPlay = () => {
        element.removeEventListener('canplaythrough', onCanPlay);
        element.removeEventListener('error', onError);

        const sourceNode = this.audioContext!.createMediaElementSource(element);
        const gainNode = this.audioContext!.createGain();
        sourceNode.connect(gainNode);
        gainNode.connect(this.masterGainNode!);

        resolve({
          id: info.id,
          element,
          sourceNode,
          gainNode,
          volume: 1.0,
          muted: false,
        });
      };

      const onError = () => {
        element.removeEventListener('canplaythrough', onCanPlay);
        element.removeEventListener('error', onError);
        reject(new Error(`Failed to load audio track: ${info.filePath}`));
      };

      element.addEventListener('canplaythrough', onCanPlay, { once: true });
      element.addEventListener('error', onError, { once: true });

      element.src = filePathToUrl(info.filePath);
    });
  }

  /**
   * 应用单轨增益（mute 时 gain=0）
   */
  private applyTrackGain(track: InternalTrack): void {
    // 指数曲线：与 setMasterVolume 保持一致
    const gain = track.muted ? 0 : track.volume * track.volume;
    track.gainNode.gain.setValueAtTime(
      gain,
      this.audioContext?.currentTime ?? 0,
    );
  }

  private cleanup(): void {
    this.stopTimeUpdateLoop();

    for (const track of this.tracks) {
      track.element.removeEventListener('ended', this.handleEnded);
      track.element.pause();
      track.element.src = '';
      track.element.load();
      try { track.sourceNode.disconnect(); } catch { /* 可能已断开 */ }
      try { track.gainNode.disconnect(); } catch { /* 可能已断开 */ }
    }

    this.tracks = [];
    this.loaded = false;
    this.playing = false;
  }

  private startTimeUpdateLoop(): void {
    if (this.rafHandle !== null) return;

    const tick = () => {
      if (!this.playing || this.disposed) {
        this.rafHandle = null;
        return;
      }

      const currentTime = this.getCurrentTimeMs();
      this.emitTimeUpdate(currentTime);

      // GPT R9 Must Fix #5：漂移检测
      this.checkDrift();

      this.rafHandle = requestAnimationFrame(tick);
    };

    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopTimeUpdateLoop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  /**
   * GPT R9 Must Fix #5：检测轨间漂移
   *
   * 以第一条轨道为参考时钟，检测其他轨道偏移。
   * 超过 DRIFT_TOLERANCE_MS 时自动对齐 + 触发回调。
   */
  private checkDrift(): void {
    if (this.tracks.length < 2) return;

    const refTime = this.tracks[0].element.currentTime;

    for (let i = 1; i < this.tracks.length; i++) {
      const track = this.tracks[i];
      const trackTime = track.element.currentTime;
      const driftMs = Math.abs(refTime - trackTime) * 1000;

      if (driftMs > DRIFT_TOLERANCE_MS) {
        // 自动修正
        track.element.currentTime = refTime;

        const event: DriftEvent = {
          referenceTrackId: this.tracks[0].id,
          driftedTrackId: track.id,
          driftMs,
          corrected: true,
        };

        for (const cb of this.driftCallbacks) {
          try { cb(event); } catch { /* 不影响引擎 */ }
        }
      }
    }
  }

  private handleEnded = (): void => {
    this.playing = false;
    this.stopTimeUpdateLoop();
    for (const cb of this.endedCallbacks) {
      try { cb(); } catch { /* 不影响引擎 */ }
    }
  };

  private emitTimeUpdate(timeMs: number): void {
    for (const cb of this.timeUpdateCallbacks) {
      try { cb(timeMs); } catch { /* 不影响引擎 */ }
    }
  }

  private emitError(error: AudioEngineError): void {
    for (const cb of this.errorCallbacks) {
      try { cb(error); } catch { /* 不影响引擎 */ }
    }
  }
}
