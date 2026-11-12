import type { RoleName } from '@teachgrow/shared';

/** Where each kind of account lands after signing in. */
export function homeFor(role: RoleName): string {
  switch (role) {
    case 'admin':
      return '/admin/attendance';
    case 'attendance_operator':
      return '/scanner';
    case 'employee':
      return '/attendance-qr';
    default:
      return '/unsupported';
  }
}

/** Which accounts may open which pages (the pages themselves enforce it too; the API always does). */
const ACCESS: Array<{ path: string; roles: readonly RoleName[] }> = [
  { path: '/scanner', roles: ['admin', 'attendance_operator'] },
  { path: '/admin/attendance', roles: ['admin'] },
  { path: '/attendance-qr', roles: ['employee', 'admin'] },
  { path: '/admin/employees', roles: ['admin'] },
  { path: '/profile', roles: ['employee', 'admin', 'attendance_operator'] },
  { path: '/change-password', roles: ['employee', 'admin', 'attendance_operator'] },
];

/**
 * Where to send somebody who has just signed in. Back to the page they were trying to open, but
 * only if THEY may open it: after one person signs out and another signs in, the second must not
 * land on a page that was meant for the first. Anything that is not a known page of this app
 * (an address on another site, for instance) is ignored.
 */
export function landingFor(role: RoleName, from?: string | null): string {
  if (from && from.startsWith('/') && !from.startsWith('//')) {
    const path = from.split(/[?#]/)[0] ?? '';
    const rule = ACCESS.find((entry) => path === entry.path || path.startsWith(`${entry.path}/`));
    if (rule?.roles.includes(role)) return from;
  }
  return homeFor(role);
}
