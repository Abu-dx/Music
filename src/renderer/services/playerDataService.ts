/**
 * @module renderer/services/playerDataService
 * @description 播放器数据服务 — 播放器域数据获取与受控命令桥接
 *
 * GPT R11 Must Fix #1：消除 playerViewController 中的 (as any).api 穿透访问。
 * GPT R11 Decision #1：不在 IProjectStore 上继续膨胀方法，引入独立 service。
 *
 * ═══════════════════════════════════════════════════════════════
 * 职责边界（GPT R12-Fix MF#6 — 职责收口）：
 *
 * ✅ 允许：
 * - 播放器域的 IPC 数据获取（波形、和弦分析）
 * - 受控命令桥接（openProjectDir → Electron shell.openPath）
 *
 * ❌ 禁止：
 * - 不持有任何状态（无 private field 用于缓存或追踪）
 * - 不做业务编排（如"加载波形后设置到 store"由 controller 驱动）
 * - 不引入 store / controller / 其他 service 依赖
 * - 不负责 UI 状态管理或页面拼装
 *
 * 如果后续新增"合成波形"等计算逻辑，
 * 应引入 WaveformService 或 Application Service，不在本 service 中膨胀。
 * ═══════════════════════════════════════════════════════════════
 *
 * 与 projectStore 的关系：
 * - projectStore 管"项目元数据投影"（生命周期、列表、摘要）
 * - playerDataService 管"播放器域的 IPC 数据获取"（波形、和弦、打开目录）
 * - 两者共享 IProjectElectronAPI，但职责不重叠
 *
 * 依赖：
 * - IProjectElectronAPI（底层 IPC）— 由 composition root 注入
 * - 不依赖任何 store
 */

import type {
  MasterWaveformDTO,
  ChordAnalysisResultDTO,
} from '../../shared/contracts';
import type { IProjectElectronAPI } from '../stores/projectStore';

// ============================================================================
// 1. 接口
// ============================================================================

/**
 * 播放器数据服务接口
 *
 * playerViewController 只依赖此接口，不穿透访问 projectStore 内部。
 * 页面组件不直接使用此 service — 通过 controller 间接调用。
 */
export interface IPlayerDataService {
  /**
   * 获取项目主波形数据
   * @returns MasterWaveformDTO | null（null = 尚未生成）
   */
  getMasterWaveform(projectId: string): Promise<MasterWaveformDTO | null>;

  /**
   * 获取和弦分析结果
   * @returns ChordAnalysisResultDTO | null（null = 尚未分析）
   */
  getChordAnalysis(projectId: string): Promise<ChordAnalysisResultDTO | null>;

  /**
   * 在系统文件管理器中打开项目目录
   *
   * 受控命令，不由页面侧自行拼路径。
   * 底层通过 Electron shell.openPath() 实现。
   *
   * @throws Error 目录不存在或权限不足
   */
  openProjectDir(projectId: string): Promise<void>;
}

// ============================================================================
// 2. 实现
// ============================================================================

export class PlayerDataService implements IPlayerDataService {
  constructor(private readonly api: IProjectElectronAPI) {}

  async getMasterWaveform(projectId: string): Promise<MasterWaveformDTO | null> {
    try {
      return await this.api.getMasterWaveform(projectId);
    } catch {
      return null;
    }
  }

  async getChordAnalysis(projectId: string): Promise<ChordAnalysisResultDTO | null> {
    try {
      return await this.api.getChordAnalysis(projectId);
    } catch {
      return null;
    }
  }

  async openProjectDir(projectId: string): Promise<void> {
    await this.api.openProjectDir(projectId);
  }
}
