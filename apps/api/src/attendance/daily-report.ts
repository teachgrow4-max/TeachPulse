import type {
  DailyAttendanceReport,
  DailyAttendanceRow,
  DailyRowState,
  LiveState,
} from '@teachgrow/shared';
import type { Db } from '../db/pool.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { requireActiveOffice } from '../office/repository.js';

/**
 * The administrator's view of one day: who is in, who is late, who is absent, when each person
 * checked in, and how many scans were refused. Read-only; everything comes from the same
 * `attendance_records` and `qr_scan_logs` the engine writes.
 */

export interface DailyReportDeps {
  db: Db;
  clock: Clock;
}

interface Row {
  id: string;
  employee_code: string;
  full_name: string;
  department: string | null;
  designation: string | null;
  status: string | null;
  check_in_at: Date | string | null;
  check_out_at: Date | string | null;
  live_state: LiveState | null;
  is_late: boolean | null;
  net_work_seconds: number | null;
  source: string | null;
  on_leave: boolean;
}

const isoOrNull = (value: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null;

export class DailyAttendanceReportService {
  constructor(private readonly deps: DailyReportDeps) {}

  async forDate(date: string | undefined): Promise<DailyAttendanceReport> {
    const { db, clock } = this.deps;
    const office = await requireActiveOffice(db);
    const today = (
      await db.query<{ d: string }>('select private.local_date($1::timestamptz, $2)::text as d', [
        clock.now(),
        office.timezone,
      ])
    ).rows[0]!.d;
    const day = date ?? today;
    if (day > today) {
      throw new AppError('VALIDATION_FAILED', 'That date is in the future.', {
        details: [{ path: 'date', message: 'That date is in the future.' }],
      });
    }

    // A holiday or weekly off applies to everybody; leave is per person.
    const dayType = (
      await db.query<{ t: string | null }>(
        'select private.common_day_type($1::date, private.require_office())::text as t',
        [day],
      )
    ).rows[0]!.t;

    const { rows } = await db.query<Row>(
      `select p.id, p.employee_code, p.full_name, d.name as department, p.designation,
              r.status::text as status, r.check_in_at, r.check_out_at, r.live_state::text as live_state,
              r.is_late, r.net_work_seconds,
              (select e.source from public.attendance_events e
                where e.attendance_record_id = r.id and e.event_type = 'CHECK_IN'
                order by e.id limit 1) as source,
              private.on_leave(p.id, $1::date) as on_leave
       from public.profiles p
       join public.roles ro on ro.id = p.role_id
       left join public.departments d on d.id = p.department_id
       left join public.attendance_records r on r.employee_id = p.id and r.work_date = $1::date
       where p.is_active and p.attendance_required and ro.name <> 'office_display'
       order by p.full_name, p.employee_code`,
      [day],
    );

    const items: DailyAttendanceRow[] = rows.map((row) => {
      let state: DailyRowState;
      if (row.check_in_at) state = row.is_late ? 'LATE' : 'PRESENT';
      else if (dayType === 'HOLIDAY') state = 'HOLIDAY';
      else if (dayType === 'WEEKLY_OFF') state = 'WEEKLY_OFF';
      else if (row.on_leave) state = 'ON_LEAVE';
      else state = 'ABSENT';
      return {
        employeeId: row.id,
        employeeCode: row.employee_code,
        fullName: row.full_name,
        department: row.department,
        designation: row.designation,
        state,
        checkInAt: isoOrNull(row.check_in_at),
        checkOutAt: isoOrNull(row.check_out_at),
        liveState: row.live_state ?? 'NONE',
        isLate: row.is_late ?? false,
        netWorkSeconds: row.net_work_seconds,
        source: row.source,
      };
    });

    const warnings = (
      await db.query<{ duplicates: string; invalid: string }>(
        `select count(*) filter (where reason_code = 'QR_ALREADY_USED')::text as duplicates,
                count(*) filter (where reason_code in
                  ('QR_EXPIRED', 'QR_SUPERSEDED', 'EMPLOYEE_QR_INVALID'))::text as invalid
         from public.qr_scan_logs
         where (scanned_at at time zone $2)::date = $1::date`,
        [day, office.timezone],
      )
    ).rows[0]!;

    const count = (state: DailyRowState) => items.filter((row) => row.state === state).length;
    return {
      date: day,
      isToday: day === today,
      summary: {
        total: items.length,
        present: count('PRESENT') + count('LATE'),
        late: count('LATE'),
        absent: count('ABSENT'),
        onLeave: count('ON_LEAVE'),
      },
      warnings: {
        duplicateScans: Number(warnings.duplicates),
        invalidOrExpiredScans: Number(warnings.invalid),
      },
      rows: items,
    };
  }
}
