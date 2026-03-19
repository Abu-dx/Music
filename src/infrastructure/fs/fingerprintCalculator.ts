/**
 * @module infrastructure/fs/fingerprintCalculator
 * @description 文件指纹计算器 — 基于文件内容的稳定指纹生成
 *
 * Why: ADR-005 要求自动分离与手动导入都必须生成指纹。
 *      指纹用于缓存命中判定，不依赖文件名/路径（规格文档 §22.7）。
 *
 * 稳定指纹组成（GPT R3 Suggested #1）：
 * - 自动分离：文件前 64KB 内容 + 文件大小 → SHA-256 → "auto:<hash>:<size>"
 *   仅读前 64KB 避免大文件全读。文件大小作为额外碰撞缓解。
 * - 手动导入：每文件完整内容 hash → 排序 → 合并 hash + 总大小 → SHA-256 → "manual:<hash>:<size>"
 *   排序保证文件选择顺序不影响指纹。
 * - Hash 算法当前为 SHA-256，后续如需更换，修改 HASH_ALGORITHM 常量即可。
 * - 指纹格式: "<prefix>:<64_hex_sha256>:<file_size_decimal>"
 *
 * 异步硬约束（GPT R3 Must Fix #1）：
 * - 所有公开方法均为 async（返回 Promise）
 * - 不允许在 renderer 中调用（ADR-003/ADR-009）
 * - 不允许在 main IPC handler 中直接做整文件 hash 计算
 * - 大文件指纹计算必须可被 worker_threads 接管（ADR-002）
 * - calculateForFiles() 对每个文件流式读取，避免内存膨胀
 *
 * 日志要求（GPT R3 Must Fix #6）：
 * - 每次指纹计算必须带 filePath / stage / elapsedMs 上下文
 * - 不允许把绝对路径透传给 UI
 *
 * 导入边界（ADR-009）：
 * - 本文件位于 infrastructure/fs，允许使用 Node.js crypto/fs/path
 * - domain/shared/renderer 不允许直接 import 本文件
 *
 * DI（ADR-008）：
 * - 通过 IFingerprintCalculator 接口暴露给 Application Service
 */

/** 当前 hash 算法 — 可替换点（GPT R3 Suggested #1） */
const HASH_ALGORITHM = 'sha256';

import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  AUTO_SEPARATION_FINGERPRINT_POLICY,
  MANUAL_IMPORT_FINGERPRINT_POLICY,
} from '../../domain/policies';
import { AppError, ErrorCode } from '../../shared/errors';
import { ILogger } from '../../shared/logger';

// ============================================================================
// 1. 接口定义（DI 友好）
// ============================================================================

/**
 * 指纹计算器接口
 *
 * Application Service 通过此接口计算文件指纹。
 */
export interface IFingerprintCalculator {
  /**
   * 计算自动分离项目的指纹
   *
   * 策略：读取文件前 sampleBytes 字节 + 文件大小 → SHA-256
   *
   * @param filePath - 原始音频文件的绝对路径
   * @returns 格式 "auto:<sha256_hex>:<file_size>"
   * @throws AppError(INPUT_FILE_NOT_FOUND) 文件不存在
   * @throws AppError(DISK_READ_FAILED) 读取失败
   */
  calculateForFile(filePath: string): Promise<string>;

  /**
   * 计算手动导入项目的指纹
   *
   * 策略（GPT R2 Must Fix #6）：
   * 1. 对每个文件计算内容 hash
   * 2. 将所有 hash 按字母序排序
   * 3. 拼接后再 hash
   * 4. 格式 "manual:<combined_hash>:<total_size>"
   *
   * @param filePaths - 所有导入文件的绝对路径列表
   * @returns 格式 "manual:<sha256_hex>:<total_size>"
   * @throws AppError(INPUT_FILE_NOT_FOUND) 任一文件不存在
   * @throws AppError(DISK_READ_FAILED) 读取失败
   */
  calculateForFiles(filePaths: string[]): Promise<string>;

  /**
   * 验证指纹格式是否合法
   *
   * @returns true 如果格式正确（"auto:<hex>:<num>" 或 "manual:<hex>:<num>"）
   */
  isValidFingerprint(fingerprint: string): boolean;
}

// ============================================================================
// 2. 实现
// ============================================================================

/**
 * 指纹计算器 — Node.js crypto + fs 实现
 */
export class FingerprintCalculator implements IFingerprintCalculator {
  constructor(private readonly logger: ILogger) {}

  async calculateForFile(filePath: string): Promise<string> {
    const policy = AUTO_SEPARATION_FINGERPRINT_POLICY;
    const startMs = Date.now();

    // 检查文件存在性
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      throw new AppError({
        code: ErrorCode.INPUT_FILE_NOT_FOUND,
        message: `File not found: ${filePath}`,
        userMessage: '音频文件未找到',
        context: { filePath },
        retryable: false,
      });
    }

    const fileSize = stat.size;

    try {
      // 读取前 sampleBytes 字节
      const fd = await fs.promises.open(filePath, 'r');
      try {
        const sampleSize = Math.min(policy.sampleBytes, fileSize);
        const buffer = Buffer.alloc(sampleSize);
        await fd.read(buffer, 0, sampleSize, 0);

        // 计算 SHA-256
        const hash = crypto.createHash(HASH_ALGORITHM);
        hash.update(buffer);
        // 混入文件大小作为额外区分
        hash.update(Buffer.from(fileSize.toString()));
        const hex = hash.digest('hex');

        const fingerprint = `${policy.prefix}:${hex}:${fileSize}`;

        this.logger.debug('Fingerprint calculated for file', {
          filePath,
          stage: 'fingerprintCalculator.calculateForFile',
          elapsedMs: Date.now() - startMs,
        });

        return fingerprint;
      } finally {
        await fd.close();
      }
    } catch (err) {
      if (err instanceof AppError) throw err;

      const error = err instanceof Error ? err : new Error(String(err));
      throw new AppError({
        code: ErrorCode.DISK_READ_FAILED,
        message: `Failed to calculate fingerprint: ${filePath}`,
        userMessage: '计算文件指纹失败',
        context: { filePath },
        retryable: true,
        cause: error,
      });
    }
  }

  async calculateForFiles(filePaths: string[]): Promise<string> {
    const policy = MANUAL_IMPORT_FINGERPRINT_POLICY;
    const startMs = Date.now();

    if (filePaths.length === 0) {
      throw new AppError({
        code: ErrorCode.IMPORT_NO_VALID_FILES,
        message: 'No files provided for fingerprint calculation',
        userMessage: '未选择任何有效文件',
        context: {},
        retryable: false,
      });
    }

    // 1. 对每个文件计算完整内容 hash
    const fileHashes: string[] = [];
    let totalSize = 0;

    for (const filePath of filePaths) {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        throw new AppError({
          code: ErrorCode.INPUT_FILE_NOT_FOUND,
          message: `File not found: ${filePath}`,
          userMessage: '导入文件未找到',
          context: { filePath },
          retryable: false,
        });
      }

      totalSize += stat.size;

      try {
        const hash = await this.hashFileContent(filePath);
        fileHashes.push(hash);
      } catch (err) {
        if (err instanceof AppError) throw err;

        const error = err instanceof Error ? err : new Error(String(err));
        throw new AppError({
          code: ErrorCode.DISK_READ_FAILED,
          message: `Failed to hash file: ${filePath}`,
          userMessage: '计算文件指纹失败',
          context: { filePath },
          retryable: true,
          cause: error,
        });
      }
    }

    // 2. 排序（保证文件选择顺序不影响指纹）
    fileHashes.sort();

    // 3. 拼接后再 hash
    const combinedHash = crypto.createHash(HASH_ALGORITHM);
    for (const h of fileHashes) {
      combinedHash.update(h);
    }
    combinedHash.update(Buffer.from(totalSize.toString()));
    const hex = combinedHash.digest('hex');

    const fingerprint = `${policy.prefix}:${hex}:${totalSize}`;

    this.logger.debug('Fingerprint calculated for multiple files', {
      stage: 'fingerprintCalculator.calculateForFiles',
      elapsedMs: Date.now() - startMs,
    });

    return fingerprint;
  }

  isValidFingerprint(fingerprint: string): boolean {
    // 格式: "auto:<64_hex>:<number>" 或 "manual:<64_hex>:<number>"
    return /^(auto|manual):[a-f0-9]{64}:\d+$/.test(fingerprint);
  }

  // --- Internal ---

  /**
   * 计算文件的完整内容 SHA-256 hash
   *
   * 使用流式读取，避免大文件一次性加载到内存
   */
  private hashFileContent(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(HASH_ALGORITHM);
      const stream = fs.createReadStream(filePath);

      stream.on('data', (chunk) => {
        hash.update(chunk);
      });
      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });
      stream.on('error', (err) => {
        reject(err);
      });
    });
  }
}
