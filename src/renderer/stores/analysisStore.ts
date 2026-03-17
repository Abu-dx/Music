/**
 * @module renderer/stores/analysisStore
 * @description 和弦分析 ViewModel — 持有和弦分析结果 + 当前和弦派生
 *
 * Round 11 创建。
 *
 * 职责（ADR-004 — analysisStore 所有权）：
 * - 持有 ChordAnalysisResultDTO（当前项目的和弦分析结果）
 * - 提供 getCurrentChord(timeMs) 查询接口（O(logN) 二分查找）
 * - 持有"当前和弦标签" — 由 playerViewController 根据播放位置派生
 * - 持有分析状态（loading / loaded / error / empty）
 * - 通过 subscribe/getSnapshot 驱动 React（useSyncExternalStore）
 *
 * 不负责：
 * - 播放控制 → playbackStore
 * - 项目元数据 → projectStore
 * - 任务运行态 → jobStore
 * - 跨 store 编排 → playerViewController
 *
 * 数据流：
 *   main 进程 (getChordAnalysis IPC)
 *     → playerViewController.loadPlayer()
 *       → analysisStore.setChordResult(result)
 *
 *   播放位置更新 (playbackStore.currentTimeMs)
 *     → playerViewController tick / 监听
 *       → analysisStore.updateCurrentTime(timeMs)
 *         → 内部二分查找 → currentChordLabel 更新
 *
 * 幂等性：dispose() 可重复调用
 */

import { ChordAnalysisResultDTO, ChordSegmentDTO, AnalysisErrorDTO } from '../../shared/contracts';

// ============================================================================
// 1. 纯函数：按时间查找当前和弦（O(logN) 二分查找）
// ============================================================================

/**
 * 在有序和弦片段列表中查找包含 timeMs 的片段
 *
 * 导出为纯函数，方便单元测试。
 *
 * @param segments 按 startMs 升序排列的和弦片段
 * @param timeMs 当前播放时间
 * @returns 匹配的 ChordSegmentDTO，未命中返回 null
 */
export function findChordAtTime(
  segments: ReadonlyArray<ChordSegmentDTO>,
  timeMs: number,
): ChordSegmentDTO | null {
  if (segments.length === 0) return null;
  if (timeMs < segments[0].startMs) return null;
  if (timeMs >= segments[segments.length - 1].endMs) return null;

  let low = 0;
  let high = segments.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const seg = segments[mid];

    if (timeMs < seg.startMs) {
      high = mid - 1;
    } else if (timeMs >= seg.endMs) {
      low = mid + 1;
    } else {
      // seg.startMs <= timeMs < seg.endMs → 命中
      return seg;
    }
  }

  return null; // 落在间隙中
}

// ============================================================================
// 2. 分析状态枚举
// ============================================================================

export type AnalysisLoadingState = 'idle' | 'loading' | 'loaded' | 'error' | 'empty';

// ============================================================================
// 3. Store 状态快照
// ============================================================================

export interface AnalysisStoreSnapshot {
  /** 加载状态 */
  loadingState: AnalysisLoadingState;
  /** 和弦分析结果（loaded 时有值） */
  chordResult: ChordAnalysisResultDTO | null;
  /** 当前和弦标签（由播放位置派生） */
  currentChordLabel: string | null;
  /** 当前和弦片段（由播放位置派生） */
  currentSegment: ChordSegmentDTO | null;
  /** 和弦片段总数 */
  segmentCount: number;
  /** 分析来源（'mixed' | 'harmonic_mix' 等） */
  source: string | null;
  /** 调性估计 */
  estimatedKey: string | null;
  /** BPM 估计 */
  estimatedBpm: number | null;
  /** 关联项目 ID */
  projectId: string | null;
  /** 结构化错误（GPT R11 Must Fix #3） */
  error: AnalysisErrorDTO | null;
  /**
   * 诊断警告（GPT R11 Must Fix #5）
   * 来自 ChordAnalysisResultDTO.warnings
   */
  warnings: string[];
  /** 分析耗时（ms）— 规格文档 §22.8（GPT R12-Fix MF#5） */
  elapsedMs: number | null;
  /** 分析引擎版本（GPT R12-Fix MF#5） */
  analysisVersion: string | null;
  /** 和弦词汇表版本（GPT R12-Fix MF#5） */
  vocabularyVersion: string | null;
}

// ============================================================================
// 4. 接口
// ============================================================================

export interface IAnalysisStore {
  getSnapshot(): AnalysisStoreSnapshot;

  /**
   * 设置和弦分析结果
   * null 表示该项目没有和弦分析（empty 状态）
   */
  setChordResult(result: ChordAnalysisResultDTO | null, projectId: string): void;

  /** 标记加载中 */
  setLoading(projectId: string): void;

  /** 标记错误（GPT R11 Must Fix #3：结构化错误） */
  setError(error: AnalysisErrorDTO, projectId: string): void;

  /**
   * 更新当前播放时间 → 派生当前和弦
   *
   * 由 playerViewController 在播放时间更新时调用。
   * 内部使用二分查找，O(logN) 复杂度。
   */
  updateCurrentTime(timeMs: number): void;

  /** 清空分析结果 */
  clear(): void;

  subscribe(listener: () => void): () => void;
  dispose(): void;
}

// ============================================================================
// 5. 实现
// ============================================================================

export class AnalysisStore implements IAnalysisStore {
  private loadingState: AnalysisLoadingState = 'idle';
  private chordResult: ChordAnalysisResultDTO | null = null;
  private currentChordLabel: string | null = null;
  private currentSegment: ChordSegmentDTO | null = null;
  private projectId: string | null = null;
  private error: AnalysisErrorDTO | null = null;
  private warnings: string[] = [];

  private listeners = new Set<() => void>();
  private disposed = false;

  getSnapshot(): AnalysisStoreSnapshot {
    return {
      loadingState: this.loadingState,
      chordResult: this.chordResult,
      currentChordLabel: this.currentChordLabel,
      currentSegment: this.currentSegment,
      segmentCount: this.chordResult?.segments.length ?? 0,
      source: this.chordResult?.source ?? null,
      estimatedKey: this.chordResult?.estimatedKey ?? null,
      estimatedBpm: this.chordResult?.estimatedBpm ?? null,
      projectId: this.projectId,
      error: this.error,
      warnings: this.warnings,
      elapsedMs: this.chordResult?.elapsedMs ?? null,
      analysisVersion: this.chordResult?.analysisVersion ?? null,
      vocabularyVersion: this.chordResult?.vocabularyVersion ?? null,
    };
  }

  setChordResult(result: ChordAnalysisResultDTO | null, projectId: string): void {
    this.projectId = projectId;
    this.error = null;

    if (result === null || result.segments.length === 0) {
      this.chordResult = result;
      this.loadingState = 'empty';
      this.currentChordLabel = null;
      this.currentSegment = null;
      this.warnings = result?.warnings ?? [];
    } else {
      this.chordResult = result;
      this.loadingState = 'loaded';
      this.currentChordLabel = null;
      this.currentSegment = null;
      this.warnings = result.warnings ?? [];
    }

    this.notify();
  }

  setLoading(projectId: string): void {
    this.projectId = projectId;
    this.loadingState = 'loading';
    this.error = null;
    this.notify();
  }

  setError(error: AnalysisErrorDTO, projectId: string): void {
    this.projectId = projectId;
    this.loadingState = 'error';
    this.error = error;
    this.chordResult = null;
    this.currentChordLabel = null;
    this.currentSegment = null;
    this.warnings = [];
    this.notify();
  }

  updateCurrentTime(timeMs: number): void {
    if (!this.chordResult || this.chordResult.segments.length === 0) {
      if (this.currentChordLabel !== null) {
        this.currentChordLabel = null;
        this.currentSegment = null;
        this.notify();
      }
      return;
    }

    const segment = findChordAtTime(this.chordResult.segments, timeMs);
    const newLabel = segment?.label ?? null;

    // 只在实际变化时通知（避免每帧触发 re-render）
    if (newLabel !== this.currentChordLabel) {
      this.currentChordLabel = newLabel;
      this.currentSegment = segment;
      this.notify();
    }
  }

  clear(): void {
    this.loadingState = 'idle';
    this.chordResult = null;
    this.currentChordLabel = null;
    this.currentSegment = null;
    this.projectId = null;
    this.error = null;
    this.warnings = [];
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* View 层错误不影响 Store */ }
    }
  }
}
