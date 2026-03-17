/**
 * @module infrastructure/adapters/separationResultAdapter
 * @description 分离引擎输出 → 统一 StemFile / ManifestStemEntry 适配器
 *
 * GPT R6 Must Fix #1：
 * 将引擎输出归一化职责从 ParseJobService 剥离到独立 adapter。
 * 前端/上层不应感知分离模型输出原始结构。
 *
 * 职责：
 * - 将 Worker separation result 归一化为 StemFile[]
 * - 将 Worker separation result 归一化为 ManifestStemEntry[]
 * - 生成 relativePath（基于 PROJECT_DIR_STRUCTURE 约定）
 * - 处理缺轨容忍（未输出的轨道不报错，仅记日志）
 * - 轨道类型推断（通过 inferStemTypeFromFilename）
 *
 * 不负责：
 * - 分离任务编排 → ParseJobService
 * - 目录创建 / 文件读写 → ProjectDirManager / ManifestManager
 * - Worker 通信 → IpcBridge
 *
 * 设计原则：
 * - 纯数据映射，无 I/O，无副作用
 * - 所有路径约定集中在此文件，不散落到应用层
 * - 可单元测试
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { StemFile, ManifestStemEntry } from '../../domain/entities';
import { StemType, StemStatus } from '../../shared/enums';
import { inferStemTypeFromFilename } from '../../domain/policies';
import { ILogger } from '../../shared/logger';

// ============================================================================
// 1. 引擎输出原始结构
// ============================================================================

/**
 * Worker 分离结果中的单个 stem 条目（引擎侧原始结构）
 */
export interface RawEngineStemOutput {
  /** stem 文件名（引擎写入 stems 目录的文件名） */
  filename: string;
  /** 音频编解码器 */
  codec: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 时长（ms） */
  durationMs: number;
  /** 采样率 */
  sampleRate: number;
  /** 合并来源轨道（GPT R7 Suggested #1：引擎合并两条弱轨时标注来源） */
  mergedFrom?: string[];
}

/**
 * Worker 分离完整结果（引擎侧原始结构）
 */
export interface RawSeparationResult {
  /** 引擎版本 */
  engineVersion: string;
  /** 输出的 stem 文件列表 */
  stems: RawEngineStemOutput[];
}

// ============================================================================
// 2. 目录约定常量（集中管理，不散落到应用层）
// ============================================================================

/**
 * stems 子目录名（与 PROJECT_DIR_STRUCTURE.STEMS_DIR 一致）
 *
 * 所有 stem 的 manifest relativePath 都以此为前缀。
 */
const STEMS_RELATIVE_DIR = 'stems';

// ============================================================================
// 3. 适配结果类型
// ============================================================================

/**
 * 适配后的分离结果
 */
export interface AdaptedSeparationResult {
  /** 归一化的 StemFile 实体列表（可直接入 DB） */
  stemFiles: StemFile[];
  /** 归一化的 ManifestStemEntry 列表（可直接写 manifest） */
  manifestEntries: ManifestStemEntry[];
  /** 引擎版本 */
  engineVersion: string;
  /** 警告信息（缺轨、合并等） */
  warnings: string[];
}

// ============================================================================
// 4. 接口
// ============================================================================

/**
 * 分离结果适配器接口
 */
export interface ISeparationResultAdapter {
  /**
   * 将引擎原始输出归一化为统一结构
   *
   * 纯数据映射，无 I/O。
   *
   * @param raw - 引擎原始输出
   * @param projectId - 项目 ID
   * @param projectDir - 项目缓存目录（用于生成 filePath 绝对路径）
   * @returns 归一化结果
   */
  adapt(
    raw: RawSeparationResult,
    projectId: string,
    projectDir: string,
  ): AdaptedSeparationResult;
}

// ============================================================================
// 5. 实现
// ============================================================================

/**
 * 所有预期轨道类型（用于缺轨检测）
 *
 * GPT R6 Suggested #5：缺轨容忍，记录缺失轨道。
 */
const EXPECTED_STEM_TYPES: readonly StemType[] = [
  StemType.Vocal,
  StemType.Drums,
  StemType.Bass,
  StemType.Guitar,
  StemType.Keyboard,
];

export class SeparationResultAdapter implements ISeparationResultAdapter {
  constructor(private readonly logger: ILogger) {}

  adapt(
    raw: RawSeparationResult,
    projectId: string,
    projectDir: string,
  ): AdaptedSeparationResult {
    const warnings: string[] = [];
    const stemFiles: StemFile[] = [];
    const manifestEntries: ManifestStemEntry[] = [];
    const detectedTypes = new Set<StemType>();

    for (const rawStem of raw.stems) {
      // 推断轨道类型
      const stemType = inferStemTypeFromFilename(rawStem.filename);
      detectedTypes.add(stemType);

      // 生成 relativePath（目录约定集中管理）
      const relativePath = `${STEMS_RELATIVE_DIR}/${rawStem.filename}`;

      // 生成 filePath 绝对路径（GPT R7 Decision #3：使用 path.join）
      const filePath = path.join(projectDir, relativePath);

      // 构建 StemFile 实体
      const stemFile: StemFile = {
        id: crypto.randomUUID(),
        projectId,
        stemType,
        filePath,
        codec: rawStem.codec,
        sizeBytes: rawStem.sizeBytes,
        durationMs: rawStem.durationMs,
        sampleRate: rawStem.sampleRate,
        exists: true,
        sourceOrigin: 'engine_output',
        confidence: null,
        exportable: true,
        status: StemStatus.Detected,
      };

      stemFiles.push(stemFile);

      // 构建 ManifestStemEntry
      manifestEntries.push({
        stemType,
        relativePath,
        codec: rawStem.codec,
        sizeBytes: rawStem.sizeBytes,
        sourceOrigin: 'engine_output',
      });
    }

    // 缺轨检测（仅警告，不阻断）
    for (const expected of EXPECTED_STEM_TYPES) {
      if (!detectedTypes.has(expected)) {
        const msg = `Expected stem type "${expected}" not found in engine output`;
        warnings.push(msg);
        this.logger.warn(msg, {
          projectId,
          stage: 'separationResultAdapter.adapt',
        });
      }
    }

    // Other 类型的轨道（引擎无法匹配到已知类型）
    if (detectedTypes.has(StemType.Other)) {
      warnings.push('Engine produced stem(s) with unrecognized type, mapped to "other"');
    }

    this.logger.info('Separation result adapted', {
      projectId,
      stemCount: stemFiles.length,
      warningCount: warnings.length,
      stage: 'separationResultAdapter.adapt',
    });

    return {
      stemFiles,
      manifestEntries,
      engineVersion: raw.engineVersion,
      warnings,
    };
  }
}

// NOTE: GPT R7 Decision #3 — custom joinPath removed, using Node.js path.join instead.
// This adapter runs exclusively in Electron main process, so path module is always available.
