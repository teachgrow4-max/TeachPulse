import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanRecorded } from '@teachgrow/shared';
import { session } from '../lib/api';
import { json, mockFetch, renderApp } from '../test/utils';
import { ScannerPage } from './scanner';

// The real camera is replaced by a stand-in that lets a test "show a QR code to the camera".
const camera = vi.hoisted(() => ({
  show: (_text: string) => {},
  enabled: [] as boolean[],
}));
vi.mock('../components/scanner/use-camera-scanner', () => ({
  useCameraScanner: ({
    enabled,
    onDecode,
  }: {
    enabled: boolean;
    onDecode: (text: string) => void;
  }) => {
    camera.show = onDecode;
    camera.enabled.push(enabled);
    return {
      videoRef: { current: null },
      status: enabled ? 'scanning' : 'idle',
      message: null,
      cameras: [],
      cameraId: '',
      chooseCamera: vi.fn(),
      torch: { available: false, on: false },
      toggleTorch: vi.fn(),
      retry: vi.fn(),
    };
  },
  decodePhoto: vi.fn(),
  classifyCameraError: vi.fn(),
}));

const CODE = `TGD1.${'A'.repeat(43)}`;
const SCAN_ID = '33333333-3333-4333-8333-333333333333';

const recorded = (action: 'CHECK_IN' | 'CHECK_OUT' = 'CHECK_IN'): ScanRecorded => ({
  scanId: SCAN_ID,
  action,
  recordedAt: '2026-11-02T04:30:00.000Z',
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
    status: 'PRESENT',
    isLate: false,
    liveState: action === 'CHECK_IN' ? 'WORKING' : 'CHECKED_OUT',
    checkInAt: '2026-11-02T04:30:00.000Z',
    checkOutAt: null,
    netWorkSeconds: null,
  },
});

const failure = (code: string, message: string, details?: unknown, status = 422) =>
  json(status, { error: { code, message, details } });

const show = async (text = CODE) => {
  await waitFor(() => expect(camera.enabled.at(-1)).toBe(true));
  await act(async () => {
    camera.show(text);
  });
};

beforeEach(() => {
  session.set('test-token');
  camera.enabled.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the scanner page', () => {
  it('records the attendance as soon as a code is read, and shows who was recorded', async () => {
    const net = mockFetch({
      'GET /api/qr-attendance/recent': json(200, { items: [] }),
      'POST /api/qr-attendance/scan': json(200, recorded()),
    });
    renderApp(<ScannerPage />);
    await show();

    expect(await screen.findByText('Checked in')).toBeInTheDocument();
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Academics')).toBeInTheDocument();
    expect(screen.getByText('Present')).toBeInTheDocument();

    const sent = net.called('POST /api/qr-attendance/scan');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ payload: CODE, scanner: { kind: expect.any(String) } });
    // Nothing else is asked for: no confirm button, no verification, no location.
    expect(screen.queryByRole('button', { name: /CHECK IN|Confirm/ })).toBeNull();
    expect(net.calls.some((c) => c.path.includes('/verify') || c.path.includes('/confirm'))).toBe(
      false,
    );
    expect(JSON.stringify(sent[0]!.body)).not.toContain('gps');
  });

  it('never asks for the scanner’s location', async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } });
    mockFetch({
      'GET /api/qr-attendance/recent': json(200, { items: [] }),
      'POST /api/qr-attendance/scan': json(200, recorded()),
    });
    renderApp(<ScannerPage />);
    await show();
    await screen.findByText('Checked in');
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('says "Checked out" for a check-out code', async () => {
    mockFetch({
      'GET /api/qr-attendance/recent': json(200, { items: [] }),
      'POST /api/qr-attendance/scan': json(200, recorded('CHECK_OUT')),
    });
    renderApp(<ScannerPage />);
    await show();
    expect(await screen.findByText('Checked out')).toBeInTheDocument();
  });

  it('warns about a duplicate, and does not record twice', async () => {
    const net = mockFetch({
      'GET /api/qr-attendance/recent': json(200, { items: [] }),
      'POST /api/qr-attendance/scan': failure(
        'QR_ALREADY_USED',
        'This QR code has already been scanned.',
        {
          scanId: 's',
          employee: { employeeCode: 'E-1001', fullName: 'Priya Sharma' },
          firstRecordedAt: '2026-11-02T04:30:00.000Z',
        },
        409,
      ),
    });
    renderApp(<ScannerPage />);
    await show();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Already scanned');
    expect(alert).toHaveTextContent('Priya Sharma');
    expect(net.called('POST /api/qr-attendance/scan')).toHaveLength(1);
  });

  it.each([
    ['QR_EXPIRED', 'This QR code has expired.', 'This QR code has expired'],
    ['QR_SUPERSEDED', 'This QR code was replaced.', 'A newer QR code exists'],
    ['EMPLOYEE_QR_INVALID', 'This QR code is not recognised.', 'QR code not recognised'],
    ['EMPLOYEE_INACTIVE', 'This employee’s account is inactive.', 'Employee account is inactive'],
  ])('shows why %s was refused', async (code, message, title) => {
    mockFetch({
      'GET /api/qr-attendance/recent': json(200, { items: [] }),
      'POST /api/qr-attendance/scan': failure(code, message, { scanId: 's' }),
    });
    renderApp(<ScannerPage />);
    await show();
    expect(await screen.findByRole('alert')).toHaveTextContent(title);
  });

  it('goes back to the camera for the next employee', async () => {
    const user = userEvent.setup();
    mockFetch({
      'GET /api/qr-attendance/recent': json(200, { items: [] }),
      'POST /api/qr-attendance/scan': json(200, recorded()),
    });
    renderApp(<ScannerPage />);
    await show();
    await screen.findByText('Checked in');
    await user.click(screen.getByRole('button', { name: /Scan another employee/ }));
    await waitFor(() => expect(camera.enabled.at(-1)).toBe(true));
    expect(screen.queryByText('Checked in')).toBeNull();
  });

  it('records a code once even if the camera reads it twice in a row', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const net = mockFetch({
      'GET /api/qr-attendance/recent': json(200, { items: [] }),
      'POST /api/qr-attendance/scan': async () => {
        await gate;
        return json(200, recorded());
      },
    });
    renderApp(<ScannerPage />);
    await show();
    await act(async () => {
      camera.show(CODE);
      camera.show(CODE);
    });
    release();
    await screen.findByText('Checked in');
    expect(net.called('POST /api/qr-attendance/scan')).toHaveLength(1);
  });

  it('reports a lost connection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderApp(<ScannerPage />);
    await show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
  });
});
