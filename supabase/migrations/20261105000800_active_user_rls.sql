-- =============================================================================
-- 0008 Deactivation takes effect immediately on the Data API and Realtime as well
-- =============================================================================
-- The API checks the session and the active flag on every request. Supabase's own Data API
-- (PostgREST) and Realtime, however, only verify the JWT, which stays valid until it expires.
-- Without this migration a deactivated employee holding a still-valid token could keep reading
-- their own rows through those channels for up to the token lifetime.
--
-- Own-row policies now also require an ACTIVE profile. Reference data (policy, holidays,
-- departments, roles) stays readable by any signed-in user: it is not personal.
-- =============================================================================

create function private.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.is_active
  )
$$;

-- own-row-or-admin tables keyed by employee_id ------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'registered_devices', 'leave_records', 'attendance_records', 'attendance_events',
    'break_records', 'attendance_corrections', 'checkout_exceptions'
  ] loop
    execute format('drop policy %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (
           (employee_id = (select auth.uid()) and (select private.is_active_user()))
           or (select private.is_admin())
         )',
      t || '_select', t);
  end loop;
end;
$$;

-- profiles: keyed by id ----------------------------------------------------------------------
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    (id = (select auth.uid()) and (select private.is_active_user()))
    or (select private.is_admin())
  );

-- notifications: keyed by user_id -----------------------------------------------------------
drop policy notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_active_user()));

-- announcements: published and unexpired, for active users; admins see everything -------------
drop policy announcements_select on public.announcements;
create policy announcements_select on public.announcements
  for select to authenticated
  using (
    (select private.is_admin())
    or (
      (select private.is_active_user())
      and published_at <= now()
      and (expires_at is null or expires_at > now())
    )
  );

-- Standard lockdown block: client roles may execute only the RLS helper functions.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_role_name() to authenticated, service_role;
grant execute on function private.is_admin() to authenticated, service_role;
grant execute on function private.is_active_user() to authenticated, service_role;
