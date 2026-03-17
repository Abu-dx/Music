/**
 * @module renderer/pages/PlayerPage
 * @description 播放器页面 — 主波形 + 和弦时间轴 + 播放控制 + 单轨控制
 *
 * Round 10 创建，Round 11 升级：
 * - GPT R10 Must Fix #1：跨 store 协调收口到 playerViewController
 * - GPT R10 Must Fix #3：波形语义明确为主波形（MasterWaveformDTO）
 * - GPT R10 Suggested #2："打开文件"入口占位
 * - Round 11：和弦时间轴显示带 + analysisStore 集成
 *
 * 职责：
 * - 播放/暂停/seek/主音量/播放速度控制（用户意图 → playbackStore）
 * - 单轨音量/mute/solo 控制卡片
 * - 主波形可视化（Canvas 绘制）
 * - 和弦时间轴（Canvas 绘制 + 当前和弦高亮）
 * - 播放进度条（可拖拽 seek）
 *
 * 数据来源：
 * - IPlaybackStore.getSnapshot() — 全部播放状态
 * - IAnalysisStore.getSnapshot() — 和弦分析状态
 * - IPlayerViewController — 加载/卸载编排
 * - IProjectStore.getSnapshot() — 项目名称
 *
 * 不负责：
 * - 跨 store 协调 → playerViewController
 * - 波形计算 → main 进程
 * - 和弦分析 → main 进程 / analysisStore
 *
 * Canvas 渲染策略（GPT R12-Fix SG#3）：
 * - WaveformDisplay 和 ChordTimeline 均使用 ResizeObserver 监听容器宽度
 * - canvas 物理尺寸 = CSS 容器宽度 × devicePixelRatio
 * - 避免固定 width 属性导致 CSS 缩放后坐标精度丢失（click-to-seek 偏移）
 * - HiDPI 屏幕下通过 DPR 乘数保证清晰度
 * - 最低 Electron 版本要求：28+（原生支持 ResizeObserver，无需 polyfill）
 */

import React, { useSyncExternalStore, useCallback, useRef, useEffect } from 'react';
import { PlaybackStatus } from '../../shared/enums';
import { IProjectStore } from '../stores/projectStore';
import { IPlaybackStore } from '../stores/playbackStore';
import { IAnalysisStore } from '../stores/analysisStore';
import { IPlayerViewController } from '../controllers/playerViewController';
import type { StemPlaybackControlDTO, MasterWaveformDTO, ChordSegmentDTO } from '../../shared/contracts';

// ============================================================================
// 1. Props
// ============================================================================

export interface PlayerPageProps {
  projectStore: IProjectStore;
  playbackStore: IPlaybackStore;
  analysisStore: IAnalysisStore;
  playerController: IPlayerViewController;
  projectId: string;
  onNavigateToResult: (projectId: string) => void;
  onNavigateToHome: () => void;
}

// ============================================================================
// 2. 轨道类型映射
// ============================================================================

const STEM_TYPE_LABELS: Record<string, string> = {
  vocal: '\u4EBA\u58F0', drums: '\u9F13', bass: '\u8D1D\u65AF', guitar: '\u5409\u4ED6',
  keyboard: '\u952E\u76D8', synth: '\u5408\u6210\u5668', other: '\u5176\u4ED6',
};

const STEM_TYPE_ICONS: Record<string, string> = {
  vocal: '\u{1F3A4}', drums: '\u{1F941}', bass: '\u{1F3B8}',
  guitar: '\u{1F3B8}', keyboard: '\u{1F3B9}', synth: '\u{1F3B6}',
  other: '\u{1F3B5}',
};

const SPEED_PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

// ============================================================================
// 3. 主组件
// ============================================================================

export const PlayerPage: React.FC<PlayerPageProps> = ({
  projectStore,
  playbackStore,
  analysisStore,
  playerController,
  projectId,
  onNavigateToResult,
  onNavigateToHome,
}) => {
  const projectSnap = useSyncExternalStore(
    (cb) => projectStore.subscribe(cb),
    () => projectStore.getSnapshot(),
  );

  const pbSnap = useSyncExternalStore(
    (cb) => playbackStore.subscribe(cb),
    () => playbackStore.getSnapshot(),
  );

  const analysisSnap = useSyncExternalStore(
    (cb) => analysisStore.subscribe(cb),
    () => analysisStore.getSnapshot(),
  );

  const projectName = projectSnap.currentProject?.displayName ?? '\u672A\u547D\u540D\u9879\u76EE';
  const isPlayable = pbSnap.status === PlaybackStatus.Playing
    || pbSnap.status === PlaybackStatus.Paused
    || pbSnap.status === PlaybackStatus.Ended;

  // ---- 生命周期：通过 controller 加载 ----
  useEffect(() => {
    playerController.loadPlayer(projectId);
    return () => {
      playerController.unloadPlayer();
    };
  }, [playerController, projectId]);

  // ---- 播放控制（直接调用 playbackStore，这些是单 store 操作） ----
  const handleTogglePlay = useCallback(() => {
    playbackStore.togglePlayPause();
  }, [playbackStore]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isPlayable) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    playbackStore.seek(ratio * pbSnap.durationMs);
  }, [playbackStore, pbSnap.durationMs, isPlayable]);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    playbackStore.setMasterVolume(parseFloat(e.target.value));
  }, [playbackStore]);

  const handleSpeedChange = useCallback((rate: number) => {
    playbackStore.setPlaybackRate(rate);
  }, [playbackStore]);

  // ---- "打开文件"入口（GPT R10 Suggested #2：占位） ----
  const handleOpenFile = useCallback(() => {
    playerController.openFile(projectId);
  }, [playerController, projectId]);

  return (
    <div className="player-page" style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.backButton} onClick={() => onNavigateToResult(projectId)}>
          &larr; \u7ED3\u679C\u9875
        </button>
        <h2 style={styles.title}>{projectName}</h2>
        <div style={styles.headerActions}>
          <button style={styles.openFileButton} onClick={handleOpenFile} title="\u6253\u5F00\u9879\u76EE\u76EE\u5F55">
            {'\u{1F4C2}'}
          </button>
          <button style={styles.homeButton} onClick={onNavigateToHome}>
            \u9996\u9875
          </button>
        </div>
      </div>

      {/* 状态提示 */}
      {pbSnap.status === PlaybackStatus.Loading && (
        <div style={styles.statusBanner}>\u52A0\u8F7D\u8F68\u9053\u4E2D...</div>
      )}
      {pbSnap.status === PlaybackStatus.Error && pbSnap.error && (
        <div style={styles.errorBanner}>{pbSnap.error.userMessage}</div>
      )}

      {/* 主波形区域 */}
      <WaveformDisplay
        waveform={pbSnap.masterWaveform}
        currentTimeMs={pbSnap.currentTimeMs}
        durationMs={pbSnap.durationMs}
        onSeek={handleSeek}
      />

      {/* 和弦时间轴（Round 11） */}
      <ChordTimeline
        segments={analysisSnap.chordResult?.segments ?? []}
        currentTimeMs={pbSnap.currentTimeMs}
        durationMs={pbSnap.durationMs}
        currentChordLabel={analysisSnap.currentChordLabel}
        loadingState={analysisSnap.loadingState}
        onSeek={handleSeek}
      />

      {/* 当前和弦高亮 + 调性/BPM（R12：加 "估计值" 标注 + warnings） */}
      {analysisSnap.loadingState === 'loaded' && (
        <>
          <div style={styles.chordInfoBar}>
            <div style={styles.currentChord}>
              {analysisSnap.currentChordLabel
                ? <span style={styles.chordLabel}>{analysisSnap.currentChordLabel}</span>
                : <span style={styles.chordLabelEmpty}>--</span>
              }
            </div>
            <div style={styles.chordMeta}>
              {analysisSnap.estimatedKey && (
                <span style={styles.chordMetaTag}>
                  调性: {analysisSnap.estimatedKey}
                  <span style={styles.estimatedBadge}>估计值</span>
                </span>
              )}
              {analysisSnap.estimatedBpm != null && (
                <span style={styles.chordMetaTag}>
                  BPM: {Math.round(analysisSnap.estimatedBpm)}
                  <span style={styles.estimatedBadge}>估计值</span>
                </span>
              )}
              <span style={styles.chordMetaTag}>
                {analysisSnap.segmentCount} 个和弦片段
              </span>
            </div>
          </div>
          {/* R12：诊断警告 */}
          {analysisSnap.warnings.length > 0 && (
            <div style={styles.warningsBar}>
              {analysisSnap.warnings.map((w, i) => (
                <div key={i} style={styles.warningItem}>⚠ {w}</div>
              ))}
            </div>
          )}
        </>
      )}
      {analysisSnap.loadingState === 'loading' && (
        <div style={styles.chordLoadingBar}>\u548C\u5F26\u5206\u6790\u52A0\u8F7D\u4E2D...</div>
      )}
      {analysisSnap.loadingState === 'empty' && (
        <div style={styles.chordEmptyBar}>\u672A\u68C0\u6D4B\u5230\u548C\u5F26\u5206\u6790\u7ED3\u679C</div>
      )}
      {analysisSnap.loadingState === 'error' && (
        <div style={styles.chordErrorBar}>
          {analysisSnap.error?.userMessage ?? '和弦分析加载失败'}
        </div>
      )}

      {/* 进度条 */}
      <div style={styles.progressRow}>
        <span style={styles.timeLabel}>{formatTime(pbSnap.currentTimeMs)}</span>
        <div style={styles.progressTrack} onClick={handleSeek}>
          <div
            style={{
              ...styles.progressFill,
              width: pbSnap.durationMs > 0
                ? `${(pbSnap.currentTimeMs / pbSnap.durationMs) * 100}%`
                : '0%',
            }}
          />
        </div>
        <span style={styles.timeLabel}>{formatTime(pbSnap.durationMs)}</span>
      </div>

      {/* 播放控制栏 */}
      <div style={styles.controlBar}>
        <button
          style={styles.playButton}
          onClick={handleTogglePlay}
          disabled={!isPlayable && pbSnap.status !== PlaybackStatus.Ended}
        >
          {pbSnap.status === PlaybackStatus.Playing ? '\u23F8' : '\u25B6'}
        </button>

        {/* 主音量 */}
        <div style={styles.volumeControl}>
          <span style={styles.volumeIcon}>{'\u{1F50A}'}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={pbSnap.masterVolume}
            onChange={handleVolumeChange}
            style={styles.volumeSlider}
          />
          <span style={styles.volumeValue}>{Math.round(pbSnap.masterVolume * 100)}%</span>
        </div>

        {/* 播放速度 */}
        <div style={styles.speedControl}>
          {SPEED_PRESETS.map(rate => (
            <button
              key={rate}
              style={{
                ...styles.speedButton,
                ...(pbSnap.playbackRate === rate ? styles.speedButtonActive : {}),
              }}
              onClick={() => handleSpeedChange(rate)}
            >
              {rate}x
            </button>
          ))}
        </div>
      </div>

      {/* 单轨控制卡片列表 */}
      <div style={styles.trackSection}>
        <h3 style={styles.trackSectionTitle}>\u8F68\u9053\u63A7\u5236</h3>
        {pbSnap.stemControls.map(ctrl => (
          <TrackControlCard
            key={ctrl.stemId}
            ctrl={ctrl}
            hasSoloedTrack={pbSnap.hasSoloedTrack}
            onVolumeChange={(v) => playbackStore.setTrackVolume(ctrl.stemId, v)}
            onToggleMute={() => playbackStore.toggleTrackMute(ctrl.stemId)}
            onToggleSolo={() => playbackStore.toggleTrackSolo(ctrl.stemId)}
          />
        ))}
        {pbSnap.stemControls.length === 0 && (
          <div style={styles.emptyTracks}>\u672A\u52A0\u8F7D\u8F68\u9053</div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 4. 子组件 — 波形显示（GPT R10 Must Fix #3：单条主波形）
// ============================================================================

/**
 * GPT R11 Must Fix #6：使用 ResizeObserver 动态设置 canvas 物理尺寸，
 * 避免固定 width=660 导致 CSS 缩放后坐标精度丢失。
 */
const WaveformDisplay: React.FC<{
  waveform: MasterWaveformDTO | null;
  currentTimeMs: number;
  durationMs: number;
  onSeek: (e: React.MouseEvent<HTMLDivElement>) => void;
}> = ({ waveform, currentTimeMs, durationMs, onSeek }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ResizeObserver 同步 canvas 物理尺寸
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        const physicalW = Math.round(width * dpr);
        const physicalH = Math.round(100 * dpr);
        if (canvas.width !== physicalW || canvas.height !== physicalH) {
          canvas.width = physicalW;
          canvas.height = physicalH;
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    if (!waveform || waveform.peaks.length === 0) {
      ctx.strokeStyle = '#ddd';
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      return;
    }

    const peaks = waveform.peaks;
    const barWidth = width / peaks.length;
    const midY = height / 2;

    ctx.fillStyle = '#2196F3';
    for (let i = 0; i < peaks.length; i++) {
      const amplitude = Math.abs(peaks[i]) * midY;
      const x = i * barWidth;
      ctx.fillRect(x, midY - amplitude, Math.max(1, barWidth - 0.5), amplitude * 2);
    }

    if (durationMs > 0) {
      const posX = (currentTimeMs / durationMs) * width;
      ctx.strokeStyle = '#F44336';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(posX, 0);
      ctx.lineTo(posX, height);
      ctx.stroke();
    }
  }, [waveform, currentTimeMs, durationMs]);

  return (
    <div ref={containerRef} style={styles.waveformContainer} onClick={onSeek}>
      <canvas
        ref={canvasRef}
        style={styles.waveformCanvas}
      />
    </div>
  );
};

// ============================================================================
// 5. 子组件 — 和弦时间轴（Round 11 核心）
// ============================================================================

const CHORD_COLORS: Record<string, string> = {
  C: '#4CAF50', D: '#2196F3', E: '#FF9800', F: '#9C27B0',
  G: '#F44336', A: '#00BCD4', B: '#795548', N: '#BDBDBD',
};

function getChordColor(label: string): string {
  // 取根音字母查颜色，默认灰
  const root = label.charAt(0).toUpperCase();
  return CHORD_COLORS[root] ?? '#78909C';
}

/**
 * GPT R11 Must Fix #6：和弦时间轴同样使用 ResizeObserver
 */
const ChordTimeline: React.FC<{
  segments: ChordSegmentDTO[];
  currentTimeMs: number;
  durationMs: number;
  currentChordLabel: string | null;
  loadingState: string;
  onSeek: (e: React.MouseEvent<HTMLDivElement>) => void;
}> = ({ segments, currentTimeMs, durationMs, currentChordLabel, loadingState, onSeek }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ResizeObserver 同步 canvas 物理尺寸
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        const physicalW = Math.round(width * dpr);
        const physicalH = Math.round(32 * dpr);
        if (canvas.width !== physicalW || canvas.height !== physicalH) {
          canvas.width = physicalW;
          canvas.height = physicalH;
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    if (loadingState !== 'loaded' || segments.length === 0 || durationMs <= 0) {
      ctx.fillStyle = '#f5f5f5';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#ccc';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        loadingState === 'loading' ? '\u52A0\u8F7D\u4E2D...' : '\u65E0\u548C\u5F26\u6570\u636E',
        width / 2,
        height / 2 + 4,
      );
      return;
    }

    for (const seg of segments) {
      const x1 = (seg.startMs / durationMs) * width;
      const x2 = (seg.endMs / durationMs) * width;
      const segWidth = Math.max(1, x2 - x1);

      const color = getChordColor(seg.label);
      const isActive = seg.label === currentChordLabel
        && currentTimeMs >= seg.startMs
        && currentTimeMs < seg.endMs;

      ctx.globalAlpha = isActive ? 0.9 : 0.5;
      ctx.fillStyle = color;
      ctx.fillRect(x1, 0, segWidth, height);

      if (segWidth > 20) {
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = '#fff';
        ctx.font = isActive ? 'bold 11px sans-serif' : '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(seg.label, x1 + segWidth / 2, height / 2);
      }
    }

    ctx.globalAlpha = 1.0;

    if (durationMs > 0) {
      const posX = (currentTimeMs / durationMs) * width;
      ctx.strokeStyle = '#F44336';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(posX, 0);
      ctx.lineTo(posX, height);
      ctx.stroke();
    }
  }, [segments, currentTimeMs, durationMs, currentChordLabel, loadingState]);

  return (
    <div ref={containerRef} style={styles.chordTimelineContainer} onClick={onSeek}>
      <canvas
        ref={canvasRef}
        style={styles.chordTimelineCanvas}
      />
    </div>
  );
};

// ============================================================================
// 6. 子组件 — 单轨控制卡片
// ============================================================================

const TrackControlCard: React.FC<{
  ctrl: StemPlaybackControlDTO;
  hasSoloedTrack: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  onToggleSolo: () => void;
}> = ({ ctrl, hasSoloedTrack, onVolumeChange, onToggleMute, onToggleSolo }) => {
  const isSilenced = ctrl.effectiveGain === 0;
  const label = STEM_TYPE_LABELS[ctrl.stemType] ?? ctrl.stemType;
  const icon = STEM_TYPE_ICONS[ctrl.stemType] ?? '\u{1F3B5}';

  return (
    <div style={{
      ...styles.trackCard,
      ...(isSilenced ? styles.trackCardSilenced : {}),
    }}>
      <span style={styles.trackIcon}>{icon}</span>
      <span style={styles.trackLabel}>{label}</span>

      {/* 音量滑块 */}
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={ctrl.volume}
        onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
        style={styles.trackVolumeSlider}
      />
      <span style={styles.trackVolumeValue}>{Math.round(ctrl.volume * 100)}%</span>

      {/* Mute 按钮 */}
      <button
        style={{
          ...styles.muteButton,
          ...(ctrl.muted ? styles.muteButtonActive : {}),
        }}
        onClick={onToggleMute}
        title={ctrl.muted ? '\u53D6\u6D88\u9759\u97F3' : '\u9759\u97F3'}
      >
        M
      </button>

      {/* Solo 按钮 */}
      <button
        style={{
          ...styles.soloButton,
          ...(ctrl.soloed ? styles.soloButtonActive : {}),
        }}
        onClick={onToggleSolo}
        title={ctrl.soloed ? '\u53D6\u6D88\u72EC\u594F' : '\u72EC\u594F'}
      >
        S
      </button>
    </div>
  );
};

// ============================================================================
// 7. 辅助函数
// ============================================================================

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// ============================================================================
// 8. 样式
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '24px',
    maxWidth: '720px',
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
    flex: 1,
    textAlign: 'center' as const,
  },
  headerActions: {
    display: 'flex',
    gap: '6px',
  },
  openFileButton: {
    padding: '6px 10px',
    fontSize: '16px',
    backgroundColor: 'transparent',
    border: '1px solid #ddd',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  homeButton: {
    padding: '6px 12px',
    fontSize: '13px',
    backgroundColor: 'transparent',
    border: '1px solid #ddd',
    borderRadius: '4px',
    cursor: 'pointer',
    color: '#666',
  },
  statusBanner: {
    padding: '10px',
    backgroundColor: '#e3f2fd',
    color: '#1565c0',
    borderRadius: '6px',
    textAlign: 'center' as const,
    marginBottom: '16px',
    fontSize: '14px',
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
  waveformContainer: {
    marginBottom: '4px',
    backgroundColor: '#fafafa',
    borderRadius: '8px 8px 0 0',
    border: '1px solid #e0e0e0',
    borderBottom: 'none',
    overflow: 'hidden',
    cursor: 'pointer',
  },
  waveformCanvas: {
    display: 'block',
    width: '100%',
    height: '100px',
  },
  // ---- 和弦时间轴样式 ----
  chordTimelineContainer: {
    marginBottom: '12px',
    backgroundColor: '#f0f0f0',
    borderRadius: '0 0 8px 8px',
    border: '1px solid #e0e0e0',
    borderTop: 'none',
    overflow: 'hidden',
    cursor: 'pointer',
  },
  chordTimelineCanvas: {
    display: 'block',
    width: '100%',
    height: '32px',
  },
  chordInfoBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    backgroundColor: '#f5f5f5',
    borderRadius: '6px',
    marginBottom: '12px',
  },
  currentChord: {
    display: 'flex',
    alignItems: 'center',
  },
  chordLabel: {
    fontSize: '22px',
    fontWeight: 700,
    color: '#1a1a1a',
    fontFamily: 'monospace',
    minWidth: '60px',
  },
  chordLabelEmpty: {
    fontSize: '22px',
    fontWeight: 700,
    color: '#ccc',
    fontFamily: 'monospace',
    minWidth: '60px',
  },
  chordMeta: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  },
  chordMetaTag: {
    fontSize: '12px',
    color: '#666',
    padding: '2px 6px',
    backgroundColor: '#e8e8e8',
    borderRadius: '3px',
  },
  chordLoadingBar: {
    padding: '6px',
    textAlign: 'center' as const,
    color: '#1565c0',
    fontSize: '12px',
    marginBottom: '12px',
  },
  chordEmptyBar: {
    padding: '6px',
    textAlign: 'center' as const,
    color: '#999',
    fontSize: '12px',
    marginBottom: '12px',
  },
  chordErrorBar: {
    padding: '6px',
    textAlign: 'center' as const,
    color: '#c62828',
    fontSize: '12px',
    marginBottom: '12px',
  },
  estimatedBadge: {
    fontSize: '9px',
    color: '#999',
    marginLeft: '3px',
    fontStyle: 'italic' as const,
  },
  warningsBar: {
    padding: '6px 12px',
    backgroundColor: '#fff8e1',
    borderRadius: '4px',
    marginBottom: '12px',
    border: '1px solid #ffe082',
  },
  warningItem: {
    fontSize: '12px',
    color: '#f57f17',
    lineHeight: '1.6',
  },
  progressRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '16px',
  },
  timeLabel: {
    fontSize: '12px',
    color: '#888',
    fontFamily: 'monospace',
    minWidth: '42px',
  },
  progressTrack: {
    flex: 1,
    height: '6px',
    backgroundColor: '#e0e0e0',
    borderRadius: '3px',
    overflow: 'hidden',
    cursor: 'pointer',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#2196F3',
    borderRadius: '3px',
    transition: 'width 0.1s linear',
  },
  controlBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    marginBottom: '24px',
    padding: '12px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
  },
  playButton: {
    width: '44px',
    height: '44px',
    fontSize: '20px',
    backgroundColor: '#2196F3',
    color: '#fff',
    border: 'none',
    borderRadius: '50%',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  volumeControl: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  volumeIcon: {
    fontSize: '16px',
  },
  volumeSlider: {
    width: '80px',
  },
  volumeValue: {
    fontSize: '12px',
    color: '#666',
    minWidth: '32px',
  },
  speedControl: {
    display: 'flex',
    gap: '4px',
    marginLeft: 'auto',
  },
  speedButton: {
    padding: '4px 8px',
    fontSize: '11px',
    backgroundColor: 'transparent',
    border: '1px solid #ccc',
    borderRadius: '3px',
    cursor: 'pointer',
    color: '#666',
  },
  speedButtonActive: {
    backgroundColor: '#2196F3',
    color: '#fff',
    borderColor: '#2196F3',
  },
  trackSection: {
    marginBottom: '24px',
  },
  trackSectionTitle: {
    fontSize: '15px',
    fontWeight: 600,
    color: '#333',
    margin: '0 0 12px 0',
  },
  trackCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 14px',
    backgroundColor: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: '6px',
    marginBottom: '6px',
  },
  trackCardSilenced: {
    opacity: 0.5,
  },
  trackIcon: {
    fontSize: '20px',
    width: '28px',
    textAlign: 'center' as const,
    flexShrink: 0,
  },
  trackLabel: {
    fontSize: '14px',
    fontWeight: 500,
    color: '#1a1a1a',
    width: '48px',
    flexShrink: 0,
  },
  trackVolumeSlider: {
    flex: 1,
    minWidth: '60px',
  },
  trackVolumeValue: {
    fontSize: '12px',
    color: '#666',
    minWidth: '32px',
    textAlign: 'right' as const,
  },
  muteButton: {
    width: '28px',
    height: '28px',
    fontSize: '12px',
    fontWeight: 700,
    backgroundColor: 'transparent',
    border: '1px solid #ccc',
    borderRadius: '4px',
    cursor: 'pointer',
    color: '#666',
  },
  muteButtonActive: {
    backgroundColor: '#F44336',
    color: '#fff',
    borderColor: '#F44336',
  },
  soloButton: {
    width: '28px',
    height: '28px',
    fontSize: '12px',
    fontWeight: 700,
    backgroundColor: 'transparent',
    border: '1px solid #ccc',
    borderRadius: '4px',
    cursor: 'pointer',
    color: '#666',
  },
  soloButtonActive: {
    backgroundColor: '#FF9800',
    color: '#fff',
    borderColor: '#FF9800',
  },
  emptyTracks: {
    textAlign: 'center' as const,
    padding: '20px',
    color: '#999',
    fontSize: '14px',
  },
};
