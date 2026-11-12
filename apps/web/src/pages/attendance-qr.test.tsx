import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyQrToday } from '@teachgrow/shared';
import { session } from '../lib/api';
import { json, mockFetch, renderApp } from '../test/utils';
import { AttendanceQrPage } from './attendance-qr';

const CODE = `TGD1.${'A'.repeat(43)}`;
const VERIFICATION = '44444444-4444-4444-8444-444444444444';
const QR_ID = '55555555-5555-4555-8555-555555555555';

const today = (over: Partial<DailyQrToday> = {}): DailyQrToday => ({
  workDate: '2026-11-02',
  next: 'CHECK_IN',
  blockedReason: null,
  verificationRequired: true,
  live: null,
  generatedToday: 0,
  maxPerDay: 5,
  ttlSeconds: 90,
  attendance: { status: null, liveState: 'NONE', checkInAt: null, checkOutAt: null, isLate: false },
  ...over,
});

const verified = (over: Record<string, unknown> = {}) =>
  json(200, {
    result: 'VERIFIED',
    verificationId: VERIFICATION,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    layers: { GPS: 'PASS', NETWORK: 'PASS', QR: 'NOT_REQUIRED', DEVICE: 'NOT_REQUIRED' },
    gps: { distanceMeters: 42, accuracyMeters: 9 },
    action: 'CHECK_IN',
    ...over,
  });

const issued = (over: Record<string, unknown> = {}) =>
  json(201, {
    id: QR_ID,
    payload: CODE,
    action: 'CHECK_IN',
    workDate: '2026-11-02',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    generatedToday: 1,
    maxPerDay: 5,
    ...over,
  });

const active = json(200, {
  id: QR_ID,
  status: 'ACTIVE',
  action: 'CHECK_IN',
  expiresAt: new Date(Date.now() + 90_000).toISOString(),
  usedAt: null,
});

function allowLocation() {
  const getCurrentPosition = vi.fn((ok: PositionCallback) =>
    ok({
      coords: { latitude: 10, longitude: 20, accuracy: 9 },
      timestamp: Date.now(),
    } as GeolocationPosition),
  );
  vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } });
  return getCurrentPosition;
}

beforeEach(() => {
  session.set('test-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the employee’s Attendance QR page', () => {
  it('checks the location and Wi-Fi, then generates a code and shows it with a countdown', async () => {
    const user = userEvent.setup();
    allowLocation();
    const net = mockFetch({
      'GET /api/attendance-qr/today': json(200, today()),
      'POST /api/attendance-qr/verify': verified(),
      'POST /api/attendance-qr/generate': issued(),
      [`GET /api/attendance-qr/${QR_ID}`]: active,
    });
    renderApp(<AttendanceQrPage />);

    // nothing can be generated before the office check passes
    const generate = await screen.findByRole('button', { name: /Generate Attendance QR/ });
    expect(generate).toBeDisabled();
    expect(screen.getByText('Location')).toBeInTheDocument();
    expect(screen.getByText('Office Wi-Fi')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check my location and Wi-Fi' }));
    expect(await screen.findByText('42 m from the office')).toBeInTheDocument();
    expect(net.called('POST /api/attendance-qr/verify')[0]!.body).toMatchObject({
      gps: { latitude: 10, longitude: 20, accuracyM: 9 },
    });
    await waitFor(() => expect(generate).toBeEnabled());

    await user.click(generate);
    const image = await screen.findByRole('img', { name: 'Attendance QR code for check-in' });
    expect(image.tagName.toLowerCase()).toBe('svg');
    expect(net.called('POST /api/attendance-qr/generate')[0]!.body).toEqual({
      verificationId: VERIFICATION,
    });
    expect(screen.getByText('Check-in code')).toBeInTheDocument();
    expect(screen.getByText(/Expires in/)).toHaveTextContent(/1:[0-3]\d/);
    expect(await screen.findByText('Waiting for an administrator to scan…')).toBeInTheDocument();
    // the proof was spent: another code needs another check
    expect(generate).toBeDisabled();
  });

  it('says exactly which requirement failed', async () => {
    const user = userEvent.setup();
    allowLocation();
    mockFetch({
      'GET /api/attendance-qr/today': json(200, today()),
      'POST /api/attendance-qr/verify': json(422, {
        error: {
          code: 'VERIFICATION_FAILED',
          message: 'You are too far from the office.',
          details: {
            result: 'REJECTED',
            verificationId: VERIFICATION,
            layers: { GPS: 'FAIL', NETWORK: 'PASS', QR: 'NOT_REQUIRED', DEVICE: 'NOT_REQUIRED' },
            reasons: [
              {
                code: 'GPS_OUTSIDE',
                layer: 'GPS',
                message: 'You are 380 m from the office.',
                hint: 'Move closer to the office and try again.',
              },
            ],
            gps: { distanceMeters: 380, accuracyMeters: 9 },
          },
        },
      }),
    });
    renderApp(<AttendanceQrPage />);
    await user.click(await screen.findByRole('button', { name: 'Check my location and Wi-Fi' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You are not verified at the office');
    expect(alert).toHaveTextContent('You are 380 m from the office.');
    expect(alert).toHaveTextContent('Move closer to the office');
    // location failed, Wi-Fi passed: each is reported on its own
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Failed');
    expect(rows[1]).toHaveTextContent('OK');
    expect(screen.getByRole('button', { name: /Generate Attendance QR/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('explains a blocked location permission without calling the server', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('navigator', {
      ...navigator,
      geolocation: {
        getCurrentPosition: (_ok: PositionCallback, fail: PositionErrorCallback) =>
          fail({ code: 1, message: 'denied' } as GeolocationPositionError),
      },
    });
    const net = mockFetch({ 'GET /api/attendance-qr/today': json(200, today()) });
    renderApp(<AttendanceQrPage />);
    await user.click(await screen.findByRole('button', { name: 'Check my location and Wi-Fi' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your location is needed');
    expect(net.called('POST /api/attendance-qr/verify')).toHaveLength(0);
  });

  it('shows the attendance confirmation when an administrator has scanned the code', async () => {
    const user = userEvent.setup();
    allowLocation();
    mockFetch({
      'GET /api/attendance-qr/today': json(200, today()),
      'POST /api/attendance-qr/verify': verified(),
      'POST /api/attendance-qr/generate': issued(),
      [`GET /api/attendance-qr/${QR_ID}`]: json(200, {
        id: QR_ID,
        status: 'USED',
        action: 'CHECK_IN',
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
        usedAt: new Date().toISOString(),
      }),
    });
    renderApp(<AttendanceQrPage />);
    await user.click(await screen.findByRole('button', { name: 'Check my location and Wi-Fi' }));
    await user.click(await screen.findByRole('button', { name: /Generate Attendance QR/ }));
    expect(await screen.findByText('Checked in')).toBeInTheDocument();
    expect(screen.getByText('Scanned')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for an administrator to scan…')).toBeNull();
  });

  it('marks a code as expired when its time runs out', async () => {
    const user = userEvent.setup();
    allowLocation();
    mockFetch({
      'GET /api/attendance-qr/today': json(200, today()),
      'POST /api/attendance-qr/verify': verified(),
      'POST /api/attendance-qr/generate': issued({
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
      }),
      [`GET /api/attendance-qr/${QR_ID}`]: active,
    });
    renderApp(<AttendanceQrPage />);
    await user.click(await screen.findByRole('button', { name: 'Check my location and Wi-Fi' }));
    await user.click(await screen.findByRole('button', { name: /Generate Attendance QR/ }));
    expect(
      (await screen.findAllByText('Expired', undefined, { timeout: 4000 })).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Verify again to make a new code/)).toBeInTheDocument();
  });

  it('offers a check-out code after checking in', async () => {
    mockFetch({
      'GET /api/attendance-qr/today': json(
        200,
        today({
          next: 'CHECK_OUT',
          attendance: {
            status: 'PRESENT',
            liveState: 'WORKING',
            checkInAt: '2026-11-02T04:30:00.000Z',
            checkOutAt: null,
            isLate: false,
          },
        }),
      ),
    });
    renderApp(<AttendanceQrPage />);
    expect(await screen.findByText(/Generate your check-out QR/)).toBeInTheDocument();
  });

  it('does not ask an administrator for a location or Wi-Fi', async () => {
    const user = userEvent.setup();
    const getCurrentPosition = allowLocation();
    const net = mockFetch({
      'GET /api/attendance-qr/today': json(200, today({ verificationRequired: false })),
      'POST /api/attendance-qr/generate': issued(),
      [`GET /api/attendance-qr/${QR_ID}`]: active,
    });
    renderApp(<AttendanceQrPage />);
    const generate = await screen.findByRole('button', { name: /Generate Attendance QR/ });
    expect(screen.getByText(/not asked for their location or Wi-Fi/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check my location and Wi-Fi' })).toBeNull();
    expect(generate).toBeEnabled();
    await user.click(generate);
    await screen.findByRole('img', { name: /Attendance QR code/ });
    expect(net.called('POST /api/attendance-qr/generate')[0]!.body).toEqual({});
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('says so when there is nothing to record today', async () => {
    mockFetch({
      'GET /api/attendance-qr/today': json(
        200,
        today({
          next: 'BLOCKED',
          blockedReason: {
            code: 'HOLIDAY',
            message: 'Today is a holiday, so attendance cannot be marked.',
          },
        }),
      ),
    });
    renderApp(<AttendanceQrPage />);
    expect(await screen.findByText('No attendance to record today')).toBeInTheDocument();
    expect(screen.getByText(/Today is a holiday/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate Attendance QR/ })).toBeNull();
  });

  it('says so when the day is complete', async () => {
    mockFetch({
      'GET /api/attendance-qr/today': json(
        200,
        today({
          next: 'ALREADY_CHECKED_OUT',
          attendance: {
            status: 'PRESENT',
            liveState: 'CHECKED_OUT',
            checkInAt: '2026-11-02T04:30:00.000Z',
            checkOutAt: '2026-11-02T12:30:00.000Z',
            isLate: false,
          },
        }),
      ),
    });
    renderApp(<AttendanceQrPage />);
    expect(await screen.findByText('Your attendance for today is complete')).toBeInTheDocument();
  });

  it('stops offering new codes once the daily limit is reached', async () => {
    mockFetch({
      'GET /api/attendance-qr/today': json(200, today({ generatedToday: 5, maxPerDay: 5 })),
    });
    renderApp(<AttendanceQrPage />);
    expect(await screen.findByText(/Codes made today: 5 of 5/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate Attendance QR/ })).toBeDisabled();
  });

  it('offers a retry when the page cannot load', async () => {
    const user = userEvent.setup();
    mockFetch({
      'GET /api/attendance-qr/today': [
        json(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'Try later.' } }),
        json(200, today()),
      ],
    });
    renderApp(<AttendanceQrPage />);
    expect(await screen.findByText('Attendance QR is not available')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('button', { name: /Generate Attendance QR/ }),
    ).toBeInTheDocument();
  });
});
