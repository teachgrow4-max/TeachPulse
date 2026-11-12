import { Router, type RequestHandler } from 'express';
import type { EmployeeQrService } from '../employee-qr/service.js';
import { requestMeta } from '../lib/request-meta.js';
import type { AuthMiddleware } from '../middleware/authenticate.js';

export interface EmployeeQrRouterDeps {
  auth: AuthMiddleware;
  qr: EmployeeQrService;
  userLimiter: RequestHandler;
}

/**
 * A signed-in person's own QR code, for their profile page and the ID-card download.
 * The office display account has no personal code and is not let in.
 */
export function employeeQrRouter(deps: EmployeeQrRouterDeps): Router {
  const { auth, qr } = deps;
  const router = Router();

  router.use(
    auth.authenticate(),
    auth.requireRole('employee', 'admin', 'attendance_operator'),
    deps.userLimiter,
  );

  // GET /api/employee-qr/me
  // { status: ACTIVE | REVOKED | NONE, payload: "TGE1.…" | null, holder: {…}, … }
  router.get('/me', async (req, res) => {
    res.json(await qr.getMine(req.auth!.identity, requestMeta(req)));
  });

  return router;
}
