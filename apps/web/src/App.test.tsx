import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUserDto } from '@teachgrow/shared';
import { App } from './App';
import { session } from './lib/api';
import { json, mockFetch, person, renderApp, session as sessionBody } from './test/utils';

// The camera is not what these tests are about.
vi.mock('./components/scanner/use-camera-scanner', () => ({
  useCameraScanner: () => ({
    videoRef: { current: null },
    status: 'scanning',
    message: null,
    cameras: [],
    cameraId: '',
    chooseCamera: vi.fn(),
    torch: { available: false, on: false },
    toggleTorch: vi.fn(),
    retry: vi.fn(),
  }),
  decodePhoto: vi.fn(),
  classifyCameraError: vi.fn(),
}));

beforeEach(() => {
  session.set(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const signedInAs = (
  user: AuthUserDto,
  extra: Record<string, Parameters<typeof mockFetch>[0][string]> = {},
) =>
  mockFetch({
    'POST /api/auth/refresh': json(200, sessionBody(user)),
    'GET /api/attendance-qr/today': json(200, {
      workDate: '2026-11-02',
      next: 'CHECK_IN',
      blockedReason: null,
      verificationRequired: true,
      live: null,
      generatedToday: 0,
      maxPerDay: 5,
      ttlSeconds: 90,
      attendance: {
        status: null,
        liveState: 'NONE',
        checkInAt: null,
        checkOutAt: null,
        isLate: false,
      },
    }),
    'GET /api/admin/attendance/daily': json(200, {
      date: '2026-11-02',
      isToday: true,
      summary: { total: 0, present: 0, late: 0, absent: 0, onLeave: 0 },
      warnings: { duplicateScans: 0, invalidOrExpiredScans: 0 },
      rows: [],
    }),
    'GET /api/qr-attendance/recent': json(200, { items: [] }),
    'GET /api/admin/departments': json(200, { items: [] }),
    ...extra,
  });

const admin = person({
  id: 'a',
  role: 'admin',
  fullName: 'Asha Admin',
  employeeCode: 'A-001',
  attendanceRequired: false,
});
const operator = person({
  id: 'o',
  role: 'attendance_operator',
  fullName: 'Omar Operator',
  employeeCode: 'O-001',
  attendanceRequired: false,
});
const employee = person();

describe('signing in', () => {
  it('sends somebody with no session to the sign-in page', async () => {
    mockFetch({
      'POST /api/auth/refresh': json(401, { error: { code: 'UNAUTHENTICATED', message: '' } }),
    });
    renderApp(<App />, { auth: true, route: '/scanner' });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('opens an employee on their Attendance QR after they sign in', async () => {
    const user = userEvent.setup();
    mockFetch({
      'POST /api/auth/refresh': json(401, { error: { code: 'UNAUTHENTICATED', message: '' } }),
      'POST /api/auth/login': (request) => {
        expect(request.headers.get('x-requested-with')).toBe('teachgrow-web');
        expect(request.body).toEqual({
          email: 'priya@demo.test',
          password: 'Demo-Passw0rd!',
          client: 'web',
        });
        return json(200, sessionBody(employee));
      },
      'GET /api/attendance-qr/today': json(200, {
        workDate: '2026-11-02',
        next: 'CHECK_IN',
        blockedReason: null,
        verificationRequired: true,
        live: null,
        generatedToday: 0,
        maxPerDay: 5,
        ttlSeconds: 90,
        attendance: {
          status: null,
          liveState: 'NONE',
          checkInAt: null,
          checkOutAt: null,
          isLate: false,
        },
      }),
    });
    renderApp(<App />, { auth: true });
    await user.type(await screen.findByLabelText('Email'), 'priya@demo.test');
    await user.type(screen.getByLabelText('Password'), 'Demo-Passw0rd!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Attendance QR' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate Attendance QR/ })).toBeDisabled();
  });

  it('does not send the next person to a page that was meant for the last one', async () => {
    const user = userEvent.setup();
    mockFetch({
      'POST /api/auth/refresh': json(401, { error: { code: 'UNAUTHENTICATED', message: '' } }),
      'POST /api/auth/login': json(200, sessionBody(employee)),
      'GET /api/attendance-qr/today': json(200, {
        workDate: '2026-11-02',
        next: 'CHECK_IN',
        blockedReason: null,
        verificationRequired: true,
        live: null,
        generatedToday: 0,
        maxPerDay: 5,
        ttlSeconds: 90,
        attendance: {
          status: null,
          liveState: 'NONE',
          checkInAt: null,
          checkOutAt: null,
          isLate: false,
        },
      }),
    });
    // an operator's page was open when the session ended, so the sign-in page remembers it
    renderApp(<App />, { auth: true, route: '/scanner' });
    await user.type(await screen.findByLabelText('Email'), 'priya@demo.test');
    await user.type(screen.getByLabelText('Password'), 'Demo-Passw0rd!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    // an employee lands on their own page, not on the operator's scanner they cannot open
    expect(await screen.findByRole('heading', { name: 'Attendance QR' })).toBeInTheDocument();
    expect(screen.queryByText('You do not have access to this page')).toBeNull();
  });

  it('explains a wrong password and clears it', async () => {
    const user = userEvent.setup();
    mockFetch({
      'POST /api/auth/refresh': json(401, { error: { code: 'UNAUTHENTICATED', message: '' } }),
      'POST /api/auth/login': json(401, {
        error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password.' },
      }),
    });
    renderApp(<App />, { auth: true });
    await user.type(await screen.findByLabelText('Email'), 'priya@demo.test');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email or password is not right.',
    );
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('tells somebody who is locked out to wait', async () => {
    const user = userEvent.setup();
    mockFetch({
      'POST /api/auth/refresh': json(401, { error: { code: 'UNAUTHENTICATED', message: '' } }),
      'POST /api/auth/login': json(429, {
        error: { code: 'ACCOUNT_LOCKED', message: 'Too many.' },
      }),
    });
    renderApp(<App />, { auth: true });
    await user.type(await screen.findByLabelText('Email'), 'a@b.test');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/wait a few minutes/i);
  });

  it('makes somebody on a temporary password choose their own first', async () => {
    const user = userEvent.setup();
    const { called } = signedInAs(person({ mustChangePassword: true }), {
      'POST /api/auth/change-password': json(204),
      'GET /api/auth/me': json(200, { user: person() }),
    });
    renderApp(<App />, { auth: true, route: '/profile' });
    expect(await screen.findByText('Choose a new password')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Current password'), 'Temp-Passw0rd-1');
    await user.type(screen.getByLabelText('New password'), 'weak');
    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save new password' })).toBeDisabled();
    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'Brand-New-Passw0rd');
    await user.type(screen.getByLabelText('New password again'), 'Brand-New-Passw0rd');
    await user.click(screen.getByRole('button', { name: 'Save new password' }));

    await waitFor(() => expect(called('POST /api/auth/change-password')).toHaveLength(1));
    expect(called('POST /api/auth/change-password')[0]?.body).toEqual({
      currentPassword: 'Temp-Passw0rd-1',
      newPassword: 'Brand-New-Passw0rd',
    });
    expect(await screen.findByRole('heading', { name: 'Attendance QR' })).toBeInTheDocument();
  });
});

describe('who sees what', () => {
  it('lets an employee see their Attendance QR and profile but not the scanner', async () => {
    signedInAs(employee);
    renderApp(<App />, { auth: true, route: '/scanner' });
    expect(await screen.findByText('You do not have access to this page')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Scan QR' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Attendance' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Attendance QR' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'My profile' }).length).toBeGreaterThan(0);
  });

  it('keeps an employee out of the attendance dashboard', async () => {
    signedInAs(employee);
    renderApp(<App />, { auth: true, route: '/admin/attendance' });
    expect(await screen.findByText('You do not have access to this page')).toBeInTheDocument();
  });

  it('opens an attendance operator on the scanner, with no dashboard', async () => {
    signedInAs(operator);
    renderApp(<App />, { auth: true, route: '/' });
    expect(await screen.findByRole('heading', { name: 'Scan employee QR' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Scan QR' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Attendance' })).toBeNull();
  });

  it('keeps an operator out of the attendance dashboard', async () => {
    signedInAs(operator);
    renderApp(<App />, { auth: true, route: '/admin/attendance' });
    expect(await screen.findByText('You do not have access to this page')).toBeInTheDocument();
  });

  it('opens an administrator on the attendance dashboard, with the scanner one click away', async () => {
    signedInAs(admin);
    renderApp(<App />, { auth: true, route: '/' });
    expect(
      await screen.findByRole('heading', { name: 'Attendance management' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Scan Employee QR/ })).toHaveAttribute(
      'href',
      '/scanner',
    );
    expect(screen.getAllByRole('link', { name: 'Scan QR' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Attendance' }).length).toBeGreaterThan(0);
  });

  it('tells the lobby screen account that this app is not for it', async () => {
    signedInAs(
      person({ role: 'office_display', fullName: 'Lobby Screen', attendanceRequired: false }),
    );
    renderApp(<App />, { auth: true, route: '/' });
    expect(await screen.findByText('This account is for the lobby screen')).toBeInTheDocument();
  });

  it('signs out', async () => {
    const user = userEvent.setup();
    const { called } = signedInAs(employee, { 'POST /api/auth/logout': json(204) });
    renderApp(<App />, { auth: true, route: '/profile' });
    await user.click((await screen.findAllByRole('button', { name: /Sign out/ }))[0]!);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(called('POST /api/auth/logout')).toHaveLength(1);
    expect(called('POST /api/auth/logout')[0]?.headers.get('x-requested-with')).toBe(
      'teachgrow-web',
    );
  });
});
