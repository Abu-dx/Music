/**
 * @module app/main/preload
 * @description contextBridge — 向 renderer 暴露最小 IPC API 集合
 *
 * 只暴露当前 App 真会调用的接口，避免把未实现接口提前固化。
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  isDevMode: () =>
    process.env.NODE_ENV === 'development',

  // ── IProjectElectronAPI subset ──
  getRecentProjects: (limit: number) =>
    ipcRenderer.invoke('project:getRecent', limit),
  startSeparation: (filePath: string) =>
    ipcRenderer.invoke('project:startSeparation', filePath),
  startPilotSeparation: (projectId: string, sourceFilePath?: string) =>
    ipcRenderer.invoke('project:startPilotSeparation', projectId, sourceFilePath),
  cancelSeparation: (jobId?: string) =>
    ipcRenderer.invoke('project:cancelSeparation', jobId),
  getProject: (projectId: string) =>
    ipcRenderer.invoke('project:get', projectId),
  renameProject: (projectId: string, displayName: string) =>
    ipcRenderer.invoke('project:rename', projectId, displayName),
  markProjectAccessed: (projectId: string) =>
    ipcRenderer.invoke('project:markAccessed', projectId),
  setActiveResult: (projectId: string, resultSetId: string) =>
    ipcRenderer.invoke('project:setActiveResult', projectId, resultSetId),
  getProjectResult: (projectId: string) =>
    ipcRenderer.invoke('project:getResult', projectId),
  getStemsByProject: (projectId: string) =>
    ipcRenderer.invoke('project:getStems', projectId),
  openExistingProject: () =>
    ipcRenderer.invoke('project:openExisting'),
  openProjectDir: (projectId: string) =>
    ipcRenderer.invoke('project:openDir', projectId),
  getMasterWaveform: (projectId: string) =>
    ipcRenderer.invoke('project:getWaveform', projectId),
  getChordAnalysis: (projectId: string) =>
    ipcRenderer.invoke('project:getChordAnalysis', projectId),

  // ── IJobElectronAPI ──
  onSeparationProgress: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on('separation:progress', handler);
    return () => { ipcRenderer.removeListener('separation:progress', handler); };
  },
  onSeparationComplete: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on('separation:complete', handler);
    return () => { ipcRenderer.removeListener('separation:complete', handler); };
  },

  // ── ICacheElectronAPI subset ──
  getCacheStats: () =>
    ipcRenderer.invoke('cache:getStats'),
  clearProjectCache: (projectId: string) =>
    ipcRenderer.invoke('cache:clearProject', projectId),
  clearAllCache: () =>
    ipcRenderer.invoke('cache:clearAll'),
  openProjectCacheDir: (projectId: string) =>
    ipcRenderer.invoke('cache:openProjectDir', projectId),
  openCacheRoot: () =>
    ipcRenderer.invoke('cache:openRoot'),

  // ── IExportElectronAPI stub ──
  exportStems: (request: unknown) =>
    ipcRenderer.invoke('export:stems', request),
  selectExportDir: () =>
    ipcRenderer.invoke('export:selectDir'),
  cancelExport: (projectId: string) =>
    ipcRenderer.invoke('export:cancel', projectId),
  onExportProgress: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on('export:progress', handler);
    return () => { ipcRenderer.removeListener('export:progress', handler); };
  },
});
