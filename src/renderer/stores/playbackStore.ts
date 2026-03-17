/**
 * @module renderer/stores/playbackStore
 * @description 播放 ViewModel — 持有播放会话状态 + 单轨控制
 *
 * Round 9 创建，Round 10 升级，Round 11 增强：
 * - GPT R10 Must Fix #2：drift 结构化告警（DriftAlertDTO）
 * - GPT R10 Must Fix #3：波形语义 → MasterWaveformDTO（单条主波形）
 * - GPT R10 Must Fix #4：可播放轨道筛选（missing 不入播放图）
 * - GPT R10 Must Fix #5：PlaybackStatus 显式状态机转移表
 * - GPT R10 Suggested #1：recalcEffectiveGains 导出为纯函数
 * - GPT R10 Suggested #4：StemPlaybackControlDTO 与 StemTrackDTO 关系已在 contracts.ts 注释
 *
 * 职责（ADR-004）：
 * - 持有播放会话状态（PlaybackStatus 枚举驱动）
 * - 持有 per-stem 控制状态 + effectiveGain 计算
 * - 封装 IAudioEngine 交互，View 层不直接调用引擎
 * - 通过 subscribe/getSnapshot 驱动 React（useSyncExternalStore）
 *
 * 不负责：
 * - 项目元数据 → projectStore
 * - 任务运行态 → jobStore
 * - 和弦分析 → analysisStore
 * - 跨 store 协调 → playerViewController
 *
 * 幂等性：dispose() / unload() 可重复调用
 */

import { PlaybackStatus } from '../../shared/enums';
import {
  AudioEngineError,
  StemPlaybackControlDTO,
  MasterWaveformDTO,
  DriftAlertDTO,
} from '../../shared/contracts';
import { IAudioEngine, AudioTrackInfo, DriftEvent } from '../audio/audioEngine';

// ============================================================================
// 0. PlaybackStatus 状态机转移表（GPT R10 Must Fix #5）
// ============================================================================

/**
 * 播放状态机 — 允许的转换与触发方法
 *
 * ┌────────┐  loadProject()  ┌──────────┐
 * │  Idle  │ ──────────────► │ Loading  │
 * └────────┘                 └──────────┘
 *                                │
 *             ┌──────────────────┤
 *             │ success          │ failure
 *             ▼                  ▼
 *        ┌──────────┐      ┌─────────┐
 *        │  Paused  │      │  Error  │
 *        └──────────┘      └─────────┘
 *             │  ▲               ▲
 *   play()   │  │ pause()       │ onError()
 *             ▼  │               │
 *        ┌──────────┐           │
 *        │ Playing  │───────────┘
 *        └──────────┘
 *             │
 *             │ onEnded()
 *             ▼
 *        ┌──────────┐
 *        │  Ended   │
 *        └──────────┘
 *             │
 *   play()   │  seek() → Paused
 *             ▼
 *        ┌──────────┐
 *        │ Playing  │ (replay from 0)
 *        └──────────┘
 *
 * 允许的转换：
 *   Idle     → Loading           (loadProject)
 *   Loading  → Paused            (load success)
 *   Loading  → Error             (load failure)
 *   Paused   → Playing           (play)
 *   Playing  → Paused            (pause)
 *   Playing  → Ended             (onEnded)
 *   Playing  → Error             (onError)
 *   Ended    → Playing           (play → replay from 0)
 *   Ended    → Paused            (seek → reposition)
 *   Error    → Loading           (retry via loadProject)
 *   Any      → Idle              (unload)
 *
 * 禁止的转换（guard 拦截，静默忽略）：
 *   Idle     → Playing/Paused    (未加载不可播放)
 *   Loading  → Playing           (加载中不可播放)
 *   Paused   → Ended             (不可直接跳 ended)
 */
export const PLAYBACK_STATE_TRANSITIONS: Record<PlaybackStatus, PlaybackStatus[]> = {
  [PlaybackStatus.Idle]:    [PlaybackStatus.Loading],
  [PlaybackStatus.Loading]: [PlaybackStatus.Paused, PlaybackStatus.Error],
  [PlaybackStatus.Paused]:  [PlaybackStatus.Playing, PlaybackStatus.Idle],
  [PlaybackStatus.Playing]: [PlaybackStatus.Paused, PlaybackStatus.Ended, PlaybackStatus.Error, PlaybackStatus.Idle],
  [PlaybackStatus.Ended]:   [PlaybackStatus.Playing, PlaybackStatus.Paused, PlaybackStatus.Loading, PlaybackStatus.Idle],
  [PlaybackStatus.Error]:   [PlaybackStatus.Loading, PlaybackStatus.Idle],
};

// ============================================================================
// 1. 纯函数：effectiveGain 计算（GPT R10 Suggested #1：可独立测试）
// ============================================================================

/**
 * 计算所有轨道的 effectiveGain
 *
 * 规格文档 §15：
 * - muted → gain = 0
 * - 任何轨道 soloed && 本轨非 solo → gain = 0
 * - 否则 → gain = volume
 *
 * 导出为纯函数，方便单元测试。
 * 输入不可变，返回新数组。
 */
export function calcEffectiveGains(
  controls: ReadonlyArray<Pick<StemPlaybackControlDTO, 'volume' | 'muted' | 'soloed'>>,
): number[] {
  const hasSoloed = controls.some(c => c.soloed);

  return controls.map(ctrl => {
    if (ctrl.muted) return 0;
    if (hasSoloed && !ctrl.soloed) return 0;
    return ctrl.volume;
  });
}

// ============================================================================
// 2. Store 状态快照
// ============================================================================

/**
 * PlaybackStore 状态快照 — View 层通过 getSnapshot() 消费
 *
 * GPT R9 Must Fix #4：使用 PlaybackStatus 枚举，不再用布尔组合。
 */
export interface PlaybackStoreSnapshot {
  /** 播放会话状态（idle/loading/playing/paused/ended/error） */
  status: PlaybackStatus;
  /** 当前播放位置（ms） */
  currentTimeMs: number;
  /** 总时长（ms） */
  durationMs: number;
  /** 主音量 0.0 ~ 1.0 */
  masterVolume: number;
  /** 播放速度（GPT R9 Must Fix #3） */
  playbackRate: number;
  /** 结构化错误（GPT R9 Must Fix #2） */
  error: AudioEngineError | null;
  /** 当前加载的项目 ID */
  currentProjectId: string | null;
  /** 已加载轨道数 — 只读诊断字段，用于 E2E 和日志排障 */
  loadedTrackCount: number;
  /** 单轨控制状态列表 */
  stemControls: StemPlaybackControlDTO[];
  /**
   * 主波形数据（GPT R10 Must Fix #3：明确为单条主波形，非分轨集合）
   * null 表示尚未加载
   */
  masterWaveform: MasterWaveformDTO | null;

  // ---- 便捷派生（只读） ----
  /** 是否有任何轨道被 solo */
  hasSoloedTrack: boolean;
  /** 最近一次漂移告警（诊断用） */
  lastDriftAlert: DriftAlertDTO | null;
}

// ============================================================================
// 3. 接口
// ============================================================================

export interface IPlaybackStore {
  getSnapshot(): PlaybackStoreSnapshot;

  /**
   * 加载项目轨道
   *
   * GPT R10 Must Fix #4：轨道筛选增强 ——
   * - missing 轨不进入底层播放图
   * - exists 但 filePath 非法时结构化报错
   * - 最终至少一个可播放轨，否则 Error
   *
   * @param projectId 项目 ID
   * @param tracks 轨道信息列表（由上层 controller 从 StemTrackDTO 映射过滤后传入）
   * @param stemTypes 各轨道的类型映射（trackId → stemType）
   */
  loadProject(
    projectId: string,
    tracks: AudioTrackInfo[],
    stemTypes: Record<string, string>,
  ): Promise<void>;

  /** 开始播放 */
  play(): void;
  /** 暂停播放 */
  pause(): void;
  /** 切换播放/暂停 */
  togglePlayPause(): void;
  /** 跳转到指定时间（ms） */
  seek(timeMs: number): void;
  /** 设置主音量 0.0 ~ 1.0 */
  setMasterVolume(volume: number): void;
  /** 设置播放速度 0.5 ~ 2.0 */
  setPlaybackRate(rate: number): void;

  // ---- 单轨控制（Round 10） ----
  /** 设置单轨音量 */
  setTrackVolume(trackId: string, volume: number): void;
  /** 切换单轨静音 */
  toggleTrackMute(trackId: string): void;
  /** 切换单轨独奏 */
  toggleTrackSolo(trackId: string): void;

  /** 设置主波形数据（GPT R10 Must Fix #3：单条主波形） */
  setMasterWaveform(waveform: MasterWaveformDTO | null): void;

  /** 卸载当前轨道 */
  unload(): void;

  subscribe(listener: () => void): () => void;
  dispose(): void;
}

// ============================================================================
// 4. 实现
// ============================================================================

/**
 * drift 告警节流窗口（ms）
 * GPT R11 Suggested #2：同一 track pair 在窗口内只发一次告警
 */
const DRIFT_THROTTLE_WINDOW_MS = 3000;

export class PlaybackStore implements IPlaybackStore {
  // --- 状态 ---
  private status: PlaybackStatus = PlaybackStatus.Idle;
  private currentTimeMs = 0;
  private durationMs = 0;
  private masterVolume = 1.0;
  private playbackRate = 1.0;
  private error: AudioEngineError | null = null;
  private currentProjectId: string | null = null;
  private loadedTrackCount = 0;
  private stemControls: StemPlaybackControlDTO[] = [];
  private masterWaveform: MasterWaveformDTO | null = null;
  private lastDriftAlert: DriftAlertDTO | null = null;

  // --- 内部 ---
  private listeners = new Set<() => void>();
  private disposed = false;
  private unsubTimeUpdate: (() => void) | null = null;
  private unsubEnded: (() => void) | null = null;
  private unsubError: (() => void) | null = null;
  private unsubDrift: (() => void) | null = null;

  /** 可选：外部注入的告警回调（由 playerViewController 注入） */
  private driftAlertHandler: ((alert: DriftAlertDTO) => void) | null = null;

  /** drift 节流：trackPair → lastAlertTimestamp */
  private driftThrottleMap = new Map<string, number>();

  constructor(private readonly engine: IAudioEngine) {}

  /** 注入 drift 告警处理器（由 controller 调用） */
  setDriftAlertHandler(handler: ((alert: DriftAlertDTO) => void) | null): void {
    this.driftAlertHandler = handler;
  }

  getSnapshot(): PlaybackStoreSnapshot {
    const hasSoloedTrack = this.stemControls.some(s => s.soloed);
    return {
      status: this.status,
      currentTimeMs: this.currentTimeMs,
      durationMs: this.durationMs,
      masterVolume: this.masterVolume,
      playbackRate: this.playbackRate,
      error: this.error,
      currentProjectId: this.currentProjectId,
      loadedTrackCount: this.loadedTrackCount,
      stemControls: this.stemControls,
      masterWaveform: this.masterWaveform,
      hasSoloedTrack,
      lastDriftAlert: this.lastDriftAlert,
    };
  }

  async loadProject(
    projectId: string,
    tracks: AudioTrackInfo[],
    stemTypes: Record<string, string>,
  ): Promise<void> {
    // 先卸载旧的
    this.unloadInternal();

    // GPT R10 Must Fix #4：验证输入 — 空轨道集
    if (tracks.length === 0) {
      this.error = {
        code: 'NO_PLAYABLE_TRACKS',
        message: 'No playable tracks provided after filtering',
        userMessage: '没有可播放的轨道（所有轨道均缺失或路径无效）',
        context: { projectId, operation: 'loadProject' },
        retryable: false,
      };
      this.transition(PlaybackStatus.Error, 'loadProject: no playable tracks');
      this.currentProjectId = projectId;
      this.notify();
      return;
    }

    // GPT R10 Must Fix #4：验证 filePath 基本合法性
    const invalidTracks = tracks.filter(t => !t.filePath || t.filePath.trim() === '');
    if (invalidTracks.length > 0) {
      const validTracks = tracks.filter(t => t.filePath && t.filePath.trim() !== '');
      if (validTracks.length === 0) {
        this.error = {
          code: 'ALL_TRACKS_INVALID_PATH',
          message: `All ${tracks.length} tracks have invalid filePath`,
          userMessage: '所有轨道文件路径无效，无法播放',
          context: { projectId, operation: 'loadProject' },
          retryable: false,
        };
        this.transition(PlaybackStatus.Error, 'loadProject: all paths invalid');
        this.currentProjectId = projectId;
        this.notify();
        return;
      }
      // 部分无效：只用有效轨道继续
      tracks = validTracks;
    }

    this.transition(PlaybackStatus.Loading, 'loadProject: start');
    this.error = null;
    this.currentProjectId = projectId;
    this.notify();

    try {
      await this.engine.loadTracks(tracks);

      // 注册引擎回调
      this.unsubTimeUpdate = this.engine.onTimeUpdate((timeMs) => {
        this.currentTimeMs = timeMs;
        this.notify();
      });

      this.unsubEnded = this.engine.onEnded(() => {
        this.transition(PlaybackStatus.Ended, 'engine: ended');
        this.notify();
      });

      this.unsubError = this.engine.onError((err) => {
        this.error = err;
        this.transition(PlaybackStatus.Error, 'engine: error');
        this.notify();
      });

      // GPT R10 Must Fix #2 + R11 Suggested #2：漂移 → 结构化 DriftAlertDTO + 节流
      this.unsubDrift = this.engine.onDriftDetected((event: DriftEvent) => {
        // 节流：同一 track pair 在窗口内只发一次
        const pairKey = `${event.referenceTrackId}:${event.driftedTrackId}`;
        const now = Date.now();
        const lastAlert = this.driftThrottleMap.get(pairKey);
        if (lastAlert && (now - lastAlert) < DRIFT_THROTTLE_WINDOW_MS) {
          return; // 节流中，跳过
        }
        this.driftThrottleMap.set(pairKey, now);

        const alert: DriftAlertDTO = {
          projectId: this.currentProjectId ?? '',
          referenceTrackId: event.referenceTrackId,
          driftedTrackId: event.driftedTrackId,
          maxDriftMs: event.driftMs,
          toleranceMs: 50, // DRIFT_TOLERANCE_MS
          corrected: event.corrected,
          currentTimeMs: this.currentTimeMs,
          timestamp: now,
        };

        this.lastDriftAlert = alert;

        // 交给外部告警处理器（统一日志链路）
        if (this.driftAlertHandler) {
          this.driftAlertHandler(alert);
        }

        this.notify();
      });

      // 初始化 per-stem 控制
      this.stemControls = tracks.map(t => ({
        stemId: t.id,
        stemType: stemTypes[t.id] ?? 'other',
        volume: 1.0,
        muted: false,
        soloed: false,
        effectiveGain: 1.0,
      }));

      this.loadedTrackCount = tracks.length;
      this.durationMs = this.engine.getDurationMs();
      this.currentTimeMs = 0;
      this.transition(PlaybackStatus.Paused, 'loadProject: success');

      // 应用当前设置到引擎
      this.engine.setMasterVolume(this.masterVolume);
      this.engine.setPlaybackRate(this.playbackRate);
    } catch (err) {
      this.error = {
        code: 'LOAD_FAILED',
        message: err instanceof Error ? err.message : String(err),
        userMessage: '轨道加载失败',
        context: { projectId, operation: 'loadProject' },
        retryable: true,
      };
      this.transition(PlaybackStatus.Error, 'loadProject: catch');
      this.loadedTrackCount = 0;
    }

    this.notify();
  }

  play(): void {
    if (this.status !== PlaybackStatus.Paused && this.status !== PlaybackStatus.Ended) return;
    if (this.disposed) return;

    // 如果在 ended 状态重新播放，先 seek 到开头
    if (this.status === PlaybackStatus.Ended) {
      this.engine.seek(0);
      this.currentTimeMs = 0;
    }

    this.engine.play();
    this.transition(PlaybackStatus.Playing, 'play');
    this.error = null;
    this.notify();
  }

  pause(): void {
    if (this.status !== PlaybackStatus.Playing) return;
    this.engine.pause();
    this.transition(PlaybackStatus.Paused, 'pause');
    this.notify();
  }

  togglePlayPause(): void {
    if (this.status === PlaybackStatus.Playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  seek(timeMs: number): void {
    if (this.status === PlaybackStatus.Idle || this.status === PlaybackStatus.Loading) return;
    const clamped = Math.max(0, Math.min(timeMs, this.durationMs));
    this.engine.seek(clamped);
    this.currentTimeMs = clamped;

    // 如果在 ended 状态 seek，切回 paused
    if (this.status === PlaybackStatus.Ended) {
      this.transition(PlaybackStatus.Paused, 'seek from ended');
    }

    this.notify();
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    this.engine.setMasterVolume(this.masterVolume);
    this.notify();
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2.0, rate));
    this.engine.setPlaybackRate(this.playbackRate);
    this.notify();
  }

  // ---- 单轨控制 ----

  setTrackVolume(trackId: string, volume: number): void {
    const ctrl = this.stemControls.find(s => s.stemId === trackId);
    if (!ctrl) return;

    ctrl.volume = Math.max(0, Math.min(1, volume));
    this.recalcAndApplyGains();
    this.notify();
  }

  toggleTrackMute(trackId: string): void {
    const ctrl = this.stemControls.find(s => s.stemId === trackId);
    if (!ctrl) return;

    ctrl.muted = !ctrl.muted;
    this.recalcAndApplyGains();
    this.notify();
  }

  toggleTrackSolo(trackId: string): void {
    const ctrl = this.stemControls.find(s => s.stemId === trackId);
    if (!ctrl) return;

    ctrl.soloed = !ctrl.soloed;
    this.recalcAndApplyGains();
    this.notify();
  }

  setMasterWaveform(waveform: MasterWaveformDTO | null): void {
    this.masterWaveform = waveform;
    this.notify();
  }

  unload(): void {
    this.unloadInternal();
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unloadInternal();
    this.engine.dispose();
    this.listeners.clear();
  }

  // ---- Private: State Machine ----

  /**
   * 受控状态转换（GPT R11 Must Fix #2：runtime enforce）
   *
   * 检查 PLAYBACK_STATE_TRANSITIONS[current].includes(to)。
   * 合法 → 执行转换。
   * 非法 → 写结构化日志告警，不执行转换，返回 false。
   *
   * 特殊路径：
   * - Any → Idle (unload) 始终允许（受控降级路径）
   */
  private transition(to: PlaybackStatus, reason: string): boolean {
    const from = this.status;
    if (from === to) return true; // 幂等

    // Idle 是通用降级路径，始终允许
    const allowed = PLAYBACK_STATE_TRANSITIONS[from];
    if (!allowed.includes(to) && to !== PlaybackStatus.Idle) {
      // 非法转换 — 结构化日志
      const alert = {
        type: 'ILLEGAL_STATE_TRANSITION' as const,
        from,
        to,
        reason,
        projectId: this.currentProjectId,
        timestamp: Date.now(),
      };
      // 进入统一日志链路（目前输出到 console.error + 存储供诊断）
      console.error('[PlaybackStore] Illegal state transition:', alert);
      return false;
    }

    this.status = to;
    return true;
  }

  // ---- Private: Gain ----

  /**
   * 重新计算并同步 effectiveGain 到引擎
   *
   * 使用导出的纯函数 calcEffectiveGains() 计算，
   * 然后将结果同步到 stemControls 和底层引擎。
   */
  private recalcAndApplyGains(): void {
    const gains = calcEffectiveGains(this.stemControls);

    for (let i = 0; i < this.stemControls.length; i++) {
      const ctrl = this.stemControls[i];
      const gain = gains[i];
      ctrl.effectiveGain = gain;

      // 同步到引擎（mute 优先于 volume）
      this.engine.setTrackMute(ctrl.stemId, gain === 0);
      if (gain > 0) {
        this.engine.setTrackVolume(ctrl.stemId, gain);
      }
    }
  }

  private unloadInternal(): void {
    if (this.status === PlaybackStatus.Playing) {
      this.engine.pause();
    }

    this.unsubTimeUpdate?.();
    this.unsubEnded?.();
    this.unsubError?.();
    this.unsubDrift?.();
    this.unsubTimeUpdate = null;
    this.unsubEnded = null;
    this.unsubError = null;
    this.unsubDrift = null;

    // Idle 是通用降级路径，transition() 内部始终允许
    this.transition(PlaybackStatus.Idle, 'unload');
    this.currentTimeMs = 0;
    this.durationMs = 0;
    this.error = null;
    this.loadedTrackCount = 0;
    this.stemControls = [];
    this.masterWaveform = null;
    this.lastDriftAlert = null;
    this.driftThrottleMap.clear();
    // masterVolume + playbackRate 跨项目持久
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* View 层错误不影响 Store */ }
    }
  }
}
