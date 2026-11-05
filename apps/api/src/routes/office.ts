import { Router, type RequestHandler } from 'express';
import { qrCheckRequestSchema } from '@teachgrow/shared';
import { normalizeIp } from '../lib/request-meta.js';
import type { AuthMiddleware } from '../middleware/authenticate.js';
import type { QrService } from '../verification/qr-service.js';
import { identityMarkingAttendance } from './helpers.js';

export interface OfficeRouterDeps {
  auth: AuthMiddleware;
  qr: QrService;
  userLimiter: RequestHandler;
}

export function officeRouter(deps: OfficeRouterDeps): Router {
  const { auth, qr } = deps;
  const router = Router();

  // GET /api/office/qr/current
  // The lobby display (and an administrator previewing it). Employees cannot read upcoming codes.
  router.get(
    '/qr/current',
    auth.authenticate(),
    auth.requireRole('office_display', 'admin'),
    deps.userLimiter,
    async (_req, res) => {
      res.json(await qr.current());
    },
  );

  // POST /api/office/qr/verify
  // Instant "is this code valid?" feedback after scanning. Does not consume the code.
  router.post(
    '/qr/verify',
    auth.authenticate(),
    auth.requireRole('employee', 'admin'),
    deps.userLimiter,
    async (req, res) => {
      const identity = identityMarkingAttendance(req);
      const body = qrCheckRequestSchema.parse(req.body ?? {});
      res.json(await qr.precheck(identity.id, body.payload, normalizeIp(req.ip)));
    },
  );

  return router;
}
