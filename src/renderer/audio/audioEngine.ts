/**
 * @module renderer/audio/audioEngine
 * @description 音频引擎抽象接口 — 所有播放引擎适配器必须实现此接口
 *
 * GPT R9 Must Fix #1：明确 adapter 边界。
 * playbackStore 只依赖此接口，不感知具体播放技术（Web Audio / Howler / etc.）。
 * 具体实现位于 webAudioEngineAdapter.ts。
 * 实例创建由 composition root / factory 完成，不由 store 自行 new。
 *
 * GPT R9 Must Fix #2：onError 使用 AudioEngineError 结构化错误。
 * GPT R9 Must Fix #3：预留 setPlaybackRate 接口。
 * GPT R9 Must Fix #5：漂移检测回调。
 *
 * MODULE SPEC:
 *
 * 多轨同步播放引擎 — 当前方案为 MVP
 *
 * 架构（具体实现 webAudioEngineAdapter.ts）：
 *   HTMLAudioElement[N] → MediaElementSourceNode → trackGainNode[N] →
 *     masterGainNode → AudioContext.destination
 *
 * 同步策略（MVP，已知局限）：
 *   - 所有 HTMLAudioElement 统一设置 currentTime 实现 seek
 *   - 同时调用 play()/pause()
 *   - 以第一条轨道 currentTime 作为时钟参考
 *   - 已知局限：HTMLAudioElement 间存在微秒级偏移
 *   - 漂移容忍阈值：DRIFT_TOLERANCE_MS（默认 50ms）
 *   - 超过阈值时触发 onDriftDetected 回调 + 自动重新对齐
 *
 * 后续替换条件：
 *   - 当漂移问题在用户可感知范围频繁出现时
 *   - 替换方案：AudioBuffer 预解码 + 精确 startTime
 *   - 替换只需实现新的 IAudioEngine adapter，不影响 store/view
 */

import { AudioEngineError } from '../../shared/contracts';

// ============================================================================
// 1. 类型
// ============================================================================

/**
 * 音轨加载信息
 */
export interface AudioTrackInfo {
  /** 轨道唯一 ID（与 StemTrackDTO.id 对应） */
  id: string;
  /** 音频文件绝对路径（Electron 本地文件） */
  filePath: string;
}

/**
 * 漂移检测事件
 */
export interface DriftEvent {
  /** 参考轨道 ID */
  referenceTrackId: string;
  /** 偏移轨道 ID */
  driftedTrackId: string;
  /** 偏移量（ms） */
  driftMs: number;
  /** 是否已自动修正 */
  corrected: boolean;
}

// ============================================================================
// 2. 常量
// ============================================================================

/**
 * 轨间漂移容忍阈值（ms）
 *
 * GPT R9 Must Fix #5：超过此值触发 onDriftDetected + 自动对齐。
 * MVP 设定为 50ms — 人耳对节奏偏移的感知阈值约 20-30ms，
 * 50ms 留了安全余量，避免频繁修正。
 */
export const DRIFT_TOLERANCE_MS = 50;

/**
 * 播放速度合法范围（GPT R9 Must Fix #3）
 *
 * 规格文档 §5.8：0.5x / 0.75x / 1.0x / 1.25x / 1.5x / 2.0x
 */
export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 2.0;

// ============================================================================
// 3. 引擎接口
// ============================================================================

/**
 * 音频引擎接口 — 所有播放引擎适配器的抽象契约
 *
 * 规格文档要求任何第三方音频引擎通过 adapter 接入（ADR-006）。
 * playbackStore 只依赖此接口。
 */
export interface IAudioEngine {
  /**
   * 加载多轨音频文件
   *
   * 调用此方法会清理之前已加载的轨道。
   * 所有轨道加载完成后 resolve。
   *
   * @throws Error 任何轨道加载失败
   */
  loadTracks(tracks: AudioTrackInfo[]): Promise<void>;

  /** 开始/恢复播放（所有轨道同步） */
  play(): void;

  /** 暂停播放 */
  pause(): void;

  /** 跳转到指定时间（ms） */
  seek(timeMs: number): void;

  /**
   * 设置主音量
   * @param volume 0.0（静音）~ 1.0（最大）
   */
  setMasterVolume(volume: number): void;

  /**
   * 设置单轨音量
   * @param trackId 轨道 ID
   * @param volume 0.0 ~ 1.0
   */
  setTrackVolume(trackId: string, volume: number): void;

  /**
   * 设置单轨静音
   * @param trackId 轨道 ID
   * @param muted 是否静音
   */
  setTrackMute(trackId: string, muted: boolean): void;

  /**
   * 设置播放速度（GPT R9 Must Fix #3）
   *
   * @param rate 合法范围 0.5 ~ 2.0
   * 规格文档 §5.8：切速时尽量保持音高、位置不明显漂移。
   * HTMLAudioElement.playbackRate 原生支持此范围。
   */
  setPlaybackRate(rate: number): void;

  /** 获取当前播放位置（ms） */
  getCurrentTimeMs(): number;

  /** 获取总时长（ms），取所有轨道中的最大值 */
  getDurationMs(): number;

  /** 是否正在播放 */
  isPlaying(): boolean;

  /** 是否已加载轨道 */
  isLoaded(): boolean;

  /** 获取已加载的轨道 ID 列表 */
  getLoadedTrackIds(): string[];

  /**
   * 注册时间更新回调
   * @returns 取消订阅函数
   */
  onTimeUpdate(callback: (timeMs: number) => void): () => void;

  /**
   * 注册播放结束回调
   * @returns 取消订阅函数
   */
  onEnded(callback: () => void): () => void;

  /**
   * 注册错误回调（GPT R9 Must Fix #2：结构化错误）
   * @returns 取消订阅函数
   */
  onError(callback: (error: AudioEngineError) => void): () => void;

  /**
   * 注册漂移检测回调（GPT R9 Must Fix #5）
   * @returns 取消订阅函数
   */
  onDriftDetected(callback: (event: DriftEvent) => void): () => void;

  /**
   * 销毁引擎 — 释放所有资源
   *
   * 资源回收语义（GPT R9 Suggested #4）：
   * - 断开所有 MediaElementSourceNode
   * - 移除所有事件监听
   * - 暂停并清空所有 HTMLAudioElement
   * - 关闭 AudioContext
   * - 清空所有回调集合
   * - 幂等：重复调用安全
   */
  dispose(): void;
}
