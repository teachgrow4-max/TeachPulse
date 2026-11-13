import { Router, type RequestHandler } from 'express';
import {
  createDepartmentSchema,
  createEmployeeSchema,
  dailyAttendanceQuerySchema,
  listEmployeesQuerySchema,
  qrOverviewQuerySchema,
  updateEmployeeSchema,
  uuidSchema,
} from '@teachgrow/shared';
import type { DailyAttendanceReportService } from '../attendance/daily-report.js';
import type { QrOverviewService } from '../attendance/qr-overview.js';
import type { DeviceService } from '../devices/service.js';
import type { EmployeeQrService } from '../employee-qr/service.js';
import type { EmployeeService } from '../employees/service.js';
import type { OfficeService } from '../office/service.js';
import { requestMeta } from '../lib/request-meta.js';
import type { AuthMiddleware } from '../middleware/authenticate.js';
import type { QrAttendanceService } from '../qr-attendance/service.js';
import { adminDevicesRouter } from './admin-devices.js';
import { adminEmployeeQrRouter } from './admin-employee-qr.js';
import { adminOfficeRouter } from './admin-office.js';
import { actorOf } from './helpers.js';

export interface AdminRouterDeps {
  auth: AuthMiddleware;
  employees: EmployeeService;
  office: OfficeService;
  devices: DeviceService;
  employeeQr: EmployeeQrService;
  qrAttendance: QrAttendanceService;
  dailyReport: DailyAttendanceReportService;
  qrOverview: QrOverviewService;
  userLimiter: RequestHandler;
}

/**
 * Administrator-only endpoints. Every route here sits behind `authenticate` (valid session,
 * active account, no pending forced password change) and `requireRole('admin')`.
 */
export function adminRouter(deps: AdminRouterDeps): Router {
  const { auth, employees, office, devices, employeeQr, qrAttendance, dailyReport, qrOverview } =
    deps;
  const router = Router();

  router.use(auth.authenticate(), auth.requireRole('admin'), deps.userLimiter);

  router.use('/office', adminOfficeRouter({ office }));
  router.use('/devices', adminDevicesRouter({ devices }));
  router.use(adminEmployeeQrRouter({ qr: employeeQr, scanner: qrAttendance }));

  // GET /api/admin/attendance/daily?date=YYYY-MM-DD   who is in, late and absent on a day
  router.get('/attendance/daily', async (req, res) => {
    const query = dailyAttendanceQuerySchema.parse(req.query);
    res.json(await dailyReport.forDate(query.date));
  });

  // GET /api/admin/qr/overview?date=&search=&departmentId=&state=&page=&pageSize=
  //   where each employee's attendance QR stands on a day (live, scanned, expired, never made)
  router.get('/qr/overview', async (req, res) => {
    const query = qrOverviewQuerySchema.parse(req.query);
    res.json(await qrOverview.overview(query));
  });

  // ---- departments ---------------------------------------------------------------------
  router.get('/departments', async (_req, res) => {
    res.json({ items: await employees.listDepartments() });
  });

  router.post('/departments', async (req, res) => {
    const body = createDepartmentSchema.parse(req.body ?? {});
    const department = await employees.createDepartment(body.name, actorOf(req), requestMeta(req));
    res.status(201).json({ department });
  });

  // ---- employees -----------------------------------------------------------------------
  router.get('/employees', async (req, res) => {
    const query = listEmployeesQuerySchema.parse(req.query);
    res.json(await employees.list(query));
  });

  router.post('/employees', async (req, res) => {
    const body = createEmployeeSchema.parse(req.body ?? {});
    const created = await employees.create(body, actorOf(req), requestMeta(req));
    res.status(201).location(`/api/admin/employees/${created.employee.id}`).json(created);
  });

  router.get('/employees/:id', async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    res.json({ employee: await employees.get(id) });
  });

  router.put('/employees/:id', async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const body = updateEmployeeSchema.parse(req.body ?? {});
    res.json(await employees.update(id, body, actorOf(req), requestMeta(req)));
  });

  router.post('/employees/:id/reset-password', async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    res.json(await employees.resetPassword(id, actorOf(req), requestMeta(req)));
  });

  return router;
}
