-- =============================================================================
-- 0004 Row Level Security
-- =============================================================================
-- Design:
--   * RLS is ENABLED on every table in `public`. A table with no policy is deny-all.
--   * Client roles receive SELECT only. There is no INSERT/UPDATE/DELETE grant for them on
--     any table, so a leaked employee JWT cannot forge attendance through the Data API.
--   * The API writes through private.* functions using its own database role.
--   * Employees see only their own rows. Admins see operational data. A few tables
--     (qr_tokens, qr_scan_events, push_subscriptions, idempotency_keys) are not readable
--     by any client role. Verification evidence (GPS, IP) is admin-only on direct access;
--     employees get their own result summary through the API.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Role helpers. SECURITY DEFINER so they can read profiles without recursing into
-- profiles' own RLS policy. search_path is pinned to defeat search_path injection.
-- -----------------------------------------------------------------------------
create function private.current_role_name()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r.name
  from public.profiles p
  join public.roles r on r.id = p.role_id
  where p.id = (select auth.uid())
    and p.is_active
$$;

create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_role_name() = 'admin', false)
$$;

revoke all on function private.current_role_name() from public, anon;
revoke all on function private.is_admin() from public, anon;
grant execute on function private.current_role_name() to authenticated, service_role;
grant execute on function private.is_admin() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere
-- -----------------------------------------------------------------------------
alter table public.roles                    enable row level security;
alter table public.departments              enable row level security;
alter table public.profiles                 enable row level security;
alter table public.office_locations         enable row level security;
alter table public.office_networks          enable row level security;
alter table public.registered_devices       enable row level security;
alter table public.attendance_policies      enable row level security;
alter table public.holidays                 enable row level security;
alter table public.leave_records            enable row level security;
alter table public.qr_tokens                enable row level security;
alter table public.attendance_verifications enable row level security;
alter table public.qr_scan_events           enable row level security;
alter table public.attendance_records       enable row level security;
alter table public.attendance_events        enable row level security;
alter table public.break_records            enable row level security;
alter table public.attendance_corrections   enable row level security;
alter table public.checkout_exceptions      enable row level security;
alter table public.audit_logs               enable row level security;
alter table public.idempotency_keys         enable row level security;
alter table public.push_subscriptions       enable row level security;
alter table public.notifications            enable row level security;
alter table public.announcements            enable row level security;

-- -----------------------------------------------------------------------------
-- Start from zero privileges for client roles, then grant SELECT where intended.
-- -----------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on
  public.roles,
  public.departments,
  public.profiles,
  public.office_locations,
  public.office_networks,
  public.registered_devices,
  public.attendance_policies,
  public.holidays,
  public.leave_records,
  public.attendance_verifications,
  public.attendance_records,
  public.attendance_events,
  public.break_records,
  public.attendance_corrections,
  public.checkout_exceptions,
  public.audit_logs,
  public.notifications,
  public.announcements
to authenticated;

-- -----------------------------------------------------------------------------
-- Reference data readable by any signed-in user
-- -----------------------------------------------------------------------------
create policy roles_select on public.roles
  for select to authenticated using (true);

create policy departments_select on public.departments
  for select to authenticated using (true);

create policy attendance_policies_select on public.attendance_policies
  for select to authenticated using (true);

create policy holidays_select on public.holidays
  for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- Own rows or admin
-- -----------------------------------------------------------------------------
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));

create policy registered_devices_select on public.registered_devices
  for select to authenticated
  using (employee_id = (select auth.uid()) or (select private.is_admin()));

create policy leave_records_select on public.leave_records
  for select to authenticated
  using (employee_id = (select auth.uid()) or (select private.is_admin()));

create policy attendance_records_select on public.attendance_records
  for select to authenticated
  using (employee_id = (select auth.uid()) or (select private.is_admin()));

create policy attendance_events_select on public.attendance_events
  for select to authenticated
  using (employee_id = (select auth.uid()) or (select private.is_admin()));

create policy break_records_select on public.break_records
  for select to authenticated
  using (employee_id = (select auth.uid()) or (select private.is_admin()));

create policy attendance_corrections_select on public.attendance_corrections
  for select to authenticated
  using (employee_id = (select auth.uid()) or (select private.is_admin()));

create policy checkout_exceptions_select on public.checkout_exceptions
  for select to authenticated
  using (employee_id = (select auth.uid()) or (select private.is_admin()));

create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- Admin only (direct table access)
-- -----------------------------------------------------------------------------
create policy office_locations_select on public.office_locations
  for select to authenticated using ((select private.is_admin()));

create policy office_networks_select on public.office_networks
  for select to authenticated using ((select private.is_admin()));

create policy attendance_verifications_select on public.attendance_verifications
  for select to authenticated using ((select private.is_admin()));

create policy audit_logs_select on public.audit_logs
  for select to authenticated using ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- Announcements: everyone sees published, unexpired ones; admins see all.
-- -----------------------------------------------------------------------------
create policy announcements_select on public.announcements
  for select to authenticated
  using (
    (select private.is_admin())
    or (published_at <= now() and (expires_at is null or expires_at > now()))
  );

-- qr_tokens, qr_scan_events, idempotency_keys, push_subscriptions: RLS enabled, NO policy,
-- NO grant -> not readable by anon/authenticated. Only the API's DB role touches them.

-- -----------------------------------------------------------------------------
-- Realtime: the admin dashboard subscribes with its own JWT; RLS above decides which rows
-- it is allowed to receive. Guarded because the publication only exists on Supabase.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.attendance_records;
  end if;
end;
$$;
