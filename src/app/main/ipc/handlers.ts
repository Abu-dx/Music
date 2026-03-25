/**
 * @module app/main/ipc/handlers
 * @description IPC handler 娉ㄥ唽 鈥?鐪熷疄 Worker 鍒嗙 + mock waveform/chord
 *
 * Phase 2 MVP:
 * - startSeparation: 閫氳繃 ParseJobService 璋冪敤鐪熷疄 Demucs Worker
 * - getStemsByProject: 浠?stemFileRepo 杩斿洖鐪熷疄 stem 鏂囦欢璺緞
 * - getProjectResult: 鐪熷疄鍒嗙鍚?sourceTypeLabel 涓嶅惈"妯℃嫙"
 * - getWaveform / getChordAnalysis: 浼樺厛璧扮湡瀹?Worker 鍒嗘瀽锛屽け璐ユ椂涓嶅啀鍥為€€鍋囨暟鎹?
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
import {
  patchProjectManifestMetadata,
  ProjectManifestResultSetEntry,
} from './projectManifestMetadata';
import {
  readManifestAnalysisRefs,
  patchManifestAnalysisRefs,
  readProjectJsonRecord,
  writeProjectJsonRecord,
} from './projectManifestAnalysisCache';

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
  symbol?: string;
  chordType?: string;
  quality?: string;
  bassNote?: string;
  adds?: string[];
  suspensions?: string[];
  extensions?: string[];
  alterations?: string[];
  omissions?: string[];
  candidates?: Array<{
    label: string;
    confidence?: number;
    method?: string;
  }>;
  method?: string;
  vocabularyTag?: string;
};

type CachedTempoAnalysisDTO = {
  primaryBpm?: number;
  confidence?: number;
  method: string;
  candidates: Array<{
    bpm: number;
    confidence?: number;
    relation?: string;
    method?: string;
  }>;
  ambiguity?: {
    isAmbiguous: boolean;
    halfTimeBpm?: number;
    doubleTimeBpm?: number;
    reason?: string;
    explanation?: string;
    confidenceGap?: number;
  };
  methodMetadata?: {
    backend?: string;
    sampleRate?: number;
    hopLength?: number;
    beatCount?: number;
    stability?: {
      isStable?: boolean;
      cv?: number;
      confidenceRatio?: number;
    };
    [key: string]: unknown;
  };
};

type CachedChordAnalysisDTO = {
  projectId: string;
  parentResultId?: string;
  sourceSignature?: string;
  source: string;
  analyzerType: string;
  analysisMethods?: {
    chordAnalyzer: string;
    tempoAnalyzer: string;
    chordAnalyzerVersion?: string;
    tempoAnalyzerVersion?: string;
    vocabularyTag?: string;
  };
  segments: CachedChordSegmentDTO[];
  elapsedMs: number;
  analyzedAt: number;
  audioDurationMs: number;
  estimatedKey?: string;
  estimatedBpm?: number;
  tempo?: CachedTempoAnalysisDTO;
  tempoAnalysisVersion?: string;
  analysisVersion?: string;
  vocabularyVersion?: string;
  analyzerFingerprint?: string;
  chordVocabulary?: {
    selected: string;
    supportsExtendedChords: boolean;
    supportedDescriptors: string[];
  };
  warnings?: string[];
  generatedAt?: number;
};

type CachedChordAnalysisEntry = {
  cacheKey: string;
  parentResultId: string;
  sourceFilePath: string;
  sourceSignature: string;
  analysisVersion: string;
  cachedAt: number;
  result: CachedChordAnalysisDTO;
};

type CachedWaveformEntry = {
  cacheKey: string;
  parentResultId: string;
  sourceFilePath: string;
  sourceSignature: string;
  analysisVersion: string;
  cachedAt: number;
  result: CachedWaveformDTO;
};

const waveformResultCache = new Map<string, CachedWaveformEntry>();
const chordAnalysisResultCache = new Map<string, CachedChordAnalysisEntry>();
const DEFAULT_WAVEFORM_CACHE_PATH = 'waveform/master-waveform.json';
const DEFAULT_CHORD_CACHE_PATH = 'chord/chord-analysis.json';
const DEFAULT_ACTIVE_RESULT_ID = 'main';
const DEFAULT_CHORD_ANALYZER_ID = 'chord_rule_chroma_v1';
const DEFAULT_TEMPO_ANALYZER_ID = 'tempo_rule_onset_v1';
const DEFAULT_TEMPO_ANALYSIS_VERSION = 'tempo-v1';
const DEFAULT_CHORD_VOCABULARY_VERSION = 'triad-v1';
const DEFAULT_RESULT_MODEL_ID = 'demucs';
const DEFAULT_RESULT_RUNTIME_PROFILE_ID = 'demucs_env_override';
const PILOT_MODEL_ID = 'htdemucs_6s';
const PILOT_RUNTIME_PROFILE_ID = 'demucs_6s_pilot';

function buildProjectScopedCachePrefix(projectId: string): string {
  return `${projectId}::`;
}

function clearProjectScopedCacheEntries<T>(cache: Map<string, T>, projectId: string): void {
  const prefix = buildProjectScopedCachePrefix(projectId);
  const keysToDelete: string[] = [];
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    cache.delete(key);
  }
}

function getWaveformCacheEntry(
  projectId: string,
  parentResultId: string,
  sourceSignature: string | null,
  analysisVersion: string,
): CachedWaveformEntry | null {
  if (!sourceSignature) return null;
  const cacheKey = buildWaveformCacheKey(projectId, parentResultId, sourceSignature, analysisVersion);
  return waveformResultCache.get(cacheKey) ?? null;
}

function setWaveformCacheEntry(entry: CachedWaveformEntry): void {
  waveformResultCache.set(entry.cacheKey, entry);
}

function getChordCacheEntry(
  projectId: string,
  parentResultId: string,
  sourceSignature: string | null,
  analysisVersion: string,
  analyzerFingerprint: string,
): CachedChordAnalysisEntry | null {
  if (!sourceSignature) return null;
  const cacheKey = buildChordAnalysisCacheKey(
    projectId,
    parentResultId,
    sourceSignature,
    analysisVersion,
    analyzerFingerprint,
  );
  const strict = chordAnalysisResultCache.get(cacheKey);
  if (strict) return strict;

  // Legacy fallback: old in-memory entries were keyed without analyzer fingerprint.
  const legacyKey = buildLegacyChordAnalysisCacheKey(projectId, parentResultId, sourceSignature, analysisVersion);
  const legacy = chordAnalysisResultCache.get(legacyKey);
  if (!legacy) return null;
  const legacyFingerprint = legacy.result.analyzerFingerprint
    ?? deriveAnalyzerFingerprintFromResult(legacy.result);
  return legacyFingerprint === analyzerFingerprint ? legacy : null;
}

function setChordCacheEntry(entry: CachedChordAnalysisEntry): void {
  chordAnalysisResultCache.set(entry.cacheKey, entry);
}

type ActiveResultContext = {
  activeResultId: string;
  sourceSignature: string | null;
};

function normalizeParentResultId(value: string | null | undefined): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : DEFAULT_ACTIVE_RESULT_ID;
}

function filterStemsForResultSet<T extends { parentResultId?: string }>(
  stems: T[],
  activeResultId: string,
): T[] {
  const target = normalizeParentResultId(activeResultId);
  return stems.filter((stem) => normalizeParentResultId(stem.parentResultId) === target);
}

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
  if (raw.includes('TASK_CANCELLED') || raw.includes('cancelled') || raw.includes('已取消')) {
    return '分离已取消';
  }
  if (raw.includes('manifest') || raw.includes('MANIFEST')) {
    return '分离结果已生成，但项目元数据写入失败，请查看日志并重试';
  }
  if (raw.includes('SEPARATION_STEMS_NOT_PERSISTED')) {
    return '分离完成但轨道写入失败，请重试';
  }
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
    return '分析输入文件不存在，未返回分析结果';
  }
  if (raw.includes('ANALYSIS_DEPENDENCY_MISSING')) {
    return '分析依赖缺失（librosa/torchaudio），未返回分析结果';
  }
  if (raw.includes('WORKER_IPC') || raw.includes('Worker')) {
    return '分析 Worker 不可用，未返回分析结果';
  }
  return raw;
}

function isSeparationCancelledError(err: unknown): boolean {
  if (isObjectLike(err)) {
    const code = typeof err.code === 'string' ? err.code : '';
    if (code === 'TASK_CANCELLED') return true;
  }
  const raw = normalizeErrorMessage(err, '');
  if (!raw) return false;
  return raw.includes('TASK_CANCELLED') || raw.includes('cancelled') || raw.includes('已取消');
}

async function runCancelledNewProjectCleanup(
  infra: WorkerInfra,
  projectId: string,
): Promise<void> {
  console.log(`[REAL_CHAIN] handlers.project:startSeparation cleanup_begin projectId="${projectId}"`);

  try {
    await infra.stemFileRepo.deleteByProjectId(projectId);
    console.log(`[REAL_CHAIN] handlers.project:startSeparation cleanup_delete_stems ok projectId="${projectId}"`);
  } catch (err) {
    console.warn(
      `[REAL_CHAIN] handlers.project:startSeparation cleanup_delete_stems fail projectId="${projectId}" error="${normalizeErrorMessage(err, 'unknown')}"`,
    );
  }

  try {
    await infra.projectRepo.delete(projectId);
    console.log(`[REAL_CHAIN] handlers.project:startSeparation cleanup_delete_project ok projectId="${projectId}"`);
  } catch (err) {
    console.warn(
      `[REAL_CHAIN] handlers.project:startSeparation cleanup_delete_project fail projectId="${projectId}" error="${normalizeErrorMessage(err, 'unknown')}"`,
    );
  }

  try {
    const beforeEntries = await readRecentProjectsIndex();
    const beforeCount = beforeEntries.length;
    await removeRecentProjectEntryByProjectId(projectId);
    const afterEntries = await readRecentProjectsIndex();
    const afterCount = afterEntries.length;
    console.log(
      `[REAL_CHAIN] handlers.project:startSeparation cleanup_remove_recent ok projectId="${projectId}" beforeCount=${beforeCount} afterCount=${afterCount}`,
    );
  } catch (err) {
    console.warn(
      `[REAL_CHAIN] handlers.project:startSeparation cleanup_remove_recent fail projectId="${projectId}" error="${normalizeErrorMessage(err, 'unknown')}"`,
    );
  }

  clearProjectScopedCacheEntries(waveformResultCache, projectId);
  clearProjectScopedCacheEntries(chordAnalysisResultCache, projectId);

  let repoExists = false;
  try {
    repoExists = !!(await infra.projectRepo.findById(projectId));
  } catch {
    repoExists = false;
  }
  console.log(
    `[REAL_CHAIN] handlers.project:startSeparation cleanup_done projectId="${projectId}" repoExists=${repoExists}`,
  );
}

async function shouldCleanupFailedNewProject(
  infra: WorkerInfra,
  projectId: string,
  projectDir: string,
): Promise<{ cleanup: boolean; stemCount: number; resultSetCount: number }> {
  const stems = await infra.stemFileRepo.findByProjectId(projectId).catch(() => []);
  const stemCount = stems.length;
  let resultSetCount = 0;
  try {
    const manifest = await readProjectJsonRecord(projectDir, 'manifest.json');
    resultSetCount = normalizeResultSetEntries(manifest?.resultSets).length;
  } catch {
    resultSetCount = 0;
  }
  return {
    cleanup: stemCount === 0 && resultSetCount === 0,
    stemCount,
    resultSetCount,
  };
}

async function resolveAnalysisSourceFilePath(
  project: Project,
  infra: WorkerInfra,
  stemsOverride?: Array<{ stemType: StemType; exists: boolean; filePath: string }>,
): Promise<string | null> {
  const originalFilePath =
    typeof project.originalFilePath === 'string' && project.originalFilePath.trim().length > 0
      ? project.originalFilePath
      : null;
  if (originalFilePath && fs.existsSync(originalFilePath)) {
    console.log(
      `[REAL_CHAIN] handlers.resolveAnalysisSourceFilePath projectId="${project.id}" ` +
      'fallbackReason="none" sourceKind="original"',
    );
    return project.originalFilePath;
  }
  if (originalFilePath) {
    console.log(
      `[REAL_CHAIN] handlers.resolveAnalysisSourceFilePath projectId="${project.id}" ` +
      'fallbackReason="original_missing -> stem_fallback" sourceKind="stem"',
    );
  }

  const stems = stemsOverride ?? await infra.stemFileRepo.findByProjectId(project.id);
  if (stems.length === 0) {
    console.log(
      `[REAL_CHAIN] handlers.resolveAnalysisSourceFilePath projectId="${project.id}" ` +
      'fallbackReason="no_candidate_stems" sourceKind="none"',
    );
    return null;
  }

  const existing = stems.filter((s) => s.exists && typeof s.filePath === 'string' && s.filePath.trim().length > 0);
  if (existing.length === 0) {
    console.log(
      `[REAL_CHAIN] handlers.resolveAnalysisSourceFilePath projectId="${project.id}" ` +
      'fallbackReason="candidate_stems_not_playable" sourceKind="none"',
    );
    return null;
  }

  for (const preferredType of ANALYSIS_SOURCE_STEM_PRIORITY) {
    const matched = existing.find((s) => s.stemType === preferredType && fs.existsSync(s.filePath));
    if (matched) {
      console.log(
        `[REAL_CHAIN] handlers.resolveAnalysisSourceFilePath projectId="${project.id}" ` +
        `fallbackReason="${originalFilePath ? 'original_missing -> stem_fallback' : 'original_absent -> stem_fallback'}" ` +
        `sourceKind="stem" selectedStemType="${matched.stemType}"`,
      );
      return matched.filePath;
    }
  }

  const firstExisting = existing.find((s) => fs.existsSync(s.filePath));
  if (firstExisting) {
    console.log(
      `[REAL_CHAIN] handlers.resolveAnalysisSourceFilePath projectId="${project.id}" ` +
      `fallbackReason="${originalFilePath ? 'original_missing -> stem_fallback' : 'original_absent -> stem_fallback'}" ` +
      `sourceKind="stem" selectedStemType="${firstExisting.stemType}"`,
    );
    return firstExisting.filePath;
  }
  console.log(
    `[REAL_CHAIN] handlers.resolveAnalysisSourceFilePath projectId="${project.id}" ` +
    'fallbackReason="stem_candidates_missing_on_disk" sourceKind="none"',
  );
  return null;
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

function getTempoAnalysisVersionHint(): string {
  const hint = process.env.TEMPO_ANALYSIS_VERSION?.trim();
  return hint && hint.length > 0 ? hint : DEFAULT_TEMPO_ANALYSIS_VERSION;
}

function getChordVocabularyVersionHint(): string {
  const hint = process.env.CHORD_VOCABULARY_VERSION?.trim();
  return hint && hint.length > 0 ? hint : DEFAULT_CHORD_VOCABULARY_VERSION;
}

function getChordAnalyzerSelectionHint(): string {
  const hint = process.env.CHORD_ANALYZER?.trim();
  return hint && hint.length > 0 ? hint : DEFAULT_CHORD_ANALYZER_ID;
}

function getTempoAnalyzerSelectionHint(): string {
  const hint = process.env.TEMPO_ANALYZER?.trim();
  return hint && hint.length > 0 ? hint : DEFAULT_TEMPO_ANALYZER_ID;
}

function getWaveformAnalysisVersionHint(): string {
  const hint = process.env.WAVEFORM_ANALYSIS_VERSION?.trim();
  return hint && hint.length > 0 ? hint : 'waveform-v1';
}

function normalizeAnalyzerFingerprintToken(value: unknown, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized.length > 0) return normalized;
  return fallback.trim().toLowerCase();
}

function buildAnalyzerFingerprint(input: {
  chordAnalyzer?: string;
  tempoAnalyzer?: string;
  chordAnalysisVersion?: string;
  tempoAnalysisVersion?: string;
  vocabularyVersion?: string;
  vocabularyTag?: string;
}): string {
  const chordAnalyzer = normalizeAnalyzerFingerprintToken(input.chordAnalyzer, DEFAULT_CHORD_ANALYZER_ID);
  const tempoAnalyzer = normalizeAnalyzerFingerprintToken(input.tempoAnalyzer, DEFAULT_TEMPO_ANALYZER_ID);
  const chordAnalysisVersion = normalizeAnalyzerFingerprintToken(input.chordAnalysisVersion, getChordAnalysisVersionHint());
  const tempoAnalysisVersion = normalizeAnalyzerFingerprintToken(input.tempoAnalysisVersion, getTempoAnalysisVersionHint());
  const vocabularyVersion = normalizeAnalyzerFingerprintToken(input.vocabularyVersion, getChordVocabularyVersionHint());
  const vocabularyTag = normalizeAnalyzerFingerprintToken(input.vocabularyTag, 'triad');
  return `ca=${chordAnalyzer}|ta=${tempoAnalyzer}|cv=${chordAnalysisVersion}|tv=${tempoAnalysisVersion}|vv=${vocabularyVersion}|vt=${vocabularyTag}`;
}

function deriveAnalyzerFingerprintFromResult(result: CachedChordAnalysisDTO): string {
  const vocabularyTag =
    (typeof result.chordVocabulary?.selected === 'string' && result.chordVocabulary.selected.trim().length > 0)
      ? result.chordVocabulary.selected
      : (result.segments.find((segment) => typeof segment.vocabularyTag === 'string' && segment.vocabularyTag.trim().length > 0)?.vocabularyTag ?? 'triad');
  return buildAnalyzerFingerprint({
    chordAnalyzer: result.analysisMethods?.chordAnalyzer,
    tempoAnalyzer: result.analysisMethods?.tempoAnalyzer,
    chordAnalysisVersion: result.analysisVersion,
    tempoAnalysisVersion: result.tempoAnalysisVersion,
    vocabularyVersion: result.vocabularyVersion,
    vocabularyTag,
  });
}

function normalizeResultSetCachePathSegment(parentResultId: string): string {
  const normalized = normalizeParentResultId(parentResultId);
  if (normalized === DEFAULT_ACTIVE_RESULT_ID) return DEFAULT_ACTIVE_RESULT_ID;
  const safe = normalized.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.length > 0 ? safe : DEFAULT_ACTIVE_RESULT_ID;
}

function getResultSetWaveformCachePath(parentResultId: string): string {
  const segment = normalizeResultSetCachePathSegment(parentResultId);
  return segment === DEFAULT_ACTIVE_RESULT_ID
    ? DEFAULT_WAVEFORM_CACHE_PATH
    : `waveform/${segment}/master-waveform.json`;
}

function getResultSetChordCachePath(parentResultId: string): string {
  const segment = normalizeResultSetCachePathSegment(parentResultId);
  return segment === DEFAULT_ACTIVE_RESULT_ID
    ? DEFAULT_CHORD_CACHE_PATH
    : `chord/${segment}/chord-analysis.json`;
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

function normalizeResultSetEntries(raw: unknown): ProjectManifestResultSetEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isObjectLike)
    .flatMap((entry) => {
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const modelId = typeof entry.modelId === 'string' ? entry.modelId.trim() : '';
      const runtimeProfileId = typeof entry.runtimeProfileId === 'string' ? entry.runtimeProfileId.trim() : '';
      const sourceSignature = typeof entry.sourceSignature === 'string' ? entry.sourceSignature.trim() : '';
      const createdAt = typeof entry.createdAt === 'number' ? Math.floor(entry.createdAt) : Date.now();
      if (!id || !modelId || !runtimeProfileId || !sourceSignature) return [];
      return [{ id, modelId, runtimeProfileId, sourceSignature, createdAt }];
    });
}

function normalizeManifestRelativePath(projectDir: string, filePath: string): string {
  const relative = path.relative(projectDir, filePath).replace(/\\/g, '/');
  if (relative.length > 0 && !relative.startsWith('..')) {
    return relative;
  }
  return `stems/${path.basename(filePath)}`;
}

async function ensurePilotManifestPersistence(
  project: Project,
  resultSetId: string,
  pilotStems: Array<{
    stemType: string;
    filePath: string;
    codec: string;
    sizeBytes: number;
    durationMs?: number | null;
    sampleRate?: number | null;
    sourceOrigin?: string;
    modelId?: string;
    runtimeProfileId?: string;
    jobId?: string;
    sourceSignature?: string;
    sourceKind?: string;
  }>,
): Promise<void> {
  const manifest = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
  if (!manifest) {
    throw new Error(`PILOT_MANIFEST_MISSING projectId="${project.id}" cacheDir="${project.cacheDir}"`);
  }

  const sourceSignature = pilotStems.find((stem) => typeof stem.sourceSignature === 'string' && stem.sourceSignature.trim().length > 0)?.sourceSignature?.trim() ?? '';
  const modelId = pilotStems.find((stem) => typeof stem.modelId === 'string' && stem.modelId.trim().length > 0)?.modelId?.trim() ?? PILOT_MODEL_ID;
  const runtimeProfileId = pilotStems.find((stem) => typeof stem.runtimeProfileId === 'string' && stem.runtimeProfileId.trim().length > 0)?.runtimeProfileId?.trim() ?? PILOT_RUNTIME_PROFILE_ID;
  if (!sourceSignature) {
    throw new Error(`PILOT_MANIFEST_SOURCE_SIGNATURE_MISSING resultSetId="${resultSetId}"`);
  }

  const existingResultSets = normalizeResultSetEntries(manifest.resultSets);
  const mergedResultSets = [
    ...existingResultSets.filter((entry) => entry.id !== resultSetId),
    {
      id: resultSetId,
      modelId,
      runtimeProfileId,
      sourceSignature,
      createdAt: Date.now(),
    },
  ];

  const rawStems = Array.isArray(manifest.stems)
    ? manifest.stems.filter(isObjectLike)
    : [];
  const keptStems = rawStems.filter((entry) =>
    normalizeParentResultId(typeof entry.parentResultId === 'string' ? entry.parentResultId : undefined) !== resultSetId,
  );
  const pilotManifestStems = pilotStems.map((stem) => ({
    stemType: stem.stemType,
    relativePath: normalizeManifestRelativePath(project.cacheDir, stem.filePath),
    codec: stem.codec,
    sizeBytes: stem.sizeBytes,
    durationMs: typeof stem.durationMs === 'number' ? stem.durationMs : null,
    sampleRate: typeof stem.sampleRate === 'number' ? stem.sampleRate : null,
    sourceOrigin: stem.sourceOrigin === 'manual_import' ? 'manual_import' : 'engine_output',
    modelId: stem.modelId ?? modelId,
    runtimeProfileId: stem.runtimeProfileId ?? runtimeProfileId,
    jobId: stem.jobId,
    parentResultId: resultSetId,
    sourceSignature: stem.sourceSignature ?? sourceSignature,
    sourceKind: stem.sourceKind ?? 'separation',
  }));

  const patchedManifest: Record<string, unknown> = {
    ...manifest,
    activeResultId:
      (typeof manifest.activeResultId === 'string' && manifest.activeResultId.trim().length > 0)
        ? manifest.activeResultId
        : DEFAULT_ACTIVE_RESULT_ID,
    resultSets: mergedResultSets,
    stems: [...keptStems, ...pilotManifestStems],
    updatedAt: Date.now(),
  };
  await writeProjectJsonRecord(project.cacheDir, 'manifest.json', patchedManifest);

  const verified = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
  const verifiedSets = normalizeResultSetEntries(verified?.resultSets);
  if (!verifiedSets.some((entry) => entry.id === resultSetId)) {
    throw new Error(`PILOT_MANIFEST_RESULT_SET_NOT_PERSISTED resultSetId="${resultSetId}"`);
  }
  const verifiedStems = Array.isArray(verified?.stems) ? verified.stems.filter(isObjectLike) : [];
  const hasPilotStems = verifiedStems.some((entry) =>
    normalizeParentResultId(typeof entry.parentResultId === 'string' ? entry.parentResultId : undefined) === resultSetId,
  );
  if (!hasPilotStems) {
    throw new Error(`PILOT_MANIFEST_STEMS_NOT_PERSISTED resultSetId="${resultSetId}"`);
  }
}

function buildDefaultResultSetEntry(project: Project, stems: Array<{
  parentResultId?: string;
  modelId?: string;
  runtimeProfileId?: string;
  sourceSignature?: string;
}>, preferredResultId: string = DEFAULT_ACTIVE_RESULT_ID): ProjectManifestResultSetEntry | null {
  const normalizedPreferredId = normalizeParentResultId(preferredResultId);
  const stemsWithSignature = stems
    .filter((stem) => typeof stem.sourceSignature === 'string' && stem.sourceSignature.trim().length > 0)
    .map((stem) => ({
      parentResultId: normalizeParentResultId(stem.parentResultId),
      modelId: typeof stem.modelId === 'string' && stem.modelId.trim().length > 0
        ? stem.modelId.trim()
        : '',
      runtimeProfileId: typeof stem.runtimeProfileId === 'string' && stem.runtimeProfileId.trim().length > 0
        ? stem.runtimeProfileId.trim()
        : '',
      sourceSignature: (stem.sourceSignature as string).trim(),
    }));
  if (stemsWithSignature.length === 0) return null;

  const uniqueParentIds = Array.from(new Set(stemsWithSignature.map((stem) => stem.parentResultId))).sort();
  const targetParentId = stemsWithSignature.some((stem) => stem.parentResultId === normalizedPreferredId)
    ? normalizedPreferredId
    : (stemsWithSignature.some((stem) => stem.parentResultId === DEFAULT_ACTIVE_RESULT_ID)
      ? DEFAULT_ACTIVE_RESULT_ID
      : uniqueParentIds[0]);
  const scoped = stemsWithSignature
    .filter((stem) => stem.parentResultId === targetParentId)
    .sort((a, b) =>
      a.sourceSignature.localeCompare(b.sourceSignature)
      || a.modelId.localeCompare(b.modelId)
      || a.runtimeProfileId.localeCompare(b.runtimeProfileId));
  const primary = scoped[0];
  if (!primary) return null;

  const modelId = scoped.find((stem) => stem.modelId.length > 0)?.modelId ?? DEFAULT_RESULT_MODEL_ID;
  const runtimeProfileId = scoped.find((stem) => stem.runtimeProfileId.length > 0)?.runtimeProfileId
    ?? DEFAULT_RESULT_RUNTIME_PROFILE_ID;
  return {
    id: targetParentId,
    modelId,
    runtimeProfileId,
    sourceSignature: primary.sourceSignature,
    createdAt: project.updatedAt > 0 ? project.updatedAt : Date.now(),
  };
}

async function resolveActiveResultContext(
  project: Project,
  stems: Array<{ parentResultId?: string; modelId?: string; runtimeProfileId?: string; sourceSignature?: string }> = [],
): Promise<ActiveResultContext> {
  const manifest = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
  const fromManifest = manifest && typeof manifest.activeResultId === 'string'
    ? manifest.activeResultId.trim()
    : '';
  const normalizedSets = normalizeResultSetEntries(manifest?.resultSets);
  const fallbackSet = buildDefaultResultSetEntry(project, stems, fromManifest || DEFAULT_ACTIVE_RESULT_ID);
  const resultSets = normalizedSets.length > 0
    ? normalizedSets
    : (fallbackSet ? [fallbackSet] : []);

  const fallbackActiveId = resultSets[0]?.id ?? DEFAULT_ACTIVE_RESULT_ID;
  const activeResultId = (fromManifest && resultSets.some((entry) => entry.id === fromManifest))
    ? fromManifest
    : fallbackActiveId;
  const activeSet = resultSets.find((entry) => entry.id === activeResultId) ?? null;
  const filteredStemsCount = filterStemsForResultSet(stems, activeResultId).length;
  const fallbackReason = normalizedSets.length > 0
    ? (!fromManifest ? 'manifest_active_missing' : (fromManifest === activeResultId ? 'manifest_active_match' : 'manifest_active_invalid'))
    : (fallbackSet ? (fallbackSet.id === normalizeParentResultId(fromManifest || DEFAULT_ACTIVE_RESULT_ID)
      ? 'fallback_from_stems_preferred'
      : 'fallback_from_stems_degraded')
      : 'fallback_no_result_set');

  if ((normalizedSets.length === 0 || !fromManifest || fromManifest !== activeResultId) && resultSets.length > 0) {
    try {
      await patchProjectManifestMetadata(project.cacheDir, {
        activeResultId,
        resultSets,
      });
    } catch (metaErr) {
      console.warn(
        `[project:resolveActiveResult] manifest patch failed projectId="${project.id}" cacheDir="${project.cacheDir}" reason="${normalizeErrorMessage(metaErr, 'unknown')}"`,
      );
    }
  }

  console.log(
    `[REAL_CHAIN] handlers.resolveActiveResultContext projectId="${project.id}" ` +
    `activeResultId="${activeResultId}" allStemsCount=${stems.length} filteredStemsCount=${filteredStemsCount} ` +
    `resolvedSourceSignature="${activeSet?.sourceSignature ?? ''}" fallbackReason="${fallbackReason}"`,
  );

  return {
    activeResultId,
    sourceSignature: activeSet?.sourceSignature ?? null,
  };
}

function buildChordAnalysisCacheKey(
  projectId: string,
  parentResultId: string,
  sourceSignature: string,
  analysisVersion: string,
  analyzerFingerprint: string,
): string {
  return `${projectId}::${parentResultId}::${sourceSignature}::${analysisVersion}::${analyzerFingerprint}`;
}

function buildLegacyChordAnalysisCacheKey(
  projectId: string,
  parentResultId: string,
  sourceSignature: string,
  analysisVersion: string,
): string {
  return `${projectId}::${parentResultId}::${sourceSignature}::${analysisVersion}`;
}

function buildWaveformCacheKey(
  projectId: string,
  parentResultId: string,
  sourceSignature: string,
  analysisVersion: string,
): string {
  return `${projectId}::${parentResultId}::${sourceSignature}::${analysisVersion}`;
}

const WARNING_MOJIBAKE_PATTERN = /[�]|(?:鍜|鍒|鎾|缁|妯|锛|銆|鈥|鈫|浣庣疆|璇婃柇)/;

function sanitizeChordWarnings(rawWarnings: unknown): string[] {
  if (!Array.isArray(rawWarnings)) return [];

  return rawWarnings
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => !WARNING_MOJIBAKE_PATTERN.test(item))
    .filter((item) => !item.includes('仅供参考'))
    .filter((item) => !item.includes('示例占位'))
    .filter((item, index, array) => array.indexOf(item) === index);
}

function normalizePersistedWaveformPayload(
  raw: Record<string, unknown>,
  fallbackAnalysisVersion: string,
  parentResultId: string,
  sourceSignature: string | null,
): CachedWaveformDTO | null {
  const persistedSignature = typeof raw.sourceSignature === 'string' ? raw.sourceSignature : null;
  if (sourceSignature && persistedSignature && persistedSignature !== sourceSignature) {
    return null;
  }
  const persistedParentResultId = typeof raw.parentResultId === 'string' ? raw.parentResultId.trim() : '';
  if (persistedParentResultId && persistedParentResultId !== parentResultId) return null;
  if (!persistedParentResultId && parentResultId !== DEFAULT_ACTIVE_RESULT_ID) return null;

  const peaks = Array.isArray(raw.peaks)
    ? raw.peaks.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    : [];
  const channels = typeof raw.channels === 'number' && Number.isFinite(raw.channels)
    ? Math.max(1, Math.floor(raw.channels))
    : null;
  const length = typeof raw.length === 'number' && Number.isFinite(raw.length)
    ? Math.max(0, Math.floor(raw.length))
    : null;
  const sampleRate = typeof raw.sampleRate === 'number' && Number.isFinite(raw.sampleRate)
    ? Math.max(1, Math.floor(raw.sampleRate))
    : null;
  const durationMs = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
    ? Math.max(0, Math.floor(raw.durationMs))
    : null;
  if (channels == null || length == null || sampleRate == null || durationMs == null) {
    return null;
  }

  return {
    id: typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id : 'master',
    channels,
    length,
    sampleRate,
    peaks,
    durationMs,
    analysisVersion:
      typeof raw.analysisVersion === 'string' && raw.analysisVersion.trim().length > 0
        ? raw.analysisVersion.trim()
        : fallbackAnalysisVersion,
  };
}

async function loadPersistedWaveformResult(
  project: Project,
  expectedAnalysisVersion: string,
  parentResultId: string,
  sourceSignature: string | null,
): Promise<CachedWaveformDTO | null> {
  const scopedWaveformPath = getResultSetWaveformCachePath(parentResultId);
  const scopedRaw = await readProjectJsonRecord(project.cacheDir, scopedWaveformPath);
  if (scopedRaw) {
    const scopedParsed = normalizePersistedWaveformPayload(
      scopedRaw,
      expectedAnalysisVersion,
      parentResultId,
      sourceSignature,
    );
    if (scopedParsed && scopedParsed.analysisVersion === expectedAnalysisVersion) {
      return scopedParsed;
    }
  }

  // Legacy fallback: manifest single-slot waveform ref.
  const refs = await readManifestAnalysisRefs(project.cacheDir);
  const waveformRef = refs?.waveform;
  if (!waveformRef) return null;
  if (waveformRef.version !== expectedAnalysisVersion) return null;
  if (waveformRef.parentResultId && waveformRef.parentResultId !== parentResultId) return null;
  if (!waveformRef.parentResultId && parentResultId !== DEFAULT_ACTIVE_RESULT_ID) return null;
  if (sourceSignature && waveformRef.sourceSignature && waveformRef.sourceSignature !== sourceSignature) return null;

  const raw = await readProjectJsonRecord(project.cacheDir, waveformRef.path);
  if (!raw) return null;
  const parsed = normalizePersistedWaveformPayload(raw, waveformRef.version, parentResultId, sourceSignature);
  if (!parsed) return null;
  if (parsed.analysisVersion !== expectedAnalysisVersion) return null;
  return parsed;
}

async function persistWaveformResult(
  project: Project,
  waveform: CachedWaveformDTO,
  parentResultId: string,
  sourceSignature: string | null,
): Promise<void> {
  const analysisVersion =
    typeof waveform.analysisVersion === 'string' && waveform.analysisVersion.trim().length > 0
      ? waveform.analysisVersion.trim()
      : getWaveformAnalysisVersionHint();
  const waveformPath = getResultSetWaveformCachePath(parentResultId);

  await writeProjectJsonRecord(project.cacheDir, waveformPath, {
    ...waveform,
    parentResultId,
    analysisVersion,
    sourceSignature,
    generatedAt: Date.now(),
  });
  await patchManifestAnalysisRefs(project.cacheDir, {
    waveform: {
      path: waveformPath,
      version: analysisVersion,
      parentResultId,
      sourceSignature: sourceSignature ?? undefined,
    },
  });
}

function normalizePersistedChordSegments(raw: unknown): CachedChordSegmentDTO[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isObjectLike)
    .filter((seg) => typeof seg.startMs === 'number' && typeof seg.endMs === 'number' && typeof seg.label === 'string')
    .map((seg) => ({
      startMs: Math.max(0, Math.floor(seg.startMs as number)),
      endMs: Math.max(0, Math.floor(seg.endMs as number)),
      label: seg.label as string,
      simplifiedLabel: typeof seg.simplifiedLabel === 'string' ? seg.simplifiedLabel : undefined,
      confidence: typeof seg.confidence === 'number' ? seg.confidence : undefined,
      sourceFlags: Array.isArray(seg.sourceFlags) ? seg.sourceFlags.filter((f): f is string => typeof f === 'string') : undefined,
      symbol: typeof seg.symbol === 'string' ? seg.symbol : undefined,
      chordType: typeof seg.chordType === 'string' ? seg.chordType : undefined,
      quality: typeof seg.quality === 'string' ? seg.quality : undefined,
      bassNote: typeof seg.bassNote === 'string' ? seg.bassNote : undefined,
      adds: Array.isArray(seg.adds) ? seg.adds.filter((v): v is string => typeof v === 'string') : undefined,
      suspensions: Array.isArray(seg.suspensions) ? seg.suspensions.filter((v): v is string => typeof v === 'string') : undefined,
      extensions: Array.isArray(seg.extensions) ? seg.extensions.filter((v): v is string => typeof v === 'string') : undefined,
      alterations: Array.isArray(seg.alterations) ? seg.alterations.filter((v): v is string => typeof v === 'string') : undefined,
      omissions: Array.isArray(seg.omissions) ? seg.omissions.filter((v): v is string => typeof v === 'string') : undefined,
      candidates: Array.isArray(seg.candidates)
        ? seg.candidates
          .filter(isObjectLike)
          .flatMap((candidate) => {
            if (typeof candidate.label !== 'string') return [];
            return [{
              label: candidate.label,
              confidence: typeof candidate.confidence === 'number' ? candidate.confidence : undefined,
              method: typeof candidate.method === 'string' ? candidate.method : undefined,
            }];
          })
        : undefined,
      method: typeof seg.method === 'string' ? seg.method : undefined,
      vocabularyTag: typeof seg.vocabularyTag === 'string' ? seg.vocabularyTag : undefined,
    }));
}

async function loadPersistedChordResult(
  project: Project,
  expectedAnalysisVersion: string,
  parentResultId: string,
  sourceSignature: string | null,
  expectedAnalyzerFingerprint: string,
): Promise<CachedChordAnalysisDTO | null> {
  const normalizePersistedChordPayload = (
    raw: Record<string, unknown>,
    fallbackAnalysisVersion: string,
    fallbackVocabularyVersion: string,
  ): CachedChordAnalysisDTO | null => {
    const persistedSignature = typeof raw.sourceSignature === 'string' ? raw.sourceSignature : null;
    if (sourceSignature && persistedSignature && persistedSignature !== sourceSignature) {
      return null;
    }
    const persistedParentResultId = typeof raw.parentResultId === 'string' ? raw.parentResultId.trim() : '';
    if (persistedParentResultId && persistedParentResultId !== parentResultId) return null;
    if (!persistedParentResultId && parentResultId !== DEFAULT_ACTIVE_RESULT_ID) return null;

    const segments = normalizePersistedChordSegments(raw.segments);
    if (!Array.isArray(raw.segments)) return null;

    const elapsedMs = typeof raw.elapsedMs === 'number' && Number.isFinite(raw.elapsedMs)
      ? Math.max(0, Math.floor(raw.elapsedMs))
      : 0;
    const analyzedAt = typeof raw.analyzedAt === 'number' && Number.isFinite(raw.analyzedAt)
      ? Math.floor(raw.analyzedAt)
      : Date.now();
    const audioDurationMs = typeof raw.audioDurationMs === 'number' && Number.isFinite(raw.audioDurationMs)
      ? Math.max(0, Math.floor(raw.audioDurationMs))
      : (project.durationMs ?? 0);
    const estimatedBpm = typeof raw.estimatedBpm === 'number' && Number.isFinite(raw.estimatedBpm)
      ? raw.estimatedBpm
      : undefined;
    const warnings = sanitizeChordWarnings(raw.warnings);
    const rawTempo = isObjectLike(raw.tempo) ? raw.tempo : null;
    const rawAnalysisMethods = isObjectLike(raw.analysisMethods) ? raw.analysisMethods : null;
    const rawChordVocabulary = isObjectLike(raw.chordVocabulary) ? raw.chordVocabulary : null;

    const tempo = rawTempo
      ? {
        primaryBpm: typeof rawTempo.primaryBpm === 'number' ? rawTempo.primaryBpm : undefined,
        confidence: typeof rawTempo.confidence === 'number' ? rawTempo.confidence : undefined,
        method: typeof rawTempo.method === 'string' ? rawTempo.method : 'tempo_default',
        candidates: Array.isArray(rawTempo.candidates)
          ? rawTempo.candidates
            .filter(isObjectLike)
            .filter((item) => typeof item.bpm === 'number' && Number.isFinite(item.bpm))
            .map((item) => ({
              bpm: item.bpm as number,
              confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
              relation: typeof item.relation === 'string' ? item.relation : undefined,
              method: typeof item.method === 'string' ? item.method : undefined,
            }))
          : [],
        ambiguity: isObjectLike(rawTempo.ambiguity)
          ? {
            isAmbiguous: Boolean(rawTempo.ambiguity.isAmbiguous),
            halfTimeBpm: typeof rawTempo.ambiguity.halfTimeBpm === 'number'
              ? rawTempo.ambiguity.halfTimeBpm
              : undefined,
            doubleTimeBpm: typeof rawTempo.ambiguity.doubleTimeBpm === 'number'
              ? rawTempo.ambiguity.doubleTimeBpm
              : undefined,
            reason: typeof rawTempo.ambiguity.reason === 'string'
              ? rawTempo.ambiguity.reason
              : undefined,
            explanation: typeof rawTempo.ambiguity.explanation === 'string'
              ? rawTempo.ambiguity.explanation
              : undefined,
            confidenceGap: typeof rawTempo.ambiguity.confidenceGap === 'number'
              ? rawTempo.ambiguity.confidenceGap
              : undefined,
          }
          : undefined,
        methodMetadata: isObjectLike(rawTempo.methodMetadata)
          ? { ...rawTempo.methodMetadata }
          : undefined,
      }
      : undefined;

    const analysisMethods = rawAnalysisMethods
      ? {
        chordAnalyzer: typeof rawAnalysisMethods.chordAnalyzer === 'string'
          ? rawAnalysisMethods.chordAnalyzer
          : DEFAULT_CHORD_ANALYZER_ID,
        tempoAnalyzer: typeof rawAnalysisMethods.tempoAnalyzer === 'string'
          ? rawAnalysisMethods.tempoAnalyzer
          : DEFAULT_TEMPO_ANALYZER_ID,
        chordAnalyzerVersion: typeof rawAnalysisMethods.chordAnalyzerVersion === 'string'
          ? rawAnalysisMethods.chordAnalyzerVersion
          : undefined,
        tempoAnalyzerVersion: typeof rawAnalysisMethods.tempoAnalyzerVersion === 'string'
          ? rawAnalysisMethods.tempoAnalyzerVersion
          : undefined,
        vocabularyTag: typeof rawAnalysisMethods.vocabularyTag === 'string'
          ? rawAnalysisMethods.vocabularyTag
          : undefined,
      }
      : undefined;
    const analysisVersion =
      typeof raw.analysisVersion === 'string' && raw.analysisVersion.trim().length > 0
        ? raw.analysisVersion.trim()
        : fallbackAnalysisVersion;
    const vocabularyVersion =
      typeof raw.vocabularyVersion === 'string' && raw.vocabularyVersion.trim().length > 0
        ? raw.vocabularyVersion.trim()
        : fallbackVocabularyVersion;
    const tempoAnalysisVersion =
      typeof raw.tempoAnalysisVersion === 'string' && raw.tempoAnalysisVersion.trim().length > 0
        ? raw.tempoAnalysisVersion.trim()
        : getTempoAnalysisVersionHint();
    const chordVocabulary = rawChordVocabulary
      ? {
        selected: typeof rawChordVocabulary.selected === 'string' ? rawChordVocabulary.selected : 'triad',
        supportsExtendedChords: Boolean(rawChordVocabulary.supportsExtendedChords),
        supportedDescriptors: Array.isArray(rawChordVocabulary.supportedDescriptors)
          ? rawChordVocabulary.supportedDescriptors.filter((item): item is string => typeof item === 'string')
          : [],
      }
      : undefined;
    const analyzerFingerprintFromPayload = typeof raw.analyzerFingerprint === 'string' && raw.analyzerFingerprint.trim().length > 0
      ? raw.analyzerFingerprint.trim()
      : buildAnalyzerFingerprint({
        chordAnalyzer: analysisMethods?.chordAnalyzer,
        tempoAnalyzer: analysisMethods?.tempoAnalyzer,
        chordAnalysisVersion: analysisVersion,
        tempoAnalysisVersion,
        vocabularyVersion,
        vocabularyTag: analysisMethods?.vocabularyTag
          ?? chordVocabulary?.selected
          ?? segments.find((segment) => typeof segment.vocabularyTag === 'string' && segment.vocabularyTag.trim().length > 0)?.vocabularyTag,
      });
    if (analyzerFingerprintFromPayload !== expectedAnalyzerFingerprint) {
      return null;
    }

    return {
      projectId: typeof raw.projectId === 'string' && raw.projectId.trim().length > 0
        ? raw.projectId
        : project.id,
      parentResultId: persistedParentResultId || parentResultId,
      sourceSignature: persistedSignature ?? sourceSignature ?? undefined,
      source: typeof raw.source === 'string' ? raw.source : 'mixed',
      analyzerType: typeof raw.analyzerType === 'string' ? raw.analyzerType : 'rule_based',
      analysisMethods,
      segments,
      elapsedMs,
      analyzedAt,
      audioDurationMs,
      estimatedKey: typeof raw.estimatedKey === 'string' ? raw.estimatedKey : undefined,
      estimatedBpm,
      tempo,
      tempoAnalysisVersion,
      analysisVersion,
      vocabularyVersion,
      analyzerFingerprint: analyzerFingerprintFromPayload,
      chordVocabulary,
      warnings,
      generatedAt: typeof raw.generatedAt === 'number' && Number.isFinite(raw.generatedAt)
        ? Math.floor(raw.generatedAt)
        : Date.now(),
    };
  };

  const scopedChordPath = getResultSetChordCachePath(parentResultId);
  const scopedRaw = await readProjectJsonRecord(project.cacheDir, scopedChordPath);
  if (scopedRaw) {
    const scopedParsed = normalizePersistedChordPayload(
      scopedRaw,
      expectedAnalysisVersion,
      getChordVocabularyVersionHint(),
    );
    if (scopedParsed && scopedParsed.analysisVersion === expectedAnalysisVersion) {
      return scopedParsed;
    }
  }

  // Legacy fallback: manifest single-slot chordAnalysis ref.
  const refs = await readManifestAnalysisRefs(project.cacheDir);
  const chordRef = refs?.chordAnalysis;
  if (!chordRef) return null;
  if (chordRef.analysisVersion !== expectedAnalysisVersion) return null;
  if (chordRef.parentResultId && chordRef.parentResultId !== parentResultId) return null;
  if (!chordRef.parentResultId && parentResultId !== DEFAULT_ACTIVE_RESULT_ID) return null;
  if (sourceSignature && chordRef.sourceSignature && chordRef.sourceSignature !== sourceSignature) return null;

  const raw = await readProjectJsonRecord(project.cacheDir, chordRef.path);
  if (!raw) return null;
  const parsed = normalizePersistedChordPayload(raw, chordRef.analysisVersion, chordRef.vocabularyVersion);
  if (!parsed) return null;
  if (parsed.analysisVersion !== expectedAnalysisVersion) return null;
  return parsed;
}

async function persistChordResult(
  project: Project,
  chordResult: CachedChordAnalysisDTO,
  parentResultId: string,
  sourceSignature: string | null,
): Promise<void> {
  const chordPath = getResultSetChordCachePath(parentResultId);
  const analysisVersion =
    typeof chordResult.analysisVersion === 'string' && chordResult.analysisVersion.trim().length > 0
      ? chordResult.analysisVersion.trim()
      : getChordAnalysisVersionHint();
  const vocabularyVersion =
    typeof chordResult.vocabularyVersion === 'string' && chordResult.vocabularyVersion.trim().length > 0
      ? chordResult.vocabularyVersion.trim()
      : getChordVocabularyVersionHint();
  const tempoAnalysisVersion =
    typeof chordResult.tempoAnalysisVersion === 'string' && chordResult.tempoAnalysisVersion.trim().length > 0
      ? chordResult.tempoAnalysisVersion.trim()
      : getTempoAnalysisVersionHint();
  const analyzerFingerprint = (typeof chordResult.analyzerFingerprint === 'string' && chordResult.analyzerFingerprint.trim().length > 0)
    ? chordResult.analyzerFingerprint.trim()
    : deriveAnalyzerFingerprintFromResult({
      ...chordResult,
      analysisVersion,
      vocabularyVersion,
      tempoAnalysisVersion,
    });

  await writeProjectJsonRecord(project.cacheDir, chordPath, {
    ...chordResult,
    parentResultId,
    analysisVersion,
    tempoAnalysisVersion,
    vocabularyVersion,
    analyzerFingerprint,
    segmentCount: chordResult.segments.length,
    sourceSignature,
    generatedAt: chordResult.generatedAt ?? Date.now(),
  });
  await patchManifestAnalysisRefs(project.cacheDir, {
    chordAnalysis: {
      path: chordPath,
      analysisVersion,
      vocabularyVersion,
      parentResultId,
      sourceSignature: sourceSignature ?? undefined,
    },
  });
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

/** Legacy mock chord 鏁版嵁鐢熸垚鍣紙淇濈暀浠呬緵娓呯悊鏈熷弬鑰冿紝涓婚摼璺笉鍐嶈繑鍥烇級 */
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
  updatedAt: number;
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
  hints?: { indexUpdatedAt?: number; indexDisplayName?: string },
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
    durationMs: number | null;
    sampleRate: number | null;
    sourceOrigin: 'engine_output' | 'manual_import';
    modelId?: string;
    runtimeProfileId?: string;
    jobId?: string;
    parentResultId?: string;
    sourceSignature?: string;
    sourceKind?: string;
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
        durationMs:
          (typeof entry.durationMs === 'number' && entry.durationMs > 0)
            ? Math.floor(entry.durationMs)
            : null,
        sampleRate:
          (typeof entry.sampleRate === 'number' && entry.sampleRate > 0)
            ? Math.floor(entry.sampleRate)
            : null,
        sourceOrigin: (entry.sourceOrigin === 'manual_import') ? 'manual_import' : 'engine_output',
        modelId: typeof entry.modelId === 'string' ? entry.modelId : undefined,
        runtimeProfileId: typeof entry.runtimeProfileId === 'string' ? entry.runtimeProfileId : undefined,
        jobId: typeof entry.jobId === 'string' ? entry.jobId : undefined,
        parentResultId: typeof entry.parentResultId === 'string' ? entry.parentResultId : undefined,
        sourceSignature: typeof entry.sourceSignature === 'string' ? entry.sourceSignature : undefined,
        sourceKind: typeof entry.sourceKind === 'string' ? entry.sourceKind : undefined,
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
        durationMs: null,
        sampleRate: null,
        sourceOrigin: 'engine_output',
        sourceKind: 'separation',
      });
    }
  }

  // stem 去重：
  // - 旧数据（无 resultSet 维度）按 stemType 去重
  // - 新数据（有 parentResultId）按 parentResultId+stemType 去重，避免 main/pilot 混写
  const dedupByType = new Map<string, typeof stemCandidates[number]>();
  for (const candidate of stemCandidates) {
    const dedupKey = `${normalizeParentResultId(candidate.parentResultId)}::${candidate.stemType}`;
    const existing = dedupByType.get(dedupKey);
    if (!existing || candidate.sizeBytes > existing.sizeBytes) {
      dedupByType.set(dedupKey, candidate);
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

  const manifestDisplayName =
    (manifestData && typeof manifestData.displayName === 'string' && manifestData.displayName.trim().length > 0)
      ? manifestData.displayName.trim()
      : '';
  const displayName = manifestDisplayName
    || (typeof hints?.indexDisplayName === 'string' && hints.indexDisplayName.trim().length > 0
      ? hints.indexDisplayName.trim()
      : path.basename(selectedDir));

  const now = Date.now();
  const inferredDurationMs = stems.reduce((max, s) => {
    const value = typeof s.durationMs === 'number' ? s.durationMs : 0;
    return value > max ? value : max;
  }, 0);
  const manifestDurationMs =
    (manifestData && typeof manifestData.durationMs === 'number' && manifestData.durationMs > 0)
      ? Math.floor(manifestData.durationMs)
      : null;
  const projectDurationMs = manifestDurationMs ?? (inferredDurationMs > 0 ? inferredDurationMs : null);
  const separationElapsedMs =
    (manifestData && typeof manifestData.separationElapsedMs === 'number' && manifestData.separationElapsedMs >= 0)
      ? Math.floor(manifestData.separationElapsedMs)
      : null;
  const lastAccessedAt =
    (manifestData && typeof manifestData.lastAccessedAt === 'number' && manifestData.lastAccessedAt >= 0)
      ? Math.floor(manifestData.lastAccessedAt)
      : null;
  const restoredUpdatedAt =
    (manifestData && typeof manifestData.updatedAt === 'number')
      ? manifestData.updatedAt
      : (typeof hints?.indexUpdatedAt === 'number' ? hints.indexUpdatedAt : now);
  const projectSampleRate = stems.find((s) => typeof s.sampleRate === 'number' && s.sampleRate > 0)?.sampleRate ?? null;
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
    updatedAt: restoredUpdatedAt,
    lastAccessedAt,
    durationMs: projectDurationMs,
    separationElapsedMs,
    sampleRate: projectSampleRate,
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
    durationMs: s.durationMs,
    sampleRate: s.sampleRate,
    exists: true,
    sourceOrigin: s.sourceOrigin,
    confidence: null,
    exportable: true,
    status: StemStatus.Detected,
    modelId: s.modelId,
    runtimeProfileId: s.runtimeProfileId,
    jobId: s.jobId,
    parentResultId: s.parentResultId,
    sourceSignature: s.sourceSignature,
    sourceKind: s.sourceKind,
  })));

  clearProjectScopedCacheEntries(waveformResultCache, projectId);
  clearProjectScopedCacheEntries(chordAnalysisResultCache, projectId);

  return {
    projectId,
    displayName,
    stemCount: stems.length,
    updatedAt: restoredUpdatedAt,
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
            console.log(
              `[REAL_CHAIN] handlers.project:getRecent getRecent_restore_attempt projectId="${entry.projectId}" projectDir="${entry.projectDir}" reason="${!existing ? 'repo_missing' : 'cache_dir_missing'}"`,
            );
            const restored = await restoreExistingProjectFromDir(entry.projectDir, workerInfra, {
              indexUpdatedAt: entry.updatedAt,
              indexDisplayName: entry.displayName,
            });
            console.log(
              `[REAL_CHAIN] handlers.project:getRecent getRecent_restore_success projectId="${restored.projectId}" projectDir="${entry.projectDir}" stemCount=${restored.stemCount}`,
            );
            keptEntries.push({
              projectId: restored.projectId,
              displayName: restored.displayName,
              projectDir: entry.projectDir,
              updatedAt: restored.updatedAt,
            });
          } catch {
            // 索引中的失效工程忽略
          }
        } else {
          keptEntries.push({
            projectId: existing.id,
            displayName: existing.displayName,
            projectDir: existing.cacheDir,
            updatedAt: existing.updatedAt,
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
      const activeResultContext = await resolveActiveResultContext(p, stems);
      const activeStems = filterStemsForResultSet(stems, activeResultContext.activeResultId);
      return {
        id: p.id,
        displayName: p.displayName,
        sourceType: p.sourceType,
        status: p.status,
        durationMs: p.durationMs,
        totalSizeBytes: p.totalSizeBytes,
        stemCount: stems.length,
        activeResultId: activeResultContext.activeResultId,
        activeStemCount: activeStems.length,
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
    const parseCurrentJobIdBefore = workerInfra?.parseJobService.getCurrentJobId() ?? null;
    console.log(
      `[REAL_CHAIN] handlers.project:startSeparation start_request_received projectId="${projectId}" jobId="${jobId}" parseCurrentJobIdBefore="${parseCurrentJobIdBefore ?? 'none'}"`,
    );
    if (workerInfra) {
      if (parseCurrentJobIdBefore) {
        console.warn(
          `[REAL_CHAIN] handlers.project:startSeparation reject_running_job currentJobId="${parseCurrentJobIdBefore}" filePath="${filePath}"`,
        );
        throw new Error('已有分离任务在运行中，请等待当前任务完成后再试');
      }
    }

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
      lastAccessedAt: null,
      durationMs: null,
      separationElapsedMs: null,
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
    let recentUpserted = false;
    try {
      await upsertRecentProjectEntry({
        projectId,
        displayName: fileName,
        projectDir: outputDir,
        updatedAt: now,
      });
      recentUpserted = true;
    } catch {
      // 最近项目索引写入失败不应阻塞主流程
    }
    console.log(
      `[REAL_CHAIN] handlers.project:startSeparation start_project_created projectId="${projectId}" recent_upserted=${recentUpserted}`,
    );

    console.log(`[REAL_CHAIN] handlers.project:startSeparation entry filePath="${filePath}" projectId="${projectId}" jobId="${jobId}" outputDir="${outputDir}"`);

    const win = BrowserWindow.fromWebContents(event.sender);

    // 璇婃柇锛氬垽鏂蛋鍝潯璺緞
    const workerStatus = workerInfra?.workerManager.getStatus();
    const useRealPath = !!workerInfra && workerInfra.workerManager.isAcceptingRequests();
    console.log(`[REAL_CHAIN] handlers.project:startSeparation decision projectId="${projectId}" jobId="${jobId}" infraExists=${!!workerInfra} status=${workerStatus?.status ?? 'N/A'} accepting=${workerStatus?.acceptingRequests ?? 'N/A'} pid=${workerStatus?.pid ?? 'N/A'} branch=${useRealPath ? 'real' : 'mock'}`);

    // 濡傛灉 Worker 鍩虹璁炬柦鍙敤涓?Worker 姝ｅ湪杩愯锛屼娇鐢ㄧ湡瀹炲垎绂?
    if (useRealPath && workerInfra) {
      const emitSeparationComplete = (
        payload: {
          success: boolean;
          errorMessage?: string;
          warnings?: string[];
          cacheHit?: boolean;
        },
        reason: string,
      ): boolean => {
        if (!win || win.isDestroyed()) {
          console.warn(
            `[REAL_CHAIN] handlers.project:startSeparation completion_emit_skipped projectId="${projectId}" jobId="${jobId}" reason="${reason}" winAvailable=${!!win} winDestroyed=${win ? win.isDestroyed() : true}`,
          );
          return false;
        }
        console.log(
          `[REAL_CHAIN] handlers.project:startSeparation completion_emit_attempt projectId="${projectId}" jobId="${jobId}" reason="${reason}" success=${payload.success} warningsCount=${payload.warnings?.length ?? 0} hasErrorMessage=${typeof payload.errorMessage === 'string' && payload.errorMessage.trim().length > 0}`,
        );
        win.webContents.send('separation:complete', {
          jobId,
          projectId,
          success: payload.success,
          errorMessage: payload.errorMessage,
          warnings: payload.warnings ?? [],
          cacheHit: payload.cacheHit ?? false,
        });
        console.log(
          `[REAL_CHAIN] handlers.project:startSeparation completion_emit_sent projectId="${projectId}" jobId="${jobId}" reason="${reason}"`,
        );
        return true;
      };

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
        let completionEventSent = false;
        try {
          console.log(`[REAL_CHAIN] handlers.project:startSeparation real_path_enter projectId="${projectId}" jobId="${jobId}"`);
          const result = await infraRef.parseJobService.startSeparation({
            projectId,
            sourceFilePath: filePath,
            projectDir: outputDir,
          });
          console.log(
            `[REAL_CHAIN] handlers.project:startSeparation service_result projectId="${projectId}" jobId="${jobId}" projectStatusAfter="${result.projectStatusAfter}" jobStatus="${result.job.status}" jobErrorCode="${result.job.errorCode ?? 'none'}" jobErrorMessage="${result.job.errorMessage ?? ''}"`,
          );
          const cancelled = result.projectStatusAfter === ProjectStatus.Cancelled || result.job.status === 'cancelled';
          if (cancelled) {
            console.log(
              `[REAL_CHAIN] handlers.project:startSeparation cancelled_cleanup projectId="${projectId}" jobId="${jobId}"`,
            );
            await runCancelledNewProjectCleanup(infraRef, projectId);
            completionEventSent = emitSeparationComplete({
              success: false,
              errorMessage: '分离已取消，项目未保存',
              warnings: ['分离已取消，项目未保存'],
              cacheHit: false,
            }, 'cancelled_cleanup');
            return;
          }
          if (result.projectStatusAfter !== ProjectStatus.Ready) {
            const explicitError = (() => {
              if (typeof result.job.errorMessage === 'string' && result.job.errorMessage.trim().length > 0) {
                return result.job.errorMessage.trim();
              }
              if (typeof result.job.errorCode === 'string' && result.job.errorCode.trim().length > 0) {
                return result.job.errorCode.trim();
              }
              return `分离未成功（projectStatusAfter=${result.projectStatusAfter}）`;
            })();
            console.warn(
              `[REAL_CHAIN] handlers.project:startSeparation non_ready_short_circuit projectId="${projectId}" jobId="${jobId}" projectStatusAfter="${result.projectStatusAfter}" jobStatus="${result.job.status}" error="${explicitError}"`,
            );
            completionEventSent = emitSeparationComplete({
              success: false,
              errorMessage: explicitError,
              warnings: [explicitError],
              cacheHit: false,
            }, 'non_ready_short_circuit');
            return;
          }

          // 鍒嗙瀹屾垚鍚庢洿鏂?project 鐨?metadata
          let stemFiles = await infraRef.stemFileRepo.findByProjectId(projectId);
          console.log(
            `[REAL_CHAIN] handlers.project:startSeparation metadata_postprocess_begin projectId="${projectId}" jobId="${jobId}" projectStatusAfter="${result.projectStatusAfter}" stemFilesCount=${stemFiles.length}`,
          );
          if (stemFiles.length === 0) {
            console.warn(
              `[REAL_CHAIN] handlers.project:startSeparation stem_repo_empty_first_read projectId="${projectId}" jobId="${jobId}" retry="immediate"`,
            );
            await Promise.resolve();
            stemFiles = await infraRef.stemFileRepo.findByProjectId(projectId);
            console.log(
              `[REAL_CHAIN] handlers.project:startSeparation stem_repo_retry_read projectId="${projectId}" jobId="${jobId}" stemFilesCount=${stemFiles.length}`,
            );
          }
          if (stemFiles.length === 0) {
            throw new Error(`SEPARATION_STEMS_NOT_PERSISTED projectId="${projectId}" jobId="${jobId}"`);
          }
          console.log(`[REAL_CHAIN] handlers.project:startSeparation real_path_after_service projectId="${projectId}" jobId="${jobId}" stemFiles=${stemFiles.length} projectStatusAfter="${result.projectStatusAfter}"`);
          const missingProvenance = stemFiles.some((stem) => (
            !stem.modelId
            || !stem.runtimeProfileId
            || !stem.jobId
            || !stem.parentResultId
            || !stem.sourceSignature
            || !stem.sourceKind
          ));
          if (missingProvenance) {
            throw new Error('SEPARATION_PROVENANCE_INCOMPLETE');
          }
          const totalSize = stemFiles.reduce((sum, s) => sum + s.sizeBytes, 0);
          const durationMs = stemFiles.reduce((max, s) => {
            const value = typeof s.durationMs === 'number' ? s.durationMs : 0;
            return value > max ? value : max;
          }, 0);
          const separationElapsedMs =
            (typeof result.job.elapsedMs === 'number' && result.job.elapsedMs >= 0)
              ? Math.floor(result.job.elapsedMs)
              : null;
          const resolvedEngineVersion =
            (typeof result.job.engineVersion === 'string' && result.job.engineVersion.trim().length > 0)
              ? result.job.engineVersion.trim()
              : 'demucs';
          const defaultResultSet = buildDefaultResultSetEntry(project, stemFiles);
          if (!defaultResultSet) {
            throw new Error(
              `MANIFEST_RESULT_SET_MAIN_MISSING projectId="${projectId}" outputDir="${outputDir}"`,
            );
          }
          const resultSets = [defaultResultSet];

          await infraRef.projectRepo.update(projectId, {
            engineVersion: resolvedEngineVersion,
            totalSizeBytes: stemFiles.length > 0 ? totalSize : project.totalSizeBytes,
            durationMs: durationMs > 0 ? durationMs : null,
            separationElapsedMs,
          });

          const metadataPatchResult = await patchProjectManifestMetadata(outputDir, {
            displayName: fileName,
            durationMs: durationMs > 0 ? durationMs : null,
            separationElapsedMs,
            activeResultId: DEFAULT_ACTIVE_RESULT_ID,
            resultSets,
          });
          console.log(
            `[REAL_CHAIN] handlers.project:startSeparation manifest_patched projectId="${projectId}" manifestPath="${metadataPatchResult.manifestPath}" activeResultId="${DEFAULT_ACTIVE_RESULT_ID}" resultSetCount=${resultSets.length}`,
          );

          completionEventSent = emitSeparationComplete({
            success: result.projectStatusAfter === ProjectStatus.Ready,
            warnings: result.warnings,
            cacheHit: false,
          }, 'real_path_success');
        } catch (err) {
          const originalError = normalizeErrorMessage(err, 'unknown_error');
          console.error(`[REAL_CHAIN] handlers.project:startSeparation real_path_error projectId="${projectId}" jobId="${jobId}" error="${originalError}"`);
          if (isSeparationCancelledError(err)) {
            await runCancelledNewProjectCleanup(infraRef, projectId);
            completionEventSent = emitSeparationComplete({
              success: false,
              errorMessage: '分离已取消，项目未保存',
              warnings: ['分离已取消，项目未保存'],
              cacheHit: false,
            }, 'error_cancelled');
            return;
          }
          const normalizedError = toSeparationFailureMessage(err);
          const cleanupDecision = await shouldCleanupFailedNewProject(infraRef, projectId, outputDir);
          if (cleanupDecision.cleanup) {
            console.warn(
              `[REAL_CHAIN] handlers.project:startSeparation failed_cleanup projectId="${projectId}" jobId="${jobId}" stemCount=${cleanupDecision.stemCount} resultSetCount=${cleanupDecision.resultSetCount}`,
            );
            await runCancelledNewProjectCleanup(infraRef, projectId);
            console.error(
              `[REAL_CHAIN] handlers.project:startSeparation real_path_error_mapped projectId="${projectId}" jobId="${jobId}" errorOriginal="${originalError}" mappedError="${normalizedError}"`,
            );
            completionEventSent = emitSeparationComplete({
              success: false,
              errorMessage: normalizedError,
              warnings: [normalizedError],
              cacheHit: false,
            }, 'error_cleanup_path');
            return;
          }

          // 鏇存柊 project 鐘舵€?
          try {
            await infraRef.projectRepo.updateStatus(projectId, ProjectStatus.Failed);
          } catch { /* ignore */ }

          console.error(
            `[REAL_CHAIN] handlers.project:startSeparation real_path_error_mapped projectId="${projectId}" jobId="${jobId}" errorOriginal="${originalError}" mappedError="${normalizedError}"`,
          );
          completionEventSent = emitSeparationComplete({
            success: false,
            errorMessage: normalizedError,
            warnings: [normalizedError],
            cacheHit: false,
          }, 'error_no_cleanup_path');
        } finally {
          console.log(
            `[REAL_CHAIN] handlers.project:startSeparation completion_emit_summary projectId="${projectId}" jobId="${jobId}" completionEventSent=${completionEventSent}`,
          );
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

  ipcMain.handle('project:startPilotSeparation', async (event, projectId: string, sourceFilePath?: string) => {
    if (!workerInfra) {
      throw new Error('分离服务不可用，请重启应用后重试');
    }
    if (typeof projectId !== 'string' || projectId.trim().length === 0) {
      throw new Error('缺少项目 ID，无法启动试点分离');
    }

    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) {
      throw new Error('项目不存在，无法启动试点分离');
    }

    const resolvedSourceFilePath = (() => {
      if (typeof sourceFilePath === 'string' && sourceFilePath.trim().length > 0) {
        return sourceFilePath.trim();
      }
      if (typeof project.originalFilePath === 'string' && project.originalFilePath.trim().length > 0) {
        return project.originalFilePath.trim();
      }
      return '';
    })();
    if (!resolvedSourceFilePath || !fs.existsSync(resolvedSourceFilePath)) {
      throw new Error('试点分离输入文件不存在，请传入有效音频路径');
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    const jobId = `job-${crypto.randomUUID().slice(0, 8)}`;
    const resultSetId = `pilot_6s_${Date.now()}`;
    const workerOutputDir = path.join(project.cacheDir, '.tmp-separation', `${resultSetId}_${jobId}`);

    const workerStatus = workerInfra.workerManager.getStatus();
    if (!workerInfra.workerManager.isAcceptingRequests()) {
      throw new Error(`Worker 不可用，当前状态：${workerStatus.status}`);
    }

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

    (async () => {
      try {
        console.log(
          `[REAL_CHAIN] handlers.project:startPilotSeparation real_path_enter projectId="${projectId}" jobId="${jobId}" resultSetId="${resultSetId}" model="${PILOT_MODEL_ID}" runtimeProfile="${PILOT_RUNTIME_PROFILE_ID}"`,
        );
        const result = await workerInfra!.parseJobService.startSeparation({
          projectId,
          sourceFilePath: resolvedSourceFilePath,
          projectDir: project.cacheDir,
          workerOutputDirOverride: workerOutputDir,
          resultSetId,
          preserveExistingStems: true,
          allowReadyStatus: true,
          runtimeProfileIdOverride: PILOT_RUNTIME_PROFILE_ID,
          workerModelOverride: PILOT_MODEL_ID,
        });
        const cancelled = result.projectStatusAfter === ProjectStatus.Cancelled || result.job.status === 'cancelled';
        if (cancelled) {
          if (win && !win.isDestroyed()) {
            win.webContents.send('separation:complete', {
              jobId,
              projectId,
              success: false,
              errorMessage: '实验分离已取消',
              warnings: ['实验分离已取消'],
              cacheHit: false,
            });
          }
          return;
        }
        if (result.projectStatusAfter !== ProjectStatus.Ready) {
          const explicitError = result.job.errorMessage
            || result.job.errorCode
            || `pilot separation failed: projectStatusAfter=${result.projectStatusAfter}`;
          throw new Error(explicitError);
        }

        const stemFiles = await workerInfra!.stemFileRepo.findByProjectId(projectId);
        const pilotStems = filterStemsForResultSet(stemFiles, resultSetId);
        if (pilotStems.length === 0) {
          throw new Error(`PILOT_RESULT_EMPTY resultSetId="${resultSetId}"`);
        }
        const missingProvenance = pilotStems.some((stem) => (
          !stem.modelId
          || !stem.runtimeProfileId
          || !stem.jobId
          || !stem.parentResultId
          || !stem.sourceSignature
          || !stem.sourceKind
        ));
        if (missingProvenance) {
          throw new Error('PILOT_SEPARATION_PROVENANCE_INCOMPLETE');
        }
        const mismatchStem = pilotStems.find((stem) =>
          stem.modelId !== PILOT_MODEL_ID || stem.runtimeProfileId !== PILOT_RUNTIME_PROFILE_ID,
        );
        if (mismatchStem) {
          throw new Error(
            `PILOT_PROFILE_MISMATCH expectedModel="${PILOT_MODEL_ID}" expectedRuntimeProfile="${PILOT_RUNTIME_PROFILE_ID}" actualModel="${mismatchStem.modelId ?? 'unknown'}" actualRuntimeProfile="${mismatchStem.runtimeProfileId ?? 'unknown'}"`,
          );
        }
        await ensurePilotManifestPersistence(project, resultSetId, pilotStems);
        console.log(
          `[REAL_CHAIN] handlers.project:startPilotSeparation manifest_persisted projectId="${projectId}" resultSetId="${resultSetId}" pilotStemCount=${pilotStems.length}`,
        );

        if (win && !win.isDestroyed()) {
          const cancelled = result.job.status === 'cancelled';
          win.webContents.send('separation:complete', {
            jobId,
            projectId,
            success: result.projectStatusAfter === ProjectStatus.Ready,
            ...(cancelled ? { errorMessage: '实验分离已取消' } : {}),
            warnings: result.warnings,
            cacheHit: false,
          });
        }
      } catch (err) {
        console.error(
          `[REAL_CHAIN] handlers.project:startPilotSeparation real_path_error projectId="${projectId}" jobId="${jobId}" error="${err instanceof Error ? err.message : String(err)}"`,
        );
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

    return {
      jobId,
      projectId,
      resultSetId,
      warnings: [],
      cacheHit: false,
    };
  });

  ipcMain.handle('project:cancelSeparation', async (_event, jobId?: string) => {
    if (workerInfra) {
      const incomingJobId = typeof jobId === 'string' && jobId.trim().length > 0 ? jobId.trim() : '';
      const parseCurrentJobId = workerInfra.parseJobService.getCurrentJobId();
      console.log(
        `[REAL_CHAIN] handlers.project:cancelSeparation cancel_begin incomingJobId="${incomingJobId || 'none'}" parseCurrentJobId="${parseCurrentJobId ?? 'none'}"`,
      );
      const dispatchJobId = parseCurrentJobId ?? (incomingJobId || undefined);
      const mode = parseCurrentJobId ? 'current' : 'explicit';
      console.log(
        `[REAL_CHAIN] handlers.project:cancelSeparation cancel_dispatched mode=${mode} targetJobId="${dispatchJobId ?? 'none'}"`,
      );
      await workerInfra.parseJobService.cancelSeparation(dispatchJobId);
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
      durationMs: project.durationMs,
      totalSizeBytes: project.totalSizeBytes,
      stemCount: stems.length,
      updatedAt: project.updatedAt,
    };
  });

  ipcMain.handle('project:rename', async (_event, projectId: string, nextDisplayName: string) => {
    if (!workerInfra) return null;
    if (typeof projectId !== 'string' || projectId.trim().length === 0) {
      throw new Error('缺少项目 ID，无法重命名');
    }
    const normalizedName = typeof nextDisplayName === 'string' ? nextDisplayName.trim() : '';
    if (normalizedName.length === 0) {
      throw new Error('项目名称不能为空');
    }

    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) {
      throw new Error('项目不存在，无法重命名');
    }

    await workerInfra.projectRepo.update(projectId, { displayName: normalizedName });
    const updatedProject = await workerInfra.projectRepo.findById(projectId);
    if (updatedProject) {
      await patchProjectManifestMetadata(updatedProject.cacheDir, { displayName: normalizedName });
      await upsertRecentProjectEntry({
        projectId: updatedProject.id,
        displayName: normalizedName,
        projectDir: updatedProject.cacheDir,
        updatedAt: updatedProject.updatedAt,
      });
    }

    return { projectId, displayName: normalizedName };
  });

  ipcMain.handle('project:markAccessed', async (_event, projectId: string) => {
    if (!workerInfra) return null;
    if (typeof projectId !== 'string' || projectId.trim().length === 0) {
      return null;
    }

    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) return null;

    const lastAccessedAt = Date.now();
    await workerInfra.projectRepo.touchLastAccessedAt(projectId, lastAccessedAt);
    await patchProjectManifestMetadata(project.cacheDir, { lastAccessedAt });
    return { projectId, lastAccessedAt };
  });

  ipcMain.handle('project:setActiveResult', async (_event, projectId: string, resultSetId: string) => {
    if (!workerInfra) return null;
    if (typeof projectId !== 'string' || projectId.trim().length === 0) {
      throw new Error('缺少项目 ID，无法切换结果集');
    }
    const normalizedResultSetId = typeof resultSetId === 'string' ? resultSetId.trim() : '';
    if (!normalizedResultSetId) {
      throw new Error('缺少结果集 ID，无法切换结果集');
    }

    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) {
      throw new Error('项目不存在，无法切换结果集');
    }

    const manifest = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
    const manifestResultSets = normalizeResultSetEntries(manifest?.resultSets);
    if (!manifestResultSets.some((entry) => entry.id === normalizedResultSetId)) {
      throw new Error(`结果集不存在，无法切换：${normalizedResultSetId}`);
    }

    await patchProjectManifestMetadata(project.cacheDir, {
      activeResultId: normalizedResultSetId,
    });

    console.log(
      `[REAL_CHAIN] handlers.project:setActiveResult projectId="${projectId}" activeResultId="${normalizedResultSetId}"`,
    );

    return {
      projectId,
      activeResultId: normalizedResultSetId,
    };
  });

  ipcMain.handle('project:getResult', async (_event, projectId: string) => {
    console.log(`[REAL_CHAIN] handlers.project:getResult query projectId="${projectId}"`);
    if (!workerInfra) return null;

    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) return null;

    const allStems = await workerInfra.stemFileRepo.findByProjectId(projectId);
    const latestJob = await workerInfra.parseJobRepo.findLatestByProjectId(projectId);
    const activeResultContext = await resolveActiveResultContext(project, allStems);
    const stems = filterStemsForResultSet(allStems, activeResultContext.activeResultId);
    const manifest = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
    const activeFromManifest = manifest && typeof manifest.activeResultId === 'string'
      ? manifest.activeResultId.trim()
      : '';
    const manifestResultSets = normalizeResultSetEntries(manifest?.resultSets);
    const fallbackResultSet = buildDefaultResultSetEntry(project, allStems, activeResultContext.activeResultId);
    const resultSets = manifestResultSets.length > 0
      ? manifestResultSets
      : (fallbackResultSet ? [fallbackResultSet] : []);

    const isRealSeparation = project.status === ProjectStatus.Ready && stems.length > 0;
    const resolvedEngineVersion =
      (typeof project.engineVersion === 'string' && project.engineVersion.trim().length > 0)
        ? project.engineVersion.trim()
        : 'demucs';
    const sourceTypeLabel = isRealSeparation
      ? `Demucs (${resolvedEngineVersion}, ${stems.length} stems)`
      : '等待分离';
    const elapsedMs = activeResultContext.activeResultId === DEFAULT_ACTIVE_RESULT_ID
      ? ((typeof project.separationElapsedMs === 'number' && project.separationElapsedMs >= 0)
        ? project.separationElapsedMs
        : ((typeof latestJob?.elapsedMs === 'number' && latestJob.elapsedMs >= 0)
          ? latestJob.elapsedMs
          : 0))
      : ((typeof latestJob?.elapsedMs === 'number' && latestJob.elapsedMs >= 0)
        ? latestJob.elapsedMs
        : ((typeof project.separationElapsedMs === 'number' && project.separationElapsedMs >= 0)
          ? project.separationElapsedMs
          : 0));
    console.log(`[REAL_CHAIN] handlers.project:getResult decision projectId="${projectId}" projectStatus="${project.status}" stemCount=${stems.length} elapsedMs=${elapsedMs} isRealSeparation=${isRealSeparation} sourceTypeLabel="${sourceTypeLabel}"`);
    console.log(
      `[REAL_CHAIN] handlers.project:getResult context projectId="${projectId}" ` +
      `resultSetCount=${resultSets.length} activeFromManifest="${activeFromManifest || 'none'}" ` +
      `activeResolved="${activeResultContext.activeResultId}"`,
    );

    return {
      id: project.id,
      displayName: project.displayName,
      sourceType: project.sourceType,
      status: project.status,
      durationMs: project.durationMs,
      totalSizeBytes: isRealSeparation
        ? stems.reduce((sum, s) => sum + s.sizeBytes, 0)
        : project.totalSizeBytes,
      stemCount: stems.length,
      updatedAt: project.updatedAt,
      elapsedMs,
      cacheHit: false,
      cacheHitBannerText: null,
      sourceTypeLabel,
      activeResultId: activeResultContext.activeResultId,
      sourceFilePath: project.originalFilePath ?? null,
      resultSets,
    };
  });

  ipcMain.handle('project:getStems', async (_event, projectId: string) => {
    console.log(`[REAL_CHAIN] handlers.project:getStems query projectId="${projectId}"`);
    if (!workerInfra) return [];

    // 鏌ヨ鐪熷疄 stem 鏂囦欢
    const allStems = await workerInfra.stemFileRepo.findByProjectId(projectId);
    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) return [];
    const manifest = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
    const manifestResultSets = normalizeResultSetEntries(manifest?.resultSets);
    const activeFromManifest = manifest && typeof manifest.activeResultId === 'string'
      ? manifest.activeResultId.trim()
      : '';
    const activeResultContext = await resolveActiveResultContext(project, allStems);
    const stems = filterStemsForResultSet(allStems, activeResultContext.activeResultId);
    console.log(
      `[REAL_CHAIN] handlers.project:getStems context projectId="${projectId}" ` +
      `activeResultId="${activeResultContext.activeResultId}" allStemsCount=${allStems.length} ` +
      `filteredStemsCount=${stems.length} resolvedSourceSignature="${activeResultContext.sourceSignature ?? ''}" ` +
      `resultSetCount=${manifestResultSets.length} activeFromManifest="${activeFromManifest || 'none'}" ` +
      `activeResolved="${activeResultContext.activeResultId}"`,
    );

    if (stems.length > 0) {
      console.log(
        `[REAL_CHAIN] handlers.project:getStems fallbackHit=false projectId="${projectId}" ` +
        'fallbackReason="none"',
      );
      // 鏈夌湡瀹?stems 鈥?杩斿洖 StemTrackDTO
      return stems.map(sf => ({
        id: sf.id,
        stemType: sf.stemType,
        codec: sf.codec,
        sizeBytes: sf.sizeBytes,
        durationMs: (typeof sf.durationMs === 'number' && sf.durationMs > 0)
          ? sf.durationMs
          : 0,
        sampleRate: sf.sampleRate ?? 44100,
        exportable: sf.exportable,
        filePath: sf.filePath,
        lastModifiedAt: project?.createdAt ?? Date.now(),
        presence: 'exists' as const,
        mergedFrom: null,
        modelId: sf.modelId,
        runtimeProfileId: sf.runtimeProfileId,
        jobId: sf.jobId,
        parentResultId: sf.parentResultId,
        sourceSignature: sf.sourceSignature,
        sourceKind: sf.sourceKind,
      }));
    }

    if (allStems.length === 0) {
      // 鏃犵湡瀹?stems 鈥?mock honest fallback
      console.log(
        `[REAL_CHAIN] handlers.project:getStems fallbackHit=true projectId="${projectId}" ` +
        'fallbackReason="repo_empty"',
      );
      return getMockHonestStems(project);
    }

    console.warn(
      `[REAL_CHAIN] handlers.project:getStems fallbackHit=false projectId="${projectId}" ` +
      `fallbackReason="active_result_no_matching_stems" activeResultId="${activeResultContext.activeResultId}"`,
    );
    return [];
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
        updatedAt: restored.updatedAt,
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

    const allStems = await workerInfra.stemFileRepo.findByProjectId(projectId);
    const activeResultContext = await resolveActiveResultContext(project, allStems);
    const activeStems = filterStemsForResultSet(allStems, activeResultContext.activeResultId);
    // Prefer original mixed source; fallback to first valid analysis source for the active result set.
    const sourceFilePath = await resolveAnalysisSourceFilePath(project, workerInfra, activeStems);
    if (!sourceFilePath) {
      console.log(`[REAL_CHAIN] handlers.project:getWaveform miss projectId="${projectId}" reason="no_source_file"`);
      return null;
    }

    const expectedAnalysisVersion = getWaveformAnalysisVersionHint();
    const sourceSignature = activeResultContext.sourceSignature ?? await getFileSourceSignature(sourceFilePath);
    const parentResultId = activeResultContext.activeResultId;
    const sourceKind = project.originalFilePath
      && fs.existsSync(project.originalFilePath)
      && path.resolve(project.originalFilePath) === path.resolve(sourceFilePath)
      ? 'original'
      : 'stem';
    const cached = getWaveformCacheEntry(projectId, parentResultId, sourceSignature, expectedAnalysisVersion);
    if (cached) {
      console.log(
        `[REAL_CHAIN] handlers.project:getWaveform cache_hit projectId="${projectId}" ` +
        `analysisVersion="${cached.analysisVersion}" parentResultId="${parentResultId}" ` +
        `sourceSignatureAvailable=${sourceSignature != null} sourceKind="${sourceKind}"`,
      );
      return cached.result;
    }
    if (!sourceSignature) {
      // Signature unavailable: never trust old cache, but still try to generate fresh waveform.
      console.log(
        `[REAL_CHAIN] handlers.project:getWaveform cache_bypass projectId="${projectId}" ` +
        `reason="source_signature_unavailable" parentResultId="${parentResultId}" ` +
        `sourceSignatureAvailable=${sourceSignature != null} sourceKind="${sourceKind}"`,
      );
    } else {
      console.log(
        `[REAL_CHAIN] handlers.project:getWaveform cache_miss projectId="${projectId}" ` +
        `reason="cache_key_not_found" analysisVersion="${expectedAnalysisVersion}" ` +
        `parentResultId="${parentResultId}" sourceSignatureAvailable=${sourceSignature != null} ` +
        `sourceKind="${sourceKind}"`,
      );
    }

    const persistedWaveform = await loadPersistedWaveformResult(
      project,
      expectedAnalysisVersion,
      parentResultId,
      sourceSignature,
    );
    if (persistedWaveform) {
      if (sourceSignature) {
        setWaveformCacheEntry({
          cacheKey: buildWaveformCacheKey(projectId, parentResultId, sourceSignature, expectedAnalysisVersion),
          parentResultId,
          sourceFilePath,
          sourceSignature,
          analysisVersion: expectedAnalysisVersion,
          cachedAt: Date.now(),
          result: persistedWaveform,
        });
      }
      console.log(
        `[REAL_CHAIN] handlers.project:getWaveform persisted_hit projectId="${projectId}" ` +
        `analysisVersion="${expectedAnalysisVersion}"`,
      );
      return persistedWaveform;
    }

    if (!ensureWorkerAcceptingRequests(workerInfra)) {
      console.log(`[REAL_CHAIN] handlers.project:getWaveform miss projectId="${projectId}" reason="worker_not_ready"`);
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
        try {
          await patchProjectManifestMetadata(project.cacheDir, { durationMs: waveform.durationMs });
        } catch (metaErr) {
          console.warn(
            `[project:getWaveform] metadata patch failed projectId="${projectId}" cacheDir="${project.cacheDir}" reason="${normalizeErrorMessage(metaErr, 'unknown')}"`,
          );
        }
      }

      const resolvedAnalysisVersion = waveform.analysisVersion ?? expectedAnalysisVersion;
      if (sourceSignature) {
        setWaveformCacheEntry({
          cacheKey: buildWaveformCacheKey(projectId, parentResultId, sourceSignature, resolvedAnalysisVersion),
          parentResultId,
          sourceFilePath,
          sourceSignature,
          analysisVersion: resolvedAnalysisVersion,
          cachedAt: Date.now(),
          result: waveform,
        });
      }
      try {
        await persistWaveformResult(project, waveform, parentResultId, sourceSignature);
      } catch {
        // analysis cache write failure should not break waveform query
      }
      console.log(
        `[REAL_CHAIN] handlers.project:getWaveform return projectId="${projectId}" ` +
        `source="${sourceFilePath}" peaks=${waveform.peaks.length} durationMs=${waveform.durationMs}`,
      );
      return waveform;
    } catch (err) {
      console.warn(`[Analysis] getWaveform unavailable. projectId=${projectId}, reason=${normalizeErrorMessage(err, 'unknown')}`);
      return null;
    }
  });

  ipcMain.handle('project:getChordAnalysis', async (_event, projectId: string) => {
    console.log(`[IPC] project:getChordAnalysis projectId="${projectId}"`);
    if (!workerInfra) return null;
    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) return null;

    const allStems = await workerInfra.stemFileRepo.findByProjectId(projectId);
    const activeResultContext = await resolveActiveResultContext(project, allStems);
    const activeStems = filterStemsForResultSet(allStems, activeResultContext.activeResultId);
    const sourceFilePath = await resolveAnalysisSourceFilePath(project, workerInfra, activeStems);
    if (!sourceFilePath) {
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis miss projectId="${projectId}" ` +
        'reason="no_source_file"',
      );
      return null;
    }
    const sourceKind = project.originalFilePath
      && fs.existsSync(project.originalFilePath)
      && path.resolve(project.originalFilePath) === path.resolve(sourceFilePath)
      ? 'original'
      : 'stem';

    const sourceSignature = activeResultContext.sourceSignature ?? await getFileSourceSignature(sourceFilePath);
    const parentResultId = activeResultContext.activeResultId;
    const activeSourceStem = activeStems.find((stem) =>
      (typeof stem.modelId === 'string' && stem.modelId.trim().length > 0)
      || (typeof stem.runtimeProfileId === 'string' && stem.runtimeProfileId.trim().length > 0),
    );
    const activeModelId = activeSourceStem?.modelId?.trim() ?? 'unknown';
    const activeRuntimeProfileId = activeSourceStem?.runtimeProfileId?.trim() ?? 'unknown';
    console.log(
      `[REAL_CHAIN] handlers.project:getChordAnalysis source_resolved projectId="${projectId}" ` +
      `source_kind="${sourceKind}" source_signature_available=${sourceSignature != null} ` +
      `activeResultId="${activeResultContext.activeResultId}" modelId="${activeModelId}" ` +
      `runtimeProfileId="${activeRuntimeProfileId}"`,
    );

    const expectedAnalysisVersion = getChordAnalysisVersionHint();
    const expectedTempoAnalysisVersion = getTempoAnalysisVersionHint();
    const expectedVocabularyVersion = getChordVocabularyVersionHint();
    const expectedAnalyzerFingerprint = buildAnalyzerFingerprint({
      chordAnalyzer: getChordAnalyzerSelectionHint(),
      tempoAnalyzer: getTempoAnalyzerSelectionHint(),
      chordAnalysisVersion: expectedAnalysisVersion,
      tempoAnalysisVersion: expectedTempoAnalysisVersion,
      vocabularyVersion: expectedVocabularyVersion,
      vocabularyTag: 'triad',
    });
    const cached = getChordCacheEntry(
      projectId,
      parentResultId,
      sourceSignature,
      expectedAnalysisVersion,
      expectedAnalyzerFingerprint,
    );
    if (cached) {
      const cachedResult = cached.result;
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis cache_hit projectId="${projectId}" ` +
        `source_kind="${sourceKind}" analysisVersion="${cached.analysisVersion}" ` +
        `segments=${cachedResult.segments.length} key_empty=${!cachedResult.estimatedKey} ` +
        `has_warning=${(cachedResult.warnings?.length ?? 0) > 0}`,
      );
      return cached.result;
    }
    if (!sourceSignature) {
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis cache_bypass projectId="${projectId}" ` +
        `source_kind="${sourceKind}" reason="source_signature_unavailable" analysisVersion="${expectedAnalysisVersion}"`,
      );
    } else {
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis cache_miss projectId="${projectId}" ` +
        `reason="cache_key_not_found" analysisVersion="${expectedAnalysisVersion}"`,
      );
    }

    const persistedChord = await loadPersistedChordResult(
      project,
      expectedAnalysisVersion,
      parentResultId,
      sourceSignature,
      expectedAnalyzerFingerprint,
    );
    if (persistedChord) {
      if (sourceSignature) {
        const persistedFingerprint = persistedChord.analyzerFingerprint ?? expectedAnalyzerFingerprint;
        setChordCacheEntry({
          cacheKey: buildChordAnalysisCacheKey(
            projectId,
            parentResultId,
            sourceSignature,
            expectedAnalysisVersion,
            persistedFingerprint,
          ),
          parentResultId,
          sourceFilePath,
          sourceSignature,
          analysisVersion: expectedAnalysisVersion,
          cachedAt: Date.now(),
          result: persistedChord,
        });
      }
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis persisted_hit projectId="${projectId}" ` +
        `analysisVersion="${expectedAnalysisVersion}" segments=${persistedChord.segments.length}`,
      );
      return persistedChord;
    }

    if (!ensureWorkerAcceptingRequests(workerInfra)) {
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis miss projectId="${projectId}" ` +
        'reason="worker_not_ready"',
      );
      return null;
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
          symbol: typeof (seg as { symbol?: unknown }).symbol === 'string'
            ? (seg as { symbol: string }).symbol
            : undefined,
          chordType: typeof (seg as { chordType?: unknown }).chordType === 'string'
            ? (seg as { chordType: string }).chordType
            : undefined,
          quality: typeof (seg as { quality?: unknown }).quality === 'string'
            ? (seg as { quality: string }).quality
            : undefined,
          bassNote: typeof (seg as { bassNote?: unknown }).bassNote === 'string'
            ? (seg as { bassNote: string }).bassNote
            : undefined,
          adds: Array.isArray((seg as { adds?: unknown }).adds)
            ? ((seg as { adds: unknown[] }).adds.filter((v) => typeof v === 'string') as string[])
            : undefined,
          suspensions: Array.isArray((seg as { suspensions?: unknown }).suspensions)
            ? ((seg as { suspensions: unknown[] }).suspensions.filter((v) => typeof v === 'string') as string[])
            : undefined,
          extensions: Array.isArray((seg as { extensions?: unknown }).extensions)
            ? ((seg as { extensions: unknown[] }).extensions.filter((v) => typeof v === 'string') as string[])
            : undefined,
          alterations: Array.isArray((seg as { alterations?: unknown }).alterations)
            ? ((seg as { alterations: unknown[] }).alterations.filter((v) => typeof v === 'string') as string[])
            : undefined,
          omissions: Array.isArray((seg as { omissions?: unknown }).omissions)
            ? ((seg as { omissions: unknown[] }).omissions.filter((v) => typeof v === 'string') as string[])
            : undefined,
          candidates: Array.isArray((seg as { candidates?: unknown }).candidates)
            ? ((seg as { candidates: unknown[] }).candidates
              .flatMap((item) => {
                if (!isObjectLike(item) || typeof item.label !== 'string') {
                  return [];
                }
                const candidate = item as Record<string, unknown>;
                return [{
                  label: candidate.label as string,
                  confidence: typeof candidate.confidence === 'number' ? candidate.confidence : undefined,
                  method: typeof candidate.method === 'string' ? candidate.method : undefined,
                }];
              }))
            : undefined,
          method: typeof (seg as { method?: unknown }).method === 'string'
            ? (seg as { method: string }).method
            : undefined,
          vocabularyTag: typeof (seg as { vocabularyTag?: unknown }).vocabularyTag === 'string'
            ? (seg as { vocabularyTag: string }).vocabularyTag
            : undefined,
        }));

      const rawTempo = isObjectLike((raw as { tempo?: unknown }).tempo)
        ? ((raw as { tempo: Record<string, unknown> }).tempo)
        : null;
      const tempoPrimary = rawTempo && typeof rawTempo.primaryBpm === 'number' && Number.isFinite(rawTempo.primaryBpm)
        ? rawTempo.primaryBpm
        : undefined;
      const rawEstimatedBpm = typeof raw.estimatedBpm === 'number' && Number.isFinite(raw.estimatedBpm)
        ? raw.estimatedBpm
        : tempoPrimary;
      const normalizedEstimatedBpm = rawEstimatedBpm != null && rawEstimatedBpm >= 40 && rawEstimatedBpm <= 240
        ? rawEstimatedBpm
        : undefined;
      const tempo: CachedTempoAnalysisDTO | undefined = rawTempo
        ? {
          primaryBpm: tempoPrimary,
          confidence: typeof rawTempo.confidence === 'number' ? rawTempo.confidence : undefined,
          method: typeof rawTempo.method === 'string' ? rawTempo.method : 'tempo_default',
          candidates: Array.isArray(rawTempo.candidates)
            ? rawTempo.candidates
              .filter((item) => isObjectLike(item) && typeof item.bpm === 'number' && Number.isFinite(item.bpm))
              .map((item) => ({
                bpm: item.bpm as number,
                confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
                relation: typeof item.relation === 'string' ? item.relation : undefined,
                method: typeof item.method === 'string' ? item.method : undefined,
              }))
            : [],
          ambiguity: isObjectLike(rawTempo.ambiguity)
            ? {
              isAmbiguous: Boolean(rawTempo.ambiguity.isAmbiguous),
              halfTimeBpm: typeof rawTempo.ambiguity.halfTimeBpm === 'number'
                ? rawTempo.ambiguity.halfTimeBpm
                : undefined,
              doubleTimeBpm: typeof rawTempo.ambiguity.doubleTimeBpm === 'number'
                ? rawTempo.ambiguity.doubleTimeBpm
                : undefined,
              reason: typeof rawTempo.ambiguity.reason === 'string'
                ? rawTempo.ambiguity.reason
                : undefined,
              explanation: typeof rawTempo.ambiguity.explanation === 'string'
                ? rawTempo.ambiguity.explanation
                : undefined,
              confidenceGap: typeof rawTempo.ambiguity.confidenceGap === 'number'
                ? rawTempo.ambiguity.confidenceGap
                : undefined,
            }
            : undefined,
          methodMetadata: isObjectLike(rawTempo.methodMetadata)
            ? { ...rawTempo.methodMetadata }
            : undefined,
        }
        : undefined;
      const warnings = sanitizeChordWarnings(raw.warnings);
      if (rawEstimatedBpm != null && normalizedEstimatedBpm == null) {
        warnings.push('BPM 估计值不稳定，已隐藏该字段');
      }

      const analysisMethods = isObjectLike((raw as { analysisMethods?: unknown }).analysisMethods)
        ? {
          chordAnalyzer: typeof ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.chordAnalyzer) === 'string'
            ? ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.chordAnalyzer as string)
            : DEFAULT_CHORD_ANALYZER_ID,
          tempoAnalyzer: typeof ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.tempoAnalyzer) === 'string'
            ? ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.tempoAnalyzer as string)
            : DEFAULT_TEMPO_ANALYZER_ID,
          chordAnalyzerVersion: typeof ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.chordAnalyzerVersion) === 'string'
            ? ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.chordAnalyzerVersion as string)
            : undefined,
          tempoAnalyzerVersion: typeof ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.tempoAnalyzerVersion) === 'string'
            ? ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.tempoAnalyzerVersion as string)
            : undefined,
          vocabularyTag: typeof ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.vocabularyTag) === 'string'
            ? ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.vocabularyTag as string)
            : undefined,
        }
        : undefined;
      const resolvedAnalysisVersion =
        typeof raw.analysisVersion === 'string' && raw.analysisVersion.trim().length > 0
          ? raw.analysisVersion.trim()
          : expectedAnalysisVersion;
      const resolvedTempoAnalysisVersion =
        typeof (raw as { tempoAnalysisVersion?: unknown }).tempoAnalysisVersion === 'string'
        && (raw as { tempoAnalysisVersion: string }).tempoAnalysisVersion.trim().length > 0
          ? (raw as { tempoAnalysisVersion: string }).tempoAnalysisVersion.trim()
          : expectedTempoAnalysisVersion;
      const resolvedVocabularyVersion =
        typeof raw.vocabularyVersion === 'string' && raw.vocabularyVersion.trim().length > 0
          ? raw.vocabularyVersion.trim()
          : expectedVocabularyVersion;
      const resolvedVocabularyTag = analysisMethods?.vocabularyTag
        ?? (isObjectLike((raw as { chordVocabulary?: unknown }).chordVocabulary)
          && typeof ((raw as { chordVocabulary: Record<string, unknown> }).chordVocabulary.selected) === 'string'
          ? ((raw as { chordVocabulary: Record<string, unknown> }).chordVocabulary.selected as string)
          : undefined)
        ?? segments.find((segment) => typeof segment.vocabularyTag === 'string' && segment.vocabularyTag.trim().length > 0)?.vocabularyTag
        ?? 'triad';
      const resolvedAnalyzerFingerprint = buildAnalyzerFingerprint({
        chordAnalyzer: analysisMethods?.chordAnalyzer,
        tempoAnalyzer: analysisMethods?.tempoAnalyzer,
        chordAnalysisVersion: resolvedAnalysisVersion,
        tempoAnalysisVersion: resolvedTempoAnalysisVersion,
        vocabularyVersion: resolvedVocabularyVersion,
        vocabularyTag: resolvedVocabularyTag,
      });

      const chordResult: CachedChordAnalysisDTO = {
        projectId,
        parentResultId,
        sourceSignature: sourceSignature ?? undefined,
        source: typeof raw.source === 'string' ? raw.source : 'mixed',
        analyzerType: typeof raw.analyzerType === 'string' ? raw.analyzerType : 'rule_based',
        analysisMethods,
        segments,
        elapsedMs: typeof raw.elapsedMs === 'number' ? Math.max(0, Math.floor(raw.elapsedMs)) : 0,
        analyzedAt: typeof raw.analyzedAt === 'number' ? raw.analyzedAt : Date.now(),
        audioDurationMs: typeof raw.audioDurationMs === 'number' ? Math.max(0, Math.floor(raw.audioDurationMs)) : (project.durationMs ?? 0),
        estimatedKey: typeof raw.estimatedKey === 'string' ? raw.estimatedKey : undefined,
        estimatedBpm: normalizedEstimatedBpm,
        tempo,
        tempoAnalysisVersion: resolvedTempoAnalysisVersion,
        analysisVersion: resolvedAnalysisVersion,
        vocabularyVersion: resolvedVocabularyVersion,
        analyzerFingerprint: resolvedAnalyzerFingerprint,
        chordVocabulary: isObjectLike((raw as { chordVocabulary?: unknown }).chordVocabulary)
          ? {
            selected: typeof ((raw as { chordVocabulary: Record<string, unknown> }).chordVocabulary.selected) === 'string'
              ? ((raw as { chordVocabulary: Record<string, unknown> }).chordVocabulary.selected as string)
              : 'triad',
            supportsExtendedChords: Boolean((raw as { chordVocabulary: Record<string, unknown> }).chordVocabulary.supportsExtendedChords),
            supportedDescriptors: Array.isArray((raw as { chordVocabulary: Record<string, unknown> }).chordVocabulary.supportedDescriptors)
              ? (((raw as { chordVocabulary: Record<string, unknown> }).chordVocabulary.supportedDescriptors as unknown[])
                .filter((item) => typeof item === 'string') as string[])
              : [],
          }
          : undefined,
        warnings,
        generatedAt: typeof raw.generatedAt === 'number' ? raw.generatedAt : Date.now(),
      };
      if (sourceKind !== 'original') {
        chordResult.warnings = Array.from(
          new Set([...(chordResult.warnings ?? []), '当前分析输入为 stem 回退源，结果稳定性可能降低']),
        );
      }

      if (project.durationMs == null && chordResult.audioDurationMs > 0) {
        await workerInfra.projectRepo.update(projectId, { durationMs: chordResult.audioDurationMs });
        try {
          await patchProjectManifestMetadata(project.cacheDir, { durationMs: chordResult.audioDurationMs });
        } catch (metaErr) {
          console.warn(
            `[project:getChordAnalysis] metadata patch failed projectId="${projectId}" cacheDir="${project.cacheDir}" reason="${normalizeErrorMessage(metaErr, 'unknown')}"`,
          );
        }
      }

      if (sourceSignature) {
        const resolvedAnalyzerFingerprint = chordResult.analyzerFingerprint ?? deriveAnalyzerFingerprintFromResult(chordResult);
        setChordCacheEntry({
          cacheKey: buildChordAnalysisCacheKey(
            projectId,
            parentResultId,
            sourceSignature,
            resolvedAnalysisVersion,
            resolvedAnalyzerFingerprint,
          ),
          parentResultId,
          sourceFilePath,
          sourceSignature,
          analysisVersion: resolvedAnalysisVersion,
          cachedAt: Date.now(),
          result: chordResult,
        });
      }
      try {
        await persistChordResult(project, chordResult, parentResultId, sourceSignature);
      } catch {
        // analysis cache write failure should not break chord query
      }
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis result_summary projectId="${projectId}" ` +
        `source_kind="${sourceKind}" analysisVersion="${resolvedAnalysisVersion}" ` +
        `segments=${chordResult.segments.length} key_empty=${!chordResult.estimatedKey} ` +
        `has_warning=${(chordResult.warnings?.length ?? 0) > 0}`,
      );
      return chordResult;
    } catch (err) {
      const warning = toAnalysisFailureMessage(err, '真实和弦分析失败，未返回示例数据');
      console.warn(
        `[Analysis] getChordAnalysis unavailable. projectId=${projectId}, reason=${warning}`,
      );
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis fail_summary projectId="${projectId}" ` +
        `source_kind="${sourceKind}" analysisVersion="${expectedAnalysisVersion}" ` +
        'segments=0 has_warning=true',
      );
      return null;
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
          lastAccessedAt: p.lastAccessedAt ?? p.createdAt,
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
    clearProjectScopedCacheEntries(waveformResultCache, projectId);
    clearProjectScopedCacheEntries(chordAnalysisResultCache, projectId);
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


