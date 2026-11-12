import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  type ApiErrorBody,
  type SessionResponse,
} from '@teachgrow/shared';

/**
 * The only place the app talks to the API.
 *
 * Authentication follows docs/AUTH.md:
 *   - the access token lives in memory and nowhere else (never localStorage);
 *   - the refresh token is an HttpOnly cookie the page cannot read, so every request is sent with
 *     `credentials: "include"`;
 *   - login, refresh and logout carry the CSRF header;
 *   - a 401 triggers exactly one refresh (shared by concurrent requests) and one retry.
 */

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The request never reached the server, or the answer never came back. */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

let accessToken: string | null = null;
let sessionLostListener: (() => void) | null = null;

export const session = {
  set(token: string | null): void {
    accessToken = token;
  },
  has(): boolean {
    return accessToken !== null;
  },
  /** Called when a request is refused for lack of a valid session and it cannot be renewed. */
  onLost(listener: (() => void) | null): void {
    sessionLostListener = listener;
  },
};

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Send the access token (default) or not (login, refresh). */
  auth?: boolean;
  /** Add the CSRF header (login, refresh, logout). */
  csrf?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.csrf) headers.set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  if (options.auth !== false && accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  try {
    return await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the server. Check the connection and try again.',
    );
  }
}

async function toError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | undefined;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    /* an error page, not our JSON */
  }
  const error = body?.error;
  return new ApiError(
    res.status,
    error?.code ?? 'UNKNOWN',
    error?.message ?? `The request failed (${res.status}).`,
    error?.details,
    error?.requestId,
  );
}

let refreshing: Promise<SessionResponse | null> | null = null;

/** Trades the refresh cookie for a new access token. null = there is no session to renew. */
export function refreshSession(): Promise<SessionResponse | null> {
  refreshing ??= (async () => {
    try {
      const res = await send('/api/auth/refresh', {
        method: 'POST',
        body: {},
        auth: false,
        csrf: true,
      });
      if (res.status === 401) {
        accessToken = null;
        return null;
      }
      if (!res.ok) throw await toError(res);
      const data = (await res.json()) as SessionResponse;
      accessToken = data.accessToken;
      return data;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(path, options);
  if (res.status === 401 && options.auth !== false) {
    const renewed = await refreshSession();
    if (renewed) {
      res = await send(path, options);
    } else {
      sessionLostListener?.();
    }
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Turns anything thrown into something a person can read. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
