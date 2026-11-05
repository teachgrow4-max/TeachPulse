import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, fromDbError, toErrorBody } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError('NOT_FOUND'));
};

interface HttpishError {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
}

/** Translate body-parser failures (bad JSON, oversized body) into client errors. */
function fromBodyParserError(error: unknown): AppError | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, statusCode, type } = error as HttpishError;
  const code =
    typeof status === 'number' ? status : typeof statusCode === 'number' ? statusCode : 0;
  if (type === 'entity.too.large') {
    return new AppError('VALIDATION_FAILED', 'The request body is too large.');
  }
  if (type === 'entity.parse.failed' || type === 'encoding.unsupported' || code === 400) {
    return new AppError('VALIDATION_FAILED', 'The request body could not be read.');
  }
  return null;
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies error middleware by arity, so all four parameters are required.
  return (error, req, res, _next) => {
    let appError: AppError | null = null;

    if (error instanceof AppError) {
      appError = error;
    } else if (error instanceof ZodError) {
      appError = new AppError('VALIDATION_FAILED', undefined, {
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    } else {
      appError = fromDbError(error) ?? fromBodyParserError(error);
    }

    if (!appError) {
      // Unexpected: log everything server-side, tell the client nothing specific.
      logger.error({ err: error, requestId: req.requestId }, 'unhandled error');
      appError = new AppError('INTERNAL');
    } else if (appError.status >= 500) {
      logger.error({ err: appError, requestId: req.requestId }, 'server error');
    }

    if (res.headersSent) {
      return;
    }
    if (appError.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(appError.retryAfterSeconds))));
    }
    if (appError.status === 401) {
      res.setHeader('WWW-Authenticate', 'Bearer');
    }
    res.status(appError.status).json(toErrorBody(appError, req.requestId));
  };
}
