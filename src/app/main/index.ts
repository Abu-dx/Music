/**
 * @module app/main/index
 * @description Electron main 进程入口
 *
 * 阶段 2 — 增加 Worker 基础设施生命周期：
 * 1. 初始化 Worker infra（WorkerManager / IpcBridge / HealthChecker / SchemaValidator / ResultAdapter）
 * 2. 注册 IPC handlers（传入 Worker infra，支持真实分离 + mock 回退）
 * 3. 创建 BrowserWindow
 * 4. 异步启动 Worker（不阻塞窗口显示）
 * 5. app quit 时优雅关闭 Worker
 */

import { app } from 'electron';
import { createMainWindow } from './window';
import { registerIpcHandlers } from './ipc/handlers';
import { initWorkerInfra, startWorker, stopWorker, WorkerInfra } from './workerSetup';

let workerInfra: WorkerInfra | null = null;

app.whenReady().then(async () => {
  // 1. 初始化 Worker 基础设施（同步，不启动进程）
  try {
    workerInfra = initWorkerInfra();
  } catch (err) {
    console.error('[main] Failed to init Worker infra, falling back to mock mode:', err);
  }

  // 2. 注册 IPC handlers（传入 infra；若为 null 则 handlers 内部走 mock 路径）
  registerIpcHandlers(workerInfra ?? undefined);

  // 3. 创建窗口（不阻塞 Worker 启动）
  createMainWindow();

  // 4. 异步启动 Worker 进程（不阻塞 UI）
  if (workerInfra) {
    try {
      await startWorker(workerInfra);
      console.log('[main] Worker started successfully');
    } catch (err) {
      console.error('[main] Worker start failed, real separation will be unavailable:', err);
    }
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async () => {
  if (workerInfra) {
    try {
      await stopWorker(workerInfra);
      console.log('[main] Worker stopped');
    } catch (err) {
      console.error('[main] Worker stop error:', err);
    }
  }
});
