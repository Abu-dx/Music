/**
 * @module renderer/pages/HomePage
 * @description 首页 — 最近项目列表 + 新建入口
 *
 * 职责：
 * - 展示最近项目列表（名称、状态、时间）
 * - 提供"新建项目"入口（跳转到上传页）
 * - 提供项目点击事件（跳转到项目详情/进度页）
 *
 * 数据来源：
 * - ProjectStore.getSnapshot().recentProjects
 * - 通过 ProjectStore.loadRecentProjects() 拉取
 *
 * 导航：
 * - "新建项目" → UploadPage
 * - 项目卡片点击 → ProgressPage（如 Running）或 ProjectDetailPage（如 Ready）
 */

import React, { useEffect, useSyncExternalStore } from 'react';
import { IProjectStore } from '../stores/projectStore';

// ============================================================================
// 1. 状态显示映射
// ============================================================================

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  scanning: '扫描中',
  cache_hit: '缓存命中',
  ready_to_parse: '等待分离',
  importing: '导入中',
  processing: '处理中',
  ready: '就绪',
  failed: '失败',
  cancelled: '已取消',
};

const STATUS_COLORS: Record<string, string> = {
  draft: '#999',
  scanning: '#2196F3',
  cache_hit: '#4CAF50',
  ready_to_parse: '#FF9800',
  importing: '#2196F3',
  processing: '#2196F3',
  ready: '#4CAF50',
  failed: '#F44336',
  cancelled: '#999',
};

// ============================================================================
// 2. Props
// ============================================================================

export interface HomePageProps {
  store: IProjectStore;
  onNavigateToUpload: () => void;
  onNavigateToProject: (projectId: string) => void;
  onNavigateToProgress: (projectId: string) => void;
}

// ============================================================================
// 3. 组件
// ============================================================================

export const HomePage: React.FC<HomePageProps> = ({
  store,
  onNavigateToUpload,
  onNavigateToProject,
  onNavigateToProgress,
}) => {
  const snapshot = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getSnapshot(),
  );
  const cacheStatsReady = snapshot.cacheStats !== null;
  const cacheStatsLoading = !cacheStatsReady;

  // 首次加载
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await store.loadRecentProjects(20);
      if (cancelled) return;
      await store.loadCacheStats();
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [store]);

  const handleProjectClick = (project: { id: string; status: string }) => {
    if (project.status === 'processing') {
      onNavigateToProgress(project.id);
    } else {
      onNavigateToProject(project.id);
    }
  };

  return (
    <div className="home-page" style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>Stem Monitor</h1>
        <button
          style={styles.newButton}
          onClick={onNavigateToUpload}
        >
          + 新建项目
        </button>
      </div>

      {/* 缓存占用摘要（GPT R7 Suggested #2） */}
      <div style={styles.cacheStats}>
        <span style={styles.cacheStatsLabel}>缓存占用</span>
        <span style={styles.cacheStatsValue}>
          {cacheStatsLoading
            ? '-- · -- 个项目（加载中）'
            : `${formatSize(snapshot.cacheStats!.totalSizeBytes)} · ${snapshot.cacheStats!.projectCount} 个项目`}
        </span>
      </div>

      {/* Loading */}
      {snapshot.isLoading && (
        <div style={styles.loading}>加载中...</div>
      )}

      {/* 项目列表 */}
      {!snapshot.isLoading && snapshot.recentProjects.length === 0 && (
        <div style={styles.empty}>
          <p>还没有项目</p>
          <p style={styles.emptyHint}>点击"新建项目"上传音频文件开始分离</p>
        </div>
      )}

      {snapshot.recentProjects.length > 0 && (
        <div style={styles.list}>
          {snapshot.recentProjects.map((project) => (
            <div
              key={project.id}
              style={styles.card}
              onClick={() => handleProjectClick(project)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleProjectClick(project);
              }}
            >
              <div style={styles.cardLeft}>
                <div style={styles.projectName}>{project.displayName}</div>
                <div style={styles.projectMeta}>
                  {project.stemCount > 0 && `${project.stemCount} 轨 · `}
                  {formatSize(project.totalSizeBytes)}
                  {' · '}
                  {formatTime(project.updatedAt)}
                </div>
              </div>
              <div style={styles.cardRight}>
                <span
                  style={{
                    ...styles.statusBadge,
                    color: STATUS_COLORS[project.status] ?? '#999',
                    borderColor: STATUS_COLORS[project.status] ?? '#999',
                  }}
                >
                  {STATUS_LABELS[project.status] ?? project.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 4. 辅助函数
// ============================================================================

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

// ============================================================================
// 5. 样式
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '24px',
    maxWidth: '800px',
    margin: '0 auto',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
  },
  title: {
    fontSize: '24px',
    fontWeight: 600,
    margin: 0,
    color: '#1a1a1a',
  },
  newButton: {
    padding: '8px 20px',
    fontSize: '14px',
    fontWeight: 500,
    backgroundColor: '#2196F3',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  cacheStats: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 16px',
    backgroundColor: '#f5f5f5',
    borderRadius: '6px',
    marginBottom: '16px',
    fontSize: '13px',
  },
  cacheStatsLabel: {
    color: '#666',
  },
  cacheStatsValue: {
    color: '#333',
    fontWeight: 500 as const,
  },
  loading: {
    textAlign: 'center' as const,
    padding: '40px',
    color: '#666',
  },
  empty: {
    textAlign: 'center' as const,
    padding: '60px 20px',
    color: '#666',
  },
  emptyHint: {
    fontSize: '14px',
    color: '#999',
    marginTop: '8px',
  },
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  card: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px',
    backgroundColor: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background-color 0.15s',
  },
  cardLeft: {
    flex: 1,
  },
  cardRight: {
    marginLeft: '16px',
  },
  projectName: {
    fontSize: '15px',
    fontWeight: 500,
    color: '#1a1a1a',
  },
  projectMeta: {
    fontSize: '13px',
    color: '#888',
    marginTop: '4px',
  },
  statusBadge: {
    fontSize: '12px',
    padding: '2px 8px',
    borderRadius: '4px',
    border: '1px solid',
    fontWeight: 500,
  },
};
