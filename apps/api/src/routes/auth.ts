import { Router, type RequestHandler, type Response } from 'express';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  type ClientKind,
  type SessionResponse,
} from '@teachgrow/shared';
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
  type CookieSettings,
} from '../auth/cookies.js';
import { assertTrustedBrowserRequest } from '../auth/csrf.js';
import { toAuthUserDto } from '../auth/identity.js';
import type { AuthService, IssuedSession } from '../auth/service.js';
import type { Env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { requestMeta } from '../lib/request-meta.js';
import { bearerToken, type AuthMiddleware } from '../middleware/authenticate.js';
import { markFailedAttempt } from '../middleware/rate-limit.js';

/** Sign-in outcomes that count against a client IP's failure budget. */
const COUNTED_LOGIN_FAILURES: ReadonlySet<string> = new Set([
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
]);

export interface AuthRouterDeps {
  env: Pick<
    Env,
    'CORS_ORIGINS' | 'AUTH_COOKIE_SAMESITE' | 'AUTH_COOKIE_SECURE' | 'AUTH_COOKIE_DAYS'
  >;
  service: AuthService;
  auth: AuthMiddleware;
  /** Counts only failed sign-ins per client IP. */
  loginFailureLimiter: RequestHandler;
  refreshFailureLimiter: RequestHandler;
  changePasswordLimiter: RequestHandler;
}

function sessionBody(session: IssuedSession, includeRefreshToken: boolean): SessionResponse {
  return {
    accessToken: session.accessToken,
    tokenType: 'bearer',
    expiresIn: session.expiresIn,
    expiresAt: session.expiresAt,
    ...(includeRefreshToken ? { refreshToken: session.refreshToken } : {}),
    user: session.user,
  };
}

export function authRouter(deps: AuthRouterDeps): Router {
  const { env, service, auth } = deps;
  const router = Router();

  const cookieSettings: CookieSettings = {
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: env.AUTH_COOKIE_SAMESITE,
    maxAgeSeconds: env.AUTH_COOKIE_DAYS * 24 * 60 * 60,
  };

  /** Web gets the refresh token as an HttpOnly cookie; mobile gets it in the body. */
  const deliver = (res: Response, session: IssuedSession, client: ClientKind): void => {
    if (client === 'web') setRefreshCookie(res, session.refreshToken, cookieSettings);
    res.json(sessionBody(session, client === 'mobile'));
  };

  // POST /api/auth/login
  router.post('/login', deps.loginFailureLimiter, async (req, res) => {
    const body = loginRequestSchema.parse(req.body ?? {});
    // The web flow sets a cookie, so it is protected against cross-site request forgery
    // ("login CSRF" would sign the victim into the attacker's account).
    if (body.client === 'web') assertTrustedBrowserRequest(req, env.CORS_ORIGINS);
    try {
      const session = await service.login(body, requestMeta(req));
      deliver(res, session, body.client);
    } catch (error) {
      // Only genuine credential failures use up the per-IP budget. Malformed or cross-site junk
      // (which a hostile page can make a visitor's browser send) is rejected before this point.
      if (error instanceof AppError && COUNTED_LOGIN_FAILURES.has(error.code))
        markFailedAttempt(res);
      throw error;
    }
  });

  // POST /api/auth/refresh  (web: cookie; mobile: refreshToken in the body)
  router.post('/refresh', deps.refreshFailureLimiter, async (req, res) => {
    const body = refreshRequestSchema.parse(req.body ?? {});
    const cookieToken = readRefreshCookie(req);

    let client: ClientKind;
    let token: string;
    if (body.refreshToken) {
      client = 'mobile';
      token = body.refreshToken;
    } else if (cookieToken) {
      client = 'web';
      token = cookieToken;
      assertTrustedBrowserRequest(req, env.CORS_ORIGINS);
    } else {
      throw new AppError('UNAUTHENTICATED');
    }

    try {
      const session = await service.refresh(token, client, requestMeta(req));
      deliver(res, session, client);
    } catch (error) {
      // A token the provider rejects counts toward the (generous) per-IP budget. A request that
      // carried no token at all, or was CSRF-rejected, never reaches here and never counts.
      if (error instanceof AppError && error.status === 401) markFailedAttempt(res);
      // A cookie the provider rejects is useless; remove it so the browser stops sending it.
      // Transient failures (outage, rate limit) keep it so the user can simply retry.
      if (
        client === 'web' &&
        error instanceof AppError &&
        (error.status === 401 || error.code === 'ACCOUNT_DEACTIVATED' || error.code === 'FORBIDDEN')
      ) {
        clearRefreshCookie(res, cookieSettings);
      }
      throw error;
    }
  });

  // POST /api/auth/logout  (idempotent: always 204)
  router.post('/logout', async (req, res) => {
    const body = logoutRequestSchema.parse(req.body ?? {});
    const cookieToken = readRefreshCookie(req);
    if (cookieToken && !body.refreshToken) {
      assertTrustedBrowserRequest(req, env.CORS_ORIGINS);
    }
    await service.logout(
      {
        accessToken: bearerToken(req),
        refreshToken: body.refreshToken ?? cookieToken,
        allDevices: body.allDevices,
      },
      requestMeta(req),
    );
    clearRefreshCookie(res, cookieSettings);
    res.status(204).end();
  });

  // GET /api/auth/me
  router.get('/me', auth.authenticate({ allowPasswordChangePending: true }), (req, res) => {
    res.json({ user: toAuthUserDto(req.auth!.identity) });
  });

  // POST /api/auth/change-password
  router.post(
    '/change-password',
    auth.authenticate({ allowPasswordChangePending: true }),
    deps.changePasswordLimiter,
    async (req, res) => {
      const body = changePasswordRequestSchema.parse(req.body ?? {});
      await service.changePassword(req.auth!, body, requestMeta(req));
      res.status(204).end();
    },
  );

  return router;
}
