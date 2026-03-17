/**
 * @module renderer/pages/ResultPage
 * @description 结果页 — 项目统计 + 分轨列表 + 操作入口
 *
 * GPT R8 Must Fix #1：数据链路正式闭环 — 通过 projectStore.loadProjectResult()
 *   获取 ProjectResultSummaryDTO + StemTrackDTO[]。
 * GPT R8 Must Fix #2：打开本地目录入口。
 * GPT R8 Must Fix #3：项目级统计信息（来源/耗时/大小/轨数）。
 * GPT R8 Must Fix #4：mergedFrom 展示 + 缺轨说明文案。
 * GPT R8 Must Fix #5：导出按钮显式 disabled + reason。
 * GPT R8 Must Fix #6：cache hit + sourceType 统一从 DTO 读取，页面不推断。
 * GPT R8 Suggested #1：预留"进入播放器"action prop。
 * GPT R10 Fix：onNavigateToPlayer 升级为 required prop —
 *   PlayerPage 已在 R10 正式落地，导航入口不再是"预留"。
 * GPT R8 Suggested #5：和弦分析摘要占位区域。
 *
 * 职责：
 * - 展示项目结果摘要（名称、来源类型、耗时、总大小、轨数、缓存命中）
 * - 展示分轨列表（类型、编码、大小、时长、存在状态、合并来源）
 * - 提供打开目录、进入播放器入口
 * - 导出按钮 disabled + 明确文案
 * - 和弦分析摘要占位
 *
 * 数据来源：
 * - IProjectStore.getSnapshot().projectResult — 项目结果摘要
 * - IProjectStore.getSnapshot().stems — 分轨列表
 *
 * 不负责：
 * - 播放控制 → playbackStore
 * - 实际导出 → exportService（后续 Round）
 * - 和弦分析逻辑 → analysisStore（后续 Round）
 */

import React, { useEffect, useSyncExternalStore, useCallback, useState } from 'react';
import { IProjectStore } from '../stores/projectStore';
import { IAnalysisStore } from '../stores/analysisStore';
import { IExportService } from '../services/exportService';
import type { StemTrackDTO, StemPresence, ExportRequestDTO } from '../../shared/contracts';

// ============================================================================
// 1. Props
// ============================================================================

export interface ResultPageProps {
  projectStore: IProjectStore;
  /** R12：和弦分析数据源 */
  analysisStore: IAnalysisStore;
  /** R12：导出服务 */
  exportService: IExportService;
  projectId: string;
  onNavigateToHome: () => void;
  onNavigateToUpload: () => void;
  /**
   * 进入播放器（GPT R8 Suggested #1 → R10 升级为 required）
   *
   * PlayerPage 已在 Round 10 正式落地，此导航回调为必需。
   * 调用方负责路由跳转到 PlayerPage 并传入 projectId。
   */
  onNavigateToPlayer: (projectId: string) => void;
}

// ============================================================================
// 2. 轨道类型显示映射
// ============================================================================

const STEM_TYPE_LABELS: Record<string, string> = {
  vocal: '人声',
  drums: '鼓',
  bass: '贝斯',
  guitar: '吉他',
  keyboard: '键盘',
  synth: '合成器',
  other: '其他',
};

const STEM_TYPE_ICONS: Record<string, string> = {
  vocal: '\u{1F3A4}',
  drums: '\u{1F941}',
  bass: '\u{1F3B8}',
  guitar: '\u{1F3B8}',
  keyboard: '\u{1F3B9}',
  synth: '\u{1F3B6}',
  other: '\u{1F3B5}',
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  separation: '自动分离',
  manual_import: '手动导入',
  cache_hit: '缓存命中',
};

/**
 * 轨道存在状态显示文案
 */
function getPresenceLabel(presence: StemPresence): string {
  switch (presence) {
    case 'exists': return '已识别';
    case 'missing': return '该轨道在本次结果中未被稳定识别';
    case 'merged': return '已合并';
  }
}

function getPresenceColor(presence: StemPresence): string {
  switch (presence) {
    case 'exists': return '#4CAF50';
    case 'missing': return '#FF9800';
    case 'merged': return '#2196F3';
  }
}

// ============================================================================
// 3. 组件
// ============================================================================

export const ResultPage: React.FC<ResultPageProps> = ({
  projectStore,
  analysisStore,
  exportService,
  projectId,
  onNavigateToHome,
  onNavigateToUpload,
  onNavigateToPlayer,
}) => {
  const snapshot = useSyncExternalStore(
    (cb) => projectStore.subscribe(cb),
    () => projectStore.getSnapshot(),
  );

  const analysisSnap = useSyncExternalStore(
    (cb) => analysisStore.subscribe(cb),
    () => analysisStore.getSnapshot(),
  );

  const [openDirError, setOpenDirError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // 加载结果数据（GPT R8 Must Fix #1）
  useEffect(() => {
    projectStore.loadProjectResult(projectId);
  }, [projectStore, projectId]);

  const { projectResult, stems, isLoading } = snapshot;

  // 打开项目目录（GPT R8 Must Fix #2）
  const handleOpenDir = useCallback(async () => {
    try {
      setOpenDirError(null);
      await projectStore.openProjectDir(projectId);
    } catch {
      setOpenDirError('无法打开项目目录（目录可能已被移除）');
    }
  }, [projectStore, projectId]);

  // 进入播放器（R10：正式导航）
  const handleEnterPlayer = useCallback(() => {
    onNavigateToPlayer(projectId);
  }, [onNavigateToPlayer, projectId]);

  // R12：全部导出
  const handleExportAll = useCallback(async () => {
    const existingIds = stems
      .filter(s => s.presence === 'exists')
      .map(s => s.id);
    if (existingIds.length === 0) return;

    try {
      setExportBusy(true);
      setExportError(null);

      const outputDir = await exportService.selectOutputDir();
      if (!outputDir) {
        setExportBusy(false);
        return; // 用户取消
      }

      const request: ExportRequestDTO = {
        projectId,
        stemIds: existingIds,
        format: 'wav',
        outputDir,
      };

      const result = await exportService.exportStems(request);
      if (!result.allSuccess) {
        const failedCount = result.results.filter(r => !r.success).length;
        setExportError(`${failedCount} 个轨道导出失败`);
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExportBusy(false);
    }
  }, [exportService, projectId, stems]);

  // 分组：已存在 / 已合并 / 缺失
  const existingStems = stems.filter(s => s.presence === 'exists');
  const mergedStems = stems.filter(s => s.presence === 'merged');
  const missingStems = stems.filter(s => s.presence === 'missing');

  if (isLoading && !projectResult) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>加载项目结果...</div>
      </div>
    );
  }

  return (
    <div className="result-page" style={styles.container}>
      {/* === 项目统计摘要（GPT R8 Must Fix #3） === */}
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>
            {projectResult?.displayName ?? '未命名项目'}
          </h2>
          <div style={styles.meta}>
            {projectResult && (
              <>
                <span style={styles.metaTag}>
                  {projectResult.sourceTypeLabel
                    ?? SOURCE_TYPE_LABELS[projectResult.sourceType]
                    ?? projectResult.sourceType}
                </span>
                {' · '}
                {stems.filter(s => s.presence === 'exists').length} 轨
                {' · '}
                {formatSize(projectResult.totalSizeBytes)}
                {projectResult.durationMs != null && (
                  <> · {formatDuration(projectResult.durationMs)}</>
                )}
                {projectResult.elapsedMs != null && (
                  <> · 耗时 {formatElapsed(projectResult.elapsedMs)}</>
                )}
              </>
            )}
          </div>
        </div>
        <button style={styles.newButton} onClick={onNavigateToUpload}>
          + 新建项目
        </button>
      </div>

      {/* === 缓存命中提示（GPT R8 Must Fix #6：从 DTO 读取） === */}
      {projectResult?.cacheHit && projectResult.cacheHitBannerText && (
        <div style={styles.cacheHitBanner}>
          {projectResult.cacheHitBannerText}
        </div>
      )}

      {/* === 操作栏 === */}
      <div style={styles.actionBar}>
        <button style={styles.actionButton} onClick={handleOpenDir}>
          📂 打开目录
        </button>
        <button
          style={{
            ...styles.actionButton,
            ...styles.playerButton,
            ...(existingStems.length === 0 ? styles.playerButtonDisabled : {}),
          }}
          onClick={handleEnterPlayer}
          disabled={existingStems.length === 0}
          title={existingStems.length === 0 ? '没有可播放的轨道' : '打开播放器'}
        >
          ▶ 进入播放器
        </button>
      </div>
      {openDirError && (
        <div style={styles.inlineError}>{openDirError}</div>
      )}

      {/* === 已识别轨道列表 === */}
      {existingStems.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>已识别轨道 ({existingStems.length})</h3>
          <div style={styles.trackList}>
            {existingStems.map(stem => (
              <StemTrackCard key={stem.id} stem={stem} />
            ))}
          </div>
        </div>
      )}

      {/* === 已合并轨道（GPT R8 Must Fix #4：mergedFrom 展示） === */}
      {mergedStems.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>已合并轨道 ({mergedStems.length})</h3>
          <div style={styles.trackList}>
            {mergedStems.map(stem => (
              <StemTrackCard key={stem.id} stem={stem} />
            ))}
          </div>
        </div>
      )}

      {/* === 缺失轨道（GPT R8 Must Fix #4：缺轨说明） === */}
      {missingStems.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>未识别轨道 ({missingStems.length})</h3>
          <div style={styles.trackList}>
            {missingStems.map(stem => (
              <StemTrackCard key={stem.id} stem={stem} />
            ))}
          </div>
        </div>
      )}

      {/* === 空结果 === */}
      {stems.length === 0 && !isLoading && (
        <div style={styles.emptyState}>未找到分轨结果</div>
      )}

      {/* === 和弦分析摘要（R12：正式集成 analysisStore） === */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>和弦分析</h3>
        {analysisSnap.loadingState === 'loading' && (
          <div style={styles.chordPlaceholder}>和弦分析加载中...</div>
        )}
        {analysisSnap.loadingState === 'empty' && (
          <div style={styles.chordPlaceholder}>未检测到和弦分析结果</div>
        )}
        {analysisSnap.loadingState === 'error' && (
          <div style={styles.chordErrorBox}>
            {analysisSnap.error?.userMessage ?? '和弦分析加载失败'}
          </div>
        )}
        {analysisSnap.loadingState === 'loaded' && (
          <div style={styles.chordSummaryBox}>
            <div style={styles.chordSummaryRow}>
              <span style={styles.chordSummaryLabel}>和弦片段</span>
              <span style={styles.chordSummaryValue}>{analysisSnap.segmentCount} 个</span>
            </div>
            {analysisSnap.estimatedKey && (
              <div style={styles.chordSummaryRow}>
                <span style={styles.chordSummaryLabel}>调性</span>
                <span style={styles.chordSummaryValue}>
                  {analysisSnap.estimatedKey}
                  <span style={styles.estimatedTag}>估计值</span>
                </span>
              </div>
            )}
            {analysisSnap.estimatedBpm != null && (
              <div style={styles.chordSummaryRow}>
                <span style={styles.chordSummaryLabel}>BPM</span>
                <span style={styles.chordSummaryValue}>
                  {Math.round(analysisSnap.estimatedBpm)}
                  <span style={styles.estimatedTag}>估计值</span>
                </span>
              </div>
            )}
            {analysisSnap.source && (
              <div style={styles.chordSummaryRow}>
                <span style={styles.chordSummaryLabel}>分析来源</span>
                <span style={styles.chordSummaryValue}>{analysisSnap.source}</span>
              </div>
            )}
            {/* R12-Fix MF#5：规格文档 §22.8 要求的完整字段 */}
            {analysisSnap.elapsedMs != null && (
              <div style={styles.chordSummaryRow}>
                <span style={styles.chordSummaryLabel}>分析耗时</span>
                <span style={styles.chordSummaryValue}>
                  {analysisSnap.elapsedMs < 1000
                    ? `${analysisSnap.elapsedMs} ms`
                    : `${(analysisSnap.elapsedMs / 1000).toFixed(1)} 秒`}
                </span>
              </div>
            )}
            {analysisSnap.analysisVersion && (
              <div style={styles.chordSummaryRow}>
                <span style={styles.chordSummaryLabel}>引擎版本</span>
                <span style={styles.chordSummaryValue}>{analysisSnap.analysisVersion}</span>
              </div>
            )}
            {analysisSnap.vocabularyVersion && (
              <div style={styles.chordSummaryRow}>
                <span style={styles.chordSummaryLabel}>词汇表版本</span>
                <span style={styles.chordSummaryValue}>{analysisSnap.vocabularyVersion}</span>
              </div>
            )}
            {/* 低置信度提示 — 从 warnings 中过滤展示 */}
            {/* 诊断警告（R12 GPT R11 Must Fix #5） */}
            {analysisSnap.warnings.length > 0 && (
              <div style={styles.chordWarnings}>
                {analysisSnap.warnings.map((w, i) => (
                  <div key={i} style={styles.chordWarningItem}>⚠ {w}</div>
                ))}
              </div>
            )}
          </div>
        )}
        {analysisSnap.loadingState === 'idle' && (
          <div style={styles.chordPlaceholder}>尚未加载和弦分析</div>
        )}
      </div>

      {/* R12：导出错误提示 */}
      {exportError && (
        <div style={styles.inlineError}>{exportError}</div>
      )}

      {/* === 底部操作 === */}
      <div style={styles.footer}>
        <button style={styles.backButton} onClick={onNavigateToHome}>
          &larr; 返回首页
        </button>
        {/* R12：全部导出（正式接入 IExportService） */}
        <button
          style={{
            ...styles.exportAllButton,
            ...(existingStems.length === 0 || exportBusy ? styles.exportAllButtonDisabled : {}),
          }}
          disabled={existingStems.length === 0 || exportBusy}
          onClick={handleExportAll}
          title={existingStems.length === 0 ? '没有可导出的轨道' : '导出所有已识别轨道'}
        >
          {exportBusy ? '导出中...' : '全部导出'}
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// 4. 子组件 — 单轨卡片
// ============================================================================

const StemTrackCard: React.FC<{ stem: StemTrackDTO }> = ({ stem }) => {
  const isMissing = stem.presence === 'missing';

  return (
    <div style={{
      ...styles.trackCard,
      ...(isMissing ? styles.trackCardMissing : {}),
    }}>
      <div style={styles.trackIcon}>
        {STEM_TYPE_ICONS[stem.stemType] ?? '\u{1F3B5}'}
      </div>
      <div style={styles.trackInfo}>
        <div style={styles.trackName}>
          {STEM_TYPE_LABELS[stem.stemType] ?? stem.stemType}
          <span style={{
            ...styles.presenceBadge,
            color: getPresenceColor(stem.presence),
            borderColor: getPresenceColor(stem.presence),
          }}>
            {stem.presence === 'exists' ? '' : getPresenceLabel(stem.presence)}
          </span>
        </div>
        <div style={styles.trackMeta}>
          {!isMissing && (
            <>
              {stem.codec.toUpperCase()} · {formatSize(stem.sizeBytes)} ·{' '}
              {stem.sampleRate / 1000}kHz · {formatDuration(stem.durationMs)}
              {stem.lastModifiedAt && (
                <> · {new Date(stem.lastModifiedAt).toLocaleDateString()}</>
              )}
            </>
          )}
          {isMissing && (
            <span style={styles.missingText}>{getPresenceLabel('missing')}</span>
          )}
        </div>
        {/* GPT R8 Must Fix #4：合并来源说明 */}
        {stem.presence === 'merged' && stem.mergedFrom && stem.mergedFrom.length > 0 && (
          <div style={styles.mergedFromText}>
            合并来源: {stem.mergedFrom.join(', ')}
          </div>
        )}
      </div>
      <div style={styles.trackActions}>
        {/* GPT R8 Must Fix #5：单轨导出 disabled + reason */}
        <button
          style={{
            ...styles.exportButton,
            ...styles.exportButtonDisabled,
          }}
          disabled
          title={isMissing ? '此轨道未被识别，无法导出' : '导出功能将在后续版本实现'}
        >
          导出
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// 5. 辅助函数
// ============================================================================

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return '< 1 秒';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}:${String(remainSec).padStart(2, '0')}`;
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
  loading: {
    textAlign: 'center' as const,
    padding: '60px',
    color: '#666',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '20px',
  },
  title: {
    fontSize: '22px',
    fontWeight: 600,
    margin: 0,
    color: '#1a1a1a',
  },
  meta: {
    fontSize: '14px',
    color: '#888',
    marginTop: '6px',
  },
  metaTag: {
    display: 'inline-block',
    padding: '1px 6px',
    backgroundColor: '#f0f0f0',
    borderRadius: '3px',
    fontSize: '12px',
    color: '#555',
    fontWeight: 500,
  },
  newButton: {
    padding: '8px 16px',
    fontSize: '14px',
    fontWeight: 500,
    backgroundColor: '#2196F3',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  cacheHitBanner: {
    padding: '10px 16px',
    backgroundColor: '#e8f5e9',
    color: '#2e7d32',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: 500,
    marginBottom: '16px',
    textAlign: 'center' as const,
  },
  actionBar: {
    display: 'flex',
    gap: '8px',
    marginBottom: '8px',
  },
  actionButton: {
    padding: '8px 16px',
    fontSize: '13px',
    backgroundColor: '#f5f5f5',
    border: '1px solid #ddd',
    borderRadius: '6px',
    cursor: 'pointer',
    color: '#333',
  },
  playerButton: {
    backgroundColor: '#2196F3',
    color: '#fff',
    border: 'none',
    fontWeight: 600,
  },
  playerButtonDisabled: {
    backgroundColor: '#90CAF9',
    cursor: 'not-allowed',
  },
  inlineError: {
    fontSize: '13px',
    color: '#c62828',
    marginBottom: '12px',
  },
  section: {
    marginBottom: '24px',
  },
  sectionTitle: {
    fontSize: '15px',
    fontWeight: 600,
    color: '#333',
    marginBottom: '10px',
    margin: '0 0 10px 0',
  },
  trackList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  trackCard: {
    display: 'flex',
    alignItems: 'center',
    padding: '14px 16px',
    backgroundColor: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    gap: '14px',
  },
  trackCardMissing: {
    backgroundColor: '#fafafa',
    borderStyle: 'dashed' as const,
    opacity: 0.7,
  },
  trackIcon: {
    fontSize: '28px',
    width: '40px',
    textAlign: 'center' as const,
    flexShrink: 0,
  },
  trackInfo: {
    flex: 1,
    minWidth: 0,
  },
  trackName: {
    fontSize: '15px',
    fontWeight: 500,
    color: '#1a1a1a',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  presenceBadge: {
    fontSize: '11px',
    padding: '1px 6px',
    borderRadius: '3px',
    border: '1px solid',
    fontWeight: 500,
  },
  trackMeta: {
    fontSize: '13px',
    color: '#888',
    marginTop: '2px',
  },
  missingText: {
    color: '#FF9800',
    fontStyle: 'italic' as const,
  },
  mergedFromText: {
    fontSize: '12px',
    color: '#2196F3',
    marginTop: '4px',
  },
  trackActions: {
    flexShrink: 0,
  },
  exportButton: {
    padding: '6px 14px',
    fontSize: '13px',
    backgroundColor: 'transparent',
    color: '#2196F3',
    border: '1px solid #2196F3',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  exportButtonDisabled: {
    color: '#bbb',
    borderColor: '#ddd',
    cursor: 'not-allowed',
  },
  chordPlaceholder: {
    padding: '20px',
    backgroundColor: '#fafafa',
    borderRadius: '8px',
    textAlign: 'center' as const,
    color: '#aaa',
    fontSize: '14px',
    border: '1px dashed #ddd',
  },
  chordErrorBox: {
    padding: '14px',
    backgroundColor: '#ffebee',
    borderRadius: '8px',
    color: '#c62828',
    fontSize: '14px',
    textAlign: 'center' as const,
  },
  chordSummaryBox: {
    padding: '14px 16px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
    border: '1px solid #e0e0e0',
  },
  chordSummaryRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '4px 0',
    fontSize: '14px',
  },
  chordSummaryLabel: {
    color: '#666',
  },
  chordSummaryValue: {
    color: '#1a1a1a',
    fontWeight: 500,
  },
  estimatedTag: {
    fontSize: '10px',
    color: '#999',
    marginLeft: '4px',
    fontStyle: 'italic' as const,
    fontWeight: 400,
  },
  chordWarnings: {
    marginTop: '8px',
    padding: '8px',
    backgroundColor: '#fff8e1',
    borderRadius: '4px',
    border: '1px solid #ffe082',
  },
  chordWarningItem: {
    fontSize: '12px',
    color: '#f57f17',
    lineHeight: '1.6',
  },
  emptyState: {
    textAlign: 'center' as const,
    padding: '40px',
    color: '#999',
    fontSize: '15px',
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: '16px',
    borderTop: '1px solid #eee',
  },
  backButton: {
    padding: '8px 16px',
    fontSize: '14px',
    backgroundColor: 'transparent',
    border: '1px solid #ddd',
    borderRadius: '6px',
    cursor: 'pointer',
    color: '#666',
  },
  exportAllButton: {
    padding: '10px 24px',
    fontSize: '14px',
    fontWeight: 600,
    backgroundColor: '#2196F3',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  exportAllButtonDisabled: {
    backgroundColor: '#bbb',
    cursor: 'not-allowed',
  },
};
