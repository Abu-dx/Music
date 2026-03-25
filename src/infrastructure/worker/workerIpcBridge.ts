/**
 * @module infrastructure/worker/workerIpcBridge
 * @description Worker IPC 通信桥 — JSON-line 协议收发与消息路由
 *
 * 职责（规格文档 §24.4, ADR-006）：
 * - 向 Worker 子进程发送 WorkerRequest（JSON-line → stdin）
 * - 从 Worker 子进程接收 WorkerResponse / WorkerEvent（stdout → JSON parse）
 * - 管理请求-响应映射（id → Promise resolve/reject）
 * - 超时控制（单次请求超时 → reject）
 * - 将 WorkerEvent 路由给已注册的监听器
 * - stderr 日志解析（[LEVEL] 前缀 → logger 映射）
 *
 * 不负责：
 * - Worker 进程生命周期 → WorkerManager
 * - 响应 schema 校验 → WorkerSchemaValidator
 * - 协议级健康检查 → WorkerHealthChecker
 * - 具体任务编排 → 各自 Service
 *
 * 通信协议（ADR-006）：
 * - 主进程 → Worker：通过 stdin 写入 JSON + '\n'
 * - Worker → 主进程：通过 stdout 输出 JSON + '\n'
 * - stderr：Worker 日志输出，支持 [LEVEL] 前缀解析
 * - 消息类型：WorkerRequest / WorkerResponse / WorkerEvent
 *
 * 并发约束（GPT R5 Suggested #2）：
 * - 规格文档建议首版单任务串行，避免算力争抢与感知抖动。
 * - 本桥不做硬并发限制（由上层 ParseJobService 通过队列串行化），
 *   但通过 getPendingCount() 暴露当前并发数，便于上层做串行约束。
 * - 若需要硬限制，可在 send() 中检查 pendingRequests.size 并拒绝。
 *
 * Pending Request 生命周期（GPT R5 Must Fix #4）：
 * - send() 前检查 workerManager.isAcceptingRequests()，不接受时拒绝
 * - stop/restart 前：WorkerManager 通过 onBeforeStop 回调触发 rejectAllPending()
 * - dispose()：reject 所有 pending（错误码 WORKER_IPC_PROTOCOL_ERROR, retryable=false）
 * - 超时：reject 对应请求（错误码 WORKER_IPC_TIMEOUT, retryable=true）
 * - crash 期间：isAcceptingRequests()=false → send() 直接拒绝
 *
 * stderr 日志处理（GPT R5 Decision #2 — 先 B 再演进 C）：
 * - 解析 stderr 行首 [LEVEL] 前缀：[DEBUG] [INFO] [WARN] [WARNING] [ERROR]
 * - 映射到对应 logger 方法
 * - 无前缀的行默认 warn
 * - 未来可演进到 WorkerEvent(LogSummary) 结构化日志
 *
 * 错误语义：
 * - send(): Worker 不接受请求 → AppError(WORKER_IPC_PROTOCOL_ERROR, retryable=true)
 * - send(): disposed → AppError(WORKER_IPC_PROTOCOL_ERROR, retryable=false)
 * - send(): 超时 → AppError(WORKER_IPC_TIMEOUT, retryable=true)
 * - send(): stdin 写入失败 → AppError(WORKER_IPC_PROTOCOL_ERROR, retryable=true)
 * - 收到非法 JSON → 记日志，不抛异常，不影响其他请求
 *
 * 幂等性：
 * - attach / detach: 重复调用安全
 * - dispose: 重复调用安全（已 dispose 后静默返回）
 */

import * as crypto from 'crypto';
import {
  WorkerRequest,
  WorkerResponse,
  WorkerEvent,
  WorkerMessage,
} from '../../shared/contracts';
import {
  WorkerMessageType,
  WorkerCommand,
  WorkerEventName,
} from '../../shared/enums';
import { AppError, ErrorCode } from '../../shared/errors';
import { ILogger } from '../../shared/logger';
import { IWorkerManager } from './workerManager';

// ============================================================================
// 1. 类型定义
// ============================================================================

/** WorkerEvent 监听器 */
export type WorkerEventListener = (event: WorkerEvent) => void;

/** 待处理请求上下文 */
interface PendingRequest {
  id: string;
  sentAt: number;
  command: WorkerCommand;
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: WorkerResponse) => void;
  reject: (error: AppError) => void;
}

/**
 * IPC Bridge 配置
 *
 * GPT R5 Suggested #5：默认值来源说明
 */
export interface WorkerIpcBridgeConfig {
  /**
   * 单次请求默认超时（ms）
   * 默认 60000 — 基于规格文档 §24.4 "Worker 单次任务最大 60 秒超时"
   * 分离任务等长时间操作应通过 timeoutMs 参数覆盖
   */
  defaultTimeoutMs: number;
}

/** 默认配置 */
export const DEFAULT_IPC_BRIDGE_CONFIG: WorkerIpcBridgeConfig = {
  defaultTimeoutMs: 60000,
};

// ============================================================================
// 2. 接口
// ============================================================================

/**
 * Worker IPC Bridge 接口
 *
 * Application Service / WorkerHealthChecker 通过此接口与 Python Worker 通信。
 */
export interface IWorkerIpcBridge {
  /**
   * 连接到 WorkerManager 管理的子进程流
   *
   * 绑定 stdout/stderr 监听。幂等：重复调用会先断开再重新绑定。
   * 同时注册 onBeforeStop 回调以在 stop 前 reject pending requests。
   */
  attach(): void;

  /**
   * 断开与子进程流的连接
   *
   * 移除所有 stdout/stderr 监听。幂等：未连接时静默返回。
   */
  detach(): void;

  /**
   * 发送请求并等待响应
   *
   * 约束：
   * - Worker 未运行 / Crashed / Stopping 时直接拒绝
   * - 规格文档建议首版单任务串行，上层应通过 ParseJobService 控制
   *
   * @param command - Worker 命令
   * @param payload - 请求载荷
   * @param timeoutMs - 超时时间（ms，可选）
   * @throws AppError(WORKER_IPC_PROTOCOL_ERROR) Worker 不可用 / 已 disposed / 写入失败
   * @throws AppError(WORKER_IPC_TIMEOUT) 请求超时
   */
  send(
    command: WorkerCommand,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<WorkerResponse>;

  /**
   * 注册 WorkerEvent 监听器
   *
   * @param eventName - 事件名（null 则监听所有事件）
   * @param listener - 回调函数
   * @returns 取消注册的函数
   */
  on(eventName: WorkerEventName | null, listener: WorkerEventListener): () => void;

  /** 获取当前待处理请求数 */
  getPendingCount(): number;

  /**
   * 拒绝所有待处理请求
   *
   * 由 WorkerManager.onBeforeStop 回调触发，也可手动调用。
   * 错误码 WORKER_IPC_PROTOCOL_ERROR, retryable=false。
   */
  rejectAllPending(reason: string): void;

  /**
   * 销毁 Bridge（清理所有待处理请求 + 断开连接）
   *
   * 幂等：重复调用安全。
   */
  dispose(): void;
}

// ============================================================================
// 3. stderr 日志级别解析
// ============================================================================

/**
 * stderr [LEVEL] 前缀正则
 *
 * GPT R5 Decision #2：先支持 [LEVEL] 前缀解析，后续演进到 WorkerEvent(LogSummary)。
 * 支持的格式：[DEBUG] [INFO] [WARN] [WARNING] [ERROR]
 */
const STDERR_LEVEL_REGEX = /^\[(DEBUG|INFO|WARN|WARNING|ERROR)\]\s*/i;

type StderrLogLevel = 'debug' | 'info' | 'warn' | 'error';

function parseStderrLevel(line: string): { level: StderrLogLevel; message: string } {
  const match = STDERR_LEVEL_REGEX.exec(line);
  if (!match) {
    return { level: 'warn', message: line }; // 无前缀默认 warn
  }

  const raw = match[1].toUpperCase();
  const message = line.slice(match[0].length);
  let level: StderrLogLevel;

  switch (raw) {
    case 'DEBUG': level = 'debug'; break;
    case 'INFO': level = 'info'; break;
    case 'WARN':
    case 'WARNING': level = 'warn'; break;
    case 'ERROR': level = 'error'; break;
    default: level = 'warn';
  }

  return { level, message };
}

// ============================================================================
// 4. 实现
// ============================================================================

export class WorkerIpcBridge implements IWorkerIpcBridge {
  private pendingRequests = new Map<string, PendingRequest>();
  private eventListeners = new Map<WorkerEventName | 'all', Set<WorkerEventListener>>();
  private lineBuffer = '';
  private attached = false;
  private disposed = false;
  private beforeStopRegistered = false;

  // 绑定函数引用（用于移除监听）
  private boundOnStdoutData: ((data: Buffer) => void) | null = null;
  private boundOnStderrData: ((data: Buffer) => void) | null = null;

  constructor(
    private readonly workerManager: IWorkerManager,
    private readonly config: WorkerIpcBridgeConfig,
    private readonly logger: ILogger,
  ) {}

  attach(): void {
    if (this.disposed) return;

    // 幂等：先 detach
    if (this.attached) {
      this.detach();
    }

    // 通过 getStreams() 获取流引用，不暴露 ChildProcess
    const streams = this.workerManager.getStreams();
    if (!streams) {
      this.logger.warn('Cannot attach: worker streams not available', {
        stage: 'workerIpcBridge.attach',
      });
      return;
    }

    this.boundOnStdoutData = (data: Buffer) => this.handleStdoutData(data);
    this.boundOnStderrData = (data: Buffer) => this.handleStderrData(data);

    streams.stdout.on('data', this.boundOnStdoutData);
    streams.stderr.on('data', this.boundOnStderrData);

    // GPT R5 Must Fix #4：注册 onBeforeStop 回调
    if (!this.beforeStopRegistered) {
      this.workerManager.onBeforeStop(() => {
        this.rejectAllPending('Worker is stopping');
      });
      this.beforeStopRegistered = true;
    }

    this.attached = true;

    this.logger.debug('IPC bridge attached', {
      stage: 'workerIpcBridge.attach',
    });
  }

  detach(): void {
    const streams = this.workerManager.getStreams();

    if (streams) {
      if (this.boundOnStdoutData) {
        streams.stdout.removeListener('data', this.boundOnStdoutData);
      }
      if (this.boundOnStderrData) {
        streams.stderr.removeListener('data', this.boundOnStderrData);
      }
    }

    this.boundOnStdoutData = null;
    this.boundOnStderrData = null;
    this.attached = false;
    this.lineBuffer = '';

    this.logger.debug('IPC bridge detached', {
      stage: 'workerIpcBridge.detach',
    });
  }

  async send(
    command: WorkerCommand,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<WorkerResponse> {
    // 已 disposed — 不可恢复
    if (this.disposed) {
      throw new AppError({
        code: ErrorCode.WORKER_IPC_PROTOCOL_ERROR,
        message: 'IPC bridge has been disposed',
        userMessage: 'Worker 通信桥已销毁',
        context: {},
        retryable: false,
      });
    }

    // GPT R5 Must Fix #4：检查 Worker 是否接受请求
    if (!this.workerManager.isAcceptingRequests()) {
      const status = this.workerManager.getStatus();
      throw new AppError({
        code: ErrorCode.WORKER_IPC_PROTOCOL_ERROR,
        message: `Worker is not accepting requests (status: ${status.status})`,
        userMessage: 'Worker 进程不可用',
        context: { command, workerStatus: status.status },
        retryable: true, // 可能正在重启
      });
    }

    // 获取 stdin 流
    const streams = this.workerManager.getStreams();
    if (!streams) {
      throw new AppError({
        code: ErrorCode.WORKER_IPC_PROTOCOL_ERROR,
        message: 'Worker streams not available',
        userMessage: 'Worker 进程未运行',
        context: { command },
        retryable: true,
      });
    }

    const requestId = crypto.randomUUID();
    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;

    const request: WorkerRequest = {
      type: WorkerMessageType.Request,
      id: requestId,
      command,
      payload,
    };
    console.log(`[REAL_CHAIN] workerIpcBridge.send request requestId="${requestId}" command="${command}" timeoutMs=${timeout}`);

    return new Promise<WorkerResponse>((resolve, reject) => {
      // 设置超时
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new AppError({
          code: ErrorCode.WORKER_IPC_TIMEOUT,
          message: `Worker request timed out after ${timeout}ms`,
          userMessage: 'Worker 请求超时',
          context: { requestId, command, timeoutMs: timeout },
          retryable: true,
        }));
      }, timeout);

      // 注册待处理请求
      this.pendingRequests.set(requestId, {
        id: requestId,
        sentAt: Date.now(),
        command,
        timer,
        resolve,
        reject,
      });

      // 写入 stdin（JSON-line 协议）
      const line = JSON.stringify(request) + '\n';
      try {
        const writeOk = streams.stdin.write(line, 'utf-8');

        if (!writeOk) {
          // 背压（backpressure）— 记日志，等 drain
          streams.stdin.once('drain', () => {
            this.logger.debug('stdin drain recovered', {
              requestId,
              stage: 'workerIpcBridge.send',
            });
          });
        }
      } catch (err) {
        // stdin 写入失败 — 清理 pending + reject
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(new AppError({
          code: ErrorCode.WORKER_IPC_PROTOCOL_ERROR,
          message: `Failed to write to worker stdin: ${err instanceof Error ? err.message : String(err)}`,
          userMessage: 'Worker 通信失败',
          context: { requestId, command },
          retryable: true,
          cause: err instanceof Error ? err : undefined,
        }));
        return;
      }

      this.logger.debug('Request sent to worker', {
        requestId,
        command,
        stage: 'workerIpcBridge.send',
      });
    });
  }

  on(eventName: WorkerEventName | null, listener: WorkerEventListener): () => void {
    const key = eventName ?? 'all';
    if (!this.eventListeners.has(key)) {
      this.eventListeners.set(key, new Set());
    }
    this.eventListeners.get(key)!.add(listener);

    return () => {
      const set = this.eventListeners.get(key);
      if (set) {
        set.delete(listener);
        if (set.size === 0) {
          this.eventListeners.delete(key);
        }
      }
    };
  }

  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new AppError({
        code: ErrorCode.WORKER_IPC_PROTOCOL_ERROR,
        message: `Request rejected: ${reason}`,
        userMessage: 'Worker 请求被中断',
        context: { requestId: id, command: pending.command, reason },
        retryable: false,
      }));
    }
    this.pendingRequests.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // reject 所有 pending requests
    this.rejectAllPending('IPC bridge disposed');

    // 断开连接
    this.detach();

    // 清理监听器
    this.eventListeners.clear();

    this.logger.info('IPC bridge disposed', {
      stage: 'workerIpcBridge.dispose',
    });
  }

  // --- Internal ---

  private handleStdoutData(data: Buffer): void {
    const chunkText = data.toString('utf-8');
    const chunkPreview = chunkText.replace(/\s+/g, ' ').slice(0, 220);
    console.log(
      `[REAL_CHAIN] workerIpcBridge.stdout_chunk_received bytes=${data.length} pendingCount=${this.pendingRequests.size} preview="${chunkPreview}"`,
    );
    this.lineBuffer += chunkText;

    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        console.log(
          `[REAL_CHAIN] workerIpcBridge.stdout_json_parse_attempt pendingCount=${this.pendingRequests.size} linePreview="${trimmed.slice(0, 220)}"`,
        );
        const message = JSON.parse(trimmed) as WorkerMessage;
        this.routeMessage(message);
      } catch (err) {
        const parseErrorMessage = err instanceof Error ? err.message : String(err);
        console.error(
          `[REAL_CHAIN] workerIpcBridge.stdout_json_parse_failed pendingCount=${this.pendingRequests.size} error="${parseErrorMessage}" linePreview="${trimmed.slice(0, 220)}"`,
        );
        this.logger.warn('Invalid JSON from worker stdout', {
          line: trimmed.slice(0, 200),
          parseError: parseErrorMessage,
          stage: 'workerIpcBridge.handleStdoutData',
        });
        this.rejectPendingFromProtocolFault(
          `Invalid JSON from worker stdout: ${parseErrorMessage}`,
        );
      }
    }
  }

  /**
   * stderr 处理 — 解析 [LEVEL] 前缀并映射到 logger
   *
   * GPT R5 Decision #2：先 B（[LEVEL] 解析），预留 C（WorkerEvent）。
   */
  private handleStderrData(data: Buffer): void {
    const text = data.toString('utf-8');
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const { level, message } = parseStderrLevel(trimmed);
      const context = {
        output: message.slice(0, 500),
        stage: 'workerIpcBridge.stderr',
      };

      switch (level) {
        case 'debug': this.logger.debug(message, context); break;
        case 'info': this.logger.info(message, context); break;
        case 'warn': this.logger.warn(message, context); break;
        case 'error': this.logger.error(message, null, context); break;
      }
    }
  }

  private routeMessage(message: WorkerMessage): void {
    switch (message.type) {
      case WorkerMessageType.Response:
        this.handleResponse(message as WorkerResponse);
        break;
      case WorkerMessageType.Event:
        this.handleEvent(message as WorkerEvent);
        break;
      default:
        this.logger.warn('Unknown message type from worker', {
          type: (message as unknown as Record<string, unknown>).type,
          stage: 'workerIpcBridge.routeMessage',
        });
    }
  }

  private handleResponse(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.error(
        `[REAL_CHAIN] workerIpcBridge.response_unknown_request_id responseId="${response.id}" pendingCount=${this.pendingRequests.size}`,
      );
      this.logger.warn('Received response for unknown request', {
        responseId: response.id,
        stage: 'workerIpcBridge.handleResponse',
      });
      if (this.pendingRequests.size > 0) {
        this.rejectPendingFromProtocolFault(
          `Response id mismatch from worker: responseId=${response.id}`,
        );
      }
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);

    // resolve（即使 success=false 也 resolve，由上层检查）
    console.log(`[REAL_CHAIN] workerIpcBridge.send response requestId="${response.id}" success=${response.success} errorCode=${response.error?.code ?? 'N/A'} errorMessage="${response.error?.message ?? ''}"`);
    pending.resolve(response);

    this.logger.debug('Response received', {
      requestId: response.id,
      success: response.success,
      elapsedMs: Date.now() - pending.sentAt,
      stage: 'workerIpcBridge.handleResponse',
    });
  }

  private rejectPendingFromProtocolFault(reason: string): void {
    if (this.pendingRequests.size === 0) {
      return;
    }
    const pendingIds = Array.from(this.pendingRequests.keys());
    console.error(
      `[REAL_CHAIN] workerIpcBridge.protocol_fault_reject pendingCount=${pendingIds.length} reason="${reason}" pendingIds="${pendingIds.join(',')}"`,
    );
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new AppError({
        code: ErrorCode.WORKER_IPC_PROTOCOL_ERROR,
        message: `Worker IPC protocol fault: ${reason}`,
        userMessage: 'Worker 通信协议异常，请重试',
        context: { requestId: id, command: pending.command, reason },
        retryable: true,
      }));
    }
    this.pendingRequests.clear();
  }

  private handleEvent(event: WorkerEvent): void {
    const specific = this.eventListeners.get(event.eventName);
    if (specific) {
      for (const listener of specific) {
        try { listener(event); } catch (err) {
          this.logger.error('Event listener error', err instanceof Error ? err : null,
            { eventName: event.eventName, stage: 'workerIpcBridge.handleEvent' });
        }
      }
    }

    const all = this.eventListeners.get('all');
    if (all) {
      for (const listener of all) {
        try { listener(event); } catch (err) {
          this.logger.error('Event listener error (all)', err instanceof Error ? err : null,
            { eventName: event.eventName, stage: 'workerIpcBridge.handleEvent' });
        }
      }
    }
  }
}
