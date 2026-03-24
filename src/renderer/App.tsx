/**
 * @module renderer/App
 * @description 根组件 — 消费 composition root + 路由分发
 *
 * 职责：
 * - 持有当前页面路由状态 { page, projectId }
 * - 根据路由渲染对应 Page 组件
 * - 传入 composition root 提供的 store / service / controller
 *
 * 不负责：
 * - 业务编排 → controller / store
 * - DI 实例化 → composition/root.ts
 */

import React, { useState, useCallback, useMemo, useEffect, useSyncExternalStore } from 'react';
import { createCompositionRoot } from './composition/root';

// Pages
import { HomePage } from './pages/HomePage';
import { UploadPage } from './pages/UploadPage';
import { ProgressPage } from './pages/ProgressPage';
import { ResultPage } from './pages/ResultPage';
import { PlayerPage } from './pages/PlayerPage';
import { CacheManagementPage } from './pages/CacheManagementPage';

// ============================================================================
// 1. 路由类型
// ============================================================================

type PageName = 'home' | 'upload' | 'progress' | 'result' | 'player' | 'cache';

interface RouteState {
  page: PageName;
  projectId: string | null;
}

// ============================================================================
// 2. 根组件
// ============================================================================

export const App: React.FC = () => {
  // composition root 保证单例（模块级缓存）
  const deps = useMemo(() => createCompositionRoot(), []);
  const jobSnap = useSyncExternalStore(
    (cb) => deps.jobStore.subscribe(cb),
    () => deps.jobStore.getSnapshot(),
  );

  const [route, setRoute] = useState<RouteState>({ page: 'home', projectId: null });
  const [pendingCancelRefreshJobId, setPendingCancelRefreshJobId] = useState<string | null>(null);

  // ── 导航回调 ──
  const goHome = useCallback(() => setRoute({ page: 'home', projectId: null }), []);
  const goUpload = useCallback(() => setRoute({ page: 'upload', projectId: null }), []);
  const goCache = useCallback(() => setRoute({ page: 'cache', projectId: null }), []);

  const goProgress = useCallback((projectId: string) =>
    setRoute({ page: 'progress', projectId }), []);
  const goResult = useCallback((projectId: string) =>
    setRoute({ page: 'result', projectId }), []);
  const goPlayer = useCallback((projectId: string) =>
    setRoute({ page: 'player', projectId }), []);
  const goProject = useCallback((projectId: string) =>
    setRoute({ page: 'result', projectId }), []);

  const handleCancel = useCallback(async (jobId?: string) => {
    const targetJobId = jobId ?? deps.jobStore.getSnapshot().currentJobId;
    if (targetJobId) {
      setPendingCancelRefreshJobId(targetJobId);
    }
    try {
      await deps.projectStore.cancelSeparation(jobId);
    } finally {
      goHome();
    }
  }, [deps.projectStore, deps.jobStore, goHome]);

  useEffect(() => {
    if (!pendingCancelRefreshJobId) return;
    if (jobSnap.currentJobId !== pendingCancelRefreshJobId) return;
    if (!jobSnap.isComplete) return;

    const isCancelled = (jobSnap.errorMessage ?? '').includes('取消')
      || jobSnap.warnings.some((w) => typeof w === 'string' && w.includes('取消'));
    if (!isCancelled) {
      setPendingCancelRefreshJobId(null);
      return;
    }

    deps.projectStore.loadRecentProjects(20)
      .catch(() => undefined)
      .finally(() => {
        setPendingCancelRefreshJobId(null);
      });
  }, [
    deps.projectStore,
    jobSnap.currentJobId,
    jobSnap.errorMessage,
    jobSnap.isComplete,
    jobSnap.warnings,
    pendingCancelRefreshJobId,
  ]);

  // ── 页面渲染 ──
  switch (route.page) {
    case 'home':
      return (
        <div>
          <HomePage
            store={deps.projectStore}
            onNavigateToUpload={goUpload}
            onNavigateToProject={goProject}
            onNavigateToProgress={goProgress}
          />
          <div style={navBarStyle}>
            <button style={navButtonStyle} onClick={goCache}>缓存管理</button>
          </div>
        </div>
      );

    case 'upload':
      return (
        <UploadPage
          store={deps.projectStore}
          jobStore={deps.jobStore}
          onNavigateToProgress={goProgress}
          onNavigateToResult={goResult}
          onNavigateBack={goHome}
        />
      );

    case 'progress':
      return (
        <ProgressPage
          projectStore={deps.projectStore}
          jobStore={deps.jobStore}
          projectId={route.projectId ?? ''}
          onNavigateToHome={goHome}
          onNavigateToUpload={goUpload}
          onNavigateToResult={goResult}
          onCancelSeparation={handleCancel}
        />
      );

    case 'result':
      return (
        <ResultPage
          projectStore={deps.projectStore}
          analysisStore={deps.analysisStore}
          exportService={deps.exportService}
          projectId={route.projectId ?? ''}
          onNavigateToHome={goHome}
          onNavigateToUpload={goUpload}
          onNavigateToPlayer={goPlayer}
        />
      );

    case 'player':
      return (
        <PlayerPage
          projectStore={deps.projectStore}
          playbackStore={deps.playbackStore}
          analysisStore={deps.analysisStore}
          playerController={deps.playerController}
          projectId={route.projectId ?? ''}
          onNavigateToResult={goResult}
          onNavigateToHome={goHome}
        />
      );

    case 'cache':
      return (
        <CacheManagementPage
          cacheApi={deps.cacheApi}
          onNavigateToHome={goHome}
        />
      );
  }
};

// ============================================================================
// 3. 底部导航栏样式（最小临时方案）
// ============================================================================

const navBarStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 0,
  left: 0,
  right: 0,
  padding: '8px 16px',
  backgroundColor: '#f5f5f5',
  borderTop: '1px solid #e0e0e0',
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
};

const navButtonStyle: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: '13px',
  backgroundColor: '#fff',
  border: '1px solid #ddd',
  borderRadius: '4px',
  cursor: 'pointer',
  color: '#666',
};
