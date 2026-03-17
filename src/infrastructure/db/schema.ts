/**
 * @module infrastructure/db/schema
 * @description SQLite 数据库 Schema 定义与迁移框架
 *
 * Why: 规格文档 §10/§11 要求 SQLite 做全局索引，manifest 做项目级事实来源。
 *      本文件定义 DDL 和迁移机制。
 *
 * 导入边界（ADR-009）：
 * - better-sqlite3 只能在 infrastructure/db/ 中被直接 import
 * - 本文件定义的是纯字符串 DDL + 迁移逻辑接口
 * - 实际的 better-sqlite3 Database 实例由 composition root 创建并注入
 *
 * 阻塞约束（ADR-002）：
 * - 建表和迁移在应用启动时执行（一次性短操作，可接受同步）
 * - 运行期的大批量查询/删除必须后台化
 */

// ============================================================================
// 1. 当前 Schema 版本
// ============================================================================

export const CURRENT_SCHEMA_VERSION = 1;

// ============================================================================
// 2. DDL 语句
// ============================================================================

/**
 * V1 建表语句
 *
 * 表设计对齐 domain/entities.ts 中的实体定义：
 * - projects: Project 的全局索引
 * - stem_files: StemFile 的按项目查询索引
 * - parse_jobs: ParseJob 的任务记录
 * - waveform_data: WaveformData 引用
 * - chord_analysis_results: ChordAnalysisResult 摘要（segments 存 JSON 文件）
 * - playback_presets: PlaybackPreset 可选持久化
 * - app_settings: 应用全局设置（单行）
 * - schema_migrations: 迁移版本追踪
 * - state_transitions: 状态变更审计日志
 */
export const SCHEMA_V1_DDL: readonly string[] = [
  // --- 迁移追踪 ---
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT
  )`,

  // --- 项目 ---
  `CREATE TABLE IF NOT EXISTS projects (
    id                TEXT PRIMARY KEY,
    fingerprint       TEXT NOT NULL,
    source_type       TEXT NOT NULL CHECK(source_type IN ('separation','manual_import','cache_hit')),
    display_name      TEXT NOT NULL,
    original_file_path TEXT,
    cache_dir         TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    duration_ms       INTEGER,
    sample_rate       INTEGER,
    channels          INTEGER,
    total_size_bytes  INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'draft',
    schema_version    TEXT NOT NULL,
    engine_version    TEXT,
    cache_status      TEXT NOT NULL DEFAULT 'active'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_fingerprint ON projects(fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_cache_status ON projects(cache_status)`,

  // --- 轨道文件 ---
  // GPT R2 Suggested #2: 同一项目内不允许出现重复 stem_type
  `CREATE TABLE IF NOT EXISTS stem_files (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    stem_type       TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    codec           TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER,
    sample_rate     INTEGER,
    exists_on_disk  INTEGER NOT NULL DEFAULT 1,
    source_origin   TEXT NOT NULL CHECK(source_origin IN ('engine_output','manual_import')),
    confidence      REAL,
    exportable      INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'detected',
    UNIQUE(project_id, stem_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stems_project ON stem_files(project_id)`,

  // --- 解析任务 ---
  `CREATE TABLE IF NOT EXISTS parse_jobs (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    stage           TEXT NOT NULL DEFAULT 'INIT',
    progress        INTEGER NOT NULL DEFAULT 0,
    started_at      INTEGER,
    finished_at     INTEGER,
    elapsed_ms      INTEGER,
    error_code      TEXT,
    error_message   TEXT,
    engine_version  TEXT,
    cancelled_by_user INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_project ON parse_jobs(project_id)`,

  // --- 波形数据 ---
  `CREATE TABLE IF NOT EXISTS waveform_data (
    project_id      TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    waveform_path   TEXT NOT NULL,
    peaks_path      TEXT,
    version         TEXT NOT NULL,
    generated_at    INTEGER NOT NULL
  )`,

  // --- 和弦分析结果摘要 ---
  // segments 以 JSON 文件单独存储（ADR-012 要求 JSON 必须带版本头）
  // result_file_path 记录 JSON 文件相对路径
  `CREATE TABLE IF NOT EXISTS chord_analysis_results (
    project_id          TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    analysis_version    TEXT NOT NULL,
    analyzer_type       TEXT NOT NULL,
    vocabulary_version  TEXT NOT NULL,
    analysis_source     TEXT NOT NULL,
    elapsed_ms          INTEGER NOT NULL,
    generated_at        INTEGER NOT NULL,
    segment_count       INTEGER NOT NULL DEFAULT 0,
    result_file_path    TEXT NOT NULL,
    warnings            TEXT
  )`,

  // --- 播放预设 ---
  `CREATE TABLE IF NOT EXISTS playback_presets (
    project_id      TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    master_volume   REAL NOT NULL DEFAULT 1.0,
    speed           REAL NOT NULL DEFAULT 1.0,
    per_stem_volume TEXT NOT NULL DEFAULT '{}',
    mute_state      TEXT NOT NULL DEFAULT '{}',
    solo_state      TEXT NOT NULL DEFAULT '{}',
    last_position_ms INTEGER NOT NULL DEFAULT 0
  )`,

  // --- 应用设置（单行） ---
  `CREATE TABLE IF NOT EXISTS app_settings (
    id                    INTEGER PRIMARY KEY CHECK(id = 1),
    cache_root            TEXT NOT NULL,
    default_export_format TEXT NOT NULL DEFAULT 'wav',
    max_parallel_jobs     INTEGER NOT NULL DEFAULT 1,
    auto_open_last_project INTEGER NOT NULL DEFAULT 0,
    log_level             TEXT NOT NULL DEFAULT 'info'
  )`,

  // --- 状态变更审计日志（Must Fix #2） ---
  `CREATE TABLE IF NOT EXISTS state_transitions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    action          TEXT NOT NULL,
    from_status     TEXT,
    to_status       TEXT NOT NULL,
    timestamp       INTEGER NOT NULL,
    correlation_id  TEXT NOT NULL,
    metadata        TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_transitions_entity ON state_transitions(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_transitions_correlation ON state_transitions(correlation_id)`,
];

// ============================================================================
// 3. 迁移框架
// ============================================================================

/**
 * 迁移条目
 *
 * Why: 规格文档 §11 要求 manifest 中记录 schemaVersion，
 *      版本变化时允许触发重新解析。
 *      迁移框架确保 schema 演进可控。
 */
export interface MigrationEntry {
  /** 版本号（递增整数） */
  version: number;
  /** 迁移描述 */
  description: string;
  /** SQL 语句列表 */
  statements: readonly string[];
}

/**
 * 迁移注册表
 *
 * 后续版本在此追加 MigrationEntry。
 * 迁移执行器在 Round 3/4 实现，这里只定义结构。
 */
export const MIGRATIONS: readonly MigrationEntry[] = [
  {
    version: 1,
    description: 'Initial schema: projects, stems, jobs, waveform, chord, presets, settings, state_transitions',
    statements: SCHEMA_V1_DDL,
  },
];

// ============================================================================
// 4. 默认设置
// ============================================================================

/**
 * 初始化 app_settings 的默认数据
 *
 * Why: 应用首次启动时需要一条默认设置记录。
 *      cacheRoot 使用占位符，由 composition root 在运行时替换为实际路径。
 */
export const DEFAULT_APP_SETTINGS_SQL = `
  INSERT OR IGNORE INTO app_settings (id, cache_root, default_export_format, max_parallel_jobs, auto_open_last_project, log_level)
  VALUES (1, ':DEFAULT_CACHE_ROOT:', 'wav', 1, 0, 'info')
`;

// ============================================================================
// 5. 迁移执行器接口（DI 友好）
// ============================================================================

/**
 * 数据库迁移执行器接口
 *
 * Why: ADR-008 要求 Domain/Application 不直接 new 基础设施实现。
 *      具体的 better-sqlite3 迁移执行在 infrastructure/db/ 中实现。
 *
 * ADR-009: better-sqlite3 只能在 infrastructure/db/ 中被 import。
 */
export interface IDatabaseMigrator {
  /** 获取当前数据库 schema 版本 */
  getCurrentVersion(): number;

  /**
   * 执行所有未应用的迁移
   *
   * @returns 应用的迁移版本列表
   * @throws AppError(DB_MIGRATION_FAILED) 如果迁移失败
   */
  migrateToLatest(): number[];

  /**
   * 迁移到指定版本
   *
   * @returns 应用的迁移版本列表
   */
  migrateTo(targetVersion: number): number[];
}
