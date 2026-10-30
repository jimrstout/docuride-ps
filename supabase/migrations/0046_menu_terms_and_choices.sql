-- 0046_menu_terms_and_choices.sql
--
-- Multiple payment terms on the conventional menu, and the customer's own
-- product choices during the presentation (docs/multi-provider.md section 26).
-- Additive only: one new table, four nullable columns. No existing row
-- changes, nothing dropped.
--
--   fni.menu_preset_terms  per menu template and column, Financed only: the
--                          extra terms offered beyond the deal's own, at most
--                          two (three terms with the deal's). Each has months
--                          and an interest rate; a rate is required, since the
--                          deal's rate never carries to a longer term.
--   sessions.menu_terms    the deal's extra terms per column, as Prepare menu
--                          set them: {"<column position>": [{"months": 72,
--                          "rate": 7.74}, ...]}. Null: the presets'.
--   sessions.menu_removed  products the customer removed from a column before
--                          choosing: {"<column position>": ["<category>", ...]}.
--                          Not session events; "Reset the menu" clears it.
--   sessions.menu_choice   the package chosen: {"column": 2, "name": "Gold",
--                          "term": {"months": 72, "rate": 7.74, "deal_term":
--                          false}, "kept": [...], "removed": [...]}. A term
--                          other than the deal's is a note on Details; PS never
--                          changes the CRM's finance terms.
--
-- Changes to preset terms are logged in fni.admin_change_log under the area
-- 'Menu preset', keyed "terms|<template>|<column>".

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
       and c.relname in ('sessions', 'menu_templates')
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on an fni table this migration changes. Nothing was changed.';
  end if;
end $$;

create table if not exists fni.menu_preset_terms (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references fni.menu_templates(id) on delete cascade,
  column_position int not null check (column_position between 1 and 5),
  -- 1 or 2: the extra terms after the deal's own, in the order shown.
  slot int not null check (slot between 1 and 2),
  term_months int check (term_months is null or term_months between 6 and 240),
  rate_percent numeric(6,3) check (rate_percent is null or (rate_percent >= 0 and rate_percent < 100)),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  unique (template_id, column_position, slot),
  -- Both or neither: an extra term always carries its own rate.
  check ((term_months is null) = (rate_percent is null))
);

comment on table fni.menu_preset_terms is
  'Per menu template and column, Financed deals only: up to two extra payment terms beyond the deal''s own, each with months and a rate. Written by managers in Administration > Menus.';

alter table fni.menu_preset_terms enable row level security;
revoke all on fni.menu_preset_terms from public, anon, authenticated;
grant select, insert, update, delete on fni.menu_preset_terms to service_role;

alter table fni.sessions add column if not exists menu_terms jsonb;
alter table fni.sessions add column if not exists menu_removed jsonb;
alter table fni.sessions add column if not exists menu_choice jsonb;

comment on column fni.sessions.menu_terms is
  'Prepare menu: each column''s extra terms, {"<position>": [{"months": n, "rate": r}]}. Null: the presets''. The deal''s own term is always first and is not stored here.';
comment on column fni.sessions.menu_removed is
  'Products the customer removed from a column before choosing, {"<position>": ["<category>"]}. Cleared by Reset the menu.';
comment on column fni.sessions.menu_choice is
  'The package chosen on the conventional menu: column, name, term (months, rate, whether the deal''s own) and the products kept and removed.';

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261030230000',
  '0046_menu_terms_and_choices',
  array['Multiple payment terms and customer product choices: fni.menu_preset_terms, sessions.menu_terms, menu_removed, menu_choice. See supabase/migrations/0046_menu_terms_and_choices.sql.'],
  'claude'
);

commit;
