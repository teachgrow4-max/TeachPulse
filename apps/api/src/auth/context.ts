import type { Identity } from './identity.js';

/** What `authenticate` attaches to `req.auth` for a verified, still-valid session. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  /** Loaded from the database for this request; never read from the token. */
  identity: Identity;
  /** Unix seconds. */
  tokenExpiresAt: number;
}
