/**
 * @module renderer/stores/projectStore
 * @description 项目 ViewModel — 持有项目生命周期状态、元数据、结果数据
 *
 * GPT R7 Must Fix #1：任务运行态已拆出到 jobStore.ts。
 * GPT R8 Must Fix #1：结果页数据链路正式闭环 —
 *   getProjectResult / getStemsByProject / openProjectDir。
 *
 * 职责（ADR-003, ADR-004）：
 * - 持有 currentProject + recentProjects + isLoading
 * - 持有当前项目的结果摘要 + 分轨列表（结果页 + 播放器共用）
 * - 通过 IPC 与 main 进程通信（contextBridge）
 * - 提供项目创建/查询/结果查询/打开目录接口
 *
 * 不负责：
 * - 任务运行态（stage/progress/warnings）→ jobStore
 * - 播放控制 → playbackStore
 *
 * 幂等性（GPT R7 Suggested #5）：
 * - dispose() 可重复调用，第二次起为空操作
 */

import {
  ProjectSummaryDTO,
  ProjectResultSummaryDTO,
  StemTrackDTO,
  SeparationStartResultDTO,
  MasterWaveformDTO,
  ChordAnalysisResultDTO,
} from '../../shared/contracts';

// ============================================================================
// 1. IPC 接口（projectStore 需要的子集）
// ============================================================================

export interface IProjectElectronAPI {
  /** 获取最近项目列表 */
  getRecentProjects(limit: number): Promise<ProjectSummaryDTO[]>;

  /** 通过文件路径创建项目并启动分离 */
  startSeparation(filePath: string): Promise<SeparationStartResultDTO>;

  /** 取消分离任务 */
  cancelSeparation(jobId?: string): Promise<void>;

  /** 获取项目详情 */
  getProject(projectId: string): Promise<ProjectSummaryDTO | null>;

  /** 获取缓存占用摘要（GPT R7 Suggested #2） */
  getCacheStats?(): Promise<{ totalSizeBytes: number; projectCount: number } | null>;

  /**
   * 获取项目结果摘要（GPT R8 Must Fix #1）
   * 包含 elapsedMs / cacheHit / sourceTypeLabel 等结果页专属字段
   */
  getProjectResult(projectId: string): Promise<ProjectResultSummaryDTO | null>;

  /**
   * 获取项目分轨列表（GPT R8 Must Fix #1）
   * 包含 filePath / presence / mergedFrom 等完整信息
   */
  getStemsByProject(projectId: string): Promise<StemTrackDTO[]>;

  /**
   * 在系统文件管理器中打开项目目录（GPT R8 Must Fix #2）
   * 通过 Electron shell.openPath() 实现
   */
  openProjectDir(projectId: string): Promise<void>;

  /**
   * 获取项目主波形数据（Round 10，R11 语义修正）
   *
   * GPT R10 Must Fix #3：返回单条主波形（基于原始混合音频生成），
   * 而非分轨波形集合。null 表示尚未生成。
   */
  getMasterWaveform(projectId: string): Promise<MasterWaveformDTO | null>;

  /**
   * 获取和弦分析结果（Round 11）
   *
   * 返回 null 表示尚未分析或分析失败。
   * ADR-006：和弦分析不阻塞主链路，可能在项目 ready 后异步完成。
   */
  getChordAnalysis(projectId: string): Promise<ChordAnalysisResultDTO | null>;
}

// ============================================================================
// 2. Store 状态快照
// ============================================================================

export interface ProjectStoreSnapshot {
  currentProject: ProjectSummaryDTO | null;
  recentProjects: ProjectSummaryDTO[];
  isLoading: boolean;
  /** 缓存占用摘要（GPT R7 Suggested #2） */
  cacheStats: { totalSizeBytes: number; projectCount: number } | null;
  /** 项目结果摘要（GPT R8 Must Fix #1） */
  projectResult: ProjectResultSummaryDTO | null;
  /** 分轨列表（GPT R8 Must Fix #1） */
  stems: StemTrackDTO[];
}

// ============================================================================
// 3. 接口
// ============================================================================

export interface IProjectStore {
  getSnapshot(): ProjectStoreSnapshot;
  loadRecentProjects(limit?: number): Promise<void>;
  startSeparation(filePath: string): Promise<SeparationStartResultDTO>;
  cancelSeparation(jobId?: string): Promise<void>;
  loadProject(projectId: string): Promise<void>;
  loadCacheStats(): Promise<void>;
  /** 加载结果摘要 + 分轨列表（GPT R8 Must Fix #1） */
  loadProjectResult(projectId: string): Promise<void>;
  /** 打开项目目录（GPT R8 Must Fix #2） */
  openProjectDir(projectId: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

// ============================================================================
// 4. 实现
// ============================================================================

export class ProjectStore implements IProjectStore {
  private currentProject: ProjectSummaryDTO | null = null;
  private recentProjects: ProjectSummaryDTO[] = [];
  private isLoading = false;
  private cacheStats: { totalSizeBytes: number; projectCount: number } | null = null;
  private projectResult: ProjectResultSummaryDTO | null = null;
  private stems: StemTrackDTO[] = [];

  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly api: IProjectElectronAPI) {}

  getSnapshot(): ProjectStoreSnapshot {
    return {
      currentProject: this.currentProject,
      recentProjects: this.recentProjects,
      isLoading: this.isLoading,
      cacheStats: this.cacheStats,
      projectResult: this.projectResult,
      stems: this.stems,
    };
  }

  async loadRecentProjects(limit = 20): Promise<void> {
    this.isLoading = true;
    this.notify();

    try {
      this.recentProjects = await this.api.getRecentProjects(limit);
    } finally {
      this.isLoading = false;
      this.notify();
    }
  }

  async startSeparation(filePath: string): Promise<SeparationStartResultDTO> {
    this.isLoading = true;
    this.notify();

    try {
      const result = await this.api.startSeparation(filePath);
      await this.loadProject(result.projectId);
      return result;
    } finally {
      this.isLoading = false;
      this.notify();
    }
  }

  async cancelSeparation(jobId?: string): Promise<void> {
    await this.api.cancelSeparation(jobId);
  }

  async loadProject(projectId: string): Promise<void> {
    const project = await this.api.getProject(projectId);
    if (project) {
      this.currentProject = project;
      this.notify();
    }
  }

  async loadCacheStats(): Promise<void> {
    if (this.api.getCacheStats) {
      this.cacheStats = await this.api.getCacheStats() ?? null;
      this.notify();
    }
  }

  async loadProjectResult(projectId: string): Promise<void> {
    this.isLoading = true;
    this.notify();

    try {
      const [result, stems] = await Promise.all([
        this.api.getProjectResult(projectId),
        this.api.getStemsByProject(projectId),
      ]);
      this.projectResult = result;
      this.stems = stems;
    } finally {
      this.isLoading = false;
      this.notify();
    }
  }

  async openProjectDir(projectId: string): Promise<void> {
    await this.api.openProjectDir(projectId);
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
