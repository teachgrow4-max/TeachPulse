import {
  GoTrueAdminApi,
  GoTrueClient,
  isAuthApiError,
  isAuthRetryableFetchError,
  isAuthWeakPasswordError,
  type Session,
} from '@supabase/auth-js';
import { z } from 'zod';

/**
 * The only place that talks to Supabase Auth (GoTrue). Everything else depends on this
 * interface, so business logic is testable without a live auth server and the provider could be
 * swapped without touching it.
 *
 *   - user-facing grants (password, refresh) use the public anon key
 *   - account administration uses the service-role key, which exists ONLY in the API process
 */

export type GatewayErrorKind =
  | 'invalid_credentials'
  | 'user_banned'
  | 'refresh_token_invalid'
  | 'email_exists'
  | 'weak_password'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown';

export class AuthGatewayError extends Error {
  /** Why a password was rejected, when the provider says (e.g. `['length']`). */
  readonly reasons?: string[];
  /** The provider's own error code, e.g. `refresh_token_already_used`. */
  readonly code?: string;

  constructor(
    readonly kind: GatewayErrorKind,
    message: string,
    options?: { cause?: unknown; reasons?: string[]; code?: string },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'AuthGatewayError';
    this.reasons = options?.reasons;
    this.code = options?.code;
  }
}

export interface GatewaySession {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Unix seconds. */
  expiresAt: number;
  userId: string;
}

export interface AuthGateway {
  signInWithPassword(email: string, password: string): Promise<GatewaySession>;
  refreshSession(refreshToken: string): Promise<GatewaySession>;
  createUser(input: { email: string; password: string; fullName: string }): Promise<{ id: string }>;
  updatePassword(userId: string, password: string): Promise<void>;
  /** Banned users cannot sign in or refresh at the provider, whatever our own tables say. */
  setBanned(userId: string, banned: boolean): Promise<void>;
  deleteUser(userId: string): Promise<void>;
}

export interface SupabaseGatewayOptions {
  /** Project URL, e.g. `https://abc.supabase.co`. `/auth/v1` is appended. */
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  timeoutMs?: number;
}

/** ~100 years. GoTrue has no "ban forever"; this is the conventional equivalent. */
const BAN_FOREVER = '876000h';

const REFRESH_INVALID_CODES = new Set([
  'refresh_token_not_found',
  'refresh_token_already_used',
  'session_not_found',
  'session_expired',
  'bad_jwt',
]);

/** Turns a provider failure (HTTP status + error code) into one of our own error kinds. */
function classifyProviderFailure(
  status: number,
  code: string,
  message: string,
  cause?: unknown,
): AuthGatewayError {
  const detail = { cause, code: code || undefined };
  if (code === 'invalid_credentials')
    return new AuthGatewayError('invalid_credentials', message, detail);
  if (code === 'user_banned') return new AuthGatewayError('user_banned', message, detail);
  if (code === 'email_exists' || code === 'user_already_exists') {
    return new AuthGatewayError('email_exists', message, detail);
  }
  if (code === 'weak_password') return new AuthGatewayError('weak_password', message, detail);
  if (REFRESH_INVALID_CODES.has(code)) {
    return new AuthGatewayError('refresh_token_invalid', message, detail);
  }
  if (status === 429 || code.startsWith('over_') || code.endsWith('_rate_limit')) {
    return new AuthGatewayError('rate_limited', message, detail);
  }
  if (status >= 500) return new AuthGatewayError('unavailable', message, detail);
  return new AuthGatewayError('unknown', message, detail);
}

export function mapGatewayError(error: unknown): AuthGatewayError {
  if (error instanceof AuthGatewayError) return error;

  if (isAuthWeakPasswordError(error)) {
    return new AuthGatewayError('weak_password', error.message, {
      cause: error,
      reasons: error.reasons,
    });
  }
  if (isAuthApiError(error)) {
    return classifyProviderFailure(error.status, error.code ?? '', error.message, error);
  }
  if (isAuthRetryableFetchError(error)) {
    return new AuthGatewayError('unavailable', 'auth provider unreachable', { cause: error });
  }
  return new AuthGatewayError('unknown', error instanceof Error ? error.message : 'unknown error', {
    cause: error,
  });
}

/** GoTrue's success body for a token grant: only the fields we rely on. */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number(),
  expires_at: z.number().optional(),
  user: z.object({ id: z.string().min(1) }),
});

/** GoTrue reports errors as `{ error_code, msg }`, or in the older OAuth style `{ error, error_description }`. */
function failureFromBody(status: number, body: unknown): AuthGatewayError {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  let code = str(record.error_code) || str(record.error);
  // The OAuth-style rejection of a refresh token.
  if (code === 'invalid_grant') code = 'refresh_token_not_found';
  const message =
    str(record.msg) || str(record.error_description) || str(record.message) || `HTTP ${status}`;
  return classifyProviderFailure(status, code, message);
}

function toGatewaySession(session: Session): GatewaySession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in,
    expiresAt: session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in,
    userId: session.user.id,
  };
}

export class SupabaseAuthGateway implements AuthGateway {
  private readonly authUrl: string;
  private readonly fetchWithTimeout: typeof fetch;
  private readonly admin: GoTrueAdminApi;

  constructor(private readonly options: SupabaseGatewayOptions) {
    this.authUrl = `${options.url.replace(/\/+$/, '')}/auth/v1`;
    const timeoutMs = options.timeoutMs ?? 8_000;
    // A hung auth server must not hang our requests (and tie up database connections).
    this.fetchWithTimeout = (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });

    this.admin = new GoTrueAdminApi({
      url: this.authUrl,
      headers: {
        Authorization: `Bearer ${options.serviceRoleKey}`,
        apikey: options.serviceRoleKey,
      },
      fetch: this.fetchWithTimeout,
    });
  }

  /**
   * A fresh, stateless client per call: auth-js keeps the "current session" inside the client
   * instance, which must never be shared between different people's requests.
   */
  private userClient(): GoTrueClient {
    return new GoTrueClient({
      url: this.authUrl,
      headers: { apikey: this.options.anonKey },
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
      fetch: this.fetchWithTimeout,
    });
  }

  async signInWithPassword(email: string, password: string): Promise<GatewaySession> {
    const { data, error } = await this.userClient().signInWithPassword({ email, password });
    if (error) throw mapGatewayError(error);
    if (!data.session) throw new AuthGatewayError('unknown', 'sign-in returned no session');
    return toGatewaySession(data.session);
  }

  /**
   * A direct, single-attempt call to the refresh-token grant. auth-js's own `refreshSession`
   * retries failures with exponential backoff for up to ~30 seconds, which would leave a user's
   * request hanging during a provider outage; an API call must fail fast and predictably instead.
   */
  async refreshSession(refreshToken: string): Promise<GatewaySession> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetchWithTimeout(`${this.authUrl}/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: this.options.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      text = await response.text();
    } catch (cause) {
      throw new AuthGatewayError('unavailable', 'auth provider unreachable', { cause });
    }

    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON (e.g. a proxy error page): handled below by status.
    }
    if (!response.ok) throw failureFromBody(response.status, body);

    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AuthGatewayError(
        'unknown',
        'the auth provider returned an unexpected token response',
      );
    }
    const { access_token, refresh_token, expires_in, expires_at, user } = parsed.data;
    return {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: expires_in,
      expiresAt: expires_at ?? Math.floor(Date.now() / 1000) + expires_in,
      userId: user.id,
    };
  }

  async createUser(input: {
    email: string;
    password: string;
    fullName: string;
  }): Promise<{ id: string }> {
    const { data, error } = await this.admin.createUser({
      email: input.email,
      password: input.password,
      // Accounts are created by an administrator, so there is no confirmation email to click.
      email_confirm: true,
      user_metadata: { full_name: input.fullName },
    });
    if (error) throw mapGatewayError(error);
    if (!data.user) throw new AuthGatewayError('unknown', 'createUser returned no user');
    return { id: data.user.id };
  }

  async updatePassword(userId: string, password: string): Promise<void> {
    const { error } = await this.admin.updateUserById(userId, { password });
    if (error) throw mapGatewayError(error);
  }

  async setBanned(userId: string, banned: boolean): Promise<void> {
    const { error } = await this.admin.updateUserById(userId, {
      ban_duration: banned ? BAN_FOREVER : 'none',
    });
    if (error) throw mapGatewayError(error);
  }

  async deleteUser(userId: string): Promise<void> {
    const { error } = await this.admin.deleteUser(userId);
    if (error) throw mapGatewayError(error);
  }
}
