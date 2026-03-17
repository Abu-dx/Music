/**
 * @module shared
 * @description 跨层共享模块统一导出
 *
 * 本模块是 shared/contracts 的最小公共集合（规格文档 §26.2）：
 * 只导出枚举、跨层 contract、错误码、日志接口和 ADR 常量。
 *
 * 领域实体不在此导出 — 它们位于 domain/entities.ts，
 * renderer 通过 DTO 投影（contracts.ts 中的 ProjectSummaryDTO 等）间接获取。
 */

export * from './enums';
export * from './contracts';
export * from './errors';
export * from './logger';
export * from './adr';
