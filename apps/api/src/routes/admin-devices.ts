import { Router } from 'express';
import { adminDevicesQuerySchema, revokeDeviceRequestSchema, uuidSchema } from '@teachgrow/shared';
import type { DeviceService } from '../devices/service.js';
import { requestMeta } from '../lib/request-meta.js';
import { actorOf } from './helpers.js';

export interface AdminDevicesRouterDeps {
  devices: DeviceService;
}

/** Mounted under `/api/admin`, after `authenticate` + `requireRole('admin')`. */
export function adminDevicesRouter({ devices }: AdminDevicesRouterDeps): Router {
  const router = Router();

  // GET /api/admin/devices?employeeId=&status=&page=&pageSize=   (pending approvals first)
  router.get('/', async (req, res) => {
    const query = adminDevicesQuerySchema.parse(req.query);
    res.json(await devices.adminList(query));
  });

  // POST /api/admin/devices/:id/approve
  router.post('/:id/approve', async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    res.json({ device: await devices.approve(actorOf(req), id, requestMeta(req)) });
  });

  // POST /api/admin/devices/:id/revoke   { reason }
  router.post('/:id/revoke', async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const body = revokeDeviceRequestSchema.parse(req.body ?? {});
    res.json({ device: await devices.revoke(actorOf(req), id, body.reason, requestMeta(req)) });
  });

  return router;
}
