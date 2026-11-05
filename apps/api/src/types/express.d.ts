import type { AuthContext } from '../auth/context.js';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request. Also returned in the X-Request-Id header. */
      requestId: string;
      /** Set by `authenticate` once the bearer token and session have been verified. */
      auth?: AuthContext;
    }
  }
}

export {};
