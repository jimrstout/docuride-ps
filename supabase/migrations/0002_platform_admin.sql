-- 0002_platform_admin
--
-- Adds the platform-operator role.
--
-- 0001 modelled only dealership users: every profile belonged to exactly one
-- tenant, and every policy scoped reads to that tenant. That has no place for
-- the people who run DocuRide, who need to see across tenants to troubleshoot.
-- Making a DocuRide operator an "owner" of All Seasons works only while All
-- Seasons is the sole tenant, and has to be undone at tenant #2.
--
--   tenant user      -> tenant_id set,  is_platform_admin = false
--   platform operator-> tenant_id null, is_platform_admin = true
--
-- Deliberately out of scope (see MIGRATION_PATH.md §4, Phase 4):
--   - impersonation / "act as tenant", which needs an audit trail
--   - users belonging to more than one tenant
--   - who may create tenants and invite the first owner (api/users.ts today
--     lets any authenticated caller invite anyone)

-- ---------- profiles ----------

alter table public.profiles
  add column if not exists is_platform_admin boolean not null default false;

-- A platform operator has no home tenant.
alter table public.profiles
  alter column tenant_id drop not null;

-- ...but a tenant user must still have one, or they would silently see
-- nothing: tenant_id = current_tenant_id() is never true when both are null.
alter table public.profiles
  drop constraint if exists profiles_tenant_required;
alter table public.profiles
  add constraint profiles_tenant_required
  check (is_platform_admin or tenant_id is not null);

-- ---------- helper ----------

-- SECURITY DEFINER, matching current_tenant_id(): it reads profiles, and the
-- policy on profiles calls it, so it must not be subject to RLS itself.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    (select is_platform_admin from public.profiles where user_id = auth.uid()),
    false
  )
$$;

-- ---------- policies ----------
--
-- Every tenant-scoped policy gains the platform-admin escape hatch. Reads
-- only; all writes still go through Vercel functions on the service-role key.

drop policy if exists tenant_read on public.tenants;
create policy tenant_read on public.tenants
  for select using (id = public.current_tenant_id() or public.is_platform_admin());

drop policy if exists stores_read on public.stores;
create policy stores_read on public.stores
  for select using (tenant_id = public.current_tenant_id() or public.is_platform_admin());

-- A platform admin can see every profile; everyone else sees only their own.
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for select using (user_id = auth.uid() or public.is_platform_admin());

drop policy if exists deals_read on public.deals;
create policy deals_read on public.deals
  for select using (tenant_id = public.current_tenant_id() or public.is_platform_admin());

drop policy if exists ownership_read on public.field_ownership;
create policy ownership_read on public.field_ownership
  for select using (tenant_id = public.current_tenant_id() or public.is_platform_admin());

-- Note: public.rr_report_runs carries an older "authenticated read" policy with
-- USING (true) — every signed-in user of every tenant can read every run. That
-- predates tenancy and is left alone here rather than bundled into this change,
-- but it wants tightening to
--   tenant_id = public.current_tenant_id() or public.is_platform_admin()
-- once admin.html is confirmed to send a user token on that path.
