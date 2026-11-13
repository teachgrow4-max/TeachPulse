import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '../lib/api';
import { json, mockFetch, renderApp } from '../test/utils';
import { QrManagementPage } from './qr-management';

const PRIYA = '11111111-1111-4111-8111-111111111111';

const row = (over: Record<string, unknown> = {}) => ({
  employeeId: PRIYA,
  employeeCode: 'E-1001',
  fullName: 'Priya Sharma',
  email: 'priya@school.in',
  avatarUrl: null,
  department: 'Academics',
  designation: 'Maths Teacher',
  state: 'ACTIVE',
  generated: 1,
  latest: {
    action: 'CHECK_IN',
    issuedAt: '2026-11-02T04:28:00.000Z',
    expiresAt: '2026-11-02T04:29:30.000Z',
    usedAt: null,
  },
  lastScannedAt: null,
  ...over,
});

const overview = (over: Record<string, unknown> = {}) => ({
  date: '2026-11-02',
  isToday: true,
  summary: { total: 4, active: 1, used: 1, expired: 1, none: 1 },
  maxPerDay: 5,
  ttlSeconds: 90,
  rows: [
    row(),
    row({
      employeeId: 'b',
      employeeCode: 'E-1002',
      fullName: 'Ravi Kumar',
      email: 'ravi@school.in',
      department: null,
      state: 'USED',
      latest: {
        action: 'CHECK_IN',
        issuedAt: '2026-11-02T04:20:00.000Z',
        expiresAt: '2026-11-02T04:21:30.000Z',
        usedAt: '2026-11-02T04:21:00.000Z',
      },
      lastScannedAt: '2026-11-02T04:21:00.000Z',
    }),
    row({
      employeeId: 'c',
      employeeCode: 'E-1003',
      fullName: 'Meena Iyer',
      email: 'meena@school.in',
      department: 'Admin',
      state: 'EXPIRED',
      latest: {
        action: 'CHECK_OUT',
        issuedAt: '2026-11-02T04:00:00.000Z',
        expiresAt: '2026-11-02T04:01:30.000Z',
        usedAt: null,
      },
    }),
    row({
      employeeId: 'd',
      employeeCode: 'E-1004',
      fullName: 'Asha Rao',
      email: 'asha@school.in',
      department: 'Admin',
      state: 'NONE',
      generated: 0,
      latest: null,
    }),
  ],
  page: 1,
  pageSize: 15,
  total: 4,
  ...over,
});

const departments = json(200, {
  items: [
    { id: '22222222-2222-4222-8222-222222222222', name: 'Academics', isActive: true },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Admin', isActive: true },
  ],
});

/** Shows where the router is, so a test can see that a menu item navigated. */
function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

const phoneWidth = () => {
  const wide = window.matchMedia;
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
  return () => {
    window.matchMedia = wide;
  };
};

beforeEach(() => {
  session.set('test-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QR management', () => {
  it('summarises the day and shows where each employee’s code stands', async () => {
    mockFetch({
      'GET /api/admin/qr/overview': json(200, overview()),
      'GET /api/admin/departments': departments,
    });
    renderApp(<QrManagementPage />);

    expect(screen.getByRole('heading', { name: 'QR Management' })).toBeInTheDocument();
    expect(
      screen.getByText('Manage employee QR credentials and monitor attendance scanning activity.'),
    ).toBeInTheDocument();

    const table = await screen.findByRole('table');
    const summary = within(screen.getByLabelText('QR summary'));
    const stat = (label: string) => summary.getByText(label).parentElement!;
    expect(stat('Total employees')).toHaveTextContent(/Total employees4/);
    expect(stat('Active QR codes')).toHaveTextContent(/Active QR codes1/);
    expect(stat('Scanned')).toHaveTextContent(/Scanned1/);
    expect(stat('Missing QR codes')).toHaveTextContent(/Missing QR codes1/);
    expect(stat('Expired codes')).toHaveTextContent(/Expired codes1/);
    expect(stat('Active QR codes')).toHaveTextContent('each lasts 90 s');

    const priya = within(table).getByText('Priya Sharma').closest('tr')!;
    expect(within(priya).getByText('Active')).toBeInTheDocument();
    expect(within(priya).getByText('E-1001')).toBeInTheDocument();
    expect(within(priya).getByText('Academics')).toBeInTheDocument();
    expect(within(priya).getByText('priya@school.in')).toBeInTheDocument();
    expect(within(priya).getByText(/Check-in code · valid until/)).toBeInTheDocument();
    expect(within(priya).getByText('Never')).toBeInTheDocument();

    const ravi = within(table).getByText('Ravi Kumar').closest('tr')!;
    expect(within(ravi).getByText('Scanned')).toBeInTheDocument();
    expect(within(ravi).getByText(/scanned at/)).toBeInTheDocument();
    expect(within(ravi).queryByText('Never')).toBeNull();

    const meena = within(table).getByText('Meena Iyer').closest('tr')!;
    expect(within(meena).getByText('Expired')).toBeInTheDocument();
    expect(
      within(meena).getByText(/Check-out code · ran out at .*never scanned/),
    ).toBeInTheDocument();

    const asha = within(table).getByText('Asha Rao').closest('tr')!;
    expect(within(asha).getByText('Not generated')).toBeInTheDocument();
  });

  it('searches, filters and pages on the server', async () => {
    const user = userEvent.setup();
    const net = mockFetch({
      'GET /api/admin/qr/overview': json(200, overview({ total: 40 })),
      'GET /api/admin/departments': departments,
    });
    renderApp(<QrManagementPage />);
    await screen.findByRole('table');
    const asked = (part: string) =>
      net.urls().some((url) => url.includes('/api/admin/qr/overview') && url.includes(part));

    await user.type(screen.getByLabelText('Search employees'), 'ravi');
    await vi.waitFor(() => expect(asked('search=ravi')).toBe(true));

    await user.selectOptions(screen.getByLabelText('QR status'), 'EXPIRED');
    await vi.waitFor(() => expect(asked('state=EXPIRED')).toBe(true));

    await user.selectOptions(
      screen.getByLabelText('Department'),
      '33333333-3333-4333-8333-333333333333',
    );
    await vi.waitFor(() => expect(asked('departmentId=33333333')).toBe(true));

    // every filter change starts again from the first page; "Next" asks for the second
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await vi.waitFor(() => expect(asked('page=2')).toBe(true));

    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    expect(screen.getByLabelText('Search employees')).toHaveValue('');
    expect(screen.getByLabelText('QR status')).toHaveValue('');
  });

  it('offers only the QR statuses that exist', async () => {
    mockFetch({
      'GET /api/admin/qr/overview': json(200, overview()),
      'GET /api/admin/departments': departments,
    });
    renderApp(<QrManagementPage />);
    await screen.findByRole('table');
    const options = within(screen.getByLabelText('QR status'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['All QR statuses', 'Active', 'Scanned', 'Expired', 'Not generated']);
  });

  it('shows another day, and says "that day" for the missing codes', async () => {
    const net = mockFetch({
      'GET /api/admin/qr/overview': (request) =>
        json(
          200,
          request.url.includes('date=2026-10-30')
            ? overview({ date: '2026-10-30', isToday: false })
            : overview(),
        ),
      'GET /api/admin/departments': departments,
    });
    renderApp(<QrManagementPage />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-10-30' } });
    expect(await screen.findByText('No code made that day')).toBeInTheDocument();
    expect(net.urls().some((url) => url.includes('date=2026-10-30'))).toBe(true);
  });

  it('opens an employee’s QR activity from the row menu', async () => {
    const user = userEvent.setup();
    const net = mockFetch({
      'GET /api/admin/qr/overview': json(200, overview()),
      'GET /api/admin/departments': departments,
      'GET /api/admin/qr-scans': json(200, {
        items: [
          {
            id: 's1',
            scannedAt: '2026-11-02T04:30:00.000Z',
            status: 'RECORDED',
            qrResult: 'VALID',
            detectedAction: 'CHECK_IN',
            reasonCode: null,
            employee: { id: PRIYA, employeeCode: 'E-1001', fullName: 'Priya Sharma' },
            scannedBy: { id: 'x', employeeCode: 'A-001', fullName: 'Asha Admin', role: 'admin' },
            confirmedAt: null,
            confirmedAction: 'CHECK_IN',
            officeVerification: null,
            attendanceEventId: '1',
            scanner: {},
            clientIp: null,
          },
        ],
        page: 1,
        pageSize: 8,
        total: 1,
      }),
    });
    renderApp(<QrManagementPage />);
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Actions for Priya Sharma' }));
    await user.click(await screen.findByRole('menuitem', { name: 'View QR activity' }));

    const dialog = await screen.findByRole('dialog', { name: 'QR activity' });
    expect(within(dialog).getByText('Priya Sharma')).toBeInTheDocument();
    expect(within(dialog).getByText('Maths Teacher · Academics')).toBeInTheDocument();
    expect(await within(dialog).findByText('Scanned by Asha Admin')).toBeInTheDocument();
    expect(within(dialog).getByText('Checked in')).toBeInTheDocument();
    // there is nothing to view, print or reissue, and the dialog says why
    expect(within(dialog).getByText(/cannot be viewed, printed or reissued/)).toBeInTheDocument();
    expect(
      net
        .urls()
        .some((url) => url.includes('/api/admin/qr-scans') && url.includes(`employeeId=${PRIYA}`)),
    ).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the scan history for one employee from the row menu', async () => {
    const user = userEvent.setup();
    mockFetch({
      'GET /api/admin/qr/overview': json(200, overview()),
      'GET /api/admin/departments': departments,
    });
    renderApp(
      <>
        <QrManagementPage />
        <Where />
      </>,
    );
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Actions for Ravi Kumar' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Open scan history' }));
    expect(screen.getByTestId('where')).toHaveTextContent(
      '/admin/scan-history?employee=b&name=Ravi%20Kumar',
    );
  });

  it('says so when nobody matches, and when the page cannot be loaded', async () => {
    mockFetch({
      'GET /api/admin/qr/overview': json(200, overview({ rows: [], total: 0 })),
      'GET /api/admin/departments': departments,
    });
    const { unmount } = renderApp(<QrManagementPage />);
    expect(await screen.findByText('No employees to show')).toBeInTheDocument();
    unmount();

    mockFetch({
      'GET /api/admin/qr/overview': json(503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Try later.' },
      }),
      'GET /api/admin/departments': departments,
    });
    renderApp(<QrManagementPage />);
    expect(await screen.findByText('QR management could not be loaded')).toBeInTheDocument();
  });

  it('offers a way to a filter that matches nobody to be cleared', async () => {
    const user = userEvent.setup();
    mockFetch({
      'GET /api/admin/qr/overview': (request) =>
        json(200, request.url.includes('state=') ? overview({ rows: [], total: 0 }) : overview()),
      'GET /api/admin/departments': departments,
    });
    renderApp(<QrManagementPage />);
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('QR status'), 'ACTIVE');
    expect(await screen.findByText('No employees match these filters')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1)!);
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('lists the employees as cards on a phone', async () => {
    const restore = phoneWidth();
    try {
      mockFetch({
        'GET /api/admin/qr/overview': json(200, overview()),
        'GET /api/admin/departments': departments,
      });
      renderApp(<QrManagementPage />);
      await screen.findByText('Ravi Kumar');
      expect(screen.queryByRole('table')).toBeNull();
      const meena = screen.getByText('Meena Iyer').closest('li')!;
      expect(within(meena).getByText('Expired')).toBeInTheDocument();
      expect(within(meena).getByText(/E-1003 · Admin/)).toBeInTheDocument();
      expect(
        within(meena).getByRole('button', { name: 'Actions for Meena Iyer' }),
      ).toBeInTheDocument();
    } finally {
      restore();
    }
  });
});
