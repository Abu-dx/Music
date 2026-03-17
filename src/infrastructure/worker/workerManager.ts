/**
 * @module infrastructure/worker/workerManager
 * @description Python Worker 进程生命周期管理器
 *
 * ═══════════════════════════════════════════════════════════════════════
 * MODULE SPEC（GPT R5 Must Fix #6 — 模块文档要求）
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. 概述
 * WorkerManager 管理一个 Python 子进程的完整生命周期：启动、停止、
 * 重启、崩溃恢复。它不负责 IPC 消息收发或响应校验。
 *
 * 2. 通信协议
 * - 子进程通过 stdio: ['pipe', 'pipe', 'pipe'] 创建
 * - stdin：主进程 → Worker（由 IpcBridge 写入 JSON-line）
 * - stdout：Worker → 主进程（由 IpcBridge 读取 JSON-line）
 * - stderr：Worker 日志输出（由 IpcBridge 解析 [LEVEL] 前缀）
 *
 * 3. 状态机
 * WorkerStatus 转移规则：
 *   Idle ──start()──→ Starting ──spawn ok──→ Running
 *   Running ──stop()──→ Stopping ──exit──→ Idle
 *   Running ──crash──→ Crashed ──auto restart──→ Starting
 *   Running ──health fail──→ Unresponsive ──restart──→ Starting
 *   Crashed ──超过 maxRestartAttempts──→ Crashed（终态，需人工干预）
 *   任何状态 ──stop()──→ Stopping ──exit──→ Idle
 *
 * 4. 重启语义
 * - 自动重启仅在 Running 状态下异常退出时触发
 * - 重启计数器 restartCount 只在异常退出时递增
 * - 超过 maxRestartAttempts 后停止自动重启，进入终态 Crashed
 * - 手动调用 restart() 不受 maxRestartAttempts 限制（会重置计数器）
 *
 * 5. Pending Request 生命周期（GPT R5 Must Fix #4）
 * - WorkerManager 不直接管理 pending requests（由 IpcBridge 管理）
 * - stop() / restart() 前，调用方应先通过 onBeforeStop 回调通知 IpcBridge
 *   reject 所有 pending requests（错误码 WORKER_IPC_PROTOCOL_ERROR）
 * - crash 后自动重启期间（Crashed/Starting 状态），IpcBridge.send() 应
 *   检查 isAcceptingRequests() 并拒绝新请求
 * - 超过 maxRestartAttempts 后 isAcceptingRequests() 返回 false
 *
 * 6. 配置校验（GPT R5 Must Fix #5）
 * - start() 前硬校验 workerScriptPath 非空且文件存在
 * - start() 前硬校验 pythonPath 非空
 * - 校验失败抛 AppError(WORKER_SPAWN_FAILED)
 *
 * 7. 错误码映射（GPT R5 Must Fix #3）
 * ┌──────────────────────────────────┬────────────────────────────────┬──────────┬──────────────┐
 * │ 场景                            │ ErrorCode                      │ retryable│ 触发重启？    │
 * ├──────────────────────────────────┼────────────────────────────────┼──────────┼──────────────┤
 * │ spawn 失败 / 配置无效           │ WORKER_SPAWN_FAILED            │ true     │ 否           │
 * │ 子进程异常退出                   │ WORKER_SPAWN_FAILED            │ true     │ 是(自动)     │
 * │ 健康检查失败(未运行)            │ WORKER_HEALTH_CHECK_FAILED     │ true     │ 否           │
 * │ 健康检查超时(协议级)            │ WORKER_HEALTH_CHECK_FAILED     │ true     │ 可选(上层决)  │
 * │ IPC 请求超时                    │ WORKER_IPC_TIMEOUT             │ true     │ 否           │
 * │ 协议解析失败                    │ WORKER_IPC_PROTOCOL_ERROR      │ false    │ 否           │
 * │ schema 校验失败                 │ WORKER_RESPONSE_SCHEMA_INVALID │ false    │ 否           │
 * │ stdin 写入失败                  │ WORKER_IPC_PROTOCOL_ERROR      │ true     │ 否           │
 * │ bridge disposed / 请求被中断    │ WORKER_IPC_PROTOCOL_ERROR      │ false    │ 否           │
 * └──────────────────────────────────┴────────────────────────────────┴──────────┴──────────────┘
 *
 * 用户可见错误：WORKER_SPAWN_FAILED, WORKER_HEALTH_CHECK_FAILED
 * 仅内部/日志：WORKER_IPC_PROTOCOL_ERROR, WORKER_RESPONSE_SCHEMA_INVALID, WORKER_IPC_TIMEOUT
 *
 * 职责（规格文档 §24.4, ADR-006）：
 * - 启动 / 停止 / 重启 Python Worker 子进程
 * - Worker 进程异常退出时自动重启（有限次数）
 * - 向上层暴露 Worker 状态与连接能力（不暴露原生 ChildProcess）
 *
 * 不负责：
 * - Worker 消息序列化/反序列化 → WorkerIpcBridge
 * - Worker 响应 schema 校验 → WorkerSchemaValidator
 * - 协议级健康检查 ping/pong → WorkerHealthChecker
 * - 具体任务编排（分离/和弦/波形） → 各自 Service
 *
 * 运行约束：
 * - 仅在 main process 中使用（ADR-003, ADR-009）
 * - 所有公开方法均为 async
 * - spawn / kill 等操作必须 <50ms 或后台化（ADR-002）
 *
 * DI（ADR-008）：
 * - 通过 IWorkerManager 接口暴露给 Application Service
 * - 不直接被 renderer / domain 层 import
 * - 不暴露原生 ChildProcess 到上层（GPT R5 Must Fix #2）
 *
 * 错误语义：
 * - start(): Worker 已在运行 → 静默返回（幂等）
 * - stop(): Worker 未运行 → 静默返回（幂等）
 * - restart(): 先 stop 再 start，均幂等；重置 restartCount
 * - getStatus(): 纯查询，不抛异常
 *
 * 危险操作 & 幂等性：
 * - stop(): 终止子进程，进行中的任务会丢失。调用方应先取消任务再 stop。
 *   幂等性：重复调用安全（未运行时静默返回）。
 * - restart(): 先 stop 再 start，同上。
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import { Readable, Writable } from 'stream';
import { AppError, ErrorCode } from '../../shared/errors';
import { ILogger } from '../../shared/logger';

// ============================================================================
// 1. Worker 状态
// ============================================================================

/**
 * Worker 进程运行状态
 *
 * 状态转移见 MODULE SPEC §3
 */
export enum WorkerStatus {
  /** 未启动 */
  Idle = 'idle',
  /** 启动中（进程已 spawn，等待就绪） */
  Starting = 'starting',
  /** 运行中（进程存活） */
  Running = 'running',
  /** 停止中（已发 SIGTERM，等待退出） */
  Stopping = 'stopping',
  /** 已崩溃（异常退出，可能自动重启） */
  Crashed = 'crashed',
  /**
   * 无响应（进程存活但协议不通）
   * GPT R5 Suggested #1：区分"进程崩了"和"进程在但协议不通"
   */
  Unresponsive = 'unresponsive',
}

/**
 * Worker 状态快照（暴露给上层查询）
 *
 * GPT R5 Must Fix #2：不暴露原生 ChildProcess，
 * 仅提供只读诊断信息。
 */
export interface WorkerStatusInfo {
  /** 当前状态 */
  status: WorkerStatus;
  /** 进程 PID（运行中时非 null） */
  pid: number | null;
  /** 上次健康检查时间（Unix ms） */
  lastHealthCheckAt: number | null;
  /** 累计自动重启次数（手动 restart 会重置） */
  restartCount: number;
  /** 启动时间（Unix ms） */
  startedAt: number | null;
  /** 是否接受新请求（Idle/Crashed(超限)/Stopping/Unresponsive 时为 false） */
  acceptingRequests: boolean;
}

/**
 * Worker 管理器配置
 *
 * GPT R5 Suggested #5：默认值来源说明
 */
export interface WorkerManagerConfig {
  /**
   * Python 可执行文件路径
   * 默认 'python3'（Unix）或 'python'（Windows）
   * 来源：用户设置 AppSettings.pythonPath 或系统 PATH
   */
  pythonPath: string;

  /**
   * Worker 入口脚本路径（必填，start() 前校验文件存在性）
   * 来源：应用打包路径 或 开发环境绝对路径
   * ⚠️ 不允许空字符串（GPT R5 Must Fix #5）
   */
  workerScriptPath: string;

  /**
   * 健康检查超时（ms）
   * 默认 5000 — 基于规格文档 §24.4 "Worker 健康检查 5 秒超时"
   */
  healthCheckTimeoutMs: number;

  /**
   * 健康检查间隔（ms）
   * 默认 30000 — 基于规格文档 §24.4 "每 30 秒一次心跳"
   */
  healthCheckIntervalMs: number;

  /**
   * 最大自动重启次数
   * 默认 3 — 基于规格文档 §24.4 "连续失败 3 次后停止自动重启"
   * 手动调用 restart() 会重置计数器，不受此限制
   */
  maxRestartAttempts: number;

  /**
   * 进程优雅关闭超时（ms）
   * 默认 10000 — SIGTERM 后等待 10 秒，超时则 SIGKILL
   */
  gracefulShutdownTimeoutMs: number;
}

/**
 * IPC 流连接器 — 供 IpcBridge 使用的最小写入/读取接口
 *
 * GPT R5 Must Fix #2：不暴露完整 ChildProcess，
 * 仅暴露 stdin(Writable) / stdout(Readable) / stderr(Readable) 的只读引用。
 */
export interface WorkerStreams {
  /** stdin 写入流（主进程 → Worker） */
  readonly stdin: Writable;
  /** stdout 读取流（Worker → 主进程） */
  readonly stdout: Readable;
  /** stderr 读取流（Worker 日志） */
  readonly stderr: Readable;
}

// ============================================================================
// 2. 接口
// ============================================================================

/**
 * Worker 管理器接口
 *
 * Application Service / IpcBridge 通过此接口管理 Python Worker 子进程。
 * ⚠️ 不暴露原生 ChildProcess（GPT R5 Must Fix #2）
 */
export interface IWorkerManager {
  /**
   * 启动 Worker 进程
   *
   * 幂等：若 Worker 已在运行则静默返回。
   *
   * @throws AppError(WORKER_SPAWN_FAILED) 配置无效或启动失败
   */
  start(): Promise<void>;

  /**
   * 停止 Worker 进程
   *
   * ⚠️ 危险操作：进行中的任务会丢失，调用方应先取消任务。
   * 调用前应通过 onBeforeStop 回调通知 IpcBridge reject pending requests。
   * 幂等：若 Worker 未运行则静默返回。
   */
  stop(): Promise<void>;

  /**
   * 重启 Worker 进程（先 stop 再 start）
   *
   * 重置 restartCount 计数器。
   *
   * @throws AppError(WORKER_SPAWN_FAILED) 重启后启动失败
   */
  restart(): Promise<void>;

  /**
   * 获取 Worker 当前状态快照
   *
   * 纯查询，不抛异常。
   */
  getStatus(): WorkerStatusInfo;

  /**
   * 获取 Worker 进程的 IPC 流（供 IpcBridge 使用）
   *
   * 仅暴露 stdin/stdout/stderr 流引用，不暴露完整 ChildProcess。
   * Worker 未运行时返回 null。
   */
  getStreams(): WorkerStreams | null;

  /**
   * 当前是否接受新请求
   *
   * Running 状态为 true；其他状态为 false。
   * IpcBridge 在 send() 前应检查此方法。
   */
  isAcceptingRequests(): boolean;

  /**
   * 注册 Worker 退出回调
   */
  onExit(callback: (code: number | null, signal: string | null) => void): void;

  /**
   * 注册 stop 前回调（供 IpcBridge 在 stop 前 reject pending requests）
   */
  onBeforeStop(callback: () => void): void;

  /**
   * 更新健康检查时间戳（由 WorkerHealthChecker 调用）
   */
  updateHealthCheckTimestamp(): void;

  /**
   * 标记为无响应状态（由 WorkerHealthChecker 在超时时调用）
   */
  markUnresponsive(): void;
}

// ============================================================================
// 3. 实现
// ============================================================================

export class WorkerManager implements IWorkerManager {
  private process: child_process.ChildProcess | null = null;
  private currentStatus: WorkerStatus = WorkerStatus.Idle;
  private pid: number | null = null;
  private startedAt: number | null = null;
  private lastHealthCheckAt: number | null = null;
  private restartCount = 0;
  private exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];
  private beforeStopCallbacks: Array<() => void> = [];

  constructor(
    private readonly config: WorkerManagerConfig,
    private readonly logger: ILogger,
  ) {}

  async start(): Promise<void> {
    // 幂等：已在运行或启动中 → 静默返回
    if (this.currentStatus === WorkerStatus.Running || this.currentStatus === WorkerStatus.Starting) {
      this.logger.debug('Worker already running or starting, skipping start', {
        stage: 'workerManager.start',
      });
      return;
    }

    // GPT R6 Must Fix #2：启动前异步硬校验配置
    await this.validateConfig();

    this.currentStatus = WorkerStatus.Starting;

    try {
      const proc = child_process.spawn(
        this.config.pythonPath,
        [this.config.workerScriptPath],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        },
      );

      if (!proc.pid) {
        throw new Error('Failed to obtain PID from spawned process');
      }

      this.process = proc;
      this.pid = proc.pid;
      this.startedAt = Date.now();
      this.currentStatus = WorkerStatus.Running;

      // 监听进程退出
      proc.on('exit', (code, signal) => {
        this.handleProcessExit(code, signal);
      });

      // 监听进程错误（spawn 失败等）
      proc.on('error', (err) => {
        this.logger.error('Worker process error', err, {
          stage: 'workerManager.start',
        });
        if (this.currentStatus !== WorkerStatus.Stopping) {
          this.currentStatus = WorkerStatus.Crashed;
        }
      });

      this.logger.info('Worker process started', {
        pid: this.pid,
        stage: 'workerManager.start',
      });
    } catch (err) {
      this.currentStatus = WorkerStatus.Idle;
      this.process = null;
      this.pid = null;

      const error = err instanceof Error ? err : new Error(String(err));
      throw new AppError({
        code: ErrorCode.WORKER_SPAWN_FAILED,
        message: `Failed to start worker process: ${error.message}`,
        userMessage: 'Worker 进程启动失败',
        context: {
          pythonPath: this.config.pythonPath,
          scriptPath: this.config.workerScriptPath,
        },
        retryable: true,
        cause: error,
      });
    }
  }

  async stop(): Promise<void> {
    // 幂等：未运行 → 静默返回
    if (!this.process || this.currentStatus === WorkerStatus.Idle) {
      return;
    }

    // GPT R5 Must Fix #4：通知 IpcBridge 在 stop 前 reject pending requests
    for (const cb of this.beforeStopCallbacks) {
      try {
        cb();
      } catch (err) {
        this.logger.error(
          'beforeStop callback error',
          err instanceof Error ? err : null,
          { stage: 'workerManager.stop' },
        );
      }
    }

    this.currentStatus = WorkerStatus.Stopping;
    const proc = this.process;

    try {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // 进程可能已退出
          }
          resolve();
        }, this.config.gracefulShutdownTimeoutMs);

        proc.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });

        try {
          proc.kill('SIGTERM');
        } catch {
          clearTimeout(timeout);
          resolve();
        }
      });
    } finally {
      this.process = null;
      this.pid = null;
      this.startedAt = null;
      this.currentStatus = WorkerStatus.Idle;

      this.logger.info('Worker process stopped', {
        stage: 'workerManager.stop',
      });
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    // 手动 restart 重置计数器
    this.restartCount = 0;
    await this.start();

    this.logger.info('Worker process restarted (manual)', {
      stage: 'workerManager.restart',
    });
  }

  getStatus(): WorkerStatusInfo {
    return {
      status: this.currentStatus,
      pid: this.pid,
      lastHealthCheckAt: this.lastHealthCheckAt,
      restartCount: this.restartCount,
      startedAt: this.startedAt,
      acceptingRequests: this.isAcceptingRequests(),
    };
  }

  getStreams(): WorkerStreams | null {
    if (!this.process || !this.process.stdin || !this.process.stdout || !this.process.stderr) {
      return null;
    }
    return {
      stdin: this.process.stdin,
      stdout: this.process.stdout,
      stderr: this.process.stderr,
    };
  }

  isAcceptingRequests(): boolean {
    return this.currentStatus === WorkerStatus.Running;
  }

  onExit(callback: (code: number | null, signal: string | null) => void): void {
    this.exitCallbacks.push(callback);
  }

  onBeforeStop(callback: () => void): void {
    this.beforeStopCallbacks.push(callback);
  }

  updateHealthCheckTimestamp(): void {
    this.lastHealthCheckAt = Date.now();
    // 如果之前是 Unresponsive，恢复为 Running
    if (this.currentStatus === WorkerStatus.Unresponsive) {
      this.currentStatus = WorkerStatus.Running;
      this.logger.info('Worker recovered from unresponsive state', {
        stage: 'workerManager.updateHealthCheckTimestamp',
      });
    }
  }

  markUnresponsive(): void {
    if (this.currentStatus === WorkerStatus.Running) {
      this.currentStatus = WorkerStatus.Unresponsive;
      this.logger.warn('Worker marked as unresponsive', {
        pid: this.pid,
        stage: 'workerManager.markUnresponsive',
      });
    }
  }

  // --- Internal ---

  /**
   * GPT R6 Must Fix #2：异步配置校验
   *
   * 不再使用同步 fs.accessSync，改为 fs.promises.access。
   * 避免在 Electron main 进程中积累同步 I/O 先例。
   *
   * @throws AppError(WORKER_SPAWN_FAILED) 配置无效
   */
  private async validateConfig(): Promise<void> {
    if (!this.config.workerScriptPath) {
      throw new AppError({
        code: ErrorCode.WORKER_SPAWN_FAILED,
        message: 'workerScriptPath is empty — must be configured before start()',
        userMessage: 'Worker 脚本路径未配置',
        context: { workerScriptPath: this.config.workerScriptPath },
        retryable: false,
      });
    }

    // 异步检查脚本文件存在性
    try {
      await fs.promises.access(this.config.workerScriptPath, fs.constants.R_OK);
    } catch {
      throw new AppError({
        code: ErrorCode.WORKER_SPAWN_FAILED,
        message: `Worker script not found or not readable: ${this.config.workerScriptPath}`,
        userMessage: 'Worker 脚本文件不存在或不可读',
        context: { workerScriptPath: this.config.workerScriptPath },
        retryable: false,
      });
    }

    if (!this.config.pythonPath) {
      throw new AppError({
        code: ErrorCode.WORKER_SPAWN_FAILED,
        message: 'pythonPath is empty — must be configured before start()',
        userMessage: 'Python 路径未配置',
        context: { pythonPath: this.config.pythonPath },
        retryable: false,
      });
    }
  }

  private handleProcessExit(code: number | null, signal: string | null): void {
    const wasRunning = this.currentStatus === WorkerStatus.Running
      || this.currentStatus === WorkerStatus.Unresponsive;

    if (this.currentStatus !== WorkerStatus.Stopping) {
      // 非预期退出
      this.currentStatus = WorkerStatus.Crashed;

      this.logger.error(
        'Worker process exited unexpectedly',
        null,
        {
          code,
          signal,
          pid: this.pid,
          stage: 'workerManager.handleProcessExit',
        },
      );

      // 清理进程引用
      this.process = null;
      this.pid = null;
      this.startedAt = null;

      // 自动重启（有限次数）
      if (wasRunning && this.restartCount < this.config.maxRestartAttempts) {
        this.restartCount++;

        this.logger.info('Attempting automatic restart', {
          restartCount: this.restartCount,
          maxAttempts: this.config.maxRestartAttempts,
          stage: 'workerManager.handleProcessExit',
        });

        this.start().catch((err) => {
          this.logger.error(
            'Automatic restart failed',
            err instanceof Error ? err : null,
            { stage: 'workerManager.handleProcessExit' },
          );
        });
      } else if (this.restartCount >= this.config.maxRestartAttempts) {
        this.logger.error(
          'Max restart attempts exceeded, worker remains crashed',
          null,
          {
            restartCount: this.restartCount,
            maxAttempts: this.config.maxRestartAttempts,
            stage: 'workerManager.handleProcessExit',
          },
        );
      }
    }

    // 通知回调
    for (const cb of this.exitCallbacks) {
      try {
        cb(code, signal);
      } catch (err) {
        this.logger.error(
          'Exit callback error',
          err instanceof Error ? err : null,
          { stage: 'workerManager.handleProcessExit' },
        );
      }
    }
  }
}
