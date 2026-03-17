/**
 * @module renderer/pages/CacheManagementPage
 * @description 缓存管理页 — 查看缓存统计、项目列表、清理操作、打开目录
 *
 * Round 12 创建，收尾修复轮定稿。
 *
 * 职责（规格文档 §5.10）：
 * - 展示缓存总体统计（总大小、项目数）
 * - 展示项目缓存列表（名称、大小、时间、操作）
 * - 提供单项目删除 + 全部清除操作
 * - 提供"打开本地目录"入口（规格文档 §5.10 明确要求）
 * - 提供"刷新"按钮重新获取缓存统计
 *
 * 删除语义定稿（GPT R12-Fix MF#1）：
 * - 单删 / 全删均为 **physical delete**
 * - 删除范围：SQLite 索引行 + manifest 条目 + 主波形文件 + 轨道文件 + 导出文件
 * - 删除操作不可逆，UI 层应展示确认对话框（当前 contract 预留 confirm 流程）
 * - 失败时 main 进程返回 CacheOperationErrorDTO（含 code / failedFiles / userMessage）
 * - 部分失败时 UI 展示失败条目，允许用户重试
 * - 删除完成后 UI 自动刷新统计和列表（loadStats）
 *
 * 数据来源：
 * - ICacheElectronAPI（IPC to main 进程获取缓存统计 + 执行清理 + 打开目录）
 *
 * 不负责：
 * - 缓存策略决策 → main 进程 / domain 层
 * - 播放 / 分析 → 其他 store
 * - 文件系统操作 → main 进程 + Electron shell
 */

import React, { useEffect, useCallback, useState } from 'react';

// ============================================================================
// 1. 缓存 DTO
// ============================================================================

/**
 * 单个项目的缓存条目
 *
 * GPT R12-Fix SG#1：包含 lastAccessedAt + openDirAvailable
 */
export interface CacheEntryDTO {
  projectId: string;
  displayName: string;
  /** 缓存总大小（字节）— 含轨道 + 波形 + 导出文件 */
  sizeBytes: number;
  /** 轨道数 */
  stemCount: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 最近访问时间戳 */
  lastAccessedAt: number;
  /**
   * 本地目录是否可打开
   *
   * false 时表示目录已被外部删除或路径不可用，
   * UI 应禁用"打开目录"按钮。
   * 由 main 进程在组装列表时校验路径可达性。
   */
  openDirAvailable: boolean;
}

/** 缓存统计汇总 */
export interface CacheStatsDTO {
  totalSizeBytes: number;
  projectCount: number;
  entries: CacheEntryDTO[];
}

/**
 * 缓存操作结构化错误 — renderer-safe
 *
 * GPT R12-Fix MF#4：与 BaseRendererErrorDTO 对齐。
 * 用于缓存删除、打开目录等失败场景。
 */
export interface CacheOperationErrorDTO {
  /** 错误码 */
  code: string;
  /** 技术消息 */
  message: string;
  /** 用户可见消息 */
  userMessage: string;
  /** 上下文 */
  context: {
    projectId?: string;
    cacheAction?: 'clearProject' | 'clearAll' | 'openDir' | 'loadStats';
    /** 删除失败时的文件列表 */
    failedFiles?: string[];
    /** 操作耗时（ms） */
    elapsedMs?: number;
  };
  /** 是否可重试 */
  retryable: boolean;
}

/**
 * 批量删除结果 — 支持部分成功
 *
 * GPT R12-Fix MF#1：删除可能部分失败（文件锁定等）
 */
export interface CacheClearResultDTO {
  /** 成功删除的项目 ID 列表 */
  succeededIds: string[];
  /** 失败项（含错误详情） */
  failedItems: Array<{
    projectId: string;
    error: CacheOperationErrorDTO;
  }>;
  /** 是否全部成功 */
  allSuccess: boolean;
  /** 释放的磁盘空间（字节） */
  freedBytes: number;
  /** 操作耗时（ms） */
  elapsedMs: number;
}

// ============================================================================
// 2. IPC 接口
// ============================================================================

/**
 * 缓存管理 IPC 接口
 *
 * 删除语义定稿（GPT R12-Fix MF#1）：
 * - 所有删除操作为 **physical delete**，不可逆
 * - clearProjectCache：删除指定项目的 SQLite 索引行 + manifest 条目 +
 *   主波形缓存文件 + 全部轨道文件 + 全部导出文件
 * - clearAllCache：对所有项目执行 clearProjectCache，返回汇总结果
 * - 若部分文件删除失败（文件锁定、权限不足），返回 CacheClearResultDTO
 *   中的 failedItems，不抛异常，允许 UI 提示用户重试
 * - 删除完成后 UI 侧应调用 getCacheStats 刷新统计，确保一致性
 */
export interface ICacheElectronAPI {
  /** 获取缓存统计 */
  getCacheStats(): Promise<CacheStatsDTO>;

  /**
   * 删除单个项目的缓存 — physical delete
   *
   * 删除范围：
   * 1. SQLite 项目索引行（project / stem / analysis 表）
   * 2. manifest.json 中该项目条目
   * 3. 主波形缓存文件（{projectDir}/waveform.json）
   * 4. 全部轨道音频文件（{projectDir}/stems/*.wav 等）
   * 5. 全部导出文件（{projectDir}/exports/*）
   *
   * 回滚策略：
   * - 索引先标记 deleted，文件删除完成后再物理删除索引行
   * - 若文件删除部分失败，索引行保留 deleted 标记，返回 failedFiles
   * - 下次重试时可续删
   *
   * @returns CacheClearResultDTO 支持部分失败
   */
  clearProjectCache(projectId: string): Promise<CacheClearResultDTO>;

  /**
   * 删除全部缓存 — physical delete
   *
   * 逐项执行 clearProjectCache，汇总结果。
   *
   * @returns CacheClearResultDTO 汇总（含每个项目的成功/失败）
   */
  clearAllCache(): Promise<CacheClearResultDTO>;

  /**
   * 在系统文件管理器中打开项目缓存目录（GPT R12-Fix MF#3）
   *
   * 规格文档 §5.10 明确要求缓存管理页提供"打开本地目录"入口。
   * 底层通过 Electron shell.openPath() 实现，不由页面拼路径。
   *
   * @throws CacheOperationErrorDTO 目录不存在或权限不足
   */
  openProjectCacheDir(projectId: string): Promise<void>;

  /**
   * 在系统文件管理器中打开缓存根目录（GPT R12-Fix MF#3）
   *
   * 便于用户直接在文件管理器中查看整体缓存结构。
   */
  openCacheRoot(): Promise<void>;
}

// ============================================================================
// 3. Props
// ============================================================================

export interface CacheManagementPageProps {
  cacheApi: ICacheElectronAPI;
  onNavigateToHome: () => void;
}

// ============================================================================
// 4. 组件
// ============================================================================

export const CacheManagementPage: React.FC<CacheManagementPageProps> = ({
  cacheApi,
  onNavigateToHome,
}) => {
  const [stats, setStats] = useState<CacheStatsDTO | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  /** SG#5：批量操作进度占位 */
  const [clearProgress, setClearProgress] = useState<string | null>(null);

  // 加载缓存统计
  const loadStats = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await cacheApi.getCacheStats();
      setStats(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法加载缓存统计');
    } finally {
      setIsLoading(false);
    }
  }, [cacheApi]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // 删除单个项目缓存（physical delete）
  const handleDeleteProject = useCallback(async (projectId: string) => {
    try {
      setDeletingId(projectId);
      setError(null);
      const result = await cacheApi.clearProjectCache(projectId);
      if (!result.allSuccess) {
        const failedCount = result.failedItems.length;
        const msg = result.failedItems[0]?.error?.userMessage ?? '部分文件删除失败';
        setError(`${msg}（${failedCount} 个文件未能删除，可重试）`);
      }
      await loadStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeletingId(null);
    }
  }, [cacheApi, loadStats]);

  // 全部清理（physical delete）
  const handleClearAll = useCallback(async () => {
    if (!stats || stats.projectCount === 0) return;
    try {
      setClearingAll(true);
      setClearProgress('正在清理所有缓存...');
      setError(null);
      const result = await cacheApi.clearAllCache();
      if (!result.allSuccess) {
        const failedCount = result.failedItems.length;
        setError(`${failedCount} 个项目清理失败，可重试`);
      }
      setClearProgress(
        `已释放 ${formatSize(result.freedBytes)}，耗时 ${Math.round(result.elapsedMs / 1000)} 秒`,
      );
      await loadStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : '清理失败');
    } finally {
      setClearingAll(false);
    }
  }, [cacheApi, loadStats, stats]);

  // 打开项目缓存目录（GPT R12-Fix MF#3）
  const handleOpenProjectDir = useCallback(async (projectId: string) => {
    try {
      setError(null);
      await cacheApi.openProjectCacheDir(projectId);
    } catch {
      setError('无法打开目录（目录可能已被删除）');
    }
  }, [cacheApi]);

  // 打开缓存根目录（GPT R12-Fix MF#3）
  const handleOpenCacheRoot = useCallback(async () => {
    try {
      setError(null);
      await cacheApi.openCacheRoot();
    } catch {
      setError('无法打开缓存根目录');
    }
  }, [cacheApi]);

  return (
    <div className="cache-management-page" style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.backButton} onClick={onNavigateToHome}>
          &larr; 返回首页
        </button>
        <h2 style={styles.title}>缓存管理</h2>
        <div style={styles.headerActions}>
          <button
            style={styles.openRootButton}
            onClick={handleOpenCacheRoot}
            title="在文件管理器中打开缓存根目录"
          >
            📂
          </button>
          <button style={styles.refreshButton} onClick={loadStats} disabled={isLoading}>
            刷新
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div style={styles.errorBanner}>{error}</div>
      )}

      {/* 批量操作进度（SG#5） */}
      {clearProgress && (
        <div style={styles.progressBanner}>{clearProgress}</div>
      )}

      {/* 加载中 */}
      {isLoading && !stats && (
        <div style={styles.loading}>加载缓存统计...</div>
      )}

      {/* 统计摘要 */}
      {stats && (
        <div style={styles.statsCard}>
          <div style={styles.statItem}>
            <span style={styles.statLabel}>缓存总大小</span>
            <span style={styles.statValue}>{formatSize(stats.totalSizeBytes)}</span>
          </div>
          <div style={styles.statItem}>
            <span style={styles.statLabel}>缓存项目数</span>
            <span style={styles.statValue}>{stats.projectCount}</span>
          </div>
          <button
            style={{
              ...styles.clearAllButton,
              ...(stats.projectCount === 0 || clearingAll ? styles.clearAllButtonDisabled : {}),
            }}
            onClick={handleClearAll}
            disabled={stats.projectCount === 0 || clearingAll}
          >
            {clearingAll ? '清理中...' : '清除全部缓存'}
          </button>
        </div>
      )}

      {/* 删除说明 */}
      {stats && stats.projectCount > 0 && (
        <div style={styles.deletionNote}>
          删除操作不可逆。将永久删除项目索引、波形缓存、轨道文件和导出文件。
        </div>
      )}

      {/* 项目缓存列表 */}
      {stats && stats.entries.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>项目缓存列表</h3>
          {stats.entries.map(entry => (
            <div key={entry.projectId} style={styles.entryCard}>
              <div style={styles.entryInfo}>
                <div style={styles.entryName}>{entry.displayName}</div>
                <div style={styles.entryMeta}>
                  {formatSize(entry.sizeBytes)} · {entry.stemCount} 轨 ·
                  创建于 {new Date(entry.createdAt).toLocaleDateString()} ·
                  最近访问 {new Date(entry.lastAccessedAt).toLocaleDateString()}
                </div>
              </div>
              <div style={styles.entryActions}>
                {/* 打开目录（GPT R12-Fix MF#3） */}
                <button
                  style={{
                    ...styles.openDirButton,
                    ...(!entry.openDirAvailable ? styles.openDirButtonDisabled : {}),
                  }}
                  onClick={() => handleOpenProjectDir(entry.projectId)}
                  disabled={!entry.openDirAvailable}
                  title={entry.openDirAvailable ? '打开项目目录' : '目录不可用'}
                >
                  📂
                </button>
                {/* 删除 */}
                <button
                  style={{
                    ...styles.deleteButton,
                    ...(deletingId === entry.projectId ? styles.deleteButtonBusy : {}),
                  }}
                  onClick={() => handleDeleteProject(entry.projectId)}
                  disabled={deletingId === entry.projectId}
                >
                  {deletingId === entry.projectId ? '删除中...' : '删除'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 空状态 */}
      {stats && stats.entries.length === 0 && (
        <div style={styles.emptyState}>暂无缓存数据</div>
      )}
    </div>
  );
};

// ============================================================================
// 5. 辅助函数
// ============================================================================

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ============================================================================
// 6. 样式
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '24px',
    maxWidth: '700px',
    margin: '0 auto',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '20px',
  },
  backButton: {
    padding: '6px 12px',
    fontSize: '13px',
    backgroundColor: 'transparent',
    border: '1px solid #ddd',
    borderRadius: '4px',
    cursor: 'pointer',
    color: '#666',
  },
  title: {
    fontSize: '18px',
    fontWeight: 600,
    margin: 0,
    color: '#1a1a1a',
  },
  headerActions: {
    display: 'flex',
    gap: '6px',
  },
  openRootButton: {
    padding: '6px 10px',
    fontSize: '16px',
    backgroundColor: 'transparent',
    border: '1px solid #ddd',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  refreshButton: {
    padding: '6px 12px',
    fontSize: '13px',
    backgroundColor: '#f5f5f5',
    border: '1px solid #ddd',
    borderRadius: '4px',
    cursor: 'pointer',
    color: '#333',
  },
  errorBanner: {
    padding: '10px',
    backgroundColor: '#ffebee',
    color: '#c62828',
    borderRadius: '6px',
    textAlign: 'center' as const,
    marginBottom: '16px',
    fontSize: '14px',
  },
  progressBanner: {
    padding: '10px',
    backgroundColor: '#e8f5e9',
    color: '#2e7d32',
    borderRadius: '6px',
    textAlign: 'center' as const,
    marginBottom: '16px',
    fontSize: '14px',
  },
  loading: {
    textAlign: 'center' as const,
    padding: '60px',
    color: '#666',
  },
  statsCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '24px',
    padding: '16px 20px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
    marginBottom: '12px',
  },
  statItem: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  },
  statLabel: {
    fontSize: '12px',
    color: '#888',
  },
  statValue: {
    fontSize: '20px',
    fontWeight: 600,
    color: '#1a1a1a',
  },
  clearAllButton: {
    marginLeft: 'auto',
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 500,
    backgroundColor: '#F44336',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  clearAllButtonDisabled: {
    backgroundColor: '#ccc',
    cursor: 'not-allowed',
  },
  deletionNote: {
    padding: '8px 12px',
    backgroundColor: '#fff3e0',
    color: '#e65100',
    borderRadius: '4px',
    fontSize: '12px',
    marginBottom: '16px',
    border: '1px solid #ffe0b2',
  },
  section: {
    marginBottom: '24px',
  },
  sectionTitle: {
    fontSize: '15px',
    fontWeight: 600,
    color: '#333',
    margin: '0 0 12px 0',
  },
  entryCard: {
    display: 'flex',
    alignItems: 'center',
    padding: '12px 16px',
    backgroundColor: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    marginBottom: '8px',
    gap: '14px',
  },
  entryInfo: {
    flex: 1,
    minWidth: 0,
  },
  entryName: {
    fontSize: '14px',
    fontWeight: 500,
    color: '#1a1a1a',
  },
  entryMeta: {
    fontSize: '12px',
    color: '#888',
    marginTop: '2px',
  },
  entryActions: {
    display: 'flex',
    gap: '6px',
    flexShrink: 0,
  },
  openDirButton: {
    padding: '6px 10px',
    fontSize: '14px',
    backgroundColor: 'transparent',
    border: '1px solid #ddd',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  openDirButtonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  deleteButton: {
    padding: '6px 14px',
    fontSize: '13px',
    backgroundColor: 'transparent',
    color: '#F44336',
    border: '1px solid #F44336',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  deleteButtonBusy: {
    color: '#ccc',
    borderColor: '#ccc',
    cursor: 'not-allowed',
  },
  emptyState: {
    textAlign: 'center' as const,
    padding: '40px',
    color: '#999',
    fontSize: '15px',
  },
};
