-- =============================================================================
-- 0001 Foundation: extensions, schemas, default privileges, enums, shared helpers
-- =============================================================================
-- Security model in one paragraph:
--   * Clients (anon / authenticated JWTs) get SELECT-only access, filtered by RLS.
--   * All attendance WRITES happen through functions in the `private` schema, which is
--     not exposed through the Data API and is executable only by the API's DB role.
--   * Nothing here is granted to `anon` at all.
-- =============================================================================

create extension if not exists btree_gist with schema extensions;

create schema if not exists private;
comment on schema private is
  'Internal functions (business rules, RLS helpers). Not exposed through the Data API.';

-- Lock the schema down; RLS helper functions are granted back individually later.
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- New objects created by migrations must NOT be reachable by client roles unless a
-- migration grants it explicitly. (Supabase otherwise grants ALL to anon/authenticated.)
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Enums (mirrored in packages/shared/src/enums.ts; contract tests enforce parity)
-- -----------------------------------------------------------------------------
create type public.attendance_status as enum
  ('PRESENT', 'LATE', 'ABSENT', 'INCOMPLETE', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY');

create type public.live_state as enum
  ('NONE', 'WORKING', 'ON_LUNCH', 'ON_SHORT_BREAK', 'CHECKED_OUT');

create type public.event_type as enum
  ('CHECK_IN', 'CHECK_OUT', 'BREAK_START', 'BREAK_END', 'CORRECTION_APPLIED', 'DAY_FINALIZED');

create type public.break_type as enum ('LUNCH', 'SHORT');

create type public.break_end_reason as enum ('USER', 'CHECKOUT_EXCEPTION', 'DAY_FINALIZED');

create type public.verification_layer as enum ('GPS', 'NETWORK', 'QR', 'DEVICE');

create type public.verification_layer_result as enum ('PASS', 'FAIL', 'NOT_REQUIRED', 'NOT_EVALUATED');

create type public.verification_result as enum ('VERIFIED', 'REJECTED');

create type public.verification_purpose as enum ('CHECK_IN', 'CHECK_OUT');

create type public.client_channel as enum ('WEB', 'MOBILE');

create type public.device_platform as enum ('ANDROID', 'IOS', 'WEB');

create type public.device_status as enum ('PENDING', 'ACTIVE', 'REVOKED');

create type public.correction_status as enum ('PENDING', 'APPROVED', 'REJECTED');

create type public.correction_source as enum ('EMPLOYEE_REQUEST', 'ADMIN_INITIATED');

-- -----------------------------------------------------------------------------
-- Shared trigger helpers
-- -----------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Used on append-only tables: any UPDATE / DELETE / TRUNCATE is refused (SQLSTATE TG002).
create function private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% on % is not allowed: the table is append-only', tg_op, tg_table_name
    using errcode = 'TG002';
end;
$$;

-- True when `tz` is a timezone name Postgres understands (used by CHECK constraints).
create function private.is_valid_timezone(tz text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  perform now() at time zone tz;
  return true;
exception when others then
  return false;
end;
$$;
