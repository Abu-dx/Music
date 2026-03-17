/**
 * @module shared/logger
 * @description 分级日志系统接口与默认实现
 *
 * 设计原则（规格文档 §25.3）：
 * - 分级日志：Trace / Debug / Info / Warn / Error
 * - 关键链路必须带上下文：projectId、jobId、filePath、stage、elapsedMs、engineVersion
 * - 日志可按项目导出，便于用户反馈问题
 * - 禁止把敏感路径、过长堆栈或二进制内容直接无控制输出到 UI
 *
 * DI 约束（ADR-008）：
 * 此文件定义接口，具体实现由 composition root 注入。
 * Application / Domain 层默认不直接 new 日志实现。
 */

import { LogLevel } from './enums';

// ============================================================================
// 1. 日志上下文
// ============================================================================

/** 日志结构化上下文 */
export interface LogContext {
  /** 当前项目 ID */
  projectId?: string;
  /** 当前任务 ID */
  jobId?: string;
  /** 相关文件路径（注意：日志输出时应脱敏，不暴露完整用户路径到 UI） */
  filePath?: string;
  /** 当前阶段 */
  stage?: string;
  /** 耗时（毫秒） */
  elapsedMs?: number;
  /** 引擎版本 */
  engineVersion?: string;
  /** 其他自由键值 */
  [key: string]: unknown;
}

// ============================================================================
// 2. 日志记录 Schema（稳定结构，Must Fix #3）
// ============================================================================

/**
 * 持久化日志条目 — 标准 schema
 *
 * Why: GPT Round-1 Must Fix #3 要求日志记录结构有稳定 schema，
 *      支持按项目导出和后续分析。
 */
export interface LogEntry {
  /** 日志时间戳（ISO 8601） */
  timestamp: string;
  /** 日志级别 */
  level: LogLevel;
  /** 日志消息 */
  message: string;
  /** 结构化上下文 */
  context: LogContext;
  /** 错误信息（如有） */
  error?: string;
  /** 错误堆栈摘要（前 5 行） */
  stackSummary?: string;
}

/**
 * 日志导出结果
 */
export interface LogExportResult {
  /** 导出的日志条目数 */
  entryCount: number;
  /** 导出文件路径 */
  exportPath: string;
  /** 导出的项目 ID */
  projectId: string;
  /** 导出时间范围 */
  timeRange: { from: string; to: string };
}

// ============================================================================
// 3. 日志导出接口（Must Fix #3）
// ============================================================================

/**
 * 日志导出服务接口
 *
 * Why: 规格文档 §25.3 要求日志可按项目导出，便于用户反馈问题。
 *      GPT Round-1 Must Fix #3 要求把"可导出"补成接口要求。
 *      具体实现由 infrastructure/logging 层提供，通过 DI 注入。
 */
export interface ILogExportService {
  /**
   * 按项目 ID 导出日志
   *
   * @param projectId - 目标项目 ID
   * @param outputDir - 可选的导出目录；默认为项目缓存目录下的 logs/
   * @returns 导出结果
   */
  exportProjectLogs(projectId: string, outputDir?: string): Promise<LogExportResult>;
}

// ============================================================================
// 4. Logger 接口（DI 友好）
// ============================================================================

/**
 * Logger 接口
 *
 * 所有模块通过此接口记录日志，不直接依赖 console 或具体日志库。
 * 由 composition root 在启动时注入具体实现。
 */
export interface ILogger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: Error | null, context?: LogContext): void;

  /** 创建带有预设上下文的子 Logger */
  child(defaultContext: LogContext): ILogger;
}

// ============================================================================
// 3. 默认控制台实现（开发阶段使用，后续替换为文件/持久化实现）
// ============================================================================

/** 日志级别优先级映射 */
const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  [LogLevel.Trace]: 0,
  [LogLevel.Debug]: 1,
  [LogLevel.Info]: 2,
  [LogLevel.Warn]: 3,
  [LogLevel.Error]: 4,
};

/**
 * 控制台日志实现
 *
 * 仅用于开发阶段和骨架验证。生产环境应替换为
 * 支持文件写入、按项目导出、日志轮转的实现。
 */
export class ConsoleLogger implements ILogger {
  private readonly minLevel: LogLevel;
  private readonly defaultContext: LogContext;

  constructor(minLevel: LogLevel = LogLevel.Info, defaultContext: LogContext = {}) {
    this.minLevel = minLevel;
    this.defaultContext = defaultContext;
  }

  trace(message: string, context?: LogContext): void {
    this.log(LogLevel.Trace, message, undefined, context);
  }

  debug(message: string, context?: LogContext): void {
    this.log(LogLevel.Debug, message, undefined, context);
  }

  info(message: string, context?: LogContext): void {
    this.log(LogLevel.Info, message, undefined, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log(LogLevel.Warn, message, undefined, context);
  }

  error(message: string, error?: Error | null, context?: LogContext): void {
    this.log(LogLevel.Error, message, error ?? undefined, context);
  }

  child(defaultContext: LogContext): ILogger {
    return new ConsoleLogger(this.minLevel, {
      ...this.defaultContext,
      ...defaultContext,
    });
  }

  // --- Internal ---

  private log(level: LogLevel, message: string, error?: Error, context?: LogContext): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const merged = { ...this.defaultContext, ...context };
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

    // 构造上下文字符串（过滤 undefined）
    const ctxEntries = Object.entries(merged).filter(([, v]) => v !== undefined);
    const ctxStr = ctxEntries.length > 0
      ? ` ${JSON.stringify(Object.fromEntries(ctxEntries))}`
      : '';

    const logLine = `${prefix} ${message}${ctxStr}`;

    switch (level) {
      case LogLevel.Trace:
      case LogLevel.Debug:
        console.debug(logLine);
        break;
      case LogLevel.Info:
        console.info(logLine);
        break;
      case LogLevel.Warn:
        console.warn(logLine);
        break;
      case LogLevel.Error:
        console.error(logLine);
        if (error) {
          // 只输出 message + 前 5 行堆栈，避免过长（规格文档 §25.3）
          const stackLines = error.stack?.split('\n').slice(0, 6).join('\n');
          console.error(`  Cause: ${error.message}\n${stackLines ?? ''}`);
        }
        break;
    }
  }
}
