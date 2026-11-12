import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect } from 'vitest';
import type { ConfirmScanResponse, ScanResolution, VerificationLayer } from '@teachgrow/shared';
import {
  type Account,
  type ApiHarness,
  accessTokenFor,
  bearer,
  createAccount,
} from './api-harness.js';

/**
 * The office, a few people and the HTTP calls the QR attendance tests keep making.
 * Test-only: coordinates and names here are synthetic.
 */

/** Synthetic office coordinates: this codebase never contains the company's real location. */
export const OFFICE = { latitude: 10, longitude: 20 };
const METRES_PER_DEGREE = 111_194.9; // great-circle, matching the server's Earth radius

type Body = Record<string, unknown>;
type Who = 'admin' | 'operator' | 'employee' | 'colleague' | 'display';

export class QrScene {
  admin!: Account;
  operator!: Account;
  employee!: Account;
  colleague!: Account;
  display!: Account;
  tok!: Record<Who, string>;
  officeId!: string;

  constructor(readonly h: ApiHarness) {}

  /** An office at synthetic coordinates, the loopback address as its network, and five people. */
  async setUp(): Promise<void> {
    const { h } = this;
    this.admin = await createAccount(h, { role: 'admin', attendanceRequired: false });
    this.operator = await createAccount(h, { role: 'attendance_operator' });
    this.employee = await createAccount(h);
    this.colleague = await createAccount(h);
    this.display = await createAccount(h, { role: 'office_display' });
    this.tok = {
      admin: await accessTokenFor(h, this.admin),
      operator: await accessTokenFor(h, this.operator),
      employee: await accessTokenFor(h, this.employee),
      colleague: await accessTokenFor(h, this.colleague),
      display: await accessTokenFor(h, this.display),
    };
    const res = await request(h.app)
      .put('/api/admin/office/settings')
      .set(bearer(this.tok.admin))
      .send({ name: 'Test Office', ...OFFICE });
    expect(res.status).toBe(200);
    this.officeId = res.body.office.id as string;
    // Requests in these tests really come from the loopback address.
    await this.allowNetwork('127.0.0.1/32');
  }

  /** Sign everybody in again (after the test clock has moved past the life of the old tokens). */
  async refreshTokens(): Promise<void> {
    this.tok = {
      admin: await accessTokenFor(this.h, this.admin),
      operator: await accessTokenFor(this.h, this.operator),
      employee: await accessTokenFor(this.h, this.employee),
      colleague: await accessTokenFor(this.h, this.colleague),
      display: await accessTokenFor(this.h, this.display),
    };
  }

  // ---- plumbing ---------------------------------------------------------------------------

  post = (path: string, body: Body = {}, token = this.tok.operator) =>
    request(this.h.app).post(path).set(bearer(token)).send(body);

  get = (path: string, token = this.tok.operator) =>
    request(this.h.app).get(path).set(bearer(token));

  async allowNetwork(cidr: string, active = true): Promise<void> {
    await this.h.testDb.query(
      `insert into public.office_networks (office_id, label, cidr, is_active)
       values ($1, $2, $3::cidr, $4)`,
      [this.officeId, `Allowed ${cidr}`, cidr, active],
    );
  }

  async forgetNetworks(): Promise<void> {
    await this.h.testDb.query('delete from public.office_networks');
  }

  /** What the person at the scanner must prove about themselves (GPS and NETWORK always stay). */
  async setAdminScanLayers(layers: VerificationLayer[]): Promise<void> {
    await this.h.testDb.query(
      `update public.attendance_policies set admin_scan_layers = $1::text[]::public.verification_layer[]`,
      [layers],
    );
  }

  /** A good location fix: at the office, precise, five seconds old. */
  gps = (over: Body = {}) => ({
    latitude: OFFICE.latitude,
    longitude: OFFICE.longitude,
    accuracyM: 10,
    fixTime: this.h.clock.now().getTime() - 5_000,
    ...over,
  });

  /** A fix this many metres north of the office. */
  gpsMetresNorth = (metres: number) =>
    this.gps({ latitude: OFFICE.latitude + metres / METRES_PER_DEGREE });

  // ---- the QR flow ------------------------------------------------------------------------

  /** A person's own code, as their profile page would fetch it. */
  async codeOf(who: Account): Promise<string> {
    const token = await accessTokenFor(this.h, who);
    const res = await this.get('/api/employee-qr/me', token);
    expect(res.status).toBe(200);
    expect(res.body.payload).toMatch(/^TGE1\./);
    return res.body.payload as string;
  }

  scan = (
    payload: string,
    token = this.tok.operator,
    scanner: Body = { kind: 'WEB', label: 'Front desk' },
  ) => this.post('/api/qr-attendance/scan', { payload, scanner }, token);

  verifyScan = (scanId: string, body?: Body, token = this.tok.operator) =>
    this.post(
      `/api/qr-attendance/scans/${scanId}/verify`,
      body ?? { channel: 'WEB', gps: this.gps() },
      token,
    );

  confirm = (
    scanId: string,
    action: string,
    key: string = randomUUID(),
    token = this.tok.operator,
  ) =>
    request(this.h.app)
      .post(`/api/qr-attendance/scans/${scanId}/confirm`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send({ action });

  /** Scan, prove presence, confirm: the whole thing, asserting that each step worked. */
  async record(
    payload: string,
    action: 'CHECK_IN' | 'CHECK_OUT',
    token = this.tok.operator,
  ): Promise<{ scan: ScanResolution; confirmation: ConfirmScanResponse }> {
    const scan = await this.scan(payload, token);
    expect(scan.status).toBe(200);
    expect(scan.body.action).toBe(action);
    const verified = await this.verifyScan(scan.body.scanId as string, undefined, token);
    expect(verified.status).toBe(200);
    const done = await this.confirm(scan.body.scanId as string, action, undefined, token);
    expect(done.status).toBe(200);
    return { scan: scan.body as ScanResolution, confirmation: done.body as ConfirmScanResponse };
  }

  // ---- database peeks ---------------------------------------------------------------------

  async scanRow(scanId: string) {
    const [row] = await this.h.testDb.query<{
      status: string;
      detected_action: string;
      qr_result: string;
      reason_code: string | null;
      employee_id: string | null;
      scanned_by: string;
      token_hash: Uint8Array | null;
      office_verification_id: string | null;
      office_verification_result: string | null;
      confirmed_action: string | null;
      attendance_event_id: string | null;
      scanner: Record<string, unknown>;
    }>('select * from public.qr_scan_logs where id = $1', [scanId]);
    return row;
  }

  async events(employeeId: string, type?: string) {
    return this.h.testDb.query<{
      id: string;
      event_type: string;
      source: string;
      actor_id: string | null;
      verification_id: string | null;
      occurred_at: Date;
      metadata: Record<string, unknown>;
    }>(
      `select id, event_type::text, source, actor_id, verification_id, occurred_at, metadata
       from public.attendance_events
       where employee_id = $1 and ($2::text is null or event_type::text = $2)
       order by id`,
      [employeeId, type ?? null],
    );
  }

  async record_(employeeId: string) {
    const [row] = await this.h.testDb.query<{
      id: string;
      status: string;
      is_late: boolean;
      live_state: string;
      check_in_at: Date | null;
      check_out_at: Date | null;
      net_work_seconds: number | null;
      check_in_verification_id: string | null;
      check_in_device_id: string | null;
    }>('select * from public.attendance_records where employee_id = $1', [employeeId]);
    return row;
  }
}
