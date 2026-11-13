import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '../lib/api';
import { json, mockFetch, renderApp } from '../test/utils';
import { ScanHistoryPage } from './scan-history';

const PRIYA = '11111111-1111-4111-8111-111111111111';

const scan = (over: Record<string, unknown>) => ({
  id: Math.random().toString(),
  scannedAt: '2026-11-02T04:30:00.000Z',
  status: 'RECORDED',
  qrResult: 'VALID',
  detectedAction: 'CHECK_IN',
  reasonCode: null,
  employee: { id: PRIYA, employeeCode: 'E-1001', fullName: 'Priya Sharma', avatarUrl: null },
  scannedBy: {
    id: 'x',
    employeeCode: 'A-001',
    fullName: 'Asha Admin',
    avatarUrl: null,
    role: 'admin',
  },
  confirmedAt: '2026-11-02T04:30:00.000Z',
  confirmedAction: 'CHECK_IN',
  officeVerification: null,
  attendanceEventId: '1',
  scanner: { label: 'Chrome on Windows' },
  clientIp: '203.0.113.9',
  ...over,
});

const noStaff = json(200, { items: [], page: 1, pageSize: 200, total: 0 });
const page = (items: unknown[], total = items.length) =>
  json(200, { items, page: 1, pageSize: 25, total });

beforeEach(() => {
  session.set('test-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the scan history page', () => {
  it('lists recorded and refused scans with the scanner, the device and the address', async () => {
    mockFetch({
      'GET /api/admin/employees': noStaff,
      'GET /api/admin/qr-scans': page([
        scan({}),
        scan({
          status: 'REJECTED',
          qrResult: 'USED',
          reasonCode: 'QR_ALREADY_USED',
          confirmedAction: null,
          confirmedAt: null,
        }),
        scan({
          status: 'REJECTED',
          qrResult: 'EXPIRED',
          reasonCode: 'QR_EXPIRED',
          confirmedAction: null,
          confirmedAt: null,
        }),
        scan({
          status: 'REJECTED',
          qrResult: 'UNKNOWN',
          reasonCode: 'EMPLOYEE_QR_INVALID',
          employee: null,
          confirmedAction: null,
          confirmedAt: null,
        }),
      ]),
    });
    renderApp(<ScanHistoryPage />, { route: '/admin/scan-history' });

    expect(screen.getByRole('heading', { name: 'Scan History' })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Checked in')).toBeInTheDocument();
    expect(within(table).getByText('Duplicate scan')).toBeInTheDocument();
    expect(within(table).getByText('Expired code')).toBeInTheDocument();
    expect(within(table).getByText('Code not recognised')).toBeInTheDocument();
    expect(within(table).getByText('Unknown code')).toBeInTheDocument();
    // who was scanned, and who held the camera
    expect(within(table).getAllByText('E-1001').length).toBe(3);
    expect(within(table).getAllByText('Asha Admin').length).toBe(4);
    expect(within(table).getAllByText('Administrator').length).toBe(4);
    expect(within(table).getAllByText('Chrome on Windows').length).toBe(4);
    expect(within(table).getAllByText('203.0.113.9').length).toBe(4);
    // the scanner is never location-checked, so there is no "office check" to show any more
    expect(within(table).queryByText('Office check')).toBeNull();
  });

  it('filters by outcome, without offering the old two-step outcomes', async () => {
    const user = userEvent.setup();
    const net = mockFetch({
      'GET /api/admin/employees': noStaff,
      'GET /api/admin/qr-scans': page([]),
    });
    renderApp(<ScanHistoryPage />, { route: '/admin/scan-history' });

    const outcome = await screen.findByLabelText('Outcome');
    const options = within(outcome)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['All outcomes', 'Recorded', 'Nothing to do', 'Refused']);
    await user.selectOptions(outcome, 'REJECTED');
    await vi.waitFor(() =>
      expect(
        net
          .urls()
          .some((url) => url.includes('/api/admin/qr-scans') && url.includes('status=REJECTED')),
      ).toBe(true),
    );
  });

  it('finds an employee by name, and shows only their scans', async () => {
    const user = userEvent.setup();
    const net = mockFetch({
      'GET /api/admin/employees': (request) =>
        json(200, {
          items: request.url.includes('search=pri')
            ? [
                {
                  id: PRIYA,
                  employeeCode: 'E-1001',
                  fullName: 'Priya Sharma',
                  avatarUrl: null,
                },
              ]
            : [],
          page: 1,
          pageSize: 8,
          total: 1,
        }),
      'GET /api/admin/qr-scans': page([scan({})]),
    });
    renderApp(<ScanHistoryPage />, { route: '/admin/scan-history' });
    await user.type(await screen.findByLabelText('Employee'), 'pri');
    await user.click(await screen.findByRole('option', { name: /Priya Sharma/ }));

    await vi.waitFor(() =>
      expect(net.urls().some((url) => url.includes(`employeeId=${PRIYA}`))).toBe(true),
    );
    // the chosen person can be cleared again
    await user.click(screen.getByRole('button', { name: /Clear employee filter/ }));
    expect(await screen.findByLabelText('Employee')).toBeInTheDocument();
  });

  it('opens already filtered to one employee when linked from QR management', async () => {
    const net = mockFetch({
      'GET /api/admin/employees': noStaff,
      'GET /api/admin/qr-scans': page([scan({})]),
    });
    renderApp(<ScanHistoryPage />, {
      route: `/admin/scan-history?employee=${PRIYA}&name=Priya%20Sharma`,
    });
    expect(await screen.findByText('Priya Sharma')).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        net
          .urls()
          .some(
            (url) => url.includes('/api/admin/qr-scans') && url.includes(`employeeId=${PRIYA}`),
          ),
      ).toBe(true),
    );
  });

  it('ignores a link that does not carry a real employee id', async () => {
    const net = mockFetch({
      'GET /api/admin/employees': noStaff,
      'GET /api/admin/qr-scans': page([]),
    });
    renderApp(<ScanHistoryPage />, { route: '/admin/scan-history?employee=not-an-id&name=Nobody' });
    await screen.findByText('No scans yet');
    expect(net.urls().some((url) => url.includes('employeeId='))).toBe(false);
  });

  it('pages through a long history', async () => {
    const user = userEvent.setup();
    const net = mockFetch({
      'GET /api/admin/employees': noStaff,
      'GET /api/admin/qr-scans': page([scan({})], 60),
    });
    renderApp(<ScanHistoryPage />, { route: '/admin/scan-history' });
    await screen.findByText('Page 1 of 3');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await vi.waitFor(() =>
      expect(
        net.urls().some((url) => url.includes('/api/admin/qr-scans') && url.includes('page=2')),
      ).toBe(true),
    );
  });

  it('says so when nothing matches the filters, and when the history cannot be loaded', async () => {
    const user = userEvent.setup();
    mockFetch({ 'GET /api/admin/employees': noStaff, 'GET /api/admin/qr-scans': page([]) });
    const { unmount } = renderApp(<ScanHistoryPage />, { route: '/admin/scan-history' });
    expect(await screen.findByText('No scans yet')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Outcome'), 'RECORDED');
    expect(await screen.findByText('No scans match these filters')).toBeInTheDocument();
    unmount();

    mockFetch({
      'GET /api/admin/employees': noStaff,
      'GET /api/admin/qr-scans': json(503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Try later.' },
      }),
    });
    renderApp(<ScanHistoryPage />, { route: '/admin/scan-history' });
    expect(await screen.findByText('The history could not be loaded')).toBeInTheDocument();
  });

  it('lists the scans as cards on a phone', async () => {
    const wide = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList;
    try {
      mockFetch({
        'GET /api/admin/employees': noStaff,
        'GET /api/admin/qr-scans': page([scan({})]),
      });
      renderApp(<ScanHistoryPage />, { route: '/admin/scan-history' });
      await screen.findByText('Priya Sharma');
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.getByText(/Recorded by Asha Admin/)).toBeInTheDocument();
    } finally {
      window.matchMedia = wide;
    }
  });
});
