import { describe, expect, it } from 'vitest';
import { homeFor, landingFor } from './routes';

describe('where somebody lands after signing in', () => {
  it('has a home for every kind of account', () => {
    expect(homeFor('admin')).toBe('/admin/attendance');
    expect(homeFor('attendance_operator')).toBe('/scanner');
    expect(homeFor('employee')).toBe('/attendance-qr');
    expect(homeFor('office_display')).toBe('/unsupported');
  });

  it('goes back to the page they were after, when they may open it', () => {
    expect(landingFor('admin', '/admin/attendance?tab=history')).toBe(
      '/admin/attendance?tab=history',
    );
    expect(landingFor('attendance_operator', '/scanner')).toBe('/scanner');
    expect(landingFor('employee', '/profile')).toBe('/profile');
    expect(landingFor('admin', '/admin/qr')).toBe('/admin/qr');
    expect(landingFor('admin', '/admin/scan-history?employee=x')).toBe(
      '/admin/scan-history?employee=x',
    );
  });

  it('does not send the next person to a page that was meant for the last one', () => {
    expect(landingFor('employee', '/scanner')).toBe('/attendance-qr');
    expect(landingFor('employee', '/admin/attendance')).toBe('/attendance-qr');
    expect(landingFor('employee', '/admin/qr')).toBe('/attendance-qr');
    expect(landingFor('attendance_operator', '/admin/scan-history')).toBe('/scanner');
    expect(landingFor('attendance_operator', '/admin/attendance')).toBe('/scanner');
    expect(landingFor('office_display', '/profile')).toBe('/unsupported');
  });

  it.each([
    'https://evil.example/profile',
    '//evil.example/profile',
    'javascript:alert(1)',
    '/somewhere-unknown',
    '',
    '/scannerx',
  ])('ignores %j', (from) => {
    expect(landingFor('employee', from)).toBe('/attendance-qr');
  });

  it('ignores nothing being asked for', () => {
    expect(landingFor('admin', undefined)).toBe('/admin/attendance');
    expect(landingFor('admin', null)).toBe('/admin/attendance');
  });
});
