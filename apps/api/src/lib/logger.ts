import { pino, type DestinationStream, type Logger } from 'pino';
import type { Env } from '../config/env.js';

export type { Logger };

/**
 * Structured JSON logger. Credentials, cookies and request bodies are never logged;
 * bodies can contain passwords, GPS coordinates and QR tokens.
 */
export function createLogger(
  env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'password',
          '*.password',
          'token',
          '*.token',
          'refreshToken',
          '*.refreshToken',
        ],
        censor: '[redacted]',
      },
    },
    destination,
  );
}
