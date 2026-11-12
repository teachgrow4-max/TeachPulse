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
    'GET /api/employee-qr/me': json(200, {
      status: 'ACTIVE',
      payload: `TGE1.${'A'.repeat(43)}`,
      generatedAt: null,
      revokedAt: null,
      holder: {
        employeeCode: user.employeeCode,
        fullName: user.fullName,
        department: null,
        designation: null,
        avatarUrl: null,
      },
    }),
    'GET /api/qr-attendance/recent': json(200, { items: [] }),
    'GET /api/admin/employee-qr': json(200, { items: [], page: 1, pageSize: 25, total: 0 }),
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

  it('shows an employee their profile after they sign in', async () => {
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
      'GET /api/employee-qr/me': json(200, {
        status: 'ACTIVE',
        payload: `TGE1.${'A'.repeat(43)}`,
        generatedAt: null,
        revokedAt: null,
        holder: {
          employeeCode: 'E-1001',
          fullName: 'Priya Sharma',
          department: null,
          designation: null,
          avatarUrl: null,
        },
      }),
    });
    renderApp(<App />, { auth: true });
    await user.type(await screen.findByLabelText('Email'), 'priya@demo.test');
    await user.type(screen.getByLabelText('Password'), 'Demo-Passw0rd!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /QR code for/ })).toBeInTheDocument();
  });

  it('does not send the next person to a page that was meant for the last one', async () => {
    const user = userEvent.setup();
    mockFetch({
      'POST /api/auth/refresh': json(401, { error: { code: 'UNAUTHENTICATED', message: '' } }),
      'POST /api/auth/login': json(200, sessionBody(employee)),
      'GET /api/employee-qr/me': json(200, {
        status: 'ACTIVE',
        payload: `TGE1.${'A'.repeat(43)}`,
        generatedAt: null,
        revokedAt: null,
        holder: {
          employeeCode: 'E-1001',
          fullName: 'Priya Sharma',
          department: null,
          designation: null,
          avatarUrl: null,
        },
      }),
    });
    // an operator's page was open when the session ended, so the sign-in page remembers it
    renderApp(<App />, { auth: true, route: '/scanner' });
    await user.type(await screen.findByLabelText('Email'), 'priya@demo.test');
    await user.type(screen.getByLabelText('Password'), 'Demo-Passw0rd!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    // an employee lands on their profile, not on the operator's scanner they cannot open
    expect(await screen.findByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument();
  });
});

describe('who sees what', () => {
  it('lets an employee see their profile but not the scanner', async () => {
    signedInAs(employee);
    renderApp(<App />, { auth: true, route: '/scanner' });
    expect(await screen.findByText('You do not have access to this page')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'QR attendance' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'QR management' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'My profile' }).length).toBeGreaterThan(0);
  });

  it('keeps an employee out of QR management too', async () => {
    signedInAs(employee);
    renderApp(<App />, { auth: true, route: '/admin/qr' });
    expect(await screen.findByText('You do not have access to this page')).toBeInTheDocument();
  });

  it('opens an attendance operator on the scanner, with no QR management', async () => {
    signedInAs(operator);
    renderApp(<App />, { auth: true, route: '/' });
    expect(await screen.findByRole('heading', { name: 'QR attendance' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'QR attendance' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'QR management' })).toBeNull();
  });

  it('keeps an operator out of QR management', async () => {
    signedInAs(operator);
    renderApp(<App />, { auth: true, route: '/admin/qr' });
    expect(await screen.findByText('You do not have access to this page')).toBeInTheDocument();
  });

  it('gives an administrator the scanner and QR management', async () => {
    signedInAs(admin);
    renderApp(<App />, { auth: true, route: '/admin/qr' });
    expect(await screen.findByRole('heading', { name: 'QR management' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'QR attendance' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'QR management' }).length).toBeGreaterThan(0);
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
