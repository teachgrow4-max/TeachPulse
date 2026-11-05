import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DB_ERROR_SQLSTATE, ERROR_MESSAGES, ERROR_STATUS, type ErrorCode } from '@teachgrow/shared';
import { createErrorHandler } from '../middleware/error-handler.js';
import { requestId } from '../middleware/request-id.js';
import { AppError, fromDbError } from './errors.js';
import { createLogger } from './logger.js';

describe('AppError', () => {
  it('derives the HTTP status and default message from the code', () => {
    const error = new AppError('ALREADY_CHECKED_IN');
    expect(error.status).toBe(409);
    expect(error.message).toBe(ERROR_MESSAGES.ALREADY_CHECKED_IN);
  });

  it('has a status and message for every code', () => {
    for (const code of Object.keys(ERROR_STATUS) as ErrorCode[]) {
      const error = new AppError(code);
      expect(error.status).toBe(ERROR_STATUS[code]);
      expect(error.message.length).toBeGreaterThan(5);
    }
  });
});

describe('fromDbError', () => {
  it('translates a domain error raised by a Postgres function', () => {
    const error = fromDbError({ code: DB_ERROR_SQLSTATE, message: 'ACTIVE_BREAK' });
    expect(error?.code).toBe('ACTIVE_BREAK');
    expect(error?.status).toBe(409);
  });

  it.each([
    { code: '23505', message: 'duplicate key value violates unique constraint' },
    { code: DB_ERROR_SQLSTATE, message: 'NOT_A_REAL_CODE' },
    { code: 'TG002', message: 'UPDATE on attendance_events is not allowed' },
    null,
    undefined,
    'a string',
  ])('returns null for non-domain error %j', (input) => {
    expect(fromDbError(input)).toBeNull();
  });
});

describe('error handler', () => {
  function appThrowing(thrower: () => never) {
    const app = express();
    app.use(requestId);
    app.get('/boom', () => thrower());
    app.use(createErrorHandler(createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' })));
    return app;
  }

  it('maps a Postgres domain error to its HTTP status', async () => {
    const res = await request(
      appThrowing(() => {
        throw Object.assign(new Error('NOT_CHECKED_IN'), { code: DB_ERROR_SQLSTATE });
      }),
    ).get('/boom');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_CHECKED_IN');
  });

  it('turns Zod failures into 400 with field paths only', async () => {
    const res = await request(
      appThrowing(() => {
        z.object({ lat: z.number().min(-90).max(90) }).parse({ lat: 500 });
        throw new Error('unreachable');
      }),
    ).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details[0].path).toBe('lat');
  });

  it('hides unexpected error details behind a generic 500', async () => {
    const res = await request(
      appThrowing(() => {
        throw new Error('relation "profiles" does not exist; password=hunter2');
      }),
    ).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toContain('profiles');
    expect(res.body.error.requestId).toBeTruthy();
  });
});
