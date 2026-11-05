-- =============================================================================
-- 0002 Core tables: identity, office configuration, devices, policy, calendar
-- =============================================================================

-- -----------------------------------------------------------------------------
-- roles
-- -----------------------------------------------------------------------------
create table public.roles (
  id          smallint generated always as identity primary key,
  name        text        not null unique check (name = lower(name)),
  description text        not null default '',
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- departments (normalised reference data for filtering / reporting)
-- -----------------------------------------------------------------------------
create table public.departments (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null check (length(btrim(name)) between 1 and 100),
  is_active  boolean     not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index departments_name_key on public.departments (lower(name));
create trigger departments_set_updated_at
  before update on public.departments
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- profiles: one row per Supabase auth user. Never hard-deleted (history depends on it).
-- -----------------------------------------------------------------------------
create table public.profiles (
  id                  uuid        primary key references auth.users (id) on delete restrict,
  employee_code       text        not null
                      check (employee_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  full_name           text        not null check (length(btrim(full_name)) between 1 and 150),
  email               text        not null check (email = lower(email) and position('@' in email) > 1),
  phone               text        check (phone is null or length(phone) <= 32),
  department_id       uuid        references public.departments (id) on delete restrict,
  designation         text        check (designation is null or length(designation) <= 100),
  joining_date        date        not null,
  avatar_url          text        check (avatar_url is null or (avatar_url ~ '^https://' and length(avatar_url) <= 2048)),
  role_id             smallint    not null references public.roles (id) on delete restrict,
  -- false for accounts that never mark attendance (e.g. the lobby QR display, HR-only admins)
  attendance_required boolean     not null default true,
  is_active           boolean     not null default true,
  deactivated_at      timestamptz,
  deactivated_by      uuid        references public.profiles (id) on delete restrict,
  created_by          uuid        references public.profiles (id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint profiles_deactivation_consistent check (
    (is_active and deactivated_at is null) or (not is_active and deactivated_at is not null)
  )
);
create unique index profiles_employee_code_key on public.profiles (lower(employee_code));
create unique index profiles_email_key on public.profiles (email);
create index profiles_department_idx on public.profiles (department_id);
create index profiles_role_idx on public.profiles (role_id);
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- office_locations: coordinates are supplied by the company administrator.
-- There is deliberately NO seed row and no default coordinates.
-- -----------------------------------------------------------------------------
create table public.office_locations (
  id                  uuid         primary key default gen_random_uuid(),
  name                text         not null check (length(btrim(name)) between 1 and 150),
  address             text         not null default '' check (length(address) <= 500),
  latitude            numeric(9,6) not null check (latitude  between  -90 and  90),
  longitude           numeric(9,6) not null check (longitude between -180 and 180),
  geofence_radius_m   integer      not null default 100  check (geofence_radius_m   between 10 and 5000),
  -- A fix whose reported accuracy is worse than this is rejected outright.
  max_gps_accuracy_m  integer      not null default 50   check (max_gps_accuracy_m  between 5 and 500),
  -- A fix older than this (server time - fix time) is rejected as stale.
  max_fix_age_seconds integer      not null default 30   check (max_fix_age_seconds between 5 and 300),
  qr_rotation_seconds integer      not null default 30   check (qr_rotation_seconds between 30 and 60),
  timezone            text         not null default 'Asia/Kolkata' check (private.is_valid_timezone(timezone)),
  -- ISO weekday numbers, 1 = Monday ... 7 = Sunday. Days not listed are weekly offs.
  working_days        smallint[]   not null default '{1,2,3,4,5,6}'
                      check (working_days <@ '{1,2,3,4,5,6,7}'::smallint[] and cardinality(working_days) >= 1),
  is_active           boolean      not null default true,
  created_at          timestamptz  not null default now(),
  updated_at          timestamptz  not null default now()
);
-- v1 supports exactly one active office.
create unique index office_locations_single_active on public.office_locations ((true)) where is_active;
create trigger office_locations_set_updated_at
  before update on public.office_locations
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- office_networks: allowlist of public IPs / CIDR ranges, managed by admins.
-- -----------------------------------------------------------------------------
create table public.office_networks (
  id         uuid        primary key default gen_random_uuid(),
  office_id  uuid        not null references public.office_locations (id) on delete cascade,
  label      text        not null check (length(btrim(label)) between 1 and 100),
  cidr       cidr        not null,
  is_active  boolean     not null default true,
  created_by uuid        references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Guard against allowing (nearly) the whole internet by accident.
  constraint office_networks_not_too_broad check (
    (family(cidr) = 4 and masklen(cidr) >= 16) or (family(cidr) = 6 and masklen(cidr) >= 48)
  ),
  unique (office_id, cidr)
);
create trigger office_networks_set_updated_at
  before update on public.office_networks
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- registered_devices
-- -----------------------------------------------------------------------------
create table public.registered_devices (
  id                      uuid                   primary key default gen_random_uuid(),
  employee_id             uuid                   not null references public.profiles (id) on delete restrict,
  -- Client-generated random id kept in SecureStore / platform key store. NOT a trusted identity
  -- on its own: trust comes from the attestation / public key below.
  device_identifier       text                   not null check (length(device_identifier) between 8 and 200),
  platform                public.device_platform not null,
  device_name             text                   check (device_name is null or length(device_name) <= 100),
  status                  public.device_status   not null default 'PENDING',
  -- Device-bound public key (native key store key, or WebAuthn credential public key).
  public_key              text,
  credential_id           text,
  attestation_provider    text                   check (attestation_provider in ('PLAY_INTEGRITY', 'APP_ATTEST', 'WEBAUTHN', 'NONE')),
  attestation_verified_at timestamptz,
  -- Monotonic counter (WebAuthn signCount / App Attest counter) to detect cloned authenticators.
  attestation_counter     bigint,
  registered_at           timestamptz            not null default now(),
  approved_by             uuid                   references public.profiles (id) on delete restrict,
  approved_at             timestamptz,
  last_seen_at            timestamptz,
  revoked_at              timestamptz,
  revoked_by              uuid                   references public.profiles (id) on delete restrict,
  revoked_reason          text                   check (revoked_reason is null or length(revoked_reason) <= 500),
  created_at              timestamptz            not null default now(),
  updated_at              timestamptz            not null default now(),
  constraint registered_devices_revoked_consistent check ((status = 'REVOKED') = (revoked_at is not null)),
  constraint registered_devices_active_needs_approval check (status <> 'ACTIVE' or approved_at is not null)
);
-- A physical device can be live for only one employee at a time (prevents buddy punching).
create unique index registered_devices_live_identifier_key
  on public.registered_devices (device_identifier) where status <> 'REVOKED';
create index registered_devices_employee_idx on public.registered_devices (employee_id, status);
create trigger registered_devices_set_updated_at
  before update on public.registered_devices
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- attendance_policies: versioned by effective date. The row in force for a date is the one
-- with the greatest effective_from <= that date.
--
-- Defaults below are the initial TeachGrow rules supplied with the project brief
-- (10:00 start, 19:00 close, 10:20 late threshold, 60 min lunch). Half-day, overtime and
-- early-checkout thresholds were NOT specified, so those rules ship DISABLED and must be
-- configured by an administrator. No payroll deduction or penalty is computed anywhere.
-- -----------------------------------------------------------------------------
create table public.attendance_policies (
  id                       uuid        primary key default gen_random_uuid(),
  effective_from           date        not null unique,
  office_start             time        not null default '10:00',
  office_end               time        not null default '19:00',
  late_threshold           time        not null default '10:20',

  lunch_allowance_minutes  integer     not null default 60 check (lunch_allowance_minutes between 0 and 240),
  -- NULL = unlimited
  max_short_breaks_per_day integer     check (max_short_breaks_per_day is null or max_short_breaks_per_day >= 0),
  max_short_break_minutes  integer     check (max_short_break_minutes is null or max_short_break_minutes between 1 and 240),

  -- Half-day: net worked time below the threshold. Independent of lateness.
  half_day_enabled             boolean not null default false,
  half_day_below_net_minutes   integer check (half_day_below_net_minutes between 1 and 1440),
  -- Overtime: net minutes beyond the threshold.
  overtime_enabled             boolean not null default false,
  overtime_after_net_minutes   integer check (overtime_after_net_minutes between 1 and 1440),
  -- Early checkout: checking out earlier than (early_checkout_before - grace) on the work date.
  early_checkout_enabled       boolean not null default false,
  early_checkout_before        time,
  early_checkout_grace_minutes integer not null default 0 check (early_checkout_grace_minutes between 0 and 240),

  -- Which verification layers are mandatory per channel. GPS and NETWORK can never be removed
  -- for check-in; QR and DEVICE are configurable (see D1/D2 in the implementation plan).
  check_in_layers_web      public.verification_layer[] not null
                           default array['GPS', 'NETWORK', 'QR', 'DEVICE']::public.verification_layer[],
  check_in_layers_mobile   public.verification_layer[] not null
                           default array['GPS', 'NETWORK', 'QR', 'DEVICE']::public.verification_layer[],
  check_out_layers         public.verification_layer[] not null
                           default array['GPS', 'NETWORK']::public.verification_layer[],
  -- How long a successful verification may be used to check in / out.
  verification_ttl_seconds integer     not null default 120 check (verification_ttl_seconds between 30 and 600),

  missing_checkout_notify_after_minutes integer not null default 30
                           check (missing_checkout_notify_after_minutes between 0 and 720),
  notes                    text        check (notes is null or length(notes) <= 1000),
  created_by               uuid        references public.profiles (id) on delete restrict,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint attendance_policies_hours_order check (office_end > office_start),
  constraint attendance_policies_late_within_day check (late_threshold >= office_start and late_threshold < office_end),
  constraint attendance_policies_half_day_complete check (not half_day_enabled or half_day_below_net_minutes is not null),
  constraint attendance_policies_overtime_complete check (not overtime_enabled or overtime_after_net_minutes is not null),
  constraint attendance_policies_early_complete check (not early_checkout_enabled or early_checkout_before is not null),
  constraint attendance_policies_check_in_web_core check (
    check_in_layers_web @> array['GPS', 'NETWORK']::public.verification_layer[]
  ),
  constraint attendance_policies_check_in_mobile_core check (
    check_in_layers_mobile @> array['GPS', 'NETWORK']::public.verification_layer[]
  ),
  constraint attendance_policies_check_out_nonempty check (cardinality(check_out_layers) >= 1)
);
create trigger attendance_policies_set_updated_at
  before update on public.attendance_policies
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- holidays
-- -----------------------------------------------------------------------------
create table public.holidays (
  id           uuid        primary key default gen_random_uuid(),
  holiday_date date        not null unique,
  name         text        not null check (length(btrim(name)) between 1 and 150),
  created_by   uuid        references public.profiles (id) on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger holidays_set_updated_at
  before update on public.holidays
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- leave_records: minimal, administrator-entered APPROVED leave. Not a request workflow.
-- -----------------------------------------------------------------------------
create table public.leave_records (
  id           uuid        primary key default gen_random_uuid(),
  employee_id  uuid        not null references public.profiles (id) on delete restrict,
  start_date   date        not null,
  end_date     date        not null,
  leave_type   text        not null default 'LEAVE' check (length(btrim(leave_type)) between 1 and 50),
  reason       text        check (reason is null or length(reason) <= 500),
  approved_by  uuid        not null references public.profiles (id) on delete restrict,
  cancelled_at timestamptz,
  cancelled_by uuid        references public.profiles (id) on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint leave_records_dates_ordered check (end_date >= start_date and end_date - start_date <= 366),
  constraint leave_records_cancel_consistent check ((cancelled_at is null) = (cancelled_by is null)),
  constraint leave_records_no_overlap exclude using gist (
    employee_id with =,
    daterange(start_date, end_date, '[]') with &&
  ) where (cancelled_at is null)
);
create index leave_records_employee_idx on public.leave_records (employee_id, start_date);
create trigger leave_records_set_updated_at
  before update on public.leave_records
  for each row execute function private.set_updated_at();
