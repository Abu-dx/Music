/**
 * @module app/main/window
 * @description BrowserWindow 创建与管理
 */

import { BrowserWindow } from 'electron';
import * as path from 'path';

export function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, 'preload.js');

  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    title: 'Stem Monitor',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  // 加载 renderer 打包输出
  const rendererHtml = path.join(__dirname, '..', '..', '..', 'renderer', 'index.html');

  win.loadFile(rendererHtml);

  return win;
}
