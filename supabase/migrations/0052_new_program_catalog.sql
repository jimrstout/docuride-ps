-- 0052_new_program_catalog.sql
--
-- Catalog rows for the products the provider offers now that rating sends its
-- codes (_shared/coded-values.ts): the New programs, GAP and Wear Care, seen
-- in the probes on deal 15063 (fni.rate_probes, 2026-11-02), and the Used
-- Premium Plus plan that appeared in 15063's own rating the same day.
--
-- Two kinds of row:
--
-- 1. The same plan as a Used one already described: its customer wording,
--    goal, order and terms link are copied from that row. Their wording is
--    generic ("factory scheduled maintenance services for your machine") and
--    names no condition or vehicle type, so it reads true for a New unit.
--
--      54_7   NEW BRONZE ATV/OFF-ROAD MC    from 64_7   Priority Maintenance, Bronze
--      55_7   NEW SILVER ATV/OFF-ROAD MC    from 81_7   Priority Maintenance, Silver
--      56_7   NEW GOLD ATV/OFF-ROAD MC      from 69_7   Priority Maintenance, Gold
--      57_7   NEW PLATINUM ATV/OFF-ROAD MC  from 75_7   Priority Maintenance, Platinum
--      26_6   RA BATTERY STANDARD           from 755_6  Battery Protection, Standard
--      27_6   RA BATTERY PLUS               from 754_6  Battery Protection, Plus
--
-- 2. A plan with no described twin: named, filed and ordered, its customer
--    wording left blank. That is the catalog's own "copy pending" state
--    (_shared/planner-catalog.ts): recognised, withheld from the customer on
--    purpose, and listed in Administration as needing a description, rather
--    than sold off words nobody wrote.
--
--      3_1       NEW ATV/UTV CARE PLUS 1-12             Mechanical Protection, Care Plus 1-12
--      2072_142  NEW ATV/UTV PREMIUM PLUS 1-12          Mechanical Protection, Premium Plus 1-12
--      2088_142  NEW ATV/UTV PREMIUM PLUS 13-24         Mechanical Protection, Premium Plus 13-24
--      2092_142  NEW ATV/UTV PREMIUM PLUS 25-36         Mechanical Protection, Premium Plus 25-36
--      2078_142  USED ATV/UTV PREMIUM PLUS              Mechanical Protection, Premium Plus
--      2082_142  USED ATV/UTV PREMIUM PLUS-SVC DRIVE    Mechanical Protection, Premium Plus Service Drive
--      18_2      POWERSPORTS GAP 150%                   GAP
--      1029_46   ATV/UTV WEAR CARE                      Wear Care
--
-- The New Care Plus and Premium Plus names keep the provider's band (1-12,
-- 13-24, 25-36): one quote offered all three Premium Plus bands, and without
-- it Prepare would show three identical lines. What the bands mean is for the
-- wording, written in Administration.
--
-- GAP and Wear Care are filed under Other: GAP is not one of the categories
-- the catalog allows, and adding it means replacing that rule, which waits for
-- Jim. Moving them is a one-line update once it is allowed.
--
-- Additive only: fourteen inserted rows, nothing updated or dropped. A row that
-- already exists is left as it is; anything other than all fourteen in place at
-- the end stops the migration.

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

-- 1. Copied from a described twin.
create temporary table copied (new_code text, from_code text, program text) on commit drop;
insert into copied values
  ('54_7', '64_7',  'NEW BRONZE ATV/OFF-ROAD MC'),
  ('55_7', '81_7',  'NEW SILVER ATV/OFF-ROAD MC'),
  ('56_7', '69_7',  'NEW GOLD ATV/OFF-ROAD MC'),
  ('57_7', '75_7',  'NEW PLATINUM ATV/OFF-ROAD MC'),
  ('26_6', '755_6', 'RA BATTERY STANDARD'),
  ('27_6', '754_6', 'RA BATTERY PLUS');

-- 2. Named only, wording pending. The tenant and provider come from 16_3,
-- the provider's Mechanical Protection row, so they match the rest.
create temporary table pending (new_code text, display_name text, category text, goal text, display_order int, program text) on commit drop;
insert into pending values
  ('3_1',      'Mechanical Protection, Care Plus 1-12',              'Mechanical Protection', 'Keep ownership manageable', 114, 'NEW ATV/UTV CARE PLUS 1-12'),
  ('2072_142', 'Mechanical Protection, Premium Plus 1-12',           'Mechanical Protection', 'Keep ownership manageable', 115, 'NEW ATV/UTV PREMIUM PLUS 1-12'),
  ('2088_142', 'Mechanical Protection, Premium Plus 13-24',          'Mechanical Protection', 'Keep ownership manageable', 115, 'NEW ATV/UTV PREMIUM PLUS 13-24'),
  ('2092_142', 'Mechanical Protection, Premium Plus 25-36',          'Mechanical Protection', 'Keep ownership manageable', 115, 'NEW ATV/UTV PREMIUM PLUS 25-36'),
  ('2078_142', 'Mechanical Protection, Premium Plus',                'Mechanical Protection', 'Keep ownership manageable', 115, 'USED ATV/UTV PREMIUM PLUS'),
  ('2082_142', 'Mechanical Protection, Premium Plus Service Drive',  'Mechanical Protection', 'Keep ownership manageable', 116, 'USED ATV/UTV PREMIUM PLUS-SVC DRIVE'),
  ('18_2',     'GAP',                                                'Other',                 'Keep ownership manageable', 150, 'POWERSPORTS GAP 150%'),
  ('1029_46',  'Wear Care',                                          'Other',                 'Keep ownership manageable', 160, 'ATV/UTV WEAR CARE');

do $$
declare
  added_copied int;
  added_pending int;
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
         s.active, s.relevance_tags, s.provider_id, s.category, a.program
    from copied a
    join fni.product_catalog s on s.product_code = a.from_code and s.store_id is null
   where not exists (
     select 1 from fni.product_catalog x
      where x.tenant_id = s.tenant_id and x.provider_id = s.provider_id
        and x.product_code = a.new_code and x.store_id is null
   );
  get diagnostics added_copied = row_count;

  insert into fni.product_catalog (
    tenant_id, store_id, product_code, display_name, goal, display_order,
    active, provider_id, category, provider_program_name
  )
  select s.tenant_id, null, p.new_code, p.display_name, p.goal, p.display_order,
         true, s.provider_id, p.category, p.program
    from pending p
    join fni.product_catalog s on s.product_code = '16_3' and s.store_id is null
   where not exists (
     select 1 from fni.product_catalog x
      where x.tenant_id = s.tenant_id and x.provider_id = s.provider_id
        and x.product_code = p.new_code and x.store_id is null
   );
  get diagnostics added_pending = row_count;

  select count(*) into present
    from fni.product_catalog c
   where c.store_id is null
     and c.product_code in (select new_code from copied union select new_code from pending);

  if present <> 14 then
    raise exception 'Expected all fourteen catalog rows; added % and %, now present %. Nothing was changed.',
      added_copied, added_pending, present;
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261102160000',
  '0052_new_program_catalog',
  array['Fourteen catalog rows: six New plans copied from their Used twins, eight named with wording pending (Care Plus, Premium Plus, GAP, Wear Care). See supabase/migrations/0052_new_program_catalog.sql.'],
  'claude'
);

commit;
