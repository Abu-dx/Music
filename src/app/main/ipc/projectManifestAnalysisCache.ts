import * as fs from 'fs';
import * as path from 'path';

export interface ManifestWaveformRef {
  path: string;
  version: string;
  parentResultId?: string;
  sourceSignature?: string;
}

export interface ManifestChordAnalysisRef {
  path: string;
  analysisVersion: string;
  vocabularyVersion: string;
  parentResultId?: string;
  sourceSignature?: string;
}

export interface ManifestAnalysisRefs {
  waveform: ManifestWaveformRef | null;
  chordAnalysis: ManifestChordAnalysisRef | null;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function resolveManifestPath(projectDir: string): string {
  return path.join(projectDir, 'manifest.json');
}

function resolveProjectPath(projectDir: string, relativeOrAbsolutePath: string): string {
  return path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(projectDir, relativeOrAbsolutePath);
}

async function readManifestRecord(projectDir: string): Promise<Record<string, unknown> | null> {
  const manifestPath = resolveManifestPath(projectDir);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isObjectLike(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeManifestRecord(projectDir: string, manifest: Record<string, unknown>): Promise<void> {
  const manifestPath = resolveManifestPath(projectDir);
  const tempPath = `${manifestPath}.tmp.${Date.now()}`;
  await fs.promises.writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.promises.rename(tempPath, manifestPath);
}

function readWaveformRef(manifest: Record<string, unknown>): ManifestWaveformRef | null {
  const waveform = manifest.waveform;
  if (!isObjectLike(waveform)) return null;
  if (typeof waveform.path !== 'string' || waveform.path.trim().length === 0) return null;
  if (typeof waveform.version !== 'string' || waveform.version.trim().length === 0) return null;
  const parentResultId =
    typeof waveform.parentResultId === 'string' && waveform.parentResultId.trim().length > 0
      ? waveform.parentResultId.trim()
      : undefined;
  const sourceSignature =
    typeof waveform.sourceSignature === 'string' && waveform.sourceSignature.trim().length > 0
      ? waveform.sourceSignature.trim()
      : undefined;
  return {
    path: waveform.path.trim(),
    version: waveform.version.trim(),
    parentResultId,
    sourceSignature,
  };
}

function readChordRef(manifest: Record<string, unknown>): ManifestChordAnalysisRef | null {
  const chordAnalysis = manifest.chordAnalysis;
  if (!isObjectLike(chordAnalysis)) return null;
  if (typeof chordAnalysis.path !== 'string' || chordAnalysis.path.trim().length === 0) return null;
  if (
    typeof chordAnalysis.analysisVersion !== 'string'
    || chordAnalysis.analysisVersion.trim().length === 0
  ) {
    return null;
  }
  if (
    typeof chordAnalysis.vocabularyVersion !== 'string'
    || chordAnalysis.vocabularyVersion.trim().length === 0
  ) {
    return null;
  }
  const parentResultId =
    typeof chordAnalysis.parentResultId === 'string' && chordAnalysis.parentResultId.trim().length > 0
      ? chordAnalysis.parentResultId.trim()
      : undefined;
  const sourceSignature =
    typeof chordAnalysis.sourceSignature === 'string' && chordAnalysis.sourceSignature.trim().length > 0
      ? chordAnalysis.sourceSignature.trim()
      : undefined;
  return {
    path: chordAnalysis.path.trim(),
    analysisVersion: chordAnalysis.analysisVersion.trim(),
    vocabularyVersion: chordAnalysis.vocabularyVersion.trim(),
    parentResultId,
    sourceSignature,
  };
}

export async function readManifestAnalysisRefs(projectDir: string): Promise<ManifestAnalysisRefs | null> {
  const manifest = await readManifestRecord(projectDir);
  if (!manifest) return null;
  return {
    waveform: readWaveformRef(manifest),
    chordAnalysis: readChordRef(manifest),
  };
}

export async function patchManifestAnalysisRefs(
  projectDir: string,
  patch: {
    waveform?: ManifestWaveformRef | null;
    chordAnalysis?: ManifestChordAnalysisRef | null;
  },
): Promise<boolean> {
  const manifest = await readManifestRecord(projectDir);
  if (!manifest) return false;

  if (patch.waveform !== undefined) {
    manifest.waveform = patch.waveform;
  }
  if (patch.chordAnalysis !== undefined) {
    manifest.chordAnalysis = patch.chordAnalysis;
  }
  manifest.updatedAt = Date.now();

  await writeManifestRecord(projectDir, manifest);
  return true;
}

export async function readProjectJsonRecord(
  projectDir: string,
  relativeOrAbsolutePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const fullPath = resolveProjectPath(projectDir, relativeOrAbsolutePath);
    const raw = await fs.promises.readFile(fullPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isObjectLike(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeProjectJsonRecord(
  projectDir: string,
  relativeOrAbsolutePath: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const fullPath = resolveProjectPath(projectDir, relativeOrAbsolutePath);
  const tempPath = `${fullPath}.tmp.${Date.now()}`;
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
  await fs.promises.rename(tempPath, fullPath);
}
