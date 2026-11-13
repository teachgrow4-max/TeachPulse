import type {
  QrOverview,
  QrOverviewQuery,
  QrOverviewRow,
  QrOverviewState,
  ScanAction,
} from '@teachgrow/shared';
import type { Db } from '../db/pool.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { loadPolicyAt, requireActiveOffice } from '../office/repository.js';

/**
 * The administrator's QR management view: for one day, where each tracked employee's attendance QR
 * stands (live, scanned, expired, or never made), and when their code was last scanned. Read-only.
 *
 * It never sees a code: only the table of hashes and its timestamps are read, and the hashes are not
 * even selected. Who may call it is decided by the router (administrators only).
 */

export interface QrOverviewDeps {
  db: Db;
  clock: Clock;
}

interface Row {
  id: string;
  employee_code: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  designation: string | null;
  department: string | null;
  state: QrOverviewState;
  generated: number;
  t_action: ScanAction | null;
  issued_at: Date | string | null;
  expires_at: Date | string | null;
  used_at: Date | string | null;
  last_scanned_at: Date | string | null;
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null): string | null => (value ? iso(value) : null);

/** `%` and `_` in what somebody typed into the search box are text, not wildcards. */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * One row per tracked, active person. `$1` is the day, `$2` is "now" (to tell a live code from one
 * that ran out without having been scanned). The latest code of the day decides the state.
 */
const BASE = `
  with base as (
    select p.id, p.employee_code, p.full_name, p.email, p.avatar_url, p.designation,
           p.department_id, d.name as department,
           t.action::text as t_action, t.issued_at, t.expires_at, t.used_at,
           coalesce(c.n, 0)::int as generated,
           case when t.id is null then 'NONE'
                when t.status = 'USED' then 'USED'
                when t.status = 'ACTIVE' and t.expires_at > $2::timestamptz then 'ACTIVE'
                else 'EXPIRED' end as state,
           (select max(l.scanned_at) from public.qr_scan_logs l
             where l.employee_id = p.id and l.status = 'RECORDED') as last_scanned_at
    from public.profiles p
    join public.roles ro on ro.id = p.role_id
    left join public.departments d on d.id = p.department_id
    left join lateral (
      select x.id, x.action, x.status, x.issued_at, x.expires_at, x.used_at
      from public.attendance_qr_tokens x
      where x.employee_id = p.id and x.work_date = $1::date
      -- Two codes made in the same instant: the one that was not replaced is the later one.
      order by x.issued_at desc, (x.status = 'SUPERSEDED') asc
      limit 1
    ) t on true
    left join lateral (
      select count(*) as n from public.attendance_qr_tokens y
      where y.employee_id = p.id and y.work_date = $1::date
    ) c on true
    where p.is_active and p.attendance_required and ro.name <> 'office_display'
  )`;

export class QrOverviewService {
  constructor(private readonly deps: QrOverviewDeps) {}

  async overview(query: QrOverviewQuery): Promise<QrOverview> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const office = await requireActiveOffice(db);
    const policy = await loadPolicyAt(db, now, office.timezone);
    const today = (
      await db.query<{ d: string }>('select private.local_date($1::timestamptz, $2)::text as d', [
        now,
        office.timezone,
      ])
    ).rows[0]!.d;
    const day = query.date ?? today;
    if (day > today) {
      throw new AppError('VALIDATION_FAILED', 'That date is in the future.', {
        details: [{ path: 'date', message: 'That date is in the future.' }],
      });
    }

    // The summary is about everybody tracked, whatever the filters say.
    const counts = (
      await db.query<{
        total: number;
        active: number;
        used: number;
        expired: number;
        none: number;
      }>(
        `${BASE}
         select count(*)::int as total,
                count(*) filter (where state = 'ACTIVE')::int as active,
                count(*) filter (where state = 'USED')::int as used,
                count(*) filter (where state = 'EXPIRED')::int as expired,
                count(*) filter (where state = 'NONE')::int as none
         from base`,
        [day, now],
      )
    ).rows[0]!;

    const params: unknown[] = [day, now];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const conditions: string[] = [];
    if (query.search) {
      const pattern = bind(`%${escapeLike(query.search)}%`);
      conditions.push(
        `(b.full_name ilike ${pattern} escape '\\' or b.employee_code ilike ${pattern} escape '\\'` +
          ` or b.email ilike ${pattern} escape '\\')`,
      );
    }
    if (query.departmentId) conditions.push(`b.department_id = ${bind(query.departmentId)}::uuid`);
    if (query.state) conditions.push(`b.state = ${bind(query.state)}`);
    const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';

    const total = (
      await db.query<{ n: number }>(
        `${BASE} select count(*)::int as n from base b ${where}`,
        params,
      )
    ).rows[0]!.n;

    const limit = bind(query.pageSize);
    const offset = bind((query.page - 1) * query.pageSize);
    const { rows } = await db.query<Row>(
      `${BASE}
       select b.* from base b ${where}
       order by b.full_name, b.employee_code
       limit ${limit}::int offset ${offset}::int`,
      params,
    );

    const items: QrOverviewRow[] = rows.map((row) => ({
      employeeId: row.id,
      employeeCode: row.employee_code,
      fullName: row.full_name,
      email: row.email,
      avatarUrl: row.avatar_url,
      department: row.department,
      designation: row.designation,
      state: row.state,
      generated: row.generated,
      latest:
        row.t_action && row.issued_at && row.expires_at
          ? {
              action: row.t_action,
              issuedAt: iso(row.issued_at),
              expiresAt: iso(row.expires_at),
              usedAt: isoOrNull(row.used_at),
            }
          : null,
      lastScannedAt: isoOrNull(row.last_scanned_at),
    }));

    return {
      date: day,
      isToday: day === today,
      summary: counts,
      maxPerDay: policy.dailyQrMaxPerDay,
      ttlSeconds: policy.dailyQrTtlSeconds,
      rows: items,
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }
}
