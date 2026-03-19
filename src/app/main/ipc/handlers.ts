/**
 * @module app/main/ipc/handlers
 * @description IPC handler 娉ㄥ唽 鈥?鐪熷疄 Worker 鍒嗙 + mock waveform/chord
 *
 * Phase 2 MVP:
 * - startSeparation: 閫氳繃 ParseJobService 璋冪敤鐪熷疄 Demucs Worker
 * - getStemsByProject: 浠?stemFileRepo 杩斿洖鐪熷疄 stem 鏂囦欢璺緞
 * - getProjectResult: 鐪熷疄鍒嗙鍚?sourceTypeLabel 涓嶅惈"妯℃嫙"
 * - getWaveform / getChordAnalysis: 浠嶈繑鍥?mock 鏁版嵁锛堟槑纭爣璁?mock_stub锛? *
 * Mock 鍥為€€锛? * - Worker 鏈惎鍔?/ HealthCheck 澶辫触 / Demucs 鏈畨瑁?鈫?mock 瀹氭椂鍣ㄦā鎷? * - 鐪熷疄鍒嗙璋冪敤澶辫触 鈫?閿欒閫氱煡 renderer锛屼笉 crash
 */

import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { app } from 'electron';
import {
  ProjectSourceType,
  ProjectStatus,
  CacheEntryStatus,
  WorkerEventName,
  WorkerCommand,
  StemStatus,
} from '../../../shared/enums';
import { StemType } from '../../../shared/enums';
import type { Project } from '../../../domain/entities';
import type { WorkerInfra } from '../workerSetup';
import { inferStemTypeFromFilename } from '../../../domain/policies';

// ============================================================================
// Worker 鍩虹璁炬柦寮曠敤锛堢敱 registerIpcHandlers 娉ㄥ叆锛?// ============================================================================

let workerInfra: WorkerInfra | null = null;

const SUPPORTED_AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.m4a', '.aac']);
const ANALYSIS_SOURCE_STEM_PRIORITY: StemType[] = [
  StemType.Other,
  StemType.Vocal,
  StemType.Drums,
  StemType.Bass,
  StemType.Guitar,
  StemType.Keyboard,
  StemType.Synth,
];

type CachedWaveformDTO = {
  id: string;
  channels: number;
  length: number;
  sampleRate: number;
  peaks: number[];
  durationMs: number;
  analysisVersion?: string;
};

type CachedChordSegmentDTO = {
  startMs: number;
  endMs: number;
  label: string;
  simplifiedLabel?: string;
  confidence?: number;
  sourceFlags?: string[];
};

type CachedChordAnalysisDTO = {
  projectId: string;
  source: string;
  analyzerType: string;
  segments: CachedChordSegmentDTO[];
  elapsedMs: number;
  analyzedAt: number;
  audioDurationMs: number;
  estimatedKey?: string;
  estimatedBpm?: number;
  analysisVersion?: string;
  vocabularyVersion?: string;
  warnings?: string[];
  generatedAt?: number;
};

type CachedChordAnalysisEntry = {
  cacheKey: string;
  sourceFilePath: string;
  sourceSignature: string;
  analysisVersion: string;
  cachedAt: number;
  result: CachedChordAnalysisDTO;
};

type CachedWaveformEntry = {
  cacheKey: string;
  sourceFilePath: string;
  sourceSignature: string;
  analysisVersion: string;
  cachedAt: number;
  result: CachedWaveformDTO;
};

const waveformResultCache = new Map<string, CachedWaveformEntry>();
const chordAnalysisResultCache = new Map<string, CachedChordAnalysisEntry>();

type RecentProjectEntry = {
  projectId: string;
  displayName: string;
  projectDir: string;
  updatedAt: number;
};

function getRecentProjectsIndexPath(): string {
  return path.join(app.getPath('userData'), 'recent-projects.json');
}

async function readRecentProjectsIndex(): Promise<RecentProjectEntry[]> {
  const indexPath = getRecentProjectsIndexPath();
  if (!fs.existsSync(indexPath)) return [];
  try {
    const raw = await fs.promises.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => isObjectLike(item))
      .map((item) => ({
        projectId: typeof item.projectId === 'string' ? item.projectId : '',
        displayName: typeof item.displayName === 'string' ? item.displayName : '未命名项目',
        projectDir: typeof item.projectDir === 'string' ? item.projectDir : '',
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
      }))
      .filter((item) => item.projectId.length > 0 && item.projectDir.length > 0);
  } catch {
    return [];
  }
}

async function writeRecentProjectsIndex(entries: RecentProjectEntry[]): Promise<void> {
  const indexPath = getRecentProjectsIndexPath();
  const normalized = entries
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 100);
  await fs.promises.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.promises.writeFile(indexPath, JSON.stringify(normalized, null, 2), 'utf-8');
}

async function upsertRecentProjectEntry(entry: RecentProjectEntry): Promise<void> {
  const existing = await readRecentProjectsIndex();
  const deduped = existing.filter((e) => e.projectDir !== entry.projectDir && e.projectId !== entry.projectId);
  deduped.unshift(entry);
  await writeRecentProjectsIndex(deduped);
}

async function removeRecentProjectEntryByProjectId(projectId: string): Promise<void> {
  const existing = await readRecentProjectsIndex();
  const filtered = existing.filter((entry) => entry.projectId !== projectId);
  if (filtered.length !== existing.length) {
    await writeRecentProjectsIndex(filtered);
  }
}

async function clearRecentProjectsIndex(): Promise<void> {
  await writeRecentProjectsIndex([]);
}

async function resolveRecentProjectDirByProjectId(projectId: string): Promise<string | null> {
  const existing = await readRecentProjectsIndex();
  let changed = false;
  const kept: RecentProjectEntry[] = [];
  let matchedDir: string | null = null;

  for (const entry of existing) {
    if (!fs.existsSync(entry.projectDir)) {
      changed = true;
      continue;
    }
    kept.push(entry);
    if (!matchedDir && entry.projectId === projectId) {
      matchedDir = entry.projectDir;
    }
  }

  if (changed) {
    await writeRecentProjectsIndex(kept);
  }
  return matchedDir;
}

function isProjectLikeDirectory(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, 'manifest.json'))
    || fs.existsSync(path.join(dirPath, 'stems'));
}

function resolveUniqueExportPath(outputDir: string, sourceFileName: string): { targetPath: string; renamed: boolean } {
  const ext = path.extname(sourceFileName);
  const baseName = path.basename(sourceFileName, ext);
  let candidatePath = path.join(outputDir, sourceFileName);
  if (!fs.existsSync(candidatePath)) {
    return { targetPath: candidatePath, renamed: false };
  }
  for (let i = 1; i <= 9999; i++) {
    const renamedFile = `${baseName} (${i})${ext}`;
    candidatePath = path.join(outputDir, renamedFile);
    if (!fs.existsSync(candidatePath)) {
      return { targetPath: candidatePath, renamed: true };
    }
  }
  throw new Error(`Unable to resolve export filename conflict for ${sourceFileName}`);
}

function normalizeErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    const msg = err.message?.trim();
    if (msg) return msg;
  }
  if (typeof err === 'string' && err.trim().length > 0) return err.trim();
  return fallback;
}

function toSeparationFailureMessage(err: unknown): string {
  const raw = normalizeErrorMessage(err, '分离失败，请稍后重试');
  if (raw.includes('WORKER_NOT_RUNNING') || raw.includes('worker_not_available')) {
    return 'Worker 不可用，请重启应用后重试';
  }
  if (raw.includes('ENOENT') || raw.includes('输入文件') || raw.includes('file')) {
    return '输入文件不存在或不可访问，请重新选择音频文件';
  }
  if (raw.includes('demucs') || raw.includes('torch') || raw.includes('engine')) {
    return '分离引擎执行失败，请检查 Demucs/Python 环境';
  }
  return raw;
}

function toAnalysisFailureMessage(err: unknown, fallback: string): string {
  const raw = normalizeErrorMessage(err, fallback);
  if (raw.includes('INPUT_FILE_NOT_FOUND') || raw.includes('Source file not found')) {
    return '分析输入文件不存在，已回退到示例数据';
  }
  if (raw.includes('ANALYSIS_DEPENDENCY_MISSING')) {
    return '分析依赖缺失（librosa/torchaudio），已回退到示例数据';
  }
  if (raw.includes('WORKER_IPC') || raw.includes('Worker')) {
    return '分析 Worker 不可用，已回退到示例数据';
  }
  return raw;
}

async function resolveAnalysisSourceFilePath(project: Project, infra: WorkerInfra): Promise<string | null> {
  if (project.originalFilePath && fs.existsSync(project.originalFilePath)) {
    return project.originalFilePath;
  }

  const stems = await infra.stemFileRepo.findByProjectId(project.id);
  if (stems.length === 0) return null;

  const existing = stems.filter((s) => s.exists && typeof s.filePath === 'string' && s.filePath.trim().length > 0);
  if (existing.length === 0) return null;

  for (const preferredType of ANALYSIS_SOURCE_STEM_PRIORITY) {
    const matched = existing.find((s) => s.stemType === preferredType && fs.existsSync(s.filePath));
    if (matched) return matched.filePath;
  }

  const firstExisting = existing.find((s) => fs.existsSync(s.filePath));
  return firstExisting?.filePath ?? null;
}

function ensureWorkerAcceptingRequests(infra: WorkerInfra): boolean {
  if (infra.workerManager.isAcceptingRequests()) {
    return true;
  }
  const status = infra.workerManager.getStatus();
  if (status.pid !== null) {
    // Recovery for temporary "unresponsive" state after long-running command.
    infra.workerManager.updateHealthCheckTimestamp();
  }
  return infra.workerManager.isAcceptingRequests();
}

function getChordAnalysisVersionHint(): string {
  const hint = process.env.CHORD_ANALYSIS_VERSION?.trim();
  return hint && hint.length > 0 ? hint : 'chord-v1';
}

function getWaveformAnalysisVersionHint(): string {
  const hint = process.env.WAVEFORM_ANALYSIS_VERSION?.trim();
  return hint && hint.length > 0 ? hint : 'waveform-v1';
}

function normalizePathForCacheKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

async function getFileSourceSignature(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;
    return `${normalizePathForCacheKey(filePath)}|${stat.size}|${Math.floor(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

function buildChordAnalysisCacheKey(projectId: string, sourceSignature: string, analysisVersion: string): string {
  return `${projectId}::${sourceSignature}::${analysisVersion}`;
}

function buildWaveformCacheKey(projectId: string, sourceSignature: string, analysisVersion: string): string {
  return `${projectId}::${sourceSignature}::${analysisVersion}`;
}

// ============================================================================
// Mock 鏁版嵁鐢熸垚锛圥hase 2 淇濈暀锛歸aveform / chord / mock 鍥為€€锛?// ============================================================================

/** Mock 娉㈠舰锛圥hase 2 涓嶅仛鐪熷疄 waveform锛?*/
function getMockWaveform(projectId: string, durationMs: number) {
  const seed = projectId.length;
  const peaks: number[] = [];
  for (let i = 0; i < 200; i++) {
    peaks.push(
      Math.sin((i / 200) * Math.PI * (4 + seed % 4)) * 0.7
      + Math.sin((i / 200) * Math.PI * (seed % 3 + 2)) * 0.2
      + (Math.sin(i * seed) * 0.5 + 0.5) * 0.1,
    );
  }
  return {
    id: 'master',
    channels: 1,
    length: 200,
    sampleRate: 100,
    peaks,
    durationMs,
  };
}

/** Mock 鍜屽鸡鍒嗘瀽锛圥hase 2 涓嶅仛鐪熷疄 chord/BPM/key锛?*/
function getMockChordAnalysis(projectId: string, durationMs: number, createdAt: number) {
  const chords = [
    { label: 'C', simplifiedLabel: 'C', startMs: 0, endMs: 4000, confidence: 0.92 },
    { label: 'Am', simplifiedLabel: 'Am', startMs: 4000, endMs: 8000, confidence: 0.88 },
    { label: 'F', simplifiedLabel: 'F', startMs: 8000, endMs: 12000, confidence: 0.91 },
    { label: 'G', simplifiedLabel: 'G', startMs: 12000, endMs: 16000, confidence: 0.85 },
    { label: 'C', simplifiedLabel: 'C', startMs: 16000, endMs: 20000, confidence: 0.93 },
  ];
  return {
    projectId,
    source: 'mock_stub',
    analyzerType: 'rule_based',
    segments: chords,
    elapsedMs: 0,
    analyzedAt: createdAt,
    audioDurationMs: durationMs,
    analysisVersion: '0.0.0-mock',
    vocabularyVersion: 'mock',
    warnings: [
      '当前和弦/调性/BPM 为示例占位数据，非真实分析结果',
    ],
    generatedAt: createdAt,
  };
}

/**
 * Mock honest 妯″紡杞ㄩ亾鍒楄〃
 * stems 涓虹┖鏃讹紙鏈垎绂?/ mock 鍥為€€锛夋樉绀猴細1 exists(鍘熸枃浠? + 3 missing
 */
function getMockHonestStems(project: Project) {
  const playableFilePath = project.originalFilePath && fs.existsSync(project.originalFilePath)
    ? project.originalFilePath
    : '';
  const codec = project.originalFilePath
    ? path.extname(project.originalFilePath).replace('.', '') || 'wav'
    : 'wav';

  return [
    {
      id: `${project.id}-original`,
      stemType: 'other',
      codec,
      sizeBytes: project.totalSizeBytes,
      durationMs: project.durationMs ?? 0,
      sampleRate: 44100,
      exportable: false,
      filePath: playableFilePath,
      lastModifiedAt: project.createdAt,
      presence: 'exists' as const,
      mergedFrom: null,
    },
    {
      id: `${project.id}-vocal`,
      stemType: 'vocal',
      codec: 'wav',
      sizeBytes: 0,
      durationMs: project.durationMs ?? 0,
      sampleRate: 44100,
      exportable: false,
      filePath: '',
      lastModifiedAt: null,
      presence: 'missing' as const,
      mergedFrom: null,
    },
    {
      id: `${project.id}-drums`,
      stemType: 'drums',
      codec: 'wav',
      sizeBytes: 0,
      durationMs: project.durationMs ?? 0,
      sampleRate: 44100,
      exportable: false,
      filePath: '',
      lastModifiedAt: null,
      presence: 'missing' as const,
      mergedFrom: null,
    },
    {
      id: `${project.id}-bass`,
      stemType: 'bass',
      codec: 'wav',
      sizeBytes: 0,
      durationMs: project.durationMs ?? 0,
      sampleRate: 44100,
      exportable: false,
      filePath: '',
      lastModifiedAt: null,
      presence: 'missing' as const,
      mergedFrom: null,
    },
  ];
}

// ============================================================================
// Mock 鍒嗙鍥為€€锛圵orker 涓嶅彲鐢ㄦ椂锛?// ============================================================================

/** 鍒嗙鍙栨秷鏍囪锛坢ock 妯″紡鐢級 */
const cancelledMockJobs = new Set<string>();

function runMockSeparation(
  project: Project,
  jobId: string,
  win: BrowserWindow | null,
): void {
  const stages = [
    { stage: 'preprocessing', progress: 0.2 },
    { stage: 'separation', progress: 0.5 },
    { stage: 'separation', progress: 0.8 },
    { stage: 'postprocessing', progress: 0.95 },
  ];

  let step = 0;
  const timer = setInterval(() => {
    if (cancelledMockJobs.has(jobId) || !win || win.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    if (step < stages.length) {
      win.webContents.send('separation:progress', {
        jobId,
        ...stages[step],
      });
      step++;
    } else {
      clearInterval(timer);
      // mock 妯″紡涓嶆洿鏂?projectRepo 鈥?stems 涓虹┖锛実etStems 鑷姩璧?honest mock
      if (!cancelledMockJobs.has(jobId)) {
        win.webContents.send('separation:complete', {
          jobId,
          projectId: project.id,
          success: true,
          warnings: ['Worker 不可用，本次为模拟分离'],
          cacheHit: false,
        });
      }
    }
  }, 800);
}

type ImportedExistingProjectResult = {
  projectId: string;
  displayName: string;
  stemCount: number;
};

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function normalizeStemType(value: unknown, fallbackFilename: string): StemType {
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    const allowed = new Set<string>(Object.values(StemType));
    if (allowed.has(lowered)) return lowered as StemType;
  }
  return inferStemTypeFromFilename(fallbackFilename);
}

async function restoreExistingProjectFromDir(
  selectedDir: string,
  infra: WorkerInfra,
): Promise<ImportedExistingProjectResult> {
  const dirStat = await fs.promises.stat(selectedDir).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) {
    throw new Error('所选路径不是有效目录');
  }

  const manifestPath = path.join(selectedDir, 'manifest.json');
  const stemsDirByConvention = path.join(selectedDir, 'stems');
  const hasManifest = fs.existsSync(manifestPath);

  let manifestData: Record<string, unknown> | null = null;
  if (hasManifest) {
    try {
      const raw = await fs.promises.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (isObjectLike(parsed)) {
        manifestData = parsed;
      }
    } catch (err) {
      console.warn(`[project:openExisting] manifest parse failed at "${manifestPath}", fallback to stems scan`, err);
    }
  }

  // 判断扫描目录：
  // 1) 有 manifest 且有 stems 子目录 -> 用 stems 子目录
  // 2) 否则如果当前目录本身有音频文件 -> 直接扫描当前目录（兼容用户选择了 stems 目录）
  // 3) 否则如果存在 stems 子目录 -> 扫描 stems 子目录
  let scanDir = stemsDirByConvention;
  const rootEntries = await fs.promises.readdir(selectedDir).catch(() => []);
  const rootAudioFiles = rootEntries.filter((name) =>
    SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()),
  );
  if (!fs.existsSync(stemsDirByConvention) || rootAudioFiles.length > 0) {
    scanDir = selectedDir;
  }

  let stemCandidates: Array<{
    stemType: StemType;
    filePath: string;
    codec: string;
    sizeBytes: number;
    sourceOrigin: 'engine_output' | 'manual_import';
  }> = [];

  if (manifestData && Array.isArray(manifestData.stems)) {
    const manifestStems = manifestData.stems.filter(isObjectLike);
    for (const entry of manifestStems) {
      const relativePath = typeof entry.relativePath === 'string' ? entry.relativePath : '';
      if (!relativePath) continue;
      const absolute = path.isAbsolute(relativePath)
        ? relativePath
        : path.join(selectedDir, relativePath);
      if (!fs.existsSync(absolute)) continue;
      const stat = await fs.promises.stat(absolute).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      const ext = path.extname(absolute).toLowerCase();
      if (!SUPPORTED_AUDIO_EXTENSIONS.has(ext)) continue;

      stemCandidates.push({
        stemType: normalizeStemType(entry.stemType, path.basename(absolute)),
        filePath: absolute,
        codec: (typeof entry.codec === 'string' && entry.codec.trim().length > 0)
          ? entry.codec.trim().toLowerCase()
          : ext.replace('.', '') || 'wav',
        sizeBytes: stat.size,
        sourceOrigin: (entry.sourceOrigin === 'manual_import') ? 'manual_import' : 'engine_output',
      });
    }
  }

  // manifest 不可用或不可恢复时，兜底扫描文件
  if (stemCandidates.length === 0) {
    const entries = await fs.promises.readdir(scanDir).catch(() => []);
    for (const fileName of entries) {
      const ext = path.extname(fileName).toLowerCase();
      if (!SUPPORTED_AUDIO_EXTENSIONS.has(ext)) continue;
      const absPath = path.join(scanDir, fileName);
      const stat = await fs.promises.stat(absPath).catch(() => null);
      if (!stat || !stat.isFile()) continue;

      stemCandidates.push({
        stemType: inferStemTypeFromFilename(fileName),
        filePath: absPath,
        codec: ext.replace('.', '') || 'wav',
        sizeBytes: stat.size,
        sourceOrigin: 'engine_output',
      });
    }
  }

  // stemType 去重：每种类型只保留一个（优先文件更大者）
  const dedupByType = new Map<StemType, typeof stemCandidates[number]>();
  for (const candidate of stemCandidates) {
    const existing = dedupByType.get(candidate.stemType);
    if (!existing || candidate.sizeBytes > existing.sizeBytes) {
      dedupByType.set(candidate.stemType, candidate);
    }
  }
  const stems = Array.from(dedupByType.values());
  if (stems.length === 0) {
    throw new Error('所选目录中未找到可识别的分轨音频文件');
  }

  const manifestProjectId = (manifestData && typeof manifestData.projectId === 'string' && manifestData.projectId.trim().length > 0)
    ? manifestData.projectId.trim()
    : '';
  let projectId = manifestProjectId || `import-${crypto.randomUUID().slice(0, 8)}`;
  const existingProject = await infra.projectRepo.findById(projectId);
  if (existingProject && existingProject.cacheDir !== selectedDir) {
    projectId = `import-${crypto.randomUUID().slice(0, 8)}`;
  }

  const displayName = (manifestData && typeof manifestData.projectId === 'string' && manifestData.projectId.trim().length > 0)
    ? path.basename(selectedDir)
    : path.basename(selectedDir);

  const now = Date.now();
  const totalSizeBytes = stems.reduce((sum, s) => sum + s.sizeBytes, 0);
  const sourceType = (manifestData && manifestData.sourceType === ProjectSourceType.Separation)
    ? ProjectSourceType.Separation
    : ProjectSourceType.ManualImport;
  const engineVersion = (manifestData && typeof manifestData.engineVersion === 'string' && manifestData.engineVersion.trim().length > 0)
    ? manifestData.engineVersion.trim()
    : 'demucs';

  const project: Project = {
    id: projectId,
    fingerprint: '',
    sourceType,
    displayName,
    originalFilePath: null,
    cacheDir: selectedDir,
    createdAt: (manifestData && typeof manifestData.createdAt === 'number') ? manifestData.createdAt : now,
    updatedAt: now,
    durationMs: null,
    sampleRate: null,
    channels: null,
    totalSizeBytes,
    status: ProjectStatus.Ready,
    schemaVersion:
      (manifestData && typeof manifestData.schemaVersion === 'string' && manifestData.schemaVersion.trim().length > 0)
        ? manifestData.schemaVersion.trim()
        : '1.0.0',
    engineVersion,
    cacheStatus: CacheEntryStatus.Active,
  };

  await infra.projectRepo.create(project);
  await infra.stemFileRepo.deleteByProjectId(projectId);
  await infra.stemFileRepo.createMany(stems.map((s) => ({
    id: crypto.randomUUID(),
    projectId,
    stemType: s.stemType,
    filePath: s.filePath,
    codec: s.codec,
    sizeBytes: s.sizeBytes,
    durationMs: null,
    sampleRate: null,
    exists: true,
    sourceOrigin: s.sourceOrigin,
    confidence: null,
    exportable: true,
    status: StemStatus.Detected,
  })));

  waveformResultCache.delete(projectId);
  chordAnalysisResultCache.delete(projectId);

  return {
    projectId,
    displayName,
    stemCount: stems.length,
  };
}

// ============================================================================
// 娉ㄥ唽鎵€鏈?handlers
// ============================================================================

export function registerIpcHandlers(infra?: WorkerInfra): void {
  workerInfra = infra ?? null;

  // 鈹€鈹€ Project 鈹€鈹€

  ipcMain.handle('project:getRecent', async (_event, _limit: number) => {
    if (!workerInfra) return [];
    const limit = Number.isFinite(_limit) && _limit > 0 ? _limit : 20;

    // 先尝试恢复最近项目索引（重启后也能快速进入）
    try {
      const indexEntries = await readRecentProjectsIndex();
      const keptEntries: RecentProjectEntry[] = [];
      for (const entry of indexEntries) {
        if (!fs.existsSync(entry.projectDir)) {
          continue;
        }
        const existing = await workerInfra.projectRepo.findById(entry.projectId);
        if (!existing || !fs.existsSync(existing.cacheDir)) {
          try {
            const restored = await restoreExistingProjectFromDir(entry.projectDir, workerInfra);
            keptEntries.push({
              projectId: restored.projectId,
              displayName: restored.displayName,
              projectDir: entry.projectDir,
              updatedAt: Date.now(),
            });
          } catch {
            // 索引中的失效工程忽略
          }
        } else {
          keptEntries.push({
            projectId: existing.id,
            displayName: existing.displayName,
            projectDir: existing.cacheDir,
            updatedAt: Math.max(entry.updatedAt, existing.updatedAt),
          });
        }
      }
      await writeRecentProjectsIndex(keptEntries);
    } catch {
      // 最近项目索引异常时，回退到内存 repo 数据
    }

    const result = await workerInfra.projectRepo.listRecent({ limit, offset: 0 });
    const mapped = await Promise.all(result.items.map(async (p) => {
      const stems = await workerInfra!.stemFileRepo.findByProjectId(p.id);
      return {
        id: p.id,
        displayName: p.displayName,
        sourceType: p.sourceType,
        status: p.status,
        durationMs: p.durationMs,
        totalSizeBytes: p.totalSizeBytes,
        stemCount: stems.length,
        updatedAt: p.updatedAt,
      };
    }));
    return mapped;
  });

  ipcMain.handle('project:startSeparation', async (event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new Error('未选择输入文件，请先选择音频文件');
    }
    if (!fs.existsSync(filePath)) {
      throw new Error('输入文件不存在或不可访问，请重新选择音频文件');
    }

    const projectId = `proj-${crypto.randomUUID().slice(0, 8)}`;
    const jobId = `job-${crypto.randomUUID().slice(0, 8)}`;
    const fileName = path.basename(filePath);
    const fileExists = fs.existsSync(filePath);
    let fileSize = 0;
    try {
      if (fileExists) {
        fileSize = fs.statSync(filePath).size;
      }
    } catch { /* ignore */ }

    // 椤圭洰杈撳嚭鐩綍锛歶serData/projects/<projectId>/
    const outputDir = path.join(app.getPath('userData'), 'projects', projectId);
    fs.mkdirSync(outputDir, { recursive: true });

    // 鍒涘缓 Project 瀹炰綋骞跺啓鍏?projectRepo
    const now = Date.now();
    const project: Project = {
      id: projectId,
      fingerprint: '',  // Phase 2 涓嶅仛鎸囩汗璁＄畻
      sourceType: ProjectSourceType.Separation,
      displayName: fileName,
      originalFilePath: filePath,
      cacheDir: outputDir,
      createdAt: now,
      updatedAt: now,
      durationMs: null,
      sampleRate: null,
      channels: null,
      totalSizeBytes: fileSize || 0,
      status: ProjectStatus.ReadyToParse,
      schemaVersion: '1.0.0',
      engineVersion: null,
      cacheStatus: CacheEntryStatus.Active,
    };

    if (workerInfra) {
      await workerInfra.projectRepo.create(project);
    }
    try {
      await upsertRecentProjectEntry({
        projectId,
        displayName: fileName,
        projectDir: outputDir,
        updatedAt: now,
      });
    } catch {
      // 最近项目索引写入失败不应阻塞主流程
    }

    console.log(`[REAL_CHAIN] handlers.project:startSeparation entry filePath="${filePath}" projectId="${projectId}" jobId="${jobId}" outputDir="${outputDir}"`);

    const win = BrowserWindow.fromWebContents(event.sender);

    // 璇婃柇锛氬垽鏂蛋鍝潯璺緞
    const workerStatus = workerInfra?.workerManager.getStatus();
    const useRealPath = !!workerInfra && workerInfra.workerManager.isAcceptingRequests();
    console.log(`[REAL_CHAIN] handlers.project:startSeparation decision projectId="${projectId}" jobId="${jobId}" infraExists=${!!workerInfra} status=${workerStatus?.status ?? 'N/A'} accepting=${workerStatus?.acceptingRequests ?? 'N/A'} pid=${workerStatus?.pid ?? 'N/A'} branch=${useRealPath ? 'real' : 'mock'}`);

    // 濡傛灉 Worker 鍩虹璁炬柦鍙敤涓?Worker 姝ｅ湪杩愯锛屼娇鐢ㄧ湡瀹炲垎绂?
    if (useRealPath && workerInfra) {
      // 娉ㄥ唽杩涘害浜嬩欢鐩戝惉 鈫?杞彂鍒?renderer
      const unsubProgress = workerInfra.ipcBridge.on(
        WorkerEventName.StageProgress,
        (progressEvent) => {
          if (win && !win.isDestroyed()) {
            const rawProgress = typeof progressEvent.payload.progress === 'number'
              ? progressEvent.payload.progress
              : 0;
            const normalizedProgress = rawProgress <= 1 ? rawProgress * 100 : rawProgress;
            win.webContents.send('separation:progress', {
              jobId,
              stage: progressEvent.payload.stage,
              progress: Math.max(0, Math.min(100, normalizedProgress)),
            });
          }
        },
      );

      // 寮傛鎵ц鐪熷疄鍒嗙锛堜笉闃诲 IPC 杩斿洖锛?
      const infraRef = workerInfra;
      (async () => {
        try {
          console.log(`[REAL_CHAIN] handlers.project:startSeparation real_path_enter projectId="${projectId}" jobId="${jobId}"`);
          const result = await infraRef.parseJobService.startSeparation({
            projectId,
            sourceFilePath: filePath,
            projectDir: outputDir,
          });

          // 鍒嗙瀹屾垚鍚庢洿鏂?project 鐨?engineVersion / totalSizeBytes / durationMs
          const stemFiles = await infraRef.stemFileRepo.findByProjectId(projectId);
          console.log(`[REAL_CHAIN] handlers.project:startSeparation real_path_after_service projectId="${projectId}" jobId="${jobId}" stemFiles=${stemFiles.length} projectStatusAfter="${result.projectStatusAfter}"`);
          if (stemFiles.length > 0) {
            const totalSize = stemFiles.reduce((sum, s) => sum + s.sizeBytes, 0);
            const durationMs = stemFiles.reduce((max, s) => {
              const value = typeof s.durationMs === 'number' ? s.durationMs : 0;
              return value > max ? value : max;
            }, 0);
            const resolvedEngineVersion =
              (typeof result.job.engineVersion === 'string' && result.job.engineVersion.trim().length > 0)
                ? result.job.engineVersion.trim()
                : 'demucs';
            await infraRef.projectRepo.update(projectId, {
              engineVersion: resolvedEngineVersion,
              totalSizeBytes: totalSize,
              durationMs: durationMs > 0 ? durationMs : null,
            });
          }

          if (win && !win.isDestroyed()) {
            win.webContents.send('separation:complete', {
              jobId,
              projectId,
              success: result.projectStatusAfter === ProjectStatus.Ready,
              warnings: result.warnings,
              cacheHit: false,
            });
          }
        } catch (err) {
          console.error(`[REAL_CHAIN] handlers.project:startSeparation real_path_error projectId="${projectId}" jobId="${jobId}" error="${err instanceof Error ? err.message : String(err)}"`);
          // 鏇存柊 project 鐘舵€?
          try {
            await infraRef.projectRepo.updateStatus(projectId, ProjectStatus.Failed);
          } catch { /* ignore */ }

          if (win && !win.isDestroyed()) {
            const normalizedError = toSeparationFailureMessage(err);
            win.webContents.send('separation:complete', {
              jobId,
              projectId,
              success: false,
              errorMessage: normalizedError,
              warnings: [normalizedError],
              cacheHit: false,
            });
          }
        } finally {
          unsubProgress();
        }
      })();

    } else {
      // Worker 涓嶅彲鐢細鍥為€€鍒?mock 瀹氭椂鍣?      console.log(`[REAL_CHAIN] handlers.project:startSeparation mock_path_enter projectId="${projectId}" jobId="${jobId}" reason="worker_not_available"`);
      runMockSeparation(project, jobId, win);
    }

    return {
      jobId,
      projectId,
      warnings: [],
      cacheHit: false,
    };
  });

  ipcMain.handle('project:cancelSeparation', async (_event, jobId?: string) => {
    if (workerInfra) {
      await workerInfra.parseJobService.cancelSeparation(jobId ?? undefined);
    }
    if (jobId) cancelledMockJobs.add(jobId);
    return undefined;
  });

  ipcMain.handle('project:get', async (_event, projectId: string) => {
    console.log(`[IPC] project:get projectId="${projectId}"`);
    if (!workerInfra) return null;
    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) return null;
    const stems = await workerInfra.stemFileRepo.findByProjectId(projectId);
    console.log(`[REAL_CHAIN] handlers.project:get summary projectId="${projectId}" stemsLength=${stems.length}`);
    return {
      id: project.id,
      displayName: project.displayName,
      sourceType: project.sourceType,
      status: project.status,
      durationMs: project.durationMs ?? 0,
      totalSizeBytes: project.totalSizeBytes,
      stemCount: stems.length,
      updatedAt: project.updatedAt,
    };
  });

  ipcMain.handle('project:getResult', async (_event, projectId: string) => {
    console.log(`[REAL_CHAIN] handlers.project:getResult query projectId="${projectId}"`);
    if (!workerInfra) return null;

    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) return null;

    const stems = await workerInfra.stemFileRepo.findByProjectId(projectId);
    const latestJob = await workerInfra.parseJobRepo.findLatestByProjectId(projectId);

    const isRealSeparation = project.status === ProjectStatus.Ready && stems.length > 0;
    const resolvedEngineVersion =
      (typeof project.engineVersion === 'string' && project.engineVersion.trim().length > 0)
        ? project.engineVersion.trim()
        : 'demucs';
    const sourceTypeLabel = isRealSeparation
      ? `Demucs (${resolvedEngineVersion}, ${stems.length} stems)`
      : '等待分离';
    console.log(`[REAL_CHAIN] handlers.project:getResult decision projectId="${projectId}" projectStatus="${project.status}" stemCount=${stems.length} elapsedMs=${latestJob?.elapsedMs ?? 0} isRealSeparation=${isRealSeparation} sourceTypeLabel="${sourceTypeLabel}"`);

    return {
      id: project.id,
      displayName: project.displayName,
      sourceType: project.sourceType,
      status: project.status,
      durationMs: project.durationMs ?? 0,
      totalSizeBytes: isRealSeparation
        ? stems.reduce((sum, s) => sum + s.sizeBytes, 0)
        : project.totalSizeBytes,
      stemCount: stems.length,
      updatedAt: project.updatedAt,
      elapsedMs: latestJob?.elapsedMs ?? 0,
      cacheHit: false,
      cacheHitBannerText: null,
      sourceTypeLabel,
    };
  });

  ipcMain.handle('project:getStems', async (_event, projectId: string) => {
    console.log(`[REAL_CHAIN] handlers.project:getStems query projectId="${projectId}"`);
    if (!workerInfra) return [];

    // 鏌ヨ鐪熷疄 stem 鏂囦欢
    const stems = await workerInfra.stemFileRepo.findByProjectId(projectId);
    console.log(`[REAL_CHAIN] handlers.project:getStems repo_result projectId="${projectId}" stemsLength=${stems.length}`);

    if (stems.length > 0) {
      console.log(`[REAL_CHAIN] handlers.project:getStems fallbackHit=false projectId="${projectId}"`);
      // 鏈夌湡瀹?stems 鈥?杩斿洖 StemTrackDTO
      const project = await workerInfra.projectRepo.findById(projectId);
      return stems.map(sf => ({
        id: sf.id,
        stemType: sf.stemType,
        codec: sf.codec,
        sizeBytes: sf.sizeBytes,
        durationMs: (typeof sf.durationMs === 'number' && sf.durationMs > 0)
          ? sf.durationMs
          : (project?.durationMs ?? 0),
        sampleRate: sf.sampleRate ?? 44100,
        exportable: sf.exportable,
        filePath: sf.filePath,
        lastModifiedAt: project?.createdAt ?? Date.now(),
        presence: 'exists' as const,
        mergedFrom: null,
      }));
    }

    // 鏃犵湡瀹?stems 鈥?mock honest fallback
    console.log(`[REAL_CHAIN] handlers.project:getStems fallbackHit=true projectId="${projectId}"`);
    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) return [];
    return getMockHonestStems(project);
  });

  ipcMain.handle('project:openExisting', async () => {
    if (!workerInfra) {
      throw new Error('项目恢复服务不可用，请重启应用后重试');
    }

    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择已分离工程目录',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const selectedDir = result.filePaths[0];
    let restored: ImportedExistingProjectResult;
    try {
      restored = await restoreExistingProjectFromDir(selectedDir, workerInfra);
    } catch (err) {
      throw new Error(normalizeErrorMessage(err, '导入已有工程失败，请确认目录有效且包含分轨文件'));
    }
    try {
      await upsertRecentProjectEntry({
        projectId: restored.projectId,
        displayName: restored.displayName,
        projectDir: selectedDir,
        updatedAt: Date.now(),
      });
    } catch {
      // 最近项目索引写入失败不应阻塞打开流程
    }
    console.log(`[REAL_CHAIN] handlers.project:openExisting restored projectId="${restored.projectId}" stemCount=${restored.stemCount} dir="${selectedDir}"`);
    return restored;
  });

  ipcMain.handle('project:openDir', async (_event, projectId: string) => {
    const openPathOrThrow = async (targetPath: string) => {
      const openError = await shell.openPath(targetPath);
      if (openError) {
        throw new Error(`无法打开目录: ${openError}`);
      }
      return { opened: true, path: targetPath };
    };

    if (workerInfra) {
      const project = await workerInfra.projectRepo.findById(projectId);
      if (project && fs.existsSync(project.cacheDir)) {
        return openPathOrThrow(project.cacheDir);
      }
    }

    // 回退：即便内存 repo 丢失，也尝试按约定路径打开当前项目目录
    const fallbackProjectDir = path.join(app.getPath('userData'), 'projects', projectId);
    if (fs.existsSync(fallbackProjectDir)) {
      return openPathOrThrow(fallbackProjectDir);
    }

    // 再回退：若项目来自“最近项目索引”且目录不在约定路径，仍可直接打开
    const indexedProjectDir = await resolveRecentProjectDirByProjectId(projectId);
    if (indexedProjectDir) {
      return openPathOrThrow(indexedProjectDir);
    }

    throw new Error('项目结果目录不存在，可能已被删除或移动');
  });

  ipcMain.handle('project:getWaveform', async (_event, projectId: string) => {
    console.log(`[IPC] project:getWaveform projectId="${projectId}"`);
    if (!workerInfra) return null;
    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) return null;

    // Prefer original mixed source; fallback to first valid analysis source to keep waveform renderable.
    const sourceFilePath = await resolveAnalysisSourceFilePath(project, workerInfra);
    if (!sourceFilePath) {
      console.log(`[REAL_CHAIN] handlers.project:getWaveform miss projectId="${projectId}" reason="no_source_file"`);
      return null;
    }

    const expectedAnalysisVersion = getWaveformAnalysisVersionHint();
    const sourceSignature = await getFileSourceSignature(sourceFilePath);
    const cached = waveformResultCache.get(projectId);
    if (cached && sourceSignature) {
      const cacheHit =
        cached.sourceSignature === sourceSignature
        && cached.analysisVersion === expectedAnalysisVersion;
      if (cacheHit) {
        console.log(`[REAL_CHAIN] handlers.project:getWaveform cache_hit projectId="${projectId}" analysisVersion="${cached.analysisVersion}"`);
        return cached.result;
      }
      console.log(
        `[REAL_CHAIN] handlers.project:getWaveform cache_miss projectId="${projectId}" ` +
        `reason="signature_or_version_changed" cachedVersion="${cached.analysisVersion}" expectedVersion="${expectedAnalysisVersion}"`,
      );
    } else if (!sourceSignature) {
      // Signature unavailable: never trust old cache, but still try to generate fresh waveform.
      console.log(
        `[REAL_CHAIN] handlers.project:getWaveform cache_bypass projectId="${projectId}" ` +
        `reason="source_signature_unavailable"`,
      );
    }

    if (!ensureWorkerAcceptingRequests(workerInfra)) {
      console.log(`[REAL_CHAIN] handlers.project:getWaveform miss projectId="${projectId}" reason="worker_not_ready"`);
      if (cached) {
        console.log(`[REAL_CHAIN] handlers.project:getWaveform return_stale_cache projectId="${projectId}"`);
        return cached.result;
      }
      return null;
    }

    try {
      const response = await workerInfra.ipcBridge.send(
        WorkerCommand.GenerateWaveform,
        {
          projectId,
          filePath: sourceFilePath,
          peakCount: 1200,
        },
        120_000,
      );
      if (!response.success) {
        const code = response.error?.code ?? 'UNKNOWN_ERROR';
        const message = response.error?.message ?? 'generate_waveform failed';
        throw new Error(`${code}: ${message}`);
      }

      const validated = workerInfra.schemaValidator.validate<CachedWaveformDTO>(
        WorkerCommand.GenerateWaveform,
        response,
      );
      if (!validated.valid || !validated.data) {
        throw new Error(
          `Waveform schema validation failed: ${
            validated.validationErrors?.map((e) => e.message).join('; ') ?? 'unknown'
          }`,
        );
      }

      const raw = validated.data;
      const waveform: CachedWaveformDTO = {
        id: typeof raw.id === 'string' ? raw.id : 'master',
        channels: Math.max(1, Math.floor(raw.channels)),
        length: Math.max(0, Math.floor(raw.length)),
        sampleRate: Math.max(1, Math.floor(raw.sampleRate)),
        peaks: Array.isArray(raw.peaks) ? raw.peaks.filter((v) => typeof v === 'number') : [],
        durationMs: Math.max(0, Math.floor(raw.durationMs)),
        analysisVersion: typeof (raw as { analysisVersion?: unknown }).analysisVersion === 'string'
          ? (raw as { analysisVersion: string }).analysisVersion
          : expectedAnalysisVersion,
      };

      if (project.durationMs == null && waveform.durationMs > 0) {
        await workerInfra.projectRepo.update(projectId, { durationMs: waveform.durationMs });
      }

      const resolvedAnalysisVersion = waveform.analysisVersion ?? expectedAnalysisVersion;
      if (sourceSignature) {
        waveformResultCache.set(projectId, {
          cacheKey: buildWaveformCacheKey(projectId, sourceSignature, resolvedAnalysisVersion),
          sourceFilePath,
          sourceSignature,
          analysisVersion: resolvedAnalysisVersion,
          cachedAt: Date.now(),
          result: waveform,
        });
      }
      console.log(
        `[REAL_CHAIN] handlers.project:getWaveform return projectId="${projectId}" ` +
        `source="${sourceFilePath}" peaks=${waveform.peaks.length} durationMs=${waveform.durationMs}`,
      );
      return waveform;
    } catch (err) {
      console.warn(`[Analysis] getWaveform unavailable. projectId=${projectId}, reason=${normalizeErrorMessage(err, 'unknown')}`);
      if (cached) {
        console.log(`[REAL_CHAIN] handlers.project:getWaveform return_stale_cache_on_error projectId="${projectId}"`);
        return cached.result;
      }
      return null;
    }
  });

  ipcMain.handle('project:getChordAnalysis', async (_event, projectId: string) => {
    console.log(`[IPC] project:getChordAnalysis projectId="${projectId}"`);
    if (!workerInfra) return null;
    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) return null;

    const sourceFilePath = await resolveAnalysisSourceFilePath(project, workerInfra);
    if (!sourceFilePath) {
      return getMockChordAnalysis(projectId, project.durationMs ?? 0, project.createdAt);
    }
    const sourceKind = project.originalFilePath
      && fs.existsSync(project.originalFilePath)
      && path.resolve(project.originalFilePath) === path.resolve(sourceFilePath)
      ? 'original'
      : 'stem';

    const sourceSignature = await getFileSourceSignature(sourceFilePath);
    console.log(
      `[REAL_CHAIN] handlers.project:getChordAnalysis source_resolved projectId="${projectId}" ` +
      `source_kind="${sourceKind}" source_signature_available=${sourceSignature != null}`,
    );

    const expectedAnalysisVersion = getChordAnalysisVersionHint();
    const cached = chordAnalysisResultCache.get(projectId);
    if (cached && sourceSignature) {
      const cacheHit =
        cached.sourceSignature === sourceSignature
        && cached.analysisVersion === expectedAnalysisVersion;
      if (cacheHit) {
        const cachedResult = cached.result;
        console.log(
          `[REAL_CHAIN] handlers.project:getChordAnalysis cache_hit projectId="${projectId}" ` +
          `source_kind="${sourceKind}" analysisVersion="${cached.analysisVersion}" ` +
          `segments=${cachedResult.segments.length} key_empty=${!cachedResult.estimatedKey} ` +
          `has_warning=${(cachedResult.warnings?.length ?? 0) > 0}`,
        );
        return cached.result;
      }
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis cache_miss projectId="${projectId}" ` +
        `reason="signature_or_version_changed" cachedVersion="${cached.analysisVersion}" expectedVersion="${expectedAnalysisVersion}"`,
      );
    } else if (!sourceSignature) {
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis cache_bypass projectId="${projectId}" ` +
        `source_kind="${sourceKind}" reason="source_signature_unavailable" analysisVersion="${expectedAnalysisVersion}"`,
      );
    }

    if (!ensureWorkerAcceptingRequests(workerInfra)) {
      return getMockChordAnalysis(projectId, project.durationMs ?? 0, project.createdAt);
    }

    try {
      const response = await workerInfra.ipcBridge.send(
        WorkerCommand.ExecuteChordAnalysis,
        {
          projectId,
          filePath: sourceFilePath,
        },
        180_000,
      );
      if (!response.success) {
        const code = response.error?.code ?? 'UNKNOWN_ERROR';
        const message = response.error?.message ?? 'execute_chord_analysis failed';
        throw new Error(`${code}: ${message}`);
      }

      const validated = workerInfra.schemaValidator.validate<CachedChordAnalysisDTO>(
        WorkerCommand.ExecuteChordAnalysis,
        response,
      );
      if (!validated.valid || !validated.data) {
        throw new Error(
          `Chord schema validation failed: ${
            validated.validationErrors?.map((e) => e.message).join('; ') ?? 'unknown'
          }`,
        );
      }

      const raw = validated.data;
      const segments = (Array.isArray(raw.segments) ? raw.segments : [])
        .filter((seg) => seg && typeof seg.startMs === 'number' && typeof seg.endMs === 'number' && typeof seg.label === 'string')
        .map((seg) => ({
          startMs: Math.max(0, Math.floor(seg.startMs)),
          endMs: Math.max(0, Math.floor(seg.endMs)),
          label: seg.label,
          simplifiedLabel: typeof seg.simplifiedLabel === 'string' ? seg.simplifiedLabel : undefined,
          confidence: typeof seg.confidence === 'number' ? seg.confidence : undefined,
          sourceFlags: Array.isArray(seg.sourceFlags) ? seg.sourceFlags.filter((f) => typeof f === 'string') : undefined,
        }));

      const rawEstimatedBpm = typeof raw.estimatedBpm === 'number' && Number.isFinite(raw.estimatedBpm)
        ? raw.estimatedBpm
        : undefined;
      const normalizedEstimatedBpm = rawEstimatedBpm != null && rawEstimatedBpm >= 40 && rawEstimatedBpm <= 240
        ? rawEstimatedBpm
        : undefined;
      const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((w) => typeof w === 'string') : [];
      if (rawEstimatedBpm != null && normalizedEstimatedBpm == null) {
        warnings.push('BPM 估计值不稳定，已隐藏该字段');
      }
      if (!warnings.some((w) => w.includes('仅供参考'))) {
        warnings.push('和弦、调性与 BPM 为算法估计值，仅供参考');
      }

      const chordResult: CachedChordAnalysisDTO = {
        projectId,
        source: typeof raw.source === 'string' ? raw.source : 'mixed',
        analyzerType: typeof raw.analyzerType === 'string' ? raw.analyzerType : 'rule_based',
        segments,
        elapsedMs: typeof raw.elapsedMs === 'number' ? Math.max(0, Math.floor(raw.elapsedMs)) : 0,
        analyzedAt: typeof raw.analyzedAt === 'number' ? raw.analyzedAt : Date.now(),
        audioDurationMs: typeof raw.audioDurationMs === 'number' ? Math.max(0, Math.floor(raw.audioDurationMs)) : (project.durationMs ?? 0),
        estimatedKey: typeof raw.estimatedKey === 'string' ? raw.estimatedKey : undefined,
        estimatedBpm: normalizedEstimatedBpm,
        analysisVersion: typeof raw.analysisVersion === 'string' ? raw.analysisVersion : expectedAnalysisVersion,
        vocabularyVersion: typeof raw.vocabularyVersion === 'string' ? raw.vocabularyVersion : 'triad-v1',
        warnings,
        generatedAt: typeof raw.generatedAt === 'number' ? raw.generatedAt : Date.now(),
      };
      if (sourceKind !== 'original') {
        chordResult.warnings = Array.from(
          new Set([...(chordResult.warnings ?? []), '当前和弦/调性分析输入为 stem 回退源，结果稳定性可能降低']),
        );
      }

      if (project.durationMs == null && chordResult.audioDurationMs > 0) {
        await workerInfra.projectRepo.update(projectId, { durationMs: chordResult.audioDurationMs });
      }

      const resolvedAnalysisVersion = chordResult.analysisVersion ?? expectedAnalysisVersion;
      if (sourceSignature) {
        chordAnalysisResultCache.set(projectId, {
          cacheKey: buildChordAnalysisCacheKey(projectId, sourceSignature, resolvedAnalysisVersion),
          sourceFilePath,
          sourceSignature,
          analysisVersion: resolvedAnalysisVersion,
          cachedAt: Date.now(),
          result: chordResult,
        });
      }
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis result_summary projectId="${projectId}" ` +
        `source_kind="${sourceKind}" analysisVersion="${resolvedAnalysisVersion}" ` +
        `segments=${chordResult.segments.length} key_empty=${!chordResult.estimatedKey} ` +
        `has_warning=${(chordResult.warnings?.length ?? 0) > 0}`,
      );
      return chordResult;
    } catch (err) {
      const fallback = getMockChordAnalysis(projectId, project.durationMs ?? 0, project.createdAt);
      const warning = toAnalysisFailureMessage(err, '真实和弦分析失败，已回退到示例数据');
      fallback.warnings = Array.from(new Set([...(fallback.warnings ?? []), warning]));
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis fallback_summary projectId="${projectId}" ` +
        `source_kind="${sourceKind}" analysisVersion="${expectedAnalysisVersion}" ` +
        `segments=${fallback.segments.length} has_warning=true`,
      );
      return fallback;
    }
  });

  // 鈹€鈹€ Cache 鈹€鈹€

  ipcMain.handle('cache:getStats', async () => {
    if (!workerInfra) {
      return { totalSizeBytes: 0, projectCount: 0, entries: [] };
    }
    const result = await workerInfra.projectRepo.listRecent({ limit: 100, offset: 0 });
    const totalSize = result.items.reduce((sum, p) => sum + p.totalSizeBytes, 0);
    return {
      totalSizeBytes: totalSize,
      projectCount: result.items.length,
      entries: await Promise.all(result.items.map(async (p) => {
        const stems = await workerInfra!.stemFileRepo.findByProjectId(p.id);
        return {
          projectId: p.id,
          displayName: p.displayName,
          sizeBytes: p.totalSizeBytes,
          stemCount: stems.length,
          createdAt: p.createdAt,
          lastAccessedAt: p.updatedAt,
          openDirAvailable: fs.existsSync(p.cacheDir),
        };
      })),
    };
  });

  ipcMain.handle('cache:clearProject', async (_event, projectId: string) => {
    if (workerInfra) {
      await workerInfra.stemFileRepo.deleteByProjectId(projectId);
      await workerInfra.projectRepo.delete(projectId);
    }
    waveformResultCache.delete(projectId);
    chordAnalysisResultCache.delete(projectId);
    try {
      await removeRecentProjectEntryByProjectId(projectId);
    } catch {
      // 最近项目索引清理失败不应中断删除主流程
    }
    return {
      succeededIds: [projectId],
      failedItems: [],
      allSuccess: true,
      freedBytes: 0,
      elapsedMs: 0,
    };
  });

  ipcMain.handle('cache:clearAll', async () => {
    const ids: string[] = [];
    if (workerInfra) {
      const result = await workerInfra.projectRepo.listRecent({ limit: 1000, offset: 0 });
      for (const p of result.items) {
        ids.push(p.id);
        await workerInfra.stemFileRepo.deleteByProjectId(p.id);
        await workerInfra.projectRepo.delete(p.id);
      }
    }
    waveformResultCache.clear();
    chordAnalysisResultCache.clear();
    try {
      await clearRecentProjectsIndex();
    } catch {
      // 最近项目索引清理失败不应中断主流程
    }
    return {
      succeededIds: ids,
      failedItems: [],
      allSuccess: true,
      freedBytes: 0,
      elapsedMs: 0,
    };
  });

  ipcMain.handle('cache:openProjectDir', async (_event, projectId: string) => {
    if (workerInfra) {
      const project = await workerInfra.projectRepo.findById(projectId);
      if (project && fs.existsSync(project.cacheDir)) {
        shell.openPath(project.cacheDir);
        return { opened: true, path: project.cacheDir };
      }
    }

    const indexedProjectDir = await resolveRecentProjectDirByProjectId(projectId);
    if (indexedProjectDir) {
      shell.openPath(indexedProjectDir);
      return { opened: true, path: indexedProjectDir };
    }

    throw new Error('项目目录不存在，可能已被删除或移动');
  });

  ipcMain.handle('cache:openRoot', () => {
    const userDataPath = app.getPath('userData');
    shell.openPath(userDataPath);
    return { opened: true, path: userDataPath };
  });

  // 鈹€鈹€ Export (Phase 2: real file copy) 鈹€鈹€

  ipcMain.handle('export:stems', async (
    _event,
    request: { projectId: string; stemIds: string[]; outputDir: string; format?: string },
  ) => {
    const startedAt = Date.now();
    const requestStemIds = Array.isArray(request.stemIds) ? request.stemIds : [];
    const format = request.format ?? 'wav';
    const warnings: string[] = [];
    let renamedCount = 0;

    const makeError = (
      code: string,
      userMessage: string,
      message: string,
      projectId: string,
      stemId: string,
      filePath: string | undefined,
      operation: string,
      retryable: boolean,
    ) => ({
      code,
      message,
      userMessage,
      retryable,
      context: {
        projectId,
        stemId,
        exportFormat: format,
        filePath,
        operation,
        elapsedMs: Date.now() - startedAt,
      },
    });

    const allStems = workerInfra
      ? await workerInfra.stemFileRepo.findByProjectId(request.projectId)
      : [];
    const exportableStems = allStems.filter(
      (s) => s.exists && s.exportable && typeof s.filePath === 'string' && s.filePath.trim().length > 0,
    );
    const stemMap = new Map(exportableStems.map((s) => [s.id, s]));

    const targetStemIds = requestStemIds.length > 0
      ? requestStemIds
      : exportableStems.map((s) => s.id);

    const results: Array<{
      projectId: string;
      stemId: string;
      status: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
      success: boolean;
      outputPath: string | null;
      outputSizeBytes: number | null;
      error: {
        code: string;
        message: string;
        userMessage: string;
        retryable: boolean;
        context: Record<string, unknown>;
      } | null;
    }> = [];

    // 输出目录校验（用户取消目录选择由 renderer 层处理，此处只处理非法目录）
    if (!request.outputDir || request.outputDir.trim().length === 0) {
      for (const stemId of targetStemIds) {
        results.push({
          projectId: request.projectId,
          stemId,
          status: 'failed',
          success: false,
          outputPath: null,
          outputSizeBytes: null,
          error: makeError(
            'EXPORT_OUTPUT_DIR_EMPTY',
            '导出目录无效，请重新选择目录',
            'Output directory is empty',
            request.projectId,
            stemId,
            undefined,
            'validateOutputDir',
            true,
          ),
        });
      }
    } else {
      try {
        if (!fs.existsSync(request.outputDir)) {
          throw new Error('OUTPUT_DIR_NOT_FOUND');
        }
        const stat = fs.statSync(request.outputDir);
        if (!stat.isDirectory()) {
          throw new Error('OUTPUT_DIR_NOT_DIRECTORY');
        }
        fs.accessSync(request.outputDir, fs.constants.W_OK);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        let code = 'EXPORT_OUTPUT_DIR_UNAVAILABLE';
        let userMessage = '导出目录不可用，请重新选择目录';
        if (errorMessage.includes('OUTPUT_DIR_NOT_FOUND')) {
          code = 'EXPORT_OUTPUT_DIR_NOT_FOUND';
          userMessage = '导出目录不存在，请重新选择目录';
        } else if (errorMessage.includes('OUTPUT_DIR_NOT_DIRECTORY')) {
          code = 'EXPORT_OUTPUT_DIR_INVALID';
          userMessage = '所选路径不是目录，请重新选择目录';
        } else if ((err as NodeJS.ErrnoException)?.code === 'EACCES') {
          code = 'EXPORT_OUTPUT_DIR_NOT_WRITABLE';
          userMessage = '导出目录不可写，请选择有权限的目录';
        }
        for (const stemId of targetStemIds) {
          results.push({
            projectId: request.projectId,
            stemId,
            status: 'failed',
            success: false,
            outputPath: null,
            outputSizeBytes: null,
            error: makeError(
              code,
              userMessage,
              errorMessage,
              request.projectId,
              stemId,
              undefined,
              'validateOutputDir',
              true,
            ),
          });
        }
      }
    }

    // 目录校验通过后，逐轨复制
    if (results.length === 0) {
      if (isProjectLikeDirectory(request.outputDir)) {
        warnings.push('检测到目标目录可能是另一个工程目录；导出将避免覆盖同名文件。');
      }
      for (const stemId of targetStemIds) {
        const stem = stemMap.get(stemId);
        if (!stem) {
          results.push({
            projectId: request.projectId,
            stemId,
            status: 'skipped',
            success: false,
            outputPath: null,
            outputSizeBytes: null,
            error: makeError(
              'EXPORT_STEM_NOT_EXPORTABLE',
              '该轨道不可导出',
              `Stem ${stemId} is not exportable or does not exist`,
              request.projectId,
              stemId,
              undefined,
              'resolveStem',
              false,
            ),
          });
          continue;
        }

        const sourcePath = stem.filePath;
        if (!fs.existsSync(sourcePath)) {
          results.push({
            projectId: request.projectId,
            stemId,
            status: 'failed',
            success: false,
            outputPath: null,
            outputSizeBytes: null,
            error: makeError(
              'EXPORT_SOURCE_NOT_FOUND',
              '源文件不存在，无法导出',
              `Source stem file not found: ${sourcePath}`,
              request.projectId,
              stemId,
              sourcePath,
              'checkSourceFile',
              true,
            ),
          });
          continue;
        }

        const sourceFileName = path.basename(sourcePath);
        const { targetPath, renamed } = resolveUniqueExportPath(request.outputDir, sourceFileName);
        if (renamed) renamedCount += 1;

        try {
          await fs.promises.copyFile(sourcePath, targetPath);
          const copied = await fs.promises.stat(targetPath);
          results.push({
            projectId: request.projectId,
            stemId,
            status: 'succeeded',
            success: true,
            outputPath: targetPath,
            outputSizeBytes: copied.size,
            error: null,
          });
        } catch (err) {
          const error = err as NodeJS.ErrnoException;
          let code = 'EXPORT_COPY_FAILED';
          let userMessage = '文件复制失败，请重试';
          if (error.code === 'EACCES') {
            code = 'EXPORT_COPY_PERMISSION_DENIED';
            userMessage = '导出失败：目录或文件无写入权限';
          } else if (error.code === 'ENOENT') {
            code = 'EXPORT_COPY_PATH_NOT_FOUND';
            userMessage = '导出失败：源文件或目标目录不存在';
          }
          results.push({
            projectId: request.projectId,
            stemId,
            status: 'failed',
            success: false,
            outputPath: null,
            outputSizeBytes: null,
            error: makeError(
              code,
              userMessage,
              error.message ?? String(err),
              request.projectId,
              stemId,
              sourcePath,
              'copyFile',
              true,
            ),
          });
        }
      }
    }

    if (renamedCount > 0) {
      warnings.push(`检测到同名文件冲突，已自动重命名 ${renamedCount} 个文件。`);
    }

    const succeededIds = results.filter((r) => r.status === 'succeeded').map((r) => r.stemId);
    const failedIds = results.filter((r) => r.status === 'failed').map((r) => r.stemId);
    const skippedIds = results.filter((r) => r.status === 'skipped').map((r) => r.stemId);
    const cancelledIds = results.filter((r) => r.status === 'cancelled').map((r) => r.stemId);
    const allSuccess = results.length > 0 && failedIds.length === 0 && skippedIds.length === 0 && cancelledIds.length === 0;

    return {
      projectId: request.projectId,
      results,
      succeededIds,
      failedIds,
      skippedIds,
      cancelledIds,
      allSuccess,
      cancelled: false,
      elapsedMs: Date.now() - startedAt,
      warnings,
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


