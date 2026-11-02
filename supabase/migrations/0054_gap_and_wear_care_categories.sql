-- 0054_gap_and_wear_care_categories.sql
--
-- GAP and Wear Care become categories of their own, each with a menu row.
--
-- Now that rating sends the provider's codes, a financed New deal is offered
-- GAP (18_2) and Wear Care (1029_46). Neither was a category the catalog, the
-- menu rows or the presets allowed, so 0052 filed both under Other and Details
-- said "1 GAP plan was offered but no menu row uses it".
--
-- 1. The three category rules are replaced with GAP and Wear Care added:
--      product_catalog.product_catalog_category_known
--      menu_template_slots.menu_template_slots_category_known
--      menu_presets.menu_presets_category_check
--    A CHECK rule cannot be changed in place, so each is dropped and added
--    again in this same transaction. Jim approved these three DROPs
--    (2026-11-02); nothing else is dropped. Every existing value is still
--    allowed, so no row can fail the new rules.
-- 2. 18_2 moves to GAP and 1029_46 to Wear Care.
-- 3. A GAP row and a Wear Care row are added to the ATV and UTV and All deals
--    menus, after their existing rows, Side by Side, each listing its product.
--
-- Anything other than exactly two catalog rows moved and four menu rows added
-- stops the migration.

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
       and c.relname in ('product_catalog', 'menu_template_slots', 'menu_presets')
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on a catalog or menu table. Nothing was changed.';
  end if;
end $$;

-- ── 1. The three category rules, with GAP and Wear Care ─────────────────
alter table fni.product_catalog drop constraint product_catalog_category_known;
alter table fni.product_catalog add constraint product_catalog_category_known
  check (category in ('Mechanical Protection', 'Maintenance', 'Tire and Wheel', 'Theft', 'Battery', 'GAP', 'Wear Care', 'Appearance', 'Other'));

alter table fni.menu_template_slots drop constraint menu_template_slots_category_known;
alter table fni.menu_template_slots add constraint menu_template_slots_category_known
  check (category is null or category in ('Mechanical Protection', 'Maintenance', 'Tire and Wheel', 'Theft', 'Battery', 'GAP', 'Wear Care', 'Appearance', 'Other'));

alter table fni.menu_presets drop constraint menu_presets_category_check;
alter table fni.menu_presets add constraint menu_presets_category_check
  check (category in ('Mechanical Protection', 'Maintenance', 'Tire and Wheel', 'Theft', 'Battery', 'GAP', 'Wear Care', 'Appearance', 'Other'));

-- ── 2 and 3. The two products, and their menu rows ──────────────────────
do $$
declare
  moved int;
  added int;
begin
  update fni.product_catalog
     set category = case product_code when '18_2' then 'GAP' when '1029_46' then 'Wear Care' end,
         updated_at = now()
   where store_id is null and product_code in ('18_2', '1029_46');
  get diagnostics moved = row_count;
  if moved <> 2 then
    raise exception 'Expected to move two catalog rows (18_2, 1029_46); moved %. Nothing was changed.', moved;
  end if;

  insert into fni.menu_template_slots (template_id, position, title, category, mode, product_ids, updated_at)
  select t.id,
         (select coalesce(max(s.position), 0) from fni.menu_template_slots s where s.template_id = t.id) + r.n,
         r.title, r.title, 'Side by Side',
         array[(select c.id from fni.product_catalog c where c.product_code = r.code and c.store_id is null and c.tenant_id = t.tenant_id)],
         now()
    from fni.menu_templates t
    cross join (values (1, 'GAP', '18_2'), (2, 'Wear Care', '1029_46')) as r(n, title, code)
   where t.name in ('ATV and UTV', 'All deals')
     and not exists (select 1 from fni.menu_template_slots s where s.template_id = t.id and s.title = r.title);
  get diagnostics added = row_count;
  if added <> 4 then
    raise exception 'Expected to add four menu rows (GAP and Wear Care on two menus); added %. Nothing was changed.', added;
  end if;
  if exists (
    select 1 from fni.menu_template_slots s join fni.menu_templates t on t.id = s.template_id
     where t.name in ('ATV and UTV', 'All deals') and s.title in ('GAP', 'Wear Care')
       and (array_length(s.product_ids, 1) is distinct from 1 or s.product_ids[1] is null)
  ) then
    raise exception 'A new menu row does not list its product. Nothing was changed.';
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261102180000',
  '0054_gap_and_wear_care_categories',
  array['GAP and Wear Care as categories (three category rules replaced, approved by Jim), 18_2 and 1029_46 moved to them, and GAP and Wear Care menu rows on ATV and UTV and All deals. See supabase/migrations/0054_gap_and_wear_care_categories.sql.'],
  'claude'
);

commit;
