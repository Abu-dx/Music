/**
 * @module infrastructure/worker/workerHealthChecker
 * @description Worker 协议级健康检查器 — 真实 ping/pong 实现
 *
 * Why（GPT R5 Must Fix #1, Decision #1）：
 * 规格文档要求健康检查基于真实协议（request/response），
 * 不允许仅更新本地时间戳的伪健康语义。
 *
 * 设计选择（GPT R5 Decision #1 — "A 的变体"）：
 * - 在 infrastructure/worker 内部新增独立协调对象
 * - 持有 IWorkerManager + IWorkerIpcBridge，负责 ping/pong
 * - 不让 WorkerManager 直接依赖 IpcBridge（避免循环依赖）
 * - 不让上层 ParseService 拼装健康检查
 *
 * 职责：
 * - 发送 HealthCheck 命令并等待响应（真实协议级 ping/pong）
 * - 周期性自动健康检查（可配置间隔）
 * - 健康检查失败时标记 Worker 为 Unresponsive
 * - 健康检查成功时更新 Worker 健康时间戳
 *
 * 不负责：
 * - Worker 进程生命周期 → WorkerManager
 * - 消息收发协议 → WorkerIpcBridge
 * - 自动重启（由 WorkerManager 在进程退出时自动处理）
 *
 * 错误语义：
 * - check(): 超时或失败抛 AppError(WORKER_HEALTH_CHECK_FAILED)
 * - startPeriodicCheck(): 幂等，重复调用先停再启
 * - stopPeriodicCheck(): 幂等，未运行时静默返回
 */

import { WorkerCommand } from '../../shared/enums';
import { AppError, ErrorCode } from '../../shared/errors';
import { ILogger } from '../../shared/logger';
import { IWorkerManager, WorkerStatus } from './workerManager';
import { IWorkerIpcBridge } from './workerIpcBridge';

// ============================================================================
// 1. 配置
// ============================================================================

export interface WorkerHealthCheckConfig {
  /**
   * 健康检查超时（ms）
   * 默认 5000 — 基于规格文档 §24.4
   */
  timeoutMs: number;

  /**
   * 周期性检查间隔（ms）
   * 默认 30000 — 基于规格文档 §24.4
   */
  intervalMs: number;
}

export const DEFAULT_HEALTH_CHECK_CONFIG: WorkerHealthCheckConfig = {
  timeoutMs: 5000,
  intervalMs: 30000,
};

// ============================================================================
// 2. 接口
// ============================================================================

/**
 * Worker 健康检查器接口
 */
export interface IWorkerHealthChecker {
  /**
   * 执行一次协议级健康检查
   *
   * 流程：
   * 1. 检查 Worker 是否运行
   * 2. 发送 WorkerCommand.HealthCheck
   * 3. 等待响应（带超时）
   * 4. 响应成功 → 更新健康时间戳
   * 5. 响应超时/失败 → 标记 Unresponsive
   *
   * @throws AppError(WORKER_HEALTH_CHECK_FAILED) Worker 未运行、超时或失败
   */
  check(): Promise<void>;

  /**
   * 启动周期性健康检查
   *
   * 幂等：重复调用先停再启。
   */
  startPeriodicCheck(): void;

  /**
   * 停止周期性健康检查
   *
   * 幂等：未运行时静默返回。
   */
  stopPeriodicCheck(): void;

  /**
   * 是否正在周期性检查
   */
  isPeriodicCheckRunning(): boolean;
}

// ============================================================================
// 3. 实现
// ============================================================================

export class WorkerHealthChecker implements IWorkerHealthChecker {
  private periodicTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly workerManager: IWorkerManager,
    private readonly ipcBridge: IWorkerIpcBridge,
    private readonly config: WorkerHealthCheckConfig,
    private readonly logger: ILogger,
  ) {}

  async check(): Promise<void> {
    const startMs = Date.now();
    console.log('[REAL_CHAIN] workerHealthChecker.check begin');

    // 1. 检查 Worker 状态
    const status = this.workerManager.getStatus();
    if (status.status !== WorkerStatus.Running && status.status !== WorkerStatus.Unresponsive) {
      console.log(`[REAL_CHAIN] workerHealthChecker.check fail_not_running status=${status.status}`);
      throw new AppError({
        code: ErrorCode.WORKER_HEALTH_CHECK_FAILED,
        message: `Worker is not running (status: ${status.status})`,
        userMessage: 'Worker 进程未运行',
        context: { workerStatus: status.status },
        retryable: true,
      });
    }

    // 2. 发送 HealthCheck 命令
    try {
      const response = await this.ipcBridge.send(
        WorkerCommand.HealthCheck,
        {},
        this.config.timeoutMs,
      );
      console.log(`[REAL_CHAIN] workerHealthChecker.check response success=${response.success} errorCode=${response.error?.code ?? 'N/A'} errorMessage="${response.error?.message ?? ''}"`);

      // 3. 检查响应
      if (!response.success) {
        this.workerManager.markUnresponsive();
        throw new AppError({
          code: ErrorCode.WORKER_HEALTH_CHECK_FAILED,
          message: `Health check returned failure: ${response.error?.message ?? 'unknown'}`,
          userMessage: 'Worker 健康检查失败',
          context: { error: response.error },
          retryable: true,
        });
      }

      // 4. 成功 → 更新时间戳
      this.workerManager.updateHealthCheckTimestamp();
      console.log(`[REAL_CHAIN] workerHealthChecker.check success elapsedMs=${Date.now() - startMs}`);

      this.logger.debug('Health check passed (protocol-level)', {
        elapsedMs: Date.now() - startMs,
        stage: 'workerHealthChecker.check',
      });
    } catch (err) {
      console.log(`[REAL_CHAIN] workerHealthChecker.check caught error="${err instanceof Error ? err.message : String(err)}"`);
      if (err instanceof AppError && err.code === ErrorCode.WORKER_HEALTH_CHECK_FAILED) {
        throw err; // 已经是正确的错误，直接 rethrow
      }

      // IPC 超时或协议错误 → 标记 Unresponsive
      this.workerManager.markUnresponsive();

      if (err instanceof AppError) {
        // 将 IPC_TIMEOUT 等包装为 HEALTH_CHECK_FAILED
        throw new AppError({
          code: ErrorCode.WORKER_HEALTH_CHECK_FAILED,
          message: `Health check failed: ${err.message}`,
          userMessage: 'Worker 健康检查失败',
          context: { originalCode: err.code },
          retryable: true,
          cause: err,
        });
      }

      const error = err instanceof Error ? err : new Error(String(err));
      throw new AppError({
        code: ErrorCode.WORKER_HEALTH_CHECK_FAILED,
        message: `Health check failed: ${error.message}`,
        userMessage: 'Worker 健康检查失败',
        context: {},
        retryable: true,
        cause: error,
      });
    }
  }

  startPeriodicCheck(): void {
    // 幂等：先停再启
    this.stopPeriodicCheck();

    this.periodicTimer = setInterval(() => {
      // [REAL_CHAIN] Long-running commands (e.g. start_separation) block the single-threaded
      // Python worker loop. Sending health_check concurrently can timeout and produce false
      // unresponsive state. Skip periodic ping while there are pending IPC requests.
      const pendingCount = this.ipcBridge.getPendingCount();
      if (pendingCount > 0) {
        console.log(`[REAL_CHAIN] workerHealthChecker.periodicCheck skipped pendingCount=${pendingCount}`);
        return;
      }

      this.check().catch((err) => {
        this.logger.warn('Periodic health check failed', {
          error: err instanceof Error ? err.message : String(err),
          stage: 'workerHealthChecker.periodicCheck',
        });
      });
    }, this.config.intervalMs);

    this.logger.debug('Periodic health check started', {
      intervalMs: this.config.intervalMs,
      stage: 'workerHealthChecker.startPeriodicCheck',
    });
  }

  stopPeriodicCheck(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;

      this.logger.debug('Periodic health check stopped', {
        stage: 'workerHealthChecker.stopPeriodicCheck',
      });
    }
  }

  isPeriodicCheckRunning(): boolean {
    return this.periodicTimer !== null;
  }
}
