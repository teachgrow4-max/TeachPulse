import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmScanResponse, ScanLogDto, ScanResolution } from '@teachgrow/shared';
import { ApiError } from '../../lib/api';
import {
  ActionPanel,
  EmployeeIdCard,
  RecentScans,
  RejectionPanel,
  SuccessPanel,
} from './scan-panels';

const scan = (over: Partial<ScanResolution> = {}): ScanResolution => ({
  scanId: '33333333-3333-4333-8333-333333333333',
  scannedAt: '2026-11-02T04:30:00.000Z',
  expiresAt: '2026-11-02T04:32:00.000Z',
  employee: {
    id: '11111111-1111-4111-8111-111111111111',
    employeeCode: 'E-1001',
    fullName: 'Priya Sharma',
    avatarUrl: null,
    department: 'Academics',
    designation: 'Maths Teacher',
    accountStatus: 'ACTIVE',
  },
  today: {
    workDate: '2026-11-02',
    status: null,
    liveState: 'NONE',
    checkInAt: null,
    checkOutAt: null,
    isLate: false,
  },
  action: 'CHECK_IN',
  reason: null,
  requiredLayers: ['GPS', 'NETWORK'],
  ...over,
});

const handlers = () => ({ onConfirm: vi.fn(), onCancel: vi.fn() });

describe('EmployeeIdCard', () => {
  it('shows the person, their ID, department, designation and account status', () => {
    render(<EmployeeIdCard scan={scan()} />);
    const card = screen.getByLabelText('Employee Priya Sharma');
    expect(within(card).getByText('Priya Sharma')).toBeInTheDocument();
    expect(within(card).getByText('E-1001')).toBeInTheDocument();
    expect(within(card).getByText('Academics')).toBeInTheDocument();
    expect(within(card).getByText('Maths Teacher')).toBeInTheDocument();
    expect(within(card).getByText('Account active')).toBeInTheDocument();
    expect(within(card).getByText('Not checked in')).toBeInTheDocument();
  });

  it('falls back to initials when there is no photo, and shows a photo when there is one', () => {
    const { rerender } = render(<EmployeeIdCard scan={scan()} />);
    expect(screen.getByText('PS')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();

    rerender(
      <EmployeeIdCard
        scan={scan({ employee: { ...scan().employee, avatarUrl: 'https://img.test/priya.png' } })}
      />,
    );
    expect(screen.getByRole('img', { name: 'Photo of Priya Sharma' })).toHaveAttribute(
      'src',
      'https://img.test/priya.png',
    );
  });

  it('shows what has already happened today', () => {
    render(
      <EmployeeIdCard
        scan={scan({
          action: 'CHECK_OUT',
          today: {
            workDate: '2026-11-02',
            status: 'LATE',
            liveState: 'WORKING',
            checkInAt: '2026-11-02T04:55:00.000Z',
            checkOutAt: null,
            isLate: true,
          },
        })}
      />,
    );
    expect(screen.getByText('Working · arrived late')).toBeInTheDocument();
  });
});

describe('ActionPanel', () => {
  it('offers CHECK IN, and nothing happens until it is pressed', async () => {
    const user = userEvent.setup();
    const h = handlers();
    render(
      <ActionPanel
        scan={scan()}
        secondsLeft={95}
        step="idle"
        failure={null}
        blockedNotice={null}
        {...h}
      />,
    );
    const button = screen.getByRole('button', { name: 'CHECK IN' });
    expect(h.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText('1:35')).toBeInTheDocument();
    expect(screen.getByText(/Confirm to record/)).toHaveTextContent('Priya Sharma');
    await user.click(button);
    expect(h.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('offers CHECK OUT for somebody who is in', () => {
    render(
      <ActionPanel
        scan={scan({ action: 'CHECK_OUT' })}
        secondsLeft={60}
        step="idle"
        failure={null}
        blockedNotice={null}
        {...handlers()}
      />,
    );
    expect(screen.getByRole('button', { name: 'CHECK OUT' })).toBeEnabled();
  });

  it('says ALREADY CHECKED OUT and offers no way to record', async () => {
    const user = userEvent.setup();
    const h = handlers();
    render(
      <ActionPanel
        scan={scan({
          action: 'ALREADY_CHECKED_OUT',
          reason: {
            code: 'ALREADY_CHECKED_OUT',
            message: 'This employee has already checked out today.',
          },
        })}
        secondsLeft={0}
        step="idle"
        failure={null}
        blockedNotice={null}
        {...h}
      />,
    );
    expect(screen.getByText('ALREADY CHECKED OUT')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /CHECK (IN|OUT)$/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Scan another employee/ }));
    expect(h.onCancel).toHaveBeenCalled();
  });

  it('explains a day that cannot take attendance', () => {
    render(
      <ActionPanel
        scan={scan({
          action: 'BLOCKED',
          reason: { code: 'HOLIDAY', message: 'Today is a company holiday.' },
        })}
        secondsLeft={0}
        step="idle"
        failure={null}
        blockedNotice={null}
        {...handlers()}
      />,
    );
    expect(screen.getByText('Today is a company holiday.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /CHECK (IN|OUT)$/ })).toBeNull();
  });

  it('cannot be pressed once the scan has expired', () => {
    render(
      <ActionPanel
        scan={scan()}
        secondsLeft={0}
        step="idle"
        failure={null}
        blockedNotice={null}
        {...handlers()}
      />,
    );
    expect(screen.getByRole('button', { name: 'CHECK IN' })).toBeDisabled();
    expect(screen.getByText(/has expired/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan again' })).toBeInTheDocument();
  });

  it.each([
    ['location', 'Finding your location…'],
    ['verifying', 'Checking you are at the office…'],
    ['recording', 'Recording attendance…'],
  ] as const)('tells the operator what is happening while it is %s', (step, text) => {
    render(
      <ActionPanel
        scan={scan()}
        secondsLeft={90}
        step={step}
        failure={null}
        blockedNotice={null}
        {...handlers()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: 'CHECK IN' })).toBeDisabled();
  });

  it('lists why the office check failed, with what to do about each', () => {
    render(
      <ActionPanel
        scan={scan()}
        secondsLeft={90}
        step="idle"
        failure={{
          title: 'You do not appear to be at the office',
          message: 'You are about 500 m from the office.',
          reasons: [
            {
              message: 'You are about 500 m from the office.',
              hint: 'Go to the office and try again.',
            },
          ],
          canRetry: true,
        }}
        blockedNotice={null}
        {...handlers()}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('You do not appear to be at the office');
    expect(alert).toHaveTextContent('Go to the office and try again.');
    expect(screen.getByRole('button', { name: 'CHECK IN' })).toBeEnabled();
  });

  it('stops offering the button when pressing it again cannot help', () => {
    render(
      <ActionPanel
        scan={scan()}
        secondsLeft={90}
        step="idle"
        failure={{
          title: 'Attendance was not recorded',
          message: 'Already checked in.',
          canRetry: false,
        }}
        blockedNotice={null}
        {...handlers()}
      />,
    );
    expect(screen.getByRole('button', { name: 'CHECK IN' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Scan again' })).toBeInTheDocument();
  });

  it('shows a notice that blocks recording on this device', () => {
    render(
      <ActionPanel
        scan={scan()}
        secondsLeft={90}
        step="idle"
        failure={null}
        blockedNotice="Needs a registered device."
        {...handlers()}
      />,
    );
    expect(screen.getByText('Needs a registered device.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CHECK IN' })).toBeDisabled();
  });
});

describe('SuccessPanel and RejectionPanel', () => {
  const result: ConfirmScanResponse = {
    scanId: '33333333-3333-4333-8333-333333333333',
    action: 'CHECK_IN',
    recordedAt: '2026-11-02T04:55:00.000Z',
    source: 'ADMIN_QR',
    employee: { id: 'x', employeeCode: 'E-1001', fullName: 'Priya Sharma' },
    attendance: {
      workDate: '2026-11-02',
      status: 'LATE',
      isLate: true,
      liveState: 'WORKING',
      checkInAt: '2026-11-02T04:55:00.000Z',
      checkOutAt: null,
      netWorkSeconds: null,
    },
  };

  it('celebrates a recording, names the person, and offers the next scan', async () => {
    const user = userEvent.setup();
    const next = vi.fn();
    render(<SuccessPanel result={result} onNext={next} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checked in');
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Arrived late')).toBeInTheDocument();
    expect(screen.getByText('Recorded by QR scan')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Scan another employee/ }));
    expect(next).toHaveBeenCalled();
  });

  it('says "Checked out" for a check-out, without the late badge', () => {
    render(<SuccessPanel result={{ ...result, action: 'CHECK_OUT' }} onNext={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checked out');
    expect(screen.queryByText('Arrived late')).toBeNull();
  });

  it('explains a refused code, naming whose it was when the server says so', () => {
    const error = new ApiError(422, 'EMPLOYEE_QR_REVOKED', 'This QR code has been revoked.', {
      scanId: 's',
      employee: { employeeCode: 'E-1001', fullName: 'Priya Sharma' },
    });
    render(<RejectionPanel error={error} onNext={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This QR code was revoked');
    expect(alert).toHaveTextContent('This QR code has been revoked.');
    expect(alert).toHaveTextContent('Priya Sharma');
  });

  it('describes a lost connection in its own words', () => {
    render(
      <RejectionPanel
        error={new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server.')}
        onNext={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the server');
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
    officeVerification: 'VERIFIED',
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
            qrResult: 'REVOKED',
            reasonCode: 'EMPLOYEE_QR_REVOKED',
            confirmedAction: null,
            employee: null,
          }),
          row({ status: 'EXPIRED', confirmedAction: null }),
        ]}
      />,
    );
    expect(screen.getByText('Checked in')).toBeInTheDocument();
    expect(screen.getByText('Revoked code')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('Unknown code')).toBeInTheDocument();
    expect(screen.getAllByText(/5 min ago/).length).toBeGreaterThan(0);
  });

  it('shows an empty state and a loading state', () => {
    const { rerender } = render(<RecentScans loading={false} items={[]} />);
    expect(screen.getByText('No scans yet')).toBeInTheDocument();
    rerender(<RecentScans loading items={undefined} />);
    expect(screen.queryByText('No scans yet')).toBeNull();
  });
});
