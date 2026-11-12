import { describe, expect, it } from 'vitest';
import { homeFor, landingFor } from './routes';

describe('where somebody lands after signing in', () => {
  it('has a home for every kind of account', () => {
    expect(homeFor('admin')).toBe('/scanner');
    expect(homeFor('attendance_operator')).toBe('/scanner');
    expect(homeFor('employee')).toBe('/profile');
    expect(homeFor('office_display')).toBe('/unsupported');
  });

  it('goes back to the page they were after, when they may open it', () => {
    expect(landingFor('admin', '/admin/qr?tab=history')).toBe('/admin/qr?tab=history');
    expect(landingFor('attendance_operator', '/scanner')).toBe('/scanner');
    expect(landingFor('employee', '/profile')).toBe('/profile');
  });

  it('does not send the next person to a page that was meant for the last one', () => {
    expect(landingFor('employee', '/scanner')).toBe('/profile');
    expect(landingFor('employee', '/admin/qr')).toBe('/profile');
    expect(landingFor('attendance_operator', '/admin/qr')).toBe('/scanner');
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
    expect(landingFor('employee', from)).toBe('/profile');
  });

  it('ignores nothing being asked for', () => {
    expect(landingFor('admin', undefined)).toBe('/scanner');
    expect(landingFor('admin', null)).toBe('/scanner');
  });
});
