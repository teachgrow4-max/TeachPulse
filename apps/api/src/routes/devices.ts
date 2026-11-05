import { Router, type RequestHandler } from 'express';
import {
  registerDeviceRequestSchema,
  registerOptionsRequestSchema,
  uuidSchema,
} from '@teachgrow/shared';
import type { DeviceService } from '../devices/service.js';
import { requestMeta } from '../lib/request-meta.js';
import type { AuthMiddleware } from '../middleware/authenticate.js';
import { identityMarkingAttendance } from './helpers.js';

export interface DevicesRouterDeps {
  auth: AuthMiddleware;
  devices: DeviceService;
  userLimiter: RequestHandler;
  /** Tighter than the general limit: enrolling a device is rare, and involves a password check. */
  registrationLimiter: RequestHandler;
}

/**
 * An employee's own devices. Every route is behind `authenticate` and is limited to people who
 * mark attendance; nothing here can see or touch anyone else's device.
 */
export function devicesRouter(deps: DevicesRouterDeps): Router {
  const { auth, devices } = deps;
  const router = Router();

  router.use(auth.authenticate(), auth.requireRole('employee', 'admin'), deps.userLimiter);

  // GET /api/devices
  router.get('/', async (req, res) => {
    const identity = identityMarkingAttendance(req);
    res.json({ items: await devices.listMine(identity.id) });
  });

  // POST /api/devices/register/options   (step 1: a one-time challenge)
  router.post('/register/options', deps.registrationLimiter, async (req, res) => {
    const identity = identityMarkingAttendance(req);
    const body = registerOptionsRequestSchema.parse(req.body ?? {});
    res.json(await devices.registerOptions(identity, body));
  });

  // POST /api/devices/register           (step 2: password + proof of the device key)
  router.post('/register', deps.registrationLimiter, async (req, res) => {
    const identity = identityMarkingAttendance(req);
    const body = registerDeviceRequestSchema.parse(req.body ?? {});
    const device = await devices.register(identity, body, requestMeta(req));
    res.status(201).location(`/api/devices/${device.id}`).json({ device });
  });

  // DELETE /api/devices/:id
  router.delete('/:id', async (req, res) => {
    const identity = identityMarkingAttendance(req);
    const id = uuidSchema.parse(req.params.id);
    res.json({ device: await devices.removeMine(identity, id, requestMeta(req)) });
  });

  return router;
}
