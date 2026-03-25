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
  ProjectSourceType,
  WorkerCommand,
  WorkerEventName,
} from '../../shared/enums';
import { CURRENT_MANIFEST_SCHEMA_VERSION } from '../../domain/policies';
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
  SeparationProvenanceContext,
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
const DEFAULT_ACTIVE_RESULT_ID = 'main';
const PILOT_RESULT_SET_PREFIX = 'pilot_6s_';
const PILOT_MODEL_ID = 'htdemucs_6s';
const PILOT_RUNTIME_PROFILE_ID = 'demucs_6s_pilot';

/** 分离任务启动参数 */
export interface StartSeparationParams {
  projectId: string;
  sourceFilePath: string;
  projectDir: string;
  workerOutputDirOverride?: string;
  engineVersion?: string;
  resultSetId?: string;
  preserveExistingStems?: boolean;
  allowReadyStatus?: boolean;
  runtimeProfileIdOverride?: string;
  workerModelOverride?: string;
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
  private readonly cancelRequestedJobIds = new Set<string>();

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
    const traceStartedAt = Date.now();
    const formatTraceElapsed = (): number => Math.max(0, Date.now() - traceStartedAt);
    const serializeForTrace = (value: unknown): string => {
      try {
        return JSON.stringify(value);
      } catch (err) {
        const stringifyError = err instanceof Error ? err.message : String(err);
        return `<<json_stringify_failed:${stringifyError}>>`;
      }
    };
    const trace = (
      stage: string,
      extra: Record<string, string | number | boolean | null | undefined> = {},
    ): void => {
      const fields: Record<string, string | number | boolean> = {
        stage,
        projectId: params.projectId,
        jobId: 'N/A',
        resultSetId: 'N/A',
        runtimeProfileId: 'N/A',
        elapsedMs: formatTraceElapsed(),
      };
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null) {
          fields[key] = value;
        }
      }
      const serialized = Object.entries(fields)
        .map(([key, value]) => `${key}="${String(value)}"`)
        .join(' ');
      console.log(`[REAL_CHAIN] parseJobTrace ${serialized}`);
    };
    trace('task_start', { sourceFilePath: params.sourceFilePath });

    const currentJobIdBefore = this.currentJobId;
    console.log(
      `[REAL_CHAIN] parseJobService.startSeparation entry projectId="${params.projectId}" sourceFilePath="${params.sourceFilePath}" projectDir="${params.projectDir}" currentJobIdBefore="${currentJobIdBefore ?? 'none'}"`,
    );
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
    this.cancelRequestedJobIds.delete(jobId);
    trace('parse_job_created', { jobId });
    this.logger.info('startSeparation createdParseJobId', {
      createdParseJobId: jobId,
      currentJobIdBefore: currentJobIdBefore ?? null,
      projectId: params.projectId,
      stage: 'parseJobService.startSeparation',
    });

    this.logger.info('Separation job created', {
      jobId,
      projectId: params.projectId,
      stage: 'parseJobService.startSeparation',
    });

    // 5. 转移状态 → Running
    assertJobTransition(jobId, JobStatus.Pending, JobStatus.Running);
    const startMs = Date.now();
    await this.parseJobRepo.updateStatus(jobId, JobStatus.Running);
    trace('job_status_running', { jobId });

    // 更新项目状态 → Processing
    await this.projectRepo.updateStatus(params.projectId, ProjectStatus.Processing);

    // 6. 监听进度事件
    let firstProgressLogged = false;
    const resultSetId = this.normalizeResultSetId(params.resultSetId);
    const isPilotResultSet = resultSetId.startsWith(PILOT_RESULT_SET_PREFIX);
    const effectiveWorkerModelOverride = (params.workerModelOverride?.trim().length ?? 0) > 0
      ? params.workerModelOverride!.trim()
      : (isPilotResultSet ? PILOT_MODEL_ID : '');
    const effectiveRuntimeProfileOverride = (params.runtimeProfileIdOverride?.trim().length ?? 0) > 0
      ? params.runtimeProfileIdOverride!.trim()
      : (isPilotResultSet ? PILOT_RUNTIME_PROFILE_ID : '');
    const selectedRuntimeProfileId =
      (effectiveRuntimeProfileOverride || process.env.DEMUCS_RUNTIME_PROFILE || 'demucs_env_override').trim()
      || 'demucs_env_override';
    trace('runtime_profile_selected', {
      jobId,
      resultSetId,
      runtimeProfileId: selectedRuntimeProfileId,
      runtimeProfileOverride: effectiveRuntimeProfileOverride || 'none',
      modelOverride: effectiveWorkerModelOverride || 'none',
    });

    this.progressUnsubscribe = this.ipcBridge.on(
      WorkerEventName.StageProgress,
      (event: WorkerEvent) => {
        const workerStage =
          typeof event.payload.stage === 'string' && event.payload.stage.trim().length > 0
            ? event.payload.stage.trim()
            : 'unknown';
        const workerProgress =
          typeof event.payload.progress === 'number' && Number.isFinite(event.payload.progress)
            ? Number(event.payload.progress.toFixed(4))
            : 'n/a';
        const isEffectiveProgressStage = workerStage === 'INFER' || workerStage === 'POSTPROCESS' || workerStage === 'DONE';
        if (!firstProgressLogged && isEffectiveProgressStage) {
          firstProgressLogged = true;
          trace('first_progress_received', {
            jobId,
            resultSetId,
            runtimeProfileId: selectedRuntimeProfileId,
            workerStage,
            workerProgress,
          });
        }
        this.handleProgressEvent(jobId, event).catch((err) => {
          this.logger.error('Failed to handle progress event', err instanceof Error ? err : null, {
            jobId,
            stage: 'parseJobService.progressHandler',
          });
        });
      },
    );

    // 7. 发送分离命令
    const workerOutputDir = this.resolveWorkerOutputDir(params.projectDir, params.workerOutputDirOverride, resultSetId, jobId);
    try {
      await fs.promises.mkdir(workerOutputDir, { recursive: true });
      const separationPayload = {
        filePath: params.sourceFilePath,
        outputDir: workerOutputDir,
        ...(effectiveWorkerModelOverride
          ? { modelName: effectiveWorkerModelOverride }
          : {}),
        ...(effectiveRuntimeProfileOverride
          ? { runtimeProfileId: effectiveRuntimeProfileOverride }
          : {}),
      };
      console.log(
        `[REAL_CHAIN] parseJobService.startSeparation overrides jobId="${jobId}" projectId="${params.projectId}" resultSetId="${resultSetId}" modelOverride="${effectiveWorkerModelOverride || 'none'}" runtimeProfileOverride="${effectiveRuntimeProfileOverride || 'none'}"`,
      );
      console.log(`[REAL_CHAIN] parseJobService.startSeparation send_before jobId="${jobId}" projectId="${params.projectId}" payload=${JSON.stringify(separationPayload)}`);
      trace('start_separation_request_sent', {
        jobId,
        resultSetId,
        runtimeProfileId: selectedRuntimeProfileId,
      });
      const response = await this.ipcBridge.send(
        WorkerCommand.StartSeparation,
        separationPayload,
        this.config.separationTimeoutMs,
      );
      console.log(`[REAL_CHAIN] parseJobService.startSeparation send_after jobId="${jobId}" projectId="${params.projectId}" responseSuccess=${response.success} responseErrorCode=${response.error?.code ?? 'N/A'} responseErrorMessage="${response.error?.message ?? ''}"`);
      console.log(
        `[REAL_CHAIN] parseJobService.startSeparation worker_response_payload jobId="${jobId}" projectId="${params.projectId}" responseJson=${serializeForTrace(response)}`,
      );
      trace('start_separation_response_received', {
        jobId,
        resultSetId,
        runtimeProfileId: selectedRuntimeProfileId,
        responseSuccess: response.success,
        responseErrorCode: response.error?.code ?? 'none',
      });

      this.cleanupProgressListener();

      // 8a. 先检查 Worker 级错误（Demucs crash / timeout / 输入无效）
      //     必须在 schema 校验之前：response.success=false 时 data 可能缺失，
      //     直接进 schema 校验会丢失 Worker 原始错误信息。
      if (!response.success) {
        trace('completion_failure_received', {
          jobId,
          resultSetId,
          runtimeProfileId: selectedRuntimeProfileId,
          errorCode: response.error?.code ?? 'UNKNOWN_WORKER_ERROR',
        });
        const errCode = response.error?.code as string ?? 'UNKNOWN_WORKER_ERROR';
        const errMsg = response.error?.message as string ?? 'Worker returned error without details';
        if (errCode === ErrorCode.TASK_CANCELLED) {
          await this.finalizeCancelledJob(jobId, params.projectId, startMs);
          const cancelledJob = await this.parseJobRepo.findById(jobId);
          return {
            job: cancelledJob ?? {
              ...job,
              status: JobStatus.Cancelled,
            },
            projectStatusAfter: ProjectStatus.Cancelled,
            warnings: [],
          };
        }
        await this.failJob(jobId, params.projectId, startMs,
          errCode, errMsg, this.classifyFailure(errCode),
        );
        const failedJob = await this.parseJobRepo.findById(jobId);
        return {
          job: failedJob ?? job,
          projectStatusAfter: this.classifyFailure(errCode) === FailureKind.TransientError
            ? ProjectStatus.ReadyToParse
            : ProjectStatus.Failed,
          warnings: [],
        };
      }

      // 8b. 校验响应 schema（response.success=true 后才校验 data 结构）
      const validated = this.schemaValidator.validate<RawSeparationResult>(
        WorkerCommand.StartSeparation,
        response,
      );
      console.log(`[REAL_CHAIN] parseJobService.startSeparation schema_validated jobId="${jobId}" projectId="${params.projectId}" valid=${validated.valid}`);
      trace('schema_validated', {
        jobId,
        resultSetId,
        runtimeProfileId: selectedRuntimeProfileId,
        valid: validated.valid,
      });
      await this.throwIfCancelRequested(jobId, params.projectId, 'after_worker_response');

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
      try {
        const parentResultId = resultSetId;
        const runtimeProfileId = selectedRuntimeProfileId;
        const provenanceContext: SeparationProvenanceContext = {
          jobId,
          runtimeProfileId,
          parentResultId,
          sourceKind: 'separation',
        };
        const adapted = this.resultAdapter.adapt(
          validated.data!,
          params.projectId,
          params.projectDir,
          provenanceContext,
        );
        await this.throwIfCancelRequested(jobId, params.projectId, 'before_materialize');
        await this.materializeSeparatedStemFiles(
          validated.data!,
          workerOutputDir,
          adapted.stemFiles,
          jobId,
          params.projectId,
        );
        console.log(`[REAL_CHAIN] parseJobService.startSeparation adapted jobId="${jobId}" projectId="${params.projectId}" stemFilesLength=${adapted.stemFiles.length}`);
        await this.throwIfCancelRequested(jobId, params.projectId, 'before_handle_success');
        await this.handleSeparationSuccess(jobId, params, adapted, startMs, {
          parentResultId,
          preserveExistingStems: !!params.preserveExistingStems,
        });
        trace('completion_success_received', {
          jobId,
          resultSetId: parentResultId,
          runtimeProfileId,
        });

        const finalJob = await this.parseJobRepo.findById(jobId);
        return {
          job: finalJob ?? job,
          projectStatusAfter: ProjectStatus.Ready,
          warnings: adapted.warnings,
        };
      } catch (pipelineErr) {
        const error = pipelineErr instanceof Error ? pipelineErr : new Error(String(pipelineErr));
        console.error(
          `[REAL_CHAIN] parseJobService.startSeparation pipeline_error jobId="${jobId}" projectId="${params.projectId}" error="${error.message}"`,
        );
        console.error(
          `[REAL_CHAIN] parseJobService.startSeparation pipeline_error_stack jobId="${jobId}" projectId="${params.projectId}" stack="${error.stack ?? 'N/A'}"`,
        );
        throw pipelineErr;
      }
    } catch (err) {
      const tracedError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[REAL_CHAIN] parseJobService.startSeparation catch_error jobId="${jobId}" projectId="${params.projectId}" error="${tracedError.message}"`,
      );
      console.error(
        `[REAL_CHAIN] parseJobService.startSeparation catch_error_stack jobId="${jobId}" projectId="${params.projectId}" stack="${tracedError.stack ?? 'N/A'}"`,
      );
      trace('completion_failure_received', {
        jobId,
        resultSetId,
        runtimeProfileId: selectedRuntimeProfileId,
        errorCode: err instanceof AppError ? err.code : 'SEPARATION_EXECUTION_FAILED',
      });
      this.cleanupProgressListener();

      if (err instanceof AppError) {
        const currentJob = await this.parseJobRepo.findById(jobId);
        if (currentJob && (
          currentJob.status === JobStatus.Failed
          || currentJob.status === JobStatus.Success
          || currentJob.status === JobStatus.Cancelled
        )) {
          if (this.currentJobId === jobId) {
            this.currentJobId = null;
          }
          return {
            job: currentJob,
            projectStatusAfter: currentJob.status === JobStatus.Success
              ? ProjectStatus.Ready
              : (currentJob.status === JobStatus.Cancelled ? ProjectStatus.Cancelled : ProjectStatus.Failed),
            warnings: [],
          };
        }
        if (err.code === ErrorCode.TASK_CANCELLED) {
          await this.finalizeCancelledJob(jobId, params.projectId, startMs);
          const cancelledJob = await this.parseJobRepo.findById(jobId);
          return {
            job: cancelledJob ?? {
              ...job,
              status: JobStatus.Cancelled,
            },
            projectStatusAfter: ProjectStatus.Cancelled,
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
    } finally {
      await this.cleanupWorkerOutputDir(workerOutputDir, params.projectDir);
      this.cancelRequestedJobIds.delete(jobId);
    }
  }

  async cancelSeparation(jobId?: string): Promise<void> {
    // GPT R6 Must Fix #5：接受可选 jobId
    let targetJobId = jobId ?? this.currentJobId;
    if (!targetJobId) {
      return; // 幂等
    }

    // 首版串行约束：只允许取消当前任务
    if (targetJobId !== this.currentJobId) {
      this.logger.warn('cancel_request_rejected job_mismatch', {
        targetJobId,
        currentJobId: this.currentJobId,
        stage: 'parseJobService.cancelSeparation',
      });
      if (this.currentJobId) {
        targetJobId = this.currentJobId;
      } else {
        return;
      }
    }

    this.logger.info('cancel_request_accepted', {
      currentJobId: this.currentJobId,
      stage: 'parseJobService.cancelSeparation',
    });

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
    this.cancelRequestedJobIds.add(targetJobId);
    this.logger.info('Separation job marked cancel_requested', {
      jobId: targetJobId,
      stage: 'parseJobService.cancelSeparation',
    });

    const job = await this.parseJobRepo.findById(targetJobId);
    if (job && (job.status === JobStatus.Running || job.status === JobStatus.Pending)) {
      assertJobTransition(targetJobId, job.status, JobStatus.Cancelled);
      await this.parseJobRepo.updateStatus(
        targetJobId,
        JobStatus.Cancelled,
        ErrorCode.TASK_CANCELLED,
        'Cancelled by user',
      );

      const elapsed = job.startedAt ? Date.now() - job.startedAt : 0;
      await this.parseJobRepo.complete(targetJobId, JobStatus.Cancelled, elapsed);

      // GPT R6 Must Fix #3：取消 → 项目状态回到 Cancelled
      await this.projectRepo.updateStatus(job.projectId, ProjectStatus.Cancelled);
    }

    this.sendCancelBestEffort(job?.projectId ?? '');

    this.cleanupProgressListener();
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
    if (params.allowReadyStatus) {
      allowedStates.push(ProjectStatus.Ready);
    }
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
    const rawProgress = typeof payload.progress === 'number' ? payload.progress : null;
    // Worker currently reports global progress in [0, 1]. Normalize to [0, 100].
    // If a future worker reports [0, 100], keep backward compatibility.
    let progress = 0;
    if (rawProgress !== null) {
      progress = rawProgress <= 1 ? rawProgress * 100 : rawProgress;
    } else if (mapping) {
      // No numeric progress in payload: fall back to stage floor to avoid 0% "stuck" display.
      progress = mapping.minProgress;
    }
    progress = Math.max(0, Math.min(100, progress));

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
    options: {
      parentResultId: string;
      preserveExistingStems: boolean;
    },
  ): Promise<void> {
    await this.throwIfCancelRequested(jobId, params.projectId, 'handle_success_entry');
    const elapsedMs = Date.now() - startMs;
    const parentResultId = this.normalizeResultSetId(options.parentResultId);
    const projectFingerprint = await this.resolveProjectFingerprintForManifest(params.projectId, params.sourceFilePath);
    const signatureFromMain = adapted.manifestEntries.find((entry) =>
      entry.parentResultId === parentResultId
      && typeof entry.sourceSignature === 'string'
      && entry.sourceSignature.trim().length > 0,
    )?.sourceSignature?.trim();
    const fallbackSignature = adapted.manifestEntries.find((entry) =>
      typeof entry.sourceSignature === 'string'
      && entry.sourceSignature.trim().length > 0,
    )?.sourceSignature?.trim();
    const sourceSignature = signatureFromMain ?? fallbackSignature ?? '';
    if (sourceSignature.length === 0) {
      throw new AppError({
        code: ErrorCode.CACHE_MANIFEST_INVALID,
        message: `Missing sourceSignature for result set "${parentResultId}"`,
        userMessage: '分离结果元数据不完整，未生成有效结果集标识',
        context: {
          projectId: params.projectId,
          jobId,
          stage: 'parseJobService.handleSeparationSuccess',
        },
        retryable: false,
      });
    }
    const modelId = adapted.manifestEntries.find((entry) =>
      typeof entry.modelId === 'string' && entry.modelId.trim().length > 0,
    )?.modelId?.trim() ?? 'demucs';
    const runtimeProfileId = adapted.manifestEntries.find((entry) =>
      typeof entry.runtimeProfileId === 'string' && entry.runtimeProfileId.trim().length > 0,
    )?.runtimeProfileId?.trim() ?? 'demucs_env_override';
    const resultSetMain = {
      id: parentResultId,
      modelId,
      runtimeProfileId,
      sourceSignature,
      createdAt: Date.now(),
    };
    const expectedCurrentResultStemCount = adapted.stemFiles.length;
    if (expectedCurrentResultStemCount <= 0) {
      throw new AppError({
        code: ErrorCode.ENGINE_OUTPUT_INVALID,
        message: `No stem files adapted for resultSet "${parentResultId}"`,
        userMessage: '分离完成但未生成可用轨道，请重试',
        context: {
          projectId: params.projectId,
          jobId,
          parentResultId,
          stage: 'parseJobService.handleSeparationSuccess',
        },
        retryable: false,
      });
    }

    const persistStemRecords = async (): Promise<void> => {
      if (options.preserveExistingStems) {
        const existingStems = await this.stemFileRepo.findByProjectId(params.projectId);
        const keptStems = existingStems.filter((stem) =>
          this.normalizeResultSetId(stem.parentResultId) !== parentResultId,
        );
        await this.stemFileRepo.deleteByProjectId(params.projectId);
        await this.stemFileRepo.createMany([...keptStems, ...adapted.stemFiles]);
        return;
      }

      await this.stemFileRepo.deleteByProjectId(params.projectId);
      await this.stemFileRepo.createMany(adapted.stemFiles);
    };

    // 1. 写入 DB
    await persistStemRecords();
    let persistedStems = await this.stemFileRepo.findByProjectId(params.projectId);
    let persistedCurrentResultStems = persistedStems.filter((stem) =>
      this.normalizeResultSetId(stem.parentResultId) === parentResultId,
    );
    console.log(
      `[REAL_CHAIN] parseJobService.handleSeparationSuccess stem_persist_verify projectId="${params.projectId}" jobId="${jobId}" parentResultId="${parentResultId}" expectedCount=${expectedCurrentResultStemCount} persistedCount=${persistedCurrentResultStems.length}`,
    );
    if (expectedCurrentResultStemCount > 0 && persistedCurrentResultStems.length < expectedCurrentResultStemCount) {
      this.logger.warn('Stem persistence mismatch after first write, retry once', {
        projectId: params.projectId,
        jobId,
        expectedCurrentResultStemCount,
        persistedCurrentResultStemCount: persistedCurrentResultStems.length,
        stage: 'parseJobService.handleSeparationSuccess',
      });
      await persistStemRecords();
      persistedStems = await this.stemFileRepo.findByProjectId(params.projectId);
      persistedCurrentResultStems = persistedStems.filter((stem) =>
        this.normalizeResultSetId(stem.parentResultId) === parentResultId,
      );
      console.log(
        `[REAL_CHAIN] parseJobService.handleSeparationSuccess stem_persist_verify_retry projectId="${params.projectId}" jobId="${jobId}" parentResultId="${parentResultId}" expectedCount=${expectedCurrentResultStemCount} persistedCount=${persistedCurrentResultStems.length}`,
      );
    }
    if (expectedCurrentResultStemCount > 0 && persistedCurrentResultStems.length < expectedCurrentResultStemCount) {
      throw new AppError({
        code: ErrorCode.CACHE_MANIFEST_INVALID,
        message: `Stem persistence incomplete for resultSet "${parentResultId}": expected=${expectedCurrentResultStemCount}, actual=${persistedCurrentResultStems.length}`,
        userMessage: '分离完成后轨道写入异常，请重试',
        context: {
          projectId: params.projectId,
          jobId,
          parentResultId,
          expectedCurrentResultStemCount,
          persistedCurrentResultStemCount: persistedCurrentResultStems.length,
          stage: 'parseJobService.handleSeparationSuccess',
        },
        retryable: false,
      });
    }

    // 2. 写入 / 更新 manifest
    //    首次分离时 manifest 不存在（read 返回 null），需从头创建
    let existingManifest = await this.manifestManager.read(params.projectDir);
    if (!existingManifest) {
      existingManifest = await this.tryRecoverManifestWithoutStrictValidation(params.projectDir, projectFingerprint);
    }
    const existingResultSets = (existingManifest?.resultSets ?? [])
      .filter((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        return typeof entry.id === 'string'
          && typeof entry.modelId === 'string'
          && typeof entry.runtimeProfileId === 'string'
          && typeof entry.sourceSignature === 'string'
          && typeof entry.createdAt === 'number';
      })
      .map((entry) => ({
        id: entry.id.trim(),
        modelId: entry.modelId.trim(),
        runtimeProfileId: entry.runtimeProfileId.trim(),
        sourceSignature: entry.sourceSignature.trim(),
        createdAt: Math.floor(entry.createdAt),
      }))
      .filter((entry) => entry.id.length > 0 && entry.modelId.length > 0 && entry.runtimeProfileId.length > 0 && entry.sourceSignature.length > 0);
    const mergedResultSets = [
      ...existingResultSets.filter((entry) => entry.id !== resultSetMain.id),
      resultSetMain,
    ].sort((a, b) => a.createdAt - b.createdAt);
    const mergedManifestStems = options.preserveExistingStems && existingManifest
      ? [
          ...(existingManifest.stems ?? []).filter((entry) =>
            this.normalizeResultSetId(entry.parentResultId) !== parentResultId,
          ),
          ...adapted.manifestEntries,
        ]
      : adapted.manifestEntries;
    const rawActiveResultId = existingManifest?.activeResultId?.trim() || DEFAULT_ACTIVE_RESULT_ID;
    const activeResultId = mergedResultSets.some((entry) => entry.id === rawActiveResultId)
      ? rawActiveResultId
      : DEFAULT_ACTIVE_RESULT_ID;
    const manifest: ProjectManifest = existingManifest
      ? {
          // 已有 manifest → 增量更新
          ...existingManifest,
          fingerprint: existingManifest.fingerprint?.trim() || projectFingerprint,
          engineVersion: adapted.engineVersion,
          updatedAt: Date.now(),
          activeResultId,
          resultSets: mergedResultSets,
          stems: mergedManifestStems,
        }
      : {
          // 首次 → 创建最小初始 manifest
          projectId: params.projectId,
          fingerprint: projectFingerprint,
          sourceType: ProjectSourceType.Separation,
          schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION,
          engineVersion: adapted.engineVersion,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          activeResultId: DEFAULT_ACTIVE_RESULT_ID,
          resultSets: [resultSetMain],
          stems: adapted.manifestEntries,
          waveform: null,         // Phase 2 不做真实 waveform
          chordAnalysis: null,    // Phase 2 不做真实 chord
        };
    await this.manifestManager.write(params.projectDir, manifest);

    // 3. 完成 Job
    await this.throwIfCancelRequested(jobId, params.projectId, 'before_mark_success');
    assertJobTransition(jobId, JobStatus.Running, JobStatus.Success);
    await this.parseJobRepo.complete(jobId, JobStatus.Success, elapsedMs);

    // 4. 更新项目状态 → Ready
    await this.projectRepo.updateStatus(params.projectId, ProjectStatus.Ready);
    console.log(`[REAL_CHAIN] parseJobService.handleSeparationSuccess done jobId="${jobId}" projectId="${params.projectId}" createManyCount=${adapted.stemFiles.length} projectStatus="${ProjectStatus.Ready}"`);

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

  private normalizeResultSetId(value: string | null | undefined): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : DEFAULT_ACTIVE_RESULT_ID;
  }

  private async resolveProjectFingerprintForManifest(
    projectId: string,
    sourceFilePath: string,
  ): Promise<string> {
    const existingProject = await this.projectRepo.findById(projectId);
    const existingFingerprint = existingProject?.fingerprint?.trim() ?? '';
    if (existingFingerprint.length > 0) {
      return existingFingerprint;
    }

    const fallback = await this.buildFallbackFingerprint(projectId, sourceFilePath);
    await this.projectRepo.update(projectId, { fingerprint: fallback });
    return fallback;
  }

  private async buildFallbackFingerprint(projectId: string, sourceFilePath: string): Promise<string> {
    try {
      const stat = await fs.promises.stat(sourceFilePath);
      const resolvedPath = path.resolve(sourceFilePath).toLowerCase();
      const seed = `${projectId}|${resolvedPath}|${stat.size}|${Math.floor(stat.mtimeMs)}`;
      const digest = crypto.createHash('sha256').update(seed).digest('hex');
      return `auto:${digest}:${stat.size}`;
    } catch {
      const digest = crypto.createHash('sha256').update(projectId).digest('hex');
      return `auto:${digest}:0`;
    }
  }

  private async tryRecoverManifestWithoutStrictValidation(
    projectDir: string,
    fallbackFingerprint: string,
  ): Promise<ProjectManifest | null> {
    const manifestPath = path.join(projectDir, 'manifest.json');
    try {
      await fs.promises.access(manifestPath, fs.constants.R_OK);
    } catch {
      return null;
    }

    try {
      const raw = await fs.promises.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const recovered = parsed as ProjectManifest;
      return {
        ...recovered,
        fingerprint: (typeof recovered.fingerprint === 'string' && recovered.fingerprint.trim().length > 0)
          ? recovered.fingerprint.trim()
          : fallbackFingerprint,
      };
    } catch {
      return null;
    }
  }

  private resolveWorkerOutputDir(
    projectDir: string,
    overrideDir: string | undefined,
    resultSetId: string,
    jobId: string,
  ): string {
    const normalizedOverride = typeof overrideDir === 'string' ? overrideDir.trim() : '';
    if (normalizedOverride.length > 0) {
      return path.resolve(normalizedOverride);
    }
    const safeResultSet = this.normalizeResultSetId(resultSetId).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(projectDir, '.tmp-separation', `${safeResultSet}_${jobId}`);
  }

  private async materializeSeparatedStemFiles(
    raw: RawSeparationResult,
    workerOutputDir: string,
    stemFiles: import('../../domain/entities').StemFile[],
    jobId: string,
    projectId: string,
  ): Promise<void> {
    const workerStemsDir = path.join(workerOutputDir, 'stems');
    const targetByFileName = new Map<string, string>();
    for (const stem of stemFiles) {
      targetByFileName.set(path.basename(stem.filePath), stem.filePath);
    }

    for (const rawStem of raw.stems) {
      await this.throwIfCancelRequested(jobId, projectId, 'materialize_before_file');
      const sourcePath = path.join(workerStemsDir, rawStem.filename);
      const targetPath = targetByFileName.get(rawStem.filename);
      if (!targetPath) continue;

      try {
        await fs.promises.access(sourcePath, fs.constants.R_OK);
      } catch {
        throw new AppError({
          code: ErrorCode.DISK_WRITE_FAILED,
          message: `Separated stem file missing before materialization: ${sourcePath}`,
          userMessage: '分离输出文件缺失，无法完成结果写入',
          context: {
            stage: 'parseJobService.materializeSeparatedStemFiles',
            projectId,
            jobId,
            sourcePath,
            targetPath,
          },
          retryable: false,
        });
      }

      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      if (path.resolve(sourcePath) === path.resolve(targetPath)) {
        continue;
      }

      await fs.promises.copyFile(sourcePath, targetPath);
      await fs.promises.unlink(sourcePath).catch(() => undefined);
    }
  }

  private async isCancelRequested(jobId: string): Promise<boolean> {
    if (this.cancelRequestedJobIds.has(jobId)) return true;
    const job = await this.parseJobRepo.findById(jobId);
    return job?.status === JobStatus.Cancelled;
  }

  private async throwIfCancelRequested(jobId: string, projectId: string, stage: string): Promise<void> {
    if (!(await this.isCancelRequested(jobId))) return;
    this.logger.info('Separation success chain short-circuited by cancel request', {
      jobId,
      projectId,
      stage,
    });
    throw new AppError({
      code: ErrorCode.TASK_CANCELLED,
      message: `Separation cancelled: ${stage}`,
      userMessage: '已取消分离任务',
      context: {
        jobId,
        projectId,
        stage,
      },
      retryable: false,
    });
  }

  private async finalizeCancelledJob(jobId: string, projectId: string, startMs: number): Promise<void> {
    const job = await this.parseJobRepo.findById(jobId);
    if (job && job.status !== JobStatus.Cancelled) {
      await this.parseJobRepo.updateStatus(
        jobId,
        JobStatus.Cancelled,
        ErrorCode.TASK_CANCELLED,
        'Cancelled by user',
      );
      await this.parseJobRepo.complete(jobId, JobStatus.Cancelled, Math.max(0, Date.now() - startMs));
    } else if (job && job.finishedAt === null) {
      await this.parseJobRepo.complete(jobId, JobStatus.Cancelled, Math.max(0, Date.now() - startMs));
    }
    await this.projectRepo.updateStatus(projectId, ProjectStatus.Cancelled).catch(() => undefined);
    this.currentJobId = null;
  }

  private async cleanupWorkerOutputDir(workerOutputDir: string, projectDir: string): Promise<void> {
    const normalizedWorkerDir = path.resolve(workerOutputDir);
    const normalizedProjectDir = path.resolve(projectDir);
    if (normalizedWorkerDir === normalizedProjectDir) return;

    const tempRoot = path.resolve(projectDir, '.tmp-separation');
    if (!normalizedWorkerDir.startsWith(tempRoot)) return;
    await fs.promises.rm(normalizedWorkerDir, { recursive: true, force: true }).catch(() => undefined);
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
