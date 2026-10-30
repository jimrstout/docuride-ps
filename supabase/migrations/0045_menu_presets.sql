-- 0045_menu_presets.sql
--
-- Menu presets (Administration > Menus) and per-deal menu preparation (Details
-- > Prepare menu). docs/multi-provider.md section 25. Additive only: new
-- tables, new nullable columns, two functions. No existing row changes,
-- nothing dropped.
--
-- ── Presets: set once per template by managers ──────────────────────────
--   fni.menu_presets  per menu template (its store, vehicle type and deal
--                     conditions, migrations 0023 and 0033), per Financed or
--                     Cash, per column (migration 0042), per product category:
--                     the preferred plan, term, deductible and mileage. When a
--                     vehicle does not rate for them the closest available is
--                     used (_shared/menu-presets.ts).
--   pricing_rules     keep the retail default, a markup over dealer cost by
--                     cost band (migration 0006). Two new columns set the top
--                     of the band staff may price within on a deal:
--                     max_markup_percent and max_markup_dollars, the lower of
--                     the two when both are set. Never below dealer cost.
--   fni.admin_change_log
--                     every preset and guardrail change: what, before, after,
--                     who and when. Insert only.
--
-- ── Deal preparation: by staff, before presenting ───────────────────────
--   fni.session_menu_prices
--                     a deal's retail price per product option: the product,
--                     term, miles, deductible and whether it disappears (the
--                     option key, not a rate id, so it survives a re-rate and
--                     one option has one price in every column). A price above
--                     the band records the manager who allowed it and why.
--   fni.sessions      menu_prepared (each column's choice per category),
--                     menu_surcharges (option codes for the vehicle, applied
--                     to every column), menu_prepared_at, menu_prepared_by,
--                     menu_prices_locked_at (set when the customer chooses).
--
-- Who is a manager: public.profiles.role 'owner' or 'admin'
-- (fni.is_menu_manager). Other signed-in staff can view presets, and price
-- within the band.

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
       and c.relname in ('sessions', 'pricing_rules', 'menu_templates')
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on an fni table this migration changes. Nothing was changed.';
  end if;
end $$;

-- ── Presets ─────────────────────────────────────────────────────────────

create table if not exists fni.menu_presets (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references fni.menu_templates(id) on delete cascade,
  deal_type text not null check (deal_type in ('Financed', 'Cash')),
  column_position int not null check (column_position between 1 and 5),
  category text not null check (category in (
    'Mechanical Protection', 'Maintenance', 'Tire and Wheel', 'Theft', 'Battery', 'Appearance', 'Other'
  )),
  -- The preferred plan, as the catalog names it ("Priority Maintenance, Gold"):
  -- one name covers that plan's version for every vehicle type, each its own
  -- product code. A lower plan is the one before it in catalog display order.
  -- Null: the column's level decides, as before.
  provider_id uuid references fni.providers(id),
  plan_name text,
  term_months int check (term_months is null or term_months > 0),
  term_miles int check (term_miles is null or term_miles >= 0),
  deductible numeric(12,2) check (deductible is null or deductible >= 0),
  disappearing_deductible boolean,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  unique (template_id, deal_type, column_position, category)
);

comment on table fni.menu_presets is
  'Per menu template, Financed or Cash, column and product category: the preferred plan, term, deductible and mileage. Fallbacks in _shared/menu-presets.ts. Written by managers in Administration > Menus.';

alter table fni.menu_presets enable row level security;
revoke all on fni.menu_presets from public, anon, authenticated;
grant select, insert, update, delete on fni.menu_presets to service_role;

-- ── The staff price band on pricing rules ──────────────────────────────

alter table fni.pricing_rules add column if not exists max_markup_percent numeric(8,3)
  check (max_markup_percent is null or max_markup_percent >= 0);
alter table fni.pricing_rules add column if not exists max_markup_dollars numeric(12,2)
  check (max_markup_dollars is null or max_markup_dollars >= 0);

comment on column fni.pricing_rules.max_markup_percent is
  'The most a deal price may be marked up over dealer cost without a manager, as a percent. With max_markup_dollars, the lower wins. Null with both null: the rule''s own retail is the top.';
comment on column fni.pricing_rules.max_markup_dollars is
  'The most a deal price may be marked up over dealer cost without a manager, in dollars.';

-- ── Change log ──────────────────────────────────────────────────────────

create table if not exists fni.admin_change_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  area text not null check (area in ('Menu preset', 'Price band')),
  record_key text not null,
  action text not null check (action in ('Created', 'Changed', 'Removed')),
  before jsonb,
  after jsonb,
  changed_by text not null,
  changed_at timestamptz not null default now()
);

create index if not exists admin_change_log_recent on fni.admin_change_log (tenant_id, changed_at desc);

comment on table fni.admin_change_log is
  'Every menu preset and price band change: before, after, who and when. Insert only.';

alter table fni.admin_change_log enable row level security;
revoke all on fni.admin_change_log from public, anon, authenticated;
grant select, insert on fni.admin_change_log to service_role;

-- ── A deal's prices per product option ──────────────────────────────────

create table if not exists fni.session_menu_prices (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references fni.sessions(id) on delete cascade,
  -- provider|product|term months|term miles|deductible|D or S
  option_key text not null,
  retail_price numeric(12,2) not null check (retail_price >= 0),
  -- Above the band: the manager who allowed it, and why.
  above_band boolean not null default false,
  approved_by text,
  reason text,
  set_by text not null,
  set_at timestamptz not null default now(),
  unique (session_id, option_key),
  check (not above_band or (approved_by is not null and coalesce(trim(reason), '') <> ''))
);

comment on table fni.session_menu_prices is
  'A deal''s retail price per product option (one price in every column), set on Prepare menu. Never below dealer cost; above the band only with a manager and a reason.';

alter table fni.session_menu_prices enable row level security;
revoke all on fni.session_menu_prices from public, anon, authenticated;
grant select, insert, update, delete on fni.session_menu_prices to service_role;

-- ── The prepared menu on the session ────────────────────────────────────

alter table fni.sessions add column if not exists menu_prepared jsonb;
alter table fni.sessions add column if not exists menu_surcharges text[] not null default '{}';
alter table fni.sessions add column if not exists menu_prepared_at timestamptz;
alter table fni.sessions add column if not exists menu_prepared_by text;
alter table fni.sessions add column if not exists menu_prices_locked_at timestamptz;

comment on column fni.sessions.menu_prepared is
  'Prepare menu: {"<column position>": {"<category>": "<option key>" | null}}. Null: Present menu uses the presets as they stand.';
comment on column fni.sessions.menu_surcharges is
  'Vehicle surcharge option codes for this deal (Lift Kit, Commercial Use, ...), applied to every column wherever a rate offers them.';
comment on column fni.sessions.menu_prices_locked_at is
  'Set when the customer chooses a package on the conventional menu. A change after that returns to Prepare menu, recorded as a session event.';

-- ── Who is a manager ────────────────────────────────────────────────────

create or replace function fni.is_menu_manager(p_user uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((select p.role in ('owner', 'admin') from public.profiles p where p.user_id = p_user), false)
$$;

revoke all on function fni.is_menu_manager(uuid) from public, anon, authenticated;
grant execute on function fni.is_menu_manager(uuid) to service_role;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261030220000',
  '0045_menu_presets',
  array['Menu presets and deal preparation: fni.menu_presets, pricing_rules max markup, fni.admin_change_log, fni.session_menu_prices, sessions.menu_prepared and friends, fni.is_menu_manager. See supabase/migrations/0045_menu_presets.sql.'],
  'claude'
);

commit;
