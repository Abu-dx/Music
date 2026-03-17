/**
 * @module domain/stateMachines
 * @description 领域状态机 — 合法转移规则与校验
 *
 * Why: GPT Round-2 Must Fix #1 要求把状态机从 entities.ts 拆出，
 *      entities.ts 专注于数据结构，stateMachines.ts 专注于状态转移规则。
 *
 * 使用规则：
 * - Application Service 在执行状态变更前必须调用 assertXxxTransition()
 * - 非法转移抛出 AppError(INVALID_STATE_TRANSITION)
 * - 终态的 allowed transitions 为空数组
 *
 * 本文件不依赖 Node.js / Electron / 文件系统 API（ADR-009）。
 */

import { ProjectStatus, JobStatus, PlaybackStatus } from '../shared/enums';
import { AppError, ErrorCode } from '../shared/errors';

// ============================================================================
// 1. 项目状态机（规格文档 §9）
// ============================================================================

/**
 * 项目状态合法转移表
 *
 * draft -> scanning -> cache_hit | ready_to_parse | importing -> processing -> ready
 *                                                              -> failed | cancelled
 * failed / cancelled -> ready_to_parse | draft (允许重试)
 */
export const PROJECT_STATUS_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> = {
  [ProjectStatus.Draft]: [ProjectStatus.Scanning],
  [ProjectStatus.Scanning]: [ProjectStatus.CacheHit, ProjectStatus.ReadyToParse, ProjectStatus.Importing, ProjectStatus.Failed],
  [ProjectStatus.CacheHit]: [ProjectStatus.Ready, ProjectStatus.Failed],
  [ProjectStatus.ReadyToParse]: [ProjectStatus.Processing, ProjectStatus.Cancelled],
  [ProjectStatus.Importing]: [ProjectStatus.Ready, ProjectStatus.Failed, ProjectStatus.Cancelled],
  [ProjectStatus.Processing]: [ProjectStatus.Ready, ProjectStatus.Failed, ProjectStatus.Cancelled],
  [ProjectStatus.Ready]: [], // 终态
  [ProjectStatus.Failed]: [ProjectStatus.ReadyToParse, ProjectStatus.Draft], // 允许重试
  [ProjectStatus.Cancelled]: [ProjectStatus.ReadyToParse, ProjectStatus.Draft], // 允许重试
};

// ============================================================================
// 2. 任务状态机（规格文档 §9）
// ============================================================================

/**
 * 任务状态合法转移表
 *
 * pending -> running -> success | failed | cancelled
 */
export const JOB_STATUS_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  [JobStatus.Pending]: [JobStatus.Running, JobStatus.Cancelled],
  [JobStatus.Running]: [JobStatus.Success, JobStatus.Failed, JobStatus.Cancelled],
  [JobStatus.Success]: [], // 终态
  [JobStatus.Failed]: [], // 终态
  [JobStatus.Cancelled]: [], // 终态
};

// ============================================================================
// 3. 播放器状态机（规格文档 §9）
// ============================================================================

/**
 * 播放器状态合法转移表（规格文档 §9 直出）
 *
 * idle -> loading -> playing <-> paused -> ended
 *                 -> error -> idle
 *
 * 设计说明（GPT R3 Decision #1）：
 * - Ended → Playing 不是自然转移，循环播放/重播应通过
 *   Ended → Loading → Playing 路径，由 replay/loop 命令触发。
 * - 此转移表仅包含规格文档定义的状态集合。
 * - Round 9/10 实现播放器时，若需增加便捷转移，
 *   必须显式标注为"工程扩展"并经 [DECISION_NEEDED] 确认。
 */
export const PLAYBACK_STATUS_TRANSITIONS: Readonly<Record<PlaybackStatus, readonly PlaybackStatus[]>> = {
  [PlaybackStatus.Idle]: [PlaybackStatus.Loading],
  [PlaybackStatus.Loading]: [PlaybackStatus.Playing, PlaybackStatus.Error],
  [PlaybackStatus.Playing]: [PlaybackStatus.Paused, PlaybackStatus.Ended, PlaybackStatus.Error],
  [PlaybackStatus.Paused]: [PlaybackStatus.Playing, PlaybackStatus.Idle, PlaybackStatus.Loading],
  [PlaybackStatus.Ended]: [PlaybackStatus.Idle, PlaybackStatus.Loading], // 不含直接→Playing，需走 Loading
  [PlaybackStatus.Error]: [PlaybackStatus.Idle],
};

// ============================================================================
// 4. 校验函数（纯查询 + 断言两种风格）
// ============================================================================

/** 判断 Project 状态转移是否合法 */
export function isValidProjectTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 判断 Job 状态转移是否合法 */
export function isValidJobTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 判断 Playback 状态转移是否合法 */
export function isValidPlaybackTransition(from: PlaybackStatus, to: PlaybackStatus): boolean {
  return PLAYBACK_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 断言 Project 状态转移合法，否则抛出 AppError
 *
 * @throws AppError(INVALID_STATE_TRANSITION)
 */
export function assertProjectTransition(
  projectId: string,
  from: ProjectStatus,
  to: ProjectStatus,
): void {
  if (!isValidProjectTransition(from, to)) {
    throw new AppError({
      code: ErrorCode.INVALID_STATE_TRANSITION,
      message: `Invalid project transition: ${from} -> ${to}`,
      userMessage: '项目状态变更失败，请重试或联系支持',
      context: { projectId, from, to },
      retryable: false,
    });
  }
}

/**
 * 断言 Job 状态转移合法，否则抛出 AppError
 *
 * @throws AppError(INVALID_STATE_TRANSITION)
 */
export function assertJobTransition(
  jobId: string,
  from: JobStatus,
  to: JobStatus,
): void {
  if (!isValidJobTransition(from, to)) {
    throw new AppError({
      code: ErrorCode.INVALID_STATE_TRANSITION,
      message: `Invalid job transition: ${from} -> ${to}`,
      userMessage: '任务状态变更失败',
      context: { jobId, from, to },
      retryable: false,
    });
  }
}

/**
 * 断言 Playback 状态转移合法，否则抛出 AppError
 *
 * @throws AppError(INVALID_STATE_TRANSITION)
 */
export function assertPlaybackTransition(
  from: PlaybackStatus,
  to: PlaybackStatus,
): void {
  if (!isValidPlaybackTransition(from, to)) {
    throw new AppError({
      code: ErrorCode.INVALID_STATE_TRANSITION,
      message: `Invalid playback transition: ${from} -> ${to}`,
      userMessage: '播放状态异常',
      context: { from, to },
      retryable: false,
    });
  }
}
