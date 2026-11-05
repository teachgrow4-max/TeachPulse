import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '@teachgrow/shared';
import type { Request } from 'express';
import { AppError } from '../lib/errors.js';

/**
 * CSRF defence for the only requests that rely on an ambient credential: the ones that read or
 * set the refresh cookie (web sign-in, refresh and sign-out). Every other endpoint authenticates
 * with an `Authorization: Bearer` header, which a cross-site page cannot attach.
 *
 * Two independent checks must both pass:
 *   1. `Origin` is present and is exactly one of the configured web origins. Browsers always send
 *      Origin on cross-origin POSTs and attackers cannot forge it.
 *   2. A custom header is present. A cross-site form or `fetch` cannot add one without a CORS
 *      preflight, and the CORS policy only approves the configured origins.
 *
 * `SameSite` on the cookie is a third layer, not the only one: deployments where the web app and
 * API are on different sites must use `SameSite=None`, which provides no CSRF protection by itself.
 */
export function assertTrustedBrowserRequest(req: Request, allowedOrigins: readonly string[]): void {
  const origin = req.get('origin');
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new AppError('CSRF_REJECTED');
  }
  if (req.get(CSRF_HEADER_NAME) !== CSRF_HEADER_VALUE) {
    throw new AppError('CSRF_REJECTED');
  }
}
