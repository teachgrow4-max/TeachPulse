-- =============================================================================
-- 0006 Reference data + scheduled jobs
-- =============================================================================
-- Seeds ONLY non-sensitive reference data. There is intentionally no office row (coordinates and
-- network addresses are supplied by the company administrator), no users, no employee IDs.

insert into public.roles (name, description) values
  ('employee',       'Marks own attendance and views own history.'),
  ('admin',          'HR administrator: manages employees, office, policy, corrections and reports.'),
  ('office_display', 'Least-privilege kiosk identity that may only fetch the rotating office QR code.')
on conflict (name) do nothing;

-- Initial TeachGrow policy, from the project brief. Every value below is an admin-editable
-- setting, not a constant: start 10:00, close 19:00, late at/after 10:20, 60 min lunch.
-- Column defaults supply those values. Half-day / overtime / early-checkout thresholds were not
-- specified, so those rules start disabled. Working days (Mon-Sat) and timezone live on the office.
insert into public.attendance_policies (effective_from, notes)
values ('2000-01-01', 'Initial TeachGrow policy. Half-day, overtime and early-checkout rules are disabled until configured by an administrator.')
on conflict (effective_from) do nothing;

-- -----------------------------------------------------------------------------
-- Scheduling via pg_cron when available. On hosts without it, run these two statements from
-- any external scheduler instead (documented in docs/DEPLOYMENT.md):
--   select private.finalize_due_days();   -- hourly
--   select private.apply_retention();     -- daily
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('attendance-finalize-days', '5 * * * *',  'select private.finalize_due_days()');
    perform cron.schedule('attendance-retention',     '30 3 * * *', 'select private.apply_retention()');
  else
    raise notice 'pg_cron is not available: schedule private.finalize_due_days() hourly and private.apply_retention() daily externally.';
  end if;
end;
$$;
