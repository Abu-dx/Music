import * as fs from 'fs';
import * as path from 'path';

export interface ProjectManifestMetadataPatch {
  displayName?: string;
  lastAccessedAt?: number | null;
  durationMs?: number | null;
  separationElapsedMs?: number | null;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

/**
 * Patch metadata fields in project manifest using atomic write.
 * Returns false if manifest is missing or unreadable.
 */
export async function patchProjectManifestMetadata(
  projectDir: string,
  patch: ProjectManifestMetadataPatch,
): Promise<boolean> {
  const manifestPath = path.join(projectDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return false;

  let parsed: Record<string, unknown>;
  try {
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const json = JSON.parse(raw);
    if (!isObjectLike(json)) return false;
    parsed = json;
  } catch {
    return false;
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
  parsed.updatedAt = Date.now();

  const tempPath = `${manifestPath}.tmp.${Date.now()}`;
  await fs.promises.writeFile(tempPath, JSON.stringify(parsed, null, 2), 'utf-8');
  await fs.promises.rename(tempPath, manifestPath);
  return true;
}
