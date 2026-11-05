-- =============================================================================
-- 0007 Authentication support
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Forced first-login password change. Enforced by the API: while true, every endpoint except
-- /auth/me, /auth/logout and /auth/change-password refuses the request.
-- -----------------------------------------------------------------------------
alter table public.profiles
  add column must_change_password boolean not null default false;

-- -----------------------------------------------------------------------------
-- Failed-login lockout is computed from the audit log (durable, shared by every API instance).
-- `metadata.subject_hash` is a SHA-256 of the lower-cased email, so unknown addresses lock out
-- exactly like known ones and no raw attempted identifier is stored.
-- -----------------------------------------------------------------------------
create index audit_logs_login_subject_idx
  on public.audit_logs ((metadata ->> 'subject_hash'), occurred_at desc)
  where action in ('auth.login.failed', 'auth.login.success');

-- -----------------------------------------------------------------------------
-- Profiles are never hard-deleted (attendance history depends on them); they are deactivated.
-- -----------------------------------------------------------------------------
create trigger profiles_no_delete
  before delete on public.profiles
  for each row execute function private.reject_delete();

-- -----------------------------------------------------------------------------
-- The system must never be left without an active administrator. Enforced in the database so
-- no API bug, script or manual SQL can lock everybody out. An advisory lock serialises
-- concurrent demotions so two admins cannot remove each other at the same time.
-- -----------------------------------------------------------------------------
create function private.protect_last_admin()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_admin_role smallint;
  v_other_admins integer;
begin
  select id into v_admin_role from public.roles where name = 'admin';

  if old.role_id = v_admin_role
     and old.is_active
     and (new.role_id <> v_admin_role or not new.is_active)
  then
    perform pg_advisory_xact_lock(hashtext('teachgrow.last_admin'));

    select count(*) into v_other_admins
    from public.profiles
    where role_id = v_admin_role and is_active and id <> old.id;

    if v_other_admins = 0 then
      raise exception using errcode = 'TG001', message = 'LAST_ADMIN';
    end if;
  end if;

  return new;
end;
$$;

create trigger profiles_protect_last_admin
  before update of role_id, is_active on public.profiles
  for each row execute function private.protect_last_admin();

-- Standard lockdown block: client roles may execute only the two RLS helpers.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_role_name() to authenticated, service_role;
grant execute on function private.is_admin() to authenticated, service_role;
