-- =============================================================================
-- 0005 Attendance engine: transactional state transitions in PL/pgSQL
-- =============================================================================
-- Conventions
--   * Everything lives in schema `private` (not exposed by the Data API).
--   * Domain failures are raised as SQLSTATE 'TG001' with the error code as the message;
--     the API maps them to HTTP statuses (packages/shared/src/errors.ts).
--   * Time is passed in (`p_now`, default clock_timestamp()) so the API and tests control the
--     clock. Only the API's database role can execute these; clients cannot supply `p_now`.
--   * Each state-changing function locks the day's row (`FOR UPDATE`), so concurrent
--     requests serialise and invalid transitions are rejected deterministically.
-- =============================================================================

-- Composite types used as return values
create type private.day_summary as (
  net_seconds       integer,
  is_half_day       boolean,
  is_early_checkout boolean,
  overtime_minutes  integer
);

create type private.correction_plan as (
  check_in_at       timestamptz,
  check_out_at      timestamptz,
  status            public.attendance_status,
  live_state        public.live_state,
  is_late           boolean,
  is_half_day       boolean,
  is_early_checkout boolean,
  overtime_minutes  integer,
  total_break_seconds integer,
  net_work_seconds  integer
);

-- -----------------------------------------------------------------------------
-- Small pure helpers
-- -----------------------------------------------------------------------------
create function private.local_date(p_ts timestamptz, p_tz text)
returns date language sql stable set search_path = ''
as $$ select (p_ts at time zone p_tz)::date $$;

create function private.local_time(p_ts timestamptz, p_tz text)
returns time language sql stable set search_path = ''
as $$ select (p_ts at time zone p_tz)::time $$;

create function private.require_office()
returns public.office_locations
language plpgsql stable set search_path = ''
as $$
declare
  v_office public.office_locations;
begin
  select * into v_office from public.office_locations where is_active;
  if not found then
    raise exception using errcode = 'TG001', message = 'OFFICE_NOT_CONFIGURED';
  end if;
  return v_office;
end;
$$;

create function private.policy_for(p_date date)
returns public.attendance_policies
language plpgsql stable set search_path = ''
as $$
declare
  v_policy public.attendance_policies;
begin
  select * into v_policy
  from public.attendance_policies
  where effective_from <= p_date
  order by effective_from desc
  limit 1;
  if not found then
    raise exception using errcode = 'TG001', message = 'POLICY_NOT_FOUND';
  end if;
  return v_policy;
end;
$$;

-- The policy a record was classified under (its snapshot), falling back to the date's policy.
create function private.policy_of(p_rec public.attendance_records)
returns public.attendance_policies
language plpgsql stable set search_path = ''
as $$
begin
  if p_rec.policy_snapshot is not null then
    return jsonb_populate_record(null::public.attendance_policies, p_rec.policy_snapshot);
  end if;
  return private.policy_for(p_rec.work_date);
end;
$$;

-- Weekly off / public holiday for a date (employee independent); NULL for a normal working day.
create function private.common_day_type(p_date date, p_office public.office_locations)
returns public.attendance_status
language plpgsql stable set search_path = ''
as $$
begin
  if not (extract(isodow from p_date)::smallint = any (p_office.working_days)) then
    return 'WEEKLY_OFF';
  end if;
  if exists (select 1 from public.holidays h where h.holiday_date = p_date) then
    return 'HOLIDAY';
  end if;
  return null;
end;
$$;

create function private.on_leave(p_employee uuid, p_date date)
returns boolean
language sql stable set search_path = ''
as $$
  select exists (
    select 1 from public.leave_records l
    where l.employee_id = p_employee
      and l.cancelled_at is null
      and p_date between l.start_date and l.end_date
  )
$$;

create function private.sum_break_seconds(p_record uuid)
returns integer
language sql stable set search_path = ''
as $$
  select coalesce(sum(b.duration_seconds), 0)::integer
  from public.break_records b
  where b.attendance_record_id = p_record and b.ended_at is not null
$$;

-- net = elapsed - recorded breaks. Half-day / overtime / early checkout follow the policy; all
-- three are independent of lateness. Nothing here computes pay or penalties.
create function private.summarize_day(
  p_policy public.attendance_policies,
  p_tz text,
  p_work_date date,
  p_in timestamptz,
  p_out timestamptz,
  p_break_seconds integer
)
returns private.day_summary
language plpgsql stable set search_path = ''
as $$
declare
  v_elapsed integer := greatest(extract(epoch from (p_out - p_in))::integer, 0);
  v_net integer := greatest(v_elapsed - p_break_seconds, 0);
  v_result private.day_summary;
begin
  v_result.net_seconds := v_net;
  v_result.is_half_day := coalesce(
    p_policy.half_day_enabled and v_net < p_policy.half_day_below_net_minutes * 60, false);
  v_result.overtime_minutes := case
    when p_policy.overtime_enabled
      then greatest(0, (v_net - p_policy.overtime_after_net_minutes * 60) / 60)
    else 0 end;
  -- Early checkout is judged on the work date only (an overnight checkout is never "early").
  v_result.is_early_checkout := coalesce(
    p_policy.early_checkout_enabled
    and private.local_date(p_out, p_tz) = p_work_date
    and private.local_time(p_out, p_tz)
        < (p_policy.early_checkout_before - make_interval(mins => p_policy.early_checkout_grace_minutes)),
    false);
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Guards shared by the state-changing functions
-- -----------------------------------------------------------------------------
create function private.assert_admin(p_user uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform 1
  from public.profiles p
  join public.roles r on r.id = p.role_id
  where p.id = p_user and p.is_active and r.name = 'admin';
  if not found then
    raise exception using errcode = 'TG001', message = 'FORBIDDEN';
  end if;
end;
$$;

create function private.assert_trackable(p_employee uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  select * into v_profile from public.profiles where id = p_employee for share;
  if not found then
    raise exception using errcode = 'TG001', message = 'NOT_FOUND';
  end if;
  if not v_profile.is_active then
    raise exception using errcode = 'TG001', message = 'ACCOUNT_DEACTIVATED';
  end if;
  if not v_profile.attendance_required then
    raise exception using errcode = 'TG001', message = 'FORBIDDEN';
  end if;
end;
$$;

-- Locks and returns the caller's own VERIFIED verification of the right purpose.
create function private.lock_verification(
  p_employee uuid,
  p_verification uuid,
  p_purpose public.verification_purpose
)
returns public.attendance_verifications
language plpgsql security definer set search_path = ''
as $$
declare
  v_ver public.attendance_verifications;
begin
  select * into v_ver
  from public.attendance_verifications
  where id = p_verification and employee_id = p_employee
  for update;
  if not found or v_ver.purpose <> p_purpose or v_ver.final_result <> 'VERIFIED' then
    raise exception using errcode = 'TG001', message = 'VERIFICATION_INVALID';
  end if;
  return v_ver;
end;
$$;

-- A device that passed verification must still be ACTIVE at the moment of use
-- (revocation takes effect immediately).
create function private.assert_device_active(p_ver public.attendance_verifications)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_ver.device_result = 'PASS' then
    perform 1
    from public.registered_devices d
    where d.id = p_ver.device_id
      and d.employee_id = p_ver.employee_id
      and d.status = 'ACTIVE'
    for share;
    if not found then
      raise exception using errcode = 'TG001', message = 'DEVICE_NOT_ACTIVE';
    end if;
  end if;
end;
$$;

create function private.append_event(
  p_record uuid,
  p_employee uuid,
  p_type public.event_type,
  p_at timestamptz,
  p_source text,
  p_actor uuid,
  p_verification uuid,
  p_device uuid,
  p_metadata jsonb
)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.attendance_events
    (attendance_record_id, employee_id, event_type, occurred_at, source, actor_id,
     verification_id, device_id, metadata)
  values
    (p_record, p_employee, p_type, p_at, p_source, p_actor,
     p_verification, p_device, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

-- The employee's currently open (checked-in, not checked-out, not finalized) day, locked.
create function private.lock_open_record(p_employee uuid, p_now timestamptz)
returns public.attendance_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_rec public.attendance_records;
  v_office public.office_locations;
begin
  select * into v_rec
  from public.attendance_records
  where employee_id = p_employee
    and check_in_at is not null
    and check_out_at is null
    and not is_finalized
  order by work_date desc
  limit 1
  for update;
  if found then
    return v_rec;
  end if;

  v_office := private.require_office();
  if exists (
    select 1 from public.attendance_records
    where employee_id = p_employee
      and work_date = private.local_date(p_now, v_office.timezone)
      and check_out_at is not null
  ) then
    raise exception using errcode = 'TG001', message = 'ALREADY_CHECKED_OUT';
  end if;
  raise exception using errcode = 'TG001', message = 'NOT_CHECKED_IN';
end;
$$;

-- -----------------------------------------------------------------------------
-- check_in
-- Consumes a VERIFIED, unexpired, single-use verification. Idempotent: replaying the same
-- verification id returns the same record rather than failing or double-writing.
-- -----------------------------------------------------------------------------
create function private.check_in(
  p_employee uuid,
  p_verification uuid,
  p_now timestamptz default clock_timestamp()
)
returns public.attendance_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_office public.office_locations;
  v_policy public.attendance_policies;
  v_ver public.attendance_verifications;
  v_rec public.attendance_records;
  v_work_date date;
  v_day public.attendance_status;
  v_is_late boolean;
  v_status public.attendance_status;
begin
  perform private.assert_trackable(p_employee);
  v_office := private.require_office();

  v_ver := private.lock_verification(p_employee, p_verification, 'CHECK_IN');

  if v_ver.consumed_at is not null then
    select r.* into v_rec
    from public.attendance_events e
    join public.attendance_records r on r.id = e.attendance_record_id
    where e.verification_id = v_ver.id and e.event_type = 'CHECK_IN' and e.employee_id = p_employee
    limit 1;
    if found then
      return v_rec;
    end if;
    raise exception using errcode = 'TG001', message = 'VERIFICATION_USED';
  end if;

  if v_ver.expires_at <= p_now then
    raise exception using errcode = 'TG001', message = 'VERIFICATION_EXPIRED';
  end if;
  perform private.assert_device_active(v_ver);

  v_work_date := private.local_date(p_now, v_office.timezone);

  v_day := private.common_day_type(v_work_date, v_office);
  if v_day is null and private.on_leave(p_employee, v_work_date) then
    v_day := 'ON_LEAVE';
  end if;
  if v_day is not null then
    raise exception using errcode = 'TG001', message = v_day::text;
  end if;

  insert into public.attendance_records (employee_id, work_date, status, live_state)
  values (p_employee, v_work_date, 'ABSENT', 'NONE')
  on conflict (employee_id, work_date) do nothing;

  select * into v_rec
  from public.attendance_records
  where employee_id = p_employee and work_date = v_work_date
  for update;

  if v_rec.check_in_at is not null then
    raise exception using errcode = 'TG001', message = 'ALREADY_CHECKED_IN';
  end if;

  v_policy := private.policy_for(v_work_date);
  v_is_late := private.local_time(p_now, v_office.timezone) >= v_policy.late_threshold;
  v_status := case when v_is_late then 'LATE'::public.attendance_status
                   else 'PRESENT'::public.attendance_status end;

  perform private.append_event(
    v_rec.id, p_employee, 'CHECK_IN', p_now, 'EMPLOYEE', p_employee, v_ver.id, v_ver.device_id,
    jsonb_build_object('is_late', v_is_late, 'policy_id', v_policy.id));

  update public.attendance_records
  set check_in_at = p_now,
      status = v_status,
      is_late = v_is_late,
      live_state = 'WORKING',
      check_in_verification_id = v_ver.id,
      check_in_device_id = v_ver.device_id,
      policy_id = v_policy.id,
      policy_snapshot = to_jsonb(v_policy)
  where id = v_rec.id
  returning * into v_rec;

  update public.attendance_verifications set consumed_at = p_now where id = v_ver.id;

  return v_rec;
end;
$$;

-- -----------------------------------------------------------------------------
-- check_out
-- Blocked while a break is open unless an administrator granted a checkout exception,
-- in which case the open break is closed at the checkout instant and the exception is used.
-- -----------------------------------------------------------------------------
create function private.check_out(
  p_employee uuid,
  p_verification uuid,
  p_now timestamptz default clock_timestamp()
)
returns public.attendance_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_office public.office_locations;
  v_policy public.attendance_policies;
  v_ver public.attendance_verifications;
  v_rec public.attendance_records;
  v_break public.break_records;
  v_exc public.checkout_exceptions;
  v_event_id bigint;
  v_break_seconds integer;
  v_out timestamptz;
  v_sum private.day_summary;
begin
  perform private.assert_trackable(p_employee);
  v_office := private.require_office();

  v_ver := private.lock_verification(p_employee, p_verification, 'CHECK_OUT');

  if v_ver.consumed_at is not null then
    select r.* into v_rec
    from public.attendance_events e
    join public.attendance_records r on r.id = e.attendance_record_id
    where e.verification_id = v_ver.id and e.event_type = 'CHECK_OUT' and e.employee_id = p_employee
    limit 1;
    if found then
      return v_rec;
    end if;
    raise exception using errcode = 'TG001', message = 'VERIFICATION_USED';
  end if;

  if v_ver.expires_at <= p_now then
    raise exception using errcode = 'TG001', message = 'VERIFICATION_EXPIRED';
  end if;
  perform private.assert_device_active(v_ver);

  v_rec := private.lock_open_record(p_employee, p_now);
  v_policy := private.policy_of(v_rec);
  v_out := greatest(p_now, v_rec.check_in_at);

  select * into v_break
  from public.break_records
  where attendance_record_id = v_rec.id and ended_at is null
  for update;
  if found then
    select * into v_exc
    from public.checkout_exceptions
    where attendance_record_id = v_rec.id and used_at is null
    for update;
    if not found then
      raise exception using errcode = 'TG001', message = 'ACTIVE_BREAK';
    end if;

    v_event_id := private.append_event(
      v_rec.id, p_employee, 'BREAK_END', v_out, 'SYSTEM', v_exc.granted_by, null, null,
      jsonb_build_object('reason', 'CHECKOUT_EXCEPTION', 'break_id', v_break.id, 'exception_id', v_exc.id));
    update public.break_records
    set ended_at = greatest(v_out, started_at),
        end_reason = 'CHECKOUT_EXCEPTION',
        end_event_id = v_event_id
    where id = v_break.id;
    update public.checkout_exceptions set used_at = p_now where id = v_exc.id;
  end if;

  v_break_seconds := private.sum_break_seconds(v_rec.id);
  v_sum := private.summarize_day(
    v_policy, v_office.timezone, v_rec.work_date, v_rec.check_in_at, v_out, v_break_seconds);

  perform private.append_event(
    v_rec.id, p_employee, 'CHECK_OUT', v_out, 'EMPLOYEE', p_employee, v_ver.id, v_ver.device_id,
    jsonb_build_object(
      'net_work_seconds', v_sum.net_seconds,
      'break_seconds', v_break_seconds,
      'is_half_day', v_sum.is_half_day,
      'is_early_checkout', v_sum.is_early_checkout,
      'overtime_minutes', v_sum.overtime_minutes));

  update public.attendance_records
  set check_out_at = v_out,
      live_state = 'CHECKED_OUT',
      total_break_seconds = v_break_seconds,
      net_work_seconds = v_sum.net_seconds,
      is_half_day = v_sum.is_half_day,
      is_early_checkout = v_sum.is_early_checkout,
      overtime_minutes = v_sum.overtime_minutes,
      check_out_verification_id = v_ver.id
  where id = v_rec.id
  returning * into v_rec;

  update public.attendance_verifications set consumed_at = p_now where id = v_ver.id;

  return v_rec;
end;
$$;

-- -----------------------------------------------------------------------------
-- Breaks
-- -----------------------------------------------------------------------------
create function private.start_break(
  p_employee uuid,
  p_type public.break_type,
  p_now timestamptz default clock_timestamp()
)
returns public.break_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_rec public.attendance_records;
  v_policy public.attendance_policies;
  v_break public.break_records;
  v_break_id uuid := gen_random_uuid();
  v_event_id bigint;
  v_short_count integer;
begin
  perform private.assert_trackable(p_employee);
  v_rec := private.lock_open_record(p_employee, p_now);

  if v_rec.live_state in ('ON_LUNCH', 'ON_SHORT_BREAK') then
    raise exception using errcode = 'TG001', message = 'ALREADY_ON_BREAK';
  end if;

  v_policy := private.policy_of(v_rec);
  if p_type = 'SHORT' and v_policy.max_short_breaks_per_day is not null then
    select count(*) into v_short_count
    from public.break_records
    where attendance_record_id = v_rec.id and break_type = 'SHORT';
    if v_short_count >= v_policy.max_short_breaks_per_day then
      raise exception using errcode = 'TG001', message = 'SHORT_BREAK_LIMIT';
    end if;
  end if;

  v_event_id := private.append_event(
    v_rec.id, p_employee, 'BREAK_START', greatest(p_now, v_rec.check_in_at), 'EMPLOYEE', p_employee,
    null, null, jsonb_build_object('break_type', p_type, 'break_id', v_break_id));

  insert into public.break_records
    (id, attendance_record_id, employee_id, break_type, started_at, start_event_id)
  values
    (v_break_id, v_rec.id, p_employee, p_type, greatest(p_now, v_rec.check_in_at), v_event_id)
  returning * into v_break;

  update public.attendance_records
  set live_state = case p_type
        when 'LUNCH' then 'ON_LUNCH'::public.live_state
        else 'ON_SHORT_BREAK'::public.live_state end
  where id = v_rec.id;

  return v_break;
end;
$$;

create function private.end_break(
  p_employee uuid,
  p_type public.break_type default null,
  p_now timestamptz default clock_timestamp()
)
returns public.break_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_rec public.attendance_records;
  v_break public.break_records;
  v_end timestamptz;
  v_event_id bigint;
begin
  perform private.assert_trackable(p_employee);
  v_rec := private.lock_open_record(p_employee, p_now);

  select * into v_break
  from public.break_records
  where attendance_record_id = v_rec.id and ended_at is null
  for update;
  if not found then
    raise exception using errcode = 'TG001', message = 'NO_ACTIVE_BREAK';
  end if;
  if p_type is not null and v_break.break_type <> p_type then
    raise exception using errcode = 'TG001', message = 'BREAK_TYPE_MISMATCH';
  end if;

  v_end := greatest(p_now, v_break.started_at);
  v_event_id := private.append_event(
    v_rec.id, p_employee, 'BREAK_END', v_end, 'EMPLOYEE', p_employee, null, null,
    jsonb_build_object('break_type', v_break.break_type, 'break_id', v_break.id));

  update public.break_records
  set ended_at = v_end, end_reason = 'USER', end_event_id = v_event_id
  where id = v_break.id
  returning * into v_break;

  update public.attendance_records
  set live_state = 'WORKING',
      total_break_seconds = private.sum_break_seconds(v_rec.id)
  where id = v_rec.id;

  return v_break;
end;
$$;

-- An administrator authorises one checkout while a break is still open.
create function private.grant_checkout_exception(
  p_employee uuid,
  p_admin uuid,
  p_reason text,
  p_now timestamptz default clock_timestamp()
)
returns public.checkout_exceptions
language plpgsql security definer set search_path = ''
as $$
declare
  v_rec public.attendance_records;
  v_exc public.checkout_exceptions;
begin
  perform private.assert_admin(p_admin);
  if p_admin = p_employee then
    raise exception using errcode = 'TG001', message = 'SELF_APPROVAL_FORBIDDEN';
  end if;
  v_rec := private.lock_open_record(p_employee, p_now);
  if exists (
    select 1 from public.checkout_exceptions
    where attendance_record_id = v_rec.id and used_at is null
  ) then
    raise exception using errcode = 'TG001', message = 'CONFLICT';
  end if;
  insert into public.checkout_exceptions
    (attendance_record_id, employee_id, granted_by, reason, granted_at)
  values (v_rec.id, p_employee, p_admin, p_reason, p_now)
  returning * into v_exc;
  return v_exc;
end;
$$;

-- -----------------------------------------------------------------------------
-- Corrections
--   plan_correction  : pure; validates a proposal and computes the resulting day.
--   create_correction: stores the request with an immutable snapshot of the original.
--   decide_correction: approve (applies) or reject. Never self-approval.
--   admin_correct    : admin-initiated create + approve in one transaction.
-- The original EVENTS are never touched; the change is recorded as CORRECTION_APPLIED.
-- -----------------------------------------------------------------------------
create function private.plan_correction(
  p_rec public.attendance_records,
  p_work_date date,
  p_proposed jsonb,
  p_tz text,
  p_today date,
  p_now timestamptz
)
returns private.correction_plan
language plpgsql stable set search_path = ''
as $$
declare
  v_in timestamptz;
  v_out timestamptz;
  v_break integer;
  v_explicit public.attendance_status;
  v_half_override boolean;
  v_policy public.attendance_policies;
  v_sum private.day_summary;
  v_plan private.correction_plan;
  v_late boolean;
  v_status public.attendance_status;
begin
  begin
    v_in := case when p_proposed ? 'check_in_at'
                 then nullif(p_proposed ->> 'check_in_at', '')::timestamptz
                 else p_rec.check_in_at end;
    v_out := case when p_proposed ? 'check_out_at'
                  then nullif(p_proposed ->> 'check_out_at', '')::timestamptz
                  else p_rec.check_out_at end;
    v_break := case when p_proposed ? 'total_break_seconds'
                    then (p_proposed ->> 'total_break_seconds')::integer
                    else coalesce(p_rec.total_break_seconds, 0) end;
    v_explicit := case when p_proposed ? 'status'
                       then (p_proposed ->> 'status')::public.attendance_status end;
    v_half_override := case when p_proposed ? 'is_half_day'
                            then (p_proposed ->> 'is_half_day')::boolean end;
  exception when others then
    raise exception using errcode = 'TG001', message = 'CORRECTION_INVALID';
  end;

  if v_in is null then
    v_out := null;
    v_break := 0;
  end if;

  if v_out is not null and (v_out < v_in or v_out > v_in + interval '24 hours') then
    raise exception using errcode = 'TG001', message = 'CORRECTION_INVALID';
  end if;
  if v_in is not null and private.local_date(v_in, p_tz) <> p_work_date then
    raise exception using errcode = 'TG001', message = 'CORRECTION_INVALID';
  end if;
  if (v_in is not null and v_in > p_now) or (v_out is not null and v_out > p_now) then
    raise exception using errcode = 'TG001', message = 'CORRECTION_INVALID';
  end if;
  if v_break < 0
     or (v_out is not null and v_break > extract(epoch from (v_out - v_in))) then
    raise exception using errcode = 'TG001', message = 'CORRECTION_INVALID';
  end if;

  if v_explicit is not null then
    if v_explicit in ('PRESENT', 'LATE', 'INCOMPLETE') and v_in is null then
      raise exception using errcode = 'TG001', message = 'CORRECTION_INVALID';
    end if;
    if v_explicit in ('ABSENT', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY') and v_in is not null then
      raise exception using errcode = 'TG001', message = 'CORRECTION_INVALID';
    end if;
    if v_explicit = 'INCOMPLETE' and v_out is not null then
      raise exception using errcode = 'TG001', message = 'CORRECTION_INVALID';
    end if;
    -- A past day with a check-in but no check-out can only be INCOMPLETE.
    if v_explicit in ('PRESENT', 'LATE') and v_out is null and p_work_date < p_today then
      raise exception using errcode = 'TG001', message = 'CORRECTION_INVALID';
    end if;
  elsif v_in is null and p_rec.status in ('PRESENT', 'LATE', 'INCOMPLETE') then
    -- Removing the check-in from a worked day requires saying what the day becomes.
    raise exception using errcode = 'TG001', message = 'CORRECTION_INVALID';
  end if;

  v_policy := case when p_rec.policy_snapshot is not null then private.policy_of(p_rec)
                   else private.policy_for(p_work_date) end;

  v_late := case
    when v_in is null then false
    when v_explicit = 'LATE' then true
    when v_explicit = 'PRESENT' then false
    else private.local_time(v_in, p_tz) >= v_policy.late_threshold
  end;

  v_status := coalesce(
    v_explicit,
    case
      when v_in is null then coalesce(p_rec.status, 'ABSENT'::public.attendance_status)
      when v_out is not null
           or not (coalesce(p_rec.is_finalized, false) or p_work_date < p_today)
        then (case when v_late then 'LATE' else 'PRESENT' end)::public.attendance_status
      else 'INCOMPLETE'::public.attendance_status
    end);

  v_plan.check_in_at := v_in;
  v_plan.check_out_at := v_out;
  v_plan.status := v_status;
  v_plan.is_late := v_late;
  v_plan.total_break_seconds := v_break;
  v_plan.live_state := case
    when v_out is not null then 'CHECKED_OUT'::public.live_state
    when v_in is not null and v_status in ('PRESENT', 'LATE') then 'WORKING'::public.live_state
    else 'NONE'::public.live_state
  end;

  if v_in is not null and v_out is not null then
    v_sum := private.summarize_day(v_policy, p_tz, p_work_date, v_in, v_out, v_break);
    v_plan.net_work_seconds := v_sum.net_seconds;
    v_plan.is_half_day := coalesce(v_half_override, v_sum.is_half_day);
    v_plan.is_early_checkout := v_sum.is_early_checkout;
    v_plan.overtime_minutes := v_sum.overtime_minutes;
  else
    v_plan.net_work_seconds := null;
    v_plan.is_half_day := coalesce(v_half_override and v_in is not null, false);
    v_plan.is_early_checkout := false;
    v_plan.overtime_minutes := 0;
  end if;

  return v_plan;
end;
$$;

create function private.create_correction(
  p_employee uuid,
  p_work_date date,
  p_proposed jsonb,
  p_reason text,
  p_requested_by uuid,
  p_source public.correction_source,
  p_now timestamptz default clock_timestamp()
)
returns public.attendance_corrections
language plpgsql security definer set search_path = ''
as $$
declare
  v_office public.office_locations;
  v_rec public.attendance_records;
  v_corr public.attendance_corrections;
  v_original jsonb;
begin
  v_office := private.require_office();

  perform 1 from public.profiles where id = p_employee;
  if not found then
    raise exception using errcode = 'TG001', message = 'NOT_FOUND';
  end if;
  if p_source = 'EMPLOYEE_REQUEST' and p_requested_by <> p_employee then
    raise exception using errcode = 'TG001', message = 'FORBIDDEN';
  end if;
  if p_source = 'ADMIN_INITIATED' then
    perform private.assert_admin(p_requested_by);
  end if;
  if p_work_date > private.local_date(p_now, v_office.timezone) then
    raise exception using errcode = 'TG001', message = 'CORRECTION_INVALID';
  end if;
  if exists (
    select 1 from public.attendance_corrections
    where employee_id = p_employee and work_date = p_work_date and status = 'PENDING'
  ) then
    raise exception using errcode = 'TG001', message = 'CONFLICT';
  end if;

  select * into v_rec
  from public.attendance_records
  where employee_id = p_employee and work_date = p_work_date;
  v_original := case when found then to_jsonb(v_rec) - 'policy_snapshot' else '{}'::jsonb end;

  -- Validate now so an impossible request is refused up front, not when an admin tries to approve it.
  perform private.plan_correction(
    v_rec, p_work_date, p_proposed, v_office.timezone,
    private.local_date(p_now, v_office.timezone), p_now);

  insert into public.attendance_corrections
    (employee_id, attendance_record_id, work_date, source, original, proposed, reason,
     requested_by, requested_at)
  values
    (p_employee, v_rec.id, p_work_date, p_source, v_original, p_proposed, p_reason,
     p_requested_by, p_now)
  returning * into v_corr;

  return v_corr;
end;
$$;

create function private.apply_correction(
  p_correction public.attendance_corrections,
  p_admin uuid,
  p_now timestamptz
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_office public.office_locations;
  v_rec public.attendance_records;
  v_plan private.correction_plan;
  v_policy public.attendance_policies;
  v_today date;
  v_before jsonb;
begin
  v_office := private.require_office();
  v_today := private.local_date(p_now, v_office.timezone);

  insert into public.attendance_records (employee_id, work_date, status, live_state)
  values (p_correction.employee_id, p_correction.work_date, 'ABSENT', 'NONE')
  on conflict (employee_id, work_date) do nothing;

  select * into v_rec
  from public.attendance_records
  where employee_id = p_correction.employee_id and work_date = p_correction.work_date
  for update;

  if exists (
    select 1 from public.break_records where attendance_record_id = v_rec.id and ended_at is null
  ) then
    raise exception using errcode = 'TG001', message = 'ACTIVE_BREAK';
  end if;

  v_plan := private.plan_correction(
    v_rec, p_correction.work_date, p_correction.proposed, v_office.timezone, v_today, p_now);
  v_policy := private.policy_for(p_correction.work_date);
  v_before := to_jsonb(v_rec) - 'policy_snapshot';

  update public.attendance_records
  set check_in_at = v_plan.check_in_at,
      check_out_at = v_plan.check_out_at,
      status = v_plan.status,
      live_state = v_plan.live_state,
      is_late = v_plan.is_late,
      is_half_day = v_plan.is_half_day,
      is_early_checkout = v_plan.is_early_checkout,
      overtime_minutes = v_plan.overtime_minutes,
      total_break_seconds = v_plan.total_break_seconds,
      net_work_seconds = v_plan.net_work_seconds,
      policy_id = coalesce(policy_id, v_policy.id),
      policy_snapshot = coalesce(policy_snapshot, to_jsonb(v_policy)),
      has_correction = true,
      -- correcting a past day closes it
      is_finalized = is_finalized or p_correction.work_date < v_today,
      finalized_at = case
        when finalized_at is null and p_correction.work_date < v_today then p_now
        else finalized_at end
  where id = v_rec.id
  returning * into v_rec;

  perform private.append_event(
    v_rec.id, p_correction.employee_id, 'CORRECTION_APPLIED', p_now, 'ADMIN', p_admin, null, null,
    jsonb_build_object(
      'correction_id', p_correction.id,
      'reason', p_correction.reason,
      'before', v_before,
      'after', to_jsonb(v_rec) - 'policy_snapshot'));

  return v_rec.id;
end;
$$;

create function private.decide_correction(
  p_correction uuid,
  p_admin uuid,
  p_approve boolean,
  p_note text default null,
  p_now timestamptz default clock_timestamp()
)
returns public.attendance_corrections
language plpgsql security definer set search_path = ''
as $$
declare
  v_corr public.attendance_corrections;
  v_record_id uuid;
begin
  perform private.assert_admin(p_admin);

  select * into v_corr from public.attendance_corrections where id = p_correction for update;
  if not found then
    raise exception using errcode = 'TG001', message = 'NOT_FOUND';
  end if;
  if v_corr.status <> 'PENDING' then
    raise exception using errcode = 'TG001', message = 'CORRECTION_ALREADY_DECIDED';
  end if;
  if v_corr.employee_id = p_admin then
    raise exception using errcode = 'TG001', message = 'SELF_APPROVAL_FORBIDDEN';
  end if;

  if p_approve then
    v_record_id := private.apply_correction(v_corr, p_admin, p_now);
    update public.attendance_corrections
    set status = 'APPROVED', decided_by = p_admin, decided_at = p_now,
        decision_note = p_note, applied_at = p_now, attendance_record_id = v_record_id
    where id = v_corr.id
    returning * into v_corr;
  else
    update public.attendance_corrections
    set status = 'REJECTED', decided_by = p_admin, decided_at = p_now, decision_note = p_note
    where id = v_corr.id
    returning * into v_corr;
  end if;

  return v_corr;
end;
$$;

create function private.admin_correct(
  p_employee uuid,
  p_work_date date,
  p_proposed jsonb,
  p_reason text,
  p_admin uuid,
  p_now timestamptz default clock_timestamp()
)
returns public.attendance_corrections
language plpgsql security definer set search_path = ''
as $$
declare
  v_corr public.attendance_corrections;
begin
  v_corr := private.create_correction(
    p_employee, p_work_date, p_proposed, p_reason, p_admin, 'ADMIN_INITIATED', p_now);
  return private.decide_correction(v_corr.id, p_admin, true, null, p_now);
end;
$$;

-- -----------------------------------------------------------------------------
-- Day finalization (idempotent). Marks, for a completed work date:
--   * no record + weekly off / holiday / approved leave / otherwise ABSENT
--   * checked in but never checked out -> INCOMPLETE (open breaks closed at zero length)
-- -----------------------------------------------------------------------------
create function private.finalize_attendance_day(
  p_date date,
  p_now timestamptz default clock_timestamp()
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_office public.office_locations;
  v_policy public.attendance_policies;
  v_policy_json jsonb;
  v_common public.attendance_status;
  v_break record;
  v_event_id bigint;
  v_touched integer := 0;
  v_rows integer;
begin
  select * into v_office from public.office_locations where is_active;
  if not found then
    return 0;
  end if;
  if p_date >= private.local_date(p_now, v_office.timezone) then
    raise exception using errcode = 'TG001', message = 'CONFLICT';
  end if;

  v_policy := private.policy_for(p_date);
  v_policy_json := to_jsonb(v_policy);
  v_common := private.common_day_type(p_date, v_office);

  -- A. Close dangling breaks at zero length: the real end is unknown, so no time is invented.
  for v_break in
    select b.id, b.attendance_record_id, b.employee_id
    from public.break_records b
    join public.attendance_records r on r.id = b.attendance_record_id
    where r.work_date = p_date and not r.is_finalized and b.ended_at is null
    for update of b
  loop
    v_event_id := private.append_event(
      v_break.attendance_record_id, v_break.employee_id, 'BREAK_END', p_now, 'SYSTEM', null, null, null,
      jsonb_build_object('reason', 'DAY_FINALIZED', 'break_id', v_break.id));
    update public.break_records
    set ended_at = started_at, end_reason = 'DAY_FINALIZED', end_event_id = v_event_id
    where id = v_break.id;
  end loop;

  -- B. Existing, not-yet-final records for the day.
  with fin as (
    update public.attendance_records r
    set status = case when r.check_in_at is not null and r.check_out_at is null
                      then 'INCOMPLETE'::public.attendance_status else r.status end,
        live_state = case when r.check_out_at is null
                          then 'NONE'::public.live_state else r.live_state end,
        is_finalized = true,
        finalized_at = p_now
    where r.work_date = p_date and not r.is_finalized
    returning r.id, r.employee_id, r.status
  ), ev as (
    insert into public.attendance_events
      (attendance_record_id, employee_id, event_type, occurred_at, source, metadata)
    select id, employee_id, 'DAY_FINALIZED', p_now, 'SYSTEM', jsonb_build_object('status', status)
    from fin
    returning 1
  )
  select count(*) into v_rows from ev;
  v_touched := v_touched + v_rows;

  -- C. Employees with no record at all.
  with eligible as (
    select p.id
    from public.profiles p
    where p.attendance_required
      and p.joining_date <= p_date
      and (p.deactivated_at is null
           or private.local_date(p.deactivated_at, v_office.timezone) > p_date)
      and not exists (
        select 1 from public.attendance_records r
        where r.employee_id = p.id and r.work_date = p_date)
  ), ins as (
    insert into public.attendance_records
      (employee_id, work_date, status, live_state, policy_id, policy_snapshot, is_finalized, finalized_at)
    select e.id, p_date,
           coalesce(
             v_common,
             case when private.on_leave(e.id, p_date)
                  then 'ON_LEAVE'::public.attendance_status
                  else 'ABSENT'::public.attendance_status end),
           'NONE', v_policy.id, v_policy_json, true, p_now
    from eligible e
    on conflict (employee_id, work_date) do nothing
    returning id, employee_id, status
  ), ev as (
    insert into public.attendance_events
      (attendance_record_id, employee_id, event_type, occurred_at, source, metadata)
    select id, employee_id, 'DAY_FINALIZED', p_now, 'SYSTEM', jsonb_build_object('status', status)
    from ins
    returning 1
  )
  select count(*) into v_rows from ev;
  v_touched := v_touched + v_rows;

  return v_touched;
end;
$$;

-- Hourly entry point. A date becomes due at 02:00 local time the following day, which leaves
-- room for late-night checkouts. A short look-back makes a missed run self-healing; dates
-- before the office was configured are never finalized.
create function private.finalize_due_days(
  p_now timestamptz default clock_timestamp(),
  p_lookback_days integer default 7
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_office public.office_locations;
  v_due_before date;
  v_first date;
  v_day date;
  v_total integer := 0;
begin
  select * into v_office from public.office_locations where is_active;
  if not found then
    return 0;
  end if;

  v_due_before := private.local_date(p_now - interval '2 hours', v_office.timezone);
  v_first := greatest(
    v_due_before - p_lookback_days,
    private.local_date(v_office.created_at, v_office.timezone));

  for v_day in
    select (v_first + g)::date from generate_series(0, v_due_before - 1 - v_first) as g
  loop
    v_total := v_total + private.finalize_attendance_day(v_day, p_now);
  end loop;
  return v_total;
end;
$$;

-- -----------------------------------------------------------------------------
-- Data retention (scheduled daily). Verdicts and distances are kept; raw coordinates are not.
-- -----------------------------------------------------------------------------
create function private.apply_retention(
  p_now timestamptz default clock_timestamp(),
  p_coordinates_days integer default 90,
  p_qr_days integer default 7,
  p_idempotency_hours integer default 48
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_coords integer;
  v_scans integer;
  v_tokens integer;
  v_keys integer;
begin
  update public.attendance_verifications
  set latitude = null, longitude = null, coordinates_purged_at = p_now
  where (latitude is not null or longitude is not null)
    and requested_at < p_now - make_interval(days => p_coordinates_days);
  get diagnostics v_coords = row_count;

  delete from public.qr_scan_events
  where scanned_at < p_now - make_interval(days => p_coordinates_days);
  get diagnostics v_scans = row_count;

  delete from public.qr_tokens
  where accept_until < p_now - make_interval(days => p_qr_days);
  get diagnostics v_tokens = row_count;

  delete from public.idempotency_keys
  where created_at < p_now - make_interval(hours => p_idempotency_hours);
  get diagnostics v_keys = row_count;

  return jsonb_build_object(
    'coordinates_purged', v_coords,
    'qr_scan_events_deleted', v_scans,
    'qr_tokens_deleted', v_tokens,
    'idempotency_keys_deleted', v_keys);
end;
$$;

-- -----------------------------------------------------------------------------
-- Lock down execution. EVERY migration that adds functions to `private` must end with this
-- block (a pgTAP test fails if a client role can execute anything not on the allowlist).
-- -----------------------------------------------------------------------------
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_role_name() to authenticated, service_role;
grant execute on function private.is_admin() to authenticated, service_role;
