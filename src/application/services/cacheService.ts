/**
 * @module application/services/cacheService
 * @description 缓存服务 — 缓存命中检测、缓存校验、重建触发、存储统计
 *
 * 职责（ADR-007, 规格文档 §24.2）：
 * - 判断新文件是否命中已有缓存（指纹查 SQLite）
 * - 校验已有项目缓存完整性（manifest + 文件系统 + SQLite 三方对照）
 * - 触发缓存重建（当 manifest 与实际文件不一致时）
 * - 管理失败项目隔离与清理
 * - 提供存储统计信息
 *
 * 不负责：
 * - 项目创建 / 状态转移 → ProjectService
 * - 播放器 / 导出 / 和弦识别 → 各自模块
 * - 直接访问 SQLite → 通过 Repository 接口
 * - 直接访问 fs → 通过 IProjectDirManager / IManifestManager
 *
 * DI（ADR-008）：
 * - 所有依赖通过构造函数注入
 * - 不直接 import better-sqlite3 / fs（ADR-009）
 *
 * 阻塞约束（ADR-002）：
 * - 所有方法均为 async
 * - validateProjectCache / getStorageStats 等可能耗时的操作
 *   由调用方（IPC handler）决定是否委托 worker_threads
 *
 * 错误语义（GPT R4 Must Fix #4 — 统一错误规范）：
 * - 查询方法（checkCacheHit）：无匹配返回 { hit: false }，不抛异常
 * - 校验方法（validateProjectCache）：目标不存在抛 AppError(DB_QUERY_FAILED)
 * - 写操作（markForDeletion）：目标不存在抛 AppError(DB_QUERY_FAILED)
 * - 批量清理（purgeMarkedProjects / cleanupFailedProjects）：
 *   单条失败不阻断整体，记错误日志，返回成功清理数
 * - isolateFailedProject：目标不存在时静默跳过（由 ProjectService 在
 *   状态变更 catch 块中调用，不应阻断主流程）
 *
 * 危险操作 & 幂等性（GPT R4 Must Fix #5）：
 * - purgeMarkedProjects(): 硬删除文件 + DB 记录，不可逆。
 *   幂等性：重复调用安全 — 已删除的项目不会再出现在 listByCacheStatus 结果中。
 *   单条删除失败不影响其他项目，下次调用会重试。
 * - cleanupFailedProjects(): 硬删除隔离区文件 + DB 记录，不可逆。
 *   幂等性：同 purgeMarkedProjects。
 * - markForDeletion(): 仅修改 cacheStatus，可重复调用（idempotent update）。
 * - isolateFailedProject(): 移动目录 + 更新状态。若目录已移动则
 *   dirManager.moveToFailed 应幂等处理（目标已存在则跳过）。
 */

import { Project } from '../../domain/entities';
import {
  IProjectRepository,
  IAppSettingsRepository,
} from '../../domain/repositories';
import { CacheEntryStatus } from '../../shared/enums';
import { AppError, ErrorCode } from '../../shared/errors';
import { ILogger } from '../../shared/logger';
import {
  IManifestManager,
  ManifestValidationResult,
  ManifestIssueType,
} from '../../infrastructure/fs/manifestManager';
import { IProjectDirManager } from '../../infrastructure/fs/projectDirManager';
import { IFingerprintCalculator } from '../../infrastructure/fs/fingerprintCalculator';

// ============================================================================
// 1. 缓存命中结果 DTO
// ============================================================================

/**
 * 缓存命中检测结果
 */
export interface CacheHitResult {
  /** 是否命中缓存 */
  hit: boolean;
  /** 命中的项目（hit=true 时非 null） */
  project: Project | null;
  /** 命中但缓存不完整时的校验结果 */
  validation: ManifestValidationResult | null;
}

/**
 * 缓存校验结果（面向上层的综合视图）
 *
 * 将 ManifestValidationResult + 目录存在性 + SQLite 一致性 综合后输出
 */
export interface CacheValidationResult {
  /** 项目 ID */
  projectId: string;
  /** 缓存是否完全有效 */
  valid: boolean;
  /** 是否可修复（部分文件缺失但 manifest 可解析） */
  repairable: boolean;
  /** 建议操作 */
  suggestedAction: CacheRepairAction;
  /** manifest 层校验详情 */
  manifestValidation: ManifestValidationResult;
  /** 目录是否存在 */
  directoryExists: boolean;
}

/**
 * 缓存修复建议
 */
export enum CacheRepairAction {
  /** 无需修复 */
  None = 'none',
  /** 需要重建索引（manifest 有效但 SQLite 不一致） */
  RebuildIndex = 'rebuild_index',
  /** 需要重新分离（关键文件缺失） */
  Reseparate = 'reseparate',
  /** 需要清理（目录或 manifest 损坏） */
  Cleanup = 'cleanup',
}

/**
 * 缓存存储统计
 */
export interface CacheStorageStats {
  /** 活跃项目数 */
  activeProjectCount: number;
  /** 活跃项目总大小（字节） */
  activeTotalSizeBytes: number;
  /** 失败隔离区项目数 */
  failedProjectCount: number;
  /** 标记待删除的项目数 */
  markedForDeletionCount: number;
}

// ============================================================================
// 2. 接口
// ============================================================================

/**
 * 缓存服务接口
 *
 * ProjectService / IPC handler 通过此接口管理缓存。
 *
 * 错误语义：
 * - checkCacheHit: 无匹配返回 { hit: false }，不抛异常
 * - validateProjectCache: 项目不存在抛 AppError(DB_QUERY_FAILED)
 * - markForDeletion: 项目不存在抛 AppError(DB_QUERY_FAILED)
 * - purgeMarkedProjects / cleanupFailedProjects: 单条失败不阻断
 * - isolateFailedProject: 项目不存在时静默跳过
 */
export interface ICacheService {
  /**
   * 检测缓存命中
   *
   * 流程：
   * 1. 按指纹查 SQLite
   * 2. 若命中，校验项目缓存完整性
   * 3. 返回命中结果（含校验详情）
   *
   * 错误语义：纯查询，不抛异常（格式无效 / 未命中均返回 hit=false）
   *
   * @param fingerprint - 文件指纹
   */
  checkCacheHit(fingerprint: string): Promise<CacheHitResult>;

  /**
   * 校验项目缓存完整性
   *
   * 综合 manifest + 文件系统 + SQLite 三方数据，
   * 返回结构化结果与修复建议。
   *
   * @param projectId - 项目 ID
   * @throws AppError(DB_QUERY_FAILED) 项目不存在
   */
  validateProjectCache(projectId: string): Promise<CacheValidationResult>;

  /**
   * 将项目标记为待删除（软删除）
   *
   * 不立即删除文件，只修改 cacheStatus。
   * 实际清理由 purgeMarkedProjects() 执行。
   *
   * 幂等性：重复调用安全（update 同一状态值无副作用）。
   *
   * @throws AppError(DB_QUERY_FAILED) 项目不存在
   */
  markForDeletion(projectId: string): Promise<void>;

  /**
   * 清理所有标记为待删除的项目（硬删除文件 + DB 记录）
   *
   * ⚠️ 危险操作：不可逆，硬删除文件系统目录与 DB 记录。
   * 幂等性：重复调用安全 — 已删除项目不再出现在查询结果中。
   * 容错性：单条失败不阻断整体，记日志后继续，下次调用会重试失败项。
   *
   * @returns 成功清理的项目数
   */
  purgeMarkedProjects(): Promise<number>;

  /**
   * 将失败项目移入隔离区
   *
   * 错误语义：项目不存在时静默返回（不抛异常），
   * 因为此方法由 ProjectService.updateProjectStatus 的 catch 块调用，
   * 不应阻断主流程。
   */
  isolateFailedProject(projectId: string): Promise<void>;

  /**
   * 清理失败隔离区
   *
   * ⚠️ 危险操作：不可逆，硬删除隔离区文件与 DB 记录。
   * 幂等性：同 purgeMarkedProjects。
   *
   * @returns 成功清理的项目数
   */
  cleanupFailedProjects(): Promise<number>;

  /**
   * 获取缓存存储统计
   *
   * 使用聚合查询（COUNT / SUM），不加载全量行（GPT R4 Must Fix #2）。
   */
  getStorageStats(): Promise<CacheStorageStats>;
}

// ============================================================================
// 3. 实现
// ============================================================================

export class CacheService implements ICacheService {
  constructor(
    private readonly projectRepo: IProjectRepository,
    private readonly settingsRepo: IAppSettingsRepository,
    private readonly dirManager: IProjectDirManager,
    private readonly manifestManager: IManifestManager,
    private readonly fingerprintCalculator: IFingerprintCalculator,
    private readonly logger: ILogger,
  ) {}

  async checkCacheHit(fingerprint: string): Promise<CacheHitResult> {
    const startMs = Date.now();

    // 1. 指纹格式校验
    if (!this.fingerprintCalculator.isValidFingerprint(fingerprint)) {
      this.logger.warn('Invalid fingerprint format in cache hit check', {
        stage: 'cacheService.checkCacheHit',
      });
      return { hit: false, project: null, validation: null };
    }

    // 2. 查 SQLite
    const project = await this.projectRepo.findByFingerprint(fingerprint);
    if (!project) {
      this.logger.debug('Cache miss', {
        stage: 'cacheService.checkCacheHit',
        elapsedMs: Date.now() - startMs,
      });
      return { hit: false, project: null, validation: null };
    }

    // 3. 检查缓存状态 — 已标记删除或失败隔离不算命中
    if (project.cacheStatus !== CacheEntryStatus.Active) {
      this.logger.debug('Cache hit but status is not active', {
        projectId: project.id,
        stage: 'cacheService.checkCacheHit',
      });
      return { hit: false, project: null, validation: null };
    }

    // 4. 校验 manifest 完整性
    const validation = await this.manifestManager.validateFull(project.cacheDir);

    this.logger.info('Cache hit', {
      projectId: project.id,
      stage: 'cacheService.checkCacheHit',
      elapsedMs: Date.now() - startMs,
    });

    return {
      hit: true,
      project,
      validation,
    };
  }

  async validateProjectCache(projectId: string): Promise<CacheValidationResult> {
    const startMs = Date.now();

    // 1. 查 project 记录
    const project = await this.projectRepo.findById(projectId);
    if (!project) {
      throw new AppError({
        code: ErrorCode.DB_QUERY_FAILED,
        message: `Project not found: ${projectId}`,
        userMessage: '项目不存在',
        context: { projectId },
        retryable: false,
      });
    }

    // 2. 检查目录存在性
    const directoryExists = await this.dirManager.validateProjectDir(project.cacheDir);

    // 3. manifest 校验
    const manifestValidation = await this.manifestManager.validateFull(project.cacheDir);

    // 4. 综合判断修复建议
    let suggestedAction = CacheRepairAction.None;
    let repairable = false;

    if (!directoryExists) {
      suggestedAction = CacheRepairAction.Cleanup;
      repairable = false;
    } else if (!manifestValidation.valid) {
      const hasManifestMissing = manifestValidation.issues.some(
        i => i.type === ManifestIssueType.ManifestMissing,
      );
      const hasJsonCorrupt = manifestValidation.issues.some(
        i => i.type === ManifestIssueType.JsonCorrupt,
      );
      const hasSchemaIncompat = manifestValidation.issues.some(
        i => i.type === ManifestIssueType.SchemaVersionIncompatible,
      );
      const hasStemMissing = manifestValidation.issues.some(
        i => i.type === ManifestIssueType.StemFileMissing,
      );

      if (hasManifestMissing || hasJsonCorrupt) {
        // manifest 不可读 → 需要清理或重分离
        suggestedAction = CacheRepairAction.Cleanup;
        repairable = false;
      } else if (hasSchemaIncompat) {
        // schema 不兼容 → 需要重分离
        suggestedAction = CacheRepairAction.Reseparate;
        repairable = false;
      } else if (hasStemMissing) {
        // 部分文件缺失但 manifest 可解析 → 需要重分离
        suggestedAction = CacheRepairAction.Reseparate;
        repairable = false;
      } else {
        // 其他问题（waveform/chord 缺失） → 可修复
        suggestedAction = CacheRepairAction.RebuildIndex;
        repairable = true;
      }
    }

    this.logger.debug('Project cache validation completed', {
      projectId,
      stage: 'cacheService.validateProjectCache',
      elapsedMs: Date.now() - startMs,
    });

    return {
      projectId,
      valid: directoryExists && manifestValidation.valid,
      repairable,
      suggestedAction,
      manifestValidation,
      directoryExists,
    };
  }

  async markForDeletion(projectId: string): Promise<void> {
    const project = await this.projectRepo.findById(projectId);
    if (!project) {
      throw new AppError({
        code: ErrorCode.DB_QUERY_FAILED,
        message: `Project not found: ${projectId}`,
        userMessage: '项目不存在',
        context: { projectId },
        retryable: false,
      });
    }

    await this.projectRepo.update(projectId, {
      cacheStatus: CacheEntryStatus.MarkedForDeletion,
    });

    this.logger.info('Project marked for deletion', {
      projectId,
      stage: 'cacheService.markForDeletion',
    });
  }

  async purgeMarkedProjects(): Promise<number> {
    const startMs = Date.now();

    const result = await this.projectRepo.listByCacheStatus(
      CacheEntryStatus.MarkedForDeletion,
    );

    let purgedCount = 0;
    for (const project of result.items) {
      try {
        // 1. 删除文件目录
        await this.dirManager.removeProjectDir(project.cacheDir);

        // 2. 删除 DB 记录
        await this.projectRepo.delete(project.id);

        purgedCount++;
      } catch (err) {
        // 单个项目清理失败不阻断整体，下次调用会重试
        this.logger.error(
          `Failed to purge project ${project.id}`,
          err instanceof Error ? err : null,
          { projectId: project.id, stage: 'cacheService.purgeMarkedProjects' },
        );
      }
    }

    this.logger.info('Marked projects purged', {
      stage: 'cacheService.purgeMarkedProjects',
      elapsedMs: Date.now() - startMs,
    });

    return purgedCount;
  }

  async isolateFailedProject(projectId: string): Promise<void> {
    const project = await this.projectRepo.findById(projectId);
    if (!project) return; // 静默跳过 — 由 ProjectService catch 块调用

    // GPT R4 Must Fix #1: 从 settingsRepo 获取 cacheRoot，不再从 cacheDir 正则反推
    const settings = await this.settingsRepo.get();
    const cacheRoot = settings.cacheRoot;

    // 移动目录到隔离区
    await this.dirManager.moveToFailed(cacheRoot, projectId);

    // 更新 DB 状态
    await this.projectRepo.update(projectId, {
      cacheStatus: CacheEntryStatus.FailedIsolated,
    });

    this.logger.info('Failed project isolated', {
      projectId,
      stage: 'cacheService.isolateFailedProject',
    });
  }

  async cleanupFailedProjects(): Promise<number> {
    // 查找所有失败隔离的项目
    const result = await this.projectRepo.listByCacheStatus(
      CacheEntryStatus.FailedIsolated,
    );

    if (result.items.length === 0) return 0;

    // GPT R4 Must Fix #1: 从 settingsRepo 获取 cacheRoot
    const settings = await this.settingsRepo.get();
    const cacheRoot = settings.cacheRoot;

    let cleanedCount = 0;
    for (const project of result.items) {
      try {
        await this.dirManager.cleanupFailedProject(cacheRoot, project.id);
        await this.projectRepo.delete(project.id);
        cleanedCount++;
      } catch (err) {
        // 单条失败不阻断，下次调用会重试
        this.logger.error(
          `Failed to cleanup failed project ${project.id}`,
          err instanceof Error ? err : null,
          { projectId: project.id, stage: 'cacheService.cleanupFailedProjects' },
        );
      }
    }

    return cleanedCount;
  }

  /**
   * 获取缓存存储统计
   *
   * GPT R4 Must Fix #2: 使用聚合查询（countByCacheStatus / sumSizeByStatus），
   * 不再拉全量行到内存再算 count / sum。
   */
  async getStorageStats(): Promise<CacheStorageStats> {
    const [
      activeProjectCount,
      activeTotalSizeBytes,
      failedProjectCount,
      markedForDeletionCount,
    ] = await Promise.all([
      this.projectRepo.countByCacheStatus(CacheEntryStatus.Active),
      this.projectRepo.sumSizeByStatus(CacheEntryStatus.Active),
      this.projectRepo.countByCacheStatus(CacheEntryStatus.FailedIsolated),
      this.projectRepo.countByCacheStatus(CacheEntryStatus.MarkedForDeletion),
    ]);

    return {
      activeProjectCount,
      activeTotalSizeBytes,
      failedProjectCount,
      markedForDeletionCount,
    };
  }
}
