import { Router, type RequestHandler } from 'express';
import { scanRequestSchema } from '@teachgrow/shared';
import { normalizeIp, requestMeta } from '../lib/request-meta.js';
import type { AuthMiddleware } from '../middleware/authenticate.js';
import type { QrAttendanceService } from '../qr-attendance/service.js';

export interface QrAttendanceRouterDeps {
  auth: AuthMiddleware;
  scanner: QrAttendanceService;
  userLimiter: RequestHandler;
  /** A camera can read several codes a second; this is a generous per-person ceiling. */
  scanLimiter: RequestHandler;
}

/**
 * The QR attendance scanner, for administrators and attendance operators ONLY.
 *
 * An employee account is refused here (403, and the attempt is audited): being signed in, or
 * holding somebody's QR code, never lets anyone record attendance.
 *
 * There is deliberately no location or network check on the scanner: staff may scan from
 * anywhere. The proof of presence is the employee's, carried by their short-lived code.
 */
export function qrAttendanceRouter(deps: QrAttendanceRouterDeps): Router {
  const { auth, scanner } = deps;
  const router = Router();

  router.use(
    auth.authenticate(),
    auth.requireRole('admin', 'attendance_operator'),
    deps.userLimiter,
  );

  // POST /api/qr-attendance/scan   { payload, scanner: { kind, label?, camera? } }
  // Validates the code and records the attendance in one step. 200 with the employee and the
  // day's record; 4xx with the reason (and details.employee / details.firstRecordedAt) otherwise.
  router.post('/scan', deps.scanLimiter, async (req, res) => {
    const body = scanRequestSchema.parse(req.body ?? {});
    res.json(await scanner.scan(req.auth!.identity, body, normalizeIp(req.ip), requestMeta(req)));
  });

  // GET /api/qr-attendance/recent?limit=10   the caller's own latest scans
  router.get('/recent', async (req, res) => {
    const limit = Math.min(
      50,
      Math.max(1, Number.parseInt(String(req.query.limit ?? '10'), 10) || 10),
    );
    res.json({ items: await scanner.recent(req.auth!.identity, limit) });
  });

  return router;
}
