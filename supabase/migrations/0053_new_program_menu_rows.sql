-- 0053_new_program_menu_rows.sql
--
-- The products catalogued in 0052, listed in the menu rows they belong to, so
-- a New unit's plans sit in the same rows as a Used unit's and a menu row
-- shows them by name rather than by the category fallback alone.
--
--   ATV and UTV, and All deals (which lists the same ATV and UTV codes)
--     Maintenance            + 54_7 55_7 56_7 57_7             New Priority Maintenance
--     Mechanical Protection  + 3_1 2072_142 2088_142 2092_142  New Care Plus, New Premium Plus
--                            + 2078_142 2082_142               Used Premium Plus (service drive
--                                                              stays out of a regular sale)
--     Battery                + 26_6 27_6                       New batteries
--   Off-Road Motorcycle
--     Maintenance            + 54_7 55_7 56_7 57_7             (the provider labels them ATV/OFF-ROAD MC)
--     Battery                + 26_6 27_6
--   On-Road Motorcycle
--     Battery                + 26_6 27_6
--
-- Codes are appended after the ones a row already lists, in the order shown;
-- a code a row already lists is not added twice. Nothing is removed. GAP gets
-- no row here: a GAP row waits for GAP to be an allowed category.
--
-- Changes only the product lists of these nine rows; anything else, or any row
-- missing a code at the end, stops the migration.

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
       and c.relname in ('menu_template_slots', 'product_catalog')
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on a menu or catalog table. Nothing was changed.';
  end if;
end $$;

create temporary table additions (template_name text, slot_title text, codes text[]) on commit drop;
insert into additions values
  ('ATV and UTV',         'Maintenance',           array['54_7', '55_7', '56_7', '57_7']),
  ('ATV and UTV',         'Mechanical Protection', array['3_1', '2072_142', '2088_142', '2092_142', '2078_142', '2082_142']),
  ('ATV and UTV',         'Battery',               array['26_6', '27_6']),
  ('All deals',           'Maintenance',           array['54_7', '55_7', '56_7', '57_7']),
  ('All deals',           'Mechanical Protection', array['3_1', '2072_142', '2088_142', '2092_142', '2078_142', '2082_142']),
  ('All deals',           'Battery',               array['26_6', '27_6']),
  ('Off-Road Motorcycle', 'Maintenance',           array['54_7', '55_7', '56_7', '57_7']),
  ('Off-Road Motorcycle', 'Battery',               array['26_6', '27_6']),
  ('On-Road Motorcycle',  'Battery',               array['26_6', '27_6']);

do $$
declare
  targets int;
  changed int;
  incomplete int;
begin
  -- Exactly one row for each addition, or nothing happens.
  select count(*) into targets
    from additions a
    join fni.menu_templates t on t.name = a.template_name
    join fni.menu_template_slots s on s.template_id = t.id and s.title = a.slot_title;
  if targets <> 9 then
    raise exception 'Expected nine menu rows to add to; found %. Nothing was changed.', targets;
  end if;

  update fni.menu_template_slots s
     set product_ids = s.product_ids || array(
           select c.id
             from unnest(a.codes) with ordinality u(code, n)
             join fni.product_catalog c
               on c.product_code = u.code and c.store_id is null and c.tenant_id = t.tenant_id
            where not (c.id = any(s.product_ids))
            order by u.n
         ),
         updated_at = now()
    from additions a
    join fni.menu_templates t on t.name = a.template_name
   where s.template_id = t.id and s.title = a.slot_title;
  get diagnostics changed = row_count;

  -- Every row now lists every code it was given.
  select count(*) into incomplete
    from additions a
    join fni.menu_templates t on t.name = a.template_name
    join fni.menu_template_slots s on s.template_id = t.id and s.title = a.slot_title
   where exists (
     select 1 from unnest(a.codes) u(code)
      where not exists (
        select 1 from fni.product_catalog c
         where c.product_code = u.code and c.store_id is null and c.tenant_id = t.tenant_id
           and c.id = any(s.product_ids)
      )
   );
  if changed <> 9 or incomplete <> 0 then
    raise exception 'Expected nine rows changed and none missing a code; changed %, missing %. Nothing was changed.', changed, incomplete;
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261102170000',
  '0053_new_program_menu_rows',
  array['New Priority Maintenance, Care Plus, Premium Plus and New batteries listed in their menu rows. See supabase/migrations/0053_new_program_menu_rows.sql.'],
  'claude'
);

commit;
