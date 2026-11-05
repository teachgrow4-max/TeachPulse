import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';

/**
 * Local verification of Supabase access tokens.
 *
 * Two kinds of signing key exist, and they are kept strictly apart:
 *   - HS256 with the project's shared secret (legacy projects and the local CLI stack)
 *   - asymmetric keys (ES256 / RS256 / EdDSA) published at the project's JWKS endpoint
 *
 * The key family is chosen from the token's `alg` header, but each family only accepts its own
 * algorithms and its own key material. A token claiming HS256 can therefore never be checked
 * against a public key (the classic "algorithm confusion" attack), `alg: none` is refused, and
 * the public anon / service_role API keys (also JWTs) are refused because they lack
 * `aud: authenticated`, `sub` and `session_id`.
 */

export type TokenFailure =
  | 'malformed'
  | 'alg_not_allowed'
  | 'invalid_signature'
  | 'expired'
  | 'invalid_claims'
  /** The JWKS endpoint could not be reached: an infrastructure problem, not a bad token. */
  | 'key_unavailable';

export class TokenError extends Error {
  constructor(
    readonly reason: TokenFailure,
    options?: { cause?: unknown },
  ) {
    super(`token rejected: ${reason}`, options);
    this.name = 'TokenError';
  }
}

export interface VerifiedToken {
  userId: string;
  sessionId: string;
  email: string | null;
  issuedAt: number | null;
  /** Unix seconds. */
  expiresAt: number;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export interface TokenVerifierOptions {
  /** Expected `iss`, e.g. `https://<project>.supabase.co/auth/v1`. */
  issuer: string;
  audience?: string;
  /** Legacy shared secret. Enables HS256 verification. */
  hs256Secret?: string;
  /** JWKS endpoint. Enables asymmetric verification. */
  jwksUrl?: string;
  /** Injectable clock (defaults to the system clock). */
  now?: () => Date;
  clockToleranceSeconds?: number;
}

const ASYMMETRIC_ALGORITHMS = ['ES256', 'RS256', 'EdDSA'] as const;
const MAX_TOKEN_LENGTH = 8192;

const claimsSchema = z.object({
  sub: z.uuid(),
  session_id: z.uuid(),
  role: z.literal('authenticated'),
  email: z.string().optional(),
  exp: z.number(),
  iat: z.number().optional(),
});

function classify(error: unknown): TokenError {
  if (error instanceof TokenError) return error;
  if (error instanceof joseErrors.JWTExpired) return new TokenError('expired', { cause: error });
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return new TokenError('invalid_claims', { cause: error });
  }
  if (error instanceof joseErrors.JOSEAlgNotAllowed) {
    return new TokenError('alg_not_allowed', { cause: error });
  }
  if (
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JWKSMultipleMatchingKeys
  ) {
    return new TokenError('invalid_signature', { cause: error });
  }
  if (error instanceof joseErrors.JWSInvalid || error instanceof joseErrors.JWTInvalid) {
    return new TokenError('malformed', { cause: error });
  }
  // JWKS timeouts, network failures, a malformed key set: not the caller's fault.
  return new TokenError('key_unavailable', { cause: error });
}

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const audience = options.audience ?? 'authenticated';
  const now = options.now ?? (() => new Date());
  const clockTolerance = options.clockToleranceSeconds ?? 5;

  const secret = options.hs256Secret ? new TextEncoder().encode(options.hs256Secret) : undefined;
  const jwks: JWTVerifyGetKey | undefined = options.jwksUrl
    ? createRemoteJWKSet(new URL(options.jwksUrl), {
        timeoutDuration: 5_000,
        // Unknown `kid` values trigger at most one refetch per cooldown: a stream of forged
        // tokens cannot be turned into a stream of requests to the auth server.
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      })
    : undefined;

  const common = {
    issuer: options.issuer,
    audience,
    clockTolerance,
    requiredClaims: ['exp', 'sub'],
  };

  return {
    async verify(token) {
      if (
        typeof token !== 'string' ||
        token.length === 0 ||
        token.length > MAX_TOKEN_LENGTH ||
        token.split('.').length !== 3
      ) {
        throw new TokenError('malformed');
      }

      let alg: string | undefined;
      try {
        alg = decodeProtectedHeader(token).alg;
      } catch (cause) {
        throw new TokenError('malformed', { cause });
      }

      let payload: JWTPayload;
      try {
        const currentDate = now();
        if (alg === 'HS256') {
          if (!secret) throw new TokenError('alg_not_allowed');
          ({ payload } = await jwtVerify(token, secret, {
            ...common,
            algorithms: ['HS256'],
            currentDate,
          }));
        } else if (
          alg !== undefined &&
          (ASYMMETRIC_ALGORITHMS as readonly string[]).includes(alg)
        ) {
          if (!jwks) throw new TokenError('alg_not_allowed');
          ({ payload } = await jwtVerify(token, jwks, {
            ...common,
            algorithms: [...ASYMMETRIC_ALGORITHMS],
            currentDate,
          }));
        } else {
          throw new TokenError('alg_not_allowed');
        }
      } catch (error) {
        throw classify(error);
      }

      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) throw new TokenError('invalid_claims', { cause: claims.error });

      return {
        userId: claims.data.sub,
        sessionId: claims.data.session_id,
        email: claims.data.email ?? null,
        issuedAt: claims.data.iat ?? null,
        expiresAt: claims.data.exp,
      };
    },
  };
}
