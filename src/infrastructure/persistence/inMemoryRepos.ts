/**
 * @module infrastructure/persistence/inMemoryRepos
 * @description Phase 2 In-Memory Repository Stubs
 *
 * Phase 2 MVP: ParseJobService 需要 4 个 Repository 接口的实现，
 * 但 Phase 2 明确不做 SQLite 持久化。
 *
 * 本文件提供 Map-based 内存实现，只实现 ParseJobService + handlers.ts
 * 实际调用的方法。未实现的方法 throw Error，防止误调用。
 *
 * Phase 3 替换路径：
 * - 实现 SQLite-based Repository（infrastructure/db/）
 * - 在 workerSetup.ts 中替换 import 即可
 * - 接口契约不变，上层无感知
 *
 * 已知限制：
 * - 进程重启后数据丢失
 * - 无事务、无索引、无并发保护
 * - 分页查询为全量内存过滤（Phase 2 项目数极少，可接受）
 */

import { Project, StemFile, ParseJob } from '../../domain/entities';
import {
  IProjectRepository,
  IStemFileRepository,
  IParseJobRepository,
  IStateTransitionRepository,
  PaginationParams,
  PaginatedResult,
  DEFAULT_PAGINATION,
} from '../../domain/repositories';
import {
  ProjectStatus,
  JobStatus,
  CacheEntryStatus,
} from '../../shared/enums';
import { StateTransitionRecord } from '../../shared/contracts';

// ============================================================================
// Helper
// ============================================================================

function notImplemented(method: string): never {
  throw new Error(`[Phase2 InMemoryRepo] ${method} is not implemented. Will be available in Phase 3 (SQLite).`);
}

function paginate<T>(items: T[], pagination?: PaginationParams): PaginatedResult<T> {
  const { limit, offset } = pagination ?? DEFAULT_PAGINATION;
  const sliced = items.slice(offset, offset + limit);
  return {
    items: sliced,
    total: items.length,
    hasMore: offset + limit < items.length,
  };
}

// ============================================================================
// 1. InMemoryProjectRepository
// ============================================================================

export class InMemoryProjectRepository implements IProjectRepository {
  private readonly store = new Map<string, Project>();

  async create(project: Project): Promise<void> {
    this.store.set(project.id, { ...project });
  }

  async findById(id: string): Promise<Project | null> {
    const p = this.store.get(id);
    return p ? { ...p } : null;
  }

  async updateStatus(id: string, status: ProjectStatus): Promise<void> {
    const p = this.store.get(id);
    if (!p) {
      throw new Error(`[InMemoryProjectRepo] Project not found: ${id}`);
    }
    p.status = status;
    p.updatedAt = Date.now();
  }

  async update(id: string, fields: Partial<Omit<Project, 'id'>>): Promise<void> {
    const p = this.store.get(id);
    if (!p) {
      throw new Error(`[InMemoryProjectRepo] Project not found: ${id}`);
    }
    Object.assign(p, fields, { updatedAt: Date.now() });
  }

  async listRecent(pagination?: PaginationParams): Promise<PaginatedResult<Project>> {
    const sorted = Array.from(this.store.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return paginate(sorted, pagination);
  }

  // --- Not needed in Phase 2 ---

  async findByFingerprint(_fingerprint: string): Promise<Project | null> {
    notImplemented('findByFingerprint');
  }

  async listByCacheStatus(
    _status: CacheEntryStatus,
    _pagination?: PaginationParams,
  ): Promise<PaginatedResult<Project>> {
    notImplemented('listByCacheStatus');
  }

  async delete(_id: string): Promise<void> {
    // Used by cache:clearProject — provide minimal implementation
    this.store.delete(_id);
  }

  async getTotalSize(): Promise<number> {
    let total = 0;
    for (const p of this.store.values()) {
      total += p.totalSizeBytes;
    }
    return total;
  }

  async countByCacheStatus(_status: CacheEntryStatus): Promise<number> {
    notImplemented('countByCacheStatus');
  }

  async sumSizeByStatus(_status: CacheEntryStatus): Promise<number> {
    notImplemented('sumSizeByStatus');
  }
}

// ============================================================================
// 2. InMemoryStemFileRepository
// ============================================================================

export class InMemoryStemFileRepository implements IStemFileRepository {
  /** projectId -> StemFile[] */
  private readonly store = new Map<string, StemFile[]>();

  async createMany(stems: StemFile[]): Promise<void> {
    if (stems.length === 0) return;
    const projectId = stems[0].projectId;
    console.log(`[REAL_CHAIN] inMemoryStemFileRepo.createMany projectId="${projectId}" count=${stems.length}`);
    const existing = this.store.get(projectId) ?? [];
    existing.push(...stems.map(s => ({ ...s })));
    this.store.set(projectId, existing);
  }

  async findByProjectId(projectId: string): Promise<StemFile[]> {
    const stems = this.store.get(projectId);
    console.log(`[REAL_CHAIN] inMemoryStemFileRepo.findByProjectId projectId="${projectId}" returnedCount=${stems ? stems.length : 0}`);
    return stems ? stems.map(s => ({ ...s })) : [];
  }

  async findById(id: string): Promise<StemFile | null> {
    for (const stems of this.store.values()) {
      const found = stems.find(s => s.id === id);
      if (found) return { ...found };
    }
    return null;
  }

  async update(_id: string, _fields: Partial<Omit<StemFile, 'id'>>): Promise<void> {
    notImplemented('update');
  }

  async deleteByProjectId(projectId: string): Promise<void> {
    this.store.delete(projectId);
  }
}

// ============================================================================
// 3. InMemoryParseJobRepository
// ============================================================================

export class InMemoryParseJobRepository implements IParseJobRepository {
  private readonly store = new Map<string, ParseJob>();

  async create(job: ParseJob): Promise<void> {
    this.store.set(job.id, { ...job });
  }

  async findById(id: string): Promise<ParseJob | null> {
    const j = this.store.get(id);
    return j ? { ...j } : null;
  }

  async findLatestByProjectId(projectId: string): Promise<ParseJob | null> {
    let latest: ParseJob | null = null;
    for (const job of this.store.values()) {
      if (job.projectId === projectId) {
        if (!latest || (job.startedAt ?? 0) > (latest.startedAt ?? 0)) {
          latest = job;
        }
      }
    }
    return latest ? { ...latest } : null;
  }

  async updateProgress(id: string, stage: string, progress: number): Promise<void> {
    const j = this.store.get(id);
    if (!j) {
      throw new Error(`[InMemoryParseJobRepo] Job not found: ${id}`);
    }
    // stage is stored as JobStage enum string
    (j as unknown as Record<string, unknown>).stage = stage;
    j.progress = progress;
    if (j.startedAt === null) {
      (j as unknown as Record<string, unknown>).startedAt = Date.now();
    }
  }

  async updateStatus(
    id: string,
    status: JobStatus,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    const j = this.store.get(id);
    if (!j) {
      throw new Error(`[InMemoryParseJobRepo] Job not found: ${id}`);
    }
    (j as unknown as Record<string, unknown>).status = status;
    if (errorCode !== undefined) {
      (j as unknown as Record<string, unknown>).errorCode = errorCode;
    }
    if (errorMessage !== undefined) {
      (j as unknown as Record<string, unknown>).errorMessage = errorMessage;
    }
  }

  async complete(id: string, status: JobStatus, elapsedMs: number): Promise<void> {
    const j = this.store.get(id);
    if (!j) {
      throw new Error(`[InMemoryParseJobRepo] Job not found: ${id}`);
    }
    (j as unknown as Record<string, unknown>).status = status;
    (j as unknown as Record<string, unknown>).finishedAt = Date.now();
    (j as unknown as Record<string, unknown>).elapsedMs = elapsedMs;
  }

  async listByProjectId(
    projectId: string,
    pagination?: PaginationParams,
  ): Promise<PaginatedResult<ParseJob>> {
    const jobs = Array.from(this.store.values())
      .filter(j => j.projectId === projectId)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return paginate(jobs, pagination);
  }
}

// ============================================================================
// 4. InMemoryStateTransitionRepository
// ============================================================================

export class InMemoryStateTransitionRepository implements IStateTransitionRepository {
  private readonly records: StateTransitionRecord[] = [];

  async record(transition: StateTransitionRecord): Promise<void> {
    this.records.push({ ...transition });
  }

  async listByEntity(
    _entityType: string,
    _entityId: string,
    _pagination?: PaginationParams,
  ): Promise<PaginatedResult<StateTransitionRecord>> {
    notImplemented('listByEntity');
  }

  async listByCorrelationId(_correlationId: string): Promise<StateTransitionRecord[]> {
    notImplemented('listByCorrelationId');
  }

  async purge(_beforeTimestamp: number): Promise<number> {
    notImplemented('purge');
  }
}
