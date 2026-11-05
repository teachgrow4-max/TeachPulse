import { Router } from 'express';
import {
  createNetworkSchema,
  officeSettingsUpdateSchema,
  officeTestRequestSchema,
  updateNetworkSchema,
  uuidSchema,
} from '@teachgrow/shared';
import { normalizeIp, requestMeta } from '../lib/request-meta.js';
import type { OfficeService } from '../office/service.js';
import { actorOf } from './helpers.js';

/**
 * Office configuration (administrator only; mounted under /api/admin/office behind the admin
 * router's authentication, role and rate-limit middleware).
 */
export function adminOfficeRouter(deps: { office: OfficeService }): Router {
  const { office } = deps;
  const router = Router();

  // GET /api/admin/office/settings
  router.get('/settings', async (_req, res) => {
    res.json(await office.getSettings());
  });

  // PUT /api/admin/office/settings  (creates the office the first time; later changes only what is sent)
  router.put('/settings', async (req, res) => {
    const body = officeSettingsUpdateSchema.parse(req.body ?? {});
    res.json(await office.updateSettings(body, actorOf(req), requestMeta(req)));
  });

  // GET /api/admin/office/networks
  router.get('/networks', async (_req, res) => {
    res.json({ items: await office.listNetworks() });
  });

  // POST /api/admin/office/networks
  router.post('/networks', async (req, res) => {
    const body = createNetworkSchema.parse(req.body ?? {});
    const created = await office.addNetwork(body, actorOf(req), requestMeta(req));
    res.status(201).json(created);
  });

  // PUT /api/admin/office/networks/:id
  router.put('/networks/:id', async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const body = updateNetworkSchema.parse(req.body ?? {});
    res.json(await office.updateNetwork(id, body, actorOf(req), requestMeta(req)));
  });

  // DELETE /api/admin/office/networks/:id
  router.delete('/networks/:id', async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    await office.deleteNetwork(id, actorOf(req), requestMeta(req));
    res.status(204).end();
  });

  // POST /api/admin/office/test  (try a location and/or address against the saved configuration)
  router.post('/test', async (req, res) => {
    const body = officeTestRequestSchema.parse(req.body ?? {});
    res.json(await office.test(body, normalizeIp(req.ip)));
  });

  return router;
}
