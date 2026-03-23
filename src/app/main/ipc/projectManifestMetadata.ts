import * as fs from 'fs';
import * as path from 'path';

export interface ProjectManifestMetadataPatch {
  displayName?: string;
  lastAccessedAt?: number | null;
  durationMs?: number | null;
  separationElapsedMs?: number | null;
  activeResultId?: string;
  resultSets?: ProjectManifestResultSetEntry[];
}

export interface ProjectManifestResultSetEntry {
  id: string;
  modelId: string;
  runtimeProfileId: string;
  sourceSignature: string;
  createdAt: number;
}

export class ProjectManifestMetadataPatchError extends Error {
  readonly manifestPath: string;
  readonly reason: string;

  constructor(manifestPath: string, reason: string, cause?: unknown) {
    super(`[manifest:patch] path="${manifestPath}" reason="${reason}"`);
    this.name = 'ProjectManifestMetadataPatchError';
    this.manifestPath = manifestPath;
    this.reason = reason;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export interface ProjectManifestMetadataPatchResult {
  manifestPath: string;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

/**
 * Patch metadata fields in project manifest using atomic write.
 * Throws when manifest is missing/unreadable/invalid to avoid silent failures.
 */
export async function patchProjectManifestMetadata(
  projectDir: string,
  patch: ProjectManifestMetadataPatch,
): Promise<ProjectManifestMetadataPatchResult> {
  const manifestPath = path.join(projectDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new ProjectManifestMetadataPatchError(manifestPath, 'manifest_not_found');
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const json = JSON.parse(raw);
    if (!isObjectLike(json)) {
      throw new ProjectManifestMetadataPatchError(manifestPath, 'manifest_not_object');
    }
    parsed = json;
  } catch (error) {
    if (error instanceof ProjectManifestMetadataPatchError) {
      throw error;
    }
    throw new ProjectManifestMetadataPatchError(manifestPath, 'manifest_read_or_parse_failed', error);
  }

  if (patch.displayName !== undefined) {
    parsed.displayName = patch.displayName;
  }
  if (patch.lastAccessedAt !== undefined) {
    parsed.lastAccessedAt = patch.lastAccessedAt;
  }
  if (patch.durationMs !== undefined) {
    parsed.durationMs = patch.durationMs;
  }
  if (patch.separationElapsedMs !== undefined) {
    parsed.separationElapsedMs = patch.separationElapsedMs;
  }
  if (patch.activeResultId !== undefined) {
    parsed.activeResultId = patch.activeResultId;
  }
  if (patch.resultSets !== undefined) {
    parsed.resultSets = patch.resultSets;
  }
  parsed.updatedAt = Date.now();

  const tempPath = `${manifestPath}.tmp.${Date.now()}`;
  try {
    await fs.promises.writeFile(tempPath, JSON.stringify(parsed, null, 2), 'utf-8');
    await fs.promises.rename(tempPath, manifestPath);
  } catch (error) {
    throw new ProjectManifestMetadataPatchError(manifestPath, 'manifest_write_failed', error);
  }
  return { manifestPath };
}
