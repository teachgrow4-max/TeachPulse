interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
  /** Postgres puts the human explanation of many errors here, not in the message. */
  detail?: string;
}

export interface ConstraintFailure {
  /** SQLSTATE, e.g. 23505 (unique violation), 23503 (foreign key), 23514 (check). */
  code?: string;
  /** The constraint or index that was violated, when the driver reports it. */
  name?: string;
  message: string;
}

/** Pulls the SQLSTATE and constraint name out of a driver error, whichever driver raised it. */
export function constraintOf(error: unknown): ConstraintFailure {
  const e = (error ?? {}) as PgErrorLike;
  const quoted = /"([^"]+)"/.exec(e.message ?? '')?.[1];
  return {
    code: e.code,
    name: e.constraint ?? quoted,
    message: [e.message, e.detail].filter(Boolean).join(' '),
  };
}
