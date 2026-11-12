import { Router, type RequestHandler } from 'express';
import {
  dailyQrVerifyRequestSchema,
  generateDailyQrRequestSchema,
  uuidSchema,
} from '@teachgrow/shared';
import type { DailyQrService } from '../daily-qr/service.js';
import { normalizeIp, requestMeta } from '../lib/request-meta.js';
import type { AuthMiddleware } from '../middleware/authenticate.js';
import { identityMarkingAttendance } from './helpers.js';

export interface DailyQrRouterDeps {
  auth: AuthMiddleware;
  dailyQr: DailyQrService;
  userLimiter: RequestHandler;
  /** Each attempt writes evidence, so this is tighter than the general per-user limit. */
  verifyLimiter: RequestHandler;
  /** Each generation spends an office verification and writes evidence. */
  generateLimiter: RequestHandler;
}

/**
 * The employee's own attendance QR code. Employees and administrators whose attendance is tracked.
 * (Check the office with `POST /api/attendance/verify` first; administrators skip that.)
 */
export function dailyQrRouter(deps: DailyQrRouterDeps): Router {
  const { auth, dailyQr } = deps;
  const router = Router();

  router.use(auth.authenticate(), auth.requireRole('employee', 'admin'), deps.userLimiter);

  // GET /api/attendance-qr/today
  // What a code generated now would be for, and whether one is live. Never returns a code.
  router.get('/today', async (req, res) => {
    res.json(await dailyQr.today(identityMarkingAttendance(req)));
  });

  // POST /api/attendance-qr/verify   { gps }
  // The employee proves they are at the office. 200 with a short-lived, single-use verification
  // (and the action a code would be for); 422 VERIFICATION_FAILED naming every layer that failed.
  router.post('/verify', deps.verifyLimiter, async (req, res) => {
    const identity = identityMarkingAttendance(req);
    const body = dailyQrVerifyRequestSchema.parse(req.body ?? {});
    res.json(await dailyQr.verify(identity, body, normalizeIp(req.ip), requestMeta(req)));
  });

  // POST /api/attendance-qr/generate   { verificationId? }
  // Spends the passed verification and returns the code, once.
  router.post('/generate', deps.generateLimiter, async (req, res) => {
    const identity = identityMarkingAttendance(req);
    const body = generateDailyQrRequestSchema.parse(req.body ?? {});
    res.status(201).json(await dailyQr.generate(identity, body.verificationId, requestMeta(req)));
  });

  // GET /api/attendance-qr/:id    has my code been scanned yet?
  router.get('/:id', async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    res.json(await dailyQr.progress(identityMarkingAttendance(req), id));
  });

  return router;
}
