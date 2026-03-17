/**
 * @module renderer/controllers/playerViewController
 * @description 播放器页面 ViewModel/Controller — 跨 store 协调收口
 *
 * GPT R10 Must Fix #1：页面层不应直接驱动 projectStore + playbackStore 组合流程。
 * 本 Controller 收口所有跨 store 协调逻辑，PlayerPage 只传"用户意图"。
 *
 * 职责：
 * - 协调 projectStore / playbackStore / analysisStore 的组合加载流程
 * - 从 projectStore 获取 StemTrackDTO[] → 过滤可播放轨道 → 传给 playbackStore
 * - 从 projectStore 获取 MasterWaveformDTO → 传给 playbackStore
 * - 从 projectStore 获取 ChordAnalysisResultDTO → 传给 analysisStore
 * - 订阅 playbackStore 时间更新 → 驱动 analysisStore.updateCurrentTime()
 * - 注入 drift 告警处理器到 playbackStore（统一日志链路）
 * - 提供"打开文件"入口占位 contract（GPT R10 Suggested #2）
 *
 * 不负责：
 * - 播放引擎操作 → playbackStore 内部封装
 * - 分析计算 → main 进程
 * - UI 渲染 → PlayerPage
 *
 * 设计决策（GPT R10 Decision #1）：
 * 不引入完整 Application Service，使用轻量 Controller 收口。
 * 后续如果需要持久化/通知等逻辑，再升级为 Application Service。
 *
 * 数据流：
 *   PlayerPage（用户意图）→ PlayerViewController → projectStore / playbackStore / analysisStore
 *   playbackStore（时间更新）→ PlayerViewController → analysisStore（和弦派生）
 */

import { IProjectStore } from '../stores/projectStore';
import { IPlaybackStore, PlaybackStore } from '../stores/playbackStore';
import { IAnalysisStore } from '../stores/analysisStore';
import { IPlayerDataService } from '../services/playerDataService';
import { AudioTrackInfo } from '../audio/audioEngine';
import { PlaybackStatus } from '../../shared/enums';
import type { DriftAlertDTO, StemTrackDTO, AnalysisErrorDTO } from '../../shared/contracts';

// ============================================================================
// 1. 可播放轨道筛选（GPT R10 Must Fix #4）
// ============================================================================

/**
 * 从 StemTrackDTO[] 中筛选可播放轨道
 *
 * 规则（GPT R10 Must Fix #4）：
 * - missing 轨不进入底层播放图
 * - merged 轨默认可播放（如果有 filePath）
 * - exists 轨必须有有效 filePath
 * - 空 filePath / null filePath 被过滤
 *
 * 返回 AudioTrackInfo[] + stemTypes 映射
 */
export function filterPlayableTracks(stems: StemTrackDTO[]): {
  tracks: AudioTrackInfo[];
  stemTypes: Record<string, string>;
  skippedCount: number;
} {
  const tracks: AudioTrackInfo[] = [];
  const stemTypes: Record<string, string> = {};
  let skippedCount = 0;

  for (const stem of stems) {
    // missing 轨不进入播放图
    if (stem.presence === 'missing') {
      skippedCount++;
      continue;
    }

    // filePath 必须有效
    if (!stem.filePath || stem.filePath.trim() === '') {
      skippedCount++;
      continue;
    }

    tracks.push({ id: stem.id, filePath: stem.filePath });
    stemTypes[stem.id] = stem.stemType;
  }

  return { tracks, stemTypes, skippedCount };
}

// ============================================================================
// 2. Controller 接口
// ============================================================================

export interface IPlayerViewController {
  /**
   * 加载播放器项目 — 一站式协调
   *
   * 1. 从 projectStore 获取 stems + waveform + chord analysis
   * 2. 过滤可播放轨道
   * 3. 调用 playbackStore.loadProject()
   * 4. 设置波形 + 和弦数据
   * 5. 开始和弦位置追踪
   */
  loadPlayer(projectId: string): Promise<void>;

  /** 卸载当前播放器 — 清理所有状态 */
  unloadPlayer(): void;

  /**
   * 打开文件（GPT R10 Suggested #2：占位 contract）
   *
   * 规格文档要求播放器页支持"打开文件"。
   * 当前为占位，实际 shell.openPath 实现在后续 Round。
   */
  openFile(projectId: string): Promise<void>;

  /** 释放资源 */
  dispose(): void;
}

// ============================================================================
// 3. 实现
// ============================================================================

export class PlayerViewController implements IPlayerViewController {
  private timeTrackingUnsub: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly projectStore: IProjectStore,
    private readonly playbackStore: IPlaybackStore,
    private readonly analysisStore: IAnalysisStore,
    /**
     * GPT R11 Must Fix #1：正式 data service，消除 (as any).api 穿透。
     */
    private readonly playerDataService: IPlayerDataService,
    /**
     * 可选：drift 告警日志处理器
     * 由 composition root 注入，接入统一日志链路。
     * 如不提供则 drift alert 仍存储在 playbackStore.lastDriftAlert，
     * 但不进入外部日志系统。
     */
    private readonly onDriftAlert?: (alert: DriftAlertDTO) => void,
  ) {
    // 注入 drift 处理器到 playbackStore
    if (this.playbackStore instanceof PlaybackStore) {
      (this.playbackStore as PlaybackStore).setDriftAlertHandler(
        this.onDriftAlert ?? null,
      );
    }
  }

  async loadPlayer(projectId: string): Promise<void> {
    if (this.disposed) return;

    // 1. 确保 projectStore 有结果数据
    await this.projectStore.loadProjectResult(projectId);
    const snap = this.projectStore.getSnapshot();

    // 2. 过滤可播放轨道（GPT R10 Must Fix #4）
    const { tracks, stemTypes } = filterPlayableTracks(snap.stems);

    // 3. 加载到 playbackStore（内部处理空轨道 → Error 状态）
    await this.playbackStore.loadProject(projectId, tracks, stemTypes);

    // 4. 并行获取波形 + 和弦分析
    this.analysisStore.setLoading(projectId);

    const [waveform, chordResult] = await Promise.all([
      this.projectStore.getSnapshot().stems.length > 0
        ? this.playerDataService.getMasterWaveform(projectId)
        : Promise.resolve(null),
      this.safeGetChordAnalysis(projectId),
    ]);

    // 5. 设置波形
    this.playbackStore.setMasterWaveform(waveform);

    // 6. 设置和弦分析结果
    this.analysisStore.setChordResult(chordResult, projectId);

    // 7. 开始和弦时间追踪
    this.startChordTimeTracking();
  }

  unloadPlayer(): void {
    this.stopChordTimeTracking();
    this.playbackStore.unload();
    this.analysisStore.clear();
  }

  async openFile(projectId: string): Promise<void> {
    // GPT R11 Must Fix #1：通过 playerDataService 走受控命令
    await this.playerDataService.openProjectDir(projectId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopChordTimeTracking();

    // 清除 drift handler
    if (this.playbackStore instanceof PlaybackStore) {
      (this.playbackStore as PlaybackStore).setDriftAlertHandler(null);
    }
  }

  // ---- Private ----

  /**
   * 订阅 playbackStore 时间变化 → 驱动和弦标签更新
   *
   * GPT R11 Suggested #3：只在 Playing 状态时更新和弦追踪，
   * 避免 Paused/Ended 状态下的无意义计算。
   *
   * 通过 subscribe + getSnapshot 差量检测 currentTimeMs 变化。
   * 由于 analysisStore.updateCurrentTime 内部只在和弦标签真正变化时
   * 才触发 notify，所以不会导致每帧 re-render。
   */
  private startChordTimeTracking(): void {
    this.stopChordTimeTracking();

    let lastTimeMs = -1;

    this.timeTrackingUnsub = this.playbackStore.subscribe(() => {
      const snap = this.playbackStore.getSnapshot();

      // GPT R11 Suggested #3：仅 Playing 状态驱动和弦追踪
      if (snap.status !== PlaybackStatus.Playing) return;

      if (snap.currentTimeMs !== lastTimeMs) {
        lastTimeMs = snap.currentTimeMs;
        this.analysisStore.updateCurrentTime(snap.currentTimeMs);
      }
    });
  }

  private stopChordTimeTracking(): void {
    this.timeTrackingUnsub?.();
    this.timeTrackingUnsub = null;
  }

  /**
   * GPT R11 Must Fix #1：通过 IPlayerDataService 获取和弦分析，
   * 失败时设置结构化 AnalysisErrorDTO。
   */
  private async safeGetChordAnalysis(projectId: string) {
    try {
      return await this.playerDataService.getChordAnalysis(projectId);
    } catch (err) {
      const analysisError: AnalysisErrorDTO = {
        code: 'CHORD_LOAD_FAILED',
        message: err instanceof Error ? err.message : String(err),
        userMessage: '和弦分析加载失败',
        context: {
          projectId,
          operation: 'loadChordAnalysis',
        },
        retryable: true,
      };
      this.analysisStore.setError(analysisError, projectId);
      return null;
    }
  }
}
