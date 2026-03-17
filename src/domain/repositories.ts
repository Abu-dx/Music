/**
 * @module domain/repositories
 * @description Repository 接口定义 — Domain 层的持久化抽象
 *
 * Why: 规格文档 §24.2 要求模块间通过 Interface/Abstract Contract 交互，
 *      不允许跨层直接访问彼此内部实现。
 *      ADR-008 要求 Domain 层不直接 new 基础设施实现。
 *
 * GPT Round-2 Must Fix #2: 集合查询增加 PaginationParams / PaginatedResult
 * GPT Round-2 Must Fix #3: 统一错误语义
 *   - 找不到 → 返回 null
 *   - 违规操作 → 抛出 AppError
 *   - 写操作成功 → void（无需返回 boolean）
 * GPT Round-2 Must Fix #4: 新增 IStateTransitionRepository
 *
 * 使用规则：
 * - 这些接口由 infrastructure/db 层实现
 * - Application Service 通过 DI 获取 Repository 实例
 * - Renderer 层不允许直接使用 Repository（ADR-003）
 * - 所有涉及大批量操作的方法必须遵循 ADR-002（<50ms 或后台化）
 */

import {
  Project,
  StemFile,
  ParseJob,
  WaveformData,
  ChordAnalysisResult,
  PlaybackPreset,
  AppSettings,
} from './entities';
import { ProjectStatus, JobStatus, CacheEntryStatus } from '../shared/enums';
import { StateTransitionRecord } from '../shared/contracts';

// ============================================================================
// 0. 分页支持（GPT R2 Must Fix #2）
// ============================================================================

/**
 * 分页查询参数
 *
 * Why: GPT Round-2 Must Fix #2 要求集合查询方法加分页/窗口化参数，
 *      防止 main process 同步加载大量数据导致阻塞（ADR-002）。
 */
export interface PaginationParams {
  /** 每页条数，默认 50 */
  limit: number;
  /** 偏移量，默认 0 */
  offset: number;
}

/**
 * 分页查询结果
 */
export interface PaginatedResult<T> {
  /** 当前页数据 */
  items: T[];
  /** 总记录数（用于 UI 分页计算） */
  total: number;
  /** 是否还有更多数据 */
  hasMore: boolean;
}

/** 默认分页参数 */
export const DEFAULT_PAGINATION: PaginationParams = {
  limit: 50,
  offset: 0,
};

// ============================================================================
// 1. IProjectRepository
// ============================================================================

/**
 * 项目 Repository
 *
 * 错误语义（GPT R2 Must Fix #3）：
 * - findById / findByFingerprint: 不存在返回 null（不抛异常）
 * - create: 指纹冲突抛 AppError(DB_QUERY_FAILED)
 * - update / updateStatus / delete: 目标不存在抛 AppError(DB_QUERY_FAILED)
 * - updateStatus: 非法转移由调用方（Application Service）提前校验并抛 INVALID_STATE_TRANSITION
 */
export interface IProjectRepository {
  /**
   * 创建项目记录
   * @throws AppError(DB_QUERY_FAILED) 指纹冲突或写入失败
   */
  create(project: Project): Promise<void>;

  /** 按 ID 查找项目，不存在返回 null */
  findById(id: string): Promise<Project | null>;

  /** 按指纹查找项目（缓存命中核心方法），不存在返回 null */
  findByFingerprint(fingerprint: string): Promise<Project | null>;

  /**
   * 查询最近项目列表（首页展示）
   * @param pagination - 分页参数（默认 limit=50, offset=0）
   */
  listRecent(pagination?: PaginationParams): Promise<PaginatedResult<Project>>;

  /**
   * 按缓存状态查询项目（缓存管理页）
   * @param pagination - 分页参数
   * 注意：若项目数量很大，此方法可能需要后台化（ADR-002）
   */
  listByCacheStatus(status: CacheEntryStatus, pagination?: PaginationParams): Promise<PaginatedResult<Project>>;

  /**
   * 更新项目字段
   * @throws AppError(DB_QUERY_FAILED) 目标不存在或写入失败
   */
  update(id: string, fields: Partial<Omit<Project, 'id'>>): Promise<void>;

  /**
   * 更新项目状态
   * 调用方必须提前校验状态转移合法性（assertProjectTransition）
   * @throws AppError(DB_QUERY_FAILED) 目标不存在或写入失败
   */
  updateStatus(id: string, status: ProjectStatus): Promise<void>;

  /**
   * 删除项目记录（硬删除 SQLite 索引；文件清理由 Service 层编排）
   * @throws AppError(DB_QUERY_FAILED) 目标不存在或写入失败
   */
  delete(id: string): Promise<void>;

  /** 计算所有活跃项目的总大小 */
  getTotalSize(): Promise<number>;

  // --- 聚合查询（GPT R4 Must Fix #2） ---

  /**
   * 按缓存状态统计项目数量（不加载全量行）
   *
   * Why: 避免 getStorageStats() 把所有项目拉回内存再算 count，
   *      直接在 SQLite 层做 COUNT(*) GROUP BY cache_status。
   */
  countByCacheStatus(status: CacheEntryStatus): Promise<number>;

  /**
   * 按缓存状态汇总项目总大小（不加载全量行）
   *
   * SELECT SUM(total_size_bytes) FROM projects WHERE cache_status = ?
   */
  sumSizeByStatus(status: CacheEntryStatus): Promise<number>;
}

// ============================================================================
// 2. IStemFileRepository
// ============================================================================

/**
 * 轨道文件 Repository
 *
 * 错误语义：
 * - findById: 不存在返回 null
 * - createMany: 空数组不报错，静默跳过
 */
export interface IStemFileRepository {
  /**
   * 批量创建轨道记录（分离完成或导入完成时）
   * @throws AppError(DB_QUERY_FAILED) 写入失败
   */
  createMany(stems: StemFile[]): Promise<void>;

  /** 按项目 ID 查询所有轨道 */
  findByProjectId(projectId: string): Promise<StemFile[]>;

  /** 按 ID 查询单个轨道，不存在返回 null */
  findById(id: string): Promise<StemFile | null>;

  /**
   * 更新轨道字段
   * @throws AppError(DB_QUERY_FAILED) 目标不存在或写入失败
   */
  update(id: string, fields: Partial<Omit<StemFile, 'id'>>): Promise<void>;

  /** 按项目 ID 删除所有轨道记录 */
  deleteByProjectId(projectId: string): Promise<void>;
}

// ============================================================================
// 3. IParseJobRepository
// ============================================================================

/**
 * 解析任务 Repository
 *
 * 错误语义：
 * - findById / findLatestByProjectId: 不存在返回 null
 * - updateProgress / updateStatus / complete: 目标不存在抛 AppError
 */
export interface IParseJobRepository {
  /**
   * 创建任务记录
   * @throws AppError(DB_QUERY_FAILED) 写入失败
   */
  create(job: ParseJob): Promise<void>;

  /** 按 ID 查询任务，不存在返回 null */
  findById(id: string): Promise<ParseJob | null>;

  /** 按项目 ID 查询最新任务，不存在返回 null */
  findLatestByProjectId(projectId: string): Promise<ParseJob | null>;

  /**
   * 更新任务进度与阶段
   * @throws AppError(DB_QUERY_FAILED) 目标不存在
   */
  updateProgress(id: string, stage: string, progress: number): Promise<void>;

  /**
   * 更新任务最终状态
   * @throws AppError(DB_QUERY_FAILED) 目标不存在
   */
  updateStatus(id: string, status: JobStatus, errorCode?: string, errorMessage?: string): Promise<void>;

  /**
   * 完成任务（设置 finishedAt、elapsedMs）
   * @throws AppError(DB_QUERY_FAILED) 目标不存在
   */
  complete(id: string, status: JobStatus, elapsedMs: number): Promise<void>;

  /**
   * 查询项目的任务历史
   * @param pagination - 分页参数
   */
  listByProjectId(projectId: string, pagination?: PaginationParams): Promise<PaginatedResult<ParseJob>>;
}

// ============================================================================
// 4. IWaveformRepository
// ============================================================================

/** 波形数据 Repository */
export interface IWaveformRepository {
  /**
   * 保存波形数据引用（upsert 语义：存在则更新）
   * @throws AppError(DB_QUERY_FAILED) 写入失败
   */
  save(data: WaveformData): Promise<void>;

  /** 按项目 ID 查询，不存在返回 null */
  findByProjectId(projectId: string): Promise<WaveformData | null>;

  /** 按项目 ID 删除 */
  deleteByProjectId(projectId: string): Promise<void>;
}

// ============================================================================
// 5. IChordAnalysisRepository
// ============================================================================

/**
 * 和弦分析结果 Repository
 *
 * 错误语义：
 * - findByProjectId: 不存在返回 null
 * - isCompatible: 无记录返回 false
 */
export interface IChordAnalysisRepository {
  /**
   * 保存分析结果（upsert 语义）
   * @throws AppError(DB_QUERY_FAILED) 写入失败
   */
  save(result: ChordAnalysisResult): Promise<void>;

  /** 按项目 ID 查询，不存在返回 null */
  findByProjectId(projectId: string): Promise<ChordAnalysisResult | null>;

  /** 按项目 ID 删除 */
  deleteByProjectId(projectId: string): Promise<void>;

  /**
   * 检查缓存兼容性
   * 返回 true 表示现有结果的 analysisVersion 和 vocabularyVersion 仍然兼容
   * 无记录时返回 false
   */
  isCompatible(projectId: string, analysisVersion: string, vocabularyVersion: string): Promise<boolean>;
}

// ============================================================================
// 6. IAppSettingsRepository
// ============================================================================

/**
 * 应用设置 Repository
 *
 * 错误语义：
 * - get: 始终返回有效设置（首次调用自动初始化默认值）
 */
export interface IAppSettingsRepository {
  /** 获取当前设置（保证非 null） */
  get(): Promise<AppSettings>;

  /**
   * 更新设置（部分字段）
   * @throws AppError(DB_QUERY_FAILED) 写入失败
   */
  update(fields: Partial<AppSettings>): Promise<void>;

  /** 重置为默认值 */
  resetToDefaults(): Promise<void>;
}

// ============================================================================
// 7. IPlaybackPresetRepository
// ============================================================================

/**
 * 播放预设 Repository（可选持久化）
 *
 * 错误语义：
 * - findByProjectId: 不存在返回 null
 * - save: upsert 语义
 */
export interface IPlaybackPresetRepository {
  /**
   * 保存播放预设（upsert 语义）
   * @throws AppError(DB_QUERY_FAILED) 写入失败
   */
  save(preset: PlaybackPreset): Promise<void>;

  /** 按项目 ID 查询，不存在返回 null */
  findByProjectId(projectId: string): Promise<PlaybackPreset | null>;

  /** 按项目 ID 删除 */
  deleteByProjectId(projectId: string): Promise<void>;
}

// ============================================================================
// 8. IStateTransitionRepository（GPT R2 Must Fix #4）
// ============================================================================

/**
 * 状态变更审计 Repository
 *
 * Why: GPT Round-2 Must Fix #4 要求补全 state_transitions 的审计查询接口。
 *      Application Service 每次状态变更后写入一条记录。
 *      用于调试、审计、状态回放。
 *
 * 对应 SQLite 表：state_transitions（schema.ts）
 */
export interface IStateTransitionRepository {
  /**
   * 记录一条状态变更
   * @throws AppError(DB_QUERY_FAILED) 写入失败
   */
  record(transition: StateTransitionRecord): Promise<void>;

  /**
   * 按实体查询变更历史
   * @param pagination - 分页参数
   */
  listByEntity(
    entityType: string,
    entityId: string,
    pagination?: PaginationParams,
  ): Promise<PaginatedResult<StateTransitionRecord>>;

  /**
   * 按 correlationId 查询关联变更（用于追踪一次用例编排的所有状态变更）
   */
  listByCorrelationId(correlationId: string): Promise<StateTransitionRecord[]>;

  /**
   * 清理过期审计记录（防止无限膨胀）
   * @param beforeTimestamp - 删除此时间戳之前的记录
   * @returns 删除的记录数
   */
  purge(beforeTimestamp: number): Promise<number>;
}
