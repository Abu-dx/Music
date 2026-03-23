/**
 * @module application/services/projectService
 * @description 项目服务 — 项目生命周期管理的核心编排层
 *
 * 职责（规格文档 §24.2）：
 * - 创建项目（从文件上传 / 从手动导入）
 * - 获取 / 列表 / 删除项目
 * - 项目状态转移（含审计记录）
 * - 协调 CacheService、ManifestManager、ProjectDirManager、FingerprintCalculator
 * - 协调跨 store 变更（ADR-004: 跨域变更必须经 Application Service 编排）
 *
 * 不负责：
 * - 分离执行 → Worker adapter / ParseJobService（后续轮次）
 * - 播放器控制 → PlaybackService（Round 9+）
 * - 和弦分析 → ChordAnalysisService（Round 7+）
 * - 导出 → ExportService（Round 8+）
 * - 缓存命中 / 缓存清理 → CacheService
 *
 * DI（ADR-008）：
 * - 所有依赖通过构造函数注入
 * - 不直接 import better-sqlite3 / fs（ADR-009）
 *
 * 状态转移规则（stateMachines.ts）：
 * - 每次状态变更前调用 assertProjectTransition()
 * - 每次状态变更后写入 IStateTransitionRepository（审计）
 * - 跨域变更使用 correlationId 串联（ADR-004）
 *
 * 错误语义（GPT R4 Must Fix #4 — 统一错误规范）：
 * - getProject: 不存在返回 null（不抛异常）
 * - listRecentProjects: 纯查询，不抛异常
 * - createFromFile / createFromManualImport: 写失败抛 AppError(DB_QUERY_FAILED)
 * - createFromManualImport: 轨道冲突抛 AppError(IMPORT_MAPPING_CONFLICT)
 * - deleteProject: 项目不存在抛 AppError(DB_QUERY_FAILED)
 * - updateProjectStatus: 项目不存在抛 AppError(DB_QUERY_FAILED)，
 *   非法转移抛 AppError(INVALID_STATE_TRANSITION)
 *
 * 危险操作 & 幂等性（GPT R4 Must Fix #5）：
 * - deleteProject(): 硬删除文件 + DB 记录，不可逆。
 *   在删除前先 markForDeletion 确保即使中途失败也不会残留"幽灵活跃"项目。
 *   重复调用：第二次会抛 DB_QUERY_FAILED（项目已不存在）。
 * - updateProjectStatus(): 更新 DB + 写审计记录。
 *   重复调用同一转移：状态机 assert 会通过（只要当前状态=目标状态的前置），
 *   审计记录会增加一条。调用方应避免重复调用。
 * - createFromFile / createFromManualImport: 缓存命中时幂等返回已有项目。
 *   未命中时创建新项目，重复调用会生成新的项目 ID（指纹相同则第二次会命中缓存）。
 */

import * as crypto from 'crypto';
import { Project, ProjectManifest } from '../../domain/entities';
import {
  IProjectRepository,
  IStemFileRepository,
  IStateTransitionRepository,
  IAppSettingsRepository,
  PaginationParams,
  PaginatedResult,
} from '../../domain/repositories';
import {
  assertProjectTransition,
} from '../../domain/stateMachines';
import {
  detectStemConflicts,
  CURRENT_MANIFEST_SCHEMA_VERSION,
} from '../../domain/policies';
import {
  ProjectStatus,
  ProjectSourceType,
  StemType,
  CacheEntryStatus,
} from '../../shared/enums';
import { AppError, ErrorCode } from '../../shared/errors';
import { StateTransitionRecord } from '../../shared/contracts';
import { ILogger } from '../../shared/logger';
import { ICacheService, CacheHitResult } from './cacheService';
import { IManifestManager } from '../../infrastructure/fs/manifestManager';
import { IProjectDirManager } from '../../infrastructure/fs/projectDirManager';
import { IFingerprintCalculator } from '../../infrastructure/fs/fingerprintCalculator';

// ============================================================================
// 1. 手动导入 stem 映射 DTO
// ============================================================================

/**
 * 手动导入时的轨道文件映射
 *
 * 由 UI 层通过 IPC 传入，ProjectService 在写入前校验冲突。
 */
export interface StemMapping {
  /** 文件绝对路径 */
  filePath: string;
  /** 映射的轨道类型（用户确认后的最终值） */
  stemType: StemType;
  /** 文件名（用于日志/审计） */
  filename: string;
}

/**
 * 项目创建结果
 */
export interface ProjectCreationResult {
  /** 创建的项目 */
  project: Project;
  /** 是否命中缓存 */
  cacheHit: boolean;
  /** 缓存命中时的校验结果 */
  cacheHitResult: CacheHitResult | null;
}

// ============================================================================
// 2. 接口
// ============================================================================

/**
 * 项目服务接口
 *
 * IPC handler 通过此接口管理项目生命周期。
 *
 * 错误语义：
 * - getProject: 不存在返回 null
 * - listRecentProjects: 纯查询，不抛异常
 * - createFromFile / createFromManualImport: 写失败抛 AppError
 * - deleteProject / updateProjectStatus: 目标不存在抛 AppError(DB_QUERY_FAILED)
 */
export interface IProjectService {
  /**
   * 从文件创建项目（自动分离流程入口）
   *
   * 流程：
   * 1. 计算指纹
   * 2. 检查缓存命中（CacheService）
   * 3. 若命中且有效 → 写审计记录，返回已有项目
   * 4. 若未命中 → 创建目录 + manifest + DB 记录，状态 draft
   *
   * @param filePath - 原始音频文件绝对路径
   * @param displayName - 显示名称（默认为文件名）
   */
  createFromFile(filePath: string, displayName?: string): Promise<ProjectCreationResult>;

  /**
   * 从手动导入创建项目
   *
   * 流程：
   * 1. 校验轨道映射冲突（同一 stemType 不允许多个文件）
   * 2. 计算组合指纹
   * 3. 检查缓存命中
   * 4. 若命中 → 写审计记录，返回已有项目
   * 5. 若未命中 → 创建目录 + manifest + DB 记录，状态 draft
   *
   * 注意（GPT R4 Must Fix #3）：
   * - manifest 中 sizeBytes 初始为 0，由 ImportService（后续轮次）在文件复制完成后填充
   * - 项目创建时状态为 Draft，调用方（IPC handler / ImportService）
   *   应在文件复制开始时将状态转移为 Importing
   *
   * @param stemMappings - 文件到轨道类型的映射（由 UI 确认后传入）
   * @param displayName - 项目显示名称
   * @throws AppError(IMPORT_MAPPING_CONFLICT) 轨道映射冲突
   */
  createFromManualImport(
    stemMappings: StemMapping[],
    displayName: string,
  ): Promise<ProjectCreationResult>;

  /**
   * 获取项目
   *
   * 错误语义：不存在返回 null（不抛异常）
   */
  getProject(projectId: string): Promise<Project | null>;

  /**
   * 获取最近项目列表
   */
  listRecentProjects(pagination?: PaginationParams): Promise<PaginatedResult<Project>>;

  /**
   * 删除项目（协调缓存清理 + DB 删除）
   *
   * ⚠️ 危险操作：硬删除文件 + DB 记录，不可逆。
   *
   * @throws AppError(DB_QUERY_FAILED) 项目不存在
   */
  deleteProject(projectId: string): Promise<void>;

  /**
   * 更新项目状态（含状态机校验 + 审计记录）
   *
   * @param projectId - 项目 ID
   * @param newStatus - 目标状态
   * @param correlationId - 关联 ID（同一用例的多个状态变更共享）
   * @throws AppError(DB_QUERY_FAILED) 项目不存在
   * @throws AppError(INVALID_STATE_TRANSITION) 非法转移
   */
  updateProjectStatus(
    projectId: string,
    newStatus: ProjectStatus,
    correlationId: string,
  ): Promise<void>;
}

// ============================================================================
// 3. 实现
// ============================================================================

export class ProjectService implements IProjectService {
  constructor(
    private readonly projectRepo: IProjectRepository,
    private readonly stemFileRepo: IStemFileRepository,
    private readonly stateTransitionRepo: IStateTransitionRepository,
    private readonly settingsRepo: IAppSettingsRepository,
    private readonly cacheService: ICacheService,
    private readonly dirManager: IProjectDirManager,
    private readonly manifestManager: IManifestManager,
    private readonly fingerprintCalculator: IFingerprintCalculator,
    private readonly logger: ILogger,
  ) {}

  async createFromFile(
    filePath: string,
    displayName?: string,
  ): Promise<ProjectCreationResult> {
    const startMs = Date.now();

    // 1. 计算指纹
    const fingerprint = await this.fingerprintCalculator.calculateForFile(filePath);

    // 2. 检查缓存命中
    const cacheHitResult = await this.cacheService.checkCacheHit(fingerprint);
    if (cacheHitResult.hit && cacheHitResult.project) {
      // GPT R4 Must Fix #6: 缓存命中也要写审计记录
      await this.recordCacheHitAudit(
        cacheHitResult.project.id,
        'createFromFile',
      );

      this.logger.info('Project cache hit', {
        projectId: cacheHitResult.project.id,
        stage: 'projectService.createFromFile',
        elapsedMs: Date.now() - startMs,
      });
      return {
        project: cacheHitResult.project,
        cacheHit: true,
        cacheHitResult,
      };
    }

    // 3. 缓存未命中 — 创建新项目
    const settings = await this.settingsRepo.get();
    const projectId = this.generateProjectId();
    const now = Date.now();

    // 3a. 创建目录
    const cacheDir = await this.dirManager.createProjectDir(settings.cacheRoot, projectId);

    // 3b. 构造项目实体
    const project: Project = {
      id: projectId,
      fingerprint,
      sourceType: ProjectSourceType.Separation,
      displayName: displayName ?? this.extractDisplayName(filePath),
      originalFilePath: filePath,
      cacheDir,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: null,
      durationMs: null,
      separationElapsedMs: null,
      sampleRate: null,
      channels: null,
      totalSizeBytes: 0,
      status: ProjectStatus.Draft,
      schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION,
      engineVersion: null,
      cacheStatus: CacheEntryStatus.Active,
    };

    // 3c. 创建初始 manifest
    const manifest: ProjectManifest = {
      projectId,
      fingerprint,
      sourceType: ProjectSourceType.Separation,
      schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION,
      engineVersion: null,
      createdAt: now,
      updatedAt: now,
      stems: [],
      waveform: null,
      chordAnalysis: null,
    };

    await this.manifestManager.write(cacheDir, manifest);

    // 3d. 写入 DB
    await this.projectRepo.create(project);

    this.logger.info('Project created from file', {
      projectId,
      stage: 'projectService.createFromFile',
      elapsedMs: Date.now() - startMs,
    });

    return {
      project,
      cacheHit: false,
      cacheHitResult: null,
    };
  }

  async createFromManualImport(
    stemMappings: StemMapping[],
    displayName: string,
  ): Promise<ProjectCreationResult> {
    const startMs = Date.now();

    // 1. 校验轨道映射冲突（应用层前置，GPT R3 Must Fix #5）
    const conflicts = detectStemConflicts(
      stemMappings.map(m => ({ filename: m.filename, stemType: m.stemType })),
    );
    if (conflicts.length > 0) {
      throw new AppError({
        code: ErrorCode.IMPORT_MAPPING_CONFLICT,
        message: `Stem mapping conflicts detected: ${conflicts.map(c => c.stemType).join(', ')}`,
        userMessage: '存在轨道映射冲突，请保留其中一个文件或取消',
        context: { conflicts },
        retryable: false,
      });
    }

    // 2. 计算组合指纹
    const filePaths = stemMappings.map(m => m.filePath);
    const fingerprint = await this.fingerprintCalculator.calculateForFiles(filePaths);

    // 3. 检查缓存命中
    const cacheHitResult = await this.cacheService.checkCacheHit(fingerprint);
    if (cacheHitResult.hit && cacheHitResult.project) {
      // GPT R4 Must Fix #6: 缓存命中也要写审计记录
      await this.recordCacheHitAudit(
        cacheHitResult.project.id,
        'createFromManualImport',
      );

      this.logger.info('Manual import cache hit', {
        projectId: cacheHitResult.project.id,
        stage: 'projectService.createFromManualImport',
        elapsedMs: Date.now() - startMs,
      });
      return {
        project: cacheHitResult.project,
        cacheHit: true,
        cacheHitResult,
      };
    }

    // 4. 创建新项目
    const settings = await this.settingsRepo.get();
    const projectId = this.generateProjectId();
    const now = Date.now();

    const cacheDir = await this.dirManager.createProjectDir(settings.cacheRoot, projectId);

    // 4a. 构造 manifest stem entries
    // GPT R4 Must Fix #3: sizeBytes 初始为 0，由 ImportService 在文件复制完成后填充。
    // 调用方在启动文件复制时应调用 updateProjectStatus(id, Importing, correlationId)
    // 将项目转入 Importing 中间状态。
    const manifestStems = stemMappings.map(m => ({
      stemType: m.stemType,
      relativePath: m.filename,
      codec: this.extractCodec(m.filename),
      sizeBytes: 0, // placeholder — ImportService 填充实际值
      sourceOrigin: 'manual_import' as const,
    }));

    const project: Project = {
      id: projectId,
      fingerprint,
      sourceType: ProjectSourceType.ManualImport,
      displayName,
      originalFilePath: null,
      cacheDir,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: null,
      durationMs: null,
      separationElapsedMs: null,
      sampleRate: null,
      channels: null,
      totalSizeBytes: 0,
      status: ProjectStatus.Draft,
      schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION,
      engineVersion: null,
      cacheStatus: CacheEntryStatus.Active,
    };

    const manifest: ProjectManifest = {
      projectId,
      fingerprint,
      sourceType: ProjectSourceType.ManualImport,
      schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION,
      engineVersion: null,
      createdAt: now,
      updatedAt: now,
      stems: manifestStems,
      waveform: null,
      chordAnalysis: null,
    };

    await this.manifestManager.write(cacheDir, manifest);
    await this.projectRepo.create(project);

    this.logger.info('Project created from manual import', {
      projectId,
      stage: 'projectService.createFromManualImport',
      elapsedMs: Date.now() - startMs,
    });

    return {
      project,
      cacheHit: false,
      cacheHitResult: null,
    };
  }

  async getProject(projectId: string): Promise<Project | null> {
    return this.projectRepo.findById(projectId);
  }

  async listRecentProjects(
    pagination?: PaginationParams,
  ): Promise<PaginatedResult<Project>> {
    return this.projectRepo.listRecent(pagination);
  }

  async deleteProject(projectId: string): Promise<void> {
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

    // 1. 标记待删除（确保即使后续步骤失败，项目也不会残留为 Active）
    await this.cacheService.markForDeletion(projectId);

    // 2. 删除文件
    await this.dirManager.removeProjectDir(project.cacheDir);

    // 3. 删除 DB 记录
    await this.projectRepo.delete(projectId);

    this.logger.info('Project deleted', {
      projectId,
      stage: 'projectService.deleteProject',
    });
  }

  async updateProjectStatus(
    projectId: string,
    newStatus: ProjectStatus,
    correlationId: string,
  ): Promise<void> {
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

    const oldStatus = project.status;

    // 1. 状态机校验（抛异常如果非法）
    assertProjectTransition(projectId, oldStatus, newStatus);

    // 2. 更新 DB
    await this.projectRepo.updateStatus(projectId, newStatus);

    // 3. 写入审计记录
    const transition: StateTransitionRecord = {
      entityType: 'project',
      entityId: projectId,
      action: 'statusChanged',
      fromStatus: oldStatus,
      toStatus: newStatus,
      timestamp: Date.now(),
      correlationId,
    };
    await this.stateTransitionRepo.record(transition);

    // 4. 如果转入 Failed/Cancelled，触发失败隔离
    if (newStatus === ProjectStatus.Failed || newStatus === ProjectStatus.Cancelled) {
      try {
        await this.cacheService.isolateFailedProject(projectId);
      } catch (err) {
        // 隔离失败不阻断状态变更，只记日志
        this.logger.error(
          'Failed to isolate failed project',
          err instanceof Error ? err : null,
          { projectId, stage: 'projectService.updateProjectStatus' },
        );
      }
    }

    this.logger.info('Project status updated', {
      projectId,
      stage: 'projectService.updateProjectStatus',
    });
  }

  // --- Internal ---

  /**
   * 生成项目 ID
   *
   * GPT R4 Decision #2: 使用 crypto.randomUUID() 替代 Math.random 手动拼接，
   * 保证 UUID v4 的密码学随机性。
   */
  private generateProjectId(): string {
    return crypto.randomUUID();
  }

  /**
   * GPT R4 Must Fix #6: 缓存命中时写审计记录
   *
   * 缓存命中意味着用户再次导入了相同指纹的文件，
   * 审计记录方便追溯用户行为与缓存效率分析。
   */
  private async recordCacheHitAudit(
    projectId: string,
    source: string,
  ): Promise<void> {
    try {
      const auditRecord: StateTransitionRecord = {
        entityType: 'project',
        entityId: projectId,
        action: 'cacheHit',
        fromStatus: 'n/a',
        toStatus: 'n/a',
        timestamp: Date.now(),
        correlationId: this.generateProjectId(), // 独立 correlationId
      };
      await this.stateTransitionRepo.record(auditRecord);
    } catch (err) {
      // 审计记录写入失败不阻断主流程
      this.logger.error(
        'Failed to record cache hit audit',
        err instanceof Error ? err : null,
        { projectId, source, stage: 'projectService.recordCacheHitAudit' },
      );
    }
  }

  private extractDisplayName(filePath: string): string {
    // 从路径提取文件名（去掉扩展名）
    const basename = filePath.replace(/\\/g, '/').split('/').pop() ?? 'Untitled';
    return basename.replace(/\.[^.]+$/, '');
  }

  private extractCodec(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const codecMap: Record<string, string> = {
      wav: 'pcm_s16le',
      mp3: 'mp3',
      flac: 'flac',
      m4a: 'aac',
    };
    return codecMap[ext] ?? ext;
  }
}
