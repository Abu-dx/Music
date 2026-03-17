/**
 * @module renderer/stores/jobStore
 * @description 分离任务运行态 ViewModel — 独立于 projectStore
 *
 * GPT R7 Must Fix #1：从 projectStore 拆出，严格遵守
 * 规格文档的 store 所有权划分（projectStore / jobStore / playbackStore / ...）。
 *
 * 职责（ADR-004）：
 * - 持有当前任务 jobId、stage、progress、elapsedMs、warnings
 * - 持有缓存命中状态（GPT R7 Must Fix #5）
 * - 持有完成/失败状态
 * - 接收 main 进程推送的进度/完成事件
 * - 提供 View 可直接绑定的只读派生属性
 *
 * 不负责：
 * - 项目元数据 → projectStore
 * - 播放控制 → playbackStore（后续 Round）
 * - 发起分离/取消 → 由页面调用 electronAPI，结果通知到此 store
 *
 * 幂等性（GPT R7 Suggested #5）：
 * - dispose() 可重复调用，第二次起为空操作
 * - subscribe() 返回 unsubscribe 函数，页面卸载时调用
 */

import {
  JobStoreState,
  SeparationProgressDTO,
  SeparationCompleteDTO,
} from '../../shared/contracts';
import {
  STAGE_DISPLAY_NAMES,
  ORDERED_STAGES,
} from '../../shared/stageMapping';

// ============================================================================
// 1. IPC 接口（jobStore 需要的子集）
// ============================================================================

export interface IJobElectronAPI {
  /** 订阅分离进度事件 */
  onSeparationProgress(callback: (data: SeparationProgressDTO) => void): () => void;
  /** 订阅分离完成事件 */
  onSeparationComplete(callback: (data: SeparationCompleteDTO) => void): () => void;
}

// ============================================================================
// 2. Store 状态快照
// ============================================================================

/**
 * JobStore 状态快照 — View 层通过 getSnapshot() 消费
 *
 * GPT R7 Must Fix #6：页面只做只读消费，不自行推导任务核心状态。
 */
export interface JobStoreSnapshot {
  // --- 核心运行态 ---
  currentJobId: string | null;
  stage: string | null;
  stageDisplayName: string | null;
  progress: number;
  isRunning: boolean;
  /** 已耗时（ms），仅 isRunning=true 时有意义 */
  elapsedMs: number;

  // --- 缓存命中（GPT R7 Must Fix #5） ---
  cacheHit: boolean;

  // --- 完成/失败 ---
  errorCode: string | null;
  errorMessage: string | null;
  isComplete: boolean;
  isFailed: boolean;

  // --- 附加 ---
  warnings: string[];

  // --- 阶段时间线（只读派生，GPT R7 Must Fix #6） ---
  /** 当前阶段在 ORDERED_STAGES 中的索引，-1 表示未开始 */
  currentStageIndex: number;
  /** 有序阶段列表（引用，不可变） */
  orderedStages: readonly { key: string; label: string }[];
}

// ============================================================================
// 3. 接口
// ============================================================================

export interface IJobStore {
  getSnapshot(): JobStoreSnapshot;

  /**
   * 标记任务开始（由页面在 startSeparation 成功后调用）
   */
  startJob(jobId: string, cacheHit: boolean): void;

  /**
   * 重置 store 到空闲状态
   */
  reset(): void;

  subscribe(listener: () => void): () => void;

  /**
   * 销毁 Store（清理 IPC 订阅）
   *
   * 幂等：重复调用安全（第二次起空操作）。
   */
  dispose(): void;
}

// ============================================================================
// 4. 实现
// ============================================================================

export class JobStore implements IJobStore {
  // --- 状态 ---
  private currentJobId: string | null = null;
  private stage: string | null = null;
  private progress = 0;
  private startedAt: number | null = null;
  private cacheHit = false;
  private errorCode: string | null = null;
  private errorMessage: string | null = null;
  private warnings: string[] = [];
  private isComplete = false;

  // --- 订阅 ---
  private listeners = new Set<() => void>();
  private unsubProgress: (() => void) | null = null;
  private unsubComplete: (() => void) | null = null;
  private disposed = false;

  constructor(api: IJobElectronAPI) {
    this.unsubProgress = api.onSeparationProgress((data) => {
      if (data.jobId === this.currentJobId) {
        this.stage = data.stage;
        this.progress = data.progress;
        this.notify();
      }
    });

    this.unsubComplete = api.onSeparationComplete((data) => {
      if (data.jobId === this.currentJobId) {
        this.isComplete = true;
        this.progress = data.success ? 100 : this.progress;
        this.warnings = data.warnings ?? [];
        this.cacheHit = data.cacheHit ?? false;

        if (!data.success) {
          this.errorCode = 'SEPARATION_FAILED';
          this.errorMessage = data.errorMessage ?? '分离失败';
        } else {
          this.errorCode = null;
          this.errorMessage = null;
          this.stage = 'DONE';
        }

        this.notify();
      }
    });
  }

  getSnapshot(): JobStoreSnapshot {
    const stageIndex = this.stage
      ? ORDERED_STAGES.findIndex((s) => s.key === this.stage)
      : -1;

    return {
      currentJobId: this.currentJobId,
      stage: this.stage,
      stageDisplayName: this.stage ? (STAGE_DISPLAY_NAMES[this.stage] ?? this.stage) : null,
      progress: this.progress,
      isRunning: this.currentJobId !== null && !this.isComplete,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      cacheHit: this.cacheHit,
      errorCode: this.errorCode,
      errorMessage: this.errorMessage,
      isComplete: this.isComplete && this.errorCode === null,
      isFailed: this.isComplete && this.errorCode !== null,
      warnings: this.warnings,
      currentStageIndex: stageIndex,
      orderedStages: ORDERED_STAGES,
    };
  }

  startJob(jobId: string, cacheHit: boolean): void {
    this.currentJobId = jobId;
    this.stage = null;
    this.progress = 0;
    this.startedAt = Date.now();
    this.cacheHit = cacheHit;
    this.errorCode = null;
    this.errorMessage = null;
    this.warnings = [];
    this.isComplete = false;
    this.notify();
  }

  reset(): void {
    this.currentJobId = null;
    this.stage = null;
    this.progress = 0;
    this.startedAt = null;
    this.cacheHit = false;
    this.errorCode = null;
    this.errorMessage = null;
    this.warnings = [];
    this.isComplete = false;
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubProgress?.();
    this.unsubComplete?.();
    this.unsubProgress = null;
    this.unsubComplete = null;
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* View 层错误不影响 Store */ }
    }
  }
}
