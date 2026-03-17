/**
 * @module application/services/parseJobService
 * @description 分离任务编排服务 — 从上传到写盘的完整链路
 *
 * 职责（规格文档 §14, §16, ADR-006）：
 * - 创建 ParseJob 记录并驱动状态机
 * - 输入边界校验（文件存在/格式/目录可写/项目状态）
 * - 发送 StartSeparation 命令给 Worker
 * - 监听 Worker 进度事件（StageProgress）→ 更新 Job 阶段 + 进度
 * - 分离完成后：通过 adapter 归一化 → 写 DB + manifest → 更新项目状态
 * - 分离失败/取消：按情形回滚（取消/引擎失败/临时错误）
 * - 超时控制：单次分离任务超时（可配置）
 *
 * 不负责：
 * - Worker 进程管理 → WorkerManager
 * - IPC 通信 → WorkerIpcBridge
 * - 引擎输出 → StemFile 映射 → SeparationResultAdapter（GPT R6 Must Fix #1）
 * - 项目创建 / 指纹计算 → ProjectService
 * - 缓存管理 → CacheService
 *
 * 串行约束（规格文档建议首版单任务串行）：
 * - 同一时刻最多一个分离任务在运行
 * - 新请求在前一个任务完成/失败/取消后才接受
 *
 * 失败回滚策略（GPT R6 Must Fix #3）：
 * 三种情形：
 * 1. 用户取消：清理半成品，Job → Cancelled，Project → Cancelled
 * 2. 引擎/写盘失败（有排障价值）：Job → Failed，Project → Failed，
 *    调用 CacheService.isolateFailedProject() 移入 _failed/
 * 3. 临时可重试错误（未产生落盘污染）：Job → Failed，Project 保持当前状态，
 *    可重新发起分离
 *
 * 错误语义：
 * - startSeparation(): 已有任务运行中 → AppError(INVALID_STATE_TRANSITION)
 * - startSeparation(): Worker 不可用 → AppError(WORKER_SPAWN_FAILED)
 * - startSeparation(): 文件不存在 → AppError(INPUT_FILE_NOT_FOUND)
 * - startSeparation(): 格式不支持 → AppError(INPUT_UNSUPPORTED_FORMAT)
 * - cancelSeparation(jobId?): 无任务运行 → 静默返回（幂等）
 *
 * DI（ADR-008）：
 * - 通过 IParseJobService 接口暴露给 IPC handler / ViewModel
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  JobStatus,
  JobStage,
  ProjectStatus,
  WorkerCommand,
  WorkerEventName,
} from '../../shared/enums';
import { SUPPORTED_INPUT_EXTENSIONS } from '../../shared/contracts';
import { STAGE_PROGRESS_MAPPING } from '../../shared/stageMapping';
import { AppError, ErrorCode } from '../../shared/errors';
import { ILogger } from '../../shared/logger';
import { WorkerEvent, StateTransitionRecord } from '../../shared/contracts';
import { ParseJob, ProjectManifest } from '../../domain/entities';
import { assertJobTransition } from '../../domain/stateMachines';
import {
  IParseJobRepository,
  IStemFileRepository,
  IProjectRepository,
  IStateTransitionRepository,
} from '../../domain/repositories';
import { IWorkerManager, WorkerStatus } from '../../infrastructure/worker/workerManager';
import { IWorkerIpcBridge } from '../../infrastructure/worker/workerIpcBridge';
import { IWorkerSchemaValidator } from '../../infrastructure/worker/workerSchemaValidator';
import { IManifestManager } from '../../infrastructure/fs/manifestManager';
import { IProjectDirManager } from '../../infrastructure/fs/projectDirManager';
import {
  ISeparationResultAdapter,
  RawSeparationResult,
} from '../../infrastructure/adapters/separationResultAdapter';
import { ICacheService } from './cacheService';

// ============================================================================
// 1. 类型定义
// ============================================================================

/** 分离任务配置 */
export interface ParseJobServiceConfig {
  /**
   * 分离任务超时（ms）
   * 默认 600000（10 分钟）— 基于规格文档 §16
   */
  separationTimeoutMs: number;
}

export const DEFAULT_PARSE_JOB_CONFIG: ParseJobServiceConfig = {
  separationTimeoutMs: 600_000,
};

/** 分离任务启动参数 */
export interface StartSeparationParams {
  projectId: string;
  sourceFilePath: string;
  projectDir: string;
  engineVersion?: string;
}

/**
 * 分离启动结果（GPT R6 Suggested #1 — 更丰富的返回对象）
 */
export interface SeparationStartResult {
  /** 创建的 Job */
  job: ParseJob;
  /** 项目在启动后的状态 */
  projectStatusAfter: ProjectStatus;
  /** 适配器产生的警告（缺轨等） */
  warnings: string[];
}

/**
 * 失败类型 — 决定回滚策略
 */
enum FailureKind {
  /** 引擎/写盘失败，有排障价值，应隔离到 _failed/ */
  EngineFailure = 'engine_failure',
  /** 临时可重试错误（IPC 超时、Worker 重启中），未产生落盘污染 */
  TransientError = 'transient_error',
}

// ============================================================================
// 2. 接口
// ============================================================================

export interface IParseJobService {
  /**
   * 启动分离任务
   *
   * @throws AppError(INVALID_STATE_TRANSITION) 已有任务运行中 / 项目状态不允许
   * @throws AppError(WORKER_SPAWN_FAILED) Worker 不可用
   * @throws AppError(INPUT_FILE_NOT_FOUND) 源文件不存在
   * @throws AppError(INPUT_UNSUPPORTED_FORMAT) 格式不支持
   */
  startSeparation(params: StartSeparationParams): Promise<SeparationStartResult>;

  /**
   * 取消分离任务
   *
   * GPT R6 Must Fix #5：接受可选 jobId，首版仍只支持 currentJobId。
   * 幂等：无任务运行时静默返回。
   */
  cancelSeparation(jobId?: string): Promise<void>;

  isRunning(): boolean;
  getCurrentJobId(): string | null;
}

// ============================================================================
// 3. 实现
// ============================================================================

export class ParseJobService implements IParseJobService {
  private currentJobId: string | null = null;
  private progressUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly parseJobRepo: IParseJobRepository,
    private readonly stemFileRepo: IStemFileRepository,
    private readonly projectRepo: IProjectRepository,
    private readonly stateTransitionRepo: IStateTransitionRepository,
    private readonly workerManager: IWorkerManager,
    private readonly ipcBridge: IWorkerIpcBridge,
    private readonly schemaValidator: IWorkerSchemaValidator,
    private readonly manifestManager: IManifestManager,
    private readonly projectDirManager: IProjectDirManager,
    private readonly resultAdapter: ISeparationResultAdapter,
    private readonly cacheService: ICacheService,
    private readonly config: ParseJobServiceConfig,
    private readonly logger: ILogger,
  ) {}

  async startSeparation(params: StartSeparationParams): Promise<SeparationStartResult> {
    // 1. 串行约束
    if (this.currentJobId) {
      throw new AppError({
        code: ErrorCode.INVALID_STATE_TRANSITION,
        message: `A separation job is already running: ${this.currentJobId}`,
        userMessage: '已有分离任务在运行中，请等待完成',
        context: { currentJobId: this.currentJobId, requestedProjectId: params.projectId },
        retryable: false,
      });
    }

    // 2. GPT R6 Must Fix #6：输入边界校验
    await this.validateInputs(params);

    // 3. 检查 Worker 可用性
    const workerStatus = this.workerManager.getStatus();
    if (workerStatus.status !== WorkerStatus.Running) {
      throw new AppError({
        code: ErrorCode.WORKER_SPAWN_FAILED,
        message: `Worker is not running (status: ${workerStatus.status})`,
        userMessage: 'Worker 进程不可用，请稍后重试',
        context: { workerStatus: workerStatus.status },
        retryable: true,
      });
    }

    // 4. 创建 ParseJob 记录
    const jobId = crypto.randomUUID();
    const job: ParseJob = {
      id: jobId,
      projectId: params.projectId,
      stage: JobStage.Init,
      progress: 0,
      startedAt: null,
      finishedAt: null,
      elapsedMs: null,
      errorCode: null,
      errorMessage: null,
      engineVersion: params.engineVersion ?? null,
      cancelledByUser: false,
      status: JobStatus.Pending,
    };

    await this.parseJobRepo.create(job);
    this.currentJobId = jobId;

    this.logger.info('Separation job created', {
      jobId,
      projectId: params.projectId,
      stage: 'parseJobService.startSeparation',
    });

    // 5. 转移状态 → Running
    assertJobTransition(jobId, JobStatus.Pending, JobStatus.Running);
    const startMs = Date.now();
    await this.parseJobRepo.updateStatus(jobId, JobStatus.Running);

    // 更新项目状态 → Processing
    await this.projectRepo.updateStatus(params.projectId, ProjectStatus.Processing);

    // 6. 监听进度事件
    this.progressUnsubscribe = this.ipcBridge.on(
      WorkerEventName.StageProgress,
      (event: WorkerEvent) => {
        this.handleProgressEvent(jobId, event).catch((err) => {
          this.logger.error('Failed to handle progress event', err instanceof Error ? err : null, {
            jobId,
            stage: 'parseJobService.progressHandler',
          });
        });
      },
    );

    // 7. 发送分离命令
    try {
      const response = await this.ipcBridge.send(
        WorkerCommand.StartSeparation,
        {
          sourceFilePath: params.sourceFilePath,
          outputDir: this.projectDirManager.getPath(params.projectDir, 'STEMS_DIR'),
          projectId: params.projectId,
        },
        this.config.separationTimeoutMs,
      );

      this.cleanupProgressListener();

      // 8. 校验响应 schema
      const validated = this.schemaValidator.validate<RawSeparationResult>(
        WorkerCommand.StartSeparation,
        response,
      );

      if (!validated.valid) {
        await this.failJob(jobId, params.projectId, startMs,
          ErrorCode.WORKER_RESPONSE_SCHEMA_INVALID,
          `Schema validation failed: ${validated.validationErrors?.map((e) => e.message).join('; ') ?? 'unknown'}`,
          FailureKind.EngineFailure,
        );
        const failedJob = await this.parseJobRepo.findById(jobId);
        return {
          job: failedJob ?? job,
          projectStatusAfter: ProjectStatus.Failed,
          warnings: [],
        };
      }

      // 9. 通过 adapter 归一化 → 写盘
      const adapted = this.resultAdapter.adapt(validated.data!, params.projectId, params.projectDir);
      await this.handleSeparationSuccess(jobId, params, adapted, startMs);

      const finalJob = await this.parseJobRepo.findById(jobId);
      return {
        job: finalJob ?? job,
        projectStatusAfter: ProjectStatus.Ready,
        warnings: adapted.warnings,
      };
    } catch (err) {
      this.cleanupProgressListener();

      if (err instanceof AppError) {
        const currentJob = await this.parseJobRepo.findById(jobId);
        if (currentJob && (currentJob.status === JobStatus.Failed || currentJob.status === JobStatus.Success)) {
          return {
            job: currentJob,
            projectStatusAfter: currentJob.status === JobStatus.Success ? ProjectStatus.Ready : ProjectStatus.Failed,
            warnings: [],
          };
        }

        // 区分失败类型
        const failureKind = this.classifyFailure(err.code);
        await this.failJob(jobId, params.projectId, startMs, err.code, err.message, failureKind);

        if (err.code === ErrorCode.WORKER_IPC_TIMEOUT) {
          this.sendCancelBestEffort(params.projectId);
        }

        const failedJob = await this.parseJobRepo.findById(jobId);
        return {
          job: failedJob ?? job,
          projectStatusAfter: failureKind === FailureKind.TransientError
            ? ProjectStatus.ReadyToParse
            : ProjectStatus.Failed,
          warnings: [],
        };
      }

      const error = err instanceof Error ? err : new Error(String(err));
      await this.failJob(jobId, params.projectId, startMs,
        ErrorCode.WORKER_SPAWN_FAILED, error.message, FailureKind.EngineFailure);

      const failedJob = await this.parseJobRepo.findById(jobId);
      return {
        job: failedJob ?? job,
        projectStatusAfter: ProjectStatus.Failed,
        warnings: [],
      };
    }
  }

  async cancelSeparation(jobId?: string): Promise<void> {
    // GPT R6 Must Fix #5：接受可选 jobId
    const targetJobId = jobId ?? this.currentJobId;
    if (!targetJobId) {
      return; // 幂等
    }

    // 首版串行约束：只允许取消当前任务
    if (targetJobId !== this.currentJobId) {
      this.logger.warn('Cannot cancel non-current job in serial mode', {
        targetJobId,
        currentJobId: this.currentJobId,
        stage: 'parseJobService.cancelSeparation',
      });
      return;
    }

    this.logger.info('Cancelling separation job', {
      jobId: targetJobId,
      stage: 'parseJobService.cancelSeparation',
    });

    const job = await this.parseJobRepo.findById(targetJobId);
    if (job && job.status === JobStatus.Running) {
      assertJobTransition(targetJobId, JobStatus.Running, JobStatus.Cancelled);
      await this.parseJobRepo.updateStatus(targetJobId, JobStatus.Cancelled);

      const elapsed = job.startedAt ? Date.now() - job.startedAt : 0;
      await this.parseJobRepo.complete(targetJobId, JobStatus.Cancelled, elapsed);

      // GPT R6 Must Fix #3：取消 → 项目状态回到 Cancelled
      await this.projectRepo.updateStatus(job.projectId, ProjectStatus.Cancelled);
    }

    this.sendCancelBestEffort(job?.projectId ?? '');

    this.cleanupProgressListener();
    this.currentJobId = null;
  }

  isRunning(): boolean {
    return this.currentJobId !== null;
  }

  getCurrentJobId(): string | null {
    return this.currentJobId;
  }

  // --- Internal ---

  /**
   * GPT R6 Must Fix #6：输入边界校验
   *
   * @throws AppError(INPUT_FILE_NOT_FOUND) 文件不存在
   * @throws AppError(INPUT_UNSUPPORTED_FORMAT) 格式不支持
   * @throws AppError(DISK_WRITE_FAILED) 输出目录不可写
   * @throws AppError(INVALID_STATE_TRANSITION) 项目状态不允许
   */
  private async validateInputs(params: StartSeparationParams): Promise<void> {
    // 1. sourceFilePath 存在且可读
    try {
      await fs.promises.access(params.sourceFilePath, fs.constants.R_OK);
    } catch {
      throw new AppError({
        code: ErrorCode.INPUT_FILE_NOT_FOUND,
        message: `Source file not found or not readable: ${params.sourceFilePath}`,
        userMessage: '源文件不存在或不可读',
        context: { sourceFilePath: params.sourceFilePath },
        retryable: false,
      });
    }

    // 2. 扩展名合法
    const ext = path.extname(params.sourceFilePath).toLowerCase();
    if (!SUPPORTED_INPUT_EXTENSIONS.includes(ext)) {
      throw new AppError({
        code: ErrorCode.INPUT_UNSUPPORTED_FORMAT,
        message: `Unsupported file format: ${ext}`,
        userMessage: `不支持的文件格式: ${ext}`,
        context: { extension: ext, supported: SUPPORTED_INPUT_EXTENSIONS },
        retryable: false,
      });
    }

    // 3. projectDir 存在且可写
    try {
      await fs.promises.access(params.projectDir, fs.constants.W_OK);
    } catch {
      throw new AppError({
        code: ErrorCode.DISK_WRITE_FAILED,
        message: `Project directory not writable: ${params.projectDir}`,
        userMessage: '项目目录不可写',
        context: { projectDir: params.projectDir },
        retryable: false,
      });
    }

    // 4. 项目存在且状态允许进入 Processing
    const project = await this.projectRepo.findById(params.projectId);
    if (!project) {
      throw new AppError({
        code: ErrorCode.INVALID_STATE_TRANSITION,
        message: `Project not found: ${params.projectId}`,
        userMessage: '项目不存在',
        context: { projectId: params.projectId },
        retryable: false,
      });
    }

    const allowedStates: ProjectStatus[] = [
      ProjectStatus.ReadyToParse,
      ProjectStatus.Failed, // 允许失败后重试
    ];
    if (!allowedStates.includes(project.status)) {
      throw new AppError({
        code: ErrorCode.INVALID_STATE_TRANSITION,
        message: `Project status "${project.status}" does not allow separation`,
        userMessage: '当前项目状态不允许启动分离',
        context: { projectId: params.projectId, currentStatus: project.status },
        retryable: false,
      });
    }
  }

  /**
   * 处理 Worker 进度事件 → 更新 Job 阶段 + 进度
   *
   * GPT R6 Suggested #4：通过 STAGE_PROGRESS_MAPPING 映射。
   */
  private async handleProgressEvent(jobId: string, event: WorkerEvent): Promise<void> {
    const payload = event.payload as { stage?: string; progress?: number };
    const rawStage = (payload.stage ?? '').toLowerCase();

    // 通过映射表归一化
    const mapping = STAGE_PROGRESS_MAPPING[rawStage];
    const stage = mapping?.stage ?? JobStage.Init;
    const progress = Math.max(0, Math.min(100, payload.progress ?? 0));

    await this.parseJobRepo.updateProgress(jobId, stage, progress);

    this.logger.debug('Separation progress updated', {
      jobId,
      stage,
      progress,
      rawStage,
      workerStage: 'parseJobService.handleProgressEvent',
    });
  }

  /**
   * 分离成功后处理
   *
   * GPT R6 Must Fix #1：使用 adapter 归一化结果，不再硬编码路径。
   */
  private async handleSeparationSuccess(
    jobId: string,
    params: StartSeparationParams,
    adapted: { stemFiles: import('../../domain/entities').StemFile[]; manifestEntries: import('../../domain/entities').ManifestStemEntry[]; engineVersion: string; warnings: string[] },
    startMs: number,
  ): Promise<void> {
    const elapsedMs = Date.now() - startMs;

    // 1. 写入 DB
    await this.stemFileRepo.createMany(adapted.stemFiles);

    // 2. 更新 manifest
    const existingManifest = await this.manifestManager.read(params.projectDir);
    if (existingManifest) {
      const updatedManifest: ProjectManifest = {
        ...existingManifest,
        engineVersion: adapted.engineVersion,
        updatedAt: Date.now(),
        stems: adapted.manifestEntries,
      };
      await this.manifestManager.write(params.projectDir, updatedManifest);
    }

    // 3. 完成 Job
    assertJobTransition(jobId, JobStatus.Running, JobStatus.Success);
    await this.parseJobRepo.complete(jobId, JobStatus.Success, elapsedMs);

    // 4. 更新项目状态 → Ready
    await this.projectRepo.updateStatus(params.projectId, ProjectStatus.Ready);

    // 5. 清理
    this.currentJobId = null;

    this.logger.info('Separation completed successfully', {
      jobId,
      projectId: params.projectId,
      stemCount: adapted.stemFiles.length,
      warningCount: adapted.warnings.length,
      elapsedMs,
      stage: 'parseJobService.handleSeparationSuccess',
    });
  }

  /**
   * GPT R6 Must Fix #3：按失败类型执行回滚策略
   * GPT R6 Must Fix #4：结构化审计替代静默吞异常
   */
  private async failJob(
    jobId: string,
    projectId: string,
    startMs: number,
    errorCode: string,
    errorMessage: string,
    failureKind: FailureKind,
  ): Promise<void> {
    const elapsedMs = Date.now() - startMs;

    // 查询当前 Job 状态用于审计
    const currentJob = await this.parseJobRepo.findById(jobId);
    const currentJobStatus = currentJob?.status ?? JobStatus.Running;

    // GPT R6 Must Fix #4：结构化审计，不吞状态机异常
    try {
      assertJobTransition(jobId, currentJobStatus, JobStatus.Failed);
    } catch (transitionError) {
      // 写审计记录而非静默吞掉
      const auditRecord: StateTransitionRecord = {
        entityType: 'ParseJob',
        entityId: jobId,
        action: 'forced_fail',
        fromStatus: currentJobStatus,
        toStatus: JobStatus.Failed,
        timestamp: Date.now(),
        correlationId: jobId,
        metadata: {
          reason: 'State transition invalid but forced for error recovery',
          originalError: errorCode,
          transitionError: transitionError instanceof Error ? transitionError.message : String(transitionError),
        },
      };

      await this.stateTransitionRepo.record(auditRecord).catch((auditErr) => {
        this.logger.error('Failed to write forced-transition audit', auditErr instanceof Error ? auditErr : null, {
          jobId,
          stage: 'parseJobService.failJob',
        });
      });

      this.logger.warn('Job state transition to Failed was invalid — forced with audit record', {
        jobId,
        fromStatus: currentJobStatus,
        errorCode,
        stage: 'parseJobService.failJob',
      });
    }

    await this.parseJobRepo.updateStatus(jobId, JobStatus.Failed, errorCode, errorMessage);
    await this.parseJobRepo.complete(jobId, JobStatus.Failed, elapsedMs);

    // GPT R6 Must Fix #3：按失败类型决定项目回滚策略
    switch (failureKind) {
      case FailureKind.EngineFailure:
        // 引擎/写盘失败 → 项目 Failed + 隔离到 _failed/
        await this.projectRepo.updateStatus(projectId, ProjectStatus.Failed);
        // GPT R7 Must Fix #3：实际调用隔离，而不仅仅是 "recommended"
        try {
          await this.cacheService.isolateFailedProject(projectId);
          this.logger.info('Engine failure: project marked Failed and isolated to _failed/', {
            jobId,
            projectId,
            stage: 'parseJobService.failJob',
          });
        } catch (isolateErr) {
          this.logger.error('Failed to isolate project to _failed/', isolateErr instanceof Error ? isolateErr : null, {
            jobId,
            projectId,
            stage: 'parseJobService.failJob',
          });
        }
        break;

      case FailureKind.TransientError:
        // 临时错误（IPC 超时等）→ 项目回到 ReadyToParse，允许重试
        await this.projectRepo.updateStatus(projectId, ProjectStatus.ReadyToParse);
        this.logger.info('Transient error: project returned to ReadyToParse for retry', {
          jobId,
          projectId,
          stage: 'parseJobService.failJob',
        });
        break;
    }

    // 清理
    this.currentJobId = null;

    this.logger.error('Separation job failed', null, {
      jobId,
      projectId,
      errorCode,
      errorMessage,
      failureKind,
      elapsedMs,
      stage: 'parseJobService.failJob',
    });
  }

  /**
   * 区分失败类型
   *
   * GPT R6 Must Fix #3：决定回滚策略。
   */
  private classifyFailure(errorCode: string): FailureKind {
    switch (errorCode) {
      // 临时可重试：IPC 超时、协议错误（Worker 重启中）
      case ErrorCode.WORKER_IPC_TIMEOUT:
      case ErrorCode.WORKER_HEALTH_CHECK_FAILED:
        return FailureKind.TransientError;

      // 引擎失败：schema 不匹配、spawn 失败、协议错误（disposed）
      case ErrorCode.WORKER_RESPONSE_SCHEMA_INVALID:
      case ErrorCode.WORKER_SPAWN_FAILED:
      default:
        return FailureKind.EngineFailure;
    }
  }

  /**
   * 尽力发送取消命令
   *
   * GPT R6 Suggested #3：明确错误码和日志上下文。
   */
  private sendCancelBestEffort(projectId: string): void {
    try {
      this.ipcBridge.send(
        WorkerCommand.CancelTask,
        { projectId },
        5000,
      ).catch((err) => {
        this.logger.warn('Cancel command failed (best-effort)', {
          error: err instanceof Error ? err.message : String(err),
          errorCode: err instanceof AppError ? err.code : 'UNKNOWN',
          projectId,
          retryable: false,
          stage: 'parseJobService.sendCancelBestEffort',
        });
      });
    } catch {
      // IPC bridge 可能已 disposed — 不再重试
    }
  }

  private cleanupProgressListener(): void {
    if (this.progressUnsubscribe) {
      this.progressUnsubscribe();
      this.progressUnsubscribe = null;
    }
  }
}
