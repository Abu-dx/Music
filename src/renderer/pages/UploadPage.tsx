/**
 * @module renderer/pages/UploadPage
 * @description 上传页 — 文件选择 + 启动分离
 *
 * 职责：
 * - 提供文件拖放区域和文件选择按钮
 * - 显示已选文件信息（名称、大小、格式）
 * - 校验文件格式（前端预校验，后端做最终校验）
 * - 点击"开始分离"后调用 ProjectStore.startSeparation()
 * - 启动成功后自动跳转到 ProgressPage
 *
 * 数据来源：
 * - 本地组件状态（已选文件）
 * - ProjectStore 用于触发分离和获取错误信息
 */

import React, { useState, useRef, useCallback, useSyncExternalStore } from 'react';
import { IProjectStore } from '../stores/projectStore';
import { SUPPORTED_INPUT_EXTENSIONS, SelectedFileDTO } from '../../shared/contracts';

// ============================================================================
// 1. Props
// ============================================================================

export interface UploadPageProps {
  store: IProjectStore;
  onNavigateToProgress: (projectId: string) => void;
  onNavigateBack: () => void;
}

// ============================================================================
// 2. 组件
// ============================================================================

export const UploadPage: React.FC<UploadPageProps> = ({
  store,
  onNavigateToProgress,
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

  /**
   * 前端格式预校验
   */
  const validateFile = useCallback((file: File): string | null => {
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!SUPPORTED_INPUT_EXTENSIONS.includes(ext)) {
      return `不支持的文件格式: ${ext}（支持 ${SUPPORTED_INPUT_EXTENSIONS.join(', ')}）`;
    }
    return null;
  }, []);

  /**
   * GPT R7 Must Fix #4：将 Electron File 对象映射为 SelectedFileDTO，
   * 隔离 Electron 特有的 File.path 属性。
   */
  const handleFileSelect = useCallback((file: File) => {
    const error = validateFile(file);
    setValidationError(error);
    if (error) {
      setSelectedFile(null);
      return;
    }
    // Electron 环境下 File 对象有 path 属性
    const filePath = (file as File & { path?: string }).path ?? null;
    const dto: SelectedFileDTO = {
      name: file.name,
      size: file.size,
      path: filePath,
    };
    setSelectedFile(dto);
  }, [validateFile]);

  /**
   * 文件选择按钮
   */
  const handleButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  /**
   * 拖放处理
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
   * 启动分离
   */
  const handleStartSeparation = useCallback(async () => {
    if (!selectedFile) return;

    if (!selectedFile.path) {
      setValidationError('无法获取文件路径（请使用文件选择器）');
      return;
    }

    await store.startSeparation(selectedFile.path);

    // 检查启动结果
    const snap = store.getSnapshot();
    if (snap.currentProject) {
      onNavigateToProgress(snap.currentProject.id);
    }
  }, [selectedFile, store, onNavigateToProgress]);

  const acceptStr = SUPPORTED_INPUT_EXTENSIONS.join(',');

  return (
    <div className="upload-page" style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.backButton} onClick={onNavigateBack}>
          &larr; 返回
        </button>
        <h2 style={styles.title}>上传音频文件</h2>
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
            : '拖放音频文件到此处，或点击选择'}
        </div>
        {selectedFile && (
          <div style={styles.fileMeta}>
            {formatFileSize(selectedFile.size)}
          </div>
        )}
        <div style={styles.formatHint}>
          支持格式: {SUPPORTED_INPUT_EXTENSIONS.join(' / ')}
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
    </div>
  );
};

// ============================================================================
// 3. 辅助函数
// ============================================================================

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// 4. 样式
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
};
