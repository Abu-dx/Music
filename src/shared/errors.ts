/**
 * @module shared/errors
 * @description 统一错误码体系与结构化错误类
 *
 * 设计原则（规格文档 §25.2）：
 * - 拒绝在全局散落裸 try-catch，边界层集中捕获
 * - 领域与应用层返回结构化错误结果或抛出受控异常
 * - 错误对象包含 code / message / userMessage / context / retryable / cause
 * - 关键错误通过事件总线或统一通知中心抛给 UI 层
 * - UI 层只负责友好提示和恢复入口
 */

// ============================================================================
// 1. 错误码枚举（集中定义，规格文档 §25.2）
// ============================================================================

/**
 * 统一错误码
 *
 * 命名规则：<MODULE>_<DESCRIPTION>
 * 所有模块的错误码在此集中管理，禁止在各自模块中私自定义错误码字符串
 */
export enum ErrorCode {
  // --- 输入相关 ---
  INPUT_UNSUPPORTED_FORMAT = 'INPUT_UNSUPPORTED_FORMAT',
  INPUT_FILE_NOT_FOUND = 'INPUT_FILE_NOT_FOUND',
  INPUT_FILE_CORRUPTED = 'INPUT_FILE_CORRUPTED',
  INPUT_FILE_TOO_LARGE = 'INPUT_FILE_TOO_LARGE',
  INPUT_METADATA_UNREADABLE = 'INPUT_METADATA_UNREADABLE',

  // --- 缓存相关 ---
  CACHE_CORRUPTED = 'CACHE_CORRUPTED',
  CACHE_MANIFEST_INVALID = 'CACHE_MANIFEST_INVALID',
  CACHE_FILES_MISSING = 'CACHE_FILES_MISSING',
  CACHE_VERSION_INCOMPATIBLE = 'CACHE_VERSION_INCOMPATIBLE',
  CACHE_REBUILD_FAILED = 'CACHE_REBUILD_FAILED',

  // --- 磁盘 / 文件系统 ---
  DISK_NO_SPACE = 'DISK_NO_SPACE',
  DISK_WRITE_FAILED = 'DISK_WRITE_FAILED',
  DISK_READ_FAILED = 'DISK_READ_FAILED',
  DISK_PERMISSION_DENIED = 'DISK_PERMISSION_DENIED',

  // --- 分离引擎 ---
  ENGINE_TIMEOUT = 'ENGINE_TIMEOUT',
  ENGINE_CRASH = 'ENGINE_CRASH',
  ENGINE_OUTPUT_INVALID = 'ENGINE_OUTPUT_INVALID',
  ENGINE_NOT_FOUND = 'ENGINE_NOT_FOUND',
  ENGINE_VERSION_MISMATCH = 'ENGINE_VERSION_MISMATCH',

  // --- Worker / IPC ---
  WORKER_SPAWN_FAILED = 'WORKER_SPAWN_FAILED',
  WORKER_HEALTH_CHECK_FAILED = 'WORKER_HEALTH_CHECK_FAILED',
  WORKER_IPC_TIMEOUT = 'WORKER_IPC_TIMEOUT',
  WORKER_IPC_PROTOCOL_ERROR = 'WORKER_IPC_PROTOCOL_ERROR',
  WORKER_RESPONSE_SCHEMA_INVALID = 'WORKER_RESPONSE_SCHEMA_INVALID',

  // --- 和弦分析 ---
  CHORD_ANALYSIS_FAILED = 'CHORD_ANALYSIS_FAILED',
  CHORD_ANALYSIS_TIMEOUT = 'CHORD_ANALYSIS_TIMEOUT',
  CHORD_VOCABULARY_INCOMPATIBLE = 'CHORD_VOCABULARY_INCOMPATIBLE',
  CHORD_INPUT_INSUFFICIENT = 'CHORD_INPUT_INSUFFICIENT',

  // --- 播放器 ---
  PLAYBACK_LOAD_FAILED = 'PLAYBACK_LOAD_FAILED',
  PLAYBACK_DECODE_ERROR = 'PLAYBACK_DECODE_ERROR',
  PLAYBACK_SYNC_DRIFT = 'PLAYBACK_SYNC_DRIFT',

  // --- 导出 ---
  EXPORT_TRANSCODE_FAILED = 'EXPORT_TRANSCODE_FAILED',
  EXPORT_FILE_EXISTS = 'EXPORT_FILE_EXISTS',
  EXPORT_CANCELLED = 'EXPORT_CANCELLED',

  // --- 导入 ---
  IMPORT_MAPPING_CONFLICT = 'IMPORT_MAPPING_CONFLICT',
  IMPORT_NO_VALID_FILES = 'IMPORT_NO_VALID_FILES',
  IMPORT_NAME_UNRECOGNIZED = 'IMPORT_NAME_UNRECOGNIZED',

  // --- 数据库 ---
  DB_CONNECTION_FAILED = 'DB_CONNECTION_FAILED',
  DB_MIGRATION_FAILED = 'DB_MIGRATION_FAILED',
  DB_QUERY_FAILED = 'DB_QUERY_FAILED',

  // --- 通用 ---
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  TASK_CANCELLED = 'TASK_CANCELLED',
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',
}

// ============================================================================
// 2. 结构化错误类（规格文档 §25.2）
// ============================================================================

/**
 * 应用级统一错误
 *
 * 使用方式：
 * - 在 Application Service / Domain 层抛出或返回
 * - 在 IPC 边界层统一捕获并序列化
 * - UI 层只读取 userMessage 做友好显示
 */
export class AppError extends Error {
  /** 统一错误码 */
  readonly code: ErrorCode;
  /** 面向用户的友好提示 */
  readonly userMessage: string;
  /** 结构化上下文信息（projectId、filePath 等） */
  readonly context: Record<string, unknown>;
  /** 是否可重试 */
  readonly retryable: boolean;
  /** 原始错误（链式追溯） */
  readonly cause?: Error;

  constructor(params: {
    code: ErrorCode;
    message: string;
    userMessage: string;
    context?: Record<string, unknown>;
    retryable?: boolean;
    cause?: Error;
  }) {
    super(params.message);
    this.name = 'AppError';
    this.code = params.code;
    this.userMessage = params.userMessage;
    this.context = params.context ?? {};
    this.retryable = params.retryable ?? false;
    this.cause = params.cause;

    // 保持正确的原型链
    Object.setPrototypeOf(this, AppError.prototype);
  }

  /** 序列化为可通过 IPC 传输的纯对象 */
  toJSON(): SerializedAppError {
    return {
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      context: this.context,
      retryable: this.retryable,
      cause: this.cause?.message ?? null,
    };
  }

  /** 从 IPC 传输的纯对象反序列化 */
  static fromJSON(json: SerializedAppError): AppError {
    return new AppError({
      code: json.code,
      message: json.message,
      userMessage: json.userMessage,
      context: json.context,
      retryable: json.retryable,
      cause: json.cause ? new Error(json.cause) : undefined,
    });
  }
}

/** IPC 可传输的错误结构 */
export interface SerializedAppError {
  code: ErrorCode;
  message: string;
  userMessage: string;
  context: Record<string, unknown>;
  retryable: boolean;
  cause: string | null;
}

// ============================================================================
// 3. 错误码分类查询工具
// ============================================================================

/** 判断错误码是否属于用户可重试的类别 */
export function isRetryableError(code: ErrorCode): boolean {
  const retryableCodes: ReadonlySet<ErrorCode> = new Set([
    ErrorCode.ENGINE_TIMEOUT,
    ErrorCode.WORKER_IPC_TIMEOUT,
    ErrorCode.WORKER_HEALTH_CHECK_FAILED,
    ErrorCode.DISK_NO_SPACE,
    ErrorCode.CHORD_ANALYSIS_TIMEOUT,
    ErrorCode.DB_CONNECTION_FAILED,
  ]);
  return retryableCodes.has(code);
}

/** 判断错误码是否属于用户需要主动介入的类别 */
export function requiresUserAction(code: ErrorCode): boolean {
  const userActionCodes: ReadonlySet<ErrorCode> = new Set([
    ErrorCode.INPUT_UNSUPPORTED_FORMAT,
    ErrorCode.IMPORT_MAPPING_CONFLICT,
    ErrorCode.CACHE_CORRUPTED,
    ErrorCode.DISK_NO_SPACE,
    ErrorCode.DISK_PERMISSION_DENIED,
  ]);
  return userActionCodes.has(code);
}

// ============================================================================
// 4. UI 错误通知载荷（GPT Round-1 Must Fix #4）
// ============================================================================

/**
 * 统一错误通知事件 — 从边界层抛向 UI 的标准载荷
 *
 * Why: 规格文档 §25.2 要求关键错误通过事件总线或统一通知中心抛给 UI 层，
 *      UI 层只负责友好提示和恢复入口，不直接处理底层异常对象。
 *
 * 使用规则：
 * - IPC 边界层捕获 AppError 后，封装为 ErrorNotification 发送到 renderer
 * - Renderer 只消费 userMessage + recoveryActions，不解析底层 context
 * - recoveryActions 定义了用户可执行的恢复操作（如"重试"、"打开缓存目录"）
 */
export interface ErrorNotification {
  /** 通知唯一 ID */
  id: string;
  /** 序列化后的错误信息 */
  error: SerializedAppError;
  /** 通知时间戳 */
  timestamp: number;
  /** 是否已被用户 dismiss */
  dismissed: boolean;
  /** 用户可执行的恢复操作列表 */
  recoveryActions: RecoveryAction[];
  /** 通知严重级别 */
  severity: ErrorSeverity;
}

/** 恢复操作 */
export interface RecoveryAction {
  /** 操作标识（如 'retry' | 'openCacheDir' | 'dismiss'） */
  actionId: string;
  /** 面向用户的操作标签 */
  label: string;
}

/** 错误严重级别 */
export enum ErrorSeverity {
  /** 信息提示，无需用户处理 */
  Info = 'info',
  /** 警告，功能部分受损 */
  Warning = 'warning',
  /** 错误，当前操作失败 */
  Error = 'error',
  /** 致命，应用功能严重受损 */
  Fatal = 'fatal',
}
