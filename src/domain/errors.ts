/**
 * 领域错误。
 *
 * code 与规范 23.7 核心错误码对齐；`details` 用于携带校验细信息（JSON 对象或 null）。
 * 展示层使用 `message`，程序判断只允许使用 `code`（规范 23.6）。
 */

export type ErrorDetails = Record<string, unknown> | null;

export class DomainError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(code: string, message: string, details: ErrorDetails = null) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function validationError(
  message: string,
  details: ErrorDetails = null,
): DomainError {
  return new DomainError("VALIDATION_ERROR", message, details);
}

export function notFoundError(entity: string): DomainError {
  return new DomainError(`${entity}_NOT_FOUND`, `${entity} 不存在`);
}

export function conflictError(
  code: string,
  message: string,
  details: ErrorDetails = null,
): DomainError {
  return new DomainError(code, message, details);
}

export function internalError(message: string): DomainError {
  return new DomainError("INTERNAL_ERROR", message);
}
