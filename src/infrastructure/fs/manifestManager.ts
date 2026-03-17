/**
 * @module infrastructure/fs/manifestManager
 * @description Manifest 管理器 — manifest.json 的读写、结构校验与版本检查
 *
 * Why: 规格文档 §11 要求 manifest 作为项目级事实来源。
 *      ADR-010 要求当 manifest 与 SQLite 冲突时，以 manifest 为准触发索引重建。
 *
 * 职责边界（GPT R3 Must Fix #2）：
 * ✅ 本模块只负责：
 *   - manifest 文件的读取与写入（原子写入）
 *   - manifest 结构完整性校验（返回结构化结果）
 *   - manifest schema 版本兼容性检查
 *   - 和弦结果 JSON 文件的读写（文件系统操作）
 * ❌ 本模块不负责：
 *   - 缓存命中决策 → CacheService
 *   - 项目修复策略选择 → CacheService
 *   - manifest + SQLite + 文件系统三方拼接成业务视图 → ProjectService / CacheService
 *   - 项目生命周期管理 → ProjectService
 *
 * 异步硬约束（GPT R3 Must Fix #1）：
 * - 所有公开方法均为 async（返回 Promise）
 * - 不允许在 renderer 中调用（ADR-003）
 * - 不允许在 main IPC handler 中直接做大文件 I/O
 *
 * 日志要求（GPT R3 Must Fix #6）：
 * - 每次读写必须带 projectId / stage 上下文
 * - 不允许把绝对路径透传给 UI（userMessage 中不含路径）
 *
 * DI（ADR-008）：
 * - 通过 IManifestManager 接口暴露给 Application Service
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectManifest } from '../../domain/entities';
import { AppError, ErrorCode } from '../../shared/errors';
import { ILogger } from '../../shared/logger';
import {
  CURRENT_MANIFEST_SCHEMA_VERSION,
  isManifestVersionCompatible,
  ChordResultJsonHeader,
  validateChordJsonHeader,
} from '../../domain/policies';
import { PROJECT_DIR_STRUCTURE } from './projectDirManager';

// ============================================================================
// 1. 结构化校验结果类型（GPT R3 Must Fix #3）
// ============================================================================

/**
 * Manifest 校验问题类型
 *
 * 规格文档要求区分以下情况，以支持"一键重建"等 UI 动作：
 * - manifest 缺失
 * - JSON 损坏/结构非法
 * - schemaVersion 不兼容
 * - engineVersion 不兼容
 * - 关键文件缺失（stems/waveform/chord）
 * - chord 结果版本不兼容
 */
export enum ManifestIssueType {
  /** manifest.json 文件不存在 */
  ManifestMissing = 'manifest_missing',
  /** JSON 解析失败（文件损坏） */
  JsonCorrupt = 'json_corrupt',
  /** manifest 结构不合法（必填字段缺失等） */
  StructureInvalid = 'structure_invalid',
  /** schemaVersion 与当前版本不兼容 */
  SchemaVersionIncompatible = 'schema_version_incompatible',
  /** engineVersion 与当前引擎不兼容 */
  EngineVersionIncompatible = 'engine_version_incompatible',
  /** stems 目录中声明的轨道文件缺失 */
  StemFileMissing = 'stem_file_missing',
  /** 波形数据文件缺失 */
  WaveformMissing = 'waveform_missing',
  /** 和弦分析结果文件缺失 */
  ChordResultMissing = 'chord_result_missing',
  /** 和弦结果版本不兼容 */
  ChordVersionIncompatible = 'chord_version_incompatible',
}

/**
 * 单条校验问题
 */
export interface ManifestIssue {
  /** 问题类型 */
  type: ManifestIssueType;
  /** 问题描述 */
  message: string;
  /** 涉及的字段路径（如 "stems[0].relativePath"） */
  field?: string;
  /** 额外细节 */
  details?: Record<string, unknown>;
}

/**
 * Manifest 校验结果 — 结构化对象（GPT R3 Must Fix #3）
 *
 * CacheService 依赖此结构判断缓存命中/异常恢复/一键重建策略。
 * 本模块只返回校验事实，不做策略决策。
 */
export interface ManifestValidationResult {
  /** 校验是否全部通过 */
  valid: boolean;
  /** 成功解析的 manifest（若 JSON 可解析） */
  manifest: ProjectManifest | null;
  /** 问题列表（空 = 无问题） */
  issues: ManifestIssue[];
  /** manifest schema 版本是否兼容 */
  schemaCompatible: boolean;
}

// ============================================================================
// 2. 和弦结果 JSON 结构
// ============================================================================

/**
 * 和弦结果 JSON 文件完整结构（ADR-012）
 */
export interface ChordResultJsonWithSegments extends ChordResultJsonHeader {
  segments: Array<{
    startMs: number;
    endMs: number;
    chordLabel: string;
    confidence: number;
    simplifiedLabel: string | null;
    sourceFlags: string[];
  }>;
}

// ============================================================================
// 3. 接口定义（DI 友好，全异步）
// ============================================================================

/**
 * Manifest 管理器接口
 *
 * 职责范围：manifest 读写 + 完整性校验 + 版本校验。
 * 不负责缓存命中决策、项目修复策略、跨模块数据拼接。
 */
export interface IManifestManager {
  /**
   * 读取项目 manifest
   *
   * @param projectDir - 项目缓存目录
   * @returns manifest 数据，文件不存在返回 null
   * @throws AppError(CACHE_MANIFEST_INVALID) manifest 格式不合法
   * @throws AppError(DISK_READ_FAILED) 读取失败
   */
  read(projectDir: string): Promise<ProjectManifest | null>;

  /**
   * 写入项目 manifest（原子写入：先写临时文件再 rename）
   *
   * @param projectDir - 项目缓存目录
   * @param manifest - 要写入的 manifest 数据
   * @throws AppError(DISK_WRITE_FAILED) 写入失败
   */
  write(projectDir: string, manifest: ProjectManifest): Promise<void>;

  /**
   * 对 manifest 做结构化校验，返回详细结果
   *
   * 不做缓存命中判定或修复策略选择，只返回事实。
   *
   * @param projectDir - 项目缓存目录
   * @returns 结构化校验结果（含 manifest/issues/schemaCompatible）
   */
  validateFull(projectDir: string): Promise<ManifestValidationResult>;

  /**
   * 对已解析的 manifest 做纯结构校验（不涉及文件系统）
   *
   * @returns 问题列表（空数组 = 无问题）
   */
  validateStructure(manifest: unknown): ManifestIssue[];

  /**
   * 检查 manifest schema 版本兼容性
   */
  isVersionCompatible(manifest: ProjectManifest): boolean;

  /**
   * 读取和弦分析结果 JSON 文件
   *
   * @throws AppError(CACHE_MANIFEST_INVALID) JSON 头部不合法（ADR-012）
   * @throws AppError(DISK_READ_FAILED) 读取失败
   */
  readChordResult(projectDir: string, relativePath: string): Promise<ChordResultJsonWithSegments>;

  /**
   * 写入和弦分析结果 JSON 文件（原子写入）
   *
   * @throws AppError(DISK_WRITE_FAILED) 写入失败
   */
  writeChordResult(
    projectDir: string,
    relativePath: string,
    data: ChordResultJsonWithSegments,
  ): Promise<void>;
}

// ============================================================================
// 4. 实现
// ============================================================================

/**
 * Manifest 管理器 — Node.js fs 异步实现
 *
 * 所有 I/O 操作使用 fs.promises（异步），不使用 fs.*Sync。
 */
export class ManifestManager implements IManifestManager {
  constructor(private readonly logger: ILogger) {}

  async read(projectDir: string): Promise<ProjectManifest | null> {
    const manifestPath = path.join(projectDir, PROJECT_DIR_STRUCTURE.MANIFEST_FILENAME);
    const startMs = Date.now();

    try {
      await fs.promises.access(manifestPath, fs.constants.R_OK);
    } catch {
      return null;
    }

    try {
      const content = await fs.promises.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(content);

      const issues = this.validateStructure(parsed);
      if (issues.length > 0) {
        const descriptions = issues.map(i => i.message);
        throw new AppError({
          code: ErrorCode.CACHE_MANIFEST_INVALID,
          message: `Manifest validation failed: ${descriptions.join('; ')}`,
          userMessage: '项目缓存数据损坏，可能需要重新分离',
          context: { projectDir, issueCount: issues.length },
          retryable: false,
        });
      }

      this.logger.debug('Manifest read', {
        projectId: (parsed as ProjectManifest).projectId,
        stage: 'manifestManager.read',
        elapsedMs: Date.now() - startMs,
      });

      return parsed as ProjectManifest;
    } catch (err) {
      if (err instanceof AppError) throw err;

      const error = err instanceof Error ? err : new Error(String(err));

      this.logger.error('Failed to read manifest', error, {
        filePath: manifestPath,
        stage: 'manifestManager.read',
      });

      throw new AppError({
        code: ErrorCode.DISK_READ_FAILED,
        message: `Failed to read manifest: ${manifestPath}`,
        userMessage: '读取项目数据失败',
        context: { projectDir },
        retryable: true,
        cause: error,
      });
    }
  }

  async write(projectDir: string, manifest: ProjectManifest): Promise<void> {
    const manifestPath = path.join(projectDir, PROJECT_DIR_STRUCTURE.MANIFEST_FILENAME);
    const tempPath = `${manifestPath}.tmp.${Date.now()}`;
    const startMs = Date.now();

    try {
      const dataToWrite = {
        ...manifest,
        updatedAt: Date.now(),
        schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION,
      };

      const content = JSON.stringify(dataToWrite, null, 2);

      await fs.promises.writeFile(tempPath, content, 'utf-8');
      await fs.promises.rename(tempPath, manifestPath);

      this.logger.debug('Manifest written', {
        projectId: manifest.projectId,
        stage: 'manifestManager.write',
        elapsedMs: Date.now() - startMs,
      });
    } catch (err) {
      try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }

      const error = err instanceof Error ? err : new Error(String(err));

      this.logger.error('Failed to write manifest', error, {
        projectId: manifest.projectId,
        stage: 'manifestManager.write',
      });

      throw new AppError({
        code: ErrorCode.DISK_WRITE_FAILED,
        message: `Failed to write manifest: ${manifestPath}`,
        userMessage: '保存项目数据失败，请检查磁盘空间',
        context: { projectDir, projectId: manifest.projectId },
        retryable: true,
        cause: error,
      });
    }
  }

  async validateFull(projectDir: string): Promise<ManifestValidationResult> {
    const manifestPath = path.join(projectDir, PROJECT_DIR_STRUCTURE.MANIFEST_FILENAME);
    const startMs = Date.now();

    // 1. 检查 manifest 文件存在
    try {
      await fs.promises.access(manifestPath, fs.constants.R_OK);
    } catch {
      return {
        valid: false,
        manifest: null,
        issues: [{ type: ManifestIssueType.ManifestMissing, message: 'manifest.json not found' }],
        schemaCompatible: false,
      };
    }

    // 2. 解析 JSON
    let raw: unknown;
    try {
      const content = await fs.promises.readFile(manifestPath, 'utf-8');
      raw = JSON.parse(content);
    } catch (err) {
      return {
        valid: false,
        manifest: null,
        issues: [{
          type: ManifestIssueType.JsonCorrupt,
          message: `JSON parse failed: ${err instanceof Error ? err.message : 'unknown'}`,
        }],
        schemaCompatible: false,
      };
    }

    // 3. 结构校验
    const structureIssues = this.validateStructure(raw);
    if (structureIssues.some(i => i.type === ManifestIssueType.StructureInvalid)) {
      return {
        valid: false,
        manifest: null,
        issues: structureIssues,
        schemaCompatible: false,
      };
    }

    const manifest = raw as ProjectManifest;
    const issues: ManifestIssue[] = [...structureIssues];

    // 4. Schema 版本兼容性
    const schemaCompatible = this.isVersionCompatible(manifest);
    if (!schemaCompatible) {
      issues.push({
        type: ManifestIssueType.SchemaVersionIncompatible,
        message: `Schema version ${manifest.schemaVersion} incompatible with current ${CURRENT_MANIFEST_SCHEMA_VERSION}`,
        field: 'schemaVersion',
        details: { manifest: manifest.schemaVersion, current: CURRENT_MANIFEST_SCHEMA_VERSION },
      });
    }

    // 5. 检查 stem 文件存在性
    for (let i = 0; i < manifest.stems.length; i++) {
      const stem = manifest.stems[i];
      const stemPath = path.join(projectDir, PROJECT_DIR_STRUCTURE.STEMS_DIR, stem.relativePath);
      try {
        await fs.promises.access(stemPath, fs.constants.R_OK);
      } catch {
        issues.push({
          type: ManifestIssueType.StemFileMissing,
          message: `Stem file missing: ${stem.stemType} (${stem.relativePath})`,
          field: `stems[${i}].relativePath`,
          details: { stemType: stem.stemType, relativePath: stem.relativePath },
        });
      }
    }

    // 6. 检查 waveform 文件存在性
    if (manifest.waveform) {
      const wfPath = path.join(projectDir, manifest.waveform.path);
      try {
        await fs.promises.access(wfPath, fs.constants.R_OK);
      } catch {
        issues.push({
          type: ManifestIssueType.WaveformMissing,
          message: `Waveform file missing: ${manifest.waveform.path}`,
          field: 'waveform.path',
        });
      }
    }

    // 7. 检查 chord 结果文件存在性与版本
    if (manifest.chordAnalysis) {
      const chordPath = path.join(projectDir, manifest.chordAnalysis.path);
      try {
        await fs.promises.access(chordPath, fs.constants.R_OK);

        // 尝试读取 header 验证版本
        try {
          const chordContent = await fs.promises.readFile(chordPath, 'utf-8');
          const chordData = JSON.parse(chordContent) as Partial<ChordResultJsonHeader>;
          const headerError = validateChordJsonHeader(chordData);
          if (headerError) {
            issues.push({
              type: ManifestIssueType.ChordVersionIncompatible,
              message: `Chord result header invalid: ${headerError}`,
              field: 'chordAnalysis',
              details: { headerError },
            });
          }
        } catch {
          issues.push({
            type: ManifestIssueType.ChordVersionIncompatible,
            message: 'Chord result file is not valid JSON',
            field: 'chordAnalysis',
          });
        }
      } catch {
        issues.push({
          type: ManifestIssueType.ChordResultMissing,
          message: `Chord result file missing: ${manifest.chordAnalysis.path}`,
          field: 'chordAnalysis.path',
        });
      }
    }

    this.logger.debug('Manifest validation completed', {
      projectId: manifest.projectId,
      stage: 'manifestManager.validateFull',
      elapsedMs: Date.now() - startMs,
    });

    return {
      valid: issues.length === 0,
      manifest,
      issues,
      schemaCompatible,
    };
  }

  validateStructure(manifest: unknown): ManifestIssue[] {
    const issues: ManifestIssue[] = [];

    if (!manifest || typeof manifest !== 'object') {
      issues.push({
        type: ManifestIssueType.StructureInvalid,
        message: 'manifest is not an object',
      });
      return issues;
    }

    const m = manifest as Record<string, unknown>;

    if (typeof m.projectId !== 'string' || !m.projectId) {
      issues.push({ type: ManifestIssueType.StructureInvalid, message: 'missing or empty projectId', field: 'projectId' });
    }
    if (typeof m.fingerprint !== 'string' || !m.fingerprint) {
      issues.push({ type: ManifestIssueType.StructureInvalid, message: 'missing or empty fingerprint', field: 'fingerprint' });
    }
    if (typeof m.sourceType !== 'string') {
      issues.push({ type: ManifestIssueType.StructureInvalid, message: 'missing sourceType', field: 'sourceType' });
    }
    if (typeof m.schemaVersion !== 'string') {
      issues.push({ type: ManifestIssueType.StructureInvalid, message: 'missing schemaVersion', field: 'schemaVersion' });
    }
    if (typeof m.createdAt !== 'number') {
      issues.push({ type: ManifestIssueType.StructureInvalid, message: 'missing or invalid createdAt', field: 'createdAt' });
    }
    if (typeof m.updatedAt !== 'number') {
      issues.push({ type: ManifestIssueType.StructureInvalid, message: 'missing or invalid updatedAt', field: 'updatedAt' });
    }
    if (!Array.isArray(m.stems)) {
      issues.push({ type: ManifestIssueType.StructureInvalid, message: 'missing or invalid stems array', field: 'stems' });
    }

    if (Array.isArray(m.stems)) {
      for (let i = 0; i < m.stems.length; i++) {
        const stem = m.stems[i] as Record<string, unknown>;
        if (typeof stem.stemType !== 'string') {
          issues.push({ type: ManifestIssueType.StructureInvalid, message: `stems[${i}]: missing stemType`, field: `stems[${i}].stemType` });
        }
        if (typeof stem.relativePath !== 'string') {
          issues.push({ type: ManifestIssueType.StructureInvalid, message: `stems[${i}]: missing relativePath`, field: `stems[${i}].relativePath` });
        }
        if (typeof stem.codec !== 'string') {
          issues.push({ type: ManifestIssueType.StructureInvalid, message: `stems[${i}]: missing codec`, field: `stems[${i}].codec` });
        }
        if (typeof stem.sizeBytes !== 'number') {
          issues.push({ type: ManifestIssueType.StructureInvalid, message: `stems[${i}]: missing or invalid sizeBytes`, field: `stems[${i}].sizeBytes` });
        }
        if (typeof stem.sourceOrigin !== 'string') {
          issues.push({ type: ManifestIssueType.StructureInvalid, message: `stems[${i}]: missing sourceOrigin`, field: `stems[${i}].sourceOrigin` });
        }
      }
    }

    return issues;
  }

  isVersionCompatible(manifest: ProjectManifest): boolean {
    return isManifestVersionCompatible(manifest.schemaVersion);
  }

  async readChordResult(
    projectDir: string,
    relativePath: string,
  ): Promise<ChordResultJsonWithSegments> {
    const fullPath = path.join(projectDir, relativePath);

    try {
      const content = await fs.promises.readFile(fullPath, 'utf-8');
      const parsed = JSON.parse(content) as ChordResultJsonWithSegments;

      const headerError = validateChordJsonHeader(parsed);
      if (headerError) {
        throw new AppError({
          code: ErrorCode.CACHE_MANIFEST_INVALID,
          message: `Chord result JSON header invalid: ${headerError}`,
          userMessage: '和弦分析数据格式异常，可能需要重新分析',
          context: { projectDir, relativePath, headerError },
          retryable: false,
        });
      }

      return parsed;
    } catch (err) {
      if (err instanceof AppError) throw err;

      const error = err instanceof Error ? err : new Error(String(err));
      throw new AppError({
        code: ErrorCode.DISK_READ_FAILED,
        message: `Failed to read chord result: ${fullPath}`,
        userMessage: '读取和弦分析数据失败',
        context: { projectDir, relativePath },
        retryable: true,
        cause: error,
      });
    }
  }

  async writeChordResult(
    projectDir: string,
    relativePath: string,
    data: ChordResultJsonWithSegments,
  ): Promise<void> {
    const fullPath = path.join(projectDir, relativePath);
    const tempPath = `${fullPath}.tmp.${Date.now()}`;

    const headerError = validateChordJsonHeader(data);
    if (headerError) {
      throw new AppError({
        code: ErrorCode.CACHE_MANIFEST_INVALID,
        message: `Cannot write chord result with invalid header: ${headerError}`,
        userMessage: '和弦分析数据格式异常',
        context: { projectDir, relativePath, headerError },
        retryable: false,
      });
    }

    try {
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      const content = JSON.stringify(data, null, 2);

      await fs.promises.writeFile(tempPath, content, 'utf-8');
      await fs.promises.rename(tempPath, fullPath);

      this.logger.debug('Chord result written', {
        stage: 'manifestManager.writeChordResult',
        filePath: relativePath,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;

      try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }

      const error = err instanceof Error ? err : new Error(String(err));
      throw new AppError({
        code: ErrorCode.DISK_WRITE_FAILED,
        message: `Failed to write chord result: ${fullPath}`,
        userMessage: '保存和弦分析数据失败',
        context: { projectDir, relativePath },
        retryable: true,
        cause: error,
      });
    }
  }
}
