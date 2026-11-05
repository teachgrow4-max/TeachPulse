import { Router, type RequestHandler } from 'express';
import { attendanceChallengeRequestSchema, verifyRequestSchema } from '@teachgrow/shared';
import type { DeviceService } from '../devices/service.js';
import { AppError } from '../lib/errors.js';
import { normalizeIp, requestMeta } from '../lib/request-meta.js';
import type { AuthMiddleware } from '../middleware/authenticate.js';
import type { VerificationService } from '../verification/service.js';
import { identityMarkingAttendance } from './helpers.js';

export interface AttendanceRouterDeps {
  auth: AuthMiddleware;
  verification: VerificationService;
  devices: DeviceService;
  userLimiter: RequestHandler;
  /** Each attempt writes evidence, so this is tighter than the general per-user limit. */
  verifyLimiter: RequestHandler;
}

/**
 * Attendance endpoints for people who mark attendance. Every route is behind `authenticate`.
 * (Check-in, check-out and breaks join these in Phase 6.)
 */
export function attendanceRouter(deps: AttendanceRouterDeps): Router {
  const { auth, verification, devices } = deps;
  const router = Router();

  router.use(auth.authenticate(), auth.requireRole('employee', 'admin'), deps.userLimiter);

  // POST /api/attendance/challenge   { deviceId, purpose }
  // A one-time challenge for the registered device to sign (or, for a browser, WebAuthn options).
  router.post('/challenge', async (req, res) => {
    const identity = identityMarkingAttendance(req);
    const body = attendanceChallengeRequestSchema.parse(req.body ?? {});
    res.json(await devices.issueVerificationChallenge(identity, body));
  });

  // POST /api/attendance/verify   { purpose, channel, gps?, qr?, device? }
  // 200 with a short-lived, single-use verification; 422 VERIFICATION_FAILED with the reasons.
  router.post('/verify', deps.verifyLimiter, async (req, res) => {
    const identity = identityMarkingAttendance(req);
    const request = verifyRequestSchema.parse(req.body ?? {});
    const outcome = await verification.verify({
      identity,
      request,
      ip: normalizeIp(req.ip),
      meta: requestMeta(req),
    });
    if (!outcome.verified) {
      const { reasons } = outcome.details;
      throw new AppError('VERIFICATION_FAILED', reasons.map((r) => r.message).join(' '), {
        details: outcome.details,
      });
    }
    res.json(outcome.response);
  });

  return router;
}
