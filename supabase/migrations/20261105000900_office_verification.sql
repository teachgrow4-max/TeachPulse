-- =============================================================================
-- 0009 Office verification: QR outcomes, device challenges, device cap
-- =============================================================================

-- -----------------------------------------------------------------------------
-- QR scan outcomes. A scan is only CONSUMED (ACCEPTED) when the whole verification succeeds.
-- If the code was genuine but the verification failed for another reason (say, a weak GPS fix),
-- the scan is recorded as VALID and the employee may use the same code again within its window.
-- The single-use guarantee is unchanged: at most one ACCEPTED scan per employee per token.
-- -----------------------------------------------------------------------------
alter table public.qr_scan_events drop constraint qr_scan_events_outcome_check;
alter table public.qr_scan_events
  add constraint qr_scan_events_outcome_check
  check (outcome in ('ACCEPTED', 'VALID', 'EXPIRED', 'UNKNOWN', 'REPLAYED'));

-- -----------------------------------------------------------------------------
-- How many devices (pending + active) one employee may hold.
-- -----------------------------------------------------------------------------
alter table public.attendance_policies
  add column max_devices_per_employee integer not null default 2
  check (max_devices_per_employee between 1 and 10);

-- A WebAuthn credential belongs to at most one live device.
create unique index registered_devices_live_credential_key
  on public.registered_devices (credential_id)
  where credential_id is not null and status <> 'REVOKED';

-- -----------------------------------------------------------------------------
-- device_challenges: one-time random challenges a device signs to prove it is present.
--   REGISTER            -> enrolling a new device (no device yet; the platform is known)
--   CHECK_IN / CHECK_OUT -> proving an existing device during a verification
-- Single use, short lived, readable only by the API.
-- -----------------------------------------------------------------------------
create table public.device_challenges (
  id          uuid                   primary key default gen_random_uuid(),
  user_id     uuid                   not null references public.profiles (id) on delete restrict,
  purpose     text                   not null check (purpose in ('REGISTER', 'CHECK_IN', 'CHECK_OUT')),
  device_id   uuid                   references public.registered_devices (id) on delete restrict,
  platform    public.device_platform,
  challenge   bytea                  not null check (octet_length(challenge) = 32),
  expires_at  timestamptz            not null,
  consumed_at timestamptz,
  created_at  timestamptz            not null default now(),
  constraint device_challenges_shape check (
    (purpose = 'REGISTER' and device_id is null and platform is not null)
    or (purpose <> 'REGISTER' and device_id is not null and platform is null)
  )
);
create index device_challenges_user_idx on public.device_challenges (user_id, purpose, created_at desc);
create index device_challenges_expiry_idx on public.device_challenges (expires_at);

alter table public.device_challenges enable row level security;
revoke all on public.device_challenges from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Retention: also purge spent / expired challenges.
-- -----------------------------------------------------------------------------
create or replace function private.apply_retention(
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
  v_challenges integer;
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

  delete from public.device_challenges
  where expires_at < p_now - interval '1 day';
  get diagnostics v_challenges = row_count;

  return jsonb_build_object(
    'coordinates_purged', v_coords,
    'qr_scan_events_deleted', v_scans,
    'qr_tokens_deleted', v_tokens,
    'idempotency_keys_deleted', v_keys,
    'device_challenges_deleted', v_challenges);
end;
$$;

-- Standard lockdown block: client roles may execute only the RLS helper functions.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_role_name() to authenticated, service_role;
grant execute on function private.is_admin() to authenticated, service_role;
grant execute on function private.is_active_user() to authenticated, service_role;
