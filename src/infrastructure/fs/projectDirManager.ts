/**
 * @module infrastructure/fs/projectDirManager
 * @description 项目缓存目录管理 — 创建、验证、清理、失败隔离、路径规范化
 *
 * Why: 规格文档 §11 要求每个项目有独立的缓存目录，
 *      目录结构规范化保证 manifest、stems、waveform、chord 文件有可预测的位置。
 *
 * 导入边界（ADR-009）：
 * - 本文件位于 infrastructure/fs，允许使用 Node.js fs/path API
 * - domain/shared/renderer 不允许直接 import 本文件
 *
 * 异步硬约束（GPT R3 Must Fix #1）：
 * - 所有公开方法均为 async（返回 Promise）
 * - 不允许在 renderer 中调用
 * - 不允许在 main IPC handler 中直接做大目录遍历
 * - calculateDirSize / removeProjectDir 等耗时操作必须可被 worker_threads 接管
 * - 调用方（Application Service / CacheService）负责判断是否委托后台线程
 *
 * 失败隔离策略（GPT R3 Must Fix #4, 规格文档 §5.11）：
 * - 失败/取消的半成品目录存放于 cacheRoot/_failed/<projectId>/
 * - 成功前不得把半成品视为正式缓存命中对象
 * - cleanupFailedDir() 必须幂等
 *
 * 日志要求（GPT R3 Must Fix #6）：
 * - 每次目录创建、校验、删除必须带 projectId + stage 上下文
 * - 不允许把绝对路径透传给 UI（userMessage 中不含路径）
 * - 失败时日志包含 filePath 供后台排障，但 UI 只看到友好提示
 *
 * StorageService 适配说明（GPT R3 Suggested #4）：
 * - 本模块只负责目录级文件操作
 * - "打开本地目录"、"项目大小汇总"、"批量清理" 由 Round 4+ 的
 *   CacheService / StorageService 编排调用，本模块不做上层决策
 *
 * DI（ADR-008）：
 * - 通过 IProjectDirManager 接口暴露给 Application Service
 * - 具体的 fs API 调用封装在本模块内部
 */

import * as fs from 'fs';
import * as path from 'path';
import { AppError, ErrorCode } from '../../shared/errors';
import { ILogger } from '../../shared/logger';

// ============================================================================
// 1. 目录结构常量（GPT R3 Suggested #2: 全部集中，不散落魔法字符串）
// ============================================================================

/**
 * 项目缓存目录内的标准子目录/文件名
 *
 * 规格文档目录约定：cacheRoot/projects/<projectId>/
 *   ├── manifest.json
 *   ├── stems/
 *   ├── waveform/
 *   ├── chord/
 *   └── logs/
 *
 * 失败项目隔离约定：cacheRoot/_failed/<projectId>/
 */
export const PROJECT_DIR_STRUCTURE = {
  /** manifest 文件名 */
  MANIFEST_FILENAME: 'manifest.json',
  /** 轨道文件目录 */
  STEMS_DIR: 'stems',
  /** 波形数据目录 */
  WAVEFORM_DIR: 'waveform',
  /** 和弦分析结果目录 */
  CHORD_DIR: 'chord',
  /** 日志目录 */
  LOGS_DIR: 'logs',
} as const;

/**
 * 失败项目隔离目录名（GPT R3 Must Fix #4）
 *
 * 位于 cacheRoot 下的顶级目录，与正式项目目录平级隔离。
 * 失败/取消任务的半成品会被移动到这里，不污染正式缓存。
 */
export const FAILED_DIR_NAME = '_failed';

// ============================================================================
// 2. 接口定义（DI 友好，全异步）
// ============================================================================

/**
 * 项目目录管理器接口
 *
 * Application Service / CacheService 通过此接口管理项目缓存目录，
 * 不直接调用 fs API。
 *
 * 所有方法均为 async，不允许同步 I/O 成为默认路径（GPT R3 Must Fix #1）。
 */
export interface IProjectDirManager {
  /**
   * 为新项目创建标准目录结构
   *
   * @param cacheRoot - 缓存根目录（来自 AppSettings.cacheRoot）
   * @param projectId - 项目 ID（用作目录名）
   * @returns 项目缓存目录绝对路径
   * @throws AppError(DISK_WRITE_FAILED) 创建失败
   * @throws AppError(DISK_PERMISSION_DENIED) 权限不足
   */
  createProjectDir(cacheRoot: string, projectId: string): Promise<string>;

  /**
   * 验证项目目录结构完整性
   *
   * @returns true 如果目录存在且包含 manifest.json
   */
  validateProjectDir(projectDir: string): Promise<boolean>;

  /**
   * 获取项目目录内的标准路径（纯路径拼接，无 I/O）
   */
  getPath(projectDir: string, subPath: keyof typeof PROJECT_DIR_STRUCTURE): string;

  /**
   * 获取 stems 目录下某轨道文件的绝对路径（纯路径拼接，无 I/O）
   */
  getStemFilePath(projectDir: string, filename: string): string;

  /**
   * 删除项目缓存目录（递归）
   *
   * 注意：大目录删除可能耗时，调用方应考虑后台化（ADR-002）
   *
   * @throws AppError(DISK_WRITE_FAILED) 删除失败
   */
  removeProjectDir(projectDir: string): Promise<void>;

  /**
   * 计算项目目录的总大小（字节）
   *
   * 警告：大目录遍历可能耗时较长，调用方（CacheService）
   * 必须评估是否需要委托 worker_threads 执行（ADR-002）。
   */
  calculateDirSize(projectDir: string): Promise<number>;

  /**
   * 检查磁盘剩余空间是否足够
   *
   * @param dir - 要检查的目录路径
   * @param requiredBytes - 需要的最小字节数
   * @returns true 如果空间足够
   */
  hasEnoughSpace(dir: string, requiredBytes: number): Promise<boolean>;

  // --- 失败项目隔离（GPT R3 Must Fix #4） ---

  /**
   * 将失败/取消项目的半成品目录移入隔离区
   *
   * 从 cacheRoot/<projectId>/ 移动到 cacheRoot/_failed/<projectId>/
   * 成功前的半成品不得被缓存命中逻辑扫到。
   *
   * @param cacheRoot - 缓存根目录
   * @param projectId - 项目 ID
   * @throws AppError(DISK_WRITE_FAILED) 移动失败
   */
  moveToFailed(cacheRoot: string, projectId: string): Promise<void>;

  /**
   * 清理失败隔离区中的特定项目（幂等）
   *
   * @param cacheRoot - 缓存根目录
   * @param projectId - 项目 ID
   */
  cleanupFailedProject(cacheRoot: string, projectId: string): Promise<void>;

  /**
   * 清理整个失败隔离区（幂等）
   *
   * @param cacheRoot - 缓存根目录
   * @returns 清理的项目数
   */
  cleanupAllFailed(cacheRoot: string): Promise<number>;

  /**
   * 获取正式项目目录路径（纯路径拼接）
   */
  getProjectDir(cacheRoot: string, projectId: string): string;

  /**
   * 获取失败隔离区项目路径（纯路径拼接）
   */
  getFailedProjectDir(cacheRoot: string, projectId: string): string;
}

// ============================================================================
// 3. 实现
// ============================================================================

/**
 * 项目目录管理器 — Node.js fs 异步实现
 *
 * 所有 I/O 操作使用 fs.promises（异步），不使用 fs.*Sync（同步）。
 */
export class ProjectDirManager implements IProjectDirManager {
  constructor(private readonly logger: ILogger) {}

  async createProjectDir(cacheRoot: string, projectId: string): Promise<string> {
    const projectDir = path.join(cacheRoot, projectId);
    const startMs = Date.now();

    try {
      await fs.promises.mkdir(projectDir, { recursive: true });

      await Promise.all([
        fs.promises.mkdir(path.join(projectDir, PROJECT_DIR_STRUCTURE.STEMS_DIR), { recursive: true }),
        fs.promises.mkdir(path.join(projectDir, PROJECT_DIR_STRUCTURE.WAVEFORM_DIR), { recursive: true }),
        fs.promises.mkdir(path.join(projectDir, PROJECT_DIR_STRUCTURE.CHORD_DIR), { recursive: true }),
        fs.promises.mkdir(path.join(projectDir, PROJECT_DIR_STRUCTURE.LOGS_DIR), { recursive: true }),
      ]);

      this.logger.info('Project directory created', {
        projectId,
        stage: 'projectDirManager.create',
        elapsedMs: Date.now() - startMs,
      });

      return projectDir;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const code = (err as NodeJS.ErrnoException).code === 'EACCES'
        ? ErrorCode.DISK_PERMISSION_DENIED
        : ErrorCode.DISK_WRITE_FAILED;

      this.logger.error('Failed to create project directory', error, {
        projectId,
        filePath: projectDir,
        stage: 'projectDirManager.create',
      });

      throw new AppError({
        code,
        message: `Failed to create project directory: ${projectDir}`,
        userMessage: code === ErrorCode.DISK_PERMISSION_DENIED
          ? '没有权限创建缓存目录，请检查文件权限'
          : '创建项目缓存目录失败，请检查磁盘空间',
        context: { projectId, cacheRoot },
        retryable: code === ErrorCode.DISK_WRITE_FAILED,
        cause: error,
      });
    }
  }

  async validateProjectDir(projectDir: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(projectDir);
      if (!stat.isDirectory()) return false;

      const manifestPath = path.join(projectDir, PROJECT_DIR_STRUCTURE.MANIFEST_FILENAME);
      await fs.promises.access(manifestPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  getPath(projectDir: string, subPath: keyof typeof PROJECT_DIR_STRUCTURE): string {
    return path.join(projectDir, PROJECT_DIR_STRUCTURE[subPath]);
  }

  getStemFilePath(projectDir: string, filename: string): string {
    return path.join(projectDir, PROJECT_DIR_STRUCTURE.STEMS_DIR, filename);
  }

  async removeProjectDir(projectDir: string): Promise<void> {
    const startMs = Date.now();
    try {
      await fs.promises.rm(projectDir, { recursive: true, force: true });

      this.logger.info('Project directory removed', {
        filePath: projectDir,
        stage: 'projectDirManager.remove',
        elapsedMs: Date.now() - startMs,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      this.logger.error('Failed to remove project directory', error, {
        filePath: projectDir,
        stage: 'projectDirManager.remove',
      });

      throw new AppError({
        code: ErrorCode.DISK_WRITE_FAILED,
        message: `Failed to remove project directory: ${projectDir}`,
        userMessage: '删除项目缓存目录失败',
        context: { projectDir },
        retryable: false,
        cause: error,
      });
    }
  }

  async calculateDirSize(projectDir: string): Promise<number> {
    let totalSize = 0;
    const startMs = Date.now();

    async function walkDir(dir: string): Promise<void> {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else if (entry.isFile()) {
          const stat = await fs.promises.stat(fullPath);
          totalSize += stat.size;
        }
      }
    }

    try {
      await walkDir(projectDir);

      this.logger.debug('Directory size calculated', {
        filePath: projectDir,
        stage: 'projectDirManager.calculateDirSize',
        elapsedMs: Date.now() - startMs,
      });

      return totalSize;
    } catch {
      return 0;
    }
  }

  async hasEnoughSpace(dir: string, requiredBytes: number): Promise<boolean> {
    try {
      const stats = await fs.promises.statfs(dir);
      const availableBytes = stats.bavail * stats.bsize;
      return availableBytes >= requiredBytes;
    } catch {
      this.logger.warn('Could not check disk space, assuming sufficient', {
        stage: 'projectDirManager.hasEnoughSpace',
      });
      return true;
    }
  }

  // --- 失败项目隔离 ---

  async moveToFailed(cacheRoot: string, projectId: string): Promise<void> {
    const srcDir = this.getProjectDir(cacheRoot, projectId);
    const destDir = this.getFailedProjectDir(cacheRoot, projectId);

    try {
      // 确保存在源目录
      await fs.promises.access(srcDir);
    } catch {
      // 源目录不存在，无需移动（幂等）
      this.logger.debug('Source directory not found for moveToFailed, skipping', {
        projectId,
        stage: 'projectDirManager.moveToFailed',
      });
      return;
    }

    try {
      // 如果目标已存在，先清理（幂等）
      await fs.promises.rm(destDir, { recursive: true, force: true });

      // 创建失败目录的父级
      await fs.promises.mkdir(path.join(cacheRoot, FAILED_DIR_NAME), { recursive: true });

      // 移动目录
      await fs.promises.rename(srcDir, destDir);

      this.logger.info('Project moved to failed isolation', {
        projectId,
        stage: 'projectDirManager.moveToFailed',
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      this.logger.error('Failed to move project to failed isolation', error, {
        projectId,
        stage: 'projectDirManager.moveToFailed',
      });

      throw new AppError({
        code: ErrorCode.DISK_WRITE_FAILED,
        message: `Failed to move project to failed dir: ${projectId}`,
        userMessage: '项目隔离失败',
        context: { projectId, cacheRoot },
        retryable: true,
        cause: error,
      });
    }
  }

  async cleanupFailedProject(cacheRoot: string, projectId: string): Promise<void> {
    const failedDir = this.getFailedProjectDir(cacheRoot, projectId);
    // 幂等：不存在不报错
    await fs.promises.rm(failedDir, { recursive: true, force: true });

    this.logger.debug('Failed project cleaned up', {
      projectId,
      stage: 'projectDirManager.cleanupFailedProject',
    });
  }

  async cleanupAllFailed(cacheRoot: string): Promise<number> {
    const failedRoot = path.join(cacheRoot, FAILED_DIR_NAME);

    try {
      await fs.promises.access(failedRoot);
    } catch {
      return 0; // 隔离区不存在
    }

    try {
      const entries = await fs.promises.readdir(failedRoot, { withFileTypes: true });
      let count = 0;

      for (const entry of entries) {
        if (entry.isDirectory()) {
          await fs.promises.rm(path.join(failedRoot, entry.name), { recursive: true, force: true });
          count++;
        }
      }

      this.logger.info('All failed projects cleaned up', {
        stage: 'projectDirManager.cleanupAllFailed',
      });

      return count;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Failed to cleanup failed projects', error, {
        stage: 'projectDirManager.cleanupAllFailed',
      });
      return 0;
    }
  }

  getProjectDir(cacheRoot: string, projectId: string): string {
    return path.join(cacheRoot, projectId);
  }

  getFailedProjectDir(cacheRoot: string, projectId: string): string {
    return path.join(cacheRoot, FAILED_DIR_NAME, projectId);
  }
}
