/**
 * @module renderer/pages/UploadPage
 * @description 涓婁紶椤?鈥?鏂囦欢閫夋嫨 + 鍚姩鍒嗙
 *
 * 鑱岃矗锛? * - 鎻愪緵鏂囦欢鎷栨斁鍖哄煙鍜屾枃浠堕€夋嫨鎸夐挳
 * - 鏄剧ず宸查€夋枃浠朵俊鎭紙鍚嶇О銆佸ぇ灏忋€佹牸寮忥級
 * - 鏍￠獙鏂囦欢鏍煎紡锛堝墠绔鏍￠獙锛屽悗绔仛鏈€缁堟牎楠岋級
 * - 鐐瑰嚮"寮€濮嬪垎绂?鍚庤皟鐢?ProjectStore.startSeparation()
 * - 鍚姩鎴愬姛鍚庤嚜鍔ㄨ烦杞埌 ProgressPage
 *
 * 鏁版嵁鏉ユ簮锛? * - 鏈湴缁勪欢鐘舵€侊紙宸查€夋枃浠讹級
 * - ProjectStore 鐢ㄤ簬瑙﹀彂鍒嗙鍜岃幏鍙栭敊璇俊鎭? */

import React, { useState, useRef, useCallback, useSyncExternalStore, useEffect } from 'react';
import { IProjectStore } from '../stores/projectStore';
import { IJobStore } from '../stores/jobStore';
import { SUPPORTED_INPUT_EXTENSIONS, SelectedFileDTO } from '../../shared/contracts';

// ============================================================================
// 1. Props
// ============================================================================

export interface UploadPageProps {
  store: IProjectStore;
  jobStore: IJobStore;
  onNavigateToProgress: (projectId: string) => void;
  onNavigateToResult: (projectId: string) => void;
  onNavigateBack: () => void;
}

// ============================================================================
// 2. 缁勪欢
// ============================================================================

export const UploadPage: React.FC<UploadPageProps> = ({
  store,
  jobStore,
  onNavigateToProgress,
  onNavigateToResult,
  onNavigateBack,
}) => {
  const snapshot = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getSnapshot(),
  );

  const [selectedFile, setSelectedFile] = useState<SelectedFileDTO | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    store.loadRecentProjects(8);
  }, [store]);

  /**
   * 鍓嶇鏍煎紡棰勬牎楠?   */
  const validateFile = useCallback((file: File): string | null => {
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!SUPPORTED_INPUT_EXTENSIONS.includes(ext)) {
      return `不支持的文件格式: ${ext}（支持: ${SUPPORTED_INPUT_EXTENSIONS.join(', ')}）`;
    }
    return null;
  }, []);

  /**
   * GPT R7 Must Fix #4锛氬皢 Electron File 瀵硅薄鏄犲皠涓?SelectedFileDTO锛?   * 闅旂 Electron 鐗规湁鐨?File.path 灞炴€с€?   */
  const handleFileSelect = useCallback((file: File) => {
    const error = validateFile(file);
    setValidationError(error);
    if (error) {
      setSelectedFile(null);
      return;
    }
    // Electron 环境中 File 对象有 path 属性
    const filePath = (file as File & { path?: string }).path ?? null;
    const dto: SelectedFileDTO = {
      name: file.name,
      size: file.size,
      path: filePath,
    };
    setSelectedFile(dto);
  }, [validateFile]);

  /**
   * 鏂囦欢閫夋嫨鎸夐挳
   */
  const handleButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  /**
   * 鎷栨斁澶勭悊
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  /**
   * 鍚姩鍒嗙
   */
  const handleStartSeparation = useCallback(async () => {
    if (!selectedFile) return;

    if (!selectedFile.path) {
      setValidationError('无法获取文件路径，请使用文件选择器重新选择');
      return;
    }

    try {
      const result = await store.startSeparation(selectedFile.path);

      // 鍏抽敭锛氶€氱煡 jobStore 浠诲姟宸插紑濮嬶紝鍚﹀垯 ProgressPage 涓嶄細鏀跺埌杩涘害
      jobStore.startJob(result.jobId, result.cacheHit);

      // 检查启动结果
      const snap = store.getSnapshot();
      if (snap.currentProject) {
        onNavigateToProgress(snap.currentProject.id);
      }
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : '启动分离失败，请重试');
    }
  }, [selectedFile, store, jobStore, onNavigateToProgress]);

  const handleOpenExistingProject = useCallback(async () => {
    try {
      setValidationError(null);
      const restored = await store.openExistingProject();
      if (!restored) return;
      onNavigateToResult(restored.projectId);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : '打开已有工程失败');
    }
  }, [store, onNavigateToResult]);

  const acceptStr = SUPPORTED_INPUT_EXTENSIONS.join(',');

  return (
    <div className="upload-page" style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.backButton} onClick={onNavigateBack}>
          &larr; 返回首页
        </button>
        <h2 style={styles.title}>上传音频并开始分离</h2>
      </div>

      {/* Drop Zone */}
      <div
        style={{
          ...styles.dropZone,
          ...(dragOver ? styles.dropZoneActive : {}),
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleButtonClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleButtonClick();
        }}
      >
        <div style={styles.dropIcon}>
          {selectedFile ? '\u{1F3B5}' : '\u{1F4C1}'}
        </div>
        <div style={styles.dropText}>
          {selectedFile
            ? selectedFile.name
            : '拖拽文件到此处，或点击选择音频文件'}
        </div>
        {selectedFile && (
          <div style={styles.fileMeta}>
            {formatFileSize(selectedFile.size)}
          </div>
        )}
        <div style={styles.formatHint}>
          支持格式：{SUPPORTED_INPUT_EXTENSIONS.join(' / ')}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={acceptStr}
        style={{ display: 'none' }}
        onChange={handleInputChange}
      />

      {/* Validation Error */}
      {validationError && (
        <div style={styles.error}>{validationError}</div>
      )}

      {/* Start Button */}
      <button
        style={{
          ...styles.startButton,
          ...((!selectedFile || snapshot.isLoading) ? styles.startButtonDisabled : {}),
        }}
        onClick={handleStartSeparation}
        disabled={!selectedFile || snapshot.isLoading}
      >
        {snapshot.isLoading ? '处理中...' : '开始分离'}
      </button>
      <button
        style={styles.openExistingButton}
        onClick={handleOpenExistingProject}
        disabled={snapshot.isLoading}
      >
        打开已有工程
      </button>

      {snapshot.recentProjects.length > 0 && (
        <div style={styles.recentSection}>
          <div style={styles.recentTitle}>最近项目</div>
          <div style={styles.recentList}>
            {snapshot.recentProjects.slice(0, 8).map((project) => (
              <button
                key={project.id}
                type="button"
                style={styles.recentItem}
                onClick={() => onNavigateToResult(project.id)}
                title={project.displayName}
              >
                <span style={styles.recentName}>{project.displayName}</span>
                <span style={styles.recentMeta}>
                  {project.stemCount} 轨 · {formatFileSize(project.totalSizeBytes)} · {formatRecentTime(project.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 3. 杈呭姪鍑芥暟
// ============================================================================

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRecentTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
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
    alignItems: 'center',
    gap: '12px',
    marginBottom: '32px',
  },
  backButton: {
    padding: '6px 12px',
    fontSize: '14px',
    backgroundColor: 'transparent',
    border: '1px solid #ddd',
    borderRadius: '4px',
    cursor: 'pointer',
    color: '#666',
  },
  title: {
    fontSize: '20px',
    fontWeight: 600,
    margin: 0,
    color: '#1a1a1a',
  },
  dropZone: {
    border: '2px dashed #ccc',
    borderRadius: '12px',
    padding: '48px 24px',
    textAlign: 'center' as const,
    cursor: 'pointer',
    transition: 'all 0.2s',
    backgroundColor: '#fafafa',
  },
  dropZoneActive: {
    borderColor: '#2196F3',
    backgroundColor: '#e3f2fd',
  },
  dropIcon: {
    fontSize: '48px',
    marginBottom: '12px',
  },
  dropText: {
    fontSize: '16px',
    color: '#333',
    fontWeight: 500,
  },
  fileMeta: {
    fontSize: '14px',
    color: '#888',
    marginTop: '8px',
  },
  formatHint: {
    fontSize: '12px',
    color: '#aaa',
    marginTop: '12px',
  },
  error: {
    marginTop: '16px',
    padding: '12px',
    backgroundColor: '#ffebee',
    color: '#c62828',
    borderRadius: '6px',
    fontSize: '14px',
  },
  startButton: {
    display: 'block',
    width: '100%',
    marginTop: '24px',
    padding: '14px',
    fontSize: '16px',
    fontWeight: 600,
    backgroundColor: '#2196F3',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  startButtonDisabled: {
    backgroundColor: '#bbb',
    cursor: 'not-allowed',
  },
  openExistingButton: {
    display: 'block',
    width: '100%',
    marginTop: '10px',
    padding: '12px',
    fontSize: '14px',
    fontWeight: 500,
    backgroundColor: '#fff',
    color: '#333',
    border: '1px solid #ddd',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  recentSection: {
    marginTop: '20px',
    borderTop: '1px solid #eee',
    paddingTop: '14px',
  },
  recentTitle: {
    fontSize: '13px',
    color: '#666',
    marginBottom: '8px',
    fontWeight: 600,
  },
  recentList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  recentItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #eee',
    borderRadius: '6px',
    backgroundColor: '#fff',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  recentName: {
    fontSize: '13px',
    color: '#222',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    maxWidth: '52%',
  },
  recentMeta: {
    fontSize: '12px',
    color: '#888',
    marginLeft: '8px',
    flexShrink: 0,
  },
};
