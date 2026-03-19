/**
 * @module renderer/pages/ProgressPage
 * @description 杩涘害椤?鈥?瀹炴椂鍒嗙杩涘害灞曠ず + 闃舵鍙鍖?+ 鍙栨秷
 *
 * GPT R7 Must Fix #5锛氱紦瀛樺懡涓垎鏀?鈥?cacheHit 鏃惰烦杩囪繘搴﹀睍绀? * GPT R7 Must Fix #6锛氭墍鏈夎繍琛屾€佷粠 jobStore 鍙娑堣垂锛岄〉闈笉鑷鎺ㄥ
 * GPT R7 Suggested #3锛氬凡鑰楁椂灞曠ず
 *
 * 鑱岃矗锛? * - 灞曠ず褰撳墠鍒嗙浠诲姟鐨勫疄鏃惰繘搴︽潯
 * - 灞曠ず褰撳墠闃舵鍚嶇О鍜岄樁娈靛垪琛紙鍙娲剧敓鑷?jobStore锛? * - 缂撳瓨鍛戒腑鏃跺睍绀哄揩閫熷畬鎴愭彁绀? * - 鎻愪緵鍙栨秷鎸夐挳
 * - 鍒嗙瀹屾垚鍚庡睍绀虹粨鏋滄憳瑕? * - 鍒嗙澶辫触鍚庡睍绀洪敊璇俊鎭? *
 * 鏁版嵁鏉ユ簮锛? * - IJobStore.getSnapshot() 鈥?杩涘害銆侀樁娈点€侀敊璇€佺紦瀛樺懡涓? * - IProjectStore.getSnapshot() 鈥?椤圭洰鍚嶇О锛堜粎灞曠ず鐢級
 *
 * 瀵艰埅锛? * - 瀹屾垚鍚?鈫?杩涘叆缁撴灉椤? * - 澶辫触鍚?鈫?鍙噸璇曪紙璺冲洖涓婁紶椤碉級
 */

import React, { useSyncExternalStore } from 'react';
import { IProjectStore } from '../stores/projectStore';
import { IJobStore } from '../stores/jobStore';

// ============================================================================
// 1. Props
// ============================================================================

export interface ProgressPageProps {
  projectStore: IProjectStore;
  jobStore: IJobStore;
  projectId: string;
  onNavigateToHome: () => void;
  onNavigateToUpload: () => void;
  onNavigateToResult: (projectId: string) => void;
  onCancel: (jobId?: string) => void;
}

// ============================================================================
// 2. 缁勪欢
// ============================================================================

export const ProgressPage: React.FC<ProgressPageProps> = ({
  projectStore,
  jobStore,
  projectId,
  onNavigateToHome,
  onNavigateToUpload,
  onNavigateToResult,
  onCancel,
}) => {
  const projectSnap = useSyncExternalStore(
    (cb) => projectStore.subscribe(cb),
    () => projectStore.getSnapshot(),
  );

  const jobSnap = useSyncExternalStore(
    (cb) => jobStore.subscribe(cb),
    () => jobStore.getSnapshot(),
  );

  const projectName = projectSnap.currentProject?.displayName ?? '未命名项目';

  // GPT R7 Must Fix #6锛氭墍鏈夎繍琛屾€佺洿鎺ヤ粠 jobStore snapshot 璇诲彇锛屼笉鎺ㄥ
  const { isRunning, isComplete, isFailed, cacheHit, progress, stageDisplayName,
    errorMessage, warnings, currentStageIndex, orderedStages, elapsedMs } = jobSnap;

  return (
    <div className="progress-page" style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.title}>{projectName}</h2>
        <span style={styles.statusText}>
          {isRunning
            ? (cacheHit ? '缓存命中，快速处理中...' : '分离中...')
            : isComplete
              ? '分离完成'
              : isFailed
                ? '分离失败'
                : '等待中'}
        </span>
      </div>

      {/* GPT R7 Must Fix #5锛氱紦瀛樺懡涓彁绀?*/}
      {cacheHit && isRunning && (
        <div style={styles.cacheHitBanner}>
          已检测到缓存，正在快速恢复结果...
        </div>
      )}

      {/* Progress Bar */}
      <div style={styles.progressContainer}>
        <div style={styles.progressTrack}>
          <div
            style={{
              ...styles.progressFill,
              width: `${Math.min(100, progress)}%`,
              backgroundColor: isFailed ? '#F44336' : isComplete ? '#4CAF50' : '#2196F3',
            }}
          />
        </div>
        <div style={styles.progressLabel}>
          {progress.toFixed(0)}%
        </div>
      </div>

      {/* Current Stage + Elapsed Time锛圙PT R7 Suggested #3锛?*/}
      {isRunning && (
        <div style={styles.stageRow}>
          {stageDisplayName && (
            <span style={styles.currentStage}>{stageDisplayName}</span>
          )}
          <span style={styles.elapsed}>{formatElapsed(elapsedMs)}</span>
        </div>
      )}

      {/* Stage Timeline 鈥?GPT R7 Must Fix #6锛氫粠 jobSnap.orderedStages 璇诲彇 */}
      {!cacheHit && (
        <div style={styles.timeline}>
          {orderedStages.map((stageItem, index) => {
            const isPast = index < currentStageIndex;
            const isCurrent = index === currentStageIndex;
            const isFuture = index > currentStageIndex;

            return (
              <div
                key={stageItem.key}
                style={{
                  ...styles.timelineItem,
                  opacity: isFuture ? 0.4 : 1,
                }}
              >
                <div
                  style={{
                    ...styles.timelineDot,
                    backgroundColor: isPast
                      ? '#4CAF50'
                      : isCurrent
                        ? '#2196F3'
                        : '#ddd',
                  }}
                />
                <span
                  style={{
                    ...styles.timelineLabel,
                    fontWeight: isCurrent ? 600 : 400,
                    color: isCurrent ? '#2196F3' : isPast ? '#4CAF50' : '#999',
                  }}
                >
                  {stageItem.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Error */}
      {isFailed && (
        <div style={styles.errorBox}>
          <div style={styles.errorTitle}>分离失败</div>
          <div style={styles.errorMessage}>{errorMessage}</div>
          <button style={styles.retryButton} onClick={onNavigateToUpload}>
            重新上传
          </button>
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div style={styles.warningsBox}>
          <div style={styles.warningsTitle}>提示</div>
          {warnings.map((w, i) => (
            <div key={i} style={styles.warningItem}>{w}</div>
          ))}
        </div>
      )}

      {/* Success */}
      {isComplete && (
        <div style={styles.successBox}>
          <div style={styles.successTitle}>
            {cacheHit ? '缓存恢复完成' : '分离完成'}
          </div>
          {projectSnap.currentProject && (
            <div style={styles.successMeta}>
              共 {projectSnap.currentProject.stemCount} 轨{cacheHit && ' · 来自缓存'}
            </div>
          )}
          <div style={styles.successActions}>
            <button
              style={styles.resultButton}
              onClick={() => onNavigateToResult(projectId)}
            >
              查看结果
            </button>
            <button style={styles.homeButton} onClick={onNavigateToHome}>
              返回首页
            </button>
          </div>
        </div>
      )}

      {/* Cancel Button */}
      {isRunning && (
        <div style={styles.actions}>
          <button
            style={styles.cancelButton}
            onClick={() => onCancel(jobSnap.currentJobId ?? undefined)}
          >
            取消分离
          </button>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 3. 杈呭姪鍑芥暟
// ============================================================================

/**
 * GPT R7 Suggested #3锛氬皢 ms 鏍煎紡鍖栦负浜虹被鍙宸茶€楁椂
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return '< 1 秒';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}:${String(remainSec).padStart(2, '0')}`;
}

// ============================================================================
// 4. 鏍峰紡
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '24px',
    maxWidth: '600px',
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
    fontSize: '20px',
    fontWeight: 600,
    margin: 0,
    color: '#1a1a1a',
  },
  statusText: {
    fontSize: '14px',
    color: '#666',
    fontWeight: 500,
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
  progressContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '8px',
  },
  progressTrack: {
    flex: 1,
    height: '8px',
    backgroundColor: '#e0e0e0',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: '4px',
    transition: 'width 0.3s ease-out',
  },
  progressLabel: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#333',
    minWidth: '40px',
    textAlign: 'right' as const,
  },
  stageRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
  },
  currentStage: {
    fontSize: '14px',
    color: '#2196F3',
    fontWeight: 500,
  },
  elapsed: {
    fontSize: '13px',
    color: '#888',
    fontFamily: 'monospace',
  },
  timeline: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
    marginBottom: '32px',
    paddingLeft: '8px',
  },
  timelineItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  timelineDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  timelineLabel: {
    fontSize: '13px',
  },
  errorBox: {
    padding: '16px',
    backgroundColor: '#ffebee',
    borderRadius: '8px',
    marginBottom: '16px',
  },
  errorTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: '#c62828',
    marginBottom: '8px',
  },
  errorMessage: {
    fontSize: '14px',
    color: '#b71c1c',
    marginBottom: '12px',
  },
  retryButton: {
    padding: '8px 16px',
    fontSize: '14px',
    backgroundColor: '#F44336',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  warningsBox: {
    padding: '12px 16px',
    backgroundColor: '#fff3e0',
    borderRadius: '8px',
    marginBottom: '16px',
  },
  warningsTitle: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#e65100',
    marginBottom: '6px',
  },
  warningItem: {
    fontSize: '13px',
    color: '#bf360c',
    marginBottom: '4px',
  },
  successBox: {
    padding: '16px',
    backgroundColor: '#e8f5e9',
    borderRadius: '8px',
    textAlign: 'center' as const,
    marginBottom: '16px',
  },
  successTitle: {
    fontSize: '18px',
    fontWeight: 600,
    color: '#2e7d32',
    marginBottom: '8px',
  },
  successMeta: {
    fontSize: '14px',
    color: '#4CAF50',
    marginBottom: '12px',
  },
  successActions: {
    display: 'flex',
    gap: '12px',
    justifyContent: 'center',
  },
  resultButton: {
    padding: '10px 24px',
    fontSize: '14px',
    backgroundColor: '#4CAF50',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 600,
  },
  homeButton: {
    padding: '10px 24px',
    fontSize: '14px',
    backgroundColor: 'transparent',
    color: '#4CAF50',
    border: '1px solid #4CAF50',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  actions: {
    textAlign: 'center' as const,
    marginTop: '24px',
  },
  cancelButton: {
    padding: '10px 24px',
    fontSize: '14px',
    backgroundColor: 'transparent',
    color: '#F44336',
    border: '1px solid #F44336',
    borderRadius: '6px',
    cursor: 'pointer',
  },
};

