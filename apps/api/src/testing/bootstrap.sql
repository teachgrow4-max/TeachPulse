-- Emulates the parts of a Supabase database that the migrations depend on, so the migrations
-- can run on a plain embedded Postgres (PGlite) with no Docker. On a real Supabase database
-- (TEST_DATABASE_URL) none of this runs: the platform already provides it.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants new public objects to the Data API roles by default. Reproduce that so the
-- migrations' explicit REVOKEs are genuinely exercised rather than trivially satisfied.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text,
  banned_until        timestamptz,
  raw_app_meta_data   jsonb not null default '{}'::jsonb,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- GoTrue keeps one row per signed-in session. The API treats a JWT as valid only while its
-- session row exists, which is what makes logout and deactivation take effect immediately.
create table auth.sessions (
  id          uuid primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  not_after   timestamptz,
  user_agent  text,
  ip          inet
);
create index sessions_user_id_idx on auth.sessions (user_id);

create function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create publication supabase_realtime;
