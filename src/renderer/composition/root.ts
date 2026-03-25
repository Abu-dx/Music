/**
 * @module renderer/composition/root
 * @description renderer 侧 composition root — 实例化全部 store / service / controller
 *
 * 最小可运行闭环版本。
 * 由 App.tsx 在模块级别调用一次，确保全局单例。
 *
 * 职责：
 * - 从 window.electronAPI 获取 preload 暴露的 IPC API
 * - 实例化 Store / Service / Controller
 * - 导出组装完成的依赖集合
 *
 * 不负责：
 * - 页面路由
 * - 页面渲染
 * - 业务编排
 */

import { ProjectStore } from '../stores/projectStore';
import type { IProjectStore, IProjectElectronAPI } from '../stores/projectStore';
import { JobStore } from '../stores/jobStore';
import type { IJobStore, IJobElectronAPI } from '../stores/jobStore';
import { PlaybackStore } from '../stores/playbackStore';
import type { IPlaybackStore } from '../stores/playbackStore';
import { AnalysisStore } from '../stores/analysisStore';
import type { IAnalysisStore } from '../stores/analysisStore';
import { PlayerViewController } from '../controllers/playerViewController';
import type { IPlayerViewController } from '../controllers/playerViewController';
import { PlayerDataService } from '../services/playerDataService';
import type { IPlayerDataService } from '../services/playerDataService';
import { ExportService } from '../services/exportService';
import type { IExportService, IExportElectronAPI } from '../services/exportService';
import { WebAudioEngineAdapter } from '../audio/webAudioEngineAdapter';
import type { ICacheElectronAPI } from '../pages/CacheManagementPage';

// ============================================================================
// 1. window.electronAPI 类型声明
// ============================================================================

/**
 * preload.ts 通过 contextBridge 暴露到 window.electronAPI 的全部方法
 */
interface ElectronAPI extends IProjectElectronAPI, IJobElectronAPI, IExportElectronAPI {
  isDevMode: () => boolean;
  // ICacheElectronAPI 方法也在此对象上
  getCacheStats: ICacheElectronAPI['getCacheStats'];
  clearProjectCache: ICacheElectronAPI['clearProjectCache'];
  clearAllCache: ICacheElectronAPI['clearAllCache'];
  openProjectCacheDir: ICacheElectronAPI['openProjectCacheDir'];
  openCacheRoot: ICacheElectronAPI['openCacheRoot'];
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// ============================================================================
// 2. Composition 结果类型
// ============================================================================

export interface CompositionRoot {
  projectStore: IProjectStore;
  jobStore: IJobStore;
  playbackStore: IPlaybackStore;
  analysisStore: IAnalysisStore;
  playerController: IPlayerViewController;
  playerDataService: IPlayerDataService;
  exportService: IExportService;
  cacheApi: ICacheElectronAPI;
}

// ============================================================================
// 3. 单例 + 创建
// ============================================================================

let _instance: CompositionRoot | null = null;

export function createCompositionRoot(): CompositionRoot {
  if (_instance) return _instance;

  const api = window.electronAPI;

  // Stores
  const projectStore = new ProjectStore(api as IProjectElectronAPI);
  const jobStore = new JobStore(api as IJobElectronAPI);
  const audioEngine = new WebAudioEngineAdapter();
  const playbackStore = new PlaybackStore(audioEngine);
  const analysisStore = new AnalysisStore();

  // Services
  const playerDataService = new PlayerDataService(api as IProjectElectronAPI);
  const exportService = new ExportService(api as IExportElectronAPI);

  // Controller
  const playerController = new PlayerViewController(
    projectStore,
    playbackStore,
    analysisStore,
    playerDataService,
  );

  // Cache API（直接透传 preload 暴露的方法）
  const cacheApi: ICacheElectronAPI = {
    getCacheStats: api.getCacheStats.bind(api),
    clearProjectCache: api.clearProjectCache.bind(api),
    clearAllCache: api.clearAllCache.bind(api),
    openProjectCacheDir: api.openProjectCacheDir.bind(api),
    openCacheRoot: api.openCacheRoot.bind(api),
  };

  _instance = {
    projectStore,
    jobStore,
    playbackStore,
    analysisStore,
    playerController,
    playerDataService,
    exportService,
    cacheApi,
  };

  return _instance;
}
