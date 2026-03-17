/**
 * @module infrastructure/worker/workerSchemaValidator
 * @description Worker 响应 Schema 校验器 — ADR-011 运行时类型守卫
 *
 * 职责（ADR-011, 规格文档 §24.4）：
 * - 对 Worker 返回的 JSON 数据做运行时结构校验
 * - 将非类型安全的 Record<string, unknown> 转化为 ValidatedWorkerResponse<T>
 * - 提供具体命令的校验规则注册机制
 * - 校验失败时返回结构化 SchemaValidationFailure[]（不抛异常）
 *
 * 不负责：
 * - Worker 进程管理 → WorkerManager
 * - IPC 通信 → WorkerIpcBridge
 * - 业务逻辑处理 → Application Service
 *
 * Why ADR-011:
 * - Python Worker 返回的 JSON 数据无编译期类型保障
 * - 必须在 TypeScript 侧做运行时校验，防止类型错误穿透到 UI 层
 * - 校验器作为 Worker ↔ Application 的防腐层
 *
 * 设计原则：
 * - 校验器不依赖第三方 schema 库（如 zod/joi），使用手工校验函数
 * - 每个 WorkerCommand 对应一个 ResponseValidator<T>
 * - 校验通过 → { valid: true, data: T }
 * - 校验失败 → { valid: false, validationErrors: [...] }
 * - 校验器纯函数，无副作用，可单元测试
 *
 * Validator 注册规范（GPT R5 Suggested #4）：
 * - 注册 key 必须使用 WorkerCommand 枚举值，与命令一一对应
 * - 每个 WorkerCommand 最多注册一个 validator（后注册覆盖前注册）
 * - 注册时机：在 composition root（DI 容器初始化阶段）统一注册，
 *   不在运行时动态注册，保证所有模块看到同一套 validator 列表
 * - 命名约定：各 Service 定义 validateXxxResponse 函数，
 *   在 composition root 调用 registerValidator(WorkerCommand.Xxx, validateXxxResponse)
 * - 未注册 validator 的命令：validate() 返回 { valid: true }
 *   但会记 warn 日志，提醒开发者补注册
 *
 * 错误语义：
 * - validate(): 纯函数，不抛异常，校验失败返回 { valid: false, ... }
 * - registerValidator(): 命令已注册则覆盖（幂等）
 * - 调用方（Application Service）收到 valid=false 时应抛
 *   AppError(WORKER_RESPONSE_SCHEMA_INVALID)
 */

import {
  WorkerResponse,
  ValidatedWorkerResponse,
  SchemaValidationFailure,
} from '../../shared/contracts';
import { WorkerCommand } from '../../shared/enums';
import { ILogger } from '../../shared/logger';

// ============================================================================
// 1. 校验器类型
// ============================================================================

/**
 * 单命令响应校验函数
 *
 * @param data - WorkerResponse.data（可能 undefined）
 * @returns 校验结果
 */
export type ResponseValidator<T> = (
  data: Record<string, unknown> | undefined,
) => ValidatedWorkerResponse<T>;

/**
 * 字段校验辅助 — 生成一条 SchemaValidationFailure
 */
export function createValidationFailure(
  fieldPath: string,
  expected: string,
  received: string,
  message: string,
): SchemaValidationFailure {
  return { fieldPath, expected, received, message };
}

// ============================================================================
// 2. 接口
// ============================================================================

/**
 * Worker Schema 校验器接口
 *
 * Application Service 通过此接口校验 Worker 返回数据。
 */
export interface IWorkerSchemaValidator {
  /**
   * 注册命令对应的校验函数
   *
   * 幂等：同一命令重复注册会覆盖。
   *
   * @param command - Worker 命令
   * @param validator - 校验函数
   */
  registerValidator<T>(command: WorkerCommand, validator: ResponseValidator<T>): void;

  /**
   * 校验 Worker 响应
   *
   * 纯函数，不抛异常。
   *
   * @param command - 原始请求命令（用于查找校验器）
   * @param response - Worker 响应
   * @returns 校验结果（含类型安全数据或校验错误）
   */
  validate<T>(command: WorkerCommand, response: WorkerResponse): ValidatedWorkerResponse<T>;

  /**
   * 检查是否已为指定命令注册校验器
   */
  hasValidator(command: WorkerCommand): boolean;
}

// ============================================================================
// 3. 实现
// ============================================================================

export class WorkerSchemaValidator implements IWorkerSchemaValidator {
  private validators = new Map<WorkerCommand, ResponseValidator<unknown>>();

  constructor(private readonly logger: ILogger) {}

  registerValidator<T>(command: WorkerCommand, validator: ResponseValidator<T>): void {
    this.validators.set(command, validator as ResponseValidator<unknown>);

    this.logger.debug('Validator registered', {
      command,
      stage: 'workerSchemaValidator.registerValidator',
    });
  }

  validate<T>(command: WorkerCommand, response: WorkerResponse): ValidatedWorkerResponse<T> {
    // 1. 检查响应基本结构
    if (!response) {
      return {
        valid: false,
        validationErrors: [
          createValidationFailure(
            'response',
            'WorkerResponse object',
            'null/undefined',
            'Response is null or undefined',
          ),
        ],
      };
    }

    // 2. 检查 success 字段
    if (!response.success) {
      // Worker 报告了业务错误 — 不算 schema 校验失败，
      // 返回 valid=false 但 validationErrors 说明来自 Worker 错误
      return {
        valid: false,
        validationErrors: [
          createValidationFailure(
            'response.success',
            'true',
            'false',
            `Worker returned error: ${response.error?.message ?? 'unknown'}`,
          ),
        ],
      };
    }

    // 3. 查找注册的校验器
    const validator = this.validators.get(command);
    if (!validator) {
      // 未注册校验器 — 透传 data（视为校验通过但无类型保障）
      this.logger.warn('No validator registered for command, skipping validation', {
        command,
        stage: 'workerSchemaValidator.validate',
      });
      return {
        valid: true,
        data: (response.data ?? {}) as T,
      };
    }

    // 4. 执行校验
    const result = validator(response.data) as ValidatedWorkerResponse<T>;

    if (!result.valid) {
      this.logger.warn('Worker response schema validation failed', {
        command,
        errorCount: result.validationErrors?.length ?? 0,
        stage: 'workerSchemaValidator.validate',
      });
    }

    return result;
  }

  hasValidator(command: WorkerCommand): boolean {
    return this.validators.has(command);
  }
}

// ============================================================================
// 4. 通用校验辅助函数
// ============================================================================

/**
 * 校验字段存在且为指定类型
 *
 * 用于简化各命令的 ResponseValidator 编写。
 */
export function assertField(
  data: Record<string, unknown>,
  fieldPath: string,
  expectedType: 'string' | 'number' | 'boolean' | 'object' | 'array',
  errors: SchemaValidationFailure[],
): boolean {
  const parts = fieldPath.split('.');
  let current: unknown = data;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      errors.push(createValidationFailure(
        fieldPath,
        expectedType,
        String(current),
        `Cannot access "${part}" on ${typeof current}`,
      ));
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (current === undefined || current === null) {
    errors.push(createValidationFailure(
      fieldPath,
      expectedType,
      current === null ? 'null' : 'undefined',
      `Field "${fieldPath}" is missing`,
    ));
    return false;
  }

  if (expectedType === 'array') {
    if (!Array.isArray(current)) {
      errors.push(createValidationFailure(
        fieldPath,
        'array',
        typeof current,
        `Field "${fieldPath}" is not an array`,
      ));
      return false;
    }
  } else if (typeof current !== expectedType) {
    errors.push(createValidationFailure(
      fieldPath,
      expectedType,
      typeof current,
      `Field "${fieldPath}" has wrong type`,
    ));
    return false;
  }

  return true;
}

/**
 * 校验数字字段在指定范围内
 */
export function assertNumberRange(
  data: Record<string, unknown>,
  fieldPath: string,
  min: number,
  max: number,
  errors: SchemaValidationFailure[],
): boolean {
  if (!assertField(data, fieldPath, 'number', errors)) return false;

  const parts = fieldPath.split('.');
  let current: unknown = data;
  for (const part of parts) {
    current = (current as Record<string, unknown>)[part];
  }

  const value = current as number;
  if (value < min || value > max) {
    errors.push(createValidationFailure(
      fieldPath,
      `number in range [${min}, ${max}]`,
      String(value),
      `Field "${fieldPath}" is out of range`,
    ));
    return false;
  }

  return true;
}

/**
 * 校验字符串字段为指定枚举值之一
 */
export function assertEnum(
  data: Record<string, unknown>,
  fieldPath: string,
  allowedValues: readonly string[],
  errors: SchemaValidationFailure[],
): boolean {
  if (!assertField(data, fieldPath, 'string', errors)) return false;

  const parts = fieldPath.split('.');
  let current: unknown = data;
  for (const part of parts) {
    current = (current as Record<string, unknown>)[part];
  }

  const value = current as string;
  if (!allowedValues.includes(value)) {
    errors.push(createValidationFailure(
      fieldPath,
      `one of [${allowedValues.join(', ')}]`,
      value,
      `Field "${fieldPath}" has invalid enum value`,
    ));
    return false;
  }

  return true;
}
