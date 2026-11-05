import { Router } from 'express';
import { AppError } from '../lib/errors.js';
import type { Clock } from '../lib/clock.js';
import type { Db } from '../db/pool.js';

export function healthRouter(deps: { db: Pick<Db, 'ping'>; clock: Clock }): Router {
  const router = Router();

  /** Liveness: the process is up. Does not touch dependencies. */
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: deps.clock.now().toISOString() });
  });

  /** Readiness: the database answers. Used by the host to decide whether to route traffic. */
  router.get('/health/ready', async (_req, res, next) => {
    try {
      await deps.db.ping();
      res.json({ status: 'ready' });
    } catch (error) {
      next(new AppError('SERVICE_UNAVAILABLE', undefined, { cause: error }));
    }
  });

  return router;
}
