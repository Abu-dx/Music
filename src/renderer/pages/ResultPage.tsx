/**
 * @module renderer/pages/ResultPage
 * @description 缁撴灉椤?鈥?椤圭洰缁熻 + 鍒嗚建鍒楄〃 + 鎿嶄綔鍏ュ彛
 *
 * GPT R8 Must Fix #1锛氭暟鎹摼璺寮忛棴鐜?鈥?閫氳繃 projectStore.loadProjectResult()
 *   鑾峰彇 ProjectResultSummaryDTO + StemTrackDTO[]銆? * GPT R8 Must Fix #2锛氭墦寮€鏈湴鐩綍鍏ュ彛銆? * GPT R8 Must Fix #3锛氶」鐩骇缁熻淇℃伅锛堟潵婧?鑰楁椂/澶у皬/杞ㄦ暟锛夈€? * GPT R8 Must Fix #4锛歮ergedFrom 灞曠ず + 缂鸿建璇存槑鏂囨銆? * GPT R8 Must Fix #5锛氬鍑烘寜閽樉寮?disabled + reason銆? * GPT R8 Must Fix #6锛歝ache hit + sourceType 缁熶竴浠?DTO 璇诲彇锛岄〉闈笉鎺ㄦ柇銆? * GPT R8 Suggested #1锛氶鐣?杩涘叆鎾斁鍣?action prop銆? * GPT R10 Fix锛歰nNavigateToPlayer 鍗囩骇涓?required prop 鈥? *   PlayerPage 宸插湪 R10 姝ｅ紡钀藉湴锛屽鑸叆鍙ｄ笉鍐嶆槸"棰勭暀"銆? * GPT R8 Suggested #5锛氬拰寮﹀垎鏋愭憳瑕佸崰浣嶅尯鍩熴€? *
 * 鑱岃矗锛? * - 灞曠ず椤圭洰缁撴灉鎽樿锛堝悕绉般€佹潵婧愮被鍨嬨€佽€楁椂銆佹€诲ぇ灏忋€佽建鏁般€佺紦瀛樺懡涓級
 * - 灞曠ず鍒嗚建鍒楄〃锛堢被鍨嬨€佺紪鐮併€佸ぇ灏忋€佹椂闀裤€佸瓨鍦ㄧ姸鎬併€佸悎骞舵潵婧愶級
 * - 鎻愪緵鎵撳紑鐩綍銆佽繘鍏ユ挱鏀惧櫒鍏ュ彛
 * - 瀵煎嚭鎸夐挳 disabled + 鏄庣‘鏂囨
 * - 鍜屽鸡鍒嗘瀽鎽樿鍗犱綅
 *
 * 鏁版嵁鏉ユ簮锛? * - IProjectStore.getSnapshot().projectResult 鈥?椤圭洰缁撴灉鎽樿
 * - IProjectStore.getSnapshot().stems 鈥?鍒嗚建鍒楄〃
 *
 * 涓嶈礋璐ｏ細
 * - 鎾斁鎺у埗 鈫?playbackStore
 * - 瀹為檯瀵煎嚭 鈫?exportService锛堝悗缁?Round锛? * - 鍜屽鸡鍒嗘瀽閫昏緫 鈫?analysisStore锛堝悗缁?Round锛? */

import React, { useEffect, useSyncExternalStore, useCallback, useRef, useState } from 'react';
import { IProjectStore } from '../stores/projectStore';
import { IAnalysisStore } from '../stores/analysisStore';
import { IExportService } from '../services/exportService';
import type {
  StemTrackDTO,
  StemPresence,
  ExportRequestDTO,
  AnalysisErrorDTO,
  ProjectResultSummaryDTO,
} from '../../shared/contracts';

// ============================================================================
// 1. Props
// ============================================================================

export interface ResultPageProps {
  projectStore: IProjectStore;
  /** R12锛氬拰寮﹀垎鏋愭暟鎹簮 */
  analysisStore: IAnalysisStore;
  /** R12锛氬鍑烘湇鍔?*/
  exportService: IExportService;
  projectId: string;
  onNavigateToHome: () => void;
  onNavigateToUpload: () => void;
  /**
   * 杩涘叆鎾斁鍣紙GPT R8 Suggested #1 鈫?R10 鍗囩骇涓?required锛?   *
   * PlayerPage 宸插湪 Round 10 姝ｅ紡钀藉湴锛屾瀵艰埅鍥炶皟涓哄繀闇€銆?   * 璋冪敤鏂硅礋璐ｈ矾鐢辫烦杞埌 PlayerPage 骞朵紶鍏?projectId銆?   */
  onNavigateToPlayer: (projectId: string) => void;
}

// ============================================================================
// 2. 杞ㄩ亾绫诲瀷鏄剧ず鏄犲皠
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
 * 杞ㄩ亾瀛樺湪鐘舵€佹樉绀烘枃妗? *
 * 缁熶竴璇箟锛堜笌 PlayerPage 涓€鑷达級锛? * - exists锛氬凡鐢熸垚 鈥?鏈夊彲鎾斁鏂囦欢
 * - missing锛氬皻鏈敓鎴?鈥?寰呯湡瀹炲垎绂诲紩鎿庡鐞? * - merged锛氬凡鍚堝苟 鈥?澶氭簮鍚堝苟杞ㄩ亾
 */
function getPresenceLabel(presence: StemPresence): string {
  switch (presence) {
    case 'exists': return '已生成';
    case 'missing': return '尚未生成（待真实分离）';
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
// 3. 缁勪欢
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
  const [exportInfo, setExportInfo] = useState<string | null>(null);
  const [hasRequestedLoad, setHasRequestedLoad] = useState(false);
  const [projectMissing, setProjectMissing] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [pilotBusy, setPilotBusy] = useState(false);
  const [resultSetSwitchBusy, setResultSetSwitchBusy] = useState(false);
  const [pilotInfo, setPilotInfo] = useState<string | null>(null);
  const [pilotError, setPilotError] = useState<string | null>(null);
  const accessMarkedRef = useRef(false);
  const analysisLoadedForProjectRef = useRef<string | null>(null);

  const getExportWarnings = (result: unknown): string[] => {
    if (!result || typeof result !== 'object') return [];
    const maybeWarnings = (result as { warnings?: unknown }).warnings;
    if (!Array.isArray(maybeWarnings)) return [];
    return maybeWarnings.filter((w): w is string => typeof w === 'string' && w.trim().length > 0);
  };

  // 鍔犺浇缁撴灉鏁版嵁锛圙PT R8 Must Fix #1锛?
  useEffect(() => {
    console.log(`[ResultPage] loading projectId="${projectId}"`);
    setHasRequestedLoad(true);
    projectStore.loadProjectResult(projectId);
  }, [projectStore, projectId]);

  const { projectResult, stems, isLoading } = snapshot;
  const projectResultWithMeta = projectResult as (ProjectResultSummaryDTO & {
    resultSets?: Array<{ id?: string; modelId?: string; runtimeProfileId?: string }>;
    sourceFilePath?: string | null;
    activeResultModelId?: string | null;
    activeResultRuntimeProfileId?: string | null;
  }) | null;
  const activeResultId = projectResultWithMeta?.activeResultId?.trim() || 'main';
  const availableResultSets = (projectResultWithMeta?.resultSets ?? [])
    .flatMap((entry) => {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!id) return [];
      return [{
        id,
        modelId: typeof entry.modelId === 'string' ? entry.modelId.trim() : '',
        runtimeProfileId: typeof entry.runtimeProfileId === 'string' ? entry.runtimeProfileId.trim() : '',
      }];
    });
  const activeStem = stems.find((stem) => (stem.parentResultId?.trim() || 'main') === activeResultId) ?? stems[0];
  const activeResultModelLabel =
    projectResultWithMeta?.activeResultModelId
    ?? activeStem?.modelId
    ?? projectResultWithMeta?.activeResultRuntimeProfileId
    ?? activeStem?.runtimeProfileId
    ?? 'unknown';

  useEffect(() => {
    accessMarkedRef.current = false;
    analysisLoadedForProjectRef.current = null;
  }, [projectId, activeResultId]);

  // 定时刷新一次，避免“当前页项目已被删除”时继续展示旧状态
  useEffect(() => {
    const timer = window.setInterval(() => {
      projectStore.loadProjectResult(projectId).catch(() => undefined);
    }, 6000);
    return () => window.clearInterval(timer);
  }, [projectStore, projectId]);

  useEffect(() => {
    if (hasRequestedLoad && !isLoading && projectResult === null) {
      setProjectMissing(true);
    }
  }, [hasRequestedLoad, isLoading, projectResult]);

  useEffect(() => {
    if (!projectMissing) return;
    const timer = window.setTimeout(() => {
      onNavigateToHome();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [projectMissing, onNavigateToHome]);

  useEffect(() => {
    if (accessMarkedRef.current) return;
    if (!hasRequestedLoad || isLoading || !projectResult) return;
    if (projectResult.id !== projectId) return;

    accessMarkedRef.current = true;
    projectStore.markProjectAccessed(projectId).catch(() => {
      // Retry once on next stable render if IPC fails transiently.
      accessMarkedRef.current = false;
    });
  }, [hasRequestedLoad, isLoading, projectResult, projectId, projectStore]);

  useEffect(() => {
    if (!hasRequestedLoad || isLoading || !projectResult) return;
    if (projectResult.id !== projectId) return;
    const analysisLoadKey = `${projectId}::${activeResultId}`;
    if (analysisLoadedForProjectRef.current === analysisLoadKey) return;

    analysisLoadedForProjectRef.current = analysisLoadKey;
    analysisStore.setLoading(projectId);

    projectStore.getChordAnalysis(projectId)
      .then((result) => {
        analysisStore.setChordResult(result, projectId);
      })
      .catch((err) => {
        analysisLoadedForProjectRef.current = null;
        const analysisError: AnalysisErrorDTO = {
          code: 'RESULT_CHORD_LOAD_FAILED',
          message: err instanceof Error ? err.message : String(err),
          userMessage: '和弦分析加载失败',
          context: {
            projectId,
            operation: 'ResultPage.loadChordAnalysis',
          },
          retryable: true,
        };
        analysisStore.setError(analysisError, projectId);
      });
  }, [
    hasRequestedLoad,
    isLoading,
    projectResult,
    projectId,
    activeResultId,
    projectStore,
    analysisStore,
  ]);

  const handleSwitchActiveResult = useCallback(async (nextResultSetId: string) => {
    if (!nextResultSetId || nextResultSetId === activeResultId) return;
    try {
      setResultSetSwitchBusy(true);
      setPilotError(null);
      setPilotInfo(null);
      await projectStore.setActiveResult(projectId, nextResultSetId);
      analysisLoadedForProjectRef.current = null;
      await Promise.all([
        projectStore.loadProjectResult(projectId),
        projectStore.loadRecentProjects(20),
      ]);
    } catch (err) {
      setPilotError(err instanceof Error ? err.message : '结果集切换失败');
    } finally {
      setResultSetSwitchBusy(false);
    }
  }, [activeResultId, projectStore, projectId]);

  // 打开项目目录
  const handleOpenDir = useCallback(async () => {
    try {
      setOpenDirError(null);
      await projectStore.openProjectDir(projectId);
    } catch (err) {
      setOpenDirError(err instanceof Error ? err.message : '无法打开项目目录');
    }
  }, [projectStore, projectId]);

  // 杩涘叆鎾斁鍣紙R10锛氭寮忓鑸級
  const handleEnterPlayer = useCallback(() => {
    onNavigateToPlayer(projectId);
  }, [onNavigateToPlayer, projectId]);

  const handleRenameProject = useCallback(() => {
    setRenameValue(projectResult?.displayName ?? '');
    setRenameError(null);
    setRenameModalOpen(true);
  }, [projectResult?.displayName]);

  const handleCancelRename = useCallback(() => {
    if (renameBusy) return;
    setRenameModalOpen(false);
    setRenameError(null);
  }, [renameBusy]);

  const handleConfirmRename = useCallback(async () => {
    const currentName = projectResult?.displayName ?? '';
    const nextName = renameValue.trim();
    if (nextName.length === 0) {
      setRenameError('项目名称不能为空');
      return;
    }
    if (nextName === currentName) {
      setRenameModalOpen(false);
      setRenameError(null);
      return;
    }

    try {
      setRenameBusy(true);
      setRenameError(null);
      await projectStore.renameProject(projectId, nextName);
      await projectStore.loadProjectResult(projectId);
      setRenameModalOpen(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : '重命名失败');
    } finally {
      setRenameBusy(false);
    }
  }, [projectResult?.displayName, renameValue, projectStore, projectId]);

  const handleStartPilotSeparation = useCallback(async () => {
    const hasExistingPilotResultSet = (projectResultWithMeta?.resultSets ?? [])
      .some((entry) => typeof entry.id === 'string' && entry.id.startsWith('pilot_6s_'));
    if (hasExistingPilotResultSet) {
      // TODO(Phase 2): 提供“清理旧实验结果集”入口，避免长期追加过多 pilot 结果集。
      const confirmed = window.confirm(
        '继续分离将新增一个实验结果集（pilot_6s_*），不会覆盖 main 主线结果。是否继续？',
      );
      if (!confirmed) return;
    }

    try {
      setPilotBusy(true);
      setPilotError(null);
      setPilotInfo(null);
      const preferredSourceFilePath =
        (typeof projectResultWithMeta?.sourceFilePath === 'string' && projectResultWithMeta.sourceFilePath.trim().length > 0)
          ? projectResultWithMeta.sourceFilePath.trim()
          : undefined;
      const result = await projectStore.startPilotSeparation(projectId, preferredSourceFilePath);
      setPilotInfo(`实验6轨任务已启动（jobId: ${result.jobId}）`);
      await Promise.all([
        projectStore.loadProjectResult(projectId),
        projectStore.loadRecentProjects(20),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('PILOT_SOURCE_PATH_REQUIRED')) {
        setPilotError('缺少可用的原始音频路径。请先重新选择源音频文件，再启动实验6轨分离。');
      } else {
        setPilotError(message || '实验6轨分离启动失败');
      }
    } finally {
      setPilotBusy(false);
    }
  }, [projectResultWithMeta?.resultSets, projectResultWithMeta?.sourceFilePath, projectStore, projectId]);

  // 全部导出
  const handleExportAll = useCallback(async () => {
    const existingIds = stems
      .filter((s) => s.presence === 'exists')
      .map((s) => s.id);
    if (existingIds.length === 0) return;

    try {
      setExportBusy(true);
      setExportError(null);
      setExportInfo(null);

      const outputDir = await exportService.selectOutputDir();
      if (!outputDir) {
        setExportBusy(false);
        return;
      }

      const request: ExportRequestDTO = {
        projectId,
        stemIds: existingIds,
        format: 'wav',
        outputDir,
      };

      const result = await exportService.exportStems(request);
      const warnings = getExportWarnings(result);
      if (!result.allSuccess) {
        const failedCount = result.results.filter((r) => !r.success).length;
        setExportError(`${failedCount} 个轨道导出失败`);
      } else if (warnings.length > 0) {
        setExportInfo(warnings.join(' '));
      } else {
        setExportInfo('导出完成');
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExportBusy(false);
    }
  }, [exportService, projectId, stems]);

  // 单轨导出
  const handleExportSingle = useCallback(async (stem: StemTrackDTO) => {
    if (stem.presence !== 'exists' || !stem.filePath) return;

    try {
      setExportBusy(true);
      setExportError(null);
      setExportInfo(null);

      const outputDir = await exportService.selectOutputDir();
      if (!outputDir) {
        setExportBusy(false);
        return;
      }

      const request: ExportRequestDTO = {
        projectId,
        stemIds: [stem.id],
        format: 'wav',
        outputDir,
      };

      const result = await exportService.exportStems(request);
      const warnings = getExportWarnings(result);
      if (!result.allSuccess) {
        const failed = result.results.find((r) => r.status === 'failed');
        const skipped = result.results.find((r) => r.status === 'skipped');
        if (failed?.error?.userMessage) {
          setExportError(failed.error.userMessage);
        } else if (skipped) {
          setExportError('该轨道当前不可导出');
        } else {
          setExportError('轨道导出失败');
        }
      } else if (warnings.length > 0) {
        setExportInfo(warnings.join(' '));
      } else {
        setExportInfo('轨道导出完成');
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '轨道导出失败');
    } finally {
      setExportBusy(false);
    }
  }, [exportService, projectId]);

  // 鍒嗙粍锛氬凡瀛樺湪 / 宸插悎骞?/ 缂哄け
  const existingStems = stems.filter(s => s.presence === 'exists');
  const mergedStems = stems.filter(s => s.presence === 'merged');
  const missingStems = stems.filter(s => s.presence === 'missing');
  // Header track count must be derived from the same grouped lists used by the UI sections.
  const headerTrackCount = [existingStems, mergedStems, missingStems]
    .reduce((sum, group) => sum + group.length, 0);

  if (isLoading && !projectResult) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>加载项目结果...</div>
      </div>
    );
  }

  if (projectMissing) {
    return (
      <div style={styles.container}>
        <div style={styles.invalidProjectBox}>
          <div style={styles.invalidProjectTitle}>项目不可用</div>
          <div style={styles.invalidProjectText}>当前项目已被删除或失效，正在返回首页...</div>
          <div style={styles.invalidProjectActions}>
            <button style={styles.backButton} onClick={onNavigateToHome}>
              返回首页
            </button>
            <button style={styles.newButton} onClick={onNavigateToUpload}>
              新建项目
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="result-page" style={styles.container}>
      {/* === 椤圭洰缁熻鎽樿锛圙PT R8 Must Fix #3锛?=== */}
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
                {headerTrackCount} 轨 {' · '}
                {formatSize(projectResult.totalSizeBytes)}
                {' · '}
                当前结果 {activeResultId} · 模型 {activeResultModelLabel}
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
        <div style={styles.headerActions}>
          <button style={styles.headerButton} onClick={handleRenameProject}>
            重命名
          </button>
          <button style={styles.newButton} onClick={onNavigateToUpload}>
            + 新建项目
          </button>
        </div>
      </div>
      <div style={styles.experimentalHint}>实验功能：新增 pilot 结果集，不覆盖 main 主线结果。</div>

      {/* === mock 鏁版嵁鎻愮ず === */}
      {projectResult?.sourceTypeLabel?.includes('模拟') && (
        <div style={styles.mockBanner}>
          <strong>当前仅提供原始音频试听：</strong>
          目前尚未生成真实分轨文件。波形、和弦、BPM、Key 仍为示例数据。
        </div>
      )}

      {/* === 缂撳瓨鍛戒腑鎻愮ず锛圙PT R8 Must Fix #6锛氫粠 DTO 璇诲彇锛?=== */}
      {projectResult?.cacheHit && projectResult.cacheHitBannerText && (
        <div style={styles.cacheHitBanner}>
          {projectResult.cacheHitBannerText}
        </div>
      )}

      {/* === 操作栏 === */}
      <div style={styles.actionBar}>
        {availableResultSets.length > 1 && (
          <label style={styles.resultSetSelector}>
            结果集
            <select
              value={activeResultId}
              disabled={resultSetSwitchBusy}
              style={styles.resultSetSelect}
              onChange={(e) => {
                void handleSwitchActiveResult(e.target.value);
              }}
            >
              {availableResultSets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.id}
                </option>
              ))}
            </select>
          </label>
        )}
        <button style={styles.actionButton} onClick={handleOpenDir}>
          打开结果目录
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
          进入播放器
        </button>
        <button
          style={{
            ...styles.actionButton,
            ...(pilotBusy ? styles.playerButtonDisabled : {}),
          }}
          onClick={handleStartPilotSeparation}
          disabled={pilotBusy}
          title="实验功能：新增 pilot_6s_* 结果集，不覆盖 main"
        >
          {pilotBusy ? '实验6轨启动中...' : '实验6轨分离'}
        </button>
      </div>
      {openDirError && (
        <div style={styles.inlineError}>{openDirError}</div>
      )}
      {pilotError && (
        <div style={styles.inlineError}>{pilotError}</div>
      )}
      {pilotInfo && (
        <div style={styles.inlineInfo}>{pilotInfo}</div>
      )}

      {/* === 已生成轨道 === */}
      {existingStems.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>已生成轨道 ({existingStems.length})</h3>
          <div style={styles.trackList}>
            {existingStems.map(stem => (
              <StemTrackCard
                key={stem.id}
                stem={stem}
                exportBusy={exportBusy}
                onExportSingle={handleExportSingle}
              />
            ))}
          </div>
        </div>
      )}

      {/* === 已合并轨道 === */}
      {mergedStems.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>已合并轨道 ({mergedStems.length})</h3>
          <div style={styles.trackList}>
            {mergedStems.map(stem => (
              <StemTrackCard
                key={stem.id}
                stem={stem}
                exportBusy={exportBusy}
                onExportSingle={handleExportSingle}
              />
            ))}
          </div>
        </div>
      )}

      {/* === 待生成轨道 === */}
      {missingStems.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>待生成轨道 ({missingStems.length})</h3>
          <div style={styles.trackList}>
            {missingStems.map(stem => (
              <StemTrackCard
                key={stem.id}
                stem={stem}
                exportBusy={exportBusy}
                onExportSingle={handleExportSingle}
              />
            ))}
          </div>
        </div>
      )}

      {/* === 空结果 === */}
      {stems.length === 0 && !isLoading && (
        <div style={styles.emptyState}>当前结果集暂无可读轨道</div>
      )}

      {/* === 鍜屽鸡鍒嗘瀽鎽樿锛圧12锛氭寮忛泦鎴?analysisStore锛?=== */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>
          和弦分析
          {analysisSnap.source === 'mock_stub' && (
            <span style={styles.mockBadge}>示例数据</span>
          )}
        </h3>
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
                  <span style={styles.estimatedTag}>
                    {analysisSnap.source === 'mock_stub' ? '示例' : '估计值'}
                  </span>
                </span>
              </div>
            )}
            {analysisSnap.estimatedBpm != null && (
              <div style={styles.chordSummaryRow}>
                <span style={styles.chordSummaryLabel}>BPM</span>
                <span style={styles.chordSummaryValue}>
                  {Math.round(analysisSnap.estimatedBpm)}
                  <span style={styles.estimatedTag}>
                    {analysisSnap.source === 'mock_stub' ? '示例' : '估计值'}
                  </span>
                </span>
              </div>
            )}
            {analysisSnap.source && (
              <div style={styles.chordSummaryRow}>
                <span style={styles.chordSummaryLabel}>分析来源</span>
                <span style={styles.chordSummaryValue}>{analysisSnap.source}</span>
              </div>
            )}
            {/* R12-Fix MF#5锛氳鏍兼枃妗?搂22.8 瑕佹眰鐨勫畬鏁村瓧娈?*/}
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
          </div>
        )}
        {analysisSnap.loadingState === 'idle' && (
          <div style={styles.chordPlaceholder}>尚未加载和弦分析</div>
        )}
      </div>

      {/* R12锛氬鍑洪敊璇彁绀?*/}
      {exportError && (
        <div style={styles.inlineError}>{exportError}</div>
      )}
      {exportInfo && (
        <div style={styles.inlineInfo}>{exportInfo}</div>
      )}

      {renameModalOpen && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modalCard}>
            <div style={styles.modalTitle}>重命名工程</div>
            <input
              style={styles.modalInput}
              type="text"
              value={renameValue}
              autoFocus
              disabled={renameBusy}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleConfirmRename();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  handleCancelRename();
                }
              }}
            />
            {renameError && (
              <div style={styles.modalError}>{renameError}</div>
            )}
            <div style={styles.modalActions}>
              <button
                style={styles.modalSecondaryButton}
                onClick={handleCancelRename}
                disabled={renameBusy}
              >
                取消
              </button>
              <button
                style={styles.modalPrimaryButton}
                onClick={handleConfirmRename}
                disabled={renameBusy}
              >
                {renameBusy ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === 底部操作 === */}
      <div style={styles.footer}>
        <button style={styles.backButton} onClick={onNavigateToHome}>
          &larr; 返回首页
        </button>
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
// 4. 瀛愮粍浠?鈥?鍗曡建鍗＄墖
// ============================================================================

const StemTrackCard: React.FC<{
  stem: StemTrackDTO;
  exportBusy: boolean;
  onExportSingle: (stem: StemTrackDTO) => void;
}> = ({ stem, exportBusy, onExportSingle }) => {
  const isMissing = stem.presence === 'missing';
  const canExport =
    stem.presence === 'exists'
    && typeof stem.filePath === 'string'
    && stem.filePath.trim().length > 0
    && stem.exportable;
  const exportDisabled = exportBusy || !canExport;
  const exportTitle = exportBusy
    ? '导出进行中，请稍候'
    : isMissing
      ? '此轨道未被识别，无法导出'
      : !stem.filePath
        ? '轨道文件不存在，无法导出'
        : (!stem.exportable ? '该轨道当前不可导出' : '导出此轨道');

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
        {/* GPT R8 Must Fix #4锛氬悎骞舵潵婧愯鏄?*/}
        {stem.presence === 'merged' && stem.mergedFrom && stem.mergedFrom.length > 0 && (
          <div style={styles.mergedFromText}>
            合并来源: {stem.mergedFrom.join(', ')}
          </div>
        )}
        {(stem.parentResultId || stem.modelId || stem.runtimeProfileId) && (
          <div style={styles.stemSourceText}>
            来源: {stem.parentResultId ?? 'main'} · {stem.modelId ?? stem.runtimeProfileId ?? 'unknown'}
          </div>
        )}
      </div>
      <div style={styles.trackActions}>
        {/* GPT R8 Must Fix #5锛氬崟杞ㄥ鍑?disabled + reason */}
        <button
          style={{
            ...styles.exportButton,
            ...(exportDisabled ? styles.exportButtonDisabled : {}),
          }}
          disabled={exportDisabled}
          title={exportTitle}
          onClick={() => onExportSingle(stem)}
        >
          {exportBusy ? '导出中...' : '导出'}
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// 5. 杈呭姪鍑芥暟
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
// 6. 鏍峰紡
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
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
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
  headerButton: {
    padding: '8px 12px',
    fontSize: '13px',
    backgroundColor: '#f5f5f5',
    border: '1px solid #ddd',
    borderRadius: '6px',
    cursor: 'pointer',
    color: '#333',
    whiteSpace: 'nowrap' as const,
  },
  modalBackdrop: {
    position: 'fixed' as const,
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
    padding: '16px',
  },
  modalCard: {
    width: '100%',
    maxWidth: '360px',
    backgroundColor: '#fff',
    borderRadius: '10px',
    border: '1px solid #e0e0e0',
    padding: '16px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.16)',
  },
  modalTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: '#1a1a1a',
    marginBottom: '12px',
  },
  modalInput: {
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '8px 10px',
    border: '1px solid #d0d0d0',
    borderRadius: '6px',
    fontSize: '14px',
    marginBottom: '8px',
  },
  modalError: {
    fontSize: '12px',
    color: '#c62828',
    marginBottom: '8px',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  },
  modalSecondaryButton: {
    padding: '6px 12px',
    fontSize: '13px',
    color: '#333',
    backgroundColor: '#f5f5f5',
    border: '1px solid #ddd',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  modalPrimaryButton: {
    padding: '6px 12px',
    fontSize: '13px',
    color: '#fff',
    backgroundColor: '#2196F3',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
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
    alignItems: 'center',
    flexWrap: 'wrap' as const,
  },
  resultSetSelector: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    color: '#666',
  },
  resultSetSelect: {
    border: '1px solid #d5d5d5',
    borderRadius: '6px',
    padding: '6px 8px',
    fontSize: '12px',
    backgroundColor: '#fff',
    color: '#333',
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
  inlineInfo: {
    fontSize: '13px',
    color: '#2e7d32',
    marginBottom: '12px',
  },
  experimentalHint: {
    marginTop: '-4px',
    marginBottom: '10px',
    fontSize: '12px',
    color: '#666',
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
  stemSourceText: {
    fontSize: '12px',
    color: '#6a6a6a',
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
  mockBanner: {
    padding: '12px 16px',
    backgroundColor: '#fff3e0',
    color: '#e65100',
    borderRadius: '6px',
    fontSize: '13px',
    lineHeight: '1.6',
    marginBottom: '16px',
    border: '1px solid #ffe0b2',
  },
  mockBadge: {
    display: 'inline-block',
    marginLeft: '8px',
    padding: '1px 6px',
    fontSize: '10px',
    fontWeight: 500,
    color: '#e65100',
    backgroundColor: '#fff3e0',
    border: '1px solid #ffe0b2',
    borderRadius: '3px',
    verticalAlign: 'middle',
  },
  invalidProjectBox: {
    marginTop: '40px',
    padding: '16px',
    backgroundColor: '#fff3e0',
    border: '1px solid #ffe0b2',
    borderRadius: '8px',
    textAlign: 'center' as const,
  },
  invalidProjectTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: '#e65100',
    marginBottom: '8px',
  },
  invalidProjectText: {
    fontSize: '14px',
    color: '#bf360c',
    marginBottom: '12px',
  },
  invalidProjectActions: {
    display: 'flex',
    justifyContent: 'center',
    gap: '8px',
  },
};

