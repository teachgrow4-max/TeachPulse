-- =============================================================================
-- Admin-operated employee QR attendance, part 2 of 2
-- =============================================================================
-- Every employee has ONE live personal QR code (a printable ID-card code). An administrator or
-- attendance operator scans it, sees who it belongs to and what will happen, and confirms. The
-- attendance is recorded in the SAME attendance_records / attendance_events as a normal check-in
-- (source ADMIN_QR), by the SAME engine code, so late rules, holidays, leave, breaks and
-- corrections behave identically.
--
-- Not to be confused with the OFFICE QR (qr_tokens / qr_scan_events), the rotating code on the
-- lobby screen that an employee scans to prove they are in the building.
--
-- What this migration adds
--   1. the attendance_operator role
--   2. ADMIN_QR as an attendance event source
--   3. attendance_policies.admin_scan_layers - what the scanner's own presence proof must include
--   4. employee_qr_codes - one row per issued code; only a hash of the code is stored
--   5. qr_scan_logs      - every scan, accepted or not, and what became of it
--   6. private.record_check_in / record_check_out - the engine core, extracted from
--      check_in / check_out so both ways of recording attendance run the same code
--   7. private.qr_attendance_state / admin_qr_record - what a scan means, and recording it

-- -----------------------------------------------------------------------------
-- 1. The operator role: scans and records, nothing else.
-- -----------------------------------------------------------------------------
insert into public.roles (name, description) values
  ('attendance_operator',
   'Front-desk operator: scans employee QR codes and records attendance. Cannot manage employees, policy or reports.')
on conflict (name) do nothing;

-- -----------------------------------------------------------------------------
-- 2. Where an attendance event came from
-- -----------------------------------------------------------------------------
alter table public.attendance_events drop constraint attendance_events_source_check;
alter table public.attendance_events
  add constraint attendance_events_source_check
  check (source in ('EMPLOYEE', 'ADMIN', 'SYSTEM', 'ADMIN_QR'));

-- -----------------------------------------------------------------------------
-- 3. What the person operating the scanner must prove about THEIR OWN presence.
--    GPS and NETWORK can never be removed (same rule as check-in). The lobby QR is not on by
--    default: it is single-use per person per rotation window, so requiring it would force an
--    operator who processes a queue to wait for a new code between employees.
-- -----------------------------------------------------------------------------
alter table public.attendance_policies
  add column admin_scan_layers public.verification_layer[] not null
    default array['GPS', 'NETWORK']::public.verification_layer[],
  add constraint attendance_policies_admin_scan_core check (
    admin_scan_layers @> array['GPS', 'NETWORK']::public.verification_layer[]
  );

-- The device challenge and the verification record both learn about the new purpose.
alter table public.device_challenges drop constraint device_challenges_purpose_check;
alter table public.device_challenges
  add constraint device_challenges_purpose_check
  check (purpose in ('REGISTER', 'CHECK_IN', 'CHECK_OUT', 'ADMIN_SCAN'));

alter table public.attendance_verifications
  add constraint verifications_admin_scan_needs_gps_and_network check (
    purpose <> 'ADMIN_SCAN'
    or final_result <> 'VERIFIED'
    or (gps_result = 'PASS' and network_result = 'PASS')
  );

-- -----------------------------------------------------------------------------
-- 4. employee_qr_codes
--    The code printed on an ID card is  TGE1.<token>.  The token is derived by the API
--    (HMAC-SHA256 of the employee and token_nonce, under a secret only the API holds), so the
--    API can show the same code again whenever the employee or an administrator asks for it,
--    while the database holds only token_hash = SHA-256(token) and the nonce:
--      * reading this table does not reveal a usable code (the secret is also needed);
--      * a code presented at a scanner is found by its hash;
--      * regenerating issues a new nonce, so every earlier code stops working at once.
--    Nothing about the employee is encoded in the code.
-- -----------------------------------------------------------------------------
create table public.employee_qr_codes (
  id            uuid        primary key default gen_random_uuid(),
  employee_id   uuid        not null references public.profiles (id) on delete restrict,
  token_hash    bytea       not null unique check (octet_length(token_hash) = 32),
  token_nonce   bytea       not null check (octet_length(token_nonce) = 32),
  status        text        not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  generated_at  timestamptz not null default now(),
  -- NULL = issued automatically when the account was created
  generated_by  uuid        references public.profiles (id) on delete restrict,
  revoked_at    timestamptz,
  revoked_by    uuid        references public.profiles (id) on delete restrict,
  revoke_reason text        check (revoke_reason is null or length(revoke_reason) <= 500),
  constraint employee_qr_codes_revocation_consistent check (
    (status = 'ACTIVE' and revoked_at is null and revoked_by is null and revoke_reason is null)
    or (status = 'REVOKED' and revoked_at is not null)
  ),
  constraint employee_qr_codes_revoked_after_issue check (
    revoked_at is null or revoked_at >= generated_at
  )
);
-- "Exactly one live QR identity per employee", enforced by the database.
create unique index employee_qr_codes_one_active
  on public.employee_qr_codes (employee_id) where status = 'ACTIVE';
create index employee_qr_codes_employee_idx
  on public.employee_qr_codes (employee_id, generated_at desc);

-- A code's identity never changes. The only edit ever allowed is ACTIVE -> REVOKED, once.
create function private.employee_qr_codes_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  mutable_columns constant text[] := array['status', 'revoked_at', 'revoked_by', 'revoke_reason'];
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on employee_qr_codes is not allowed' using errcode = 'TG002';
  end if;
  if (to_jsonb(new) - mutable_columns) is distinct from (to_jsonb(old) - mutable_columns) then
    raise exception 'employee_qr_codes identity columns are immutable' using errcode = 'TG002';
  end if;
  if old.status = 'REVOKED' then
    raise exception 'a revoked QR code can never be changed' using errcode = 'TG002';
  end if;
  return new;
end;
$$;
create trigger employee_qr_codes_guard
  before update or delete on public.employee_qr_codes
  for each row execute function private.employee_qr_codes_guard();
create trigger employee_qr_codes_no_truncate
  before truncate on public.employee_qr_codes
  for each statement execute function private.reject_mutation();

-- -----------------------------------------------------------------------------
-- 5. qr_scan_logs: one row per scan. Written when the code is read, completed when the
--    attendance is recorded.
--
--    status  PENDING    the code was valid and an action is waiting for confirmation
--            RECORDED   the action was confirmed and attendance written
--            NO_ACTION  the code was valid but there is nothing to do (already checked out, holiday)
--            REJECTED   the code (or the employee) was not acceptable
--    A PENDING scan that is never confirmed simply expires (expires_at); it is not rewritten.
-- -----------------------------------------------------------------------------
create table public.qr_scan_logs (
  id                         uuid        primary key default gen_random_uuid(),
  -- the administrator / operator holding the camera
  scanned_by                 uuid        not null references public.profiles (id) on delete restrict,
  employee_id                uuid        references public.profiles (id) on delete restrict,
  qr_code_id                 uuid        references public.employee_qr_codes (id) on delete restrict,
  -- SHA-256 of what was presented (never the code itself); NULL when it was not even well formed
  token_hash                 bytea       check (token_hash is null or octet_length(token_hash) = 32),
  qr_result                  text        not null
                             check (qr_result in ('VALID', 'REVOKED', 'UNKNOWN', 'MALFORMED')),
  detected_action            text        not null
                             check (detected_action in
                               ('CHECK_IN', 'CHECK_OUT', 'ALREADY_CHECKED_OUT', 'BLOCKED', 'REJECTED')),
  -- stable machine code explaining a rejection or a "nothing to do"
  reason_code                text        check (reason_code is null or length(reason_code) <= 64),
  status                     text        not null
                             check (status in ('PENDING', 'RECORDED', 'NO_ACTION', 'REJECTED')),
  scanned_at                 timestamptz not null default now(),
  -- how long the scanner has to confirm (PENDING only)
  expires_at                 timestamptz,
  -- the device in the operator's hands: client-declared label, camera, plus the user agent
  scanner                    jsonb       not null default '{}'::jsonb
                             check (jsonb_typeof(scanner) = 'object'),
  client_ip                  inet,
  request_id                 text        check (request_id is null or length(request_id) <= 64),

  -- the operator's own presence proof (attendance_verifications, purpose ADMIN_SCAN); the latest
  -- attempt while PENDING, the one that was spent once RECORDED
  office_verification_id     uuid        references public.attendance_verifications (id) on delete restrict,
  office_verification_result text        check (office_verification_result in ('VERIFIED', 'REJECTED')),

  confirmed_at               timestamptz,
  confirmed_action           text        check (confirmed_action in ('CHECK_IN', 'CHECK_OUT')),
  attendance_event_id        bigint      references public.attendance_events (id) on delete restrict,
  attendance_record_id       uuid        references public.attendance_records (id) on delete restrict,

  -- who the code identified
  constraint qr_scan_logs_identity_shape check (
    (qr_result = 'VALID'   and employee_id is not null and qr_code_id is not null)
    or (qr_result = 'REVOKED' and employee_id is not null and qr_code_id is not null)
    or (qr_result in ('UNKNOWN', 'MALFORMED') and employee_id is null and qr_code_id is null)
  ),
  -- the only legal pairings of what was detected and where the scan stands
  constraint qr_scan_logs_action_matches_status check (
    (detected_action in ('CHECK_IN', 'CHECK_OUT') and status in ('PENDING', 'RECORDED'))
    or (detected_action in ('ALREADY_CHECKED_OUT', 'BLOCKED') and status = 'NO_ACTION')
    or (detected_action = 'REJECTED' and status = 'REJECTED')
  ),
  constraint qr_scan_logs_actionable_needs_valid_code check (
    detected_action not in ('CHECK_IN', 'CHECK_OUT') or qr_result = 'VALID'
  ),
  -- Separation of duties: nobody records their OWN attendance with the scanner. Their scan of their
  -- own code is kept (so the attempt is on record) but only ever as a refusal. The scanner proves
  -- presence with fewer layers than a check-in may require, so allowing this would be a way round
  -- the stricter check-in policy.
  constraint qr_scan_logs_no_self_recording check (
    employee_id is null or employee_id <> scanned_by or status = 'REJECTED'
  ),
  constraint qr_scan_logs_pending_has_expiry check (status <> 'PENDING' or expires_at is not null),
  constraint qr_scan_logs_reason_when_nothing_happens check (
    status not in ('NO_ACTION', 'REJECTED') or reason_code is not null
  ),
  constraint qr_scan_logs_recorded_is_complete check (
    (status = 'RECORDED') = (confirmed_at is not null)
    and (
      status <> 'RECORDED' or (
        confirmed_action = detected_action
        and attendance_event_id is not null
        and attendance_record_id is not null
        and office_verification_id is not null
        and office_verification_result = 'VERIFIED'
      )
    )
  )
);
create index qr_scan_logs_scanner_idx on public.qr_scan_logs (scanned_by, scanned_at desc);
create index qr_scan_logs_employee_idx on public.qr_scan_logs (employee_id, scanned_at desc)
  where employee_id is not null;
create index qr_scan_logs_scanned_at_idx on public.qr_scan_logs (scanned_at desc);
create index qr_scan_logs_status_idx on public.qr_scan_logs (status, scanned_at desc);
create index qr_scan_logs_code_idx on public.qr_scan_logs (qr_code_id) where qr_code_id is not null;
-- One attendance event is explained by exactly one scan, and one presence proof is spent once.
create unique index qr_scan_logs_one_per_event
  on public.qr_scan_logs (attendance_event_id) where attendance_event_id is not null;
create unique index qr_scan_logs_one_use_per_verification
  on public.qr_scan_logs (office_verification_id) where status = 'RECORDED';

-- A scan is evidence. After it is read only its confirmation can be filled in, once.
create function private.qr_scan_logs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  mutable_columns constant text[] := array[
    'status', 'office_verification_id', 'office_verification_result', 'confirmed_at',
    'confirmed_action', 'attendance_event_id', 'attendance_record_id'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on qr_scan_logs is not allowed' using errcode = 'TG002';
  end if;
  if (to_jsonb(new) - mutable_columns) is distinct from (to_jsonb(old) - mutable_columns) then
    raise exception 'qr_scan_logs rows are immutable once written' using errcode = 'TG002';
  end if;
  if old.status <> 'PENDING' then
    raise exception 'a finished scan can never be changed' using errcode = 'TG002';
  end if;
  if new.status not in ('PENDING', 'RECORDED') then
    raise exception 'a pending scan can only be recorded' using errcode = 'TG002';
  end if;
  return new;
end;
$$;
create trigger qr_scan_logs_guard
  before update or delete on public.qr_scan_logs
  for each row execute function private.qr_scan_logs_guard();
create trigger qr_scan_logs_no_truncate
  before truncate on public.qr_scan_logs
  for each statement execute function private.reject_mutation();

-- -----------------------------------------------------------------------------
-- Row Level Security. The API reaches these tables with its own database role; the grants below
-- are for the Data API / Realtime. Neither the hash, the nonce, the client address nor the device
-- description is ever visible to a signed-in user, whoever they are.
-- -----------------------------------------------------------------------------
alter table public.employee_qr_codes enable row level security;
alter table public.qr_scan_logs enable row level security;
revoke all on public.employee_qr_codes from anon, authenticated;
revoke all on public.qr_scan_logs from anon, authenticated;

grant select (id, employee_id, status, generated_at, generated_by, revoked_at, revoked_by)
  on public.employee_qr_codes to authenticated;
grant select (id, scanned_by, employee_id, qr_result, detected_action, reason_code, status,
              scanned_at, confirmed_at, confirmed_action, office_verification_result,
              attendance_event_id, attendance_record_id)
  on public.qr_scan_logs to authenticated;

create policy employee_qr_codes_select on public.employee_qr_codes
  for select to authenticated
  using (
    (employee_id = (select auth.uid()) and (select private.is_active_user()))
    or (select private.is_admin())
  );

create policy qr_scan_logs_select on public.qr_scan_logs
  for select to authenticated
  using (
    ((scanned_by = (select auth.uid()) or employee_id = (select auth.uid()))
      and (select private.is_active_user()))
    or (select private.is_admin())
  );

-- -----------------------------------------------------------------------------
-- 6. The engine core.
--    private.check_in / private.check_out used to do two jobs: prove the caller holds a valid
--    verification, then change attendance. The second job is now its own function, called by
--    check_in / check_out (the employee marking their own attendance) and by admin_qr_record
--    (an operator marking it for them). There is one copy of the rules that decide late, half-day,
--    holiday, leave and break handling, so the two ways in can never disagree.
-- -----------------------------------------------------------------------------
create function private.record_check_in(
  p_employee uuid,
  p_now timestamptz,
  p_source text,
  p_actor uuid,
  p_verification uuid,
  p_device uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns public.attendance_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_office public.office_locations;
  v_policy public.attendance_policies;
  v_rec public.attendance_records;
  v_work_date date;
  v_day public.attendance_status;
  v_is_late boolean;
  v_status public.attendance_status;
begin
  v_office := private.require_office();
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
    v_rec.id, p_employee, 'CHECK_IN', p_now, p_source, p_actor, p_verification, p_device,
    jsonb_build_object('is_late', v_is_late, 'policy_id', v_policy.id)
      || coalesce(p_metadata, '{}'::jsonb));

  update public.attendance_records
  set check_in_at = p_now,
      status = v_status,
      is_late = v_is_late,
      live_state = 'WORKING',
      check_in_verification_id = p_verification,
      check_in_device_id = p_device,
      policy_id = v_policy.id,
      policy_snapshot = to_jsonb(v_policy)
  where id = v_rec.id
  returning * into v_rec;

  return v_rec;
end;
$$;

create function private.record_check_out(
  p_employee uuid,
  p_now timestamptz,
  p_source text,
  p_actor uuid,
  p_verification uuid,
  p_device uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns public.attendance_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_office public.office_locations;
  v_policy public.attendance_policies;
  v_rec public.attendance_records;
  v_break public.break_records;
  v_exc public.checkout_exceptions;
  v_event_id bigint;
  v_break_seconds integer;
  v_out timestamptz;
  v_sum private.day_summary;
begin
  v_office := private.require_office();
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
    v_rec.id, p_employee, 'CHECK_OUT', v_out, p_source, p_actor, p_verification, p_device,
    jsonb_build_object(
      'net_work_seconds', v_sum.net_seconds,
      'break_seconds', v_break_seconds,
      'is_half_day', v_sum.is_half_day,
      'is_early_checkout', v_sum.is_early_checkout,
      'overtime_minutes', v_sum.overtime_minutes)
      || coalesce(p_metadata, '{}'::jsonb));

  update public.attendance_records
  set check_out_at = v_out,
      live_state = 'CHECKED_OUT',
      total_break_seconds = v_break_seconds,
      net_work_seconds = v_sum.net_seconds,
      is_half_day = v_sum.is_half_day,
      is_early_checkout = v_sum.is_early_checkout,
      overtime_minutes = v_sum.overtime_minutes,
      check_out_verification_id = p_verification
  where id = v_rec.id
  returning * into v_rec;

  return v_rec;
end;
$$;

-- check_in / check_out keep their signatures and behaviour: they prove the caller's own
-- verification, hand over to the core above, then spend the verification.
create or replace function private.check_in(
  p_employee uuid,
  p_verification uuid,
  p_now timestamptz default clock_timestamp()
)
returns public.attendance_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_ver public.attendance_verifications;
  v_rec public.attendance_records;
begin
  perform private.assert_trackable(p_employee);
  perform private.require_office();

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

  v_rec := private.record_check_in(
    p_employee, p_now, 'EMPLOYEE', p_employee, v_ver.id, v_ver.device_id);

  update public.attendance_verifications set consumed_at = p_now where id = v_ver.id;

  return v_rec;
end;
$$;

create or replace function private.check_out(
  p_employee uuid,
  p_verification uuid,
  p_now timestamptz default clock_timestamp()
)
returns public.attendance_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_ver public.attendance_verifications;
  v_rec public.attendance_records;
begin
  perform private.assert_trackable(p_employee);
  perform private.require_office();

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

  v_rec := private.record_check_out(
    p_employee, p_now, 'EMPLOYEE', p_employee, v_ver.id, v_ver.device_id);

  update public.attendance_verifications set consumed_at = p_now where id = v_ver.id;

  return v_rec;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7a. Who may operate the scanner
-- -----------------------------------------------------------------------------
create function private.assert_scanner(p_user uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform 1
  from public.profiles p
  join public.roles r on r.id = p.role_id
  where p.id = p_user and p.is_active and r.name in ('admin', 'attendance_operator');
  if not found then
    raise exception using errcode = 'TG001', message = 'FORBIDDEN';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7b. What would happen if this employee's code were confirmed right now?
--     Read-only, and answered from the same facts check_in / check_out use:
--       an open day (checked in, not out, not finalised)      -> CHECK_OUT
--       today already checked out                             -> ALREADY_CHECKED_OUT
--       nothing yet today                                     -> CHECK_IN
--     unless the day cannot take attendance at all (holiday, weekly off, leave, a day closed
--     without a check-out), in which case the answer is BLOCKED with the reason.
-- -----------------------------------------------------------------------------
create function private.qr_attendance_state(
  p_employee uuid,
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_office public.office_locations;
  v_work_date date;
  v_rec public.attendance_records;
  v_day public.attendance_status;
  v_on_break boolean := false;
  v_exception boolean := false;
  v_action text;
  v_blocked text;
begin
  v_office := private.require_office();
  v_work_date := private.local_date(p_now, v_office.timezone);

  select * into v_rec
  from public.attendance_records
  where employee_id = p_employee
    and check_in_at is not null and check_out_at is null and not is_finalized
  order by work_date desc
  limit 1;

  if found then
    v_action := 'CHECK_OUT';
    select exists (
      select 1 from public.break_records
      where attendance_record_id = v_rec.id and ended_at is null) into v_on_break;
    select exists (
      select 1 from public.checkout_exceptions
      where attendance_record_id = v_rec.id and used_at is null) into v_exception;
    if v_on_break and not v_exception then
      v_blocked := 'ACTIVE_BREAK';
    end if;
  else
    select * into v_rec
    from public.attendance_records
    where employee_id = p_employee and work_date = v_work_date;

    if found and v_rec.check_out_at is not null then
      v_action := 'ALREADY_CHECKED_OUT';
    elsif found and v_rec.check_in_at is not null then
      -- Checked in, but the day was closed without a check-out. Only a correction can fix it.
      v_action := 'BLOCKED';
      v_blocked := 'ALREADY_CHECKED_IN';
    else
      v_day := private.common_day_type(v_work_date, v_office);
      if v_day is null and private.on_leave(p_employee, v_work_date) then
        v_day := 'ON_LEAVE';
      end if;
      if v_day is not null then
        v_action := 'BLOCKED';
        v_blocked := v_day::text;
      else
        v_action := 'CHECK_IN';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'workDate', coalesce(v_rec.work_date, v_work_date),
    'action', v_action,
    'blockedReason', v_blocked,
    'record', case when v_rec.id is null then null else jsonb_build_object(
      'id', v_rec.id,
      'workDate', v_rec.work_date,
      'status', v_rec.status,
      'liveState', v_rec.live_state,
      'isLate', v_rec.is_late,
      'checkInAt', v_rec.check_in_at,
      'checkOutAt', v_rec.check_out_at) end);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7c. Record the confirmed action. One transaction, one lock order, every rule re-checked at
--     the moment of recording (the scan may be minutes old, and another operator may have
--     got there first).
-- -----------------------------------------------------------------------------
create function private.admin_qr_record(
  p_scan uuid,
  p_admin uuid,
  p_action text,
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_scan public.qr_scan_logs;
  v_code public.employee_qr_codes;
  v_ver public.attendance_verifications;
  v_profile public.profiles;
  v_rec public.attendance_records;
  v_event bigint;
  v_meta jsonb;
begin
  perform private.assert_scanner(p_admin);

  select * into v_scan from public.qr_scan_logs where id = p_scan for update;
  -- Somebody else's scan looks exactly like one that does not exist.
  if not found or v_scan.scanned_by <> p_admin then
    raise exception using errcode = 'TG001', message = 'NOT_FOUND';
  end if;
  -- (the table's own constraint already makes this unreachable; kept so the rule reads here too)
  if v_scan.employee_id = p_admin then
    raise exception using errcode = 'TG001', message = 'SELF_SCAN_FORBIDDEN';
  end if;
  if v_scan.status = 'RECORDED' then
    raise exception using errcode = 'TG001', message = 'SCAN_ALREADY_RECORDED';
  end if;
  if v_scan.status <> 'PENDING' then
    raise exception using errcode = 'TG001', message = 'SCAN_NOT_ACTIONABLE';
  end if;
  if v_scan.expires_at <= p_now then
    raise exception using errcode = 'TG001', message = 'SCAN_EXPIRED';
  end if;
  if p_action is distinct from v_scan.detected_action then
    raise exception using errcode = 'TG001', message = 'SCAN_ACTION_MISMATCH';
  end if;

  -- The code must still be the employee's live one, and the employee must still be trackable.
  select * into v_code from public.employee_qr_codes where id = v_scan.qr_code_id for share;
  if not found or v_code.status <> 'ACTIVE' then
    raise exception using errcode = 'TG001', message = 'EMPLOYEE_QR_REVOKED';
  end if;

  select * into v_profile from public.profiles where id = v_scan.employee_id for share;
  if not found then
    raise exception using errcode = 'TG001', message = 'NOT_FOUND';
  end if;
  if not v_profile.is_active then
    raise exception using errcode = 'TG001', message = 'EMPLOYEE_INACTIVE';
  end if;
  if not v_profile.attendance_required then
    raise exception using errcode = 'TG001', message = 'ATTENDANCE_NOT_TRACKED';
  end if;

  -- The operator's own proof that they are at the office: theirs, for this purpose, passed,
  -- unspent, unexpired, and from a device that is still approved.
  if v_scan.office_verification_id is null then
    raise exception using errcode = 'TG001', message = 'VERIFICATION_REQUIRED';
  end if;
  select * into v_ver
  from public.attendance_verifications
  where id = v_scan.office_verification_id
  for update;
  if not found
     or v_ver.employee_id <> p_admin
     or v_ver.purpose <> 'ADMIN_SCAN'
     or v_ver.final_result <> 'VERIFIED' then
    raise exception using errcode = 'TG001', message = 'VERIFICATION_INVALID';
  end if;
  if v_ver.consumed_at is not null then
    raise exception using errcode = 'TG001', message = 'VERIFICATION_USED';
  end if;
  if v_ver.expires_at <= p_now then
    raise exception using errcode = 'TG001', message = 'VERIFICATION_EXPIRED';
  end if;
  perform private.assert_device_active(v_ver);

  -- The attendance itself: the shared engine core. The employee's own device is not involved,
  -- so none is recorded; the evidence is the operator's verification.
  v_meta := jsonb_build_object(
    'scan_id', v_scan.id,
    'qr_code_id', v_scan.qr_code_id,
    'scanned_by', p_admin);
  if p_action = 'CHECK_IN' then
    v_rec := private.record_check_in(
      v_scan.employee_id, p_now, 'ADMIN_QR', p_admin, v_ver.id, null, v_meta);
  elsif p_action = 'CHECK_OUT' then
    v_rec := private.record_check_out(
      v_scan.employee_id, p_now, 'ADMIN_QR', p_admin, v_ver.id, null, v_meta);
  else
    raise exception using errcode = 'TG001', message = 'VALIDATION_FAILED';
  end if;

  select e.id into v_event
  from public.attendance_events e
  where e.verification_id = v_ver.id
    and e.employee_id = v_scan.employee_id
    and e.event_type = p_action::public.event_type
  order by e.id desc
  limit 1;

  update public.attendance_verifications set consumed_at = p_now where id = v_ver.id;

  update public.qr_scan_logs
  set status = 'RECORDED',
      confirmed_at = p_now,
      confirmed_action = p_action,
      attendance_event_id = v_event,
      attendance_record_id = v_rec.id,
      office_verification_result = 'VERIFIED'
  where id = v_scan.id;

  return jsonb_build_object('scanId', v_scan.id, 'eventId', v_event, 'recordId', v_rec.id);
end;
$$;

-- Standard lockdown block: client roles may execute only the RLS helper functions.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_role_name() to authenticated, service_role;
grant execute on function private.is_admin() to authenticated, service_role;
grant execute on function private.is_active_user() to authenticated, service_role;
