-- 0049_menu_row_preferred_term.sql
--
-- A preferred coverage term per menu row (Administration > Menus).
--
-- When no preset sets a term, Prepare presentation picks the longest offered
-- term that does not run past the deal's finance term (the longest offered on
-- a cash deal). A manager can override that per row of a menu template:
--
--   menu_template_slots.preferred_term_months
--                     the term this row starts at, in months, when no preset
--                     sets one. Null: the default rule above. The closest
--                     offered term is used when this exact one is not offered.
--
-- Additive only: one nullable column with a range check. No existing value
-- changes, nothing dropped.

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
       and c.relname = 'menu_template_slots'
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on fni.menu_template_slots. Nothing was changed.';
  end if;
end $$;

alter table fni.menu_template_slots add column if not exists preferred_term_months integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'menu_template_slots_preferred_term_months_check') then
    alter table fni.menu_template_slots add constraint menu_template_slots_preferred_term_months_check
      check (preferred_term_months is null or preferred_term_months between 1 and 240);
  end if;
end $$;

comment on column fni.menu_template_slots.preferred_term_months is
  'The coverage term this row starts at when no preset sets one, in months. Null: the longest offered term within the finance term (longest offered on cash).';

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261102130000',
  '0049_menu_row_preferred_term',
  array['A preferred coverage term per menu row: menu_template_slots.preferred_term_months. See supabase/migrations/0049_menu_row_preferred_term.sql.'],
  'claude'
);

commit;
