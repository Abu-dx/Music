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
import { spawnSync } from 'child_process';
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
import type { Project, ManifestStemEntry } from '../../../domain/entities';
import type { WorkerInfra } from '../workerSetup';
import { inferStemTypeFromFilename } from '../../../domain/policies';
import {
  OrchestratedSeparationService,
} from '../../../application/services/orchestratedSeparationService';
import type {
  SpecialistDescriptor,
  SpecialistExecutionPlan,
  SpecialistHealthStatus,
  SpecialistPassReport,
  SpecialistStatus,
  StemSelectionPolicy,
} from '../../../application/services/orchestrationTypes';
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
  bassNote?: string;
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
  };
};

type CachedChordAnalysisDTO = {
  projectId: string;
  source: string;
  analyzerType: string;
  analysisMethods?: {
    chordAnalyzer: string;
    tempoAnalyzer: string;
  };
  segments: CachedChordSegmentDTO[];
  elapsedMs: number;
  analyzedAt: number;
  audioDurationMs: number;
  estimatedKey?: string;
  estimatedBpm?: number;
  tempo?: CachedTempoAnalysisDTO;
  analysisVersion?: string;
  vocabularyVersion?: string;
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
  analysisMethodKey: string;
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
const DEFAULT_RESULT_MODEL_ID = 'demucs';
const DEFAULT_RESULT_RUNTIME_PROFILE_ID = 'demucs_env_override';
const DEFAULT_CHORD_ANALYZER_ID = 'chord_rule_chroma_v2_pilot';
const DEFAULT_TEMPO_ANALYZER_ID = 'tempo_rule_onset_v2_pilot';
const PILOT_MODEL_ID = 'htdemucs_6s';
const PILOT_RUNTIME_PROFILE_ID = 'demucs_6s_pilot';
const ORCH_GUITAR_SPECIALIST_DEFAULT_MODEL_ID = 'mel_roformer_guitar';
const ORCH_GUITAR_SPECIALIST_DEFAULT_RUNTIME_PROFILE_ID = PILOT_RUNTIME_PROFILE_ID;
const ORCH_GUITAR_SPECIALIST_SUPPORTED_MODEL_IDS = new Set(['mel_roformer_guitar']);
const ORCH_GUITAR_SPECIALIST_COMMAND_ENV = 'ORCH_GUITAR_SPECIALIST_CMD';
const ORCH_GUITAR_SPECIALIST_CHECKPOINT_ENV = 'ORCH_GUITAR_SPECIALIST_CHECKPOINT';
const ORCH_RESULT_SET_PREFIX = 'orch_6s_';
const ORCH_RESULT_MODEL_ID = 'orchestrated_6s';
const ORCH_RESULT_RUNTIME_PROFILE_ID = 'orchestrator_main';

type ActiveResultContext = {
  activeResultId: string;
  manifestActiveResultId: string | null;
  fallbackReason: string | null;
  sourceSignature: string | null;
  resultSets: ProjectManifestResultSetEntry[];
  modelId: string | null;
  runtimeProfileId: string | null;
};

function normalizeParentResultId(value: string | null | undefined): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : DEFAULT_ACTIVE_RESULT_ID;
}

type PilotRuntimePreflightResult = {
  configured: boolean;
  missingItems: string[];
};

function checkPilotRuntimeProfileAvailability(): PilotRuntimePreflightResult {
  const pilotPython = process.env.DEMUCS_6S_PILOT_PYTHON_EXE?.trim() ?? '';
  const pilotEnvRoot = process.env.DEMUCS_6S_PILOT_ENV_ROOT?.trim() ?? '';
  const missingItems: string[] = [];

  if (pilotPython.length === 0) {
    missingItems.push('DEMUCS_6S_PILOT_PYTHON_EXE');
  }
  if (path.isAbsolute(pilotPython) && !fs.existsSync(pilotPython)) {
    missingItems.push(`DEMUCS_6S_PILOT_PYTHON_EXE(path_not_found:${pilotPython})`);
  }
  if (pilotEnvRoot.length > 0 && path.isAbsolute(pilotEnvRoot) && !fs.existsSync(pilotEnvRoot)) {
    missingItems.push(`DEMUCS_6S_PILOT_ENV_ROOT(path_not_found:${pilotEnvRoot})`);
  }

  return {
    configured: missingItems.length === 0,
    missingItems,
  };
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
  if (raw.includes('PILOT_RUNTIME_PROFILE_UNAVAILABLE')) {
    const detail = raw.split('PILOT_RUNTIME_PROFILE_UNAVAILABLE:')[1]?.trim();
    return detail
      ? `实验6轨运行环境未就绪：${detail}`
      : '实验6轨运行环境未就绪（缺少 pilot runtime profile），请先配置后再试';
  }
  if (raw.includes('PILOT_PARSE_JOB_FAILED')) {
    return '实验6轨分离失败（任务执行失败），请查看日志中的错误码';
  }
  if (raw.includes('PILOT_RESULT_EMPTY')) {
    return '实验6轨分离未产出可用轨道，请查看日志确认输入文件与模型输出';
  }
  if (raw.includes('PILOT_PROFILE_MISMATCH')) {
    return '实验6轨模型输出与预期不一致，请查看日志中的模型信息';
  }
  const missingModuleMatch = raw.match(/required_modules_missing:([a-zA-Z0-9_.-]+)/i);
  if (missingModuleMatch) {
    const moduleName = missingModuleMatch[1];
    return `运行环境缺少依赖模块：${moduleName}，请在对应 Python 环境安装后重试`;
  }
  if (raw.includes('manifest') || raw.includes('MANIFEST')) {
    return '分离结果已生成，但项目元数据写入失败，请查看日志并重试';
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

function classifyPilotFailure(
  errorMessage: string,
  errorCode: string | null,
): string {
  const merged = `${errorCode ?? ''} ${errorMessage}`.toUpperCase();
  if (merged.includes('PILOT_RUNTIME_PROFILE_UNAVAILABLE')) return 'PILOT_RUNTIME_PROFILE_UNAVAILABLE';
  if (merged.includes('PILOT_SOURCE_PATH_REQUIRED')) return 'PILOT_SOURCE_PATH_REQUIRED';
  if (merged.includes('PILOT_PARSE_JOB_FAILED')) return 'PILOT_PARSE_JOB_FAILED';
  if (merged.includes('PILOT_RESULT_EMPTY')) return 'PILOT_RESULT_EMPTY';
  if (merged.includes('PILOT_PROFILE_MISMATCH')) return 'PILOT_PROFILE_MISMATCH';
  if (merged.includes('PILOT_SEPARATION_PROVENANCE_INCOMPLETE')) return 'PILOT_SEPARATION_PROVENANCE_INCOMPLETE';
  return 'PILOT_UNKNOWN_ERROR';
}

function toAnalysisFailureMessage(err: unknown, fallback: string): string {
  const raw = normalizeErrorMessage(err, fallback);
  if (raw.includes('ANALYZER_SELECTION_FAILED')) {
    return '分析器选择失败（未找到请求的 analyzer 或 strict 模式阻断）';
  }
  if (raw.includes('ANALYSIS_RUNTIME_UNSUPPORTED')) {
    return '分析运行时不支持当前分析器，请检查 runtime profile 配置';
  }
  if (raw.includes('INPUT_FILE_NOT_FOUND') || raw.includes('Source file not found')) {
    return '分析输入文件不存在，未返回分析结果';
  }
  if (raw.includes('ANALYSIS_DEPENDENCY_MISSING')) {
    return '分析依赖缺失（librosa/torchaudio），未返回分析结果';
  }
  if (raw.includes('ANALYSIS_CHORD_RESULT_EMPTY')) {
    return '和弦分析未产出有效片段，请检查输入音频或分析器配置';
  }
  if (raw.includes('WORKER_IPC') || raw.includes('Worker')) {
    return '分析 Worker 不可用，未返回分析结果';
  }
  return raw;
}

async function resolveAnalysisSourceFilePath(
  project: Project,
  infra: WorkerInfra,
  stemsOverride?: Array<{ stemType: StemType; exists: boolean; filePath: string }>,
): Promise<string | null> {
  if (project.originalFilePath && fs.existsSync(project.originalFilePath)) {
    return project.originalFilePath;
  }

  const stems = stemsOverride ?? await infra.stemFileRepo.findByProjectId(project.id);
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

function normalizeAnalyzerId(value: string | null | undefined, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.length > 0 ? normalized : fallback;
}

function buildAnalysisMethodKey(
  analysisMethods: { chordAnalyzer: string; tempoAnalyzer: string } | null | undefined,
): string | null {
  if (!analysisMethods) return null;
  const chordAnalyzer = normalizeAnalyzerId(analysisMethods.chordAnalyzer, DEFAULT_CHORD_ANALYZER_ID);
  const tempoAnalyzer = normalizeAnalyzerId(analysisMethods.tempoAnalyzer, DEFAULT_TEMPO_ANALYZER_ID);
  return `${chordAnalyzer}|${tempoAnalyzer}`;
}

function resolveExpectedAnalysisMethodKey(): string {
  const chordAnalyzer = normalizeAnalyzerId(process.env.CHORD_ANALYZER, DEFAULT_CHORD_ANALYZER_ID);
  const tempoAnalyzer = normalizeAnalyzerId(process.env.TEMPO_ANALYZER, DEFAULT_TEMPO_ANALYZER_ID);
  return `${chordAnalyzer}|${tempoAnalyzer}`;
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
  // TODO(Phase 2 Gate): this fallback keeps legacy compatibility but may hide path issues.
  // Upgrade to strict validation in a dedicated hardening pass.
  return `stems/${path.basename(filePath)}`;
}

function resolveManifestSourceFilePath(
  manifest: Record<string, unknown> | null | undefined,
  projectDir: string,
): string | null {
  if (!manifest) return null;
  const rawCandidates: string[] = [];
  if (typeof manifest.originalFilePath === 'string' && manifest.originalFilePath.trim().length > 0) {
    rawCandidates.push(manifest.originalFilePath.trim());
  }
  if (typeof manifest.sourceFilePath === 'string' && manifest.sourceFilePath.trim().length > 0) {
    rawCandidates.push(manifest.sourceFilePath.trim());
  }

  for (const candidate of rawCandidates) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.join(projectDir, candidate);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

async function persistManifestSourceFilePath(
  projectDir: string,
  sourceFilePath: string,
): Promise<void> {
  const normalized = sourceFilePath.trim();
  if (normalized.length === 0) return;
  const manifest = await readProjectJsonRecord(projectDir, 'manifest.json');
  if (!manifest) return;

  const currentOriginal = typeof manifest.originalFilePath === 'string'
    ? manifest.originalFilePath.trim()
    : '';
  const currentSource = typeof manifest.sourceFilePath === 'string'
    ? manifest.sourceFilePath.trim()
    : '';
  if (currentOriginal === normalized && currentSource === normalized) {
    return;
  }

  await writeProjectJsonRecord(projectDir, 'manifest.json', {
    ...manifest,
    originalFilePath: normalized,
    sourceFilePath: normalized,
    updatedAt: Date.now(),
  });
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

function normalizeSpecialistHealthStatus(raw: string | undefined): SpecialistHealthStatus {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'healthy') return 'healthy';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'unavailable') return 'unavailable';
  return 'unknown';
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return false;
  return !['0', 'false', 'off', 'no'].includes(normalized);
}

function probePythonDemucsHealth(pythonExe: string): SpecialistHealthStatus {
  if (!pythonExe || !path.isAbsolute(pythonExe) || !fs.existsSync(pythonExe)) {
    return 'unavailable';
  }
  const probe = spawnSync(
    pythonExe,
    ['-c', 'import demucs'],
    { encoding: 'utf-8', timeout: 12_000 },
  );
  if (probe.error) {
    return 'failed';
  }
  if (typeof probe.status === 'number' && probe.status !== 0) {
    return 'failed';
  }
  return 'healthy';
}

function resolveGuitarSpecialistHealthStatus(runtimeProfileId: string): SpecialistHealthStatus {
  if (!runtimeProfileId) return 'unknown';
  if (runtimeProfileId === PILOT_RUNTIME_PROFILE_ID) {
    const pilotPreflight = checkPilotRuntimeProfileAvailability();
    if (!pilotPreflight.configured) {
      return 'unavailable';
    }
    const pilotPython = process.env.DEMUCS_6S_PILOT_PYTHON_EXE?.trim() ?? '';
    return probePythonDemucsHealth(pilotPython);
  }
  return normalizeSpecialistHealthStatus(process.env.ORCH_GUITAR_SPECIALIST_HEALTH_STATUS);
}

function resolveGuitarSpecialistRequiredEnv(
  guitarEnabled: boolean,
  guitarModelId: string,
  runtimeProfileId: string,
): string[] {
  if (!guitarEnabled) {
    return ['ORCH_GUITAR_SPECIALIST_ENABLED'];
  }
  if (!ORCH_GUITAR_SPECIALIST_SUPPORTED_MODEL_IDS.has(guitarModelId)) {
    return ['ORCH_GUITAR_SPECIALIST_MODEL_ID'];
  }
  const required = [ORCH_GUITAR_SPECIALIST_COMMAND_ENV, ORCH_GUITAR_SPECIALIST_CHECKPOINT_ENV];
  if (runtimeProfileId === PILOT_RUNTIME_PROFILE_ID) {
    required.push('DEMUCS_6S_PILOT_PYTHON_EXE');
  }
  return required;
}

function applyGuitarSpecialistCheckpointHealth(
  healthStatus: SpecialistHealthStatus,
  checkpointPath: string,
): SpecialistHealthStatus {
  if (!checkpointPath) return healthStatus;
  const resolvedCheckpoint = path.isAbsolute(checkpointPath)
    ? checkpointPath
    : path.resolve(checkpointPath);
  if (!fs.existsSync(resolvedCheckpoint)) {
    return 'failed';
  }
  try {
    const stat = fs.statSync(resolvedCheckpoint);
    if (!stat.isFile()) {
      return 'failed';
    }
  } catch {
    return 'failed';
  }
  return healthStatus;
}

function resolveOrchestrationSpecialists(): SpecialistDescriptor[] {
  const guitarEnabled = isTruthyEnv(process.env.ORCH_GUITAR_SPECIALIST_ENABLED);
  const guitarModelId = guitarEnabled
    ? (process.env.ORCH_GUITAR_SPECIALIST_MODEL_ID?.trim() || ORCH_GUITAR_SPECIALIST_DEFAULT_MODEL_ID)
    : '';
  const guitarRuntimeProfileId = guitarEnabled
    ? (process.env.ORCH_GUITAR_SPECIALIST_RUNTIME_PROFILE_ID?.trim() || ORCH_GUITAR_SPECIALIST_DEFAULT_RUNTIME_PROFILE_ID)
    : '';
  const guitarCheckpointPath = process.env.ORCH_GUITAR_SPECIALIST_CHECKPOINT?.trim() ?? '';
  const guitarHealthStatus = guitarEnabled
    ? resolveGuitarSpecialistHealthStatus(guitarRuntimeProfileId)
    : 'unknown';
  const guitarHealthStatusWithCheckpoint = applyGuitarSpecialistCheckpointHealth(
    guitarHealthStatus,
    guitarCheckpointPath,
  );
  const guitarRequiredEnv = resolveGuitarSpecialistRequiredEnv(
    guitarEnabled,
    guitarModelId,
    guitarRuntimeProfileId,
  );
  console.log(
    `[REAL_CHAIN] handlers.resolveOrchestrationSpecialists guitar enabled=${guitarEnabled} ` +
    `modelId="${guitarModelId || 'none'}" runtimeProfileId="${guitarRuntimeProfileId || 'none'}" ` +
    `healthStatus="${guitarHealthStatusWithCheckpoint}" cmdConfigured=${Boolean(process.env.ORCH_GUITAR_SPECIALIST_CMD?.trim())} ` +
    `checkpoint="${guitarCheckpointPath || 'none'}"`,
  );

  const pianoModelId = process.env.ORCH_PIANO_SPECIALIST_MODEL_ID?.trim() ?? '';
  const pianoRuntimeProfileId = process.env.ORCH_PIANO_SPECIALIST_RUNTIME_PROFILE_ID?.trim() ?? '';

  return [
    {
      specialistId: 'guitar_specialist',
      targetStem: StemType.Guitar,
      modelId: guitarModelId,
      runtimeProfileId: guitarRuntimeProfileId,
      requiredEnv: guitarRequiredEnv,
      healthStatus: guitarHealthStatusWithCheckpoint,
      selectionPriority: 10,
      supportsFallback: true,
    },
    {
      specialistId: 'piano_specialist',
      targetStem: StemType.Keyboard,
      modelId: pianoModelId,
      runtimeProfileId: pianoRuntimeProfileId,
      requiredEnv: ['ORCH_PIANO_SPECIALIST_MODEL_ID', 'ORCH_PIANO_SPECIALIST_RUNTIME_PROFILE_ID'],
      healthStatus: normalizeSpecialistHealthStatus(process.env.ORCH_PIANO_SPECIALIST_HEALTH_STATUS),
      selectionPriority: 20,
      supportsFallback: true,
    },
  ];
}

function resolveOrchestrationSelectionPolicy(): StemSelectionPolicy {
  return {
    policyId: 'phase2_5a_default',
    baselineStemTypes: [StemType.Drums, StemType.Bass, StemType.Vocal, StemType.Other],
    specialistStemTypes: [StemType.Guitar, StemType.Keyboard],
    fallbackToBaselineOnFailure: true,
  };
}

function buildSpecialistStatusMap(
  specialistReports: SpecialistPassReport[],
): Record<string, SpecialistStatus> {
  const map: Record<string, SpecialistStatus> = {};
  for (const report of specialistReports) {
    map[report.specialistId] = report.status;
  }
  return map;
}

async function ensureOrchestratedManifestPersistence(
  project: Project,
  resultSetEntry: ProjectManifestResultSetEntry,
  orchManifestStems: ManifestStemEntry[],
  debugReportRelativePath: string,
): Promise<void> {
  const resultSetId = resultSetEntry.id;
  const manifest = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
  if (!manifest) {
    throw new Error(`ORCH_MANIFEST_MISSING projectId="${project.id}" cacheDir="${project.cacheDir}"`);
  }

  const existingResultSets = normalizeResultSetEntries(manifest.resultSets);
  const mergedResultSets = [
    ...existingResultSets.filter((entry) => entry.id !== resultSetId),
    resultSetEntry,
  ];
  const rawStems = Array.isArray(manifest.stems)
    ? manifest.stems.filter(isObjectLike)
    : [];
  const keptStems = rawStems.filter((entry) =>
    normalizeParentResultId(typeof entry.parentResultId === 'string' ? entry.parentResultId : undefined) !== resultSetId,
  );
  const activeFromManifest = typeof manifest.activeResultId === 'string' ? manifest.activeResultId.trim() : '';
  const resolvedActive = mergedResultSets.some((entry) => entry.id === activeFromManifest)
    ? activeFromManifest
    : DEFAULT_ACTIVE_RESULT_ID;

  const existingOrchestration = isObjectLike(manifest.orchestration) ? manifest.orchestration : {};
  const existingReports = isObjectLike(existingOrchestration.reports) ? existingOrchestration.reports : {};
  const nextReports = {
    ...existingReports,
    [resultSetId]: {
      path: debugReportRelativePath,
      createdAt: Date.now(),
    },
  };
  const orchestrationMeta = {
    ...existingOrchestration,
    lastResultSetId: resultSetId,
    reports: nextReports,
  };

  await writeProjectJsonRecord(project.cacheDir, 'manifest.json', {
    ...manifest,
    activeResultId: resolvedActive,
    resultSets: mergedResultSets,
    stems: [...keptStems, ...orchManifestStems],
    orchestration: orchestrationMeta,
    updatedAt: Date.now(),
  });

  const verified = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
  const verifiedSets = normalizeResultSetEntries(verified?.resultSets);
  if (!verifiedSets.some((entry) => entry.id === resultSetId)) {
    throw new Error(`ORCH_MANIFEST_RESULT_SET_NOT_PERSISTED resultSetId="${resultSetId}"`);
  }
  const verifiedStems = Array.isArray(verified?.stems) ? verified.stems.filter(isObjectLike) : [];
  const hasOrchStems = verifiedStems.some((entry) =>
    normalizeParentResultId(typeof entry.parentResultId === 'string' ? entry.parentResultId : undefined) === resultSetId,
  );
  if (!hasOrchStems) {
    throw new Error(`ORCH_MANIFEST_STEMS_NOT_PERSISTED resultSetId="${resultSetId}"`);
  }
}

function buildDefaultResultSetEntry(project: Project, stems: Array<{
  modelId?: string;
  runtimeProfileId?: string;
  sourceSignature?: string;
}>): ProjectManifestResultSetEntry | null {
  const signature = stems.find((stem) => typeof stem.sourceSignature === 'string' && stem.sourceSignature.trim().length > 0)?.sourceSignature?.trim();
  if (!signature) return null;
  const modelId = stems.find((stem) => typeof stem.modelId === 'string' && stem.modelId.trim().length > 0)?.modelId?.trim()
    ?? DEFAULT_RESULT_MODEL_ID;
  const runtimeProfileId = stems.find((stem) => typeof stem.runtimeProfileId === 'string' && stem.runtimeProfileId.trim().length > 0)?.runtimeProfileId?.trim()
    ?? DEFAULT_RESULT_RUNTIME_PROFILE_ID;
  return {
    id: DEFAULT_ACTIVE_RESULT_ID,
    modelId,
    runtimeProfileId,
    sourceSignature: signature,
    createdAt: project.updatedAt > 0 ? project.updatedAt : Date.now(),
  };
}

async function resolveActiveResultContext(
  project: Project,
  stems: Array<{ modelId?: string; runtimeProfileId?: string; sourceSignature?: string }> = [],
): Promise<ActiveResultContext> {
  const manifest = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
  const fromManifest = manifest && typeof manifest.activeResultId === 'string'
    ? manifest.activeResultId.trim()
    : '';
  const normalizedSets = normalizeResultSetEntries(manifest?.resultSets);
  const fallbackSet = buildDefaultResultSetEntry(project, stems);
  const resultSets = normalizedSets.length > 0
    ? normalizedSets
    : (fallbackSet ? [fallbackSet] : []);

  const hasMainResultSet = resultSets.some((entry) => entry.id === DEFAULT_ACTIVE_RESULT_ID);
  const fallbackActiveId = DEFAULT_ACTIVE_RESULT_ID;
  const hasManifestActive = fromManifest.length > 0;
  const hasManifestActiveMatch = hasManifestActive && resultSets.some((entry) => entry.id === fromManifest);
  const activeResultId = hasManifestActiveMatch
    ? fromManifest
    : fallbackActiveId;
  const activeSet = resultSets.find((entry) => entry.id === activeResultId) ?? null;
  const fallbackReason = !hasManifestActiveMatch
    ? (!hasManifestActive ? 'manifest_active_missing' : 'manifest_active_invalid')
    : null;
  if (!hasManifestActiveMatch) {
    console.warn(
      `[REAL_CHAIN] handlers.resolveActiveResultContext fallback projectId="${project.id}" ` +
      `fromManifest="${fromManifest || 'none'}" resolved="${activeResultId}" reason="${fallbackReason}" hasMain=${hasMainResultSet}`,
    );
  }

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

  return {
    activeResultId,
    manifestActiveResultId: fromManifest || null,
    fallbackReason,
    sourceSignature: activeSet?.sourceSignature ?? null,
    resultSets,
    modelId: activeSet?.modelId ?? null,
    runtimeProfileId: activeSet?.runtimeProfileId ?? null,
  };
}

async function resolveOrchestrationDebugSnapshot(
  project: Project,
  stems: Array<{
    stemType?: string;
    modelId?: string;
    runtimeProfileId?: string;
    parentResultId?: string;
    sourceSignature?: string;
    selectionReason?: string;
    fallbackUsed?: boolean;
    sourceResultSetId?: string;
  }>,
  activeResultContext: ActiveResultContext,
): Promise<Record<string, unknown>> {
  const orchResultSets = activeResultContext.resultSets
    .filter((entry) => entry.id.startsWith(ORCH_RESULT_SET_PREFIX))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (orchResultSets.length === 0) {
    return {
      exists: false,
      activeIsOrch: activeResultContext.activeResultId.startsWith(ORCH_RESULT_SET_PREFIX),
      orchResultSetId: null,
      latestOrchResultSetId: null,
      baselinePassStatus: 'not_configured',
      guitarSpecialistStatus: 'not_configured',
      pianoSpecialistStatus: 'not_configured',
      specialistReports: [],
      passReports: [],
      stemSelections: [],
      reportPath: null,
    };
  }

  const latestOrchResultSetId = orchResultSets[0].id;
  const inspectedResultSetId = activeResultContext.activeResultId.startsWith(ORCH_RESULT_SET_PREFIX)
    ? activeResultContext.activeResultId
    : latestOrchResultSetId;
  const fallbackStemSelections = filterStemsForResultSet(stems, inspectedResultSetId).map((stem) => ({
    stemType: stem.stemType ?? 'unknown',
    modelId: stem.modelId ?? 'unknown',
    runtimeProfileId: stem.runtimeProfileId ?? 'unknown',
    selectionReason: stem.selectionReason ?? 'unknown',
    fallbackUsed: !!stem.fallbackUsed,
    sourceResultSetId: stem.sourceResultSetId ?? null,
    sourceSignature: stem.sourceSignature ?? null,
  }));

  const manifest = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
  const manifestOrchestration = isObjectLike(manifest?.orchestration)
    ? manifest!.orchestration as Record<string, unknown>
    : null;
  const orchestrationReports = manifestOrchestration && isObjectLike(manifestOrchestration.reports)
    ? manifestOrchestration.reports as Record<string, unknown>
    : null;
  const reportFromManifest = orchestrationReports
    && isObjectLike(orchestrationReports[inspectedResultSetId])
    ? orchestrationReports[inspectedResultSetId] as Record<string, unknown>
    : null;
  const reportPathFromManifest = reportFromManifest && typeof reportFromManifest.path === 'string'
    ? reportFromManifest.path.trim()
    : '';
  const reportPath = reportPathFromManifest.length > 0
    ? reportPathFromManifest
    : path.posix.join('results', inspectedResultSetId, 'orchestration-report.json');
  const reportRecord = await readProjectJsonRecord(project.cacheDir, reportPath);
  const reportPasses = Array.isArray(reportRecord?.passReports)
    ? reportRecord!.passReports.filter(isObjectLike).map((entry) => ({
      passId: typeof entry.passId === 'string' ? entry.passId : 'unknown',
      resultSetId: typeof entry.resultSetId === 'string' ? entry.resultSetId : '',
      executionStatus: typeof entry.executionStatus === 'string'
        ? entry.executionStatus
        : (typeof entry.status === 'string' ? entry.status : 'unknown'),
      specialistStatus: typeof entry.specialistStatus === 'string' ? entry.specialistStatus : null,
      reason: typeof entry.reason === 'string' ? entry.reason : null,
      modelId: typeof entry.modelId === 'string' ? entry.modelId : '',
      runtimeProfileId: typeof entry.runtimeProfileId === 'string' ? entry.runtimeProfileId : '',
      warningCount: typeof entry.warningCount === 'number' ? entry.warningCount : 0,
      jobStatus: typeof entry.jobStatus === 'string' ? entry.jobStatus : null,
      errorCode: typeof entry.errorCode === 'string' ? entry.errorCode : null,
      errorMessage: typeof entry.errorMessage === 'string' ? entry.errorMessage : null,
    }))
    : [];
  const reportSpecialistReports = Array.isArray(reportRecord?.specialistReports)
    ? reportRecord!.specialistReports.filter(isObjectLike).map((entry) => ({
      specialistId: typeof entry.specialistId === 'string' ? entry.specialistId : 'unknown',
      targetStem: typeof entry.targetStem === 'string' ? entry.targetStem : 'unknown',
      modelId: typeof entry.modelId === 'string' ? entry.modelId : '',
      runtimeProfileId: typeof entry.runtimeProfileId === 'string' ? entry.runtimeProfileId : '',
      resultSetId: typeof entry.resultSetId === 'string' ? entry.resultSetId : '',
      status: typeof entry.status === 'string' ? entry.status : 'not_configured',
      healthStatus: typeof entry.healthStatus === 'string' ? entry.healthStatus : 'unknown',
      reason: typeof entry.reason === 'string' ? entry.reason : null,
      warningCount: typeof entry.warningCount === 'number' ? entry.warningCount : 0,
      jobStatus: typeof entry.jobStatus === 'string' ? entry.jobStatus : null,
      errorCode: typeof entry.errorCode === 'string' ? entry.errorCode : null,
      errorMessage: typeof entry.errorMessage === 'string' ? entry.errorMessage : null,
      selected: !!entry.selected,
      fallbackUsed: !!entry.fallbackUsed,
      selectionReason: typeof entry.selectionReason === 'string' ? entry.selectionReason : null,
      sourceResultSetId: typeof entry.sourceResultSetId === 'string' ? entry.sourceResultSetId : null,
      passStatusBeforeFallback: typeof entry.passStatusBeforeFallback === 'string'
        ? entry.passStatusBeforeFallback
        : null,
    }))
    : [];
  const reportStemSelections = Array.isArray(reportRecord?.stemSelections)
    ? reportRecord!.stemSelections.filter(isObjectLike).map((entry) => ({
      stemType: typeof entry.stemType === 'string' ? entry.stemType : 'unknown',
      modelId: typeof entry.modelId === 'string' ? entry.modelId : 'unknown',
      runtimeProfileId: typeof entry.runtimeProfileId === 'string' ? entry.runtimeProfileId : 'unknown',
      selectionReason: typeof entry.selectionReason === 'string' ? entry.selectionReason : 'unknown',
      fallbackUsed: !!entry.fallbackUsed,
      sourceResultSetId: typeof entry.sourceResultSetId === 'string' ? entry.sourceResultSetId : null,
      sourceSignature: typeof entry.sourceSignature === 'string' ? entry.sourceSignature : null,
    }))
    : fallbackStemSelections;

  const baselinePassStatus = (() => {
    if (typeof reportRecord?.baselinePassStatus === 'string') {
      return reportRecord.baselinePassStatus;
    }
    return reportPasses.find((entry) => entry.passId === 'baseline_6s')?.executionStatus ?? 'failed';
  })();
  const fallbackSpecialistStatus = (specialistId: 'guitar_specialist' | 'piano_specialist'): SpecialistStatus => {
    const pass = reportPasses.find((entry) => entry.passId === specialistId);
    if (!pass) return 'not_configured';
    if (typeof pass.specialistStatus === 'string') {
      return pass.specialistStatus as SpecialistStatus;
    }
    if (pass.executionStatus === 'failed') return 'failed';
    if (pass.executionStatus === 'skipped') return 'skipped_by_policy';
    return 'selected';
  };
  const guitarSpecialistReport = reportSpecialistReports.find((entry) => entry.specialistId === 'guitar_specialist');
  const pianoSpecialistReport = reportSpecialistReports.find((entry) => entry.specialistId === 'piano_specialist');

  return {
    exists: true,
    activeIsOrch: activeResultContext.activeResultId.startsWith(ORCH_RESULT_SET_PREFIX),
    orchResultSetId: inspectedResultSetId,
    latestOrchResultSetId,
    availableOrchResultSetIds: orchResultSets.map((entry) => entry.id),
    baselinePassStatus,
    guitarSpecialistStatus: guitarSpecialistReport?.status ?? fallbackSpecialistStatus('guitar_specialist'),
    pianoSpecialistStatus: pianoSpecialistReport?.status ?? fallbackSpecialistStatus('piano_specialist'),
    specialistReports: reportSpecialistReports,
    passReports: reportPasses,
    stemSelections: reportStemSelections,
    reportPath,
  };
}

function buildChordAnalysisCacheKey(
  projectId: string,
  parentResultId: string,
  sourceSignature: string,
  analysisVersion: string,
  analysisMethodKey: string,
): string {
  return `${projectId}::${parentResultId}::${sourceSignature}::${analysisVersion}::${analysisMethodKey}`;
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

async function loadPersistedWaveformResult(
  project: Project,
  expectedAnalysisVersion: string,
  parentResultId: string,
  sourceSignature: string | null,
): Promise<CachedWaveformDTO | null> {
  const refs = await readManifestAnalysisRefs(project.cacheDir);
  const waveformRef = refs?.waveform;
  if (!waveformRef) return null;
  if (waveformRef.version !== expectedAnalysisVersion) return null;
  if (waveformRef.parentResultId && waveformRef.parentResultId !== parentResultId) return null;
  if (!waveformRef.parentResultId && parentResultId !== DEFAULT_ACTIVE_RESULT_ID) return null;
  if (sourceSignature && waveformRef.sourceSignature && waveformRef.sourceSignature !== sourceSignature) return null;

  const raw = await readProjectJsonRecord(project.cacheDir, waveformRef.path);
  if (!raw) return null;

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
        : waveformRef.version,
  };
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
  const refs = await readManifestAnalysisRefs(project.cacheDir);
  const waveformPath = refs?.waveform?.path ?? DEFAULT_WAVEFORM_CACHE_PATH;

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
      bassNote: typeof seg.bassNote === 'string' ? seg.bassNote : undefined,
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
  expectedAnalysisMethodKey: string,
  parentResultId: string,
  sourceSignature: string | null,
): Promise<CachedChordAnalysisDTO | null> {
  const refs = await readManifestAnalysisRefs(project.cacheDir);
  const chordRef = refs?.chordAnalysis;
  if (!chordRef) return null;
  if (chordRef.analysisVersion !== expectedAnalysisVersion) return null;
  if (chordRef.parentResultId && chordRef.parentResultId !== parentResultId) return null;
  if (!chordRef.parentResultId && parentResultId !== DEFAULT_ACTIVE_RESULT_ID) return null;
  if (sourceSignature && chordRef.sourceSignature && chordRef.sourceSignature !== sourceSignature) return null;

  const raw = await readProjectJsonRecord(project.cacheDir, chordRef.path);
  if (!raw) return null;

  const persistedSignature = typeof raw.sourceSignature === 'string' ? raw.sourceSignature : null;
  if (sourceSignature && persistedSignature && persistedSignature !== sourceSignature) {
    return null;
  }
  const persistedParentResultId = typeof raw.parentResultId === 'string' ? raw.parentResultId.trim() : '';
  if (persistedParentResultId && persistedParentResultId !== parentResultId) return null;
  if (!persistedParentResultId && parentResultId !== DEFAULT_ACTIVE_RESULT_ID) return null;

  if (chordRef.analysisMethodKey && chordRef.analysisMethodKey !== expectedAnalysisMethodKey) {
    return null;
  }

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
  const rawAnalysisMethodsRecord = rawAnalysisMethods as Record<string, unknown> | null;
  const persistedAnalysisMethodKey =
    (typeof raw.analysisMethodKey === 'string' && raw.analysisMethodKey.trim().length > 0
      ? raw.analysisMethodKey.trim()
      : null)
    ?? buildAnalysisMethodKey(
      rawAnalysisMethodsRecord
        ? {
          chordAnalyzer:
            typeof rawAnalysisMethodsRecord.chordAnalyzer === 'string'
              ? rawAnalysisMethodsRecord.chordAnalyzer
              : DEFAULT_CHORD_ANALYZER_ID,
          tempoAnalyzer:
            typeof rawAnalysisMethodsRecord.tempoAnalyzer === 'string'
              ? rawAnalysisMethodsRecord.tempoAnalyzer
              : DEFAULT_TEMPO_ANALYZER_ID,
        }
        : null,
    );
  if (!persistedAnalysisMethodKey || persistedAnalysisMethodKey !== expectedAnalysisMethodKey) {
    return null;
  }

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
        }
        : undefined,
    }
    : undefined;

  return {
    projectId: typeof raw.projectId === 'string' && raw.projectId.trim().length > 0
      ? raw.projectId
      : project.id,
    source: typeof raw.source === 'string' ? raw.source : 'mixed',
    analyzerType: typeof raw.analyzerType === 'string' ? raw.analyzerType : 'rule_based',
    analysisMethods: rawAnalysisMethods
      ? {
        chordAnalyzer: typeof rawAnalysisMethods.chordAnalyzer === 'string'
          ? rawAnalysisMethods.chordAnalyzer
          : 'chord_default',
        tempoAnalyzer: typeof rawAnalysisMethods.tempoAnalyzer === 'string'
          ? rawAnalysisMethods.tempoAnalyzer
          : 'tempo_default',
      }
      : undefined,
    segments,
    elapsedMs,
    analyzedAt,
    audioDurationMs,
    estimatedKey: typeof raw.estimatedKey === 'string' ? raw.estimatedKey : undefined,
    estimatedBpm,
    tempo,
    analysisVersion:
      typeof raw.analysisVersion === 'string' && raw.analysisVersion.trim().length > 0
        ? raw.analysisVersion
        : chordRef.analysisVersion,
    vocabularyVersion:
      typeof raw.vocabularyVersion === 'string' && raw.vocabularyVersion.trim().length > 0
        ? raw.vocabularyVersion
        : chordRef.vocabularyVersion,
    chordVocabulary: rawChordVocabulary
      ? {
        selected: typeof rawChordVocabulary.selected === 'string' ? rawChordVocabulary.selected : 'triad',
        supportsExtendedChords: Boolean(rawChordVocabulary.supportsExtendedChords),
        supportedDescriptors: Array.isArray(rawChordVocabulary.supportedDescriptors)
          ? rawChordVocabulary.supportedDescriptors.filter((item): item is string => typeof item === 'string')
          : [],
      }
      : undefined,
    warnings,
    generatedAt: typeof raw.generatedAt === 'number' && Number.isFinite(raw.generatedAt)
      ? Math.floor(raw.generatedAt)
      : Date.now(),
  };
}

async function persistChordResult(
  project: Project,
  chordResult: CachedChordAnalysisDTO,
  parentResultId: string,
  sourceSignature: string | null,
  analysisMethodKey: string,
): Promise<void> {
  const refs = await readManifestAnalysisRefs(project.cacheDir);
  const chordPath = refs?.chordAnalysis?.path ?? DEFAULT_CHORD_CACHE_PATH;
  const analysisVersion =
    typeof chordResult.analysisVersion === 'string' && chordResult.analysisVersion.trim().length > 0
      ? chordResult.analysisVersion.trim()
      : getChordAnalysisVersionHint();
  const vocabularyVersion =
    typeof chordResult.vocabularyVersion === 'string' && chordResult.vocabularyVersion.trim().length > 0
      ? chordResult.vocabularyVersion.trim()
      : 'triad-v1';

  await writeProjectJsonRecord(project.cacheDir, chordPath, {
    ...chordResult,
    parentResultId,
    analysisVersion,
    vocabularyVersion,
    analysisMethodKey,
    segmentCount: chordResult.segments.length,
    sourceSignature,
    generatedAt: chordResult.generatedAt ?? Date.now(),
  });
  await patchManifestAnalysisRefs(project.cacheDir, {
    chordAnalysis: {
      path: chordPath,
      analysisVersion,
      vocabularyVersion,
      analysisMethodKey,
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
  const manifestHasOriginalFilePath = !!manifestData
    && Object.prototype.hasOwnProperty.call(manifestData, 'originalFilePath');
  const manifestHasSourceFilePath = !!manifestData
    && Object.prototype.hasOwnProperty.call(manifestData, 'sourceFilePath');
  const manifestOriginalFilePathValue = manifestData && typeof manifestData.originalFilePath === 'string'
    ? manifestData.originalFilePath.trim()
    : '';
  const manifestSourceFilePathValue = manifestData && typeof manifestData.sourceFilePath === 'string'
    ? manifestData.sourceFilePath.trim()
    : '';
  const restoredOriginalFilePath = resolveManifestSourceFilePath(manifestData, selectedDir);
  console.log(
    `[project:openExisting] source_path_probe projectId="${projectId}" projectDir="${selectedDir}" ` +
    `manifestHasOriginalFilePath=${manifestHasOriginalFilePath} manifestHasSourceFilePath=${manifestHasSourceFilePath} ` +
    `manifestOriginalFilePath="${manifestOriginalFilePathValue || 'none'}" ` +
    `manifestSourceFilePath="${manifestSourceFilePathValue || 'none'}" ` +
    `resolvedOriginalFilePath="${restoredOriginalFilePath ?? 'none'}"`,
  );
  if (!restoredOriginalFilePath) {
    console.warn(
      `[project:openExisting] original source path unavailable projectDir="${selectedDir}" projectId="${projectId}"`,
    );
  }

  const project: Project = {
    id: projectId,
    fingerprint: '',
    sourceType,
    displayName,
    originalFilePath: restoredOriginalFilePath,
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

  waveformResultCache.delete(projectId);
  chordAnalysisResultCache.delete(projectId);

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
            const restored = await restoreExistingProjectFromDir(entry.projectDir, workerInfra, {
              indexUpdatedAt: entry.updatedAt,
              indexDisplayName: entry.displayName,
            });
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

          // 鍒嗙瀹屾垚鍚庢洿鏂?project 鐨?metadata
          const stemFiles = await infraRef.stemFileRepo.findByProjectId(projectId);
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
          try {
            await persistManifestSourceFilePath(outputDir, filePath);
          } catch (persistErr) {
            console.warn(
              `[project:startSeparation] persist sourceFilePath failed projectId="${projectId}" reason="${normalizeErrorMessage(persistErr, 'unknown')}"`,
            );
          }
          console.log(
            `[REAL_CHAIN] handlers.project:startSeparation manifest_patched projectId="${projectId}" manifestPath="${metadataPatchResult.manifestPath}" activeResultId="${DEFAULT_ACTIVE_RESULT_ID}" resultSetCount=${resultSets.length}`,
          );

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

    const pilotRuntimePreflight = checkPilotRuntimeProfileAvailability();
    if (!pilotRuntimePreflight.configured) {
      const missing = pilotRuntimePreflight.missingItems.length > 0
        ? pilotRuntimePreflight.missingItems.join(', ')
        : 'unknown';
      console.error(
        `[REAL_CHAIN] handlers.project:startPilotSeparation preflight_failed projectId="${projectId}" ` +
        `reason="pilot_runtime_profile_unavailable" runtimeProfileId="${PILOT_RUNTIME_PROFILE_ID}" ` +
        `DEMUCS_6S_PILOT_PYTHON_EXE="${process.env.DEMUCS_6S_PILOT_PYTHON_EXE ?? ''}" ` +
        `DEMUCS_6S_PILOT_ENV_ROOT="${process.env.DEMUCS_6S_PILOT_ENV_ROOT ?? ''}" ` +
        `missing="${missing}"`,
      );
      throw new Error(
        `PILOT_RUNTIME_PROFILE_UNAVAILABLE: missing ${missing} or runtime profile registration for ${PILOT_RUNTIME_PROFILE_ID}`,
      );
    }

    const jobId = `job-${crypto.randomUUID().slice(0, 8)}`;
    const resultSetId = `pilot_6s_${Date.now()}`;
    const manifest = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
    const requestSourceFilePath = typeof sourceFilePath === 'string' ? sourceFilePath.trim() : '';
    const projectOriginalFilePath = typeof project.originalFilePath === 'string'
      ? project.originalFilePath.trim()
      : '';
    const manifestOriginalFilePath = manifest && typeof manifest.originalFilePath === 'string'
      ? manifest.originalFilePath.trim()
      : '';
    const manifestSourceFilePath = manifest && typeof manifest.sourceFilePath === 'string'
      ? manifest.sourceFilePath.trim()
      : '';
    const rawCandidates = [
      {
        source: 'request.sourceFilePath',
        path: requestSourceFilePath,
      },
      {
        source: 'project.originalFilePath',
        path: projectOriginalFilePath,
      },
      {
        source: 'manifest.originalFilePath',
        path: manifestOriginalFilePath,
      },
      {
        source: 'manifest.sourceFilePath',
        path: manifestSourceFilePath,
      },
    ].filter((candidate) => candidate.path.length > 0);
    const sourceCandidates = rawCandidates
      .map((candidate) => ({
        ...candidate,
        resolvedPath: path.isAbsolute(candidate.path)
          ? candidate.path
          : path.join(project.cacheDir, candidate.path),
      }))
      .filter((candidate, index, array) =>
        array.findIndex((entry) => path.resolve(entry.resolvedPath) === path.resolve(candidate.resolvedPath)) === index,
      );
    const sourceProbe = await Promise.all(sourceCandidates.map(async (candidate) => {
      const exists = fs.existsSync(candidate.resolvedPath);
      if (!exists) {
        return {
          source: candidate.source,
          rawPath: candidate.path,
          resolvedPath: candidate.resolvedPath,
          exists: false,
          readable: false,
          accessError: 'ENOENT',
        };
      }
      try {
        await fs.promises.access(candidate.resolvedPath, fs.constants.R_OK);
        return {
          source: candidate.source,
          rawPath: candidate.path,
          resolvedPath: candidate.resolvedPath,
          exists: true,
          readable: true,
          accessError: '',
        };
      } catch (err) {
        return {
          source: candidate.source,
          rawPath: candidate.path,
          resolvedPath: candidate.resolvedPath,
          exists: true,
          readable: false,
          accessError: normalizeErrorMessage(err, 'ACCESS_DENIED'),
        };
      }
    }));
    console.log(
      `[REAL_CHAIN] handlers.project:startPilotSeparation source_probe projectId="${projectId}" jobId="${jobId}" resultSetId="${resultSetId}" ` +
      `requestSourceFilePath="${requestSourceFilePath || 'none'}" ` +
      `projectOriginalFilePath="${projectOriginalFilePath || 'none'}" ` +
      `manifestOriginalFilePath="${manifestOriginalFilePath || 'none'}" ` +
      `manifestSourceFilePath="${manifestSourceFilePath || 'none'}" probes=${JSON.stringify(sourceProbe)}`,
    );
    const resolvedSource = sourceProbe.find((probe) => probe.exists);
    if (!resolvedSource && sourceProbe.length === 0) {
      console.warn(
        `[REAL_CHAIN] handlers.project:startPilotSeparation source_path_missing projectId="${projectId}" ` +
        `requestSourceFilePath="${requestSourceFilePath || 'none'}" ` +
        `projectOriginalFilePath="${projectOriginalFilePath || 'none'}" ` +
        `manifestOriginalFilePath="${manifestOriginalFilePath || 'none'}" ` +
        `manifestSourceFilePath="${manifestSourceFilePath || 'none'}"`,
      );
      throw new Error(
        'PILOT_SOURCE_PATH_REQUIRED: 缺少可用的原始音频路径，请重新选择源文件后再试实验6轨分离',
      );
    }
    if (!resolvedSource) {
      console.warn(
        `[REAL_CHAIN] handlers.project:startPilotSeparation source_path_unreadable projectId="${projectId}" ` +
        `probes=${JSON.stringify(sourceProbe)}`,
      );
      throw new Error(
        'PILOT_SOURCE_PATH_REQUIRED: 原始音频路径不可访问，请重新选择源文件后重试',
      );
    }
    if (!resolvedSource.readable) {
      console.warn(
        `[REAL_CHAIN] handlers.project:startPilotSeparation source_path_unreadable projectId="${projectId}" ` +
        `resolvedSource=${JSON.stringify(resolvedSource)} probes=${JSON.stringify(sourceProbe)}`,
      );
      throw new Error(
        'PILOT_SOURCE_PATH_REQUIRED: 原始音频路径不可访问，请重新选择源文件后重试',
      );
    }
    const resolvedSourceFilePath = resolvedSource.resolvedPath;
    console.log(
      `[REAL_CHAIN] handlers.project:startPilotSeparation source_resolved projectId="${projectId}" jobId="${jobId}" resultSetId="${resultSetId}" ` +
      `source="${resolvedSource.source}" rawPath="${resolvedSource.rawPath}" resolvedPath="${resolvedSourceFilePath}" ` +
      `exists=${resolvedSource.exists} readable=${resolvedSource.readable}`,
    );
    if (project.originalFilePath !== resolvedSourceFilePath) {
      await workerInfra.projectRepo.update(projectId, { originalFilePath: resolvedSourceFilePath });
    }
    try {
      await persistManifestSourceFilePath(project.cacheDir, resolvedSourceFilePath);
    } catch (persistErr) {
      console.warn(
        `[project:startPilotSeparation] persist sourceFilePath failed projectId="${projectId}" reason="${normalizeErrorMessage(persistErr, 'unknown')}"`,
      );
    }

    const win = BrowserWindow.fromWebContents(event.sender);

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
      let pilotFailureStage = 'start';
      try {
        pilotFailureStage = 'start_parse_job';
        console.log(
          `[REAL_CHAIN] handlers.project:startPilotSeparation real_path_enter projectId="${projectId}" jobId="${jobId}" resultSetId="${resultSetId}" model="${PILOT_MODEL_ID}" runtimeProfile="${PILOT_RUNTIME_PROFILE_ID}"`,
        );
        console.log(
          `[REAL_CHAIN] handlers.project:startPilotSeparation parse_job_call_before projectId="${projectId}" jobId="${jobId}" resultSetId="${resultSetId}" ` +
          `sourceFilePath="${resolvedSourceFilePath}" modelId="${PILOT_MODEL_ID}" runtimeProfileId="${PILOT_RUNTIME_PROFILE_ID}"`,
        );
        const result = await workerInfra!.parseJobService.startSeparation({
          projectId,
          sourceFilePath: resolvedSourceFilePath,
          projectDir: project.cacheDir,
          resultSetId,
          preserveExistingStems: true,
          allowReadyStatus: true,
          runtimeProfileIdOverride: PILOT_RUNTIME_PROFILE_ID,
          workerModelOverride: PILOT_MODEL_ID,
        });
        console.log(
          `[REAL_CHAIN] handlers.project:startPilotSeparation parse_job_call_after projectId="${projectId}" jobId="${jobId}" resultSetId="${resultSetId}" ` +
          `projectStatusAfter="${result.projectStatusAfter}" jobStatus="${result.job.status}" ` +
          `jobErrorCode="${result.job.errorCode ?? 'none'}" jobErrorMessage="${result.job.errorMessage ?? 'none'}" ` +
          `warningCount=${result.warnings.length}`,
        );
        pilotFailureStage = 'validate_parse_job_result';
        if (result.projectStatusAfter !== ProjectStatus.Ready) {
          const explicitError = `PILOT_PARSE_JOB_FAILED projectStatusAfter="${result.projectStatusAfter}" ` +
            `jobStatus="${result.job.status}" errorCode="${result.job.errorCode ?? 'unknown'}" ` +
            `errorMessage="${result.job.errorMessage ?? 'unknown'}"`;
          throw new Error(explicitError);
        }

        pilotFailureStage = 'validate_pilot_stems';
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
        pilotFailureStage = 'persist_manifest';
        await ensurePilotManifestPersistence(project, resultSetId, pilotStems);
        console.log(
          `[REAL_CHAIN] handlers.project:startPilotSeparation manifest_persisted projectId="${projectId}" resultSetId="${resultSetId}" pilotStemCount=${pilotStems.length}`,
        );

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
        const errorMessage = normalizeErrorMessage(err, 'unknown_pilot_error');
        const errRecord = err as { code?: unknown; errorCode?: unknown };
        const errorCode = typeof errRecord.code === 'string'
          ? errRecord.code
          : (typeof errRecord.errorCode === 'string' ? errRecord.errorCode : null);
        const errorType = classifyPilotFailure(errorMessage, errorCode);
        console.error(
          `[REAL_CHAIN] handlers.project:startPilotSeparation real_path_error projectId="${projectId}" jobId="${jobId}" resultSetId="${resultSetId}" ` +
          `stage="${pilotFailureStage}" errorType="${errorType}" errorCode="${errorCode ?? 'none'}" ` +
          `errorMessage="${errorMessage}" modelId="${PILOT_MODEL_ID}" runtimeProfileId="${PILOT_RUNTIME_PROFILE_ID}"`,
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

  ipcMain.handle('project:startOrchestratedSeparation', async (_event, projectId: string, sourceFilePath?: string) => {
    if (!workerInfra) {
      throw new Error('分离服务不可用，请重启应用后重试');
    }
    if (typeof projectId !== 'string' || projectId.trim().length === 0) {
      throw new Error('缺少项目 ID，无法启动 orchestration 试点');
    }
    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) {
      throw new Error('项目不存在，无法启动 orchestration 试点');
    }
    const pilotRuntimePreflight = checkPilotRuntimeProfileAvailability();
    if (!pilotRuntimePreflight.configured) {
      const missing = pilotRuntimePreflight.missingItems.length > 0
        ? pilotRuntimePreflight.missingItems.join(', ')
        : 'unknown';
      throw new Error(`ORCH_RUNTIME_PROFILE_UNAVAILABLE: missing ${missing}`);
    }

    const manifest = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
    const requestSourceFilePath = typeof sourceFilePath === 'string' ? sourceFilePath.trim() : '';
    const projectOriginalFilePath = typeof project.originalFilePath === 'string'
      ? project.originalFilePath.trim()
      : '';
    const manifestOriginalFilePath = manifest && typeof manifest.originalFilePath === 'string'
      ? manifest.originalFilePath.trim()
      : '';
    const manifestSourceFilePath = manifest && typeof manifest.sourceFilePath === 'string'
      ? manifest.sourceFilePath.trim()
      : '';
    const sourceCandidates = [
      requestSourceFilePath,
      projectOriginalFilePath,
      manifestOriginalFilePath,
      manifestSourceFilePath,
    ]
      .filter((candidate) => candidate.length > 0)
      .map((candidate) => (path.isAbsolute(candidate) ? candidate : path.join(project.cacheDir, candidate)));
    let resolvedSourceFilePath = '';
    for (const candidate of sourceCandidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
        await fs.promises.access(candidate, fs.constants.R_OK);
        resolvedSourceFilePath = candidate;
        break;
      } catch {
        // try next candidate
      }
    }
    console.log(
      `[REAL_CHAIN] handlers.project:startOrchestratedSeparation source_probe projectId="${projectId}" ` +
      `requestSourceFilePath="${requestSourceFilePath || 'none'}" projectOriginalFilePath="${projectOriginalFilePath || 'none'}" ` +
      `manifestOriginalFilePath="${manifestOriginalFilePath || 'none'}" manifestSourceFilePath="${manifestSourceFilePath || 'none'}" ` +
      `resolved="${resolvedSourceFilePath || 'none'}"`,
    );
    if (!resolvedSourceFilePath) {
      throw new Error('ORCH_SOURCE_PATH_REQUIRED: 缺少可读的原始音频路径，无法启动 orchestration');
    }
    if (project.originalFilePath !== resolvedSourceFilePath) {
      await workerInfra.projectRepo.update(projectId, { originalFilePath: resolvedSourceFilePath });
    }
    await persistManifestSourceFilePath(project.cacheDir, resolvedSourceFilePath);

    const orchestrationResultSetId = `${ORCH_RESULT_SET_PREFIX}${Date.now()}`;
    const orchestrationService = new OrchestratedSeparationService(
      workerInfra.parseJobService,
      workerInfra.projectRepo,
      workerInfra.stemFileRepo,
    );
    const specialists = resolveOrchestrationSpecialists();
    const executionPlan: SpecialistExecutionPlan = {
      orchestratedResultSetId: orchestrationResultSetId,
      baselineModelId: PILOT_MODEL_ID,
      baselineRuntimeProfileId: PILOT_RUNTIME_PROFILE_ID,
      specialists,
      selectionPolicy: resolveOrchestrationSelectionPolicy(),
    };
    const orchestrationResult = await orchestrationService.start({
      projectId,
      sourceFilePath: resolvedSourceFilePath,
      projectDir: project.cacheDir,
      executionPlan,
    });

    const existingStems = await workerInfra.stemFileRepo.findByProjectId(projectId);
    const keptStems = existingStems.filter((stem) =>
      normalizeParentResultId(stem.parentResultId) !== orchestrationResultSetId,
    );
    await workerInfra.stemFileRepo.deleteByProjectId(projectId);
    await workerInfra.stemFileRepo.createMany([...keptStems, ...orchestrationResult.stemFiles]);

    const resultSetEntry: ProjectManifestResultSetEntry = {
      id: orchestrationResult.resultSetEntry.id,
      modelId: orchestrationResult.resultSetEntry.modelId,
      runtimeProfileId: orchestrationResult.resultSetEntry.runtimeProfileId,
      sourceSignature: orchestrationResult.resultSetEntry.sourceSignature,
      createdAt: orchestrationResult.resultSetEntry.createdAt,
    };
    const manifestEntries: ManifestStemEntry[] = orchestrationResult.manifestEntries.map((entry) => ({
      ...entry,
      relativePath: normalizeManifestRelativePath(project.cacheDir, path.join(project.cacheDir, entry.relativePath)),
    }));
    await ensureOrchestratedManifestPersistence(
      project,
      resultSetEntry,
      manifestEntries,
      orchestrationResult.debugReportRelativePath,
    );
    await workerInfra.projectRepo.updateStatus(projectId, ProjectStatus.Ready);
    console.log(
      `[REAL_CHAIN] handlers.project:startOrchestratedSeparation completed projectId="${projectId}" resultSetId="${orchestrationResultSetId}" ` +
      `baselineResultSetId="${orchestrationResult.baselineResultSetId}" stemCount=${orchestrationResult.stemFiles.length} ` +
      `passReports=${JSON.stringify(orchestrationResult.passReports)}`,
    );

    return {
      jobId: `orch-${crypto.randomUUID().slice(0, 8)}`,
      projectId,
      resultSetId: orchestrationResultSetId,
      modelId: ORCH_RESULT_MODEL_ID,
      runtimeProfileId: ORCH_RESULT_RUNTIME_PROFILE_ID,
      passReports: orchestrationResult.passReports,
      specialistReports: orchestrationResult.specialistReports,
      specialistStatusMap: buildSpecialistStatusMap(orchestrationResult.specialistReports),
      warnings: orchestrationResult.warnings,
      orchestrationDebug: orchestrationResult.debugReport,
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

  ipcMain.handle('project:rebindSourceFile', async (_event, projectId: string, filePath: string) => {
    if (!workerInfra) {
      throw new Error('原始音频重绑服务不可用，请重启应用后重试');
    }
    if (typeof projectId !== 'string' || projectId.trim().length === 0) {
      throw new Error('缺少项目 ID，无法重绑原始音频');
    }
    const normalizedFilePath = typeof filePath === 'string' ? filePath.trim() : '';
    if (normalizedFilePath.length === 0) {
      throw new Error('缺少原始音频路径，无法重绑');
    }
    try {
      await fs.promises.access(normalizedFilePath, fs.constants.R_OK);
    } catch (err) {
      throw new Error(
        `PILOT_SOURCE_PATH_REQUIRED: 指定的原始音频不可读（path="${normalizedFilePath}" reason="${normalizeErrorMessage(err, 'access_failed')}")`,
      );
    }

    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) {
      throw new Error('项目不存在，无法重绑原始音频');
    }

    await workerInfra.projectRepo.update(projectId, { originalFilePath: normalizedFilePath });
    await persistManifestSourceFilePath(project.cacheDir, normalizedFilePath);
    console.log(
      `[REAL_CHAIN] handlers.project:rebindSourceFile projectId="${projectId}" sourceFilePath="${normalizedFilePath}"`,
    );
    return {
      projectId,
      originalFilePath: normalizedFilePath,
    };
  });

  ipcMain.handle('project:setActiveResult', async (_event, projectId: string, resultSetId: string) => {
    if (!workerInfra) {
      throw new Error('结果集切换服务不可用，请重启应用后重试');
    }
    if (typeof projectId !== 'string' || projectId.trim().length === 0) {
      throw new Error('缺少项目 ID，无法切换结果集');
    }
    const normalizedResultSetId = typeof resultSetId === 'string' ? resultSetId.trim() : '';
    if (!normalizedResultSetId) {
      throw new Error('缺少 resultSetId，无法切换结果集');
    }

    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) {
      throw new Error('项目不存在，无法切换结果集');
    }

    const manifest = await readProjectJsonRecord(project.cacheDir, 'manifest.json');
    const resultSets = normalizeResultSetEntries(manifest?.resultSets);
    if (resultSets.length === 0) {
      throw new Error('当前项目没有可切换的结果集');
    }
    if (!resultSets.some((entry) => entry.id === normalizedResultSetId)) {
      throw new Error(`目标结果集不存在：${normalizedResultSetId}`);
    }

    await patchProjectManifestMetadata(project.cacheDir, {
      activeResultId: normalizedResultSetId,
      resultSets,
    });
    console.log(
      `[REAL_CHAIN] handlers.project:setActiveResult projectId="${projectId}" activeResultId="${normalizedResultSetId}" resultSetCount=${resultSets.length}`,
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
    const orchestrationDebug = await resolveOrchestrationDebugSnapshot(project, allStems, activeResultContext);
    const stems = filterStemsForResultSet(allStems, activeResultContext.activeResultId);
    console.log(
      `[REAL_CHAIN] handlers.project:getResult active_context projectId="${projectId}" resultSetCount=${activeResultContext.resultSets.length} ` +
      `activeFromManifest="${activeResultContext.manifestActiveResultId ?? 'none'}" ` +
      `activeResolved="${activeResultContext.activeResultId}" fallbackReason="${activeResultContext.fallbackReason ?? 'none'}"`,
    );

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
      resultSets: activeResultContext.resultSets,
      sourceFilePath: project.originalFilePath ?? null,
      activeResultModelId: activeResultContext.modelId,
      activeResultRuntimeProfileId: activeResultContext.runtimeProfileId,
      orchestrationDebug,
    };
  });

  ipcMain.handle('project:getStems', async (_event, projectId: string) => {
    console.log(`[REAL_CHAIN] handlers.project:getStems query projectId="${projectId}"`);
    if (!workerInfra) return [];

    // 鏌ヨ鐪熷疄 stem 鏂囦欢
    const allStems = await workerInfra.stemFileRepo.findByProjectId(projectId);
    const project = await workerInfra.projectRepo.findById(projectId);
    if (!project) return [];
    const activeResultContext = await resolveActiveResultContext(project, allStems);
    const stems = filterStemsForResultSet(allStems, activeResultContext.activeResultId);
    console.log(
      `[REAL_CHAIN] handlers.project:getStems repo_result projectId="${projectId}" activeResultId="${activeResultContext.activeResultId}" ` +
      `activeFromManifest="${activeResultContext.manifestActiveResultId ?? 'none'}" fallbackReason="${activeResultContext.fallbackReason ?? 'none'}" ` +
      `allStemsCount=${allStems.length} filteredStemsCount=${stems.length}`,
    );

    if (stems.length > 0) {
      console.log(`[REAL_CHAIN] handlers.project:getStems fallbackHit=false projectId="${projectId}"`);
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
        selectionReason: sf.selectionReason,
        fallbackUsed: sf.fallbackUsed,
        sourceResultSetId: sf.sourceResultSetId,
      }));
    }

    const fallbackReason = allStems.length > 0
      ? 'active_result_set_empty'
      : 'project_stems_empty';
    console.warn(
      `[REAL_CHAIN] handlers.project:getStems fallbackHit=false projectId="${projectId}" fallbackReason="${fallbackReason}" activeResultId="${activeResultContext.activeResultId}" allStemsCount=${allStems.length} filteredStemsCount=0`,
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
    const cached = waveformResultCache.get(projectId);
    if (cached && sourceSignature) {
      const cacheHit =
        cached.parentResultId === parentResultId
        && cached.sourceSignature === sourceSignature
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

    const persistedWaveform = await loadPersistedWaveformResult(
      project,
      expectedAnalysisVersion,
      parentResultId,
      sourceSignature,
    );
    if (persistedWaveform) {
      if (sourceSignature) {
        waveformResultCache.set(projectId, {
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
      if (cached && cached.parentResultId === parentResultId) {
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
        waveformResultCache.set(projectId, {
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
      if (cached && cached.parentResultId === parentResultId) {
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
    console.log(
      `[REAL_CHAIN] handlers.project:getChordAnalysis source_resolved projectId="${projectId}" ` +
      `source_kind="${sourceKind}" source_signature_available=${sourceSignature != null}`,
    );

    const expectedAnalysisVersion = getChordAnalysisVersionHint();
    const expectedAnalysisMethodKey = resolveExpectedAnalysisMethodKey();
    const cached = chordAnalysisResultCache.get(projectId);
    if (cached && sourceSignature) {
      const cacheHit =
        cached.parentResultId === parentResultId
        && cached.sourceSignature === sourceSignature
        && cached.analysisVersion === expectedAnalysisVersion
        && cached.analysisMethodKey === expectedAnalysisMethodKey;
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
        `reason="signature_or_version_or_method_changed" cachedVersion="${cached.analysisVersion}" expectedVersion="${expectedAnalysisVersion}" ` +
        `cachedMethod="${cached.analysisMethodKey}" expectedMethod="${expectedAnalysisMethodKey}"`,
      );
    } else if (!sourceSignature) {
      console.log(
        `[REAL_CHAIN] handlers.project:getChordAnalysis cache_bypass projectId="${projectId}" ` +
        `source_kind="${sourceKind}" reason="source_signature_unavailable" analysisVersion="${expectedAnalysisVersion}"`,
      );
    }

    const persistedChord = await loadPersistedChordResult(
      project,
      expectedAnalysisVersion,
      expectedAnalysisMethodKey,
      parentResultId,
      sourceSignature,
    );
    if (persistedChord) {
      if (sourceSignature) {
        chordAnalysisResultCache.set(projectId, {
          cacheKey: buildChordAnalysisCacheKey(
            projectId,
            parentResultId,
            sourceSignature,
            expectedAnalysisVersion,
            expectedAnalysisMethodKey,
          ),
          parentResultId,
          sourceFilePath,
          sourceSignature,
          analysisVersion: expectedAnalysisVersion,
          analysisMethodKey: expectedAnalysisMethodKey,
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
      if (
        cached
        && cached.parentResultId === parentResultId
        && cached.analysisMethodKey === expectedAnalysisMethodKey
      ) {
        console.log(
          `[REAL_CHAIN] handlers.project:getChordAnalysis return_stale_cache projectId="${projectId}"`,
        );
        return cached.result;
      }
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
          bassNote: typeof (seg as { bassNote?: unknown }).bassNote === 'string'
            ? (seg as { bassNote: string }).bassNote
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
            }
            : undefined,
        }
        : undefined;
      const warnings = sanitizeChordWarnings(raw.warnings);
      if (rawEstimatedBpm != null && normalizedEstimatedBpm == null) {
        warnings.push('BPM 估计值不稳定，已隐藏该字段');
      }

      const chordResult: CachedChordAnalysisDTO = {
        projectId,
        source: typeof raw.source === 'string' ? raw.source : 'mixed',
        analyzerType: typeof raw.analyzerType === 'string' ? raw.analyzerType : 'rule_based',
        analysisMethods: isObjectLike((raw as { analysisMethods?: unknown }).analysisMethods)
          ? {
            chordAnalyzer: typeof ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.chordAnalyzer) === 'string'
              ? ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.chordAnalyzer as string)
              : 'chord_default',
            tempoAnalyzer: typeof ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.tempoAnalyzer) === 'string'
              ? ((raw as { analysisMethods: Record<string, unknown> }).analysisMethods.tempoAnalyzer as string)
              : 'tempo_default',
          }
          : undefined,
        segments,
        elapsedMs: typeof raw.elapsedMs === 'number' ? Math.max(0, Math.floor(raw.elapsedMs)) : 0,
        analyzedAt: typeof raw.analyzedAt === 'number' ? raw.analyzedAt : Date.now(),
        audioDurationMs: typeof raw.audioDurationMs === 'number' ? Math.max(0, Math.floor(raw.audioDurationMs)) : (project.durationMs ?? 0),
        estimatedKey: typeof raw.estimatedKey === 'string' ? raw.estimatedKey : undefined,
        estimatedBpm: normalizedEstimatedBpm,
        tempo,
        analysisVersion: typeof raw.analysisVersion === 'string' ? raw.analysisVersion : expectedAnalysisVersion,
        vocabularyVersion: typeof raw.vocabularyVersion === 'string' ? raw.vocabularyVersion : 'triad-v1',
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

      const resolvedAnalysisVersion = chordResult.analysisVersion ?? expectedAnalysisVersion;
      const resolvedAnalysisMethodKey =
        buildAnalysisMethodKey(chordResult.analysisMethods) ?? expectedAnalysisMethodKey;
      if (sourceSignature) {
        chordAnalysisResultCache.set(projectId, {
          cacheKey: buildChordAnalysisCacheKey(
            projectId,
            parentResultId,
            sourceSignature,
            resolvedAnalysisVersion,
            resolvedAnalysisMethodKey,
          ),
          parentResultId,
          sourceFilePath,
          sourceSignature,
          analysisVersion: resolvedAnalysisVersion,
          analysisMethodKey: resolvedAnalysisMethodKey,
          cachedAt: Date.now(),
          result: chordResult,
        });
      }
      try {
        await persistChordResult(
          project,
          chordResult,
          parentResultId,
          sourceSignature,
          resolvedAnalysisMethodKey,
        );
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
      if (
        cached
        && cached.parentResultId === parentResultId
        && cached.analysisMethodKey === expectedAnalysisMethodKey
      ) {
        console.log(
          `[REAL_CHAIN] handlers.project:getChordAnalysis return_stale_cache_on_error projectId="${projectId}"`,
        );
        return cached.result;
      }
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
    let activeResultId = DEFAULT_ACTIVE_RESULT_ID;
    let scopedStems = allStems;
    if (workerInfra) {
      const project = await workerInfra.projectRepo.findById(request.projectId);
      if (project) {
        const activeResultContext = await resolveActiveResultContext(project, allStems);
        activeResultId = activeResultContext.activeResultId;
        scopedStems = filterStemsForResultSet(allStems, activeResultId);
      }
    }
    console.log(
      `[REAL_CHAIN] handlers.export:stems active_gate projectId="${request.projectId}" ` +
      `activeResultId="${activeResultId}" allStemsCount=${allStems.length} scopedStemsCount=${scopedStems.length}`,
    );
    const exportableStems = scopedStems.filter(
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


