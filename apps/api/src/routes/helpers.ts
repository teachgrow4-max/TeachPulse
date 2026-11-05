import type { Request } from 'express';
import type { Identity } from '../auth/identity.js';
import type { Actor } from '../employees/service.js';
import { AppError } from '../lib/errors.js';

/** The signed-in person as an audit/authorization actor. Call only after `authenticate`. */
export const actorOf = (req: Request): Actor => ({
  id: req.auth!.userId,
  role: req.auth!.identity.role,
});

/**
 * Devices, QR scans and verifications only exist for people who mark attendance. An administrator
 * (or the lobby screen) whose account is not tracked has nothing to register or verify.
 * Call only after `authenticate`.
 */
export function identityMarkingAttendance(req: Request): Identity {
  const { identity } = req.auth!;
  if (!identity.attendanceRequired) {
    throw new AppError('FORBIDDEN', 'This account does not mark attendance.');
  }
  return identity;
}
