-- 0003_rr_report_runs_tenancy
--
-- Closes a tenancy leak that predates tenancy itself.
--
-- rr_report_runs was created before tenants existed, with the placeholder
-- policy "authenticated read" USING (true): every signed-in user of every
-- tenant could read every report run, including other dealers' filenames,
-- deal counts and FTP responses. 0001 added the tenant_id column but left the
-- policy alone. This scopes it like every other table.
--
-- IMPORTANT — api/reports/reyrey.ts does not set tenant_id when it logs a run,
-- so new rows land with tenant_id null and, after this migration, are invisible
-- to tenant users. admin.html reads this table straight from the browser under
-- RLS (admin.html:373), so those runs would silently vanish from the console.
-- Platform admins still see them, so this is harmless while the only profile is
-- a platform operator, but reyrey.ts must stamp tenant_id before the first
-- dealership user is created.

-- Existing unstamped rows are All Seasons', from before the column existed.
update public.rr_report_runs
   set tenant_id = (select id from public.tenants where slug = 'allseasons')
 where tenant_id is null;

drop policy if exists "authenticated read" on public.rr_report_runs;
create policy rr_report_runs_read on public.rr_report_runs
  for select using (
    tenant_id = public.current_tenant_id() or public.is_platform_admin()
  );
