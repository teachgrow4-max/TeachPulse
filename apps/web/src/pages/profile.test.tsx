import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '../lib/api';
import { json, mockFetch, person, renderApp, session as sessionBody } from '../test/utils';
import { ProfilePage } from './profile';

beforeEach(() => {
  session.set('test-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the profile page', () => {
  it('shows the person and a way to their attendance QR', async () => {
    mockFetch({ 'POST /api/auth/refresh': json(200, sessionBody(person())) });
    renderApp(<ProfilePage />, { auth: true });
    expect(await screen.findByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument();
    expect(screen.getAllByText('E-1001').length).toBeGreaterThan(0);
    expect(screen.getByText('Academics')).toBeInTheDocument();
    expect(screen.getByText('Maths Teacher')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Attendance QR/ })).toHaveAttribute(
      'href',
      '/attendance-qr',
    );
  });

  it('shows no static QR code and offers no ID-card download', async () => {
    mockFetch({ 'POST /api/auth/refresh': json(200, sessionBody(person())) });
    renderApp(<ProfilePage />, { auth: true });
    await screen.findByRole('heading', { name: 'Priya Sharma' });
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  });

  it('does not offer attendance to an account that does not mark it', async () => {
    mockFetch({
      'POST /api/auth/refresh': json(
        200,
        sessionBody(person({ role: 'attendance_operator', attendanceRequired: false })),
      ),
    });
    renderApp(<ProfilePage />, { auth: true });
    await screen.findByRole('heading', { name: 'Priya Sharma' });
    expect(screen.queryByRole('link', { name: /Open Attendance QR/ })).toBeNull();
  });
});
