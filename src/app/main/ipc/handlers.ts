/**
 * @module app/main/ipc/handlers
 * @description IPC handler 注册 — 全部返回形状正确的 stub 数据
 *
 * 最小可运行闭环：不接入真实业务，只保证 renderer 页面能正常渲染。
 */

import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import * as path from 'path';
import { app } from 'electron';

// ============================================================================
// Mock 数据
// ============================================================================

const MOCK_PROJECT_ID = 'mock-proj-001';
const MOCK_JOB_ID = 'mock-job-001';

function mockProjectSummary(id: string, name: string, status: string) {
  return {
    id,
    displayName: name,
    sourceType: 'local_file',
    status,
    durationMs: 210000,
    totalSizeBytes: 15728640,
    stemCount: 4,
    updatedAt: Date.now() - 3600000,
  };
}

function mockProjectResult() {
  return {
    id: MOCK_PROJECT_ID,
    displayName: 'Demo Song.mp3',
    sourceType: 'local_file',
    status: 'completed',
    durationMs: 210000,
    totalSizeBytes: 15728640,
    stemCount: 4,
    updatedAt: Date.now(),
    elapsedMs: 45200,
    cacheHit: false,
    cacheHitBannerText: null,
    sourceTypeLabel: '自动分离',
  };
}

function mockStems() {
  return [
    {
      id: 'stem-vocals',
      stemType: 'vocals',
      codec: 'wav',
      sizeBytes: 5242880,
      durationMs: 210000,
      sampleRate: 44100,
      exportable: true,
      filePath: '/mock/path/vocals.wav',
      lastModifiedAt: Date.now(),
      presence: 'exists' as const,
      mergedFrom: null,
    },
    {
      id: 'stem-drums',
      stemType: 'drums',
      codec: 'wav',
      sizeBytes: 4194304,
      durationMs: 210000,
      sampleRate: 44100,
      exportable: true,
      filePath: '/mock/path/drums.wav',
      lastModifiedAt: Date.now(),
      presence: 'exists' as const,
      mergedFrom: null,
    },
    {
      id: 'stem-bass',
      stemType: 'bass',
      codec: 'wav',
      sizeBytes: 3145728,
      durationMs: 210000,
      sampleRate: 44100,
      exportable: true,
      filePath: '/mock/path/bass.wav',
      lastModifiedAt: Date.now(),
      presence: 'exists' as const,
      mergedFrom: null,
    },
    {
      id: 'stem-other',
      stemType: 'other',
      codec: 'wav',
      sizeBytes: 0,
      durationMs: 210000,
      sampleRate: 44100,
      exportable: false,
      filePath: '',
      lastModifiedAt: null,
      presence: 'missing' as const,
      mergedFrom: null,
    },
  ];
}

function mockWaveform() {
  // 生成 200 个正弦波峰值点
  const peaks: number[] = [];
  for (let i = 0; i < 200; i++) {
    peaks.push(Math.sin((i / 200) * Math.PI * 6) * 0.7 + Math.random() * 0.3);
  }
  return {
    id: 'master',
    channels: 1,
    length: 200,
    sampleRate: 100,
    peaks,
    durationMs: 210000,
  };
}

function mockChordAnalysis() {
  const chords = [
    { label: 'C', simplifiedLabel: 'C', startMs: 0, endMs: 4000, confidence: 0.92 },
    { label: 'Am', simplifiedLabel: 'Am', startMs: 4000, endMs: 8000, confidence: 0.88 },
    { label: 'F', simplifiedLabel: 'F', startMs: 8000, endMs: 12000, confidence: 0.91 },
    { label: 'G', simplifiedLabel: 'G', startMs: 12000, endMs: 16000, confidence: 0.85 },
    { label: 'C', simplifiedLabel: 'C', startMs: 16000, endMs: 20000, confidence: 0.93 },
  ];
  return {
    projectId: MOCK_PROJECT_ID,
    source: 'mixed',
    analyzerType: 'rule_based',
    segments: chords,
    elapsedMs: 1250,
    analyzedAt: Date.now(),
    audioDurationMs: 210000,
    estimatedKey: 'C major',
    estimatedBpm: 120,
    analysisVersion: '0.1.0-stub',
    vocabularyVersion: '1.0',
    warnings: ['低置信度片段: 1/5 (20%)'],
    generatedAt: Date.now(),
  };
}

// ============================================================================
// 分离流程 mock 状态
// ============================================================================

let separationCancelled = false;

// ============================================================================
// 注册所有 handlers
// ============================================================================

export function registerIpcHandlers(): void {
  // ── Project ──
  ipcMain.handle('project:getRecent', (_event, _limit: number) => {
    return [
      mockProjectSummary(MOCK_PROJECT_ID, 'Demo Song.mp3', 'completed'),
      mockProjectSummary('mock-proj-002', 'Jazz Sample.wav', 'completed'),
    ];
  });

  ipcMain.handle('project:startSeparation', (event, _filePath: string) => {
    separationCancelled = false;
    const win = BrowserWindow.fromWebContents(event.sender);

    // 模拟进度事件链
    const stages = [
      { stage: 'preprocessing', progress: 0.2 },
      { stage: 'separation', progress: 0.5 },
      { stage: 'separation', progress: 0.8 },
      { stage: 'postprocessing', progress: 0.95 },
    ];

    let step = 0;
    const timer = setInterval(() => {
      if (separationCancelled || !win || win.isDestroyed()) {
        clearInterval(timer);
        return;
      }
      if (step < stages.length) {
        win.webContents.send('separation:progress', {
          jobId: MOCK_JOB_ID,
          ...stages[step],
        });
        step++;
      } else {
        clearInterval(timer);
        if (!separationCancelled) {
          win.webContents.send('separation:complete', {
            jobId: MOCK_JOB_ID,
            projectId: MOCK_PROJECT_ID,
            success: true,
            warnings: [],
            cacheHit: false,
          });
        }
      }
    }, 800);

    return {
      jobId: MOCK_JOB_ID,
      projectId: MOCK_PROJECT_ID,
      warnings: [],
      cacheHit: false,
    };
  });

  ipcMain.handle('project:cancelSeparation', () => {
    separationCancelled = true;
    return undefined;
  });

  ipcMain.handle('project:get', (_event, projectId: string) => {
    return mockProjectSummary(projectId, 'Demo Song.mp3', 'completed');
  });

  ipcMain.handle('project:getResult', () => {
    return mockProjectResult();
  });

  ipcMain.handle('project:getStems', () => {
    return mockStems();
  });

  ipcMain.handle('project:openDir', () => {
    // 打开应用数据目录作为 stub 反馈
    const userDataPath = app.getPath('userData');
    shell.openPath(userDataPath);
    return { opened: true, path: userDataPath };
  });

  ipcMain.handle('project:getWaveform', () => {
    return mockWaveform();
  });

  ipcMain.handle('project:getChordAnalysis', () => {
    return mockChordAnalysis();
  });

  // ── Cache ──
  ipcMain.handle('cache:getStats', () => {
    return {
      totalSizeBytes: 25165824,
      projectCount: 2,
      entries: [
        {
          projectId: MOCK_PROJECT_ID,
          displayName: 'Demo Song.mp3',
          sizeBytes: 15728640,
          stemCount: 4,
          createdAt: Date.now() - 86400000,
          lastAccessedAt: Date.now() - 3600000,
          openDirAvailable: true,
        },
        {
          projectId: 'mock-proj-002',
          displayName: 'Jazz Sample.wav',
          sizeBytes: 9437184,
          stemCount: 3,
          createdAt: Date.now() - 172800000,
          lastAccessedAt: Date.now() - 7200000,
          openDirAvailable: true,
        },
      ],
    };
  });

  ipcMain.handle('cache:clearProject', (_event, projectId: string) => {
    return {
      succeededIds: [projectId],
      failedItems: [],
      allSuccess: true,
      freedBytes: 15728640,
      elapsedMs: 320,
    };
  });

  ipcMain.handle('cache:clearAll', () => {
    return {
      succeededIds: [MOCK_PROJECT_ID, 'mock-proj-002'],
      failedItems: [],
      allSuccess: true,
      freedBytes: 25165824,
      elapsedMs: 580,
    };
  });

  ipcMain.handle('cache:openProjectDir', () => {
    const userDataPath = app.getPath('userData');
    shell.openPath(userDataPath);
    return { opened: true, path: userDataPath };
  });

  ipcMain.handle('cache:openRoot', () => {
    const userDataPath = app.getPath('userData');
    shell.openPath(userDataPath);
    return { opened: true, path: userDataPath };
  });

  // ── Export ──
  ipcMain.handle('export:stems', (_event, request: { projectId: string; stemIds: string[] }) => {
    const results = (request.stemIds.length > 0 ? request.stemIds : ['stem-vocals', 'stem-drums', 'stem-bass']).map(id => ({
      projectId: request.projectId,
      stemId: id,
      status: 'succeeded' as const,
      success: true,
      outputPath: `/mock/export/${id}.wav`,
      outputSizeBytes: 5242880,
      error: null,
    }));
    return {
      projectId: request.projectId,
      results,
      succeededIds: results.map(r => r.stemId),
      failedIds: [],
      skippedIds: [],
      cancelledIds: [],
      allSuccess: true,
      cancelled: false,
      elapsedMs: 2100,
    };
  });

  ipcMain.handle('export:selectDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择导出目录',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('export:cancel', () => {
    return undefined;
  });
}
