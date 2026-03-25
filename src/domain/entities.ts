/**
 * @module domain/entities
 * @description 领域实体、值对象、Manifest 结构与业务规则字典
 *
 * Why: GPT Round-1 Must Fix #1 要求把领域实体从 shared/types.ts 迁回 domain 层。
 *      规格文档 §26.2 要求 shared/contracts 只保留跨层最小公共集合。
 *
 * 数据职责分工（GPT Suggested #4）：
 * - ProjectManifest 是项目级事实来源（磁盘文件），记录 stems、waveform、chord 的存在性
 * - SQLite 是全局索引（db/schema.ts），记录 Project 摘要、指纹查找、最近访问排序
 * - 当 manifest 与 SQLite 冲突时，以 manifest 为准触发索引重建
 *
 * 本文件不依赖 Node.js / Electron / 文件系统 API（ADR-009/010）。
 *
 * GPT Round-2 Must Fix #1 拆分：
 * - 状态机 → domain/stateMachines.ts
 * - 业务策略（轨道别名、指纹策略） → domain/policies.ts
 * - 本文件只保留纯数据结构定义
 */

import {
  ProjectSourceType,
  ProjectStatus,
  JobStatus,
  JobStage,
  StemStatus,
  StemType,
  AudioExportFormat,
  LogLevel,
  ChordAnalysisSource,
  ChordAnalyzerType,
  CacheEntryStatus,
} from '../shared/enums';

// ============================================================================
// 1. 核心实体（规格文档 §10）
// ============================================================================

/**
 * 项目实体 — 统一事实模型
 *
 * Why（ADR-005）：自动分离与手动导入使用同一结构。
 * 两种来源都必须生成稳定指纹、manifest、SQLite 索引，可复用 waveform / chord 结果。
 *
 * 数据归属：
 * - id, fingerprint, sourceType, displayName, status → SQLite 索引 + manifest 双写
 * - originalFilePath, cacheDir → manifest 为准（SQLite 冗余索引）
 * - durationMs, sampleRate, channels, totalSizeBytes → manifest 为准
 * - schemaVersion, engineVersion → manifest 为准，SQLite 校验用
 * - createdAt, updatedAt → SQLite 排序用，manifest 记录用
 */
export interface Project {
  readonly id: string;
  /** 基于文件内容的稳定指纹（hash + 文件长度 + 可选元数据），不依赖文件名 */
  fingerprint: string;
  sourceType: ProjectSourceType;
  displayName: string;
  /** 原始音频路径；手动导入时为 null */
  originalFilePath: string | null;
  /** 项目缓存目录绝对路径 */
  cacheDir: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  durationMs: number | null;
  separationElapsedMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  totalSizeBytes: number;
  status: ProjectStatus;
  /** manifest schema 版本，缓存兼容性检查 */
  schemaVersion: string;
  /** 分离引擎版本，缓存兼容性检查 */
  engineVersion: string | null;
  /** 缓存条目状态（含软删除标记） */
  cacheStatus: CacheEntryStatus;
}

/**
 * 轨道文件实体
 *
 * Why: 自动分离的输出和手动导入的文件都归一化为此结构（ADR-005）。
 *      前端不直接读取本结构，而是通过 DTO 投影（shared/contracts.ts）。
 *
 * 数据归属：manifest 为准，SQLite 做按项目查询索引
 */
export interface StemFile {
  readonly id: string;
  projectId: string;
  stemType: StemType;
  /** 绝对文件路径 */
  filePath: string;
  codec: string;
  sizeBytes: number;
  durationMs: number | null;
  sampleRate: number | null;
  exists: boolean;
  sourceOrigin: StemSourceOrigin;
  /** 识别置信度（0-1），手动导入时为 1.0 */
  confidence: number | null;
  exportable: boolean;
  status: StemStatus;
  modelId?: string;
  runtimeProfileId?: string;
  jobId?: string;
  parentResultId?: string;
  sourceSignature?: string;
  sourceKind?: string;
  selectionReason?: string;
  fallbackUsed?: boolean;
  sourceResultSetId?: string;
}

/** 轨道来源 — 值对象 */
export type StemSourceOrigin = 'engine_output' | 'manual_import';

/**
 * 解析任务实体（规格文档 §10）
 *
 * 数据归属：SQLite 为主（任务是运行态数据，不在 manifest 中持久化）
 */
export interface ParseJob {
  readonly id: string;
  projectId: string;
  stage: JobStage;
  /** 0-100 */
  progress: number;
  startedAt: number | null;
  finishedAt: number | null;
  elapsedMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  engineVersion: string | null;
  cancelledByUser: boolean;
  status: JobStatus;
}

/** 波形数据引用 — 数据归属：manifest 为准 */
export interface WaveformData {
  projectId: string;
  waveformPath: string;
  peaksPath: string | null;
  version: string;
  generatedAt: number;
}

/**
 * 和弦片段 — 值对象
 */
export interface ChordSegment {
  startMs: number;
  endMs: number;
  chordLabel: string;
  confidence: number;
  simplifiedLabel: string | null;
  sourceFlags: string[];
}

/**
 * 和弦分析结果
 *
 * Why（ADR-006）：
 * - chord analysis 不是分离成功的前置完成条件
 * - chord 失败只记录 warnings，不把项目从 ready 拉回 failed
 * - analysisVersion / vocabularyVersion 独立校验，不与 stem 缓存绑定
 *
 * 数据归属：manifest 记录 path/version，分析结果 JSON 文件单独落盘
 */
export interface ChordAnalysisResult {
  projectId: string;
  analysisVersion: string;
  analyzerType: ChordAnalyzerType;
  /** 缓存命中时必须检查此版本兼容性（规格文档 §22.7） */
  vocabularyVersion: string;
  analysisSource: ChordAnalysisSource;
  elapsedMs: number;
  generatedAt: number;
  segments: ChordSegment[];
  warnings: string[];
}

/**
 * 播放预设（可选持久化） — 数据归属：SQLite
 */
export interface PlaybackPreset {
  projectId: string;
  masterVolume: number;
  speed: number;
  perStemVolume: Record<StemType, number>;
  muteState: Record<StemType, boolean>;
  soloState: Record<StemType, boolean>;
  lastPositionMs: number;
}

/**
 * 应用全局设置（规格文档 §10） — 数据归属：SQLite app_settings 表
 */
export interface AppSettings {
  cacheRoot: string;
  defaultExportFormat: AudioExportFormat;
  maxParallelJobs: number;
  autoOpenLastProject: boolean;
  logLevel: LogLevel;
}

// ============================================================================
// 2. Manifest 结构（规格文档 §11）
// ============================================================================

/**
 * 项目级 manifest — 项目级事实来源
 *
 * Why: 规格文档 §11 要求 manifest 作为项目级事实来源，数据库做全局索引。
 *
 * 字段职责说明（GPT Suggested #4）：
 * - projectId, fingerprint, sourceType: 唯一标识，manifest 与 SQLite 双写
 * - schemaVersion, engineVersion: 缓存兼容性判定，manifest 为准
 * - stems[]: 轨道文件清单，manifest 为准（SQLite 做按项目查询索引）
 * - waveform, chordAnalysis: 分析结果引用，manifest 为准
 * - createdAt, updatedAt: 时间戳，manifest 记录，SQLite 用于排序
 *
 * 当 manifest 与 SQLite 不一致时：以 manifest 为准触发 SQLite 索引重建。
 */
export interface ProjectManifest {
  projectId: string;
  fingerprint: string;
  sourceType: ProjectSourceType;
  schemaVersion: string;
  engineVersion: string | null;
  createdAt: number;
  updatedAt: number;
  displayName?: string;
  lastAccessedAt?: number | null;
  durationMs?: number | null;
  separationElapsedMs?: number | null;
  activeResultId?: string;
  resultSets?: ManifestResultSetEntry[];
  stems: ManifestStemEntry[];
  waveform: {
    path: string;
    version: string;
    parentResultId?: string;
    sourceSignature?: string;
  } | null;
  /** 和弦分析引用，版本独立校验（ADR-006） */
  chordAnalysis: {
    path: string;
    analysisVersion: string;
    vocabularyVersion: string;
    parentResultId?: string;
    sourceSignature?: string;
  } | null;
}

export interface ManifestResultSetEntry {
  id: string;
  modelId: string;
  runtimeProfileId: string;
  sourceSignature: string;
  createdAt: number;
}

/** Manifest 中的轨道条目 — 值对象 */
export interface ManifestStemEntry {
  stemType: StemType;
  /** 相对于项目缓存目录的路径 */
  relativePath: string;
  codec: string;
  sizeBytes: number;
  durationMs?: number | null;
  sampleRate?: number | null;
  sourceOrigin: StemSourceOrigin;
  modelId?: string;
  runtimeProfileId?: string;
  jobId?: string;
  parentResultId?: string;
  sourceSignature?: string;
  sourceKind?: string;
  selectionReason?: string;
  fallbackUsed?: boolean;
  sourceResultSetId?: string;
}

// ============================================================================
// 3. 重导出（向后兼容）
// ============================================================================

/**
 * 状态机和业务策略已迁移：
 * - 状态机转移规则 → domain/stateMachines.ts
 * - 轨道别名 / 指纹策略 → domain/policies.ts
 *
 * 为了向后兼容，此处重导出核心 symbol。
 * 新代码应直接从 stateMachines.ts / policies.ts 导入。
 */
export {
  PROJECT_STATUS_TRANSITIONS,
  JOB_STATUS_TRANSITIONS,
  isValidProjectTransition,
  isValidJobTransition,
} from './stateMachines';

export {
  STEM_NAME_ALIASES,
  inferStemTypeFromFilename,
} from './policies';
