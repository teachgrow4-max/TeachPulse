import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminEmployeeQrDetail, AdminEmployeeQrRow, ScanLogDto } from '@teachgrow/shared';
import { session } from '../lib/api';
import { json, mockFetch, renderApp } from '../test/utils';
import { QrManagementPage } from './qr-management';

const PAYLOAD = `TGE1.${'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde'.slice(0, 43)}`;
const PRIYA = '11111111-1111-4111-8111-111111111111';
const RAHUL = '44444444-4444-4444-8444-444444444444';

const row = (
  id: string,
  name: string,
  code: string,
  status: 'ACTIVE' | 'REVOKED' | 'NONE',
  over: Partial<AdminEmployeeQrRow['employee']> = {},
): AdminEmployeeQrRow => ({
  employee: {
    id,
    employeeCode: code,
    fullName: name,
    email: `${code}@demo.test`,
    role: 'employee',
    department: 'Academics',
    designation: null,
    isActive: true,
    ...over,
  },
  qr: {
    status,
    generatedAt: status === 'NONE' ? null : '2026-11-01T05:00:00.000Z',
    revokedAt: status === 'REVOKED' ? '2026-11-02T05:00:00.000Z' : null,
    issued: status === 'NONE' ? 0 : 1,
  },
  lastScanAt: id === PRIYA ? '2026-11-02T04:30:00.000Z' : null,
});

const list = (items: AdminEmployeeQrRow[]) =>
  json(200, { items, page: 1, pageSize: 25, total: items.length });

const detail = (over: Partial<AdminEmployeeQrDetail> = {}): AdminEmployeeQrDetail => ({
  employeeId: PRIYA,
  status: 'ACTIVE',
  payload: PAYLOAD,
  generatedAt: '2026-11-01T05:00:00.000Z',
  revokedAt: null,
  holder: {
    employeeCode: 'E-1001',
    fullName: 'Priya Sharma',
    department: 'Academics',
    designation: 'Maths Teacher',
    avatarUrl: null,
  },
  history: [
    {
      id: 'c2',
      status: 'ACTIVE',
      generatedAt: '2026-11-01T05:00:00.000Z',
      generatedBy: { id: 'a', fullName: 'Asha Admin' },
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    },
    {
      id: 'c1',
      status: 'REVOKED',
      generatedAt: '2026-10-01T05:00:00.000Z',
      generatedBy: null,
      revokedAt: '2026-11-01T05:00:00.000Z',
      revokedBy: { id: 'a', fullName: 'Asha Admin' },
      revokeReason: 'Card photographed',
    },
  ],
  ...over,
});

const scanRow = (over: Partial<ScanLogDto> = {}): ScanLogDto => ({
  id: 's1',
  scannedAt: '2026-11-02T04:30:00.000Z',
  status: 'RECORDED',
  qrResult: 'VALID',
  detectedAction: 'CHECK_IN',
  reasonCode: null,
  employee: { id: PRIYA, employeeCode: 'E-1001', fullName: 'Priya Sharma' },
  scannedBy: {
    id: 'o',
    employeeCode: 'O-1',
    fullName: 'Omar Operator',
    role: 'attendance_operator',
  },
  confirmedAt: '2026-11-02T04:30:20.000Z',
  confirmedAction: 'CHECK_IN',
  officeVerification: 'VERIFIED',
  attendanceEventId: '9',
  scanner: { label: 'Chrome on Android' },
  clientIp: '203.0.113.7',
  ...over,
});

beforeEach(() => {
  session.set('test-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const baseRoutes = () => ({
  'GET /api/admin/departments': json(200, {
    items: [{ id: 'd1', name: 'Academics', isActive: true }],
  }),
  'GET /api/admin/employee-qr': list([
    row(PRIYA, 'Priya Sharma', 'E-1001', 'ACTIVE'),
    row(RAHUL, 'Rahul Verma', 'E-1002', 'REVOKED'),
    row('55555555-5555-4555-8555-555555555555', 'Meera Nair', 'E-1003', 'NONE', {
      isActive: false,
    }),
  ]),
});

describe('QR management: employee codes', () => {
  it('lists everybody with the state of their code and when they were last scanned', async () => {
    mockFetch(baseRoutes());
    renderApp(<QrManagementPage />);
    expect(await screen.findByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Rahul Verma')).toBeInTheDocument();
    expect(screen.getByText('(inactive)')).toBeInTheDocument();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Revoked').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No code').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Last scanned: never/).length).toBe(2);
  });

  it('searches and filters on the server', async () => {
    const user = userEvent.setup();
    const { urls } = mockFetch(baseRoutes());
    renderApp(<QrManagementPage />);
    await screen.findByText('Priya Sharma');

    await user.type(screen.getByLabelText('Search employees'), 'rahul');
    await waitFor(() => expect(urls().some((u) => u.includes('search=rahul'))).toBe(true));

    await user.selectOptions(screen.getByLabelText('Filter by QR code'), 'REVOKED');
    await waitFor(() => expect(urls().some((u) => u.includes('qrStatus=REVOKED'))).toBe(true));
  });

  it('shows a person’s code with its downloads and its history', async () => {
    const user = userEvent.setup();
    mockFetch({ ...baseRoutes(), [`GET /api/admin/employee-qr/${PRIYA}`]: json(200, detail()) });
    renderApp(<QrManagementPage />);
    await user.click(await screen.findByRole('button', { name: 'View QR code for Priya Sharma' }));

    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByRole('img', { name: 'QR code for Priya Sharma' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Download PNG/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Download PDF/ })).toBeInTheDocument();
    expect(within(dialog).getByText(/Card photographed/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Issued .* automatically/)).toBeInTheDocument();
  });

  it('regenerates a code only after the administrator confirms', async () => {
    const user = userEvent.setup();
    const { called } = mockFetch({
      ...baseRoutes(),
      [`GET /api/admin/employee-qr/${PRIYA}`]: json(200, detail()),
      [`POST /api/admin/employee-qr/${PRIYA}/regenerate`]: json(200, detail()),
    });
    renderApp(<QrManagementPage />);
    await user.click(await screen.findByRole('button', { name: 'View QR code for Priya Sharma' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: /^Regenerate$/ }));

    expect(within(dialog).getByText('Regenerate this code?')).toBeInTheDocument();
    expect(called(`POST /api/admin/employee-qr/${PRIYA}/regenerate`)).toHaveLength(0);

    await user.type(within(dialog).getByLabelText(/Reason/), 'Photographed on social media');
    await user.click(within(dialog).getByRole('button', { name: 'Regenerate code' }));

    expect(await screen.findByText('New QR code issued')).toBeInTheDocument();
    expect(called(`POST /api/admin/employee-qr/${PRIYA}/regenerate`)[0]?.body).toEqual({
      reason: 'Photographed on social media',
    });
  });

  it('will not revoke without a reason', async () => {
    const user = userEvent.setup();
    const { called } = mockFetch({
      ...baseRoutes(),
      [`GET /api/admin/employee-qr/${PRIYA}`]: json(200, detail()),
      [`POST /api/admin/employee-qr/${PRIYA}/revoke`]: json(
        200,
        detail({ status: 'REVOKED', payload: null }),
      ),
    });
    renderApp(<QrManagementPage />);
    await user.click(await screen.findByRole('button', { name: 'View QR code for Priya Sharma' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: /Revoke/ }));

    const confirm = within(dialog).getByRole('button', { name: 'Revoke this code' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Reason/), 'ID card reported lost');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(await screen.findByText('QR code revoked')).toBeInTheDocument();
    expect(called(`POST /api/admin/employee-qr/${PRIYA}/revoke`)[0]?.body).toEqual({
      reason: 'ID card reported lost',
    });
  });

  it('offers no revoke for a code that is already revoked, and says so', async () => {
    const user = userEvent.setup();
    mockFetch({
      ...baseRoutes(),
      [`GET /api/admin/employee-qr/${RAHUL}`]: json(
        200,
        detail({
          employeeId: RAHUL,
          status: 'REVOKED',
          payload: null,
          holder: {
            employeeCode: 'E-1002',
            fullName: 'Rahul Verma',
            department: null,
            designation: null,
            avatarUrl: null,
          },
        }),
      ),
    });
    renderApp(<QrManagementPage />);
    await user.click(await screen.findByRole('button', { name: 'View QR code for Rahul Verma' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('This QR code was revoked')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Revoke/ })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^Regenerate$/ })).toBeEnabled();
    expect(within(dialog).queryByRole('img')).toBeNull();
  });

  it('issues the codes that are missing and says how many', async () => {
    const user = userEvent.setup();
    mockFetch({
      ...baseRoutes(),
      'POST /api/admin/employee-qr/backfill': json(200, { issued: 2 }),
    });
    renderApp(<QrManagementPage />);
    await user.click(await screen.findByRole('button', { name: /Issue missing codes/ }));
    expect(await screen.findByText('2 new codes issued')).toBeInTheDocument();
  });

  it('says plainly when the list cannot be loaded', async () => {
    mockFetch({
      ...baseRoutes(),
      'GET /api/admin/employee-qr': json(500, {
        error: { code: 'INTERNAL', message: 'Something went wrong on our side.' },
      }),
    });
    renderApp(<QrManagementPage />);
    expect(await screen.findByText('The list could not be loaded')).toBeInTheDocument();
  });
});

describe('QR management: scan history', () => {
  const routes = () => ({
    ...baseRoutes(),
    // administrators and operators are asked for separately
    'GET /api/admin/employees': (request: { url: string }) =>
      json(200, {
        items: request.url.includes('role=attendance_operator')
          ? [{ id: 'o', fullName: 'Omar Operator', role: 'attendance_operator' }]
          : [{ id: 'a', fullName: 'Asha Admin', role: 'admin' }],
        page: 1,
        pageSize: 200,
        total: 1,
      }),
    'GET /api/admin/qr-scans': json(200, {
      items: [
        scanRow(),
        scanRow({
          id: 's2',
          status: 'REJECTED',
          qrResult: 'REVOKED',
          reasonCode: 'EMPLOYEE_QR_REVOKED',
          confirmedAt: null,
          confirmedAction: null,
          officeVerification: null,
          attendanceEventId: null,
          scannedBy: { id: 'a', employeeCode: 'A-1', fullName: 'Asha Admin', role: 'admin' },
        }),
      ],
      page: 1,
      pageSize: 25,
      total: 2,
    }),
  });

  it('shows who recorded each scan and what became of it', async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderApp(<QrManagementPage />, { route: '/admin/qr?tab=history' });

    const table = await screen.findByRole('table', { name: 'QR scan history' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2
    expect(within(rows[1]!).getByText('Priya Sharma')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Checked in')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Omar Operator')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Operator')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Verified')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('203.0.113.7')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Revoked code')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Asha Admin')).toBeInTheDocument();

    // the tabs switch back and forth
    await user.click(screen.getByRole('tab', { name: /Employee codes/ }));
    expect(await screen.findByLabelText('Search employees')).toBeInTheDocument();
  });

  it('filters by date, person who recorded it, and outcome, on the server', async () => {
    const user = userEvent.setup();
    const { urls } = mockFetch(routes());
    renderApp(<QrManagementPage />, { route: '/admin/qr?tab=history' });
    await screen.findByRole('table', { name: 'QR scan history' });

    await user.type(screen.getByLabelText('From'), '2026-11-01');
    await user.type(screen.getByLabelText('To'), '2026-11-30');
    await user.selectOptions(screen.getByLabelText('Outcome'), 'RECORDED');
    await user.selectOptions(
      await screen
        .findByRole('option', { name: /Omar Operator/ })
        .then(() => screen.getByLabelText('Recorded by')),
      'o',
    );

    await waitFor(() => {
      const last =
        urls()
          .filter((u) => u.includes('/api/admin/qr-scans'))
          .at(-1) ?? '';
      expect(last).toContain('from=2026-11-01');
      expect(last).toContain('to=2026-11-30');
      expect(last).toContain('status=RECORDED');
      expect(last).toContain('scannedBy=o');
    });
  });

  it('can be narrowed to one employee found by name', async () => {
    const user = userEvent.setup();
    const { urls } = mockFetch(routes());
    renderApp(<QrManagementPage />, { route: '/admin/qr?tab=history' });
    await screen.findByRole('table', { name: 'QR scan history' });

    await user.type(screen.getByRole('combobox', { name: 'Employee' }), 'priya');
    const option = await screen.findByRole('option', { name: /Priya Sharma/ });
    await user.click(option);

    expect(await screen.findByText('Priya Sharma (E-1001)')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        urls()
          .filter((u) => u.includes('/api/admin/qr-scans'))
          .at(-1),
      ).toContain(`employeeId=${PRIYA}`);
    });
  });

  it('warns when the date range runs backwards', async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderApp(<QrManagementPage />, { route: '/admin/qr?tab=history' });
    await screen.findByRole('table', { name: 'QR scan history' });
    await user.type(screen.getByLabelText('From'), '2026-11-10');
    await user.type(screen.getByLabelText('To'), '2026-11-01');
    expect(await screen.findByText(/“From” is after “to”/)).toBeInTheDocument();
  });

  it('has a friendly empty state', async () => {
    mockFetch({
      ...routes(),
      'GET /api/admin/qr-scans': json(200, { items: [], page: 1, pageSize: 25, total: 0 }),
    });
    renderApp(<QrManagementPage />, { route: '/admin/qr?tab=history' });
    expect(await screen.findByText('No scans yet')).toBeInTheDocument();
  });
});
