-- =============================================================================
-- Employee-generated daily attendance QR codes
--
-- Replaces "the administrator proves THEY are at the office" with "the EMPLOYEE proves they are at
-- the office, and the proof is carried in a short-lived code the administrator scans":
--
--   employee   login -> GPS + office network verified -> generates a QR for TODAY and ONE action
--   admin      login -> opens the scanner -> scans -> attendance is recorded (no location, no Wi-Fi)
--
-- Contents
--   1. attendance_policies: what must be proved before generating a code (GPS + network),
--      how long a code lives, how many may be generated per day
--   2. office_locations: the default geofence is 150 m
--   3. attendance_qr_tokens: one row per generated code; only a SHA-256 of it is stored
--   4. qr_scan_logs: learns about these codes; a scan now records in one step
--   5. private.issue_daily_qr   - the employee generates a code
--   6. private.daily_qr_record  - the administrator's scan records attendance, atomically
--
-- The earlier static ID-card codes (employee_qr_codes) are no longer accepted by the scanner:
-- with the operator no longer proving presence, a code that never changes would let a photograph
-- of a card record attendance from anywhere. The tables stay so history is not lost.
-- No enum value is added, so this file can be run in one go.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Policy
-- -----------------------------------------------------------------------------
alter table public.attendance_policies
  add column daily_qr_layers public.verification_layer[] not null
    default array['GPS', 'NETWORK']::public.verification_layer[],
  add constraint attendance_policies_daily_qr_core check (
    daily_qr_layers @> array['GPS', 'NETWORK']::public.verification_layer[]
  ),
  add column daily_qr_ttl_seconds integer not null default 90
    check (daily_qr_ttl_seconds between 30 and 900),
  add column daily_qr_max_per_day integer not null default 5
    check (daily_qr_max_per_day between 1 and 50);

comment on column public.attendance_policies.daily_qr_layers is
  'What an employee must prove before generating an attendance QR code. GPS and NETWORK are always required; this is separate from the check-in layers so that generating a code needs only the location and the office network.';
comment on column public.attendance_policies.daily_qr_ttl_seconds is
  'How long a generated attendance QR code can be scanned.';
comment on column public.attendance_policies.daily_qr_max_per_day is
  'How many attendance QR codes one person may generate per day (regenerating replaces the live one).';

-- -----------------------------------------------------------------------------
-- 2. Geofence default
-- -----------------------------------------------------------------------------
alter table public.office_locations alter column geofence_radius_m set default 150;

-- -----------------------------------------------------------------------------
-- 3. attendance_qr_tokens
--    The code is  TGD1.<43 random base64url characters>. It is shown once, to the employee who
--    generated it. The database keeps only token_hash = SHA-256(code).
--
--    A code is bound to one employee, one calendar day (office time) and one action, and records
--    which verification proved the employee was at the office when it was generated.
--    Administrators are exempt from the location / network check, so for them the proof is waived.
-- -----------------------------------------------------------------------------
create table public.attendance_qr_tokens (
  id                  uuid        primary key default gen_random_uuid(),
  employee_id         uuid        not null references public.profiles (id) on delete restrict,
  work_date           date        not null,
  action              text        not null check (action in ('CHECK_IN', 'CHECK_OUT')),
  token_hash          bytea       not null unique check (octet_length(token_hash) = 32),
  -- the employee's own passed GPS + network verification, spent by generating this code
  verification_id     uuid        unique references public.attendance_verifications (id) on delete restrict,
  verification_waived boolean     not null default false,
  status              text        not null default 'ACTIVE'
                      check (status in ('ACTIVE', 'USED', 'SUPERSEDED')),
  issued_at           timestamptz not null default now(),
  expires_at          timestamptz not null,
  used_at             timestamptz,
  used_by             uuid        references public.profiles (id) on delete restrict,
  constraint attendance_qr_tokens_window check (expires_at > issued_at),
  constraint attendance_qr_tokens_has_proof check (verification_id is not null or verification_waived),
  constraint attendance_qr_tokens_used_shape check (
    (status = 'USED') = (used_at is not null and used_by is not null)
  ),
  constraint attendance_qr_tokens_no_self_use check (used_by is null or used_by <> employee_id)
);
-- One live code per person; generating another retires it.
create unique index attendance_qr_tokens_one_active
  on public.attendance_qr_tokens (employee_id) where status = 'ACTIVE';
-- A person can be recorded for one action once per day, whatever else happens.
create unique index attendance_qr_tokens_one_use_per_action
  on public.attendance_qr_tokens (employee_id, work_date, action) where status = 'USED';
create index attendance_qr_tokens_day_idx
  on public.attendance_qr_tokens (employee_id, work_date, issued_at desc);

create function private.attendance_qr_tokens_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  mutable_columns constant text[] := array['status', 'used_at', 'used_by'];
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on attendance_qr_tokens is not allowed' using errcode = 'TG002';
  end if;
  if (to_jsonb(new) - mutable_columns) is distinct from (to_jsonb(old) - mutable_columns) then
    raise exception 'attendance_qr_tokens identity columns are immutable' using errcode = 'TG002';
  end if;
  if old.status <> 'ACTIVE' then
    raise exception 'a used or superseded code can never change' using errcode = 'TG002';
  end if;
  if new.status not in ('USED', 'SUPERSEDED') then
    raise exception 'an active code can only be used or superseded' using errcode = 'TG002';
  end if;
  return new;
end;
$$;
create trigger attendance_qr_tokens_guard
  before update or delete on public.attendance_qr_tokens
  for each row execute function private.attendance_qr_tokens_guard();
create trigger attendance_qr_tokens_no_truncate
  before truncate on public.attendance_qr_tokens
  for each statement execute function private.reject_mutation();

alter table public.attendance_qr_tokens enable row level security;
revoke all on public.attendance_qr_tokens from anon, authenticated;
grant select (id, employee_id, work_date, action, status, issued_at, expires_at, used_at, used_by)
  on public.attendance_qr_tokens to authenticated;
create policy attendance_qr_tokens_select on public.attendance_qr_tokens
  for select to authenticated
  using (
    (employee_id = (select auth.uid()) and (select private.is_active_user()))
    or (select private.is_admin())
  );

-- -----------------------------------------------------------------------------
-- 4. qr_scan_logs: scans of these codes
--    A scan now records in one step, so the row is written already RECORDED (or refused).
--    The old two-step columns stay for history.
-- -----------------------------------------------------------------------------
alter table public.qr_scan_logs
  add column daily_qr_id uuid references public.attendance_qr_tokens (id) on delete restrict;
create index qr_scan_logs_daily_qr_idx on public.qr_scan_logs (daily_qr_id)
  where daily_qr_id is not null;
-- One code records attendance once.
create unique index qr_scan_logs_one_record_per_daily_qr
  on public.qr_scan_logs (daily_qr_id) where status = 'RECORDED' and daily_qr_id is not null;

alter table public.qr_scan_logs drop constraint qr_scan_logs_qr_result_check;
alter table public.qr_scan_logs
  add constraint qr_scan_logs_qr_result_check
  check (qr_result in ('VALID', 'REVOKED', 'UNKNOWN', 'MALFORMED', 'EXPIRED', 'USED', 'SUPERSEDED'));

alter table public.qr_scan_logs drop constraint qr_scan_logs_identity_shape;
alter table public.qr_scan_logs
  add constraint qr_scan_logs_identity_shape check (
    (qr_result in ('VALID', 'REVOKED') and employee_id is not null
       and (qr_code_id is not null or daily_qr_id is not null))
    or (qr_result in ('EXPIRED', 'USED', 'SUPERSEDED') and employee_id is not null
       and daily_qr_id is not null)
    or (qr_result in ('UNKNOWN', 'MALFORMED') and employee_id is null
       and qr_code_id is null and daily_qr_id is null)
  );

alter table public.qr_scan_logs drop constraint qr_scan_logs_recorded_is_complete;
alter table public.qr_scan_logs
  add constraint qr_scan_logs_recorded_is_complete check (
    (status = 'RECORDED') = (confirmed_at is not null)
    and (
      status <> 'RECORDED' or (
        confirmed_action = detected_action
        and attendance_event_id is not null
        and attendance_record_id is not null
        and (
          daily_qr_id is not null
          or (office_verification_id is not null and office_verification_result = 'VERIFIED')
        )
      )
    )
  );

grant select (daily_qr_id) on public.qr_scan_logs to authenticated;

-- -----------------------------------------------------------------------------
-- 5. The employee generates a code
--
--    p_hash is SHA-256 of the code text; the API makes the code and never stores it.
--    Everything is decided here, in one transaction: who may generate, what the code is for,
--    the employee's proof, the daily limit, and retiring the previous code.
-- -----------------------------------------------------------------------------
create function private.issue_daily_qr(
  p_employee     uuid,
  p_verification uuid,
  p_hash         bytea,
  p_now          timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_office public.office_locations;
  v_policy public.attendance_policies;
  v_role text;
  v_state jsonb;
  v_action text;
  v_work_date date;
  v_ver public.attendance_verifications;
  v_used integer;
  v_id uuid;
  v_expires timestamptz;
  v_waived boolean;
begin
  perform private.assert_trackable(p_employee);
  v_office := private.require_office();
  v_work_date := private.local_date(p_now, v_office.timezone);
  v_policy := private.policy_for(v_work_date);

  select r.name into v_role
  from public.profiles p join public.roles r on r.id = p.role_id
  where p.id = p_employee;
  if v_role = 'office_display' then
    raise exception using errcode = 'TG001', message = 'FORBIDDEN';
  end if;
  v_waived := v_role = 'admin';

  -- What is this code for? Whatever the engine would do next for this person.
  v_state := private.qr_attendance_state(p_employee, p_now);
  if v_state ->> 'blockedReason' is not null then
    raise exception using errcode = 'TG001', message = v_state ->> 'blockedReason';
  end if;
  v_action := v_state ->> 'action';
  if v_action = 'ALREADY_CHECKED_OUT' then
    raise exception using errcode = 'TG001', message = 'ALREADY_CHECKED_OUT';
  end if;
  if v_action not in ('CHECK_IN', 'CHECK_OUT') then
    raise exception using errcode = 'TG001', message = 'INTERNAL';
  end if;

  -- The employee's own proof that they are at the office (administrators are exempt).
  if not v_waived then
    if p_verification is null then
      raise exception using errcode = 'TG001', message = 'VERIFICATION_REQUIRED';
    end if;
    v_ver := private.lock_verification(p_employee, p_verification, v_action::public.verification_purpose);
    if v_ver.consumed_at is not null then
      raise exception using errcode = 'TG001', message = 'VERIFICATION_USED';
    end if;
    if v_ver.expires_at <= p_now then
      raise exception using errcode = 'TG001', message = 'VERIFICATION_EXPIRED';
    end if;
    perform private.assert_device_active(v_ver);
  end if;

  select count(*) into v_used
  from public.attendance_qr_tokens
  where employee_id = p_employee and work_date = v_work_date;
  if v_used >= v_policy.daily_qr_max_per_day then
    raise exception using errcode = 'TG001', message = 'QR_LIMIT_REACHED';
  end if;

  -- The previous live code stops working the moment a new one exists.
  update public.attendance_qr_tokens
  set status = 'SUPERSEDED'
  where employee_id = p_employee and status = 'ACTIVE';

  v_expires := p_now + make_interval(secs => v_policy.daily_qr_ttl_seconds);
  insert into public.attendance_qr_tokens
    (employee_id, work_date, action, token_hash, verification_id, verification_waived,
     issued_at, expires_at)
  values
    (p_employee, v_work_date, v_action, p_hash, case when v_waived then null else v_ver.id end,
     v_waived, p_now, v_expires)
  returning id into v_id;

  if not v_waived then
    update public.attendance_verifications set consumed_at = p_now where id = v_ver.id;
  end if;

  return jsonb_build_object(
    'id', v_id,
    'action', v_action,
    'workDate', v_work_date,
    'issuedAt', p_now,
    'expiresAt', v_expires,
    'generatedToday', v_used + 1,
    'maxPerDay', v_policy.daily_qr_max_per_day);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. The administrator's scan records attendance
--
--    One transaction. Every rule is checked here against the stored code, not against anything
--    the scanner sent: the code is live, today's, unexpired, unused, for the action the engine
--    would take now, and its owner is still active. Nothing about the scanner's location or
--    network is considered. The attendance goes through the same engine core as a self check-in,
--    marked ADMIN_QR, with the EMPLOYEE's verification as the evidence.
-- -----------------------------------------------------------------------------
create function private.daily_qr_record(
  p_token   uuid,
  p_scanner uuid,
  p_info    jsonb,
  p_ip      inet,
  p_request text,
  p_now     timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_office public.office_locations;
  v_tok public.attendance_qr_tokens;
  v_profile public.profiles;
  v_state jsonb;
  v_rec public.attendance_records;
  v_event bigint;
  v_scan uuid;
  v_meta jsonb;
begin
  perform private.assert_scanner(p_scanner);
  v_office := private.require_office();

  select * into v_tok from public.attendance_qr_tokens where id = p_token for update;
  if not found then
    raise exception using errcode = 'TG001', message = 'EMPLOYEE_QR_INVALID';
  end if;
  if v_tok.employee_id = p_scanner then
    raise exception using errcode = 'TG001', message = 'SELF_SCAN_FORBIDDEN';
  end if;
  if v_tok.status = 'USED' then
    raise exception using errcode = 'TG001', message = 'QR_ALREADY_USED';
  end if;
  if v_tok.status = 'SUPERSEDED' then
    raise exception using errcode = 'TG001', message = 'QR_SUPERSEDED';
  end if;
  if v_tok.expires_at <= p_now or v_tok.work_date <> private.local_date(p_now, v_office.timezone) then
    raise exception using errcode = 'TG001', message = 'QR_EXPIRED';
  end if;

  select * into v_profile from public.profiles where id = v_tok.employee_id for share;
  if not v_profile.is_active then
    raise exception using errcode = 'TG001', message = 'EMPLOYEE_INACTIVE';
  end if;
  if not v_profile.attendance_required then
    raise exception using errcode = 'TG001', message = 'ATTENDANCE_NOT_TRACKED';
  end if;

  -- The code was made for one action. If the day has moved on (another scan, a correction),
  -- it is no longer the right one.
  v_state := private.qr_attendance_state(v_tok.employee_id, p_now);
  if v_state ->> 'blockedReason' is not null then
    raise exception using errcode = 'TG001', message = v_state ->> 'blockedReason';
  end if;
  if v_state ->> 'action' = 'ALREADY_CHECKED_OUT' then
    raise exception using errcode = 'TG001', message = 'ALREADY_CHECKED_OUT';
  end if;
  if v_state ->> 'action' is distinct from v_tok.action then
    raise exception using errcode = 'TG001', message = 'SCAN_ACTION_MISMATCH';
  end if;

  v_meta := jsonb_build_object('daily_qr_id', v_tok.id, 'scanned_by', p_scanner);
  if v_tok.action = 'CHECK_IN' then
    v_rec := private.record_check_in(
      v_tok.employee_id, p_now, 'ADMIN_QR', p_scanner, v_tok.verification_id, null, v_meta);
  else
    v_rec := private.record_check_out(
      v_tok.employee_id, p_now, 'ADMIN_QR', p_scanner, v_tok.verification_id, null, v_meta);
  end if;

  select e.id into v_event
  from public.attendance_events e
  where e.attendance_record_id = v_rec.id
    and e.employee_id = v_tok.employee_id
    and e.event_type = v_tok.action::public.event_type
  order by e.id desc
  limit 1;

  update public.attendance_qr_tokens
  set status = 'USED', used_at = p_now, used_by = p_scanner
  where id = v_tok.id;

  insert into public.qr_scan_logs
    (scanned_by, employee_id, daily_qr_id, token_hash, qr_result, detected_action, status,
     scanned_at, scanner, client_ip, request_id, confirmed_at, confirmed_action,
     attendance_event_id, attendance_record_id)
  values
    (p_scanner, v_tok.employee_id, v_tok.id, v_tok.token_hash, 'VALID', v_tok.action, 'RECORDED',
     p_now, coalesce(p_info, '{}'::jsonb), p_ip, p_request, p_now, v_tok.action,
     v_event, v_rec.id)
  returning id into v_scan;

  return jsonb_build_object(
    'scanId', v_scan,
    'eventId', v_event,
    'recordId', v_rec.id,
    'action', v_tok.action,
    'at', p_now);
end;
$$;

-- Standard lockdown block: client roles may execute only the RLS helper functions.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_role_name() to authenticated, service_role;
grant execute on function private.is_admin() to authenticated, service_role;
grant execute on function private.is_active_user() to authenticated, service_role;
