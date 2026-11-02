-- 0055_care_plus_bands.sql
--
-- The two other Care Plus warranty bands in the catalog and on the menus.
--
-- The provider offers New Care Plus in bands of remaining factory warranty and
-- picks the band itself. Probes on deal 15063 (fni.rate_probes, 2026-11-02):
--   warranty 12      3_1    NEW ATV/UTV CARE PLUS 1-12   (catalogued in 0052)
--   warranty 13-24   98_1   NEW ATV/UTV CARE PLUS 13-24
--   warranty 25-36   102_1  NEW ATV/UTV CARE PLUS 25-36
-- 98_1 and 102_1 were not in the catalog.
--
-- 1. Two catalog rows, copied from 3_1 (provider, tenant, category, goal,
--    order), each with its own name and the provider's program name. Their
--    customer wording is left blank, as 3_1's is, so Administration lists them
--    as needing a description and customers never see a blank one.
-- 2. Both appended to the Mechanical Protection rows of the ATV and UTV and
--    All deals menus, after the codes those rows already list.
--
-- Additive only: two rows inserted, two menu rows given more codes. Nothing
-- removed, nothing dropped. Anything other than both rows in place and both
-- menu rows listing both codes stops the migration.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ── Lock check ──────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'fni'
       and c.relname in ('product_catalog', 'menu_template_slots')
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on the catalog or a menu table. Nothing was changed.';
  end if;
end $$;

do $$
declare
  present int;
  incomplete int;
begin
  insert into fni.product_catalog (
    tenant_id, store_id, product_code, display_name, goal, display_order,
    active, provider_id, category, provider_program_name
  )
  select s.tenant_id, null, b.code, b.name, s.goal, s.display_order, true, s.provider_id, s.category, b.program
    from (values
      ('98_1',  'Mechanical Protection, Care Plus 13-24', 'NEW ATV/UTV CARE PLUS 13-24'),
      ('102_1', 'Mechanical Protection, Care Plus 25-36', 'NEW ATV/UTV CARE PLUS 25-36')
    ) as b(code, name, program)
    join fni.product_catalog s on s.product_code = '3_1' and s.store_id is null
   where not exists (
     select 1 from fni.product_catalog x
      where x.tenant_id = s.tenant_id and x.provider_id = s.provider_id and x.product_code = b.code and x.store_id is null
   );

  select count(*) into present from fni.product_catalog where store_id is null and product_code in ('98_1', '102_1');
  if present <> 2 then
    raise exception 'Expected both Care Plus rows (98_1, 102_1); % present. Nothing was changed.', present;
  end if;

  update fni.menu_template_slots s
     set product_ids = s.product_ids || array(
           select c.id from unnest(array['98_1', '102_1']) with ordinality u(code, n)
             join fni.product_catalog c on c.product_code = u.code and c.store_id is null and c.tenant_id = t.tenant_id
            where not (c.id = any(s.product_ids))
            order by u.n
         ),
         updated_at = now()
    from fni.menu_templates t
   where s.template_id = t.id and t.name in ('ATV and UTV', 'All deals') and s.title = 'Mechanical Protection';

  select count(*) into incomplete
    from fni.menu_template_slots s join fni.menu_templates t on t.id = s.template_id
   where t.name in ('ATV and UTV', 'All deals') and s.title = 'Mechanical Protection'
     and (select count(*) from fni.product_catalog c
           where c.id = any(s.product_ids) and c.product_code in ('98_1', '102_1') and c.store_id is null) <> 2;
  if incomplete <> 0 or (select count(*) from fni.menu_template_slots s join fni.menu_templates t on t.id = s.template_id
                          where t.name in ('ATV and UTV', 'All deals') and s.title = 'Mechanical Protection') <> 2 then
    raise exception 'Expected both Mechanical Protection menu rows to list 98_1 and 102_1. Nothing was changed.';
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261103090000',
  '0055_care_plus_bands',
  array['Care Plus 13-24 (98_1) and 25-36 (102_1) in the catalog, wording pending, and on the ATV and UTV and All deals Mechanical Protection rows. See supabase/migrations/0055_care_plus_bands.sql.'],
  'claude'
);

commit;
