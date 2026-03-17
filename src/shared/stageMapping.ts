/**
 * @module shared/stageMapping
 * @description 跨层共享的阶段映射、阶段显示名、IPC 事件 DTO
 *
 * GPT R7 Must Fix #2：从 application 层迁移到 shared 层，
 * 禁止 renderer import application 层常量。
 *
 * GPT R7 Suggested #4：IPC 事件 payload 统一成共享 DTO。
 *
 * 位置选择：独立文件而非 contracts.ts，因为阶段映射自成体系，
 * 放入 contracts.ts 会使其过长。规格文档 26.2 允许 shared 层
 * 包含多个文件，只要属于跨层最小公共集合。
 */

import { JobStage } from './enums';

// ============================================================================
// 1. 阶段映射表
// ============================================================================

/**
 * 阶段映射条目
 */
export interface StageMapping {
  /** 归一化的 JobStage 枚举值 */
  stage: JobStage;
  /** 建议最小进度百分比（规格文档 §16） */
  minProgress: number;
  /** 建议最大进度百分比 */
  maxProgress: number;
}

/**
 * Worker 上报的 stage 字符串 → 规格文档推荐的 JobStage + 百分比区间
 *
 * 规格文档 §16 进度系统：
 * - INIT: 0-5%
 * - READ_SOURCE: 5-10%
 * - PREPROCESS: 10-20%
 * - INFER: 20-80%
 * - POSTPROCESS: 80-88%
 * - WRITE_FILES: 88-94%
 * - BUILD_INDEX: 94-97%
 * - GENERATE_WAVEFORM: 97-99%
 * - DONE: 100%
 */
export const STAGE_PROGRESS_MAPPING: Record<string, StageMapping> = {
  'init':              { stage: JobStage.Init, minProgress: 0, maxProgress: 5 },
  'read_source':       { stage: JobStage.ReadSource, minProgress: 5, maxProgress: 10 },
  'preprocess':        { stage: JobStage.Preprocess, minProgress: 10, maxProgress: 20 },
  'infer':             { stage: JobStage.Infer, minProgress: 20, maxProgress: 80 },
  'postprocess':       { stage: JobStage.Postprocess, minProgress: 80, maxProgress: 88 },
  'write_files':       { stage: JobStage.WriteFiles, minProgress: 88, maxProgress: 94 },
  'build_index':       { stage: JobStage.BuildIndex, minProgress: 94, maxProgress: 97 },
  'generate_waveform': { stage: JobStage.GenerateWaveform, minProgress: 97, maxProgress: 99 },
  'done':              { stage: JobStage.Done, minProgress: 100, maxProgress: 100 },
};

// ============================================================================
// 2. 阶段显示名
// ============================================================================

/**
 * JobStage → 用户友好显示名
 */
export const STAGE_DISPLAY_NAMES: Record<string, string> = {
  [JobStage.Init]: '初始化',
  [JobStage.ReadSource]: '读取源文件',
  [JobStage.Preprocess]: '预处理',
  [JobStage.Infer]: '分离推理',
  [JobStage.Postprocess]: '后处理',
  [JobStage.WriteFiles]: '写入文件',
  [JobStage.BuildIndex]: '构建索引',
  [JobStage.GenerateWaveform]: '生成波形',
  [JobStage.ChordAnalysis]: '和弦分析',
  [JobStage.Done]: '完成',
};

/**
 * 有序阶段列表（用于进度页时间线展示）
 */
export const ORDERED_STAGES: readonly { key: string; label: string }[] = [
  { key: JobStage.Init, label: STAGE_DISPLAY_NAMES[JobStage.Init] },
  { key: JobStage.ReadSource, label: STAGE_DISPLAY_NAMES[JobStage.ReadSource] },
  { key: JobStage.Preprocess, label: STAGE_DISPLAY_NAMES[JobStage.Preprocess] },
  { key: JobStage.Infer, label: STAGE_DISPLAY_NAMES[JobStage.Infer] },
  { key: JobStage.Postprocess, label: STAGE_DISPLAY_NAMES[JobStage.Postprocess] },
  { key: JobStage.WriteFiles, label: STAGE_DISPLAY_NAMES[JobStage.WriteFiles] },
  { key: JobStage.BuildIndex, label: STAGE_DISPLAY_NAMES[JobStage.BuildIndex] },
  { key: JobStage.GenerateWaveform, label: STAGE_DISPLAY_NAMES[JobStage.GenerateWaveform] },
  { key: JobStage.Done, label: STAGE_DISPLAY_NAMES[JobStage.Done] },
];

// ============================================================================
// 3. IPC DTO 已迁移到 shared/contracts.ts（GPT R8 Decision #1）
// ============================================================================
// SeparationProgressDTO, SeparationCompleteDTO, SeparationStartResultDTO,
// SelectedFileDTO 现在从 shared/contracts.ts 导出。
// 保留此注释以说明迁移历史。
