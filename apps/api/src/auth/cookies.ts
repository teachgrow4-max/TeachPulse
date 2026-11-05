import { parseCookie } from 'cookie';
import type { CookieOptions, Request, Response } from 'express';

/**
 * The web app's refresh token lives only in an HttpOnly cookie, so page JavaScript (and therefore
 * any XSS) can never read it. The short-lived access token is kept in memory by the SPA.
 *
 * The cookie is scoped to /api/auth: the browser sends it to the sign-in, refresh and sign-out
 * endpoints and to nothing else.
 */

export const REFRESH_COOKIE_NAME = 'tg_refresh';
export const REFRESH_COOKIE_PATH = '/api/auth';

export interface CookieSettings {
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  maxAgeSeconds: number;
}

const baseOptions = (settings: Pick<CookieSettings, 'secure' | 'sameSite'>): CookieOptions => ({
  httpOnly: true,
  secure: settings.secure,
  sameSite: settings.sameSite,
  path: REFRESH_COOKIE_PATH,
});

export function setRefreshCookie(res: Response, token: string, settings: CookieSettings): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...baseOptions(settings),
    maxAge: settings.maxAgeSeconds * 1000,
  });
}

export function clearRefreshCookie(
  res: Response,
  settings: Pick<CookieSettings, 'secure' | 'sameSite'>,
): void {
  res.clearCookie(REFRESH_COOKIE_NAME, baseOptions(settings));
}

export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const value = parseCookie(header)[REFRESH_COOKIE_NAME];
  return value && value.length <= 2048 ? value : undefined;
}
