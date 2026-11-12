import { Router } from 'express';
import {
  listEmployeeQrQuerySchema,
  listScansQuerySchema,
  regenerateQrRequestSchema,
  revokeQrRequestSchema,
  uuidSchema,
} from '@teachgrow/shared';
import type { EmployeeQrService } from '../employee-qr/service.js';
import { requestMeta } from '../lib/request-meta.js';
import type { QrAttendanceService } from '../qr-attendance/service.js';
import { actorOf } from './helpers.js';

export interface AdminEmployeeQrRouterDeps {
  qr: EmployeeQrService;
  scanner: QrAttendanceService;
}

/** Mounted under `/api/admin`, after `authenticate` + `requireRole('admin')`. */
export function adminEmployeeQrRouter(deps: AdminEmployeeQrRouterDeps): Router {
  const { qr, scanner } = deps;
  const router = Router();

  // GET /api/admin/employee-qr?search=&qrStatus=ACTIVE|REVOKED|NONE&departmentId=&page=&pageSize=
  router.get('/employee-qr', async (req, res) => {
    res.json(await qr.list(listEmployeeQrQuerySchema.parse(req.query)));
  });

  // POST /api/admin/employee-qr/backfill   (everybody who has never had a code gets one)
  router.post('/employee-qr/backfill', async (req, res) => {
    res.json(await qr.backfill(actorOf(req), requestMeta(req)));
  });

  // GET /api/admin/employee-qr/:employeeId   the code itself, and every code they have had
  router.get('/employee-qr/:employeeId', async (req, res) => {
    const employeeId = uuidSchema.parse(req.params.employeeId);
    res.json(await qr.getForAdmin(employeeId, actorOf(req), requestMeta(req)));
  });

  // POST /api/admin/employee-qr/:employeeId/regenerate   { reason? }
  router.post('/employee-qr/:employeeId/regenerate', async (req, res) => {
    const employeeId = uuidSchema.parse(req.params.employeeId);
    const body = regenerateQrRequestSchema.parse(req.body ?? {});
    res.json(await qr.regenerate(employeeId, actorOf(req), body.reason, requestMeta(req)));
  });

  // POST /api/admin/employee-qr/:employeeId/revoke   { reason }
  router.post('/employee-qr/:employeeId/revoke', async (req, res) => {
    const employeeId = uuidSchema.parse(req.params.employeeId);
    const body = revokeQrRequestSchema.parse(req.body ?? {});
    res.json(await qr.revoke(employeeId, actorOf(req), body.reason, requestMeta(req)));
  });

  // GET /api/admin/qr-scans?from=&to=&employeeId=&scannedBy=&status=&page=&pageSize=
  router.get('/qr-scans', async (req, res) => {
    res.json(await scanner.history(listScansQuerySchema.parse(req.query)));
  });

  return router;
}
