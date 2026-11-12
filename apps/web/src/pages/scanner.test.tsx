import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmScanResponse, ScanResolution } from '@teachgrow/shared';
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

const CODE = `TGE1.${'A'.repeat(43)}`;
const LOBBY = 'TG1.12345.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const SCAN_ID = '33333333-3333-4333-8333-333333333333';

const resolution = (over: Partial<ScanResolution> = {}): ScanResolution => ({
  scanId: SCAN_ID,
  scannedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
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

const confirmation = (action: 'CHECK_IN' | 'CHECK_OUT' = 'CHECK_IN'): ConfirmScanResponse => ({
  scanId: SCAN_ID,
  action,
  recordedAt: new Date().toISOString(),
  source: 'ADMIN_QR',
  employee: {
    id: '11111111-1111-4111-8111-111111111111',
    employeeCode: 'E-1001',
    fullName: 'Priya Sharma',
  },
  attendance: {
    workDate: '2026-11-02',
    status: 'PRESENT',
    isLate: false,
    liveState: action === 'CHECK_IN' ? 'WORKING' : 'CHECKED_OUT',
    checkInAt: new Date().toISOString(),
    checkOutAt: null,
    netWorkSeconds: null,
  },
});

const verified = {
  result: 'VERIFIED',
  verificationId: 'v1',
  expiresAt: new Date().toISOString(),
  layers: {},
  gps: {},
};
const failure = (code: string, message: string, details?: unknown, status = 422) =>
  json(status, { error: { code, message, details } });

function allowLocation(latitude = 10, longitude = 20) {
  const getCurrentPosition = vi.fn((ok: PositionCallback) =>
    ok({
      coords: { latitude, longitude, accuracy: 9 },
      timestamp: Date.now(),
    } as GeolocationPosition),
  );
  vi.stubGlobal('navigator', {
    ...navigator,
    geolocation: { getCurrentPosition },
    userAgent: 'TestBrowser Windows',
  });
  return getCurrentPosition;
}

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

const recentRoute = { 'GET /api/qr-attendance/recent': json(200, { items: [] }) };

describe('the scanner page', () => {
  it('shows the employee and what will happen, and records nothing yet', async () => {
    const { called } = mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': json(200, resolution()),
    });
    renderApp(<ScannerPage />);

    await show();
    expect(await screen.findByLabelText('Employee Priya Sharma')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CHECK IN' })).toBeEnabled();
    expect(screen.getByText('Maths Teacher')).toBeInTheDocument();

    // the code was sent, along with a description of the scanner, and that is all
    const [request] = called('POST /api/qr-attendance/scan');
    expect(request?.body).toMatchObject({
      payload: CODE,
      scanner: { kind: expect.stringMatching(/WEB|MOBILE/) },
    });
    expect(called('POST /api/qr-attendance/scans/' + SCAN_ID + '/confirm')).toHaveLength(0);
    // the camera is switched off while somebody is reviewing a person
    expect(camera.enabled.at(-1)).toBe(false);
  });

  it('checks the operator’s own location, then records, only when the big button is pressed', async () => {
    const user = userEvent.setup();
    const position = allowLocation();
    const { called } = mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': json(200, resolution()),
      [`POST /api/qr-attendance/scans/${SCAN_ID}/verify`]: json(200, verified),
      [`POST /api/qr-attendance/scans/${SCAN_ID}/confirm`]: json(200, confirmation()),
    });
    renderApp(<ScannerPage />);

    await show();
    await user.click(await screen.findByRole('button', { name: 'CHECK IN' }));

    expect(await screen.findByRole('status', { name: '' })).toBeDefined();
    await screen.findByText('Checked in');
    expect(position).toHaveBeenCalledTimes(1);

    const [verify] = called(`POST /api/qr-attendance/scans/${SCAN_ID}/verify`);
    expect(verify?.body).toMatchObject({
      gps: { latitude: 10, longitude: 20, accuracyM: 9 },
      channel: expect.stringMatching(/WEB|MOBILE/),
    });
    const [confirm] = called(`POST /api/qr-attendance/scans/${SCAN_ID}/confirm`);
    expect(confirm?.body).toEqual({ action: 'CHECK_IN' });
    expect(confirm?.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    // order: scan, then verify, then confirm
    expect(called('POST /api/qr-attendance/scan')).toHaveLength(1);
  });

  it('goes back to the camera for the next employee', async () => {
    const user = userEvent.setup();
    allowLocation();
    mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': json(200, resolution()),
      [`POST /api/qr-attendance/scans/${SCAN_ID}/verify`]: json(200, verified),
      [`POST /api/qr-attendance/scans/${SCAN_ID}/confirm`]: json(200, confirmation()),
    });
    renderApp(<ScannerPage />);
    await show();
    await user.click(await screen.findByRole('button', { name: 'CHECK IN' }));
    await user.click(await screen.findByRole('button', { name: /Scan another employee/ }));

    expect(screen.queryByText('Checked in')).toBeNull();
    expect(camera.enabled.at(-1)).toBe(true);
    expect(screen.getByText(/Hold the QR code inside the frame/)).toBeInTheDocument();
  });

  it('offers CHECK OUT to somebody who is already in', async () => {
    const user = userEvent.setup();
    allowLocation();
    const { called } = mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': json(
        200,
        resolution({
          action: 'CHECK_OUT',
          today: {
            workDate: '2026-11-02',
            status: 'PRESENT',
            liveState: 'WORKING',
            checkInAt: new Date().toISOString(),
            checkOutAt: null,
            isLate: false,
          },
        }),
      ),
      [`POST /api/qr-attendance/scans/${SCAN_ID}/verify`]: json(200, verified),
      [`POST /api/qr-attendance/scans/${SCAN_ID}/confirm`]: json(200, confirmation('CHECK_OUT')),
    });
    renderApp(<ScannerPage />);
    await show();
    await user.click(await screen.findByRole('button', { name: 'CHECK OUT' }));
    await screen.findByText('Checked out');
    expect(called(`POST /api/qr-attendance/scans/${SCAN_ID}/confirm`)[0]?.body).toEqual({
      action: 'CHECK_OUT',
    });
  });

  it('has nothing to confirm for somebody who has already checked out', async () => {
    mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': json(
        200,
        resolution({
          action: 'ALREADY_CHECKED_OUT',
          reason: {
            code: 'ALREADY_CHECKED_OUT',
            message: 'This employee has already checked out today.',
          },
          today: {
            workDate: '2026-11-02',
            status: 'PRESENT',
            liveState: 'CHECKED_OUT',
            checkInAt: new Date().toISOString(),
            checkOutAt: new Date().toISOString(),
            isLate: false,
          },
        }),
      ),
    });
    renderApp(<ScannerPage />);
    await show();
    expect(await screen.findByText('ALREADY CHECKED OUT')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^CHECK (IN|OUT)$/ })).toBeNull();
  });

  it('says why a code was refused, and offers the next scan', async () => {
    const user = userEvent.setup();
    mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': failure(
        'EMPLOYEE_QR_REVOKED',
        'This QR code has been revoked.',
        {
          scanId: SCAN_ID,
          employee: { employeeCode: 'E-1001', fullName: 'Priya Sharma' },
        },
      ),
    });
    renderApp(<ScannerPage />);
    await show();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This QR code was revoked');
    expect(alert).toHaveTextContent('Priya Sharma');
    await user.click(within(alert).getByRole('button', { name: /Scan another employee/ }));
    expect(camera.enabled.at(-1)).toBe(true);
  });

  it('explains that nobody can record their own attendance with the scanner', async () => {
    mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': failure(
        'SELF_SCAN_FORBIDDEN',
        'You cannot record your own attendance with the scanner. Ask another operator or an administrator to scan your code.',
        { scanId: SCAN_ID },
        403,
      ),
    });
    renderApp(<ScannerPage />);
    await show();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You cannot scan your own code');
    expect(alert).toHaveTextContent('Ask another operator or an administrator');
  });

  it('does not read a second code while the first is being looked up', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { called } = mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': async () => {
        await gate;
        return json(200, resolution());
      },
    });
    renderApp(<ScannerPage />);
    await show();
    await act(async () => {
      camera.show(CODE);
      camera.show(`TGE1.${'B'.repeat(43)}`);
    });
    release();
    await screen.findByLabelText('Employee Priya Sharma');
    expect(called('POST /api/qr-attendance/scan')).toHaveLength(1);
  });

  describe('when the office check fails', () => {
    it('lists each reason with what to do, records nothing, and lets the operator try again', async () => {
      const user = userEvent.setup();
      allowLocation(10.01, 20);
      const { called } = mockFetch({
        ...recentRoute,
        'POST /api/qr-attendance/scan': json(200, resolution()),
        [`POST /api/qr-attendance/scans/${SCAN_ID}/verify`]: failure(
          'VERIFICATION_FAILED',
          'You are about 1,100 m from the office.',
          {
            reasons: [
              {
                code: 'GPS_OUTSIDE_RADIUS',
                layer: 'GPS',
                message: 'You are about 1,100 m from the office; you must be within 100 m.',
                hint: 'Go to the office and try again.',
              },
            ],
          },
        ),
      });
      renderApp(<ScannerPage />);
      await show();
      await user.click(await screen.findByRole('button', { name: 'CHECK IN' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('You do not appear to be at the office');
      expect(alert).toHaveTextContent('you must be within 100 m');
      expect(alert).toHaveTextContent('Go to the office and try again.');
      expect(called(`POST /api/qr-attendance/scans/${SCAN_ID}/confirm`)).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'CHECK IN' })).toBeEnabled();
    });

    it('explains when the browser will not share a location', async () => {
      const user = userEvent.setup();
      vi.stubGlobal('navigator', {
        ...navigator,
        geolocation: {
          getCurrentPosition: (_ok: PositionCallback, fail: PositionErrorCallback) =>
            fail({ code: 1 } as GeolocationPositionError),
        },
      });
      const { called } = mockFetch({
        ...recentRoute,
        'POST /api/qr-attendance/scan': json(200, resolution()),
      });
      renderApp(<ScannerPage />);
      await show();
      await user.click(await screen.findByRole('button', { name: 'CHECK IN' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/location is blocked/i);
      expect(called(`POST /api/qr-attendance/scans/${SCAN_ID}/verify`)).toHaveLength(0);
    });
  });

  it('after a lost connection, pressing again repeats only the recording, with the same key', async () => {
    const user = userEvent.setup();
    const position = allowLocation();
    const { called } = mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': json(200, resolution()),
      [`POST /api/qr-attendance/scans/${SCAN_ID}/verify`]: json(200, verified),
      [`POST /api/qr-attendance/scans/${SCAN_ID}/confirm`]: [
        // the first answer never arrives
        () => {
          throw new TypeError('Failed to fetch');
        },
        json(200, confirmation()),
      ],
    });
    renderApp(<ScannerPage />);
    await show();
    await user.click(await screen.findByRole('button', { name: 'CHECK IN' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Connection lost/);
    expect(screen.getByRole('alert')).toHaveTextContent(/will not record it twice/);

    await user.click(screen.getByRole('button', { name: 'CHECK IN' }));
    await screen.findByText('Checked in');

    const confirms = called(`POST /api/qr-attendance/scans/${SCAN_ID}/confirm`);
    expect(confirms).toHaveLength(2);
    expect(confirms[0]?.headers.get('idempotency-key')).toBe(
      confirms[1]?.headers.get('idempotency-key'),
    );
    // the office check and the location were not asked for a second time
    expect(called(`POST /api/qr-attendance/scans/${SCAN_ID}/verify`)).toHaveLength(1);
    expect(position).toHaveBeenCalledTimes(1);
  });

  it('stops offering the button when somebody else got there first', async () => {
    const user = userEvent.setup();
    allowLocation();
    mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': json(200, resolution()),
      [`POST /api/qr-attendance/scans/${SCAN_ID}/verify`]: json(200, verified),
      [`POST /api/qr-attendance/scans/${SCAN_ID}/confirm`]: failure(
        'ALREADY_CHECKED_IN',
        'You have already checked in today.',
        undefined,
        409,
      ),
    });
    renderApp(<ScannerPage />);
    await show();
    await user.click(await screen.findByRole('button', { name: 'CHECK IN' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already checked in/i);
    expect(screen.getByRole('button', { name: 'CHECK IN' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Scan again' })).toBeInTheDocument();
  });

  it('cannot be confirmed once the scan has run out of time', async () => {
    mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': json(
        200,
        resolution({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      ),
    });
    renderApp(<ScannerPage />);
    await show();
    const button = await screen.findByRole('button', { name: 'CHECK IN' });
    expect(button).toBeDisabled();
    expect(screen.getByText(/has expired/)).toBeInTheDocument();
  });

  describe('when the office also asks for its lobby code', () => {
    it('asks the operator to scan it, and sends it with the office check', async () => {
      const user = userEvent.setup();
      allowLocation();
      const { called } = mockFetch({
        ...recentRoute,
        'POST /api/qr-attendance/scan': json(
          200,
          resolution({ requiredLayers: ['GPS', 'NETWORK', 'QR'] }),
        ),
        [`POST /api/qr-attendance/scans/${SCAN_ID}/verify`]: json(200, verified),
        [`POST /api/qr-attendance/scans/${SCAN_ID}/confirm`]: json(200, confirmation()),
      });
      renderApp(<ScannerPage />);
      await show();
      await user.click(await screen.findByRole('button', { name: 'CHECK IN' }));

      expect(await screen.findByText('Scan the code on the office screen')).toBeInTheDocument();
      expect(called(`POST /api/qr-attendance/scans/${SCAN_ID}/verify`)).toHaveLength(0);

      // another employee's code is not the office code and is ignored
      await act(async () => {
        camera.show(`TGE1.${'C'.repeat(43)}`);
      });
      expect(called(`POST /api/qr-attendance/scans/${SCAN_ID}/verify`)).toHaveLength(0);

      await act(async () => {
        camera.show(LOBBY);
      });
      await screen.findByText('Checked in');
      expect(called(`POST /api/qr-attendance/scans/${SCAN_ID}/verify`)[0]?.body).toMatchObject({
        qr: { payload: LOBBY },
      });
    });
  });

  it('says so when this device cannot satisfy a registered-device requirement', async () => {
    mockFetch({
      ...recentRoute,
      'POST /api/qr-attendance/scan': json(
        200,
        resolution({ requiredLayers: ['GPS', 'NETWORK', 'DEVICE'] }),
      ),
    });
    renderApp(<ScannerPage />);
    await show();
    expect(await screen.findByText(/registered device/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CHECK IN' })).toBeDisabled();
  });

  it('lists the operator’s recent scans', async () => {
    mockFetch({
      'GET /api/qr-attendance/recent': json(200, {
        items: [
          {
            id: 'a',
            scannedAt: new Date().toISOString(),
            status: 'RECORDED',
            qrResult: 'VALID',
            detectedAction: 'CHECK_IN',
            reasonCode: null,
            employee: { id: 'e', employeeCode: 'E-1002', fullName: 'Rahul Verma' },
            scannedBy: {
              id: 'o',
              employeeCode: 'O-1',
              fullName: 'Omar',
              role: 'attendance_operator',
            },
            confirmedAt: new Date().toISOString(),
            confirmedAction: 'CHECK_IN',
            officeVerification: 'VERIFIED',
            attendanceEventId: '1',
            scanner: {},
            clientIp: null,
          },
        ],
      }),
    });
    renderApp(<ScannerPage />);
    expect(await screen.findByText('Rahul Verma')).toBeInTheDocument();
    expect(screen.getByText('Checked in')).toBeInTheDocument();
  });
});
