-- =============================================================================
-- 0003 Attendance tables: QR, verification, records, events, breaks, corrections,
--      audit, notifications, idempotency
-- =============================================================================

-- -----------------------------------------------------------------------------
-- qr_tokens
-- The secret token is derived by the API (HMAC over office + time window) and is never
-- stored in clear: only its SHA-256 is kept, to give each rotation window an identity that
-- scans can be attributed to. Rows are created lazily and purged by private.apply_retention().
-- -----------------------------------------------------------------------------
create table public.qr_tokens (
  id           uuid        primary key default gen_random_uuid(),
  office_id    uuid        not null references public.office_locations (id) on delete cascade,
  token_hash   bytea       not null unique check (octet_length(token_hash) = 32),
  valid_from   timestamptz not null,
  expires_at   timestamptz not null,
  -- expires_at + a short grace so a scan started just before rotation still succeeds
  accept_until timestamptz not null,
  created_at   timestamptz not null default now(),
  constraint qr_tokens_window_ordered check (expires_at > valid_from and accept_until >= expires_at)
);
create index qr_tokens_office_window_idx on public.qr_tokens (office_id, valid_from desc);
create index qr_tokens_accept_until_idx on public.qr_tokens (accept_until);

-- -----------------------------------------------------------------------------
-- attendance_verifications: one row per verification attempt, pass or fail.
-- -----------------------------------------------------------------------------
create table public.attendance_verifications (
  id                  uuid                              primary key default gen_random_uuid(),
  employee_id         uuid                              not null references public.profiles (id) on delete restrict,
  purpose             public.verification_purpose       not null,
  channel             public.client_channel             not null,
  device_id           uuid                              references public.registered_devices (id) on delete restrict,

  gps_result          public.verification_layer_result  not null,
  network_result      public.verification_layer_result  not null,
  qr_result           public.verification_layer_result  not null,
  device_result       public.verification_layer_result  not null,
  final_result        public.verification_result       not null,
  -- Stable machine codes explaining each failed layer, e.g. {GPS_OUTSIDE_RADIUS, QR_EXPIRED}
  failure_reasons     text[]                            not null default '{}',

  distance_m          numeric(10,2)                     check (distance_m is null or distance_m >= 0),
  gps_accuracy_m      numeric(8,2)                      check (gps_accuracy_m is null or gps_accuracy_m >= 0),
  -- Raw fix. Nulled by the retention job (coordinates_purged_at records when). Verdict + distance stay.
  latitude            numeric(9,6)                      check (latitude  is null or latitude  between  -90 and  90),
  longitude           numeric(9,6)                      check (longitude is null or longitude between -180 and 180),
  fix_time            timestamptz,
  location_mocked     boolean,
  client_ip           inet,
  matched_network_id  uuid                              references public.office_networks (id) on delete set null,
  qr_token_id         uuid                              references public.qr_tokens (id) on delete set null,

  requested_at        timestamptz                       not null default now(),
  -- A VERIFIED row may be used to check in/out until this instant, exactly once.
  expires_at          timestamptz,
  consumed_at         timestamptz,
  coordinates_purged_at timestamptz,
  created_at          timestamptz                       not null default now(),

  -- The database refuses to record VERIFIED unless every layer actually passed or was
  -- explicitly not required: the centralised engine cannot be bypassed by a bad insert.
  constraint verifications_verified_means_no_failed_layer check (
    final_result <> 'VERIFIED' or (
      gps_result     in ('PASS', 'NOT_REQUIRED') and
      network_result in ('PASS', 'NOT_REQUIRED') and
      qr_result      in ('PASS', 'NOT_REQUIRED') and
      device_result  in ('PASS', 'NOT_REQUIRED')
    )
  ),
  -- Location and network proof can never be waived for check-in.
  constraint verifications_check_in_needs_gps_and_network check (
    purpose <> 'CHECK_IN' or final_result <> 'VERIFIED' or (gps_result = 'PASS' and network_result = 'PASS')
  ),
  constraint verifications_verified_has_expiry check (final_result <> 'VERIFIED' or expires_at is not null),
  constraint verifications_consumed_only_if_verified check (consumed_at is null or final_result = 'VERIFIED')
);
create index verifications_employee_idx on public.attendance_verifications (employee_id, requested_at desc);
create index verifications_requested_at_idx on public.attendance_verifications (requested_at);
create index verifications_rejected_idx on public.attendance_verifications (requested_at desc)
  where final_result = 'REJECTED';

-- Verification rows are evidence. Only the one-time consumption stamp and the privacy
-- redaction of raw coordinates may ever change, and FK SET NULLs on config deletion.
create function private.verifications_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  mutable_columns constant text[] := array[
    'consumed_at', 'latitude', 'longitude', 'coordinates_purged_at', 'qr_token_id', 'matched_network_id'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on attendance_verifications is not allowed' using errcode = 'TG002';
  end if;
  if (to_jsonb(new) - mutable_columns) is distinct from (to_jsonb(old) - mutable_columns) then
    raise exception 'attendance_verifications rows are immutable' using errcode = 'TG002';
  end if;
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception 'a verification can only be consumed once' using errcode = 'TG002';
  end if;
  return new;
end;
$$;
create trigger verifications_guard
  before update or delete on public.attendance_verifications
  for each row execute function private.verifications_guard();

-- -----------------------------------------------------------------------------
-- qr_scan_events: every QR scan attempt. A given token may be ACCEPTED only once per employee.
-- -----------------------------------------------------------------------------
create table public.qr_scan_events (
  id              bigint generated always as identity primary key,
  qr_token_id     uuid        references public.qr_tokens (id) on delete set null,
  employee_id     uuid        not null references public.profiles (id) on delete restrict,
  device_id       uuid        references public.registered_devices (id) on delete restrict,
  verification_id uuid        references public.attendance_verifications (id) on delete restrict,
  outcome         text        not null check (outcome in ('ACCEPTED', 'EXPIRED', 'UNKNOWN', 'REPLAYED')),
  client_ip       inet,
  scanned_at      timestamptz not null default now()
);
create unique index qr_scan_events_one_accept_per_employee
  on public.qr_scan_events (qr_token_id, employee_id) where outcome = 'ACCEPTED';
create index qr_scan_events_employee_idx on public.qr_scan_events (employee_id, scanned_at desc);
create index qr_scan_events_scanned_at_idx on public.qr_scan_events (scanned_at);

-- -----------------------------------------------------------------------------
-- attendance_records: one row per employee per work date (a derived summary of the events).
-- -----------------------------------------------------------------------------
create table public.attendance_records (
  id                        uuid                     primary key default gen_random_uuid(),
  employee_id               uuid                     not null references public.profiles (id) on delete restrict,
  work_date                 date                     not null,
  status                    public.attendance_status not null,
  live_state                public.live_state        not null default 'NONE',

  check_in_at               timestamptz,
  check_out_at              timestamptz,
  -- Independent flags: a day can be LATE and half-day at once.
  is_late                   boolean                  not null default false,
  is_half_day               boolean                  not null default false,
  is_early_checkout         boolean                  not null default false,
  overtime_minutes          integer                  not null default 0 check (overtime_minutes >= 0),
  total_break_seconds       integer                  not null default 0 check (total_break_seconds >= 0),
  -- Set at checkout / correction. For an open day the API computes it live from server time.
  net_work_seconds          integer                  check (net_work_seconds is null or net_work_seconds >= 0),

  check_in_verification_id  uuid                     references public.attendance_verifications (id) on delete restrict,
  check_out_verification_id uuid                     references public.attendance_verifications (id) on delete restrict,
  check_in_device_id        uuid                     references public.registered_devices (id) on delete restrict,
  policy_id                 uuid                     references public.attendance_policies (id) on delete restrict,
  -- Policy values in force when the day was classified, so later policy edits never
  -- retroactively reclassify closed days.
  policy_snapshot           jsonb,

  has_correction            boolean                  not null default false,
  is_finalized              boolean                  not null default false,
  finalized_at              timestamptz,

  created_at                timestamptz              not null default now(),
  updated_at                timestamptz              not null default now(),

  unique (employee_id, work_date),

  constraint records_checkout_needs_checkin check (check_out_at is null or check_in_at is not null),
  constraint records_checkout_after_checkin check (check_out_at is null or check_out_at >= check_in_at),
  constraint records_net_needs_checkout check (net_work_seconds is null or check_out_at is not null),
  constraint records_late_matches_status check (
    (status <> 'LATE' or is_late) and (status <> 'PRESENT' or not is_late)
  ),
  constraint records_attendance_status_needs_checkin check (
    status not in ('PRESENT', 'LATE', 'INCOMPLETE') or check_in_at is not null
  ),
  constraint records_non_attendance_status_has_no_checkin check (
    status not in ('ABSENT', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY') or check_in_at is null
  ),
  constraint records_incomplete_has_no_checkout check (status <> 'INCOMPLETE' or check_out_at is null),
  constraint records_checked_out_state check (live_state <> 'CHECKED_OUT' or check_out_at is not null),
  constraint records_working_state check (
    live_state in ('NONE', 'CHECKED_OUT') or (check_in_at is not null and check_out_at is null)
  ),
  constraint records_finalized_consistent check (not is_finalized or finalized_at is not null)
);
create index attendance_records_work_date_idx on public.attendance_records (work_date, status);
create index attendance_records_live_idx on public.attendance_records (work_date, live_state);
-- Fast lookup of "the day I am currently checked in on".
create index attendance_records_open_idx on public.attendance_records (employee_id, work_date desc)
  where check_in_at is not null and check_out_at is null and not is_finalized;
create trigger attendance_records_set_updated_at
  before update on public.attendance_records
  for each row execute function private.set_updated_at();

-- Attendance history is never deleted. Mistakes are fixed through the correction workflow.
create function private.reject_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'DELETE on % is not allowed', tg_table_name using errcode = 'TG002';
end;
$$;
create trigger attendance_records_no_delete
  before delete on public.attendance_records
  for each row execute function private.reject_delete();

-- -----------------------------------------------------------------------------
-- attendance_events: append-only ledger. Original facts are never overwritten.
-- -----------------------------------------------------------------------------
create table public.attendance_events (
  id                   bigint generated always as identity primary key,
  attendance_record_id uuid                not null references public.attendance_records (id) on delete restrict,
  employee_id          uuid                not null references public.profiles (id) on delete restrict,
  event_type           public.event_type   not null,
  occurred_at          timestamptz         not null default now(),
  source               text                not null default 'EMPLOYEE' check (source in ('EMPLOYEE', 'ADMIN', 'SYSTEM')),
  actor_id             uuid                references public.profiles (id) on delete restrict,
  verification_id      uuid                references public.attendance_verifications (id) on delete restrict,
  device_id            uuid                references public.registered_devices (id) on delete restrict,
  metadata             jsonb               not null default '{}'::jsonb,
  created_at           timestamptz         not null default now()
);
create index attendance_events_record_idx on public.attendance_events (attendance_record_id, occurred_at, id);
create index attendance_events_employee_idx on public.attendance_events (employee_id, occurred_at desc);
create index attendance_events_type_idx on public.attendance_events (event_type, occurred_at desc);
create index attendance_events_verification_idx on public.attendance_events (verification_id)
  where verification_id is not null;
create trigger attendance_events_append_only
  before update or delete on public.attendance_events
  for each row execute function private.reject_mutation();
create trigger attendance_events_no_truncate
  before truncate on public.attendance_events
  for each statement execute function private.reject_mutation();

-- -----------------------------------------------------------------------------
-- break_records
-- -----------------------------------------------------------------------------
create table public.break_records (
  id                   uuid                    primary key default gen_random_uuid(),
  attendance_record_id uuid                    not null references public.attendance_records (id) on delete restrict,
  employee_id          uuid                    not null references public.profiles (id) on delete restrict,
  break_type           public.break_type       not null,
  started_at           timestamptz             not null default now(),
  ended_at             timestamptz,
  end_reason           public.break_end_reason,
  duration_seconds     integer generated always as (
                         case when ended_at is null then null
                              else extract(epoch from (ended_at - started_at))::integer end
                       ) stored,
  start_event_id       bigint                  references public.attendance_events (id) on delete restrict,
  end_event_id         bigint                  references public.attendance_events (id) on delete restrict,
  created_at           timestamptz             not null default now(),
  updated_at           timestamptz             not null default now(),
  -- ended_at may equal started_at: a break force-closed at day finalization has zero length.
  constraint break_records_time_ordered check (ended_at is null or ended_at >= started_at),
  constraint break_records_end_reason_consistent check ((ended_at is null) = (end_reason is null)),
  -- Overlapping breaks are impossible at the storage level, not just in application code.
  constraint break_records_no_overlap exclude using gist (
    attendance_record_id with =,
    tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz)) with &&
  )
);
create unique index break_records_one_active_per_day
  on public.break_records (attendance_record_id) where ended_at is null;
create index break_records_employee_idx on public.break_records (employee_id, started_at desc);
create trigger break_records_set_updated_at
  before update on public.break_records
  for each row execute function private.set_updated_at();
create trigger break_records_no_delete
  before delete on public.break_records
  for each row execute function private.reject_delete();

-- -----------------------------------------------------------------------------
-- attendance_corrections: the only way to change recorded attendance.
-- -----------------------------------------------------------------------------
create table public.attendance_corrections (
  id                   uuid                       primary key default gen_random_uuid(),
  employee_id          uuid                       not null references public.profiles (id) on delete restrict,
  attendance_record_id uuid                       references public.attendance_records (id) on delete restrict,
  work_date            date                       not null,
  source               public.correction_source   not null,
  status               public.correction_status   not null default 'PENDING',
  -- Snapshot of the day's record BEFORE the change ('{}' when no record existed).
  original             jsonb                      not null,
  -- Only these keys are allowed: check_in_at, check_out_at, status, total_break_seconds, is_half_day.
  proposed             jsonb                      not null,
  reason               text                       not null,
  requested_by         uuid                       not null references public.profiles (id) on delete restrict,
  requested_at         timestamptz                not null default now(),
  decided_by           uuid                       references public.profiles (id) on delete restrict,
  decided_at           timestamptz,
  decision_note        text                       check (decision_note is null or length(decision_note) <= 1000),
  applied_at           timestamptz,
  constraint corrections_reason_meaningful check (length(btrim(reason)) between 5 and 1000),
  constraint corrections_json_objects check (jsonb_typeof(original) = 'object' and jsonb_typeof(proposed) = 'object'),
  constraint corrections_proposed_keys check (
    proposed <> '{}'::jsonb and
    (proposed - array['check_in_at', 'check_out_at', 'status', 'total_break_seconds', 'is_half_day']) = '{}'::jsonb
  ),
  constraint corrections_decision_consistent check (
    (status = 'PENDING') = (decided_by is null and decided_at is null)
  ),
  constraint corrections_approved_is_applied check (status <> 'APPROVED' or applied_at is not null),
  constraint corrections_no_self_approval check (decided_by is null or decided_by <> employee_id)
);
create index corrections_employee_idx on public.attendance_corrections (employee_id, work_date desc);
create index corrections_pending_idx on public.attendance_corrections (requested_at) where status = 'PENDING';

-- Once written, a correction's content never changes; only its decision fields move, and only once.
create function private.corrections_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  decision_columns constant text[] := array[
    'status', 'decided_by', 'decided_at', 'decision_note', 'applied_at', 'attendance_record_id'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on attendance_corrections is not allowed' using errcode = 'TG002';
  end if;
  if (to_jsonb(new) - decision_columns) is distinct from (to_jsonb(old) - decision_columns) then
    raise exception 'attendance_corrections content is immutable' using errcode = 'TG002';
  end if;
  if old.status <> 'PENDING' then
    raise exception 'a decided correction cannot be changed' using errcode = 'TG002';
  end if;
  return new;
end;
$$;
create trigger corrections_guard
  before update or delete on public.attendance_corrections
  for each row execute function private.corrections_guard();

-- -----------------------------------------------------------------------------
-- checkout_exceptions: admin-authorised permission to check out while a break is open.
-- -----------------------------------------------------------------------------
create table public.checkout_exceptions (
  id                   uuid        primary key default gen_random_uuid(),
  attendance_record_id uuid        not null references public.attendance_records (id) on delete restrict,
  employee_id          uuid        not null references public.profiles (id) on delete restrict,
  granted_by           uuid        not null references public.profiles (id) on delete restrict,
  reason               text        not null check (length(btrim(reason)) between 5 and 500),
  granted_at           timestamptz not null default now(),
  used_at              timestamptz,
  constraint checkout_exceptions_not_self check (granted_by <> employee_id)
);
create unique index checkout_exceptions_one_open
  on public.checkout_exceptions (attendance_record_id) where used_at is null;

-- -----------------------------------------------------------------------------
-- audit_logs: append-only record of security- and admin-relevant actions.
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id          bigint      generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid        references public.profiles (id) on delete restrict,
  actor_role  text,
  action      text        not null check (length(action) between 1 and 100),
  entity_type text        check (entity_type is null or length(entity_type) <= 100),
  entity_id   text        check (entity_id is null or length(entity_id) <= 200),
  before_data jsonb,
  after_data  jsonb,
  metadata    jsonb       not null default '{}'::jsonb,
  ip          inet,
  user_agent  text        check (user_agent is null or length(user_agent) <= 512),
  request_id  text        check (request_id is null or length(request_id) <= 64)
);
create index audit_logs_occurred_idx on public.audit_logs (occurred_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, occurred_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_action_idx on public.audit_logs (action, occurred_at desc);
create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function private.reject_mutation();
create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function private.reject_mutation();

-- -----------------------------------------------------------------------------
-- idempotency_keys: stored responses so a retried POST returns the original result.
-- -----------------------------------------------------------------------------
create table public.idempotency_keys (
  employee_id     uuid        not null references public.profiles (id) on delete restrict,
  key             text        not null check (length(key) between 8 and 128),
  endpoint        text        not null,
  request_hash    text        not null,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  primary key (employee_id, key)
);
create index idempotency_keys_created_idx on public.idempotency_keys (created_at);

-- -----------------------------------------------------------------------------
-- push_subscriptions / notifications / announcements
-- -----------------------------------------------------------------------------
create table public.push_subscriptions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references public.profiles (id) on delete restrict,
  device_id    uuid        references public.registered_devices (id) on delete set null,
  channel      text        not null check (channel in ('FCM', 'WEBPUSH')),
  -- FCM registration token, or the Web Push endpoint URL
  token        text        not null check (length(token) between 10 and 4096),
  -- Web Push key material (p256dh / auth); null for FCM
  keys         jsonb,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  unique (channel, token)
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id) where revoked_at is null;

create table public.notifications (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles (id) on delete restrict,
  type       text        not null check (type in (
               'CHECK_IN_SUCCESS', 'CHECK_OUT_SUCCESS', 'VERIFICATION_FAILED',
               'MISSING_CHECKOUT', 'CORRECTION_UPDATE', 'ANNOUNCEMENT')),
  -- Stable identity of the thing being notified about, e.g. 'MISSING_CHECKOUT:2026-11-02'.
  -- UNIQUE (user_id, dedupe_key) is what guarantees no duplicate notifications.
  dedupe_key text        not null check (length(dedupe_key) between 1 and 200),
  title      text        not null check (length(title) between 1 and 200),
  body       text        not null check (length(body) between 1 and 1000),
  data       jsonb       not null default '{}'::jsonb,
  status     text        not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts   integer     not null default 0 check (attempts >= 0),
  last_error text        check (last_error is null or length(last_error) <= 500),
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  read_at    timestamptz,
  unique (user_id, dedupe_key)
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.announcements (
  id           uuid        primary key default gen_random_uuid(),
  title        text        not null check (length(btrim(title)) between 1 and 200),
  body         text        not null check (length(btrim(body)) between 1 and 4000),
  created_by   uuid        not null references public.profiles (id) on delete restrict,
  published_at timestamptz not null default now(),
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint announcements_expiry_after_publish check (expires_at is null or expires_at > published_at)
);
create trigger announcements_set_updated_at
  before update on public.announcements
  for each row execute function private.set_updated_at();
