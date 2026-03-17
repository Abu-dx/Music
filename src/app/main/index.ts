/**
 * @module app/main/index
 * @description Electron main 进程入口
 *
 * 最小可运行闭环 — 只负责：
 * 1. 注册 IPC handlers（stub）
 * 2. 创建 BrowserWindow
 * 3. 加载 renderer HTML
 */

import { app } from 'electron';
import { createMainWindow } from './window';
import { registerIpcHandlers } from './ipc/handlers';

app.whenReady().then(() => {
  registerIpcHandlers();
  createMainWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
