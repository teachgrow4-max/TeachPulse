import express, { type Express, type Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { SupabaseAuthGateway, type AuthGateway } from './auth/gateway.js';
import { AuthService } from './auth/service.js';
import { createTokenVerifier, type TokenVerifier } from './auth/token-verifier.js';
import { parseTrustProxy } from './config/trust-proxy.js';
import type { Env } from './config/env.js';
import type { Db } from './db/pool.js';
import { EmployeeService } from './employees/service.js';
import type { Clock } from './lib/clock.js';
import type { Logger } from './lib/logger.js';
import { createAuthMiddleware } from './middleware/authenticate.js';
import { createErrorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createRateLimiter, wasFailedAttempt } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { corsPolicy, noStore, securityHeaders } from './middleware/security.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  env: Env;
  logger: Logger;
  db: Db;
  clock: Clock;
  /** Defaults to the real Supabase Auth client; tests substitute their own. */
  gateway?: AuthGateway;
  /** Defaults to verifying Supabase tokens against the configured secret / JWKS. */
  verifier?: TokenVerifier;
}

const FIFTEEN_MINUTES = 15 * 60_000;

export function createApp({ env, logger, db, clock, gateway, verifier }: AppDeps): Express {
  const app = express();

  const authGateway =
    gateway ??
    new SupabaseAuthGateway({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });
  const tokenVerifier =
    verifier ??
    createTokenVerifier({
      issuer: env.JWT_ISSUER,
      hs256Secret: env.SUPABASE_JWT_SECRET,
      jwksUrl: env.SUPABASE_JWKS_URL,
      now: () => clock.now(),
    });

  const auth = createAuthMiddleware({ verifier: tokenVerifier, db, clock, logger });
  const authService = new AuthService({
    db,
    gateway: authGateway,
    verifier: tokenVerifier,
    clock,
    logger,
    lockout: {
      maxFailures: env.LOGIN_MAX_FAILURES,
      windowSeconds: env.LOGIN_LOCKOUT_MINUTES * 60,
    },
  });
  const employeeService = new EmployeeService({ db, gateway: authGateway, clock, logger });

  /** Per signed-in person; falls back to the client IP if (unexpectedly) unauthenticated. */
  const perUser = (req: Request): string => req.auth?.userId ?? ipKeyGenerator(req.ip ?? '');

  app.disable('x-powered-by');
  app.disable('etag');
  // Never `true`: see parseTrustProxy. req.ip is the only client-IP source the app uses.
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      // Health probes are noisy; log them only when they fail.
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/health') ?? false },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          // Query strings can carry tokens; keep only the path.
          url: req.url.split('?')[0],
        }),
      },
    }),
  );
  app.use(securityHeaders());
  app.use(corsPolicy(env.CORS_ORIGINS));
  app.use(noStore);
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', createRateLimiter({ windowMs: 60_000, limit: env.RATE_LIMIT_GLOBAL_PER_MIN }));
  app.use('/api', healthRouter({ db, clock }));

  app.use(
    '/api/auth',
    authRouter({
      env,
      service: authService,
      auth,
      loginFailureLimiter: createRateLimiter({
        windowMs: FIFTEEN_MINUTES,
        limit: env.LOGIN_IP_FAILURE_LIMIT,
        isFailedAttempt: wasFailedAttempt,
      }),
      // Rejected refresh tokens are routine (a cookie that has simply expired), so this budget is
      // deliberately much looser than the one for passwords.
      refreshFailureLimiter: createRateLimiter({
        windowMs: FIFTEEN_MINUTES,
        limit: env.LOGIN_IP_FAILURE_LIMIT * 10,
        isFailedAttempt: wasFailedAttempt,
      }),
      changePasswordLimiter: createRateLimiter({
        windowMs: FIFTEEN_MINUTES,
        limit: 10,
        keyGenerator: perUser,
      }),
    }),
  );

  app.use(
    '/api/admin',
    adminRouter({
      auth,
      employees: employeeService,
      userLimiter: createRateLimiter({
        windowMs: 60_000,
        limit: env.USER_RATE_LIMIT_PER_MIN,
        keyGenerator: perUser,
      }),
    }),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
