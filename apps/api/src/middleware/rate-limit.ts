import type { Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AppError } from '../lib/errors.js';

export interface LimiterOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests per key per window. */
  limit: number;
  /** Optional message override. */
  message?: string;
  /**
   * When given, ONLY requests for which this returns true use up the budget. Sign-in uses it so
   * that (a) a whole office signing in through one shared public IP is never throttled by its own
   * successes, and (b) junk a hostile web page can make a visitor's browser send (malformed or
   * cross-site requests) cannot burn that IP's budget. The route marks genuine failed attempts.
   */
  isFailedAttempt?: (req: Request, res: Response) => boolean;
  /** Custom bucket key (e.g. the signed-in user). Defaults to the client IP. */
  keyGenerator?: (req: Request) => string;
}

/** Routes set this on `res.locals` when a request was a genuine failed credential attempt. */
export const FAILED_ATTEMPT = 'failedAttempt';

export const markFailedAttempt = (res: Response): void => {
  res.locals[FAILED_ATTEMPT] = true;
};

export const wasFailedAttempt = (_req: Request, res: Response): boolean =>
  res.locals[FAILED_ATTEMPT] === true;

/**
 * Fixed-window limiter. By default keyed by `req.ip`, which honours TRUST_PROXY; IPv6 clients are
 * bucketed by /56 so rotating addresses inside one prefix does not evade it.
 *
 * The in-memory store is correct for a single API instance only. When running more than one
 * instance, supply a shared store (Redis) before relying on these limits.
 */
export function createRateLimiter(options: LimiterOptions): RequestHandler {
  const { isFailedAttempt } = options;
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(isFailedAttempt
      ? {
          skipSuccessfulRequests: true,
          requestWasSuccessful: (req: Request, res: Response) => !isFailedAttempt(req, res),
        }
      : {}),
    // The /56 bucketing applies to the default per-IP key only; a custom key (e.g. the user id)
    // is used exactly as given.
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : { ipv6Subnet: 56 }),
    handler: (_req, _res, next) => {
      next(new AppError('RATE_LIMITED', options.message));
    },
  });
}
