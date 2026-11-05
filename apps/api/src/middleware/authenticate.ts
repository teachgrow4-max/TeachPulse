import type { Request, RequestHandler } from 'express';
import type { RoleName } from '@teachgrow/shared';
import { writeAudit } from '../audit/audit.js';
import { loadIdentity } from '../auth/identity.js';
import { TokenError, type TokenVerifier } from '../auth/token-verifier.js';
import type { Db } from '../db/pool.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { requestMeta } from '../lib/request-meta.js';

export interface AuthenticateOptions {
  /**
   * Let a user who still has a temporary password through. Only /auth/me, /auth/logout and
   * /auth/change-password set this; everything else refuses until the password is changed.
   */
  allowPasswordChangePending?: boolean;
}

export interface AuthMiddlewareDeps {
  verifier: TokenVerifier;
  db: Db;
  clock: Clock;
  logger: Logger;
}

/** Extracts the token from `Authorization: Bearer <token>`; undefined if absent or malformed. */
export function bearerToken(req: Request): string | undefined {
  const header = req.get('authorization');
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1];
}

export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  const { verifier, db, clock, logger } = deps;

  /**
   * Proves who is calling, on every request:
   *   1. the bearer token's signature, issuer, audience and expiry (local, no network);
   *   2. that its session still exists (logout / revocation / deactivation are immediate);
   *   3. that the person has a profile, is active, and is not stuck on a temporary password.
   * Role and status always come from the database, never from the token.
   */
  const authenticate =
    (options: AuthenticateOptions = {}): RequestHandler =>
    async (req, _res, next) => {
      const token = bearerToken(req);
      if (!token) throw new AppError('UNAUTHENTICATED');

      let verified;
      try {
        verified = await verifier.verify(token);
      } catch (error) {
        if (error instanceof TokenError) {
          if (error.reason === 'key_unavailable') {
            logger.error({ err: error }, 'cannot verify tokens: signing keys unavailable');
            throw new AppError('SERVICE_UNAVAILABLE', undefined, { cause: error });
          }
          // Every rejected token looks identical to the caller; the reason is for operators.
          logger.debug({ reason: error.reason, requestId: req.requestId }, 'access token rejected');
          throw new AppError('UNAUTHENTICATED');
        }
        throw error;
      }

      const { identity, sessionActive } = await loadIdentity(
        db,
        verified.userId,
        verified.sessionId,
        clock.now(),
      );

      if (!sessionActive) throw new AppError('UNAUTHENTICATED');
      if (!identity) {
        throw new AppError(
          'FORBIDDEN',
          'This account has not been set up for TeachGrow Attendance. Please contact HR.',
        );
      }
      if (!identity.isActive) throw new AppError('ACCOUNT_DEACTIVATED');
      if (identity.mustChangePassword && !options.allowPasswordChangePending) {
        throw new AppError('PASSWORD_CHANGE_REQUIRED');
      }

      req.auth = {
        userId: identity.id,
        sessionId: verified.sessionId,
        identity,
        tokenExpiresAt: verified.expiresAt,
      };
      next();
    };

  /**
   * Role gate. Must run after `authenticate`. Denials are written to the audit log: an employee
   * probing admin endpoints is worth knowing about.
   */
  const requireRole =
    (...allowed: RoleName[]): RequestHandler =>
    async (req, _res, next) => {
      const auth = req.auth;
      if (!auth) throw new AppError('UNAUTHENTICATED');
      if (allowed.includes(auth.identity.role)) {
        next();
        return;
      }

      try {
        await writeAudit(db, {
          action: 'authz.denied',
          actorId: auth.userId,
          actorRole: auth.identity.role,
          metadata: {
            method: req.method,
            path: `${req.baseUrl}${req.path}`,
            required_roles: allowed,
          },
          ...requestMeta(req),
          at: clock.now(),
        });
      } catch (error) {
        // Failing to log a denial must never turn it into a different outcome.
        logger.error({ err: error }, 'could not record authorization denial');
      }
      throw new AppError('FORBIDDEN');
    };

  return { authenticate, requireRole };
}

export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;
