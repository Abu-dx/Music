/**
 * @module renderer/services/exportService
 * @description 导出服务 contract — renderer 侧导出命令封装与进度桥接
 *
 * Round 12 创建，收尾修复轮定稿。
 *
 * ═══════════════════════════════════════════════════════════════
 * 职责边界（GPT R12-Fix MF#6 — 职责收口）：
 *
 * ✅ 允许：
 * - 封装导出 IPC 命令（exportStems / cancelExport）
 * - 桥接导出进度回调（onProgress）
 * - 桥接目录选择器（selectOutputDir）
 *
 * ❌ 禁止：
 * - 不持有任何状态（exportBusy / exportError 等由页面组件管理）
 * - 不做业务编排（如"导出完成后刷新列表"由页面/controller 驱动）
 * - 不负责页面状态管理或结果页 UI 拼装
 * - 不引入新依赖（如 store / controller / 其他 service）
 *
 * 如果后续新增"导出后自动打开目录"等编排逻辑，
 * 应引入 ExportController 或 Application Service，不在本 service 中膨胀。
 * ═══════════════════════════════════════════════════════════════
 *
 * 批处理 contract（GPT R12-Fix MF#2）：
 * - 单轨导出与全部导出共用 ExportRequestDTO（stemIds 数量区分）
 * - 批量结果通过 ExportBatchResultDTO 返回 succeeded/failed/skipped/cancelled 分类
 * - 导出过程中通过 onProgress 推送进度事件
 * - 用户可通过 cancelExport() 取消正在进行的导出
 * - 取消后已完成文件保留，未开始文件标记 cancelled
 * - 失败项根据 ExportErrorDTO.retryable 判断是否可重试
 *
 * 数据流：
 *   ResultPage/PlayerPage → IExportService.exportStems() → main 进程
 *   main 进程 → IExportService.onProgress() → UI 进度展示
 *   ResultPage/PlayerPage → IExportService.cancelExport() → main 进程中断
 */

import type {
  ExportRequestDTO,
  ExportBatchResultDTO,
  ExportProgressDTO,
} from '../../shared/contracts';

// ============================================================================
// 1. IPC 接口（exportService 需要的 main 进程 API 子集）
// ============================================================================

export interface IExportElectronAPI {
  /** 发起批量导出 */
  exportStems(request: ExportRequestDTO): Promise<ExportBatchResultDTO>;

  /** 选择导出目标目录（返回路径或 null = 用户取消） */
  selectExportDir(): Promise<string | null>;

  /** 注册导出进度回调 */
  onExportProgress(callback: (progress: ExportProgressDTO) => void): () => void;

  /**
   * 取消正在进行的导出（GPT R12-Fix MF#2）
   *
   * 取消语义：
   * - 已完成的文件保留在 outputDir
   * - 正在进行的单轨不中断，等其完成
   * - 后续未开始的轨道标记 status = 'cancelled'
   * - exportStems() 的 Promise 正常 resolve（非 reject），
   *   返回的 ExportBatchResultDTO.cancelled = true
   */
  cancelExport(projectId: string): Promise<void>;
}

// ============================================================================
// 2. 服务接口
// ============================================================================

export interface IExportService {
  /**
   * 选择导出目录
   * @returns 用户选择的路径，null 表示取消
   */
  selectOutputDir(): Promise<string | null>;

  /**
   * 批量导出轨道
   *
   * @param request 导出请求（项目 ID + 轨道列表 + 格式 + 目标目录）
   * @returns 批量导出结果（含 succeeded/failed/skipped/cancelled 分类）
   */
  exportStems(request: ExportRequestDTO): Promise<ExportBatchResultDTO>;

  /**
   * 取消正在进行的导出（GPT R12-Fix MF#2）
   */
  cancelExport(projectId: string): Promise<void>;

  /**
   * 注册导出进度监听
   * @returns 取消订阅函数
   */
  onProgress(callback: (progress: ExportProgressDTO) => void): () => void;
}

// ============================================================================
// 3. 实现
// ============================================================================

export class ExportService implements IExportService {
  constructor(private readonly api: IExportElectronAPI) {}

  async selectOutputDir(): Promise<string | null> {
    return this.api.selectExportDir();
  }

  async exportStems(request: ExportRequestDTO): Promise<ExportBatchResultDTO> {
    return this.api.exportStems(request);
  }

  async cancelExport(projectId: string): Promise<void> {
    return this.api.cancelExport(projectId);
  }

  onProgress(callback: (progress: ExportProgressDTO) => void): () => void {
    return this.api.onExportProgress(callback);
  }
}
