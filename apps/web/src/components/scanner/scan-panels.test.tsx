import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ScanLogDto, ScanRecorded } from '@teachgrow/shared';
import { ApiError } from '../../lib/api';
import { RecentScans, RejectionPanel, SuccessPanel } from './scan-panels';

const recorded = (over: Partial<ScanRecorded> = {}): ScanRecorded => ({
  scanId: '33333333-3333-4333-8333-333333333333',
  action: 'CHECK_IN',
  recordedAt: '2026-11-02T04:55:00.000Z',
  source: 'ADMIN_QR',
  employee: {
    id: '11111111-1111-4111-8111-111111111111',
    employeeCode: 'E-1001',
    fullName: 'Priya Sharma',
    department: 'Academics',
    designation: 'Maths Teacher',
    avatarUrl: null,
  },
  attendance: {
    workDate: '2026-11-02',
    status: 'LATE',
    isLate: true,
    liveState: 'WORKING',
    checkInAt: '2026-11-02T04:55:00.000Z',
    checkOutAt: null,
    netWorkSeconds: null,
  },
  ...over,
});

describe('SuccessPanel', () => {
  it('shows who was recorded, with the ID, department, date, time and status', async () => {
    const user = userEvent.setup();
    const next = vi.fn();
    render(<SuccessPanel result={recorded()} onNext={next} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checked in');
    const card = screen.getByLabelText('Employee Priya Sharma');
    expect(within(card).getByText('Priya Sharma')).toBeInTheDocument();
    expect(within(card).getByText('E-1001')).toBeInTheDocument();
    expect(within(card).getByText('Academics')).toBeInTheDocument();
    expect(within(card).getByText('Late')).toBeInTheDocument();
    expect(within(card).getByText('Recorded by QR scan')).toBeInTheDocument();
    expect(within(card).getByText('Attendance date')).toBeInTheDocument();
    expect(within(card).getByText('Check-in time')).toBeInTheDocument();
    expect(within(card).getByText('Maths Teacher')).toBeInTheDocument();
    expect(within(card).getByText('Valid, now used')).toBeInTheDocument();
    // the confirmation says so, and gives the exact time
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Attendance recorded successfully');
    expect(status).toHaveTextContent(/\d{2}:\d{2}:\d{2}/);
    await user.click(screen.getByRole('button', { name: /Scan another employee/ }));
    expect(next).toHaveBeenCalled();
  });

  it('says Present for an on-time arrival and Checked out for a check-out', () => {
    const { rerender } = render(
      <SuccessPanel
        result={recorded({
          attendance: { ...recorded().attendance, status: 'PRESENT', isLate: false },
        })}
        onNext={vi.fn()}
      />,
    );
    expect(screen.getByText('Present')).toBeInTheDocument();
    rerender(<SuccessPanel result={recorded({ action: 'CHECK_OUT' })} onNext={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checked out');
  });

  it('falls back to initials when there is no photo', () => {
    render(<SuccessPanel result={recorded()} onNext={vi.fn()} />);
    expect(screen.getByText('PS')).toBeInTheDocument();
  });
});

describe('RejectionPanel', () => {
  it('explains a duplicate scan, naming the person and when it was first recorded', () => {
    const error = new ApiError(409, 'QR_ALREADY_USED', 'This QR code has already been scanned.', {
      scanId: 's',
      employee: { employeeCode: 'E-1001', fullName: 'Priya Sharma' },
      firstRecordedAt: '2026-11-02T04:30:00.000Z',
    });
    render(<RejectionPanel error={error} onNext={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Already scanned');
    expect(alert).toHaveTextContent('Priya Sharma');
    expect(alert).toHaveTextContent('First recorded at');
    expect(alert).toHaveTextContent('Nothing was recorded twice');
  });

  it('explains an expired code and an unrecognised one', () => {
    const { rerender } = render(
      <RejectionPanel
        error={new ApiError(422, 'QR_EXPIRED', 'This QR code has expired.')}
        onNext={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This QR code has expired');
    rerender(
      <RejectionPanel
        error={new ApiError(422, 'EMPLOYEE_QR_INVALID', 'This QR code is not recognised.')}
        onNext={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('QR code not recognised');
  });

  it('describes a lost connection in its own words, and offers to send the same code again', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(
      <RejectionPanel
        error={new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server.')}
        onNext={vi.fn()}
        onRetry={retry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the server');
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry when the server did answer: the code itself was the problem', () => {
    render(
      <RejectionPanel
        error={new ApiError(422, 'QR_EXPIRED', 'This QR code has expired.')}
        onNext={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Scan another employee/ })).toBeInTheDocument();
  });

  it.each([
    ['EMPLOYEE_INACTIVE', 'Employee account is inactive'],
    ['QR_SUPERSEDED', 'A newer QR code exists'],
    ['ALREADY_CHECKED_OUT', 'Already checked out'],
    ['SELF_SCAN_FORBIDDEN', 'You cannot scan your own code'],
  ])('names the problem for %s', (code, title) => {
    render(<RejectionPanel error={new ApiError(422, code, 'Because.')} onNext={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(title);
  });
});

describe('RecentScans', () => {
  const row = (over: Partial<ScanLogDto>): ScanLogDto => ({
    id: Math.random().toString(),
    scannedAt: '2026-11-02T04:30:00.000Z',
    status: 'RECORDED',
    qrResult: 'VALID',
    detectedAction: 'CHECK_IN',
    reasonCode: null,
    employee: { id: 'e', employeeCode: 'E-1001', fullName: 'Priya Sharma' },
    scannedBy: { id: 'o', employeeCode: 'O-1', fullName: 'Omar', role: 'attendance_operator' },
    confirmedAt: '2026-11-02T04:30:20.000Z',
    confirmedAction: 'CHECK_IN',
    officeVerification: null,
    attendanceEventId: '1',
    scanner: {},
    clientIp: null,
    ...over,
  });

  it('lists what became of each scan', () => {
    const now = Date.parse('2026-11-02T04:35:00.000Z');
    render(
      <RecentScans
        loading={false}
        now={now}
        items={[
          row({}),
          row({
            status: 'REJECTED',
            qrResult: 'EXPIRED',
            reasonCode: 'QR_EXPIRED',
            confirmedAction: null,
          }),
          row({
            status: 'REJECTED',
            qrResult: 'USED',
            reasonCode: 'QR_ALREADY_USED',
            confirmedAction: null,
          }),
          row({
            status: 'REJECTED',
            qrResult: 'UNKNOWN',
            reasonCode: 'EMPLOYEE_QR_INVALID',
            confirmedAction: null,
            employee: null,
          }),
        ]}
      />,
    );
    expect(screen.getByText('Checked in')).toBeInTheDocument();
    expect(screen.getByText('Expired code')).toBeInTheDocument();
    expect(screen.getByText('Duplicate scan')).toBeInTheDocument();
    expect(screen.getByText('Code not recognised')).toBeInTheDocument();
    expect(screen.getByText('Unknown code')).toBeInTheDocument();
    expect(screen.getAllByText(/5 min ago/).length).toBeGreaterThan(0);
    // who was scanned: initials when there is no photo, and the employee ID
    expect(screen.getAllByText('PS').length).toBe(3);
    expect(screen.getAllByText('E-1001').length).toBe(3);
  });

  it('shows a person’s photo when they have one', () => {
    render(
      <RecentScans
        loading={false}
        items={[
          row({
            employee: {
              id: 'e',
              employeeCode: 'E-1001',
              fullName: 'Priya Sharma',
              avatarUrl: 'https://example.test/priya.jpg',
            },
          }),
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: 'Photo of Priya Sharma' })).toHaveAttribute(
      'src',
      'https://example.test/priya.jpg',
    );
  });

  it('shows an empty state and a loading state', () => {
    const { rerender } = render(<RecentScans loading={false} items={[]} />);
    expect(screen.getByText('No scans yet')).toBeInTheDocument();
    rerender(<RecentScans loading items={undefined} />);
    expect(screen.queryByText('No scans yet')).toBeNull();
  });
});
