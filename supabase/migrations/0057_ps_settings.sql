-- 0057_ps_settings.sql
--
-- PS-wide settings, one row per tenant, in fni rather than on the shared
-- company record (public.tenants), which R&R reporting, DocuRide DC and the
-- Zoho mirror also reference. Two settings to start:
--
--   default_deductible         Administration > Menus, "Default deductible":
--                              where PS starts a product that offers
--                              deductibles when staff have not chosen one.
--                              In the words staff see. #150 kept it in
--                              public.tenants.config.default_deductible; it
--                              was never saved there (config is {} on Test),
--                              so it starts at the default.
--   dealer_group_display_name  Administration > Wording: the dealer group's
--                              name as a customer reads it (migration 0012
--                              put it on public.tenants). Copied from there.
--
-- public.tenants is only read and referenced here, never written: config and
-- dealer_group_display_name stay on it exactly as they are. Additive: one new
-- table, nothing changed in any existing one, nothing dropped.
--
-- Security matches the other fni settings tables: row-level security on, no
-- policies, no grants to anon or authenticated. Only the Edge Functions, as
-- the service role, read or write it. Each edit is logged in
-- fni.admin_change_log by the function that makes it.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ── Lock check ──────────────────────────────────────────────────────────
-- The foreign key takes a brief SHARE ROW EXCLUSIVE lock on public.tenants,
-- so a conflicting lock there stops the migration too.
do $$
begin
  if exists (
    select 1
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
     where l.pid <> pg_backend_pid()
       and l.mode in ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and (n.nspname = 'fni' or (n.nspname = 'public' and c.relname = 'tenants'))
  ) then
    raise exception 'A conflicting lock is held on an fni table or on public.tenants. Nothing was changed.';
  end if;
end $$;

create table if not exists fni.ps_settings (
  tenant_id                 uuid primary key references public.tenants(id) on delete no action,
  default_deductible        text not null default '$100 disappearing deductible'
    constraint ps_settings_default_deductible_check
    check (default_deductible in (
      'No deductible', '$50 deductible', '$100 deductible',
      '$100 disappearing deductible', '$250 deductible', '$500 deductible'
    )),
  dealer_group_display_name text,
  updated_at                timestamptz not null default now(),
  updated_by                text
);

comment on table fni.ps_settings is
  'PS-wide settings, one row per tenant. Edited in Administration; each edit is logged in fni.admin_change_log.';
comment on column fni.ps_settings.default_deductible is
  'Administration > Menus, "Default deductible": where PS starts a product that offers deductibles when staff have not chosen one. In the words staff see.';
comment on column fni.ps_settings.dealer_group_display_name is
  'Administration > Wording: the dealer group''s name as a customer reads it, e.g. "ASP Group". Null means not set, and sentences that need it are left out.';

alter table fni.ps_settings enable row level security;
revoke all on fni.ps_settings from anon, authenticated;

-- One row for each tenant there is now: the default deductible, and the
-- dealer group name as public.tenants has it. Reads public.tenants only.
insert into fni.ps_settings (tenant_id, dealer_group_display_name, updated_by)
select t.id, t.dealer_group_display_name, 'claude'
  from public.tenants t
on conflict (tenant_id) do nothing;

do $$
declare
  missing int;
begin
  select count(*) into missing
    from public.tenants t
   where not exists (select 1 from fni.ps_settings p where p.tenant_id = t.id);
  if missing > 0 then
    raise exception '% tenant(s) have no settings row. Nothing was changed.', missing;
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261106232000',
  '0057_ps_settings',
  array['PS-wide settings in fni: fni.ps_settings, one row per tenant, with default_deductible in the words staff see (default $100 disappearing deductible) and dealer_group_display_name copied from public.tenants. public.tenants is not changed. See supabase/migrations/0057_ps_settings.sql.'],
  'claude'
);

commit;
