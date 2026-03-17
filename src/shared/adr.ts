/**
 * @module shared/adr
 * @description 架构决策记录（Architecture Decision Records）
 *
 * 本文件记录项目级不可回退的架构约束，来源于：
 * - 规格文档 v3 的强制规范
 * - Round-0 架构审查结论
 * - GPT Round-0 Fix Package 的 Must Fix 要求
 *
 * 规则：
 * 1. 这些决策一旦写入，后续任何轮次不得悄悄改掉
 * 2. 如需变更必须显式提出 [DECISION_NEEDED] 并经用户拍板
 * 3. 每轮 Review 时 GPT 可对照本文件检查是否有违反
 */

// ============================================================================
// ADR 条目定义
// ============================================================================

/**
 * ADR 条目结构
 *
 * GPT Suggested #1: 增加 status / supersedes / consequences 字段，
 * 支持架构演进时显式标记 replaced/active/deprecated。
 */
export interface ADREntry {
  /** ADR 编号 */
  readonly id: string;
  /** 决策标题 */
  readonly title: string;
  /** 决策内容 */
  readonly decision: string;
  /** 决策理由 */
  readonly rationale: string;
  /** 来源（规格文档章节 / GPT Fix 编号） */
  readonly source: string;
  /** 决策日期 */
  readonly decidedAt: string;
  /** 是否可回退 */
  readonly reversible: boolean;
  /** 当前状态：active | deprecated | replaced */
  readonly status: ADRStatus;
  /** 若被替代，指向替代此 ADR 的新 ADR ID */
  readonly supersededBy?: string;
  /** 此决策产生的后果与约束 */
  readonly consequences: readonly string[];
}

/** ADR 状态 */
export enum ADRStatus {
  Active = 'active',
  Deprecated = 'deprecated',
  Replaced = 'replaced',
}

// ============================================================================
// 架构决策记录（含 Round-1 Fix ADR-009/010/011，Round-2 Fix ADR-012）
// ============================================================================

export const ARCHITECTURE_DECISIONS: readonly ADREntry[] = [
  {
    id: 'ADR-001',
    title: 'Electron 为当前唯一开发基线',
    decision:
      '后续所有实现回合统一以 Electron + React + TypeScript + Node main + Python Worker 为唯一当前开发基线。' +
      'Tauri 仅保留在文档中的历史备选说明，不再进入代码、目录设计或 IPC 协议设计。',
    rationale:
      '规格文档 §23 已将 Electron 方案写为首选。消除双方案摇摆，避免目录、进程模型、IPC、打包链路的不确定性。',
    source: '规格文档 §12/§23, GPT R0 Must Fix #1, GPT R0 Blocking Risk #1',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: ['所有目录、IPC、打包链路按 Electron 设计', 'Tauri 不进入代码'],
  },
  {
    id: 'ADR-002',
    title: 'Main Process 阻塞硬规则',
    decision:
      'Electron main process 只允许执行短时、可预测的小事务（<50ms）。' +
      '大批量查询、批量删除、索引重建、缓存扫描、指纹批计算等必须后台化。',
    rationale:
      'better-sqlite3 同步 API 在大批量操作时阻塞 main process。规格文档 §24.4 要求 UI 主线程流畅。',
    source: '规格文档 §24.4, GPT R0 Must Fix #2',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: ['Repository 长操作必须返回 Promise 并可委托 worker_threads', 'IPC handler 禁止同步大查询'],
  },
  {
    id: 'ADR-003',
    title: 'Renderer / Store / Service / Worker 边界禁止项',
    decision:
      '① Renderer 禁止直接访问 SQLite、FS、Worker。② Store 禁止直接调第三方引擎或 Python Worker。' +
      '③ 只有 Application Service 发起用例编排。④ Worker adapter 只接受纯 DTO，不感知 UI 状态。',
    rationale: '规格文档 §26.2 文件边界规则。',
    source: '规格文档 §26.2, GPT R0 Must Fix #3',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: ['Renderer 只通过 IPC + DTO 与 main 通信', 'Store action 只调 Application Service'],
  },
  {
    id: 'ADR-004',
    title: '四类 Store 所有权严格隔离',
    decision:
      'projectStore/jobStore/playbackStore/analysisStore 各自只持有其领域状态。' +
      '禁止一个 action 同时直接改写多套底层状态，跨域变更必须经 Application Service 编排。',
    rationale: '规格文档 §12/§24.3 警告混合 store 导致分支爆炸。',
    source: '规格文档 §12/§24.3, GPT R0 Must Fix #4',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: ['每个 store 有独立 action 集', '跨 store 变更走 Application Service + correlationId'],
  },
  {
    id: 'ADR-005',
    title: '统一项目事实模型',
    decision:
      '自动分离与手动导入使用同一 Project 实体。都必须生成指纹、manifest、SQLite 索引。',
    rationale: '规格文档 §22.7；否则缓存复用、播放器、导出一致性全部破坏。',
    source: '规格文档 §22.7, GPT R0 Must Fix #5, GPT R0 Blocking Risk #3',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: ['不允许"两套项目体系"', 'manual_import 也走 Project + manifest 全流程'],
  },
  {
    id: 'ADR-006',
    title: 'Chord Analysis 不阻塞主链路',
    decision:
      'Chord 不是分离成功前置条件。Chord 失败只记日志，不把项目从 ready 拉回 failed。' +
      'analysisVersion/vocabularyVersion 独立校验。',
    rationale: '规格文档 §22.7/§22.8。和弦是增强分析，不是首版主链路承诺。',
    source: '规格文档 §22.7/§22.8, GPT R0 Must Fix #6',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: ['和弦分析单独子任务', '和弦缓存版本独立于 stem 缓存'],
  },
  {
    id: 'ADR-007',
    title: '模块命名约定：CacheService vs CacheManagement',
    decision:
      'CacheService 负责运行期缓存逻辑。CacheManagementUseCase 仅表示页面/用例层。',
    rationale: '避免命名混淆与职责漂移。',
    source: 'GPT R0 Must Fix #7',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: ['核心模块列表不并列两个相似抽象'],
  },
  {
    id: 'ADR-008',
    title: 'DI 边界：Application / Domain 不直接 new 基础设施',
    decision:
      '统一由 composition root 装配注入 FS、DB、Logger、WorkerClient、AudioEngineAdapter。' +
      'Python Worker 为唯一重计算执行体。首版单任务串行队列。',
    rationale: '规格文档 §25.6 DI 要求。',
    source: '规格文档 §25.6, GPT R0 Suggested #5',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: ['所有 Service/Repository 构造函数接受接口参数', '测试可 mock'],
  },
  // --- Round 1 Fix 新增 ---
  {
    id: 'ADR-009',
    title: 'better-sqlite3 导入边界',
    decision:
      'better-sqlite3 只能在 infrastructure/db/ 中被直接 import。' +
      'Node fs/path/child_process 等系统 API 只能出现在 app/main/ 或 infrastructure/*。' +
      'renderer/shared/contracts/domain 不允许直接依赖这些包。',
    rationale:
      'GPT Round-1 Must Fix #5。规格文档 §26.2 要求 UI 页面不能直连 SQLite/FS/Worker。' +
      '已把依赖加进工程，现在不封边界后续会越层。',
    source: 'GPT R1 Must Fix #5, 规格文档 §26.2',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: [
      'domain/entities.ts 不 import 任何 Node.js 模块',
      'shared/ 不 import better-sqlite3/fs/path/child_process',
      'renderer/ 不 import better-sqlite3/fs/path/child_process',
    ],
  },
  {
    id: 'ADR-010',
    title: 'Manifest 为项目级事实来源，SQLite 为全局索引',
    decision:
      '当 manifest 与 SQLite 数据冲突时，以 manifest 为准触发 SQLite 索引重建。' +
      'manifest 记录 stems/waveform/chordAnalysis 的存在性与版本；SQLite 做全局查询与排序。',
    rationale: '规格文档 §11 明确要求。GPT Suggested #4 要求在类型注释中写清字段职责。',
    source: '规格文档 §11, GPT R1 Suggested #4',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: [
      'domain/entities.ts 中每个字段标注数据归属',
      'CacheService 的 validateProject 必须对比 manifest 与 SQLite',
    ],
  },
  {
    id: 'ADR-011',
    title: 'Worker 响应强制 Schema 校验',
    decision:
      '所有 Worker response/event 在进入 application 层前必须经 schema 校验。' +
      '校验失败产生 WORKER_RESPONSE_SCHEMA_INVALID 错误，不静默接受。',
    rationale: '规格文档 §25.5 要求对 Worker 返回值做 schema 校验。GPT R1 Must Fix #6。',
    source: '规格文档 §25.5, GPT R1 Must Fix #6',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: [
      'shared/contracts.ts 提供 ValidatedWorkerResponse<T> 类型',
      'infrastructure/worker 层必须在 adapter 中实现校验',
    ],
  },
  // --- Round 2 Fix 新增 ---
  {
    id: 'ADR-012',
    title: '和弦分析结果 JSON 必须带版本头',
    decision:
      '所有和弦分析结果 JSON 文件必须包含 header 字段：' +
      'analysisVersion, vocabularyVersion, analyzerType, generatedAt, segmentCount。' +
      '读取时必须校验 header，版本不兼容标记为过期，不静默使用。' +
      '写入时必须校验 header 完整性，缺失字段拒绝写入。',
    rationale:
      'GPT Round-2 Must Fix #5。和弦结果 JSON 如果没有版本头，' +
      '无法判断缓存是否过期，导致不同版本分析器的结果混用。',
    source: 'GPT R2 Must Fix #5, 规格文档 §22.7/§22.8',
    decidedAt: '2026-03-16',
    reversible: false,
    status: ADRStatus.Active,
    consequences: [
      'domain/policies.ts 定义 ChordResultJsonHeader 和 validateChordJsonHeader()',
      'ManifestManager 读写和弦 JSON 时强制校验 header',
      '版本不兼容的和弦结果不会被加载',
    ],
  },
] as const;

/**
 * 快速查询 ADR
 */
export function getADR(id: string): ADREntry | undefined {
  return ARCHITECTURE_DECISIONS.find(adr => adr.id === id);
}

/**
 * 打印所有 ADR 摘要（调试用）
 */
export function printADRSummary(): string {
  return ARCHITECTURE_DECISIONS
    .map(adr => `${adr.id}: ${adr.title}`)
    .join('\n');
}
