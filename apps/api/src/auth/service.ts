import { decodeJwt } from 'jose';
import type { AuthUserDto, ClientKind } from '@teachgrow/shared';
import { writeAudit } from '../audit/audit.js';
import type { Db } from '../db/pool.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { RequestMeta } from '../lib/request-meta.js';
import type { AuthContext } from './context.js';
import { AuthGatewayError, type AuthGateway, type GatewaySession } from './gateway.js';
import { loadIdentity, toAuthUserDto, type Identity } from './identity.js';
import { checkLockout, subjectHashOf, type LockoutPolicy } from './lockout.js';
import { revokeSession, revokeUserSessions } from './sessions.js';
import { TokenError, type TokenVerifier, type VerifiedToken } from './token-verifier.js';

export interface AuthServiceDeps {
  db: Db;
  gateway: AuthGateway;
  verifier: TokenVerifier;
  clock: Clock;
  logger: Logger;
  lockout: LockoutPolicy;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt: number;
  sessionId: string;
  user: AuthUserDto;
}

interface SignInContext {
  subjectHash: string;
  client: ClientKind;
  meta: RequestMeta;
  now: Date;
  /** Record `auth.login.success` (true for sign-in, false for silent token refresh). */
  auditSuccess: boolean;
}

const lockedError = (retryAfterSeconds: number): AppError => {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return new AppError(
    'ACCOUNT_LOCKED',
    `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    { retryAfterSeconds, details: { retryAfterSeconds } },
  );
};

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  // ---------------------------------------------------------------------------------------
  // Sign in
  // ---------------------------------------------------------------------------------------

  async login(
    input: { email: string; password: string; client: ClientKind },
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const { db, gateway, clock, lockout } = this.deps;
    const now = clock.now();
    const subjectHash = subjectHashOf(input.email);

    const lock = await checkLockout(db, subjectHash, now, lockout);
    if (lock.locked) {
      await writeAudit(db, {
        action: 'auth.login.blocked',
        metadata: {
          subject_hash: subjectHash,
          client: input.client,
          retry_after_seconds: lock.retryAfterSeconds,
        },
        ...meta,
        at: now,
      });
      throw lockedError(lock.retryAfterSeconds);
    }

    let granted: GatewaySession;
    try {
      granted = await gateway.signInWithPassword(input.email, input.password);
    } catch (error) {
      throw await this.translateCredentialError(error, {
        email: input.email,
        subjectHash,
        client: input.client,
        meta,
        now,
        reasonForBadPassword: 'invalid_credentials',
      });
    }

    return this.completeSignIn(granted, {
      subjectHash,
      client: input.client,
      meta,
      now,
      auditSuccess: true,
    });
  }

  // ---------------------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------------------

  async refresh(
    refreshToken: string,
    client: ClientKind,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const { gateway, clock, logger } = this.deps;
    const now = clock.now();

    let granted: GatewaySession;
    try {
      granted = await gateway.refreshSession(refreshToken);
    } catch (error) {
      if (error instanceof AuthGatewayError) {
        switch (error.kind) {
          case 'refresh_token_invalid':
            if (error.code === 'refresh_token_already_used') {
              // A rotated token was presented again: the usual sign of a stolen token.
              await writeAudit(this.deps.db, {
                action: 'auth.refresh.reuse_detected',
                metadata: { client },
                ...meta,
                at: now,
              });
              logger.warn({ requestId: meta.requestId }, 'refresh token reuse detected');
            }
            throw new AppError('UNAUTHENTICATED');
          case 'user_banned':
            throw new AppError('ACCOUNT_DEACTIVATED');
          case 'rate_limited':
            throw new AppError('RATE_LIMITED');
          case 'unavailable':
            throw new AppError('SERVICE_UNAVAILABLE', undefined, { cause: error });
          default:
            break;
        }
      }
      throw error;
    }

    return this.completeSignIn(granted, {
      subjectHash: '',
      client,
      meta,
      now,
      auditSuccess: false,
    });
  }

  // ---------------------------------------------------------------------------------------
  // Sign out
  // ---------------------------------------------------------------------------------------

  /**
   * Always succeeds (idempotent) and reveals nothing about token validity. If the access token has
   * expired but the refresh token is still good, the session is found by refreshing and is then
   * revoked, so a user who has been idle can still sign out completely.
   */
  async logout(
    input: { accessToken?: string; refreshToken?: string; allDevices: boolean },
    meta: RequestMeta,
  ): Promise<void> {
    const { db, gateway, verifier, clock } = this.deps;
    const now = clock.now();

    let target: Pick<VerifiedToken, 'userId' | 'sessionId'> | null = null;

    if (input.accessToken) {
      try {
        target = await verifier.verify(input.accessToken);
      } catch {
        target = null;
      }
    }
    if (!target && input.refreshToken) {
      try {
        const rotated = await gateway.refreshSession(input.refreshToken);
        target = await verifier.verify(rotated.accessToken);
      } catch {
        target = null;
      }
    }
    if (!target) return;

    const revoked = input.allDevices
      ? await revokeUserSessions(db, target.userId)
      : await revokeSession(db, target.sessionId);

    await writeAudit(db, {
      action: 'auth.logout',
      actorId: target.userId,
      metadata: { all_devices: input.allDevices, sessions_revoked: revoked },
      ...meta,
      at: now,
    });
  }

  // ---------------------------------------------------------------------------------------
  // Change password
  // ---------------------------------------------------------------------------------------

  /**
   * Proves the signed-in person knows their password right now ("sudo mode"), for actions where a
   * stolen access token must not be enough: changing the password, enrolling a new device.
   *
   * It shares the sign-in lockout and failure trail, so these endpoints cannot be used as an
   * unlimited password-guessing oracle. Leaves no session behind.
   */
  async confirmPassword(
    identity: Identity,
    password: string,
    meta: RequestMeta,
    purpose: 'change_password' | 'device_registration',
  ): Promise<void> {
    const { db, gateway, verifier, clock, lockout, logger } = this.deps;
    const now = clock.now();
    const subjectHash = subjectHashOf(identity.email);

    const lock = await checkLockout(db, subjectHash, now, lockout);
    if (lock.locked) {
      await writeAudit(db, {
        action: 'auth.login.blocked',
        actorId: identity.id,
        metadata: {
          subject_hash: subjectHash,
          context: purpose,
          retry_after_seconds: lock.retryAfterSeconds,
        },
        ...meta,
        at: now,
      });
      throw lockedError(lock.retryAfterSeconds);
    }

    let proof: GatewaySession;
    try {
      proof = await gateway.signInWithPassword(identity.email, password);
    } catch (error) {
      const translated = await this.translateCredentialError(error, {
        email: identity.email,
        subjectHash,
        client: 'web',
        meta,
        now,
        reasonForBadPassword: 'invalid_current_password',
      });
      if (translated.code === 'INVALID_CREDENTIALS') {
        throw new AppError('INVALID_CREDENTIALS', 'Your current password is incorrect.');
      }
      throw translated;
    }

    // Proving the password created a throw-away session; remove it again.
    try {
      const proofToken = await verifier.verify(proof.accessToken);
      await revokeSession(db, proofToken.sessionId);
    } catch (error) {
      logger.warn({ err: error }, 'could not clean up the password re-check session');
      await this.revokeUnverified(proof.accessToken);
    }
  }

  async changePassword(
    auth: AuthContext,
    input: { currentPassword: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<void> {
    const { db, gateway, clock } = this.deps;
    const now = clock.now();
    const { identity } = auth;

    await this.confirmPassword(identity, input.currentPassword, meta, 'change_password');

    try {
      await gateway.updatePassword(identity.id, input.newPassword);
    } catch (error) {
      if (error instanceof AuthGatewayError) {
        if (error.kind === 'weak_password') {
          throw new AppError('VALIDATION_FAILED', 'That password is too easy to guess.', {
            details: [
              {
                path: 'newPassword',
                message: 'Choose a longer or less common password.',
              },
            ],
          });
        }
        if (error.kind === 'unavailable') {
          throw new AppError('SERVICE_UNAVAILABLE', undefined, { cause: error });
        }
        if (error.kind === 'rate_limited') throw new AppError('RATE_LIMITED');
      }
      throw error;
    }

    await db.withTransaction(async (tx) => {
      await tx.query('update public.profiles set must_change_password = false where id = $1', [
        identity.id,
      ]);
      // Anyone else holding a session for this account (a thief, an old phone) is signed out.
      const revoked = await revokeUserSessions(tx, identity.id, auth.sessionId);
      await writeAudit(tx, {
        action: 'auth.password.changed',
        actorId: identity.id,
        actorRole: identity.role,
        entityType: 'profile',
        entityId: identity.id,
        metadata: { other_sessions_revoked: revoked, was_forced: identity.mustChangePassword },
        ...meta,
        at: now,
      });
    });
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  /** Everything that must be true of a freshly issued session before we hand it to a client. */
  private async completeSignIn(
    granted: GatewaySession,
    context: SignInContext,
  ): Promise<IssuedSession> {
    const { db, verifier, logger } = this.deps;
    const { subjectHash, client, meta, now, auditSuccess } = context;
    const event = auditSuccess ? 'login' : 'refresh';

    let token: VerifiedToken;
    try {
      token = await verifier.verify(granted.accessToken);
    } catch (error) {
      // GoTrue issued this token moments ago. If we cannot verify it, our configuration (signing
      // secret, JWKS URL or issuer) is wrong; fail loudly instead of locking everyone out silently.
      logger.error(
        { err: error, reason: error instanceof TokenError ? error.reason : undefined },
        'a token issued by the auth provider failed verification: check SUPABASE_JWT_SECRET, ' +
          'SUPABASE_JWKS_URL and JWT_ISSUER',
      );
      await this.revokeUnverified(granted.accessToken);
      throw new AppError('SERVICE_UNAVAILABLE', undefined, { cause: error });
    }

    const { identity } = await loadIdentity(db, token.userId, token.sessionId, now);

    if (!identity) {
      await revokeSession(db, token.sessionId);
      await writeAudit(db, {
        action: `auth.${event}.denied`,
        metadata: { subject_hash: subjectHash, reason: 'no_profile', client },
        ...meta,
        at: now,
      });
      throw new AppError(
        'FORBIDDEN',
        'This account has not been set up for TeachGrow Attendance. Please contact HR.',
      );
    }

    if (!identity.isActive) {
      await revokeSession(db, token.sessionId);
      await writeAudit(db, {
        action: `auth.${event}.denied`,
        actorId: identity.id,
        actorRole: identity.role,
        metadata: { subject_hash: subjectHash, reason: 'deactivated', client },
        ...meta,
        at: now,
      });
      throw new AppError('ACCOUNT_DEACTIVATED');
    }

    if (auditSuccess) {
      await writeAudit(db, {
        action: 'auth.login.success',
        actorId: identity.id,
        actorRole: identity.role,
        metadata: { subject_hash: subjectHash, client },
        ...meta,
        at: now,
      });
    }

    return {
      accessToken: granted.accessToken,
      refreshToken: granted.refreshToken,
      expiresIn: granted.expiresIn,
      expiresAt: granted.expiresAt,
      sessionId: token.sessionId,
      user: toAuthUserDto(identity),
    };
  }

  /**
   * Maps a provider failure during a password check to the API's error, recording credential
   * failures (which feed the lockout) but not provider outages or provider-side rate limits.
   */
  private async translateCredentialError(
    error: unknown,
    context: {
      email: string;
      subjectHash: string;
      client: ClientKind;
      meta: RequestMeta;
      now: Date;
      reasonForBadPassword: string;
    },
  ): Promise<AppError> {
    if (!(error instanceof AuthGatewayError)) throw error;

    switch (error.kind) {
      case 'invalid_credentials':
        await this.recordFailedAttempt(context, context.reasonForBadPassword);
        return new AppError('INVALID_CREDENTIALS');
      case 'user_banned':
        await this.recordFailedAttempt(context, 'banned');
        return new AppError('ACCOUNT_DEACTIVATED');
      case 'rate_limited':
        this.deps.logger.warn(
          'the auth provider is rate limiting sign-ins; see "Auth rate limits" in docs/AUTH.md',
        );
        return new AppError('RATE_LIMITED');
      case 'unavailable':
        return new AppError('SERVICE_UNAVAILABLE', undefined, { cause: error });
      default:
        throw error;
    }
  }

  private async recordFailedAttempt(
    context: {
      email: string;
      subjectHash: string;
      client: ClientKind;
      meta: RequestMeta;
      now: Date;
    },
    reason: string,
  ): Promise<void> {
    const { db } = this.deps;
    // Link the attempt to the account when it exists (for administrators reading the log), but
    // always run this lookup so the failure path costs the same for unknown addresses.
    const { rows } = await db.query<{ id: string }>(
      'select id from public.profiles where email = $1',
      [context.email],
    );
    await writeAudit(db, {
      action: 'auth.login.failed',
      actorId: rows[0]?.id ?? null,
      metadata: { subject_hash: context.subjectHash, reason, client: context.client },
      ...context.meta,
      at: context.now,
    });
  }

  /** Best-effort revocation of a session whose token we could not verify (decode only). */
  private async revokeUnverified(accessToken: string): Promise<void> {
    try {
      const sessionId = decodeJwt(accessToken).session_id;
      if (typeof sessionId === 'string') await revokeSession(this.deps.db, sessionId);
    } catch {
      // Nothing more can be done; the session will expire on its own.
    }
  }
}
