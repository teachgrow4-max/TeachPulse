import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  VERIFICATION_LAYERS,
  verificationProofMessage,
  type VerificationLayer,
  type VerificationPurpose,
} from '@teachgrow/shared';
import { createLogger } from '../lib/logger.js';
import { attempt } from '../testing/harness.js';
import {
  type Account,
  QR_TEST_SECRET,
  START_TIME,
  WEB_ORIGIN,
  accessTokenFor,
  auditRows,
  bearer,
  createAccount,
  useApi,
} from '../testing/api-harness.js';
import { SoftwareAuthenticator } from '../testing/software-authenticator.js';
import { SoftwareDevice } from '../testing/software-device.js';
import { buildPayload, deriveCode, windowIndexAt } from '../verification/qr.js';

const h = useApi();

const T0 = Date.parse(START_TIME);
const RP_ID = 'app.test';
// Synthetic coordinates: this codebase never contains the company's real location.
const OFFICE = { latitude: 10, longitude: 20 };
const METRES_PER_DEGREE = 111_194.9; // great-circle, matching the server's Earth radius

type Layer = VerificationLayer;
type Body = Record<string, unknown>;

let admin: Account;
let employee: Account;
let colleague: Account;
let display: Account;
let tok: Record<'admin' | 'employee' | 'colleague' | 'display', string>;
let officeId: string;

beforeEach(async () => {
  admin = await createAccount(h, { role: 'admin', attendanceRequired: false });
  employee = await createAccount(h);
  colleague = await createAccount(h);
  display = await createAccount(h, { role: 'office_display' });
  tok = {
    admin: await accessTokenFor(h, admin),
    employee: await accessTokenFor(h, employee),
    colleague: await accessTokenFor(h, colleague),
    display: await accessTokenFor(h, display),
  };

  const res = await request(h.app)
    .put('/api/admin/office/settings')
    .set(bearer(tok.admin))
    .send({ name: 'Test Office', ...OFFICE });
  expect(res.status).toBe(200);
  officeId = res.body.office.id as string;
  // Requests in these tests really come from the loopback address.
  await allowNetwork('127.0.0.1/32');
});

// ---- small API wrappers -------------------------------------------------------------------------

const post = (path: string, body: Body = {}, t = tok.employee) =>
  request(h.app).post(path).set(bearer(t)).send(body);
const verify = (body: Body, t = tok.employee) => post('/api/attendance/verify', body, t);

async function allowNetwork(cidr: string, active = true) {
  await h.testDb.query(
    `insert into public.office_networks (office_id, label, cidr, is_active)
     values ($1, $2, $3::cidr, $4)`,
    [officeId, `Allowed ${cidr}`, cidr, active],
  );
}
const forgetNetworks = () => h.testDb.query('delete from public.office_networks');
const setPolicy = (patch: { web?: Layer[]; mobile?: Layer[]; checkOut?: Layer[] }) =>
  h.testDb.query(
    `update public.attendance_policies set
       check_in_layers_web    = coalesce($1::text[], check_in_layers_web::text[])::public.verification_layer[],
       check_in_layers_mobile = coalesce($2::text[], check_in_layers_mobile::text[])::public.verification_layer[],
       check_out_layers       = coalesce($3::text[], check_out_layers::text[])::public.verification_layer[]`,
    [patch.web ?? null, patch.mobile ?? null, patch.checkOut ?? null],
  );

// ---- evidence builders --------------------------------------------------------------------------

const northOfOffice = (metres: number) => OFFICE.latitude + metres / METRES_PER_DEGREE;

/** A good location fix: at the office, precise, five seconds old. */
const gps = (over: Body = {}) => ({
  latitude: OFFICE.latitude,
  longitude: OFFICE.longitude,
  accuracyM: 10,
  fixTime: h.clock.now().getTime() - 5_000,
  ...over,
});

const showing = async (): Promise<string> =>
  (await request(h.app).get('/api/office/qr/current').set(bearer(tok.display))).body.payload;
const qr = async () => ({ payload: await showing() });
/** A code minted locally for window `index`, as the lobby screen would show it. */
const mint = (index: number, secret = QR_TEST_SECRET) =>
  buildPayload(index, deriveCode(secret, { id: officeId, rotationSeconds: 30 }, index));
const windowNow = () => windowIndexAt(h.clock.now(), 30);

interface EnrolledPhone {
  phone: SoftwareDevice;
  deviceId: string;
  owner: Account;
  token: string;
}
interface EnrolledBrowser {
  passkey: SoftwareAuthenticator;
  deviceId: string;
  owner: Account;
  token: string;
}

async function approve(deviceId: string) {
  const res = await post(`/api/admin/devices/${deviceId}/approve`, {}, tok.admin);
  expect(res.status).toBe(200);
}

async function enrolPhone(
  opts: { who?: Account; token?: string; approved?: boolean } = {},
): Promise<EnrolledPhone> {
  const owner = opts.who ?? employee;
  const token = opts.token ?? tok.employee;
  const phone = new SoftwareDevice();
  const c = (await post('/api/devices/register/options', { platform: 'ANDROID' }, token)).body;
  const res = await post(
    '/api/devices/register',
    phone.registrationBody({
      challengeId: c.challengeId,
      challenge: c.challenge,
      employeeId: owner.id,
      password: owner.password,
    }),
    token,
  );
  expect(res.status).toBe(201);
  const deviceId = res.body.device.id as string;
  if (opts.approved !== false) await approve(deviceId);
  return { phone, deviceId, owner, token };
}

async function enrolBrowser(
  opts: {
    who?: Account;
    token?: string;
    approved?: boolean;
    passkey?: SoftwareAuthenticator;
  } = {},
): Promise<EnrolledBrowser> {
  const owner = opts.who ?? employee;
  const token = opts.token ?? tok.employee;
  const passkey = opts.passkey ?? new SoftwareAuthenticator({ origin: WEB_ORIGIN, rpId: RP_ID });
  const c = (await post('/api/devices/register/options', { platform: 'WEB' }, token)).body;
  const res = await post(
    '/api/devices/register',
    {
      challengeId: c.challengeId,
      platform: 'WEB',
      currentPassword: owner.password,
      webauthn: passkey.register({ challenge: c.webauthn.challenge }),
    },
    token,
  );
  expect(res.status).toBe(201);
  const deviceId = res.body.device.id as string;
  if (opts.approved !== false) await approve(deviceId);
  return { passkey, deviceId, owner, token };
}

const challengeFor = async (
  deviceId: string,
  purpose: VerificationPurpose,
  token = tok.employee,
) => {
  const res = await post('/api/attendance/challenge', { deviceId, purpose }, token);
  expect(res.status).toBe(200);
  return res.body as {
    challengeId: string;
    challenge: string;
    expiresAt: string;
    webauthn?: { challenge: string; allowCredentials: Array<{ id: string }> };
  };
};

/** The `device` evidence a phone sends for a check-in or check-out. */
async function phoneEvidence(p: EnrolledPhone, purpose: VerificationPurpose = 'CHECK_IN') {
  const c = await challengeFor(p.deviceId, purpose, p.token);
  return p.phone.evidence({
    challengeId: c.challengeId,
    challenge: c.challenge,
    employeeId: p.owner.id,
    deviceId: p.deviceId,
    purpose,
  });
}

/** The `device` evidence a browser sends for a check-in or check-out. */
async function browserEvidence(b: EnrolledBrowser, purpose: VerificationPurpose = 'CHECK_IN') {
  const c = await challengeFor(b.deviceId, purpose, b.token);
  return {
    deviceId: b.deviceId,
    challengeId: c.challengeId,
    proof: {
      type: 'WEBAUTHN' as const,
      response: b.passkey.assert({ challenge: c.webauthn!.challenge }),
    },
  };
}

/** A complete, valid mobile check-in. Tests change one thing and expect one consequence. */
async function mobileCheckIn(p: EnrolledPhone, over: Body = {}): Promise<Body> {
  return {
    purpose: 'CHECK_IN',
    channel: 'MOBILE',
    gps: gps(),
    qr: await qr(),
    device: await phoneEvidence(p),
    ...over,
  };
}
async function webCheckIn(b: EnrolledBrowser, over: Body = {}): Promise<Body> {
  return {
    purpose: 'CHECK_IN',
    channel: 'WEB',
    gps: gps(),
    qr: await qr(),
    device: await browserEvidence(b),
    ...over,
  };
}

// ---- assertions & database peeks ----------------------------------------------------------------

type Res = request.Response;
const layersOf = (res: Res) =>
  (res.body.error?.details ?? res.body).layers as Record<Layer, string>;
const reasonCodes = (res: Res): string[] =>
  (res.body.error.details.reasons as Array<{ code: string }>).map((r) => r.code);

function expectVerified(res: Res) {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.result).toBe('VERIFIED');
}
function expectRejected(res: Res, reasons: string[]) {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body.error.code).toBe('VERIFICATION_FAILED');
  expect(res.body.error.details.result).toBe('REJECTED');
  expect(reasonCodes(res)).toEqual(reasons);
}

interface VerificationRow {
  id: string;
  employee_id: string;
  purpose: string;
  channel: string;
  device_id: string | null;
  gps_result: string;
  network_result: string;
  qr_result: string;
  device_result: string;
  final_result: string;
  failure_reasons: string[];
  distance_m: string | null;
  gps_accuracy_m: string | null;
  latitude: string | null;
  longitude: string | null;
  fix_time: Date | null;
  location_mocked: boolean | null;
  ip: string | null;
  matched_network_id: string | null;
  qr_token_id: string | null;
  requested_at: Date;
  expires_at: Date | null;
  consumed_at: Date | null;
}
const verificationRows = () =>
  h.testDb.query<VerificationRow>(
    `select id, employee_id, purpose::text as purpose, channel::text as channel, device_id,
            gps_result::text as gps_result, network_result::text as network_result,
            qr_result::text as qr_result, device_result::text as device_result,
            final_result::text as final_result, failure_reasons,
            distance_m::text as distance_m, gps_accuracy_m::text as gps_accuracy_m,
            latitude::text as latitude, longitude::text as longitude, fix_time, location_mocked,
            host(client_ip) as ip, matched_network_id, qr_token_id, requested_at, expires_at,
            consumed_at
     from public.attendance_verifications order by requested_at, id`,
  );
const scanRows = () =>
  h.testDb.query<{
    outcome: string;
    employee_id: string;
    qr_token_id: string | null;
    device_id: string | null;
    verification_id: string | null;
  }>(
    `select outcome, employee_id, qr_token_id, device_id, verification_id
     from public.qr_scan_events order by id`,
  );
const challengeRows = (deviceId: string) =>
  h.testDb.query<{ purpose: string; consumed_at: Date | null }>(
    `select purpose, consumed_at from public.device_challenges
     where device_id = $1 order by created_at, id`,
    [deviceId],
  );

// =================================================================================================

describe('who may verify', () => {
  const body = () => ({ purpose: 'CHECK_IN', channel: 'MOBILE', gps: gps() });

  it('needs a signed-in user', async () => {
    expect((await request(h.app).post('/api/attendance/verify').send(body())).status).toBe(401);
    expect(
      (await request(h.app).post('/api/attendance/challenge').send({ deviceId: randomUUID() }))
        .status,
    ).toBe(401);
  });

  it('is closed to the office display account and to untracked administrators', async () => {
    expect((await verify(body(), tok.display)).status).toBe(403);
    expect((await verify(body(), tok.admin)).status).toBe(403);
    expect(await verificationRows()).toHaveLength(0);
  });

  it('is open to an administrator who does mark attendance', async () => {
    const tracked = await createAccount(h, { role: 'admin', attendanceRequired: true });
    const res = await verify(
      { purpose: 'CHECK_IN', channel: 'WEB', gps: gps(), qr: await qr() },
      await accessTokenFor(h, tracked),
    );
    // Rejected only for the layers they have not satisfied, never refused for who they are.
    expect(res.status).toBe(422);
    expect(reasonCodes(res)).toEqual(['DEVICE_MISSING']);
  });

  it('says plainly that the office is not set up yet, and records nothing', async () => {
    await h.testDb.query('delete from public.office_networks');
    await h.testDb.query('delete from public.office_locations');
    const res = await verify(body());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('OFFICE_NOT_CONFIGURED');
    expect(await verificationRows()).toHaveLength(0);
  });
});

describe('the request', () => {
  const mobileWith = (extra: Body): Body => ({ purpose: 'CHECK_IN', channel: 'MOBILE', ...extra });
  it.each<[string, () => Body]>([
    ['no purpose', () => ({ channel: 'MOBILE' })],
    ['no channel', () => ({ purpose: 'CHECK_IN' })],
    ['an unknown purpose', () => ({ purpose: 'LUNCH', channel: 'MOBILE' })],
    ['an unknown channel', () => ({ purpose: 'CHECK_IN', channel: 'KIOSK' })],
    ['latitude beyond 90', () => mobileWith({ gps: gps({ latitude: 91 }) })],
    ['longitude beyond 180', () => mobileWith({ gps: gps({ longitude: 181 }) })],
    ['negative accuracy', () => mobileWith({ gps: gps({ accuracyM: -1 }) })],
    ['a fix time that is not a time', () => mobileWith({ gps: gps({ fixTime: 'yesterday' }) })],
    ['coordinates as text', () => mobileWith({ gps: gps({ latitude: '10' }) })],
    ['an empty QR payload', () => mobileWith({ qr: { payload: '' } })],
    ['an enormous QR payload', () => mobileWith({ qr: { payload: 'x'.repeat(201) } })],
    [
      'a device proof of an unknown type',
      () =>
        mobileWith({
          device: {
            deviceId: randomUUID(),
            challengeId: randomUUID(),
            proof: { type: 'FINGERPRINT', signature: 'x' },
          },
        }),
    ],
    [
      'a device id that is not a UUID',
      () => mobileWith({ device: { deviceId: 'phone', challengeId: randomUUID() } }),
    ],
  ])('answers %s with a 400 and records nothing', async (_label, make) => {
    const res = await verify(make());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await verificationRows()).toHaveLength(0);
  });

  it.each([
    ['a verdict', { result: 'VERIFIED' }],
    ['layer results', { layers: { GPS: 'PASS', NETWORK: 'PASS', QR: 'PASS', DEVICE: 'PASS' } }],
    ['a distance', { distanceM: 0 }],
    ['an address', { ip: '203.0.113.9' }],
    ['a client address', { clientIp: '203.0.113.9' }],
    ['a time', { requestedAt: new Date(T0).toISOString() }],
    ['an employee id', { employeeId: randomUUID() }],
    ['an expiry', { expiresAt: new Date(T0 + 3_600_000).toISOString() }],
  ])('never takes %s from the client', async (_label, extra) => {
    const res = await verify({ purpose: 'CHECK_IN', channel: 'MOBILE', gps: gps(), ...extra });
    expect(res.status).toBe(400);
    expect(await verificationRows()).toHaveLength(0);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await request(h.app)
      .post('/api/attendance/verify')
      .set(bearer(tok.employee))
      .set('Content-Type', 'application/json')
      .send('{"purpose": ');
    expect(res.status).toBe(400);
  });
});

describe('a complete, honest check-in', () => {
  it('is verified on a phone through all four layers, and the record says so', async () => {
    const p = await enrolPhone();
    const body = await mobileCheckIn(p, {
      gps: gps({ latitude: northOfOffice(40), accuracyM: 12 }),
    });
    const res = await verify(body);

    expectVerified(res);
    expect(res.body).toEqual({
      result: 'VERIFIED',
      verificationId: expect.any(String),
      expiresAt: new Date(T0 + 120_000).toISOString(),
      layers: { GPS: 'PASS', NETWORK: 'PASS', QR: 'PASS', DEVICE: 'PASS' },
      gps: { distanceMeters: 40, accuracyMeters: 12 },
    });

    const [row] = await verificationRows();
    expect(row).toMatchObject({
      id: res.body.verificationId,
      employee_id: employee.id,
      purpose: 'CHECK_IN',
      channel: 'MOBILE',
      device_id: p.deviceId,
      gps_result: 'PASS',
      network_result: 'PASS',
      qr_result: 'PASS',
      device_result: 'PASS',
      final_result: 'VERIFIED',
      failure_reasons: [],
      gps_accuracy_m: '12.00',
      location_mocked: null,
      ip: '127.0.0.1',
      consumed_at: null,
    });
    expect(Number(row!.distance_m)).toBeCloseTo(40, 0);
    expect(Number(row!.latitude)).toBeCloseTo(northOfOffice(40), 5);
    expect(row!.requested_at).toEqual(new Date(T0));
    expect(row!.expires_at).toEqual(new Date(T0 + 120_000));
    expect(row!.matched_network_id).not.toBeNull();
    expect(row!.qr_token_id).not.toBeNull();
  });

  it('is verified in a browser through all four layers with a platform passkey', async () => {
    const b = await enrolBrowser();
    const res = await verify(await webCheckIn(b));
    expectVerified(res);
    expect(res.body.layers).toEqual({ GPS: 'PASS', NETWORK: 'PASS', QR: 'PASS', DEVICE: 'PASS' });
    const [row] = await verificationRows();
    expect(row).toMatchObject({ channel: 'WEB', device_id: b.deviceId, final_result: 'VERIFIED' });
  });

  it('spends the QR code for that person and notes which device and verification used it', async () => {
    const p = await enrolPhone();
    const res = await verify(await mobileCheckIn(p));
    expectVerified(res);
    const [scan] = await scanRows();
    expect(scan).toMatchObject({
      outcome: 'ACCEPTED',
      employee_id: employee.id,
      device_id: p.deviceId,
      verification_id: res.body.verificationId,
    });
  });

  it('keeps the device’s “last seen” up to date', async () => {
    const p = await enrolPhone();
    expectVerified(await verify(await mobileCheckIn(p)));
    const [row] = await h.testDb.query<{ last_seen_at: Date | null }>(
      'select last_seen_at from public.registered_devices where id = $1',
      [p.deviceId],
    );
    expect(row!.last_seen_at).toEqual(new Date(T0));
  });

  it('accepts the fix time as an ISO timestamp too', async () => {
    const p = await enrolPhone();
    const body = await mobileCheckIn(p, {
      gps: gps({ fixTime: new Date(T0 - 3_000).toISOString() }),
    });
    expectVerified(await verify(body));
  });

  it('measures the distance itself, whatever the device thinks', async () => {
    const p = await enrolPhone();
    const res = await verify(await mobileCheckIn(p, { gps: gps({ latitude: northOfOffice(99) }) }));
    expectVerified(res);
    expect(res.body.gps.distanceMeters).toBe(99);
  });

  it('stamps each verification with the server’s clock, never the client’s', async () => {
    const p = await enrolPhone();
    expectVerified(await verify(await mobileCheckIn(p)));
    // Later, with the next code on screen (the first was spent) and a fresh device challenge.
    h.clock.set(new Date(T0 + 31_000));
    expectVerified(await verify(await mobileCheckIn(p)));
    const rows = await verificationRows();
    expect(rows.map((r) => r.requested_at.getTime())).toEqual([T0, T0 + 31_000]);
  });
});

describe('which layers are required', () => {
  it('asks a browser for a passkey and a code by default, and a phone for the same', async () => {
    const res = await verify({ purpose: 'CHECK_IN', channel: 'WEB', gps: gps() });
    expectRejected(res, ['QR_MISSING', 'DEVICE_MISSING']);
    expect(layersOf(res)).toEqual({ GPS: 'PASS', NETWORK: 'PASS', QR: 'FAIL', DEVICE: 'FAIL' });
    const mobile = await verify({ purpose: 'CHECK_IN', channel: 'MOBILE', gps: gps() });
    expectRejected(mobile, ['QR_MISSING', 'DEVICE_MISSING']);
  });

  it('asks only for location and network at check-out, by default', async () => {
    const res = await verify({ purpose: 'CHECK_OUT', channel: 'MOBILE', gps: gps() });
    expectVerified(res);
    expect(res.body.layers).toEqual({
      GPS: 'PASS',
      NETWORK: 'PASS',
      QR: 'NOT_REQUIRED',
      DEVICE: 'NOT_REQUIRED',
    });
    expect(await scanRows()).toHaveLength(0);
  });

  it('ignores a QR code and a device proof it did not ask for, and spends neither', async () => {
    const p = await enrolPhone();
    const evidence = await phoneEvidence(p, 'CHECK_OUT');
    const res = await verify({
      purpose: 'CHECK_OUT',
      channel: 'MOBILE',
      gps: gps(),
      qr: await qr(),
      device: evidence,
    });
    expectVerified(res);
    expect(await scanRows()).toHaveLength(0);
    expect((await challengeRows(p.deviceId)).every((c) => c.consumed_at === null)).toBe(true);
    const [row] = await verificationRows();
    expect(row).toMatchObject({ device_id: null, qr_token_id: null });
  });

  it('follows the policy for each channel', async () => {
    await setPolicy({ web: ['GPS', 'NETWORK'], mobile: ['GPS', 'NETWORK', 'QR'] });
    const web = await verify({ purpose: 'CHECK_IN', channel: 'WEB', gps: gps() });
    expectVerified(web);
    expect(web.body.layers).toMatchObject({ QR: 'NOT_REQUIRED', DEVICE: 'NOT_REQUIRED' });

    const mobile = await verify({ purpose: 'CHECK_IN', channel: 'MOBILE', gps: gps() });
    expectRejected(mobile, ['QR_MISSING']);
    expect(layersOf(mobile).DEVICE).toBe('NOT_REQUIRED');
  });

  it('can ask for more at check-out when the policy says so', async () => {
    await setPolicy({ checkOut: ['GPS', 'NETWORK', 'QR'] });
    const res = await verify({ purpose: 'CHECK_OUT', channel: 'MOBILE', gps: gps() });
    expectRejected(res, ['QR_MISSING']);
    const ok = await verify({
      purpose: 'CHECK_OUT',
      channel: 'MOBILE',
      gps: gps(),
      qr: await qr(),
    });
    expectVerified(ok);
  });

  it('never lets location and network be dropped, whatever the policy row says', async () => {
    // The database forbids it for check-in; the engine also insists for check-out.
    await setPolicy({ checkOut: ['QR'] });
    const res = await verify({ purpose: 'CHECK_OUT', channel: 'MOBILE', qr: await qr() });
    expectRejected(res, ['GPS_MISSING']);
    expect(layersOf(res).GPS).toBe('FAIL');
    expect(layersOf(res).NETWORK).toBe('PASS');
  });

  it('applies a policy change to the very next request', async () => {
    const before = await verify({ purpose: 'CHECK_IN', channel: 'WEB', gps: gps() });
    expectRejected(before, ['QR_MISSING', 'DEVICE_MISSING']);
    await setPolicy({ web: ['GPS', 'NETWORK'] });
    expectVerified(await verify({ purpose: 'CHECK_IN', channel: 'WEB', gps: gps() }));
  });
});

// -------------------------------------------------------------------------------------------------
// Layer 1: location
// -------------------------------------------------------------------------------------------------

describe('layer 1: location', () => {
  beforeEach(async () => {
    await setPolicy({ web: ['GPS', 'NETWORK'], mobile: ['GPS', 'NETWORK'] });
  });
  const checkIn = (over: Body = {}) =>
    verify({ purpose: 'CHECK_IN', channel: 'MOBILE', gps: gps(), ...over });

  it('needs a location', async () => {
    const res = await verify({ purpose: 'CHECK_IN', channel: 'MOBILE' });
    expectRejected(res, ['GPS_MISSING']);
    expect(res.body.error.details.gps).toEqual({ distanceMeters: null, accuracyMeters: null });
    const [row] = await verificationRows();
    expect(row).toMatchObject({
      gps_result: 'FAIL',
      latitude: null,
      longitude: null,
      distance_m: null,
    });
  });

  it('accepts a point inside the radius and rejects one outside it, saying how far', async () => {
    expectVerified(await checkIn({ gps: gps({ latitude: northOfOffice(99) }) }));
    const far = await checkIn({ gps: gps({ latitude: northOfOffice(150) }) });
    expectRejected(far, ['GPS_OUTSIDE_RADIUS']);
    expect(far.body.error.details.gps.distanceMeters).toBe(150);
    expect(far.body.error.details.reasons[0].message).toContain('150');
    expect(far.body.error.details.reasons[0].hint).toBeTruthy();
  });

  it('judges in every direction, not just north', async () => {
    const east =
      OFFICE.longitude + 150 / (METRES_PER_DEGREE * Math.cos((OFFICE.latitude * Math.PI) / 180));
    expectRejected(await checkIn({ gps: gps({ longitude: east }) }), ['GPS_OUTSIDE_RADIUS']);
    expectRejected(await checkIn({ gps: gps({ latitude: northOfOffice(-150) }) }), [
      'GPS_OUTSIDE_RADIUS',
    ]);
  });

  it('follows the radius the administrator sets, immediately', async () => {
    const at150 = gps({ latitude: northOfOffice(150) });
    expectRejected(await checkIn({ gps: at150 }), ['GPS_OUTSIDE_RADIUS']);
    const res = await request(h.app)
      .put('/api/admin/office/settings')
      .set(bearer(tok.admin))
      .send({ geofenceRadiusM: 200 });
    expect(res.status).toBe(200);
    expectVerified(await checkIn({ gps: at150 }));
  });

  it('does not trust a reading flagged as mocked, even at the desk', async () => {
    const res = await checkIn({ gps: gps({ mocked: true }) });
    expectRejected(res, ['GPS_MOCKED']);
    const [row] = await verificationRows();
    expect(row).toMatchObject({ location_mocked: true, gps_result: 'FAIL' });
  });

  it('accepts an explicit “not mocked”', async () => {
    expectVerified(await checkIn({ gps: gps({ mocked: false }) }));
  });

  it('rejects a stale reading, with the exact boundary inclusive', async () => {
    expectVerified(await checkIn({ gps: gps({ fixTime: T0 - 30_000 }) }));
    const res = await checkIn({ gps: gps({ fixTime: T0 - 31_000 }) });
    expectRejected(res, ['GPS_STALE']);
    expect(res.body.error.details.reasons[0].message).toMatch(/31 s old/);
  });

  it('rejects a reading from a device clock in the future', async () => {
    expectVerified(await checkIn({ gps: gps({ fixTime: T0 + 10_000 }) }));
    expectRejected(await checkIn({ gps: gps({ fixTime: T0 + 11_000 }) }), ['GPS_FUTURE']);
  });

  it('rejects an imprecise reading, with the limit inclusive', async () => {
    expectVerified(await checkIn({ gps: gps({ accuracyM: 50 }) }));
    const res = await checkIn({ gps: gps({ accuracyM: 51 }) });
    expectRejected(res, ['GPS_LOW_ACCURACY']);
  });

  it('asks for a better reading before judging a poor one against the radius', async () => {
    const res = await checkIn({ gps: gps({ latitude: northOfOffice(500), accuracyM: 300 }) });
    expectRejected(res, ['GPS_LOW_ACCURACY']); // not also "outside the radius"
  });

  it('reports every problem with a reading at once', async () => {
    const res = await checkIn({
      gps: gps({ mocked: true, fixTime: T0 - 120_000, accuracyM: 200 }),
    });
    expectRejected(res, ['GPS_MOCKED', 'GPS_STALE', 'GPS_LOW_ACCURACY']);
  });

  it('works in the southern and western hemispheres, and across the date line', async () => {
    await request(h.app)
      .put('/api/admin/office/settings')
      .set(bearer(tok.admin))
      .send({ latitude: -33.8688, longitude: 179.9999, geofenceRadiusM: 100 });
    const fix = { latitude: -33.8688, longitude: -179.9999 }; // ~18.6 m away, over the date line
    expectVerified(await checkIn({ gps: gps(fix) }));
    expectRejected(await checkIn({ gps: gps({ latitude: -33.8688, longitude: 179.99 }) }), [
      'GPS_OUTSIDE_RADIUS',
    ]);
  });

  it('keeps the raw fix and the verdict, so the verdict outlives the privacy purge of coordinates', async () => {
    expectVerified(await checkIn({ gps: gps({ latitude: northOfOffice(40) }) }));
    await h.testDb.query('select private.apply_retention($1::timestamptz)', [
      new Date(T0 + 91 * 86_400_000),
    ]);
    const [row] = await verificationRows();
    expect(row).toMatchObject({ latitude: null, longitude: null, final_result: 'VERIFIED' });
    expect(Number(row!.distance_m)).toBeCloseTo(40, 0);
  });
});

// -------------------------------------------------------------------------------------------------
// Layer 2: the office network
// -------------------------------------------------------------------------------------------------

describe('layer 2: office network', () => {
  beforeEach(async () => {
    await setPolicy({ web: ['GPS', 'NETWORK'], mobile: ['GPS', 'NETWORK'] });
  });
  const fromAddress = (headers: Record<string, string> = {}, app = h.app) =>
    request(app)
      .post('/api/attendance/verify')
      .set(bearer(tok.employee))
      .set(headers)
      .send({ purpose: 'CHECK_IN', channel: 'MOBILE', gps: gps() });

  it('passes from an allowed address and records which entry matched', async () => {
    const res = await fromAddress();
    expectVerified(res);
    const [row] = await verificationRows();
    const [net] = await h.testDb.query<{ id: string }>(
      "select id from public.office_networks where cidr = '127.0.0.1/32'",
    );
    expect(row!.matched_network_id).toBe(net!.id);
  });

  it('fails from any other address, and says to use the office Wi-Fi', async () => {
    await forgetNetworks();
    await allowNetwork('203.0.113.0/24');
    const res = await fromAddress();
    expectRejected(res, ['NETWORK_NOT_ALLOWED']);
    expect(res.body.error.details.reasons[0].hint).toMatch(/Wi-?Fi/i);
    expect(layersOf(res).NETWORK).toBe('FAIL');
  });

  it('says so when no network has been configured at all', async () => {
    await forgetNetworks();
    expectRejected(await fromAddress(), ['NETWORK_NOT_CONFIGURED']);
  });

  it('treats networks an administrator has switched off as not there at all', async () => {
    await forgetNetworks();
    await allowNetwork('127.0.0.1/32', false);
    const res = await fromAddress();
    expectRejected(res, ['NETWORK_NOT_CONFIGURED']);
    expect(res.body.error.details.reasons[0].hint).toMatch(/administrator/i);
  });

  it('takes effect the moment an allowlist entry is switched off or on', async () => {
    await allowNetwork('203.0.113.0/24'); // some other office line stays active throughout
    expectVerified(await fromAddress());
    await h.testDb.query(
      "update public.office_networks set is_active = false where cidr = '127.0.0.1/32'",
    );
    expectRejected(await fromAddress(), ['NETWORK_NOT_ALLOWED']);
    await h.testDb.query(
      "update public.office_networks set is_active = true where cidr = '127.0.0.1/32'",
    );
    expectVerified(await fromAddress());
  });

  it('matches anywhere inside a range, and not just outside it', async () => {
    await forgetNetworks();
    await allowNetwork('127.0.0.0/24');
    expectVerified(await fromAddress());
    await forgetNetworks();
    await allowNetwork('127.0.1.0/24');
    expectRejected(await fromAddress(), ['NETWORK_NOT_ALLOWED']);
  });

  describe('forged forwarding headers (no trusted proxy)', () => {
    beforeEach(async () => {
      await forgetNetworks();
      await allowNetwork('203.0.113.0/24'); // the "office"; we are NOT in it
    });

    it.each([
      ['X-Forwarded-For', { 'X-Forwarded-For': '203.0.113.9' }],
      ['X-Forwarded-For with a chain', { 'X-Forwarded-For': '203.0.113.9, 203.0.113.10' }],
      ['X-Real-IP', { 'X-Real-IP': '203.0.113.9' }],
      ['Forwarded', { Forwarded: 'for=203.0.113.9' }],
      ['CF-Connecting-IP', { 'CF-Connecting-IP': '203.0.113.9' }],
      ['True-Client-IP', { 'True-Client-IP': '203.0.113.9' }],
      ['X-Client-IP', { 'X-Client-IP': '203.0.113.9' }],
      ['X-Originating-IP', { 'X-Originating-IP': '203.0.113.9' }],
      ['an IPv4-mapped IPv6 spoof', { 'X-Forwarded-For': '::ffff:203.0.113.9' }],
    ])('is not fooled by %s', async (_label, headers) => {
      const res = await fromAddress(headers);
      expectRejected(res, ['NETWORK_NOT_ALLOWED']);
      const [row] = await verificationRows();
      // The record shows the address the connection really came from, not the one claimed.
      expect(row!.ip).toBe('127.0.0.1');
      expect(row!.network_result).toBe('FAIL');
    });
  });

  describe('behind exactly one trusted proxy', () => {
    let proxied: ReturnType<typeof h.build>;
    beforeEach(async () => {
      proxied = h.build({ env: { TRUST_PROXY: '1' } });
      await forgetNetworks();
      await allowNetwork('203.0.113.0/24');
      await allowNetwork('2001:db8:abcd::/48');
    });

    it('believes the address the proxy reports', async () => {
      expectVerified(await fromAddress({ 'X-Forwarded-For': '203.0.113.9' }, proxied));
      const [row] = await verificationRows();
      expect(row!.ip).toBe('203.0.113.9');
    });

    it('works for IPv6 office ranges too', async () => {
      expectVerified(await fromAddress({ 'X-Forwarded-For': '2001:db8:abcd::1234' }, proxied));
    });

    it('ignores anything a client adds to the left of what the proxy appended', async () => {
      // The attacker claims 203.0.113.9; the proxy appends the real peer, 198.51.100.7.
      const res = await fromAddress({ 'X-Forwarded-For': '203.0.113.9, 198.51.100.7' }, proxied);
      expectRejected(res, ['NETWORK_NOT_ALLOWED']);
      const [row] = await verificationRows();
      expect(row!.ip).toBe('198.51.100.7');
    });

    it('still ignores headers other than X-Forwarded-For', async () => {
      const res = await fromAddress(
        {
          'X-Real-IP': '203.0.113.9',
          'CF-Connecting-IP': '203.0.113.9',
          Forwarded: 'for=203.0.113.9',
        },
        proxied,
      );
      // No X-Forwarded-For at all: the address is the proxy's own (loopback here), which is not allowed.
      expectRejected(res, ['NETWORK_NOT_ALLOWED']);
    });

    it('treats an unparseable header as an unknown address, not as permission', async () => {
      const res = await fromAddress({ 'X-Forwarded-For': 'not-an-address' }, proxied);
      expectRejected(res, ['NETWORK_UNKNOWN']);
      const [row] = await verificationRows();
      expect(row!.ip).toBeNull();
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Layer 3: the rotating QR code
// -------------------------------------------------------------------------------------------------

describe('layer 3: office QR code', () => {
  beforeEach(async () => {
    await setPolicy({ web: ['GPS', 'NETWORK', 'QR'], mobile: ['GPS', 'NETWORK', 'QR'] });
  });
  const checkIn = (qrEvidence?: { payload: string }, t = tok.employee) =>
    verify(
      {
        purpose: 'CHECK_IN',
        channel: 'MOBILE',
        gps: gps(),
        ...(qrEvidence ? { qr: qrEvidence } : {}),
      },
      t,
    );

  it('needs a code', async () => {
    const res = await checkIn();
    expectRejected(res, ['QR_MISSING']);
    expect(await scanRows()).toHaveLength(0); // nothing was scanned
  });

  it('accepts the code on screen', async () => {
    expectVerified(await checkIn(await qr()));
  });

  it('rejects text that is not a code, a code from another system, and a forgery', async () => {
    for (const payload of [
      'hello',
      'https://example.com',
      mint(windowNow(), 'a-different-signing-secret-0123456789abcdef'),
    ]) {
      expectRejected(await checkIn({ payload }), ['QR_INVALID']);
    }
    expect((await scanRows()).every((s) => s.outcome === 'UNKNOWN' && s.qr_token_id === null)).toBe(
      true,
    );
  });

  it('rejects a code that has expired', async () => {
    const old = await showing();
    h.clock.set(new Date(T0 + 60_000));
    const res = await checkIn({ payload: old });
    expectRejected(res, ['QR_EXPIRED']);
    expect((await scanRows())[0]!.outcome).toBe('EXPIRED');
  });

  it('still accepts the previous code through the short grace period', async () => {
    const previous = await showing();
    h.clock.set(new Date(T0 + 35_000)); // five seconds after the screen moved on
    expectVerified(await checkIn({ payload: previous }));
  });

  it('refuses a code twice from the same person, once it has been used', async () => {
    const { payload } = await qr();
    expectVerified(await checkIn({ payload }));
    h.clock.set(new Date(T0 + 5_000));
    const again = await checkIn({ payload });
    expectRejected(again, ['QR_REPLAYED']);
    const outcomes = (await scanRows()).map((s) => s.outcome);
    expect(outcomes).toEqual(['ACCEPTED', 'REPLAYED']);
  });

  it('lets a colleague use the very same code, because the screen is shared', async () => {
    const { payload } = await qr();
    expectVerified(await checkIn({ payload }));
    expectVerified(await checkIn({ payload }, tok.colleague));
    const scans = await scanRows();
    expect(scans.map((s) => [s.employee_id, s.outcome])).toEqual([
      [employee.id, 'ACCEPTED'],
      [colleague.id, 'ACCEPTED'],
    ]);
  });

  it('does NOT use a code up when the verification fails for another reason', async () => {
    const { payload } = await qr();
    const bad = await verify({
      purpose: 'CHECK_IN',
      channel: 'MOBILE',
      gps: gps({ latitude: northOfOffice(500) }),
      qr: { payload },
    });
    expectRejected(bad, ['GPS_OUTSIDE_RADIUS']);
    expect(layersOf(bad).QR).toBe('PASS');
    expect((await scanRows())[0]!.outcome).toBe('VALID');

    // The same code works on the next, better attempt.
    expectVerified(await checkIn({ payload }));
    expect((await scanRows()).map((s) => s.outcome)).toEqual(['VALID', 'ACCEPTED']);
  });

  it('links every scan to the verification it belonged to', async () => {
    await checkIn({ payload: 'hello' });
    const { payload } = await qr();
    expectVerified(await checkIn({ payload }));
    const rows = await verificationRows();
    const scans = await scanRows();
    expect(rows).toHaveLength(2);
    expect(new Set(scans.map((s) => s.verification_id))).toEqual(new Set(rows.map((r) => r.id)));
  });

  it('is not required for a browser whose policy leaves it out, and is then ignored', async () => {
    await setPolicy({ web: ['GPS', 'NETWORK'] });
    const res = await verify({
      purpose: 'CHECK_IN',
      channel: 'WEB',
      gps: gps(),
      qr: { payload: 'hello' },
    });
    expectVerified(res);
    expect(await scanRows()).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
// Layer 4: the registered device
// -------------------------------------------------------------------------------------------------

describe('layer 4: registered device', () => {
  beforeEach(async () => {
    await setPolicy({ web: ['GPS', 'NETWORK', 'DEVICE'], mobile: ['GPS', 'NETWORK', 'DEVICE'] });
  });
  const mobile = (device?: Body, over: Body = {}) =>
    verify({
      purpose: 'CHECK_IN',
      channel: 'MOBILE',
      gps: gps(),
      ...(device ? { device } : {}),
      ...over,
    });
  const web = (device?: Body, over: Body = {}) =>
    verify({
      purpose: 'CHECK_IN',
      channel: 'WEB',
      gps: gps(),
      ...(device ? { device } : {}),
      ...over,
    });

  it('needs a device', async () => {
    expectRejected(await mobile(), ['DEVICE_MISSING']);
  });

  it('passes for the registered phone with a fresh signature', async () => {
    const p = await enrolPhone();
    expectVerified(await mobile(await phoneEvidence(p)));
  });

  it('passes for the registered browser with a fresh passkey assertion', async () => {
    const b = await enrolBrowser();
    expectVerified(await web(await browserEvidence(b)));
  });

  describe('whose device it is', () => {
    it('refuses a device that was never registered', async () => {
      const res = await mobile({ deviceId: randomUUID(), challengeId: randomUUID() });
      expectRejected(res, ['DEVICE_NOT_REGISTERED']);
      const [row] = await verificationRows();
      expect(row!.device_id).toBeNull();
    });

    it('refuses a colleague’s device, and does not reveal that it exists', async () => {
      const theirs = await enrolPhone({ who: colleague, token: tok.colleague });
      const stranger = await mobile({ deviceId: randomUUID(), challengeId: randomUUID() });
      const borrowed = await mobile({
        deviceId: theirs.deviceId,
        challengeId: randomUUID(),
      });
      expectRejected(borrowed, ['DEVICE_NOT_REGISTERED']);
      expect(borrowed.body.error.details.reasons).toEqual(stranger.body.error.details.reasons);
      expect((await verificationRows()).every((r) => r.device_id === null)).toBe(true);
    });

    it('refuses a colleague’s phone even with a perfect signature from it', async () => {
      const theirs = await enrolPhone({ who: colleague, token: tok.colleague });
      // The colleague hands over a fully signed challenge for THEIR device.
      const evidence = await phoneEvidence(theirs);
      expectRejected(await mobile(evidence), ['DEVICE_NOT_REGISTERED']);
    });
  });

  describe('the state of the device', () => {
    it('says a device still waiting for approval is waiting', async () => {
      const p = await enrolPhone({ approved: false });
      const res = await mobile(await phoneEvidence(p));
      expectRejected(res, ['DEVICE_PENDING']);
      const [row] = await verificationRows();
      expect(row!.device_id).toBe(p.deviceId); // recorded: it is the employee's own device
    });

    it('refuses a device an administrator has revoked, at once', async () => {
      const p = await enrolPhone();
      const evidence = await phoneEvidence(p);
      await post(`/api/admin/devices/${p.deviceId}/revoke`, { reason: 'Lost phone' }, tok.admin);
      expectRejected(await mobile(evidence), ['DEVICE_REVOKED']);
    });

    it('refuses a device the employee removed themselves', async () => {
      const p = await enrolPhone();
      const res = await request(h.app)
        .delete(`/api/devices/${p.deviceId}`)
        .set(bearer(tok.employee));
      expect(res.status).toBe(200);
      const evidence = { deviceId: p.deviceId, challengeId: randomUUID() };
      expectRejected(await mobile(evidence), ['DEVICE_REVOKED']);
    });

    it('cannot get a challenge for a revoked device in the first place', async () => {
      const p = await enrolPhone();
      await post(`/api/admin/devices/${p.deviceId}/revoke`, { reason: 'Lost phone' }, tok.admin);
      const res = await post('/api/attendance/challenge', {
        deviceId: p.deviceId,
        purpose: 'CHECK_IN',
      });
      expect(res.status).toBe(404);
    });

    it('does not let a phone verify a browser check-in, or a browser a phone one', async () => {
      const p = await enrolPhone();
      const b = await enrolBrowser();
      expectRejected(await web(await phoneEvidence(p)), ['DEVICE_PLATFORM_MISMATCH']);
      expectRejected(await mobile(await browserEvidence(b)), ['DEVICE_PLATFORM_MISMATCH']);
    });
  });

  describe('the challenge', () => {
    it('refuses a challenge that was never issued', async () => {
      const p = await enrolPhone();
      const real = await phoneEvidence(p);
      expectRejected(await mobile({ ...real, challengeId: randomUUID() }), [
        'DEVICE_CHALLENGE_INVALID',
      ]);
    });

    it('refuses a challenge that has expired', async () => {
      const p = await enrolPhone();
      const c = await challengeFor(p.deviceId, 'CHECK_IN');
      h.clock.set(new Date(T0 + 121_000));
      const evidence = p.phone.evidence({
        challengeId: c.challengeId,
        challenge: c.challenge,
        employeeId: employee.id,
        deviceId: p.deviceId,
        purpose: 'CHECK_IN',
      });
      expectRejected(await mobile(evidence), ['DEVICE_CHALLENGE_EXPIRED']);
    });

    it('accepts it right up to its expiry', async () => {
      const p = await enrolPhone();
      const c = await challengeFor(p.deviceId, 'CHECK_IN');
      h.clock.set(new Date(T0 + 119_000));
      const evidence = p.phone.evidence({
        challengeId: c.challengeId,
        challenge: c.challenge,
        employeeId: employee.id,
        deviceId: p.deviceId,
        purpose: 'CHECK_IN',
      });
      expectVerified(await mobile(evidence, { gps: gps() }));
    });

    it('can be used once, even when the verification it belonged to was rejected', async () => {
      const p = await enrolPhone();
      const evidence = await phoneEvidence(p);
      const first = await mobile(evidence, { gps: gps({ latitude: northOfOffice(500) }) });
      expectRejected(first, ['GPS_OUTSIDE_RADIUS']);
      expect(layersOf(first).DEVICE).toBe('PASS'); // the proof itself was fine...

      const second = await mobile(evidence); // ...but it is spent
      expectRejected(second, ['DEVICE_CHALLENGE_INVALID']);
      expect((await challengeRows(p.deviceId))[0]!.consumed_at).not.toBeNull();
    });

    it('can not be replayed after a successful verification', async () => {
      const p = await enrolPhone();
      const evidence = await phoneEvidence(p);
      expectVerified(await mobile(evidence));
      expectRejected(await mobile(evidence), ['DEVICE_CHALLENGE_INVALID']);
    });

    it('is bound to its purpose: a check-out challenge does not check anyone in', async () => {
      const p = await enrolPhone();
      const out = await phoneEvidence(p, 'CHECK_OUT');
      expectRejected(await mobile(out), ['DEVICE_CHALLENGE_INVALID']);
    });

    it('is bound to its device', async () => {
      const first = await enrolPhone();
      const second = await enrolPhone();
      const c = await challengeFor(first.deviceId, 'CHECK_IN');
      const evidence = second.phone.evidence({
        challengeId: c.challengeId,
        challenge: c.challenge,
        employeeId: employee.id,
        deviceId: second.deviceId,
        purpose: 'CHECK_IN',
      });
      expectRejected(await mobile(evidence), ['DEVICE_CHALLENGE_INVALID']);
    });

    it('is bound to its owner: nobody can spend a colleague’s challenge', async () => {
      const mine = await enrolPhone();
      const theirs = await enrolPhone({ who: colleague, token: tok.colleague });
      const c = await challengeFor(theirs.deviceId, 'CHECK_IN', tok.colleague);
      const evidence = mine.phone.evidence({
        challengeId: c.challengeId,
        challenge: c.challenge,
        employeeId: employee.id,
        deviceId: mine.deviceId,
        purpose: 'CHECK_IN',
      });
      expectRejected(await mobile(evidence), ['DEVICE_CHALLENGE_INVALID']);
      // ...and the colleague's challenge survived the attempt.
      expect((await challengeRows(theirs.deviceId))[0]!.consumed_at).toBeNull();
    });

    it('only the newest challenge for a device is live', async () => {
      const p = await enrolPhone();
      const old = await phoneEvidence(p);
      await phoneEvidence(p); // a newer one retires it
      expectRejected(await mobile(old), ['DEVICE_CHALLENGE_INVALID']);
    });
  });

  describe('the proof for a phone', () => {
    it('is required', async () => {
      const p = await enrolPhone();
      const { proof: _proof, ...withoutProof } = await phoneEvidence(p);
      expectRejected(await mobile(withoutProof), ['DEVICE_PROOF_MISSING']);
    });

    it('must come from the registered key', async () => {
      const p = await enrolPhone();
      const impostor = new SoftwareDevice();
      const c = await challengeFor(p.deviceId, 'CHECK_IN');
      const evidence = impostor.evidence({
        challengeId: c.challengeId,
        challenge: c.challenge,
        employeeId: employee.id,
        deviceId: p.deviceId,
        purpose: 'CHECK_IN',
      });
      expectRejected(await mobile(evidence), ['DEVICE_PROOF_INVALID']);
    });

    it.each([
      ['another challenge', { challenge: 'x'.repeat(43) }],
      ['another employee', { employeeId: randomUUID() }],
      ['another device id', { deviceId: randomUUID() }],
      ['another purpose', { purpose: 'CHECK_OUT' as const }],
    ])('must be a signature over this verification, not %s', async (_label, change) => {
      const p = await enrolPhone();
      const c = await challengeFor(p.deviceId, 'CHECK_IN');
      const message = verificationProofMessage({
        challenge: c.challenge,
        employeeId: employee.id,
        deviceId: p.deviceId,
        purpose: 'CHECK_IN',
        ...change,
      });
      const evidence = {
        deviceId: p.deviceId,
        challengeId: c.challengeId,
        proof: { type: 'APP_KEY', signature: p.phone.signMessage(message) },
      };
      expectRejected(await mobile(evidence), ['DEVICE_PROOF_INVALID']);
    });

    it('must be of the right kind for the device', async () => {
      const p = await enrolPhone();
      const b = await enrolBrowser();
      const c = await challengeFor(p.deviceId, 'CHECK_IN');
      const evidence = {
        deviceId: p.deviceId,
        challengeId: c.challengeId,
        proof: {
          type: 'WEBAUTHN',
          response: b.passkey.assert({ challenge: c.challenge }),
        },
      };
      expectRejected(await mobile(evidence), ['DEVICE_PROOF_INVALID']);
    });

    it('is not accepted if it is mere noise', async () => {
      const p = await enrolPhone();
      const c = await challengeFor(p.deviceId, 'CHECK_IN');
      const evidence = {
        deviceId: p.deviceId,
        challengeId: c.challengeId,
        proof: { type: 'APP_KEY', signature: 'A'.repeat(86) },
      };
      expectRejected(await mobile(evidence), ['DEVICE_PROOF_INVALID']);
    });
  });

  describe('the proof for a browser', () => {
    it('must be of the right kind for the device', async () => {
      const b = await enrolBrowser();
      const p = await enrolPhone();
      const c = await challengeFor(b.deviceId, 'CHECK_IN');
      const evidence = {
        deviceId: b.deviceId,
        challengeId: c.challengeId,
        proof: { type: 'APP_KEY', signature: p.phone.signMessage('anything') },
      };
      expectRejected(await web(evidence), ['DEVICE_PROOF_INVALID']);
    });

    it('must be made on our site, for our domain, with the screen lock or biometric', async () => {
      for (const options of [
        { origin: 'https://evil.test' },
        { rpId: 'evil.test' },
        { userVerified: false },
      ]) {
        // The wrong authenticator's key is not the registered one either, so build the attack
        // from the registered passkey and tamper with how it presents.
        const b = await enrolBrowser();
        Object.assign(b.passkey.options, options);
        expectRejected(await web(await browserEvidence(b)), ['DEVICE_PROOF_INVALID']);
        await post(
          `/api/admin/devices/${b.deviceId}/revoke`,
          { reason: 'test cleanup' },
          tok.admin,
        );
      }
    });

    it('must be for the registered passkey, not another one', async () => {
      const b = await enrolBrowser();
      const impostor = new SoftwareAuthenticator({ origin: WEB_ORIGIN, rpId: RP_ID });
      const c = await challengeFor(b.deviceId, 'CHECK_IN');
      const evidence = {
        deviceId: b.deviceId,
        challengeId: c.challengeId,
        proof: {
          type: 'WEBAUTHN',
          response: impostor.assert({ challenge: c.webauthn!.challenge }),
        },
      };
      expectRejected(await web(evidence), ['DEVICE_PROOF_INVALID']);
    });

    it('is bound to the challenge it was issued for', async () => {
      const b = await enrolBrowser();
      const c = await challengeFor(b.deviceId, 'CHECK_IN');
      const other = createHash('sha256').update('another challenge').digest('base64url');
      const evidence = {
        deviceId: b.deviceId,
        challengeId: c.challengeId,
        proof: { type: 'WEBAUTHN', response: b.passkey.assert({ challenge: other }) },
      };
      expectRejected(await web(evidence), ['DEVICE_PROOF_INVALID']);
    });

    it('offers the browser the registered passkey, and only that one', async () => {
      const b = await enrolBrowser();
      const c = await challengeFor(b.deviceId, 'CHECK_IN');
      expect(c.webauthn!.challenge).toBe(c.challenge);
      expect(c.webauthn!.allowCredentials).toEqual([expect.objectContaining({ id: b.passkey.id })]);
    });
  });

  describe('copied passkeys', () => {
    it('notices a signature counter that does not move forward, and flags it for administrators', async () => {
      const passkey = new SoftwareAuthenticator({
        origin: WEB_ORIGIN,
        rpId: RP_ID,
        reportsCounter: true,
      });
      const b = await enrolBrowser({ passkey });
      expectVerified(await web(await browserEvidence(b))); // counter 1
      expectVerified(await web(await browserEvidence(b))); // counter 2

      // A copy of the key, still at counter 1, is used: it has fallen behind the original.
      passkey.counter = 0;
      const res = await web(await browserEvidence(b));
      expectRejected(res, ['DEVICE_CLONE_SUSPECTED']);

      const [entry] = await auditRows(h, 'device.clone_suspected');
      expect(entry).toMatchObject({ actor_id: employee.id, entity_id: b.deviceId });
    });

    it('stores the counter, so progress is remembered between check-ins', async () => {
      const passkey = new SoftwareAuthenticator({
        origin: WEB_ORIGIN,
        rpId: RP_ID,
        reportsCounter: true,
      });
      const b = await enrolBrowser({ passkey });
      expectVerified(await web(await browserEvidence(b)));
      const [row] = await h.testDb.query<{ attestation_counter: string }>(
        'select attestation_counter::text from public.registered_devices where id = $1',
        [b.deviceId],
      );
      // Registration reported 1, this check-in 2.
      expect(row!.attestation_counter).toBe('2');
    });

    it('does not cry wolf for the many passkeys that always report zero', async () => {
      const b = await enrolBrowser();
      for (let i = 0; i < 3; i += 1) expectVerified(await web(await browserEvidence(b)));
      expect(await auditRows(h, 'device.clone_suspected')).toHaveLength(0);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Every combination of layers passing and failing
// -------------------------------------------------------------------------------------------------

describe('every combination of layer results', () => {
  const REASON_FOR: Record<Layer, string> = {
    GPS: 'GPS_OUTSIDE_RADIUS',
    NETWORK: 'NETWORK_NOT_ALLOWED',
    QR: 'QR_INVALID',
    DEVICE: 'DEVICE_PROOF_INVALID',
  };
  const subsets = Array.from({ length: 16 }, (_, mask) =>
    VERIFICATION_LAYERS.filter((_layer, bit) => (mask >> bit) & 1),
  );

  it.each(
    subsets.map((broken) => [broken.length === 0 ? 'none' : broken.join(' + '), broken] as const),
  )('a phone check-in with these layers failing: %s', async (_label, broken) => {
    const p = await enrolPhone();
    const body = (await mobileCheckIn(p)) as {
      gps: Body;
      qr: { payload: string };
      device: { proof: { signature: string } };
    };

    if (broken.includes('GPS')) body.gps = gps({ latitude: northOfOffice(500) });
    if (broken.includes('NETWORK')) {
      await forgetNetworks();
      await allowNetwork('203.0.113.0/24');
    }
    if (broken.includes('QR')) body.qr = { payload: mint(windowNow(), 'x'.repeat(40)) };
    if (broken.includes('DEVICE')) {
      (body.device as Body).proof = { type: 'APP_KEY', signature: 'A'.repeat(86) };
    }

    const res = await verify(body);
    const expectedLayers = Object.fromEntries(
      VERIFICATION_LAYERS.map((l) => [l, broken.includes(l) ? 'FAIL' : 'PASS']),
    );

    if (broken.length === 0) {
      expectVerified(res);
      expect(res.body.layers).toEqual(expectedLayers);
    } else {
      // Every failed layer is reported, in the fixed order, and nothing else is.
      expectRejected(
        res,
        VERIFICATION_LAYERS.filter((l) => broken.includes(l)).map((l) => REASON_FOR[l]),
      );
      expect(layersOf(res)).toEqual(expectedLayers);
    }

    // Whatever happened is on record, consistently.
    const [row] = await verificationRows();
    expect(row).toMatchObject({
      gps_result: expectedLayers.GPS,
      network_result: expectedLayers.NETWORK,
      qr_result: expectedLayers.QR,
      device_result: expectedLayers.DEVICE,
      final_result: broken.length === 0 ? 'VERIFIED' : 'REJECTED',
    });
    expect(row!.failure_reasons).toEqual(
      VERIFICATION_LAYERS.filter((l) => broken.includes(l)).map((l) => REASON_FOR[l]),
    );
    expect(row!.expires_at === null).toBe(broken.length > 0);
  });
});

describe('rejections are evidence', () => {
  it('records a rejected attempt with its reasons and no expiry, and nothing can use it', async () => {
    const res = await verify({
      purpose: 'CHECK_IN',
      channel: 'MOBILE',
      gps: gps({ latitude: northOfOffice(500) }),
    });
    expect(res.status).toBe(422);
    const [row] = await verificationRows();
    expect(row).toMatchObject({
      id: res.body.error.details.verificationId,
      final_result: 'REJECTED',
      expires_at: null,
    });
    // The check-in function accepts only a VERIFIED verification.
    const error = await attempt(h.testDb, 'select * from private.check_in($1, $2, $3)', [
      employee.id,
      row!.id,
      new Date(T0),
    ]);
    expect(error?.message).toMatch(/VERIFICATION_INVALID/);
  });

  it('joins every reason into the message people read', async () => {
    const res = await verify({
      purpose: 'CHECK_IN',
      channel: 'MOBILE',
      gps: gps({ latitude: northOfOffice(500) }),
    });
    expect(res.body.error.message).toContain('500 m from the office');
    expect(res.body.error.message).toContain('QR code was not scanned');
    expect(res.body.error.message).toContain('device was not identified');
  });

  it('gives every reason a hint about what to do next', async () => {
    const res = await verify({ purpose: 'CHECK_IN', channel: 'MOBILE' });
    for (const reason of res.body.error.details.reasons) {
      expect(reason.message).toBeTruthy();
      expect(reason.hint).toBeTruthy();
      expect(VERIFICATION_LAYERS).toContain(reason.layer);
    }
  });
});

describe('passing the verification on to check-in and check-out', () => {
  const checkIn = (verificationId: string, at = new Date(T0)) =>
    h.testDb.query<{ id: string; status: string; is_late: boolean }>(
      'select id, status::text as status, is_late from private.check_in($1, $2, $3)',
      [employee.id, verificationId, at],
    );

  it('lets a verified phone check-in become attendance', async () => {
    const p = await enrolPhone();
    const res = await verify(await mobileCheckIn(p));
    expectVerified(res);

    const [record] = await checkIn(res.body.verificationId);
    expect(record).toMatchObject({ status: 'PRESENT', is_late: false });
    const [row] = await verificationRows();
    expect(row!.consumed_at).toEqual(new Date(T0));
  });

  it('checks in once however often the same verification is presented', async () => {
    const p = await enrolPhone();
    const res = await verify(await mobileCheckIn(p));
    await checkIn(res.body.verificationId);
    // A retry after a lost response returns the same record instead of checking in twice.
    await checkIn(res.body.verificationId, new Date(T0 + 1000));
    const events = await h.testDb.query(
      "select 1 from public.attendance_events where verification_id = $1 and event_type = 'CHECK_IN'",
      [res.body.verificationId],
    );
    expect(events).toHaveLength(1);
  });

  it('refuses a verification once it has expired', async () => {
    const p = await enrolPhone();
    const res = await verify(await mobileCheckIn(p));
    const error = await attempt(h.testDb, 'select * from private.check_in($1, $2, $3)', [
      employee.id,
      res.body.verificationId,
      new Date(T0 + 121_000),
    ]);
    expect(error?.message).toMatch(/VERIFICATION_EXPIRED/);
  });

  it('refuses it if the device was revoked in between', async () => {
    const p = await enrolPhone();
    const res = await verify(await mobileCheckIn(p));
    await post(`/api/admin/devices/${p.deviceId}/revoke`, { reason: 'Lost phone' }, tok.admin);
    const error = await attempt(h.testDb, 'select * from private.check_in($1, $2, $3)', [
      employee.id,
      res.body.verificationId,
      new Date(T0 + 30_000),
    ]);
    expect(error?.message).toMatch(/DEVICE_NOT_ACTIVE/);
  });

  it('is for the person it was issued to, and for the purpose it was issued for', async () => {
    const res = await verify({ purpose: 'CHECK_OUT', channel: 'MOBILE', gps: gps() });
    expectVerified(res);
    const wrongPurpose = await attempt(h.testDb, 'select * from private.check_in($1, $2, $3)', [
      employee.id,
      res.body.verificationId,
      new Date(T0),
    ]);
    expect(wrongPurpose?.message).toMatch(/VERIFICATION_INVALID/);

    const wrongPerson = await attempt(h.testDb, 'select * from private.check_out($1, $2, $3)', [
      colleague.id,
      res.body.verificationId,
      new Date(T0),
    ]);
    expect(wrongPerson?.message).toMatch(/VERIFICATION_INVALID/);
  });

  it('completes a day: verified check-in, then a verified check-out', async () => {
    const p = await enrolPhone();
    const inRes = await verify(await mobileCheckIn(p));
    await checkIn(inRes.body.verificationId);

    // (Access tokens last an hour, so stay inside it.)
    h.clock.set(new Date(T0 + 50 * 60_000));
    const outRes = await verify({ purpose: 'CHECK_OUT', channel: 'MOBILE', gps: gps() });
    expectVerified(outRes);
    const [record] = await h.testDb.query<{ check_out_at: Date }>(
      'select check_out_at from private.check_out($1, $2, $3)',
      [employee.id, outRes.body.verificationId, h.clock.now()],
    );
    expect(record!.check_out_at).toEqual(new Date(T0 + 50 * 60_000));
  });
});

describe('rate limiting', () => {
  it('slows down a person who keeps submitting attempts, without affecting a colleague', async () => {
    const body = {
      purpose: 'CHECK_IN',
      channel: 'MOBILE',
      gps: gps({ latitude: northOfOffice(500) }),
    };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await verify(body)).status);
    expect(statuses.slice(0, 30).every((s) => s === 422)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect((await verify(body, tok.colleague)).status).toBe(422);
  });
});

describe('log hygiene', () => {
  it('never writes locations, codes, signatures or challenges to the logs', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const env = h.envWith({ NODE_ENV: 'development', LOG_LEVEL: 'trace' });
    h.app = h.build({
      env: { NODE_ENV: 'development', LOG_LEVEL: 'trace' },
      logger: createLogger(env, sink),
    });

    const p = await enrolPhone();
    const evidence = await phoneEvidence(p);
    const code = await showing();
    const secretLatitude = 10.123456;
    const secretLongitude = 20.654321;
    await verify({
      purpose: 'CHECK_IN',
      channel: 'MOBILE',
      gps: gps({ latitude: secretLatitude, longitude: secretLongitude }),
      qr: { payload: code },
      device: evidence,
    });
    await verify({
      purpose: 'CHECK_IN',
      channel: 'MOBILE',
      gps: gps(),
      qr: { payload: code },
      device: evidence,
    });

    const logs = lines.join('');
    expect(logs).toContain('/api/attendance/verify'); // the logger was genuinely active
    for (const [label, secret] of Object.entries({
      latitude: String(secretLatitude),
      longitude: String(secretLongitude),
      'qr code': code.split('.')[2]!,
      signature: evidence.proof.signature,
      'challenge id': evidence.challengeId,
    })) {
      expect(logs, label).not.toContain(secret);
    }
  });
});
