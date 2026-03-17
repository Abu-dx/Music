/**
 * @module shared/enums
 * @description 全局枚举集中定义
 *
 * Why: 规格文档 §25.1 要求事件名、错误码、配置键、任务状态枚举必须统一命名规则并集中定义。
 *      GPT Round-1 Must Fix #1 要求把枚举从大一统 types.ts 分离出来。
 *
 * 边界: 本文件只包含枚举定义，不包含 interface / class / 常量字典。
 *       所有层（renderer / application / domain / infrastructure）均可导入本文件。
 */

// ============================================================================
// 项目与任务生命周期
// ============================================================================

/** 项目来源类型 — 自动分离与手动导入统一入口 */
export enum ProjectSourceType {
  /** 用户上传原始音频后自动分离 */
  Separation = 'separation',
  /** 用户手动导入已有分轨 */
  ManualImport = 'manual_import',
  /** 缓存命中直接加载 */
  CacheHit = 'cache_hit',
}

/**
 * 项目生命周期状态（规格文档 §9 状态机）
 * draft -> scanning -> cache_hit | ready_to_parse | importing -> processing -> ready | failed | cancelled
 */
export enum ProjectStatus {
  Draft = 'draft',
  Scanning = 'scanning',
  CacheHit = 'cache_hit',
  ReadyToParse = 'ready_to_parse',
  Importing = 'importing',
  Processing = 'processing',
  Ready = 'ready',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

/**
 * 解析任务状态（规格文档 §9）
 * pending -> running -> success | failed | cancelled
 */
export enum JobStatus {
  Pending = 'pending',
  Running = 'running',
  Success = 'success',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

/**
 * 解析任务阶段（规格文档 §16 进度系统）
 * 百分比区间为建议值，不要求绝对精确，但必须连续可信
 */
export enum JobStage {
  /** 0% - 5% */
  Init = 'INIT',
  /** 5% - 10% */
  ReadSource = 'READ_SOURCE',
  /** 10% - 20% */
  Preprocess = 'PREPROCESS',
  /** 20% - 80%（允许估算进度） */
  Infer = 'INFER',
  /** 80% - 88% */
  Postprocess = 'POSTPROCESS',
  /** 88% - 94% */
  WriteFiles = 'WRITE_FILES',
  /** 94% - 97% */
  BuildIndex = 'BUILD_INDEX',
  /** 97% - 99% */
  GenerateWaveform = 'GENERATE_WAVEFORM',
  /** 子任务：和弦识别（不阻塞主链路，ADR-006） */
  ChordAnalysis = 'CHORD_ANALYSIS',
  /** 100% */
  Done = 'DONE',
}

// ============================================================================
// 轨道与音频
// ============================================================================

/** 轨道状态（规格文档 §9） */
export enum StemStatus {
  Missing = 'missing',
  Detected = 'detected',
  Exported = 'exported',
  Invalid = 'invalid',
}

/** 目标轨道类型（规格文档 §8） */
export enum StemType {
  Vocal = 'vocal',
  Drums = 'drums',
  Bass = 'bass',
  Guitar = 'guitar',
  Keyboard = 'keyboard',
  Synth = 'synth',
  /** 模型输出但未匹配到目标轨时的兜底 */
  Other = 'other',
}

/** 支持的输入音频格式（规格文档 §4 白名单） */
export enum AudioInputFormat {
  WAV = 'wav',
  MP3 = 'mp3',
  FLAC = 'flac',
  M4A = 'm4a',
}

/** 支持的导出格式（规格文档 §5.9） */
export enum AudioExportFormat {
  WAV = 'wav',
  AAC = 'aac',
  MP3 = 'mp3',
}

// ============================================================================
// 播放器
// ============================================================================

/**
 * 播放器会话状态（规格文档 §9）
 * idle -> loading -> playing | paused | ended | error
 */
export enum PlaybackStatus {
  Idle = 'idle',
  Loading = 'loading',
  Playing = 'playing',
  Paused = 'paused',
  Ended = 'ended',
  Error = 'error',
}

/** 播放速度预设（规格文档 §5.8） */
export enum PlaybackSpeed {
  Half = 0.5,
  ThreeQuarter = 0.75,
  Normal = 1.0,
  OneAndQuarter = 1.25,
  OneAndHalf = 1.5,
  Double = 2.0,
}

// ============================================================================
// 和弦分析
// ============================================================================

/** 和弦分析来源（规格文档 §22.3） */
export enum ChordAnalysisSource {
  Mixed = 'mixed',
  HarmonicMix = 'harmonic_mix',
  SelectedStems = 'selected_stems',
  FallbackSource = 'fallback_source',
}

/** 和弦分析器类型（规格文档 §22.4） */
export enum ChordAnalyzerType {
  RuleBased = 'rule_based',
  ML = 'ml',
}

// ============================================================================
// Worker IPC
// ============================================================================

/**
 * Worker IPC 消息类型（规格文档 §24.4）
 * 收敛为三类消息，避免协议失控
 */
export enum WorkerMessageType {
  Request = 'request',
  Response = 'response',
  Event = 'event',
}

/** Worker 可接收的命令 */
export enum WorkerCommand {
  StartSeparation = 'start_separation',
  CancelTask = 'cancel_task',
  HealthCheck = 'health_check',
  ExecuteChordAnalysis = 'execute_chord_analysis',
  GenerateWaveform = 'generate_waveform',
  Transcode = 'transcode',
}

/** Worker 可发出的事件 */
export enum WorkerEventName {
  StageProgress = 'stage_progress',
  LogSummary = 'log_summary',
  StatusChange = 'status_change',
}

// ============================================================================
// 基础设施与系统
// ============================================================================

/** 日志级别（规格文档 §25.3） */
export enum LogLevel {
  Trace = 'trace',
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

/**
 * 缓存条目状态
 * 含软删除标记，满足删除与恢复策略
 */
export enum CacheEntryStatus {
  Active = 'active',
  MarkedForDeletion = 'marked_for_deletion',
  Corrupted = 'corrupted',
  /** 失败项目隔离存放，不污染正式缓存（规格文档 §5.11） */
  FailedIsolated = 'failed_isolated',
}
