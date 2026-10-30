-- 0042_conventional_menu.sql
--
-- The conventional column menu, a second presentation beside the Ownership
-- Planner (docs/multi-provider.md, section 22). Additive only: no existing row
-- changes and nothing is dropped.
--
--   fni.menu_template_columns  a menu template's package columns: two to five,
--                              each with its name, its order, the product
--                              categories it starts checked, and the coverage
--                              level its products start at. A template with
--                              no rows uses the default layout in code
--                              (_shared/menu-columns.ts), so a new template
--                              works before anyone edits it.
--   fni.save_menu_columns      replaces a template's columns in one statement,
--                              and refuses fewer than two or more than five.
--   fni.sessions               which presentation was used, the coverage level
--                              a manager set for each column on this deal, and
--                              who presented it, for the acknowledgment.
--
-- Stored values are the words people read: "Ownership Planner",
-- "Conventional Menu", "Lowest", "Middle", "Highest", and the product
-- categories as they appear everywhere else.
--
-- Coverage level picks a tier within a product's levels, cheapest first:
-- Lowest is the cheapest, Highest the most expensive, and Middle the one in
-- the middle (the lower of the two middle ones when the count is even). A
-- product with one level uses it whatever the setting.

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
    raise exception 'A conflicting lock is held on fni.sessions or fni.menu_templates. Nothing was changed.';
  end if;
end $$;

-- ── A template's package columns ────────────────────────────────────────

create table if not exists fni.menu_template_columns (
  id                uuid primary key default gen_random_uuid(),
  template_id       uuid not null references fni.menu_templates(id) on delete cascade,
  position          integer not null,
  name              text not null,
  preset_categories text[] not null default '{}',
  starting_level    text not null default 'Lowest',
  updated_at        timestamptz not null default now(),
  updated_by        text,

  constraint menu_template_columns_position_range check (position between 1 and 5),
  constraint menu_template_columns_name_present check (btrim(name) <> ''),
  constraint menu_template_columns_categories_known check (preset_categories <@ array[
    'Mechanical Protection', 'Maintenance', 'Tire and Wheel', 'Theft', 'Battery', 'Appearance', 'Other'
  ]::text[]),
  constraint menu_template_columns_level_known check (starting_level in ('Lowest', 'Middle', 'Highest'))
);

create unique index if not exists menu_template_columns_position_key
  on fni.menu_template_columns (template_id, position);
create unique index if not exists menu_template_columns_name_key
  on fni.menu_template_columns (template_id, lower(name));

comment on table fni.menu_template_columns is
  'A menu template''s conventional menu columns (packages), two to five. No rows: the default layout in _shared/menu-columns.ts.';
comment on column fni.menu_template_columns.preset_categories is
  'The product categories this column starts checked. A category with no rated product on a deal is simply absent.';
comment on column fni.menu_template_columns.starting_level is
  'The coverage level this column''s products start at: Lowest, Middle or Highest of each product''s levels, cheapest first.';

alter table fni.menu_template_columns enable row level security;
grant select, insert, update, delete on fni.menu_template_columns to service_role;
revoke all on fni.menu_template_columns from anon, authenticated;

-- ── Saving a template's columns, all at once ────────────────────────────
-- p_columns: [{ "name": "Platinum", "preset_categories": [...], "starting_level": "Highest" }, ...]
-- in display order. Positions are 1, 2, 3 ... from that order.

create or replace function fni.save_menu_columns(
  p_template_id uuid,
  p_columns jsonb,
  p_updated_by text
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  if jsonb_typeof(p_columns) is distinct from 'array' then
    raise exception 'The columns must be a list.';
  end if;
  n := jsonb_array_length(p_columns);
  if n < 2 or n > 5 then
    raise exception 'A menu has two to five columns. This one has %.', n;
  end if;
  if not exists (select 1 from fni.menu_templates t where t.id = p_template_id) then
    raise exception 'That menu template does not exist.';
  end if;

  delete from fni.menu_template_columns c where c.template_id = p_template_id;

  insert into fni.menu_template_columns (template_id, position, name, preset_categories, starting_level, updated_by)
  select p_template_id,
         x.ord::integer,
         pg_catalog.btrim(x.col->>'name'),
         coalesce(array(select pg_catalog.jsonb_array_elements_text(x.col->'preset_categories')), '{}'),
         coalesce(nullif(x.col->>'starting_level', ''), 'Lowest'),
         nullif(pg_catalog.btrim(p_updated_by), '')
    from pg_catalog.jsonb_array_elements(p_columns) with ordinality as x(col, ord);

  return n;
end
$$;

revoke all on function fni.save_menu_columns(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function fni.save_menu_columns(uuid, jsonb, text) to service_role;

-- ── The session: which presentation, the levels for this deal, who ──────

alter table fni.sessions add column if not exists presentation_path text;
alter table fni.sessions add column if not exists menu_column_levels jsonb;
alter table fni.sessions add column if not exists presented_by_name text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_presentation_path_known') then
    alter table fni.sessions add constraint sessions_presentation_path_known
      check (presentation_path is null or presentation_path in ('Ownership Planner', 'Conventional Menu'));
  end if;
end $$;

comment on column fni.sessions.presentation_path is
  'Which presentation recorded the customer''s choices: Ownership Planner or Conventional Menu. Null on sessions from before it was recorded.';
comment on column fni.sessions.menu_column_levels is
  'The coverage level a manager set for each menu column on this deal, by column position: {"1": "Highest", "4": "Lowest"}. A column not named here uses its template setting.';
comment on column fni.sessions.presented_by_name is
  'The signed-in staff member who presented, named on the acknowledgment ("Presented by <name>, dealership staff"). Null when no one was signed in.';

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261030120000',
  '0042_conventional_menu',
  array['Conventional menu: fni.menu_template_columns, fni.save_menu_columns, and fni.sessions.presentation_path, menu_column_levels and presented_by_name. See supabase/migrations/0042_conventional_menu.sql.'],
  'claude'
);

commit;
