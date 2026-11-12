import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyAttendanceReport } from '@teachgrow/shared';
import { session } from '../lib/api';
import { json, mockFetch, renderApp } from '../test/utils';
import { AttendancePage } from './attendance';

const report = (over: Partial<DailyAttendanceReport> = {}): DailyAttendanceReport => ({
  date: '2026-11-02',
  isToday: true,
  summary: { total: 3, present: 2, late: 1, absent: 1, onLeave: 0 },
  warnings: { duplicateScans: 0, invalidOrExpiredScans: 0 },
  rows: [
    {
      employeeId: 'a',
      employeeCode: 'E-1001',
      fullName: 'Priya Sharma',
      department: 'Academics',
      designation: null,
      state: 'PRESENT',
      checkInAt: '2026-11-02T04:25:00.000Z',
      checkOutAt: null,
      liveState: 'WORKING',
      isLate: false,
      netWorkSeconds: null,
      source: 'ADMIN_QR',
    },
    {
      employeeId: 'b',
      employeeCode: 'E-1002',
      fullName: 'Ravi Kumar',
      department: null,
      designation: null,
      state: 'LATE',
      checkInAt: '2026-11-02T05:10:00.000Z',
      checkOutAt: null,
      liveState: 'WORKING',
      isLate: true,
      netWorkSeconds: null,
      source: 'ADMIN_QR',
    },
    {
      employeeId: 'c',
      employeeCode: 'E-1003',
      fullName: 'Meena Iyer',
      department: 'Admin',
      designation: null,
      state: 'ABSENT',
      checkInAt: null,
      checkOutAt: null,
      liveState: 'NONE',
      isLate: false,
      netWorkSeconds: null,
      source: null,
    },
  ],
  ...over,
});

beforeEach(() => {
  session.set('test-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the attendance dashboard', () => {
  it('shows who is present, late and absent, with check-in times', async () => {
    mockFetch({ 'GET /api/admin/attendance/daily': json(200, report()) });
    renderApp(<AttendancePage />);

    expect(await screen.findByText('Priya Sharma')).toBeInTheDocument();
    for (const label of ['Present', 'Late arrivals', 'Absent', 'On leave']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    const table = screen.getByRole('table');
    const ravi = within(table).getByText('Ravi Kumar').closest('tr')!;
    expect(within(ravi).getByText('Late')).toBeInTheDocument();
    const meena = within(table).getByText('Meena Iyer').closest('tr')!;
    expect(within(meena).getByText('Absent')).toBeInTheDocument();
    expect(screen.queryByText('Scan warnings for this day')).toBeNull();
  });

  it('shows duplicate and invalid-scan warnings, and a way to the history', async () => {
    const user = userEvent.setup();
    mockFetch({
      'GET /api/admin/attendance/daily': json(
        200,
        report({ warnings: { duplicateScans: 2, invalidOrExpiredScans: 1 } }),
      ),
      'GET /api/admin/qr-scans': json(200, { items: [], page: 1, pageSize: 25, total: 0 }),
      'GET /api/admin/employee-qr': json(200, { items: [], page: 1, pageSize: 8, total: 0 }),
    });
    renderApp(<AttendancePage />);
    const warning = await screen.findByText('Scan warnings for this day');
    const box = warning.closest('div')!;
    expect(box).toHaveTextContent('2 duplicate scans');
    expect(box).toHaveTextContent('1 invalid or expired code');
    await user.click(screen.getByRole('button', { name: 'See the scan history' }));
    expect(
      await screen.findByRole('tab', { name: /Scan history/, selected: true }),
    ).toBeInTheDocument();
  });

  it('filters to the people who are late or absent', async () => {
    const user = userEvent.setup();
    mockFetch({ 'GET /api/admin/attendance/daily': json(200, report()) });
    renderApp(<AttendancePage />);
    await screen.findByText('Priya Sharma');

    await user.click(screen.getByRole('button', { name: 'Absent' }));
    expect(screen.queryByText('Priya Sharma')).toBeNull();
    expect(screen.getByText('Meena Iyer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Late' }));
    expect(screen.getByText('Ravi Kumar')).toBeInTheDocument();
    expect(screen.queryByText('Meena Iyer')).toBeNull();
  });

  it('loads another day when a date is chosen', async () => {
    const net = mockFetch({
      'GET /api/admin/attendance/daily': (request) =>
        json(
          200,
          report(
            request.url.includes('date=2026-10-30') ? { date: '2026-10-30', isToday: false } : {},
          ),
        ),
    });
    renderApp(<AttendancePage />);
    await screen.findByText('Priya Sharma');
    const date = screen.getByLabelText('Date');
    fireEvent.change(date, { target: { value: '2026-10-30' } });
    await screen.findByRole('button', { name: 'Back to today' });
    expect(net.urls().some((url) => url.includes('date=2026-10-30'))).toBe(true);
  });

  it('says when nobody is tracked, and when the report fails', async () => {
    mockFetch({
      'GET /api/admin/attendance/daily': json(
        200,
        report({ rows: [], summary: { total: 0, present: 0, late: 0, absent: 0, onLeave: 0 } }),
      ),
    });
    const { unmount } = renderApp(<AttendancePage />);
    expect(
      await screen.findByText('No employees are tracked for attendance yet.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled();
    unmount();

    mockFetch({
      'GET /api/admin/attendance/daily': json(503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Try later.' },
      }),
    });
    renderApp(<AttendancePage />);
    expect(await screen.findByText('The report could not be loaded')).toBeInTheDocument();
  });

  it('downloads the day as a CSV', async () => {
    const user = userEvent.setup();
    mockFetch({ 'GET /api/admin/attendance/daily': json(200, report()) });
    let saved: Blob | null = null;
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        saved = blob;
        return 'blob:test';
      },
      revokeObjectURL: vi.fn(),
    });
    // jsdom cannot follow a download link
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderApp(<AttendancePage />);
    await screen.findByText('Priya Sharma');
    await user.click(screen.getByRole('button', { name: /Download CSV/ }));
    const blob = saved as Blob | null;
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob!);
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      'Employee ID,Name,Department,Status,Check-in,Check-out,Net hours,Recorded by',
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('E-1001,Priya Sharma,Academics,Present');
    expect(lines[3]).toContain('E-1003,Meena Iyer,Admin,Absent');
  });
});

describe('the scan history tab', () => {
  const scan = (over: Record<string, unknown>) => ({
    id: Math.random().toString(),
    scannedAt: '2026-11-02T04:30:00.000Z',
    status: 'RECORDED',
    qrResult: 'VALID',
    detectedAction: 'CHECK_IN',
    reasonCode: null,
    employee: { id: 'a', employeeCode: 'E-1001', fullName: 'Priya Sharma' },
    scannedBy: { id: 'x', employeeCode: 'A-001', fullName: 'Asha Admin', role: 'admin' },
    confirmedAt: '2026-11-02T04:30:00.000Z',
    confirmedAction: 'CHECK_IN',
    officeVerification: null,
    attendanceEventId: '1',
    scanner: { label: 'Chrome on Windows' },
    clientIp: '203.0.113.9',
    ...over,
  });

  it('lists recorded and refused scans with the scanner, the device and the address', async () => {
    mockFetch({
      'GET /api/admin/employees': json(200, { items: [], page: 1, pageSize: 200, total: 0 }),
      'GET /api/admin/employee-qr': json(200, { items: [], page: 1, pageSize: 8, total: 0 }),
      'GET /api/admin/qr-scans': json(200, {
        items: [
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
        ],
        page: 1,
        pageSize: 25,
        total: 4,
      }),
    });
    renderApp(<AttendancePage />, { route: '/admin/attendance?tab=history' });

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Checked in')).toBeInTheDocument();
    expect(within(table).getByText('Duplicate scan')).toBeInTheDocument();
    expect(within(table).getByText('Expired code')).toBeInTheDocument();
    expect(within(table).getByText('Code not recognised')).toBeInTheDocument();
    expect(within(table).getByText('Unknown code')).toBeInTheDocument();
    expect(within(table).getAllByText('Chrome on Windows').length).toBe(4);
    expect(within(table).getAllByText('203.0.113.9').length).toBe(4);
    // the scanner is never location-checked, so there is no "office check" to show any more
    expect(within(table).queryByText('Office check')).toBeNull();
  });

  it('filters by outcome, without offering the old two-step outcomes', async () => {
    const user = userEvent.setup();
    const net = mockFetch({
      'GET /api/admin/employees': json(200, { items: [], page: 1, pageSize: 200, total: 0 }),
      'GET /api/admin/employee-qr': json(200, { items: [], page: 1, pageSize: 8, total: 0 }),
      'GET /api/admin/qr-scans': json(200, { items: [], page: 1, pageSize: 25, total: 0 }),
    });
    renderApp(<AttendancePage />, { route: '/admin/attendance?tab=history' });

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
});
