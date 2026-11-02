-- 0048_atv_priority_maintenance_catalog.sql
--
-- The four used ATV Priority Maintenance plans in the product catalog.
--
-- On deal 15063 the provider offered Priority Maintenance under its used ATV
-- codes, 64_7, 69_7, 75_7 and 81_7. The catalog had only the used UTV codes
-- (66_7, 72_7, 78_7, 84_7), so the customer's storyboard treated the ATV
-- offers as unknown and left them out. Each new row copies its UTV sibling's
-- wording (what it covers, how to use it, and so on); only the code and the
-- provider's program name differ:
--
--   64_7  USED BRONZE ATV    from 66_7
--   69_7  USED GOLD ATV      from 72_7
--   75_7  USED PLATINUM ATV  from 84_7
--   81_7  USED SILVER ATV    from 78_7
--
-- Additive only: four inserted rows, nothing updated or dropped. A row that
-- already exists is left as it is; anything other than four new rows, or an
-- existing row for every code, stops the migration.

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
       and c.relname = 'product_catalog'
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on fni.product_catalog. Nothing was changed.';
  end if;
end $$;

create temporary table atv_ppm (new_code text, from_code text, program text) on commit drop;
insert into atv_ppm values
  ('64_7', '66_7', 'USED BRONZE ATV'),
  ('69_7', '72_7', 'USED GOLD ATV'),
  ('75_7', '84_7', 'USED PLATINUM ATV'),
  ('81_7', '78_7', 'USED SILVER ATV');

do $$
declare
  added int;
  present int;
begin
  insert into fni.product_catalog (
    tenant_id, store_id, product_code, display_name, goal, what_it_accomplishes,
    what_it_covers, coverage_duration, what_it_excludes, deductible_note, how_to_use,
    transferable, transfer_note, future_value_note, full_terms_url, display_order,
    active, relevance_tags, provider_id, category, provider_program_name
  )
  select s.tenant_id, null, a.new_code, s.display_name, s.goal, s.what_it_accomplishes,
         s.what_it_covers, s.coverage_duration, s.what_it_excludes, s.deductible_note, s.how_to_use,
         s.transferable, s.transfer_note, s.future_value_note, s.full_terms_url, s.display_order,
         s.active, s.relevance_tags, s.provider_id, 'Maintenance', a.program
    from atv_ppm a
    join fni.product_catalog s on s.product_code = a.from_code and s.store_id is null
   where not exists (
     select 1 from fni.product_catalog x
      where x.tenant_id = s.tenant_id and x.provider_id = s.provider_id
        and x.product_code = a.new_code and x.store_id is null
   );
  get diagnostics added = row_count;

  select count(*) into present
    from fni.product_catalog c join atv_ppm a on c.product_code = a.new_code
   where c.store_id is null;

  if not (added = 4 or (added = 0 and present = 4)) or present <> 4 then
    raise exception 'Expected the four ATV Priority Maintenance rows; added %, now present %. Nothing was changed.', added, present;
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261102120000',
  '0048_atv_priority_maintenance_catalog',
  array['Four used ATV Priority Maintenance catalog rows (64_7, 69_7, 75_7, 81_7), copied from their UTV siblings. See supabase/migrations/0048_atv_priority_maintenance_catalog.sql.'],
  'claude'
);

commit;
