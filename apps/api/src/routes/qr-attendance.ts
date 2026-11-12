import { Router, type RequestHandler } from 'express';
import {
  confirmScanRequestSchema,
  idempotencyKeySchema,
  scanRequestSchema,
  scanVerifyRequestSchema,
  scannerChallengeRequestSchema,
  uuidSchema,
} from '@teachgrow/shared';
import type { DeviceService } from '../devices/service.js';
import { AppError } from '../lib/errors.js';
import { normalizeIp, requestMeta } from '../lib/request-meta.js';
import type { AuthMiddleware } from '../middleware/authenticate.js';
import type { QrAttendanceService } from '../qr-attendance/service.js';

export interface QrAttendanceRouterDeps {
  auth: AuthMiddleware;
  scanner: QrAttendanceService;
  devices: DeviceService;
  userLimiter: RequestHandler;
  /** A camera can read several codes a second; this is a generous per-person ceiling. */
  scanLimiter: RequestHandler;
  /** Each attempt writes evidence, so this is tighter than the general per-user limit. */
  verifyLimiter: RequestHandler;
}

/** `Idempotency-Key` is mandatory for anything that records attendance. */
function idempotencyKeyOf(header: string | undefined): string {
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'An Idempotency-Key header is required.', {
      details: [
        {
          path: 'Idempotency-Key',
          message:
            header === undefined ? 'Required.' : (parsed.error.issues[0]?.message ?? 'Invalid.'),
        },
      ],
    });
  }
  return parsed.data;
}

/**
 * The QR attendance scanner, for administrators and attendance operators ONLY.
 *
 * An employee account is refused here (403, and the attempt is audited): holding a copy of
 * somebody's QR code, or being signed in at all, never lets anyone record attendance. Recording
 * needs a person with the right role who is also provably at the office.
 */
export function qrAttendanceRouter(deps: QrAttendanceRouterDeps): Router {
  const { auth, scanner, devices } = deps;
  const router = Router();

  router.use(
    auth.authenticate(),
    auth.requireRole('admin', 'attendance_operator'),
    deps.userLimiter,
  );

  // POST /api/qr-attendance/scan   { payload, scanner: { kind, label?, camera? } }
  // Reads a code. 200 with the employee and what would happen; 422 if the code is not acceptable.
  router.post('/scan', deps.scanLimiter, async (req, res) => {
    const body = scanRequestSchema.parse(req.body ?? {});
    res.json(await scanner.scan(req.auth!.identity, body, normalizeIp(req.ip), requestMeta(req)));
  });

  // POST /api/qr-attendance/challenge   { deviceId }
  // A one-time challenge for the operator's registered device (only if the policy asks for it).
  router.post('/challenge', async (req, res) => {
    const body = scannerChallengeRequestSchema.parse(req.body ?? {});
    res.json(
      await devices.issueVerificationChallenge(req.auth!.identity, {
        deviceId: body.deviceId,
        purpose: 'ADMIN_SCAN',
      }),
    );
  });

  // POST /api/qr-attendance/scans/:id/verify   { channel, gps?, qr?, device? }
  // The operator proves they are at the office. 200 with a short-lived, single-use verification;
  // 422 VERIFICATION_FAILED with the reasons.
  router.post('/scans/:id/verify', deps.verifyLimiter, async (req, res) => {
    const scanId = uuidSchema.parse(req.params.id);
    const body = scanVerifyRequestSchema.parse(req.body ?? {});
    res.json(
      await scanner.verify(req.auth!.identity, scanId, body, normalizeIp(req.ip), requestMeta(req)),
    );
  });

  // POST /api/qr-attendance/scans/:id/confirm   { action }      Idempotency-Key: <8-128 chars>
  // Records the attendance the scan showed. Safe to retry with the same key.
  router.post('/scans/:id/confirm', async (req, res) => {
    const scanId = uuidSchema.parse(req.params.id);
    const key = idempotencyKeyOf(req.get('idempotency-key'));
    const body = confirmScanRequestSchema.parse(req.body ?? {});
    const result = await scanner.confirm(req.auth!.identity, scanId, body, key, requestMeta(req));
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
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
