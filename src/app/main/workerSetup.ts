/**
 * @module app/main/workerSetup
 * @description Worker 基础设施 + ParseJobService 初始化 — composition root
 *
 * Phase 2 MVP 组装清单：
 * - WorkerManager: 进程生命周期
 * - WorkerIpcBridge: JSON-line 协议
 * - WorkerHealthChecker: ping/pong 健康检查
 * - WorkerSchemaValidator: 响应校验
 * - SeparationResultAdapter: 引擎输出归一化
 * - In-Memory Repos: Phase 2 stub（Phase 3 → SQLite）
 * - ManifestManager: manifest 读写（真实实现）
 * - ProjectDirManager: 项目目录管理（真实实现）
 * - NoOpCacheService: Phase 2 stub（isolateFailedProject 只打日志）
 * - ParseJobService: 分离任务编排（真实实现）
 *
 * 本模块不引入新概念，只做 composition + 初始化。
 */

import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import {
  WorkerManager,
  WorkerManagerConfig,
} from '../../infrastructure/worker/workerManager';
import { WorkerIpcBridge, DEFAULT_IPC_BRIDGE_CONFIG } from '../../infrastructure/worker/workerIpcBridge';
import { WorkerHealthChecker, DEFAULT_HEALTH_CHECK_CONFIG } from '../../infrastructure/worker/workerHealthChecker';
import {
  WorkerSchemaValidator,
  assertField,
  createValidationFailure,
} from '../../infrastructure/worker/workerSchemaValidator';
import { SeparationResultAdapter, RawSeparationResult } from '../../infrastructure/adapters/separationResultAdapter';
import {
  InMemoryProjectRepository,
  InMemoryStemFileRepository,
  InMemoryParseJobRepository,
  InMemoryStateTransitionRepository,
} from '../../infrastructure/persistence/inMemoryRepos';
import { ManifestManager } from '../../infrastructure/fs/manifestManager';
import { ProjectDirManager } from '../../infrastructure/fs/projectDirManager';
import {
  ParseJobService,
  IParseJobService,
  DEFAULT_PARSE_JOB_CONFIG,
} from '../../application/services/parseJobService';
import type { ICacheService } from '../../application/services/cacheService';
import { WorkerCommand } from '../../shared/enums';
import { ConsoleLogger } from '../../shared/logger';
import { LogLevel } from '../../shared/enums';
import type { ValidatedWorkerResponse } from '../../shared/contracts';

// ============================================================================
// Logger
// ============================================================================

const logger = new ConsoleLogger(LogLevel.Debug, { stage: 'worker' });

// ============================================================================
// StartSeparation Response Validator
// ============================================================================

/**
 * 校验 WorkerCommand.StartSeparation 的响应数据
 * 验证其符合 RawSeparationResult 结构
 */
function validateStartSeparationResponse(
  data: Record<string, unknown> | undefined,
): ValidatedWorkerResponse<RawSeparationResult> {
  if (!data) {
    return {
      valid: false,
      validationErrors: [
        createValidationFailure('data', 'object', 'undefined', 'Response data is missing'),
      ],
    };
  }

  const errors: import('../../shared/contracts').SchemaValidationFailure[] = [];

  assertField(data, 'engineVersion', 'string', errors);
  assertField(data, 'stems', 'array', errors);

  if (errors.length > 0) {
    return { valid: false, validationErrors: errors };
  }

  // Validate each stem entry
  const stems = data.stems as unknown[];
  for (let i = 0; i < stems.length; i++) {
    const stem = stems[i] as Record<string, unknown>;
    if (typeof stem !== 'object' || stem === null) {
      errors.push(createValidationFailure(
        `stems[${i}]`, 'object', typeof stem, `stems[${i}] is not an object`,
      ));
      continue;
    }
    assertField(stem, 'filename', 'string', errors);
    assertField(stem, 'codec', 'string', errors);
    assertField(stem, 'sizeBytes', 'number', errors);
    // durationMs and sampleRate are expected but we tolerate if missing
  }

  if (errors.length > 0) {
    return { valid: false, validationErrors: errors };
  }

  return {
    valid: true,
    data: data as unknown as RawSeparationResult,
  };
}

interface RawWaveformResult {
  id: string;
  channels: number;
  length: number;
  sampleRate: number;
  peaks: number[];
  durationMs: number;
  elapsedMs?: number;
  analysisVersion?: string;
}

function validateGenerateWaveformResponse(
  data: Record<string, unknown> | undefined,
): ValidatedWorkerResponse<RawWaveformResult> {
  if (!data) {
    return {
      valid: false,
      validationErrors: [
        createValidationFailure('data', 'object', 'undefined', 'Response data is missing'),
      ],
    };
  }
  const errors: import('../../shared/contracts').SchemaValidationFailure[] = [];
  assertField(data, 'id', 'string', errors);
  assertField(data, 'channels', 'number', errors);
  assertField(data, 'length', 'number', errors);
  assertField(data, 'sampleRate', 'number', errors);
  assertField(data, 'peaks', 'array', errors);
  assertField(data, 'durationMs', 'number', errors);

  if (errors.length > 0) {
    return { valid: false, validationErrors: errors };
  }

  const peaks = data.peaks as unknown[];
  for (let i = 0; i < peaks.length; i++) {
    if (typeof peaks[i] !== 'number') {
      errors.push(createValidationFailure(
        `peaks[${i}]`,
        'number',
        typeof peaks[i],
        `peaks[${i}] is not a number`,
      ));
      break;
    }
  }

  if (errors.length > 0) {
    return { valid: false, validationErrors: errors };
  }

  return {
    valid: true,
    data: data as unknown as RawWaveformResult,
  };
}

interface RawChordSegmentResult {
  startMs: number;
  endMs: number;
  label: string;
  simplifiedLabel?: string;
  confidence?: number;
  sourceFlags?: string[];
}

interface RawChordAnalysisResult {
  projectId: string;
  source: string;
  analyzerType: string;
  segments: RawChordSegmentResult[];
  elapsedMs: number;
  analyzedAt: number;
  audioDurationMs: number;
  estimatedKey?: string;
  estimatedBpm?: number;
  analysisVersion?: string;
  vocabularyVersion?: string;
  warnings?: string[];
  generatedAt?: number;
}

function validateExecuteChordAnalysisResponse(
  data: Record<string, unknown> | undefined,
): ValidatedWorkerResponse<RawChordAnalysisResult> {
  if (!data) {
    return {
      valid: false,
      validationErrors: [
        createValidationFailure('data', 'object', 'undefined', 'Response data is missing'),
      ],
    };
  }

  const errors: import('../../shared/contracts').SchemaValidationFailure[] = [];
  assertField(data, 'projectId', 'string', errors);
  assertField(data, 'source', 'string', errors);
  assertField(data, 'analyzerType', 'string', errors);
  assertField(data, 'segments', 'array', errors);
  assertField(data, 'elapsedMs', 'number', errors);
  assertField(data, 'analyzedAt', 'number', errors);
  assertField(data, 'audioDurationMs', 'number', errors);

  if (errors.length > 0) {
    return { valid: false, validationErrors: errors };
  }

  const segments = data.segments as unknown[];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as Record<string, unknown>;
    if (typeof seg !== 'object' || seg === null) {
      errors.push(createValidationFailure(
        `segments[${i}]`,
        'object',
        typeof seg,
        `segments[${i}] is not an object`,
      ));
      continue;
    }
    assertField(seg, 'startMs', 'number', errors);
    assertField(seg, 'endMs', 'number', errors);
    assertField(seg, 'label', 'string', errors);
  }

  if (errors.length > 0) {
    return { valid: false, validationErrors: errors };
  }

  return {
    valid: true,
    data: data as unknown as RawChordAnalysisResult,
  };
}

// ============================================================================
// NoOp CacheService (Phase 2 stub)
// ============================================================================

/**
 * Phase 2 CacheService stub — isolateFailedProject 只打日志
 *
 * CacheService 真实实现依赖 IAppSettingsRepository / IFingerprintCalculator，
 * 这两个在 Phase 2 均无实现。且 Phase 2 不做持久化缓存管理。
 * Phase 3 替换为真实 CacheService。
 */
class NoOpCacheService implements ICacheService {
  async checkCacheHit(_fingerprint: string) {
    return { hit: false as const, project: null, validation: null };
  }
  async validateProjectCache(_projectId: string): Promise<import('../../application/services/cacheService').CacheValidationResult> {
    return {
      projectId: _projectId,
      valid: true,
      repairable: false,
      suggestedAction: 'none' as import('../../application/services/cacheService').CacheRepairAction,
      manifestValidation: { valid: true, manifest: null, issues: [], schemaCompatible: true },
      directoryExists: true,
    };
  }
  async markForDeletion(_projectId: string) { /* noop */ }
  async purgeMarkedProjects(): Promise<number> {
    return 0;
  }
  async isolateFailedProject(projectId: string) {
    logger.info(`[NoOpCacheService] Would isolate failed project ${projectId} — skipped in Phase 2`);
  }
  async cleanupFailedProjects(): Promise<number> {
    return 0;
  }
  async getStorageStats(): Promise<import('../../application/services/cacheService').CacheStorageStats> {
    return {
      activeProjectCount: 0, activeTotalSizeBytes: 0,
      failedProjectCount: 0, markedForDeletionCount: 0,
    };
  }
}

// ============================================================================
// Singleton instances
// ============================================================================

let workerManager: WorkerManager | null = null;
let ipcBridge: WorkerIpcBridge | null = null;
let healthChecker: WorkerHealthChecker | null = null;
let schemaValidator: WorkerSchemaValidator | null = null;
let resultAdapter: SeparationResultAdapter | null = null;

// Phase 2 in-memory repos (exposed for handlers.ts direct queries)
let projectRepo: InMemoryProjectRepository | null = null;
let stemFileRepo: InMemoryStemFileRepository | null = null;
let parseJobRepo: InMemoryParseJobRepository | null = null;

let parseJobService: ParseJobService | null = null;

function resolveWorkerScriptPath(): string {
  const candidates = [
    // Primary: app path relative lookup
    path.join(app.getAppPath(), 'python', 'worker', 'main.py'),
    // Dev runtime: launched from project root
    path.join(process.cwd(), 'python', 'worker', 'main.py'),
    // Dist runtime: __dirname = dist/main/app/main
    path.resolve(__dirname, '..', '..', '..', '..', 'python', 'worker', 'main.py'),
    // Packaged fallback
    path.join(process.resourcesPath, 'python', 'worker', 'main.py'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log(`[REAL_CHAIN] workerSetup.resolveWorkerScriptPath selected="${candidate}"`);
      return candidate;
    }
  }

  console.log(`[REAL_CHAIN] workerSetup.resolveWorkerScriptPath no_match candidates=${JSON.stringify(candidates)}`);
  // Keep original primary path as fallback so validateConfig() can report the exact missing path.
  return candidates[0];
}

export interface WorkerInfra {
  workerManager: WorkerManager;
  ipcBridge: WorkerIpcBridge;
  healthChecker: WorkerHealthChecker;
  schemaValidator: WorkerSchemaValidator;
  resultAdapter: SeparationResultAdapter;
  // Phase 2: ParseJobService + repos exposed for handlers.ts
  parseJobService: IParseJobService;
  projectRepo: InMemoryProjectRepository;
  stemFileRepo: InMemoryStemFileRepository;
  parseJobRepo: InMemoryParseJobRepository;
}

/**
 * 初始化 Worker 基础设施（幂等）
 *
 * 调用时机：app.whenReady() 之后，registerIpcHandlers() 之前
 */
export function initWorkerInfra(): WorkerInfra {
  if (
    workerManager && ipcBridge && healthChecker && schemaValidator &&
    resultAdapter && parseJobService && projectRepo && stemFileRepo && parseJobRepo
  ) {
    return {
      workerManager, ipcBridge, healthChecker, schemaValidator, resultAdapter,
      parseJobService, projectRepo, stemFileRepo, parseJobRepo,
    };
  }

  // 确定 Python Worker 脚本路径
  const workerScriptPath = resolveWorkerScriptPath();

  // 确定 Python 可执行文件路径
  const pythonPath = process.platform === 'win32' ? 'python' : 'python3';

  const config: WorkerManagerConfig = {
    pythonPath,
    workerScriptPath,
    healthCheckTimeoutMs: 5000,
    healthCheckIntervalMs: 30000,
    maxRestartAttempts: 3,
    gracefulShutdownTimeoutMs: 10000,
  };

  // --- Worker infrastructure ---
  workerManager = new WorkerManager(config, logger);
  ipcBridge = new WorkerIpcBridge(workerManager, DEFAULT_IPC_BRIDGE_CONFIG, logger);
  healthChecker = new WorkerHealthChecker(workerManager, ipcBridge, DEFAULT_HEALTH_CHECK_CONFIG, logger);
  schemaValidator = new WorkerSchemaValidator(logger);
  resultAdapter = new SeparationResultAdapter(logger);

  // 注册 schema validators
  schemaValidator.registerValidator(
    WorkerCommand.StartSeparation,
    validateStartSeparationResponse,
  );
  schemaValidator.registerValidator(
    WorkerCommand.GenerateWaveform,
    validateGenerateWaveformResponse,
  );
  schemaValidator.registerValidator(
    WorkerCommand.ExecuteChordAnalysis,
    validateExecuteChordAnalysisResponse,
  );

  // Worker 退出时自动 reject pending
  workerManager.onBeforeStop(() => {
    ipcBridge!.rejectAllPending('Worker stopping');
  });

  // --- Phase 2 in-memory repos ---
  projectRepo = new InMemoryProjectRepository();
  stemFileRepo = new InMemoryStemFileRepository();
  parseJobRepo = new InMemoryParseJobRepository();
  const stateTransitionRepo = new InMemoryStateTransitionRepository();

  // --- Real filesystem infrastructure ---
  const manifestManager = new ManifestManager(logger);
  const projectDirManager = new ProjectDirManager(logger);

  // --- Phase 2 NoOp CacheService ---
  const cacheService = new NoOpCacheService();

  // --- ParseJobService ---
  parseJobService = new ParseJobService(
    parseJobRepo,
    stemFileRepo,
    projectRepo,
    stateTransitionRepo,
    workerManager,
    ipcBridge,
    schemaValidator,
    manifestManager,
    projectDirManager,
    resultAdapter,
    cacheService,
    {
      ...DEFAULT_PARSE_JOB_CONFIG,
      separationTimeoutMs: 1_800_000, // 30 分钟（Demucs 长音频需要）
    },
    logger,
  );

  logger.info('Worker infrastructure + ParseJobService initialized', {
    pythonPath,
    workerScriptPath,
  });
  console.log(`[REAL_CHAIN] workerSetup.initWorkerInfra pythonPath="${pythonPath}" workerScriptPath="${workerScriptPath}"`);

  return {
    workerManager, ipcBridge, healthChecker, schemaValidator, resultAdapter,
    parseJobService, projectRepo, stemFileRepo, parseJobRepo,
  };
}

/**
 * 启动 Worker（启动进程 + attach bridge + health check）
 */
export async function startWorker(infra: WorkerInfra): Promise<void> {
  console.log('[REAL_CHAIN] workerSetup.startWorker begin');
  await infra.workerManager.start();
  infra.ipcBridge.attach();

  // 初始健康检查（失败不阻塞启动）
  try {
    await infra.healthChecker.check();
    console.log('[REAL_CHAIN] workerSetup.startWorker health_check=passed');
    logger.info('Worker health check passed');
  } catch (err) {
    console.log(`[REAL_CHAIN] workerSetup.startWorker health_check=failed error="${err instanceof Error ? err.message : String(err)}"`);
    logger.warn('Initial health check failed, worker may not be ready yet', {
      error: err instanceof Error ? err.message : String(err),
    });
    // 重要：check() 失败时内部会调 markUnresponsive()，将 status 改为 Unresponsive。
    // 但初始 health check 失败不应阻止后续请求（可能只是竞态超时），
    // 如果进程实际仍在运行，恢复为 Running 让 isAcceptingRequests() 返回 true。
    // 后续周期性 health check 会持续监控真实健康状态。
    const status = infra.workerManager.getStatus();
    if (status.pid !== null) {
      // 进程仍存活 → 手动恢复时间戳以将 status 从 Unresponsive 恢复为 Running
      infra.workerManager.updateHealthCheckTimestamp();
      logger.info('Worker status recovered to Running (process still alive)', {
        pid: status.pid,
      });
      console.log(`[REAL_CHAIN] workerSetup.startWorker recovered_to_running pid=${status.pid}`);
    }
  }

  // 最终状态诊断（必须在所有恢复逻辑之后）
  const finalStatus = infra.workerManager.getStatus();
  console.log(`[REAL_CHAIN] workerSetup.startWorker done status=${finalStatus.status} pid=${finalStatus.pid} acceptingRequests=${finalStatus.acceptingRequests}`);

  // 启动周期健康检查
  infra.healthChecker.startPeriodicCheck();
}

/**
 * 停止 Worker
 */
export async function stopWorker(infra: WorkerInfra): Promise<void> {
  infra.healthChecker.stopPeriodicCheck();
  infra.ipcBridge.detach();
  await infra.workerManager.stop();
}
