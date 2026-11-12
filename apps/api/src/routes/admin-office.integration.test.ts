import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Account,
  accessTokenFor,
  auditRows,
  bearer,
  createAccount,
  useApi,
} from '../testing/api-harness.js';

const h = useApi();

let admin: Account;
let token: string;

beforeEach(async () => {
  admin = await createAccount(h, { role: 'admin' });
  token = await accessTokenFor(h, admin);
});

const get = (path: string, t = token) => request(h.app).get(path).set(bearer(t));
const put = (path: string, body: object, t = token) =>
  request(h.app).put(path).set(bearer(t)).send(body);
const post = (path: string, body: object = {}, t = token) =>
  request(h.app).post(path).set(bearer(t)).send(body);
const del = (path: string, t = token) => request(h.app).delete(path).set(bearer(t));

// Synthetic coordinates: this codebase never contains the company's real location.
const OFFICE = { name: 'Test Office', latitude: 10, longitude: 20 };
const configure = (patch: object = {}) =>
  put('/api/admin/office/settings', { ...OFFICE, ...patch });
const addNetwork = (cidr: string, label = 'Main line') =>
  post('/api/admin/office/networks', { label, cidr });

describe('who may configure the office', () => {
  const id = randomUUID();
  const routes: Array<[string, string, object | undefined]> = [
    ['get', '/api/admin/office/settings', undefined],
    ['put', '/api/admin/office/settings', OFFICE],
    ['get', '/api/admin/office/networks', undefined],
    ['post', '/api/admin/office/networks', { label: 'x', cidr: '203.0.113.10' }],
    ['put', `/api/admin/office/networks/${id}`, { label: 'y' }],
    ['delete', `/api/admin/office/networks/${id}`, undefined],
    ['post', '/api/admin/office/test', {}],
  ];
  const call = (method: string, path: string, body: object | undefined, t?: string) => {
    let r = request(h.app)[method as 'get'](path);
    if (t) r = r.set(bearer(t));
    return body ? r.send(body) : r;
  };

  it.each(routes)('%s %s needs a signed-in user', async (method, path, body) => {
    expect((await call(method, path, body)).status).toBe(401);
  });

  it.each(routes)('%s %s is forbidden to employees', async (method, path, body) => {
    const employee = await createAccount(h);
    const res = await call(method, path, body, await accessTokenFor(h, employee));
    expect(res.status).toBe(403);
  });

  it('is forbidden to the office display account', async () => {
    const kiosk = await createAccount(h, { role: 'office_display' });
    expect((await get('/api/admin/office/settings', await accessTokenFor(h, kiosk))).status).toBe(
      403,
    );
  });

  it('never changes anything when an employee tries', async () => {
    const employee = await createAccount(h);
    await put('/api/admin/office/settings', OFFICE, await accessTokenFor(h, employee));
    const rows = await h.testDb.query('select 1 from public.office_locations');
    expect(rows).toHaveLength(0);
  });
});

describe('office settings', () => {
  it('reports "not configured" until an administrator sets the office up', async () => {
    const res = await get('/api/admin/office/settings');
    expect(res.status).toBe(200);
    expect(res.body.office).toBeNull();
    expect(res.body.networks).toEqual([]);
    expect(res.body.readiness.ready).toBe(false);
    expect(res.body.readiness.issues[0].code).toBe('OFFICE_NOT_CONFIGURED');
  });

  it('creates the office with the documented defaults', async () => {
    const res = await configure({ address: '1 Example Street' });
    expect(res.status).toBe(200);
    expect(res.body.office).toMatchObject({
      name: 'Test Office',
      address: '1 Example Street',
      latitude: 10,
      longitude: 20,
      geofenceRadiusM: 150,
      maxGpsAccuracyM: 50,
      maxFixAgeSeconds: 30,
      qrRotationSeconds: 30,
      timezone: 'Asia/Kolkata',
      workingDays: [1, 2, 3, 4, 5, 6],
    });
    expect(res.body.office.id).toBeTruthy();

    const [entry] = await auditRows(h, 'office.create');
    expect(entry).toMatchObject({ actor_id: admin.id, entity_type: 'office' });
    expect(entry!.after_data).toMatchObject({
      name: 'Test Office',
      latitude: 10,
      geofenceRadiusM: 150,
    });
  });

  it('requires name, latitude and longitude the first time, and says which are missing', async () => {
    const res = await put('/api/admin/office/settings', { geofenceRadiusM: 150 });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'latitude',
      'longitude',
      'name',
    ]);
    expect(await h.testDb.query('select 1 from public.office_locations')).toHaveLength(0);
  });

  it('changes only the fields sent, and audits exactly those (before and after)', async () => {
    await configure();
    const res = await put('/api/admin/office/settings', {
      geofenceRadiusM: 250,
      qrRotationSeconds: 45,
    });
    expect(res.status).toBe(200);
    expect(res.body.office).toMatchObject({
      name: 'Test Office',
      latitude: 10,
      geofenceRadiusM: 250,
      qrRotationSeconds: 45,
      maxGpsAccuracyM: 50,
    });
    const [entry] = await auditRows(h, 'office.update');
    expect(entry!.before_data).toEqual({ geofenceRadiusM: 150, qrRotationSeconds: 30 });
    expect(entry!.after_data).toEqual({ geofenceRadiusM: 250, qrRotationSeconds: 45 });
  });

  it('writes no audit entry when nothing actually changed', async () => {
    await configure();
    await put('/api/admin/office/settings', { geofenceRadiusM: 150 });
    expect(await auditRows(h, 'office.update')).toHaveLength(0);
  });

  it('keeps one office: a second PUT updates it instead of creating another', async () => {
    await configure();
    await configure({ name: 'Renamed Office' });
    const rows = await h.testDb.query('select 1 from public.office_locations');
    expect(rows).toHaveLength(1);
    expect((await get('/api/admin/office/settings')).body.office.name).toBe('Renamed Office');
  });

  it('stores working days sorted, and the location to six decimal places', async () => {
    const res = await configure({
      workingDays: [6, 1, 3],
      latitude: 12.97160049,
      longitude: 77.59460049,
    });
    expect(res.body.office.workingDays).toEqual([1, 3, 6]);
    expect(res.body.office.latitude).toBeCloseTo(12.9716, 6);
    expect(res.body.office.longitude).toBeCloseTo(77.5946, 6);
  });

  it.each([
    ['a latitude above 90', { latitude: 91 }],
    ['a longitude above 180', { longitude: 181 }],
    ['the null-island coordinates 0, 0', { latitude: 0, longitude: 0 }],
    ['a radius under 10 m', { geofenceRadiusM: 5 }],
    ['a radius over 5000 m', { geofenceRadiusM: 5001 }],
    ['an accuracy limit under 5 m', { maxGpsAccuracyM: 4 }],
    ['an accuracy limit over 500 m', { maxGpsAccuracyM: 501 }],
    ['a fix age under 5 s', { maxFixAgeSeconds: 4 }],
    ['a fix age over 300 s', { maxFixAgeSeconds: 301 }],
    ['a rotation under 30 s', { qrRotationSeconds: 29 }],
    ['a rotation over 60 s', { qrRotationSeconds: 61 }],
    ['an unknown timezone', { timezone: 'Mars/Olympus' }],
    ['no working days', { workingDays: [] }],
    ['a weekday 0', { workingDays: [0, 1] }],
    ['a weekday 8', { workingDays: [1, 8] }],
    ['a repeated weekday', { workingDays: [1, 1, 2] }],
    ['an unknown setting', { isActive: false }],
    ['a non-numeric radius', { geofenceRadiusM: '100' }],
  ])('rejects %s and saves nothing', async (_label, patch) => {
    const res = await configure(patch);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await h.testDb.query('select 1 from public.office_locations')).toHaveLength(0);
  });

  it('rejects an empty update', async () => {
    await configure();
    expect((await put('/api/admin/office/settings', {})).status).toBe(400);
  });

  describe('readiness', () => {
    it('lists what still blocks employees, and clears each item as it is fixed', async () => {
      await configure();
      const issues = async () =>
        (await get('/api/admin/office/settings')).body.readiness.issues.map(
          (i: { code: string }) => i.code,
        );
      expect(await issues()).toEqual(['NO_ACTIVE_NETWORK', 'NO_QR_DISPLAY_ACCOUNT']);

      await addNetwork('203.0.113.10');
      expect(await issues()).toEqual(['NO_QR_DISPLAY_ACCOUNT']);

      await createAccount(h, { role: 'office_display' });
      expect(await issues()).toEqual([]);
      expect((await get('/api/admin/office/settings')).body.readiness.ready).toBe(true);
    });

    it('warns when the only networks are private addresses the server can never see', async () => {
      await configure();
      await createAccount(h, { role: 'office_display' });
      await addNetwork('192.168.1.0/24');
      const { readiness } = (await get('/api/admin/office/settings')).body;
      expect(readiness.issues.map((i: { code: string }) => i.code)).toEqual([
        'ONLY_NON_PUBLIC_NETWORKS',
      ]);
    });

    it('warns when the accepted GPS inaccuracy is larger than the geofence', async () => {
      await configure({ geofenceRadiusM: 30, maxGpsAccuracyM: 100 });
      const codes = (await get('/api/admin/office/settings')).body.readiness.issues.map(
        (i: { code: string }) => i.code,
      );
      expect(codes).toContain('ACCURACY_EXCEEDS_RADIUS');
    });

    it('does not count a deactivated display account', async () => {
      await configure();
      await addNetwork('203.0.113.10');
      const kiosk = await createAccount(h, { role: 'office_display', active: false });
      expect(kiosk.id).toBeTruthy();
      const codes = (await get('/api/admin/office/settings')).body.readiness.issues.map(
        (i: { code: string }) => i.code,
      );
      expect(codes).toContain('NO_QR_DISPLAY_ACCOUNT');
    });
  });
});

describe('office networks', () => {
  beforeEach(async () => {
    await configure();
  });

  it('stores a single IPv4 address as a /32 and a range as given', async () => {
    const single = await addNetwork('203.0.113.10');
    expect(single.status).toBe(201);
    expect(single.body.network).toMatchObject({
      cidr: '203.0.113.10/32',
      label: 'Main line',
      isActive: true,
    });
    expect(single.body.network.nonPublic).toBe(false);
    expect(single.body.warnings).toEqual([]);

    const range = await addNetwork('198.51.100.0/29', 'Backup line');
    expect(range.body.network.cidr).toBe('198.51.100.0/29');
  });

  it('supports IPv6 addresses and ranges', async () => {
    expect((await addNetwork('2001:db8::1')).body.network.cidr).toBe('2001:db8::1/128');
    expect((await addNetwork('2001:db8:1::/48', 'v6 range')).body.network.cidr).toBe(
      '2001:db8:1::/48',
    );
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 address it is', async () => {
    expect((await addNetwork('::ffff:203.0.113.77')).body.network.cidr).toBe('203.0.113.77/32');
  });

  it('records who added it', async () => {
    const created = await addNetwork('203.0.113.10');
    const [entry] = await auditRows(h, 'office.network.add');
    expect(entry).toMatchObject({ actor_id: admin.id, entity_id: created.body.network.id });
    expect(entry!.after_data).toEqual({ label: 'Main line', cidr: '203.0.113.10/32' });
  });

  it.each([
    ['text', 'hello'],
    ['a short dotted address', '1.2.3'],
    ['an abbreviated address', '10.1'],
    ['an out-of-range octet', '203.0.113.256'],
    ['a prefix that is too long', '203.0.113.0/33'],
    ['only slashes', '//'],
    ['an injection attempt', "203.0.113.1'; drop table office_networks;--"],
  ])('rejects %s with a helpful message', async (_label, cidr) => {
    const res = await addNetwork(cidr);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('cidr');
    expect(res.body.error.details[0].message).toMatch(/203\.0\.113/);
  });

  it('rejects a range with host bits set, and suggests the network address', async () => {
    const res = await addNetwork('203.0.113.10/24');
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain('host bits');
    expect(res.body.error.details[0].message).toContain('203.0.113.0/24');
  });

  it.each(['10.0.0.0/8', '0.0.0.0/0', '203.0.0.0/15', '::/0', '2001:db8::/32'])(
    'refuses the over-broad range %s, which would admit far more than the office',
    async (cidr) => {
      const res = await addNetwork(cidr);
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].message).toMatch(/too broad/i);
    },
  );

  it('warns, but allows, a private range - and flags it in the list', async () => {
    const res = await addNetwork('192.168.1.0/24', 'Office LAN');
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual(['NON_PUBLIC_RANGE']);
    expect(res.body.network.nonPublic).toBe(true);
    for (const cidr of [
      '10.1.0.0/16',
      '172.16.0.0/16',
      '127.0.0.1',
      '169.254.1.1',
      '100.64.0.1',
      'fd00::1',
    ]) {
      expect((await addNetwork(cidr, cidr)).body.network.nonPublic, cidr).toBe(true);
    }
    expect((await addNetwork('203.0.113.9', 'public')).body.network.nonPublic).toBe(false);
  });

  it('refuses a duplicate, however it is written', async () => {
    await addNetwork('203.0.113.10');
    const same = await addNetwork('203.0.113.10/32');
    expect(same.status).toBe(409);
    expect(same.body.error.details[0].path).toBe('cidr');
  });

  it('needs the office to exist first', async () => {
    await h.testDb.exec('delete from public.office_locations');
    const res = await addNetwork('203.0.113.10');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/office location first/i);
  });

  it('validates the label', async () => {
    expect(
      (await post('/api/admin/office/networks', { label: '', cidr: '203.0.113.10' })).status,
    ).toBe(400);
    expect((await post('/api/admin/office/networks', { cidr: '203.0.113.10' })).status).toBe(400);
    expect(
      (
        await post('/api/admin/office/networks', {
          label: 'x',
          cidr: '203.0.113.10',
          isActive: false,
        })
      ).status,
    ).toBe(400);
  });

  it('lists networks, oldest first', async () => {
    await addNetwork('203.0.113.10', 'First');
    await addNetwork('198.51.100.7', 'Second');
    const list = await get('/api/admin/office/networks');
    expect(list.body.items.map((n: { label: string }) => n.label)).toEqual(['First', 'Second']);
  });

  describe('updating and removing', () => {
    it('renames, re-addresses and deactivates, auditing each change', async () => {
      const created = (await addNetwork('203.0.113.10', 'Old name')).body.network;

      const renamed = await put(`/api/admin/office/networks/${created.id}`, { label: 'New name' });
      expect(renamed.body.network.label).toBe('New name');

      const moved = await put(`/api/admin/office/networks/${created.id}`, {
        cidr: '198.51.100.0/29',
      });
      expect(moved.body.network.cidr).toBe('198.51.100.0/29');

      const off = await put(`/api/admin/office/networks/${created.id}`, { isActive: false });
      expect(off.body.network.isActive).toBe(false);

      const entries = await auditRows(h, 'office.network.update');
      expect(entries).toHaveLength(3);
      expect(entries[1]!.before_data).toMatchObject({ cidr: '203.0.113.10/32' });
      expect(entries[1]!.after_data).toMatchObject({ cidr: '198.51.100.0/29' });
    });

    it('writes no audit entry for a no-op update', async () => {
      const created = (await addNetwork('203.0.113.10', 'Same')).body.network;
      await put(`/api/admin/office/networks/${created.id}`, { label: 'Same' });
      expect(await auditRows(h, 'office.network.update')).toHaveLength(0);
    });

    it('applies the same address validation and duplicate protection as adding', async () => {
      const a = (await addNetwork('203.0.113.10')).body.network;
      await addNetwork('198.51.100.7');
      expect((await put(`/api/admin/office/networks/${a.id}`, { cidr: 'nonsense' })).status).toBe(
        400,
      );
      expect((await put(`/api/admin/office/networks/${a.id}`, { cidr: '10.0.0.0/8' })).status).toBe(
        400,
      );
      expect(
        (await put(`/api/admin/office/networks/${a.id}`, { cidr: '198.51.100.7' })).status,
      ).toBe(409);
    });

    it('rejects an empty update, an unknown id, and a malformed id', async () => {
      const a = (await addNetwork('203.0.113.10')).body.network;
      expect((await put(`/api/admin/office/networks/${a.id}`, {})).status).toBe(400);
      expect((await put(`/api/admin/office/networks/${randomUUID()}`, { label: 'x' })).status).toBe(
        404,
      );
      expect((await put('/api/admin/office/networks/not-a-uuid', { label: 'x' })).status).toBe(400);
    });

    it('deletes a network and records what was removed', async () => {
      const a = (await addNetwork('203.0.113.10', 'To remove')).body.network;
      expect((await del(`/api/admin/office/networks/${a.id}`)).status).toBe(204);
      expect((await get('/api/admin/office/networks')).body.items).toEqual([]);
      const [entry] = await auditRows(h, 'office.network.delete');
      expect(entry!.before_data).toEqual({ label: 'To remove', cidr: '203.0.113.10/32' });
      expect((await del(`/api/admin/office/networks/${a.id}`)).status).toBe(404);
      expect((await del('/api/admin/office/networks/xyz')).status).toBe(400);
    });
  });
});

describe('POST /api/admin/office/test', () => {
  const inside = (extra: object = {}) => ({
    latitude: 10,
    longitude: 20,
    accuracyM: 8,
    fixTime: h.clock.now().getTime() - 1000,
    ...extra,
  });

  it('needs the office to be set up', async () => {
    expect((await post('/api/admin/office/test', {})).status).toBe(409);
  });

  describe('location', () => {
    beforeEach(async () => {
      await configure();
    });

    it('passes a location at the office and shows the measured distance', async () => {
      const res = await post('/api/admin/office/test', { gps: inside() });
      expect(res.body.gps).toMatchObject({
        result: 'PASS',
        radiusM: 150,
        maxAccuracyM: 50,
        reasons: [],
      });
      expect(res.body.gps.distanceMeters).toBeCloseTo(0, 3);
    });

    it('fails one outside the radius, in plain words', async () => {
      const res = await post('/api/admin/office/test', { gps: inside({ latitude: 10.005 }) });
      expect(res.body.gps.result).toBe('FAIL');
      expect(res.body.gps.distanceMeters).toBeGreaterThan(500);
      expect(res.body.gps.reasons[0]).toMatchObject({ code: 'GPS_OUTSIDE_RADIUS' });
      expect(res.body.gps.reasons[0].message).toMatch(/you are about \d+ m from the office/i);
    });

    it('applies the saved accuracy and age limits', async () => {
      await put('/api/admin/office/settings', { maxGpsAccuracyM: 20, maxFixAgeSeconds: 10 });
      const fuzzy = await post('/api/admin/office/test', { gps: inside({ accuracyM: 25 }) });
      expect(fuzzy.body.gps.reasons[0].code).toBe('GPS_LOW_ACCURACY');
      const old = await post('/api/admin/office/test', {
        gps: inside({ fixTime: h.clock.now().getTime() - 15_000 }),
      });
      expect(old.body.gps.reasons[0].code).toBe('GPS_STALE');
    });

    it('does not test the location when none is given', async () => {
      const res = await post('/api/admin/office/test', {});
      expect(res.body.gps).toMatchObject({
        result: 'NOT_TESTED',
        distanceMeters: null,
        reasons: [],
      });
    });

    it('rejects a malformed location with 400', async () => {
      expect(
        (
          await post('/api/admin/office/test', {
            gps: { latitude: 95, longitude: 20, accuracyM: 5, fixTime: 1 },
          })
        ).status,
      ).toBe(400);
    });
  });

  describe('network', () => {
    beforeEach(async () => {
      await configure();
    });

    it('says the network is not set up when the allowlist is empty', async () => {
      const res = await post('/api/admin/office/test', {});
      expect(res.body.network.result).toBe('FAIL');
      expect(res.body.network.reasons[0].code).toBe('NETWORK_NOT_CONFIGURED');
    });

    it('tests the address this request came from by default', async () => {
      await addNetwork('198.51.100.0/24');
      const rejected = await post('/api/admin/office/test', {});
      expect(rejected.body.network).toMatchObject({
        result: 'FAIL',
        ipAddress: '127.0.0.1',
        source: 'request',
        matchedNetwork: null,
      });
      expect(rejected.body.network.reasons[0].code).toBe('NETWORK_NOT_ALLOWED');

      await addNetwork('127.0.0.1', 'This computer');
      const accepted = await post('/api/admin/office/test', {});
      expect(accepted.body.network).toMatchObject({
        result: 'PASS',
        ipAddress: '127.0.0.1',
        matchedNetwork: { label: 'This computer', cidr: '127.0.0.1/32' },
      });
    });

    it('tests an address you type, so the allowlist can be checked from anywhere', async () => {
      await addNetwork('203.0.113.8/29');
      const inRange = await post('/api/admin/office/test', { ipAddress: '203.0.113.12' });
      expect(inRange.body.network).toMatchObject({
        result: 'PASS',
        source: 'supplied',
        ipAddress: '203.0.113.12',
      });
      const outOfRange = await post('/api/admin/office/test', { ipAddress: '203.0.113.16' });
      expect(outOfRange.body.network.result).toBe('FAIL');
    });

    it('works for IPv6 and treats an IPv4-mapped address as IPv4', async () => {
      await addNetwork('2001:db8:1::/48');
      await addNetwork('203.0.113.10');
      expect(
        (await post('/api/admin/office/test', { ipAddress: '2001:db8:1::abcd' })).body.network
          .result,
      ).toBe('PASS');
      expect(
        (await post('/api/admin/office/test', { ipAddress: '2001:db8:2::1' })).body.network.result,
      ).toBe('FAIL');
      const mapped = await post('/api/admin/office/test', { ipAddress: '::ffff:203.0.113.10' });
      expect(mapped.body.network).toMatchObject({ result: 'PASS', ipAddress: '203.0.113.10' });
    });

    it('ignores deactivated networks', async () => {
      const n = (await addNetwork('203.0.113.10')).body.network;
      await put(`/api/admin/office/networks/${n.id}`, { isActive: false });
      const res = await post('/api/admin/office/test', { ipAddress: '203.0.113.10' });
      expect(res.body.network.reasons[0].code).toBe('NETWORK_NOT_CONFIGURED');
    });

    it('names the most specific matching entry when ranges overlap', async () => {
      await addNetwork('203.0.113.0/24', 'Whole block');
      await addNetwork('203.0.113.10', 'One address');
      const res = await post('/api/admin/office/test', { ipAddress: '203.0.113.10' });
      expect(res.body.network.matchedNetwork.label).toBe('One address');
    });

    it.each(['not-an-ip', '999.1.1.1', '203.0.113', ''])(
      'rejects the address %j',
      async (ipAddress) => {
        expect((await post('/api/admin/office/test', { ipAddress })).status).toBe(400);
      },
    );
  });

  it('reports the QR rotation in force', async () => {
    await configure({ qrRotationSeconds: 45 });
    const res = await post('/api/admin/office/test', {});
    expect(res.body.qr.rotationSeconds).toBe(45);
    expect(new Date(res.body.qr.currentWindow.expiresAt).getTime()).toBeGreaterThan(
      h.clock.now().getTime(),
    );
  });

  it('writes nothing: no verification rows and no audit entries', async () => {
    await configure();
    await addNetwork('203.0.113.10');
    const auditBefore = (await auditRows(h)).length;
    await post('/api/admin/office/test', { gps: inside(), ipAddress: '203.0.113.10' });
    expect((await auditRows(h)).length).toBe(auditBefore);
    expect(await h.testDb.query('select 1 from public.attendance_verifications')).toHaveLength(0);
  });
});
