/**
 * @module shared/contracts
 * @description 跨层共享的最小公共 contract 集合
 *
 * Why: 规格文档 §26.2 要求 shared/contracts 是跨层共享的最小公共集合，
 *      避免把整个 domain 暴露到 renderer。
 *      GPT Round-1 Must Fix #1 要求从大一统 types.ts 中拆出本文件。
 *
 * 本文件只包含：
 * - Worker IPC 消息结构（跨进程传输 DTO）
 * - 状态变更追踪协议（Must Fix #2）
 * - Store 所有权类型声明（renderer 需要感知的最小 store shape）
 * - Worker schema 校验类型（Must Fix #6）
 *
 * 领域实体（Project, StemFile, ParseJob 等）不在此文件中，
 * 它们位于 domain/entities.ts，renderer 通过 DTO 间接获取。
 */

import {
  WorkerMessageType,
  WorkerCommand,
  WorkerEventName,
  PlaybackStatus,
  StemType,
} from './enums';

// ============================================================================
// 1. Worker IPC DTO（跨进程传输，规格文档 §24.4）
// ============================================================================

/** Worker 请求 */
export interface WorkerRequest {
  type: WorkerMessageType.Request;
  id: string;
  command: WorkerCommand;
  payload: Record<string, unknown>;
}

/** Worker 响应 */
export interface WorkerResponse {
  type: WorkerMessageType.Response;
  id: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: WorkerErrorPayload;
}

/** Worker 事件 */
export interface WorkerEvent {
  type: WorkerMessageType.Event;
  eventName: WorkerEventName;
  payload: Record<string, unknown>;
}

/** Worker 消息联合类型 */
export type WorkerMessage = WorkerRequest | WorkerResponse | WorkerEvent;

/**
 * Worker 错误载荷
 * Why: GPT Round-1 Must Fix #6 要求为 Worker 返回预留 schema 校验类型
 */
export interface WorkerErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// ============================================================================
// 2. Worker Schema 校验（Must Fix #6）
// ============================================================================

/**
 * 经过 schema 校验的 Worker 响应包装
 *
 * Why: 规格文档 §25.5 要求对 Worker 返回值与第三方库输出做 schema 校验，
 *      不接受"相信它永远正确"。
 *      所有 Worker response/event 在进入 application 层前必须经此结构包装。
 *
 * ADR-011 声明此规则不可回退。
 */
export interface ValidatedWorkerResponse<T> {
  /** 校验是否通过 */
  valid: boolean;
  /** 校验通过时的类型安全数据 */
  data?: T;
  /** 校验失败时的详细信息 */
  validationErrors?: SchemaValidationFailure[];
}

/** Schema 校验失败上下文 */
export interface SchemaValidationFailure {
  /** 失败字段路径，如 "data.segments[0].startMs" */
  fieldPath: string;
  /** 期望类型或约束 */
  expected: string;
  /** 实际收到的值描述 */
  received: string;
  /** 诊断消息 */
  message: string;
}

// ============================================================================
// 3. 状态变更追踪协议（Must Fix #2）
// ============================================================================

/**
 * 领域事件 — 所有关键状态变更的记录结构
 *
 * Why: 规格文档 §24.3 要求所有状态变更通过 action/command 进入，
 *      关键状态变更可追踪、可记录、可回放。
 *      GPT Round-1 Must Fix #2 要求此 contract 在骨架阶段定下来。
 *
 * 使用规则：
 * - Store 层只能经 action/command 触发状态变更
 * - 每次状态变更必须生成一条 DomainEvent
 * - 跨域变更必须经 Application Service 编排，不允许一个 action 直接改写多 store
 */
export interface DomainEvent {
  /** 事件唯一 ID */
  readonly eventId: string;
  /** 实体类型：'project' | 'job' | 'playback' | 'analysis' | 'settings' */
  readonly entityType: string;
  /** 实体 ID */
  readonly entityId: string;
  /** 动作名称，如 'statusChanged' | 'volumeAdjusted' | 'jobStarted' */
  readonly action: string;
  /** 变更前状态（可选，某些新增操作无 from） */
  readonly fromState?: string;
  /** 变更后状态 */
  readonly toState: string;
  /** 事件时间戳（毫秒） */
  readonly timestamp: number;
  /**
   * 关联 ID — 用于把同一用例编排中的多个事件串联
   * 例如：一次 "startParse" 会同时变更 Project 和 Job 状态，
   * 这两个 DomainEvent 共享同一个 correlationId
   */
  readonly correlationId: string;
  /** 额外载荷 */
  readonly payload?: Record<string, unknown>;
}

/**
 * 状态转移记录 — 持久化审计用
 *
 * Why: 支持状态机调试、回放、审计
 */
export interface StateTransitionRecord {
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly timestamp: number;
  readonly correlationId: string;
  readonly metadata?: Record<string, unknown>;
}

// ============================================================================
// 4. Store 所有权类型（renderer 需感知的最小 shape）
// ============================================================================

/**
 * 以下 Store State 类型只包含 renderer 渲染所需的最小字段。
 * 它们是 domain 实体的"投影"，不是实体本身。
 *
 * Why: ADR-003 禁止 renderer 直接访问 domain 实体的完整结构，
 *      ADR-004 要求四类 store 所有权严格隔离。
 */

/** 项目摘要 — renderer 可见的项目信息投影 */
export interface ProjectSummaryDTO {
  id: string;
  displayName: string;
  sourceType: string;
  status: string;
  durationMs: number | null;
  totalSizeBytes: number;
  stemCount: number;
  updatedAt: number;
}

/** projectStore 所有权：只持有 Project 生命周期状态与当前项目元数据 */
export interface ProjectStoreState {
  currentProject: ProjectSummaryDTO | null;
  recentProjects: ProjectSummaryDTO[];
  isLoading: boolean;
}

/** jobStore 所有权：只持有后台任务状态、阶段进度、取消/失败信息 */
export interface JobStoreState {
  currentJobId: string | null;
  stage: string | null;
  progress: number;
  isRunning: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

/** 单轨播放状态（含 solo/mute 派生） */
export interface StemPlaybackState {
  stemType: StemType;
  exists: boolean;
  volume: number;
  muted: boolean;
  soloed: boolean;
  /** 由计算层统一得出，不由 UI 直接覆写（规格文档 §15） */
  effectiveGain: number;
}

/** playbackStore 所有权：只持有播放会话与派生控制态 */
export interface PlaybackStoreState {
  status: PlaybackStatus;
  currentPositionMs: number;
  durationMs: number;
  masterVolume: number;
  speed: number;
  stems: StemPlaybackState[];
}

/** analysisStore 所有权：只持有 chord / waveform 可视化状态 */
export interface AnalysisStoreState {
  hasChordResult: boolean;
  hasWaveformData: boolean;
  isAnalyzing: boolean;
  /** 当前和弦标签（由播放位置派生） */
  currentChordLabel: string | null;
}

// ============================================================================
// 5. 结果页 DTO（GPT R8 Must Fix #1, #3, #6）
// ============================================================================

/**
 * 轨道存在状态 — 区分已输出/缺失/合并三种展示态
 *
 * GPT R8 Suggested #2：显式区分，让缺轨容忍和合并说明在 UI 稳定展示。
 */
export type StemPresence = 'exists' | 'missing' | 'merged';

/**
 * 分轨展示 DTO — ResultPage + PlaybackStore 共用
 *
 * GPT R8 Must Fix #1, #3：正式闭环 stem 数据形状，
 * 包含路径（播放需要）、格式、存在态、合并来源。
 */
export interface StemTrackDTO {
  id: string;
  stemType: string;
  codec: string;
  sizeBytes: number;
  durationMs: number;
  sampleRate: number;
  /** 是否可导出 */
  exportable: boolean;
  /** 文件绝对路径（播放时转 file:// URL） */
  filePath: string;
  /** 最后修改时间戳 */
  lastModifiedAt: number | null;
  /** 轨道存在状态 */
  presence: StemPresence;
  /** 合并来源轨道名（presence='merged' 时有值） */
  mergedFrom: string[] | null;
  modelId?: string;
  runtimeProfileId?: string;
  jobId?: string;
  parentResultId?: string;
  sourceSignature?: string;
  sourceKind?: string;
}

/**
 * 项目结果摘要 DTO — ResultPage 项目级统计信息
 *
 * GPT R8 Must Fix #3, #6：扩展 ProjectSummaryDTO，
 * 包含 elapsedMs / cacheHit / 来源类型统一建模。
 */
export interface ProjectResultSummaryDTO extends ProjectSummaryDTO {
  /** 分离耗时（ms） */
  elapsedMs: number | null;
  /** 来自缓存 */
  cacheHit: boolean;
  /** 缓存命中时的 banner 文案（由 main 进程提供，页面只读展示） */
  cacheHitBannerText: string | null;
  /** 来源类型显示名（由 main 提供，如 "自动分离"/"手动导入"/"缓存命中"） */
  sourceTypeLabel: string;
  activeResultId?: string;
}

// ============================================================================
// 6. IPC 事件共享 DTO（从 stageMapping.ts 迁入，GPT R8 Decision #1）
// ============================================================================

/**
 * 分离进度事件 — main → renderer 推送
 */
export interface SeparationProgressDTO {
  jobId: string;
  stage: string;
  progress: number;
}

/**
 * 分离完成事件 — main → renderer 推送
 */
export interface SeparationCompleteDTO {
  jobId: string;
  projectId: string;
  success: boolean;
  errorMessage?: string;
  warnings?: string[];
  /** 是否为缓存命中（直接跳过分离） */
  cacheHit?: boolean;
}

/**
 * 分离启动结果 — renderer 调用 startSeparation 的返回
 */
export interface SeparationStartResultDTO {
  jobId: string;
  projectId: string;
  warnings: string[];
  /** 缓存命中时为 true，无需等待分离完成 */
  cacheHit: boolean;
}

/**
 * 文件选择 DTO — renderer 层受控文件信息
 *
 * GPT R7 Must Fix #4：页面层不应直接依赖 Electron File.path。
 */
export interface SelectedFileDTO {
  /** 文件绝对路径（由 preload bridge 填充） */
  path: string | null;
  /** 文件名 */
  name: string;
  /** 文件大小（字节） */
  size: number;
}

// ============================================================================
// 7. 播放器错误与波形 DTO（GPT R9 Must Fix #2）
// ============================================================================

/**
 * 播放器链路结构化错误 — 替代 string error
 *
 * GPT R9 Must Fix #2：播放器是主链路，必须与全局错误体系一致。
 * renderer-safe（不含 Node.js 特有类型）。
 */
export interface AudioEngineError {
  /** 错误码 — 复用 ErrorCode 或播放器专属码 */
  code: string;
  /** 技术消息 */
  message: string;
  /** 用户可见消息 */
  userMessage: string;
  /** 上下文 */
  context: {
    projectId?: string;
    trackId?: string;
    filePath?: string;
    operation?: string;
  };
  /** 是否可重试 */
  retryable: boolean;
}

/**
 * 漂移检测结构化告警 DTO — renderer-safe
 *
 * GPT R10 Must Fix #2：drift 检测必须进入结构化日志/告警链路，
 * 不得仅停留在 console.warn。
 *
 * 统一字段：projectId、trackIds、maxDriftMs、toleranceMs、corrected、currentTimeMs
 */
export interface DriftAlertDTO {
  /** 关联项目 ID */
  projectId: string;
  /** 参考轨道 ID */
  referenceTrackId: string;
  /** 偏移轨道 ID */
  driftedTrackId: string;
  /** 最大偏移量（ms） */
  maxDriftMs: number;
  /** 容忍阈值（ms） */
  toleranceMs: number;
  /** 是否已自动修正 */
  corrected: boolean;
  /** 发生时的播放位置（ms） */
  currentTimeMs: number;
  /** 告警时间戳 */
  timestamp: number;
}

/**
 * 主波形数据 DTO — 从 main 进程获取的预计算波形
 *
 * GPT R10 Must Fix #3：明确语义 —— 此 DTO 代表项目的"主波形"（master waveform），
 * 基于原始混合音频生成，而非每个 stem 分别生成。
 * PlayerPage 中的波形区域只显示主波形，不显示分轨波形。
 *
 * 如果 main 进程生成时基于多个 stem 合成（降级方案），
 * 仍然只产出一条 MasterWaveformDTO，语义不变。
 */
export interface MasterWaveformDTO {
  /** 标识 — 固定为 'master' 或原始音频文件 ID */
  id: string;
  /** 通道数（通常 1 = mono 混缩后） */
  channels: number;
  /** 采样点总数 */
  length: number;
  /** 每秒采样点数 */
  sampleRate: number;
  /** 归一化峰值数据（-1.0 ~ 1.0），按 channel 交错 */
  peaks: number[];
  /** 音频总时长（ms） */
  durationMs: number;
}

/**
 * 单轨播放控制状态 — playbackStore 管理
 *
 * Round 10：单轨音量 + mute + solo。
 * effectiveGain 由 store 计算层统一得出（规格文档 §15）。
 *
 * 与 StemTrackDTO 的关系：
 * - StemTrackDTO 是"结果数据"（不可变，由 main 进程 / projectStore 提供）
 * - StemPlaybackControlDTO 是"播放控制态"（可变，由 playbackStore 管理）
 * - 控制态不反写结果 DTO —— 两者严格只读/写分离，避免跨层污染。
 * - 两者通过 stemId 关联：StemPlaybackControlDTO.stemId === StemTrackDTO.id
 */
export interface StemPlaybackControlDTO {
  stemId: string;
  stemType: string;
  /** 单轨音量 0.0 ~ 1.0 */
  volume: number;
  /** 静音 */
  muted: boolean;
  /** 独奏 */
  soloed: boolean;
  /**
   * 最终增益 — 由 store 统一计算
   *
   * 规则：
   * - muted → 0
   * - 任何轨道 soloed && 本轨非 solo → 0
   * - 否则 → volume
   */
  effectiveGain: number;
}

// ============================================================================
// 9. 和弦分析 DTO（Round 11）
// ============================================================================

/**
 * 和弦片段 — 时间轴上的一段和弦标注
 *
 * 规格文档 §22：和弦识别结果以时间片段列表形式输出。
 * 每段和弦包含起止时间 + 和弦标签。
 *
 * 时间约束：
 * - startMs < endMs
 * - 相邻段 segments[i].endMs <= segments[i+1].startMs（允许间隙，不允许重叠）
 * - startMs >= 0, endMs <= 音频总时长
 */
export interface ChordCandidateDTO {
  label: string;
  confidence?: number;
  method?: string;
}

export interface TempoCandidateDTO {
  bpm: number;
  confidence?: number;
  relation?: string;
  method?: string;
}

export interface TempoAmbiguityDTO {
  isAmbiguous: boolean;
  halfTimeBpm?: number;
  doubleTimeBpm?: number;
  reason?: string;
}

export interface TempoAnalysisDTO {
  primaryBpm?: number;
  confidence?: number;
  method: string;
  candidates: TempoCandidateDTO[];
  ambiguity?: TempoAmbiguityDTO;
}

export interface ChordSegmentDTO {
  /** 起始时间（ms） */
  startMs: number;
  /** 结束时间（ms） */
  endMs: number;
  /**
   * 和弦标签 — 标准记法
   *
   * 示例：'C', 'Am', 'G7', 'Dm/F', 'N'（N = No Chord / 无和弦）
   * 由分析引擎输出，PlayerPage 直接展示。
   */
  label: string;
  /**
   * 简化标签 — 去除修饰的根音+性质（GPT R11 Must Fix #4）
   *
   * 示例：'C' → 'C', 'Am7' → 'Am', 'Dm/F' → 'Dm'
   * 用于时间轴缩放不足时的简化显示策略。
   */
  simplifiedLabel?: string;
  /**
   * 置信度 0.0 ~ 1.0（可选）
   *
   * 由 ML 模型输出；rule-based 模式下可省略。
   * PlayerPage 可据此调整显示样式（如低置信度灰显）。
   */
  confidence?: number;
  /**
   * 来源标记 — 标注该片段由哪些输入贡献（GPT R11 Must Fix #4）
   *
   * 示例：['mixed'], ['vocal', 'bass']
   * 可选，用于调试和诊断。
   */
  sourceFlags?: string[];
  symbol?: string;
  chordType?: string;
  bassNote?: string;
  extensions?: string[];
  alterations?: string[];
  omissions?: string[];
  candidates?: ChordCandidateDTO[];
  method?: string;
  vocabularyTag?: string;
}

/**
 * 和弦分析结果 — 完整的分析输出
 *
 * 规格文档 §22.3：分析来源可以是 mixed / harmonic_mix / selected_stems。
 * ADR-006：和弦分析不阻塞主链路（异步子任务）。
 *
 * 持有者：analysisStore
 * 消费者：PlayerPage（和弦时间轴） / ResultPage（摘要展示）
 */
export interface ChordAnalysisResultDTO {
  /** 关联项目 ID */
  projectId: string;
  /**
   * 分析来源（规格文档 §22.3）
   * 'mixed' | 'harmonic_mix' | 'selected_stems' | 'fallback_source'
   */
  source: string;
  /**
   * 分析器类型
   * 'rule_based' | 'ml'
   */
  analyzerType: string;
  analysisMethods?: {
    chordAnalyzer: string;
    tempoAnalyzer: string;
  };
  /** 和弦片段列表（按时间排序） */
  segments: ChordSegmentDTO[];
  /** 分析耗时（ms） */
  elapsedMs: number;
  /** 分析时间戳 */
  analyzedAt: number;
  /** 音频总时长（ms） — 与播放时长交叉校验用 */
  audioDurationMs: number;
  /**
   * 调性估计（可选）
   *
   * 示例：'C major', 'A minor'
   * 由分析引擎在有足够置信度时输出。
   */
  estimatedKey?: string;
  /** 估计 BPM（可选） */
  estimatedBpm?: number;
  tempo?: TempoAnalysisDTO;
  /**
   * 分析引擎版本（GPT R11 Must Fix #4）
   * 用于缓存兼容性校验 — 版本不匹配时应重新分析。
   */
  analysisVersion?: string;
  /**
   * 和弦词汇表版本（GPT R11 Must Fix #4）
   * 不同版本可能输出不同标签格式。
   */
  vocabularyVersion?: string;
  chordVocabulary?: {
    selected: string;
    supportsExtendedChords: boolean;
    supportedDescriptors: string[];
  };
  /**
   * 诊断警告（GPT R11 Must Fix #4, #5）
   *
   * 记录分析过程中的非致命问题：
   * - 低置信度片段比例过高
   * - 片段过碎（平均时长 < 阈值）
   * - 输入轨不足，回退到总轨分析
   * - 部分时间段无法识别
   *
   * analysisStore 持有，PlayerPage / ResultPage 只读展示。
   */
  warnings: string[];
  /**
   * 结果生成时间戳（GPT R11 Must Fix #4）
   * 可能与 analyzedAt 不同（如后处理延迟）。
   */
  generatedAt: number;
}

// ============================================================================
// 10. renderer-safe 统一错误基础 contract（GPT R12-Fix SG#4, MF#4）
// ============================================================================

/**
 * renderer-safe 基础错误 DTO — 所有 renderer 侧结构化错误的公共基础
 *
 * GPT R12-Fix SG#4：AudioEngineError / AnalysisErrorDTO / ExportErrorDTO /
 * CacheOperationErrorDTO 的共性字段抽取。
 *
 * 规则：
 * - UI 只消费 userMessage，详细 message + context 走日志摘要
 * - code 用于错误分类与 i18n 映射
 * - retryable 用于 UI 是否展示"重试"按钮
 * - context 至少包含 projectId + operation
 */
export interface BaseRendererErrorDTO {
  /** 错误码（用于分类与 i18n） */
  code: string;
  /** 技术消息（仅日志，不展示给用户） */
  message: string;
  /** 用户可见消息（UI 直接展示） */
  userMessage: string;
  /** 上下文（最少包含 projectId + operation） */
  context: {
    projectId?: string;
    operation?: string;
    [key: string]: unknown;
  };
  /** 是否可重试 */
  retryable: boolean;
}

/**
 * 和弦分析结构化错误 — 继承 BaseRendererErrorDTO
 *
 * GPT R11 Must Fix #3：不允许 string error。
 */
export interface AnalysisErrorDTO extends BaseRendererErrorDTO {
  context: {
    projectId?: string;
    source?: string;
    analyzerType?: string;
    operation?: string;
  };
}

// ============================================================================
// 11. 导出 DTO（Round 12 + 收尾修复 MF#2, MF#4）
// ============================================================================

/**
 * 导出格式枚举
 *
 * GPT R12-Fix SG#2：显式默认值 = 'wav'。
 * 当 UI 未提供 format 选择时，默认使用 wav（无损）。
 * 后续若 UI 增加格式下拉，只需修改 ExportRequestDTO.format 传参。
 */
export const EXPORT_DEFAULT_FORMAT: ExportFormat = 'wav';
export type ExportFormat = 'wav' | 'mp3' | 'aac';

/**
 * 导出请求 — 由 UI 发起
 *
 * GPT R12-Fix MF#2：单轨导出与全部导出共用同一个 request 结构。
 * - 单轨导出：stemIds = [singleId]
 * - 全部导出：stemIds = 全部可导出 stem ID 列表
 * - stemIds = [] 由 main 进程解释为"全部可导出轨道"
 */
export interface ExportRequestDTO {
  /** 项目 ID */
  projectId: string;
  /** 要导出的轨道 ID 列表（空 = 全部可导出轨道） */
  stemIds: string[];
  /**
   * 导出格式（默认 'wav'）
   * @default 'wav'
   * @see EXPORT_DEFAULT_FORMAT
   */
  format: ExportFormat;
  /** 目标目录（由用户通过文件选择器选择） */
  outputDir: string;
}

/**
 * 单轨导出结果
 *
 * GPT R12-Fix MF#2：增加结构化错误 + 状态枚举。
 */
export type ExportItemStatus = 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface ExportResultDTO {
  /** 关联项目 ID */
  projectId: string;
  /** 轨道 ID */
  stemId: string;
  /** 导出状态 */
  status: ExportItemStatus;
  /** 是否成功（便捷访问，等价 status === 'succeeded'） */
  success: boolean;
  /** 输出文件路径（成功时） */
  outputPath: string | null;
  /** 输出文件大小（字节，成功时） */
  outputSizeBytes: number | null;
  /**
   * 结构化错误（失败时）
   *
   * GPT R12-Fix MF#4：与 BaseRendererErrorDTO 对齐。
   * context 包含 projectId / stemId / exportFormat / filePath / elapsedMs。
   */
  error: ExportErrorDTO | null;
}

/**
 * 导出链路结构化错误 — renderer-safe
 *
 * GPT R12-Fix MF#4：继承 BaseRendererErrorDTO。
 */
export interface ExportErrorDTO extends BaseRendererErrorDTO {
  context: {
    projectId?: string;
    stemId?: string;
    exportFormat?: string;
    filePath?: string;
    operation?: string;
    /** 操作耗时（ms） */
    elapsedMs?: number;
  };
}

/**
 * 批量导出进度 — main → renderer 推送
 *
 * GPT R12-Fix MF#2：增加 cancelled 状态 + 取消语义。
 */
export interface ExportProgressDTO {
  projectId: string;
  /** 已完成数（含成功+失败+跳过） */
  completedCount: number;
  /** 总数 */
  totalCount: number;
  /** 当前正在处理的轨道 ID（null = 已全部完成或取消） */
  currentStemId: string | null;
  /** 是否已取消 */
  cancelled: boolean;
}

/**
 * 批量导出完成结果
 *
 * GPT R12-Fix MF#2：明确 succeeded[] / failed[] / skipped[] / cancelled 语义。
 *
 * 部分失败 contract：
 * - allSuccess = true 当且仅当所有 item 的 status === 'succeeded'
 * - failed 项可由 UI 提示用户重试（根据 ExportErrorDTO.retryable 判断）
 * - skipped 项表示轨道不可导出（missing/无文件路径）
 * - cancelled 表示用户主动取消，已完成的文件保留
 *
 * 取消语义：
 * - 用户取消后，已完成的导出文件不回滚（保留在 outputDir）
 * - 尚未开始的轨道标记 status = 'cancelled'
 * - main 进程收到取消信号后停止后续导出，但不中断正在进行的单轨
 */
export interface ExportBatchResultDTO {
  projectId: string;
  /** 全部单轨结果 */
  results: ExportResultDTO[];
  /** 按状态分类的 stemId 列表 — 便于 UI 分组展示 */
  succeededIds: string[];
  failedIds: string[];
  skippedIds: string[];
  cancelledIds: string[];
  /** 全部成功 */
  allSuccess: boolean;
  /** 是否被用户取消 */
  cancelled: boolean;
  /** 导出耗时（ms） */
  elapsedMs: number;
}

// ============================================================================
// 8. 支持的格式与阈值常量
// ============================================================================

/** 支持的输入格式白名单 */
export const SUPPORTED_INPUT_EXTENSIONS: readonly string[] = [
  '.wav', '.mp3', '.flac', '.m4a',
];

/** 默认大文件阈值（规格文档 §5.2） */
export const LARGE_FILE_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500MB
