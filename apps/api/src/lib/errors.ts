import {
  DB_ERROR_SQLSTATE,
  ERROR_MESSAGES,
  ERROR_STATUS,
  isErrorCode,
  type ApiErrorBody,
  type ErrorCode,
} from '@teachgrow/shared';

interface AppErrorOptions {
  details?: unknown;
  cause?: unknown;
  /** Sent as the Retry-After header (rate limiting / lockout). */
  retryAfterSeconds?: number;
}

/** An error that is safe to report to the client: it carries a stable code. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, message?: string, options?: AppErrorOptions) {
    super(message ?? ERROR_MESSAGES[code], options?.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options?.details;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

interface PgErrorLike {
  code?: unknown;
  message?: unknown;
}

/**
 * Domain rules enforced inside Postgres functions raise SQLSTATE TG001 with the error
 * code as the message. Translate those into AppError; return null for anything else
 * (those are unexpected and must surface as a 500, never leak SQL details).
 */
export function fromDbError(error: unknown): AppError | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, message } = error as PgErrorLike;
  if (code !== DB_ERROR_SQLSTATE || typeof message !== 'string') return null;
  const domainCode = message.trim();
  if (!isErrorCode(domainCode)) return null;
  return new AppError(domainCode, undefined, { cause: error });
}

export function toErrorBody(error: AppError, requestId?: string): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(requestId ? { requestId } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
}
