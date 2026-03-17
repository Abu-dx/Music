/**
 * @module domain/policies
 * @description 领域业务策略 — 轨道别名识别、手动导入指纹约束等
 *
 * Why: GPT Round-2 Must Fix #1 要求把业务策略从 entities.ts 拆出，
 *      entities.ts 专注于数据结构。
 *      GPT Round-2 Must Fix #6 要求手动导入指纹约束显式化。
 *      GPT Round-3 Must Fix #5 要求 stem UNIQUE 冲突在应用层前置处理。
 *
 * 本文件不依赖 Node.js / Electron / 文件系统 API（ADR-009）。
 */

import { StemType } from '../shared/enums';
import { ErrorCode } from '../shared/errors';

// ============================================================================
// 1. 轨道别名策略（规格文档 §8）
// ============================================================================

/**
 * 轨道别名映射表 — 用于手动导入时自动识别文件名 -> 轨道类型
 *
 * Why: GPT Suggested #5 要求从 types.ts 迁出到更明确位置。
 *      放在 domain/policies 因为它是业务规则字典。
 */
export const STEM_NAME_ALIASES: Readonly<Record<StemType, readonly string[]>> = {
  [StemType.Vocal]: ['vocal', 'vocals', 'vox', 'lead_vocal', 'singer'],
  [StemType.Drums]: ['drum', 'drums', 'drumkit', 'percussion'],
  [StemType.Bass]: ['bass', 'electric_bass', 'sub_bass'],
  [StemType.Guitar]: ['guitar', 'gt', 'electric_guitar', 'acoustic_guitar'],
  [StemType.Keyboard]: ['keys', 'keyboard', 'piano', 'ep'],
  [StemType.Synth]: ['synth', 'synths', 'pad', 'lead', 'arp'],
  [StemType.Other]: [],
};

/**
 * 从文件名推断轨道类型
 *
 * 规则：
 * 1. 取文件名（去掉扩展名），转小写
 * 2. 按 '_' / '-' / ' ' / '.' 分词
 * 3. 逐词匹配 STEM_NAME_ALIASES
 * 4. 首次命中即返回，无命中返回 StemType.Other
 *
 * @param filename - 文件名（不含目录路径），如 "Vocal_01.wav"
 */
export function inferStemTypeFromFilename(filename: string): StemType {
  // 去掉扩展名并分词
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
  const tokens = nameWithoutExt.toLowerCase().split(/[_\-\s.]+/);

  for (const [stemType, aliases] of Object.entries(STEM_NAME_ALIASES)) {
    for (const token of tokens) {
      if (aliases.includes(token)) {
        return stemType as StemType;
      }
    }
  }

  return StemType.Other;
}

// ============================================================================
// 2. 轨道冲突策略（GPT R3 Must Fix #5）
// ============================================================================

/**
 * 轨道冲突检测结果
 *
 * Why: GPT R3 Must Fix #5 — stem_files UNIQUE(project_id, stem_type) 只是最后防线，
 *      手动导入时若同一轨道映射多个文件，必须在 Application Service 层先拦截并要求用户处理。
 *      规格文档明确要求"首版不自动混合，需要求用户手动保留一个或取消"。
 *
 * 使用规则：
 * - ImportService / ProjectService 在写入 stem_files 之前必须调用 detectStemConflicts()
 * - 若返回冲突列表非空，必须抛出 AppError(IMPORT_MAPPING_CONFLICT) 并携带冲突详情
 * - DB UNIQUE 约束仅作为最后防线，不承担主要用户交互职责
 */
export interface StemConflict {
  /** 冲突的轨道类型 */
  stemType: StemType;
  /** 映射到此类型的文件列表 */
  conflictingFiles: string[];
}

/**
 * 检测轨道映射冲突
 *
 * @param mappings - 文件到轨道类型的映射列表
 * @returns 冲突列表（空数组 = 无冲突）
 */
export function detectStemConflicts(
  mappings: Array<{ filename: string; stemType: StemType }>,
): StemConflict[] {
  const typeToFiles = new Map<StemType, string[]>();

  for (const { filename, stemType } of mappings) {
    const existing = typeToFiles.get(stemType) ?? [];
    existing.push(filename);
    typeToFiles.set(stemType, existing);
  }

  const conflicts: StemConflict[] = [];
  for (const [stemType, files] of typeToFiles) {
    if (files.length > 1) {
      conflicts.push({ stemType, conflictingFiles: files });
    }
  }

  return conflicts;
}

/**
 * 断言无轨道冲突，否则返回应使用的错误码
 *
 * 调用方应使用此错误码构造 AppError(IMPORT_MAPPING_CONFLICT)
 */
export const STEM_CONFLICT_ERROR_CODE = ErrorCode.IMPORT_MAPPING_CONFLICT;

// ============================================================================
// 3. 手动导入指纹策略（GPT R2 Must Fix #6）
// ============================================================================

/**
 * 手动导入项目的指纹计算策略
 *
 * Why: ADR-005 要求自动分离与手动导入使用同一 Project 实体，
 *      都必须生成指纹。但手动导入没有单一原始文件。
 *
 * 策略：
 * - 手动导入时，指纹基于所有导入文件的内容 hash 排序后再 hash
 * - 排序保证文件选择顺序不影响指纹
 * - 指纹格式：`manual:<combined_hash>:<total_size>`
 *
 * 此策略由 FingerprintCalculator 实现层使用。
 */
export interface ManualImportFingerprintPolicy {
  /** 指纹前缀标识手动导入来源 */
  readonly prefix: 'manual';
  /** 多文件 hash 合并规则：排序后拼接再 hash */
  readonly combineRule: 'sort_then_hash';
  /** 包含文件总大小作为碰撞缓解 */
  readonly includeTotalSize: true;
}

export const MANUAL_IMPORT_FINGERPRINT_POLICY: ManualImportFingerprintPolicy = {
  prefix: 'manual',
  combineRule: 'sort_then_hash',
  includeTotalSize: true,
};

/**
 * 自动分离项目的指纹计算策略
 *
 * 策略：
 * - 基于原始音频文件前 N 字节 + 文件大小 hash
 * - 指纹格式：`auto:<content_hash>:<file_size>`
 */
export interface AutoSeparationFingerprintPolicy {
  readonly prefix: 'auto';
  /** 读取文件前 N 字节用于 hash 计算（避免大文件全读） */
  readonly sampleBytes: number;
  readonly includeTotalSize: true;
}

export const AUTO_SEPARATION_FINGERPRINT_POLICY: AutoSeparationFingerprintPolicy = {
  prefix: 'auto',
  sampleBytes: 64 * 1024, // 64KB
  includeTotalSize: true,
};

// ============================================================================
// 4. Manifest 版本兼容策略
// ============================================================================

/** 当前 manifest schema 版本 */
export const CURRENT_MANIFEST_SCHEMA_VERSION = '1.0.0';

/**
 * manifest schema 版本兼容性规则
 *
 * Why: 规格文档 §11 要求 manifest 记录 schemaVersion，版本变化时可触发重新解析。
 *
 * 规则：
 * - major 版本不同 → 不兼容，必须重建
 * - minor 版本不同 → 兼容，可选升级
 * - patch 版本不同 → 完全兼容
 */
export function isManifestVersionCompatible(
  manifestVersion: string,
  currentVersion: string = CURRENT_MANIFEST_SCHEMA_VERSION,
): boolean {
  const [mMajor] = manifestVersion.split('.').map(Number);
  const [cMajor] = currentVersion.split('.').map(Number);
  return mMajor === cMajor;
}

// ============================================================================
// 5. 和弦分析 JSON 一致性策略（GPT R2 Must Fix #5 / ADR-012）
// ============================================================================

/**
 * 和弦分析结果 JSON 文件头必须包含的字段
 *
 * Why: ADR-012 要求和弦结果 JSON 必须带版本头，
 *      加载时校验版本兼容性，不兼容则标记为过期。
 */
export interface ChordResultJsonHeader {
  /** 分析版本 */
  analysisVersion: string;
  /** 词汇表版本 */
  vocabularyVersion: string;
  /** 分析器类型 */
  analyzerType: string;
  /** 生成时间戳 */
  generatedAt: number;
  /** segment 数量（快速校验完整性） */
  segmentCount: number;
}

/**
 * 校验和弦 JSON 头部是否合法
 *
 * @returns null 如果合法，否则返回错误描述
 */
export function validateChordJsonHeader(header: Partial<ChordResultJsonHeader>): string | null {
  if (!header.analysisVersion) return 'missing analysisVersion';
  if (!header.vocabularyVersion) return 'missing vocabularyVersion';
  if (!header.analyzerType) return 'missing analyzerType';
  if (typeof header.generatedAt !== 'number') return 'missing or invalid generatedAt';
  if (typeof header.segmentCount !== 'number') return 'missing or invalid segmentCount';
  return null;
}
