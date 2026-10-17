-- 0023_menu_templates.sql
--
-- Menu templates decide which products a deal is offered. See
-- docs/multi-provider.md, sections 1 and 4.
--
-- A template has conditions (stores, deal types, vehicle types, New or Used,
-- makes; an empty list means any) and an ordered list of slots. A slot is one
-- decision on the menu: its eligible products, in order, and whether it shows
-- the first of them that got an offer (Best Match) or all of them together
-- (Side by Side).
--
-- The seeded "All deals" template has no conditions and priority 0, so it
-- matches every deal and loses to anything more specific. Its five slots are
-- today's menu: the eleven TecAssured products, one Side by Side slot per
-- family, in the catalog's display order. Nothing a live deal sees changes.
--
-- Stored values are the words people read: "Best Match", "Side by Side",
-- "Loan", "Cash", "New", "Used".

create table if not exists fni.menu_templates (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id),
  name          text not null,
  description   text,
  -- Conditions. An empty list matches anything.
  store_ids     uuid[] not null default '{}',
  deal_types    text[] not null default '{}',
  vehicle_types text[] not null default '{}',
  conditions    text[] not null default '{}',
  makes         text[] not null default '{}',
  -- Breaks a tie between equally specific templates. Higher wins.
  priority      integer not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text,

  constraint menu_templates_name_present check (btrim(name) <> ''),
  constraint menu_templates_deal_types_known check (deal_types <@ array['Loan', 'Cash']::text[]),
  constraint menu_templates_conditions_known check (conditions <@ array['New', 'Used']::text[])
);

create unique index if not exists menu_templates_tenant_name_key
  on fni.menu_templates (tenant_id, lower(name));

create table if not exists fni.menu_template_slots (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references fni.menu_templates(id) on delete cascade,
  position      integer not null,
  title         text not null,
  category      text,
  mode          text not null default 'Side by Side',
  -- Eligible products, in order: fni.product_catalog ids of the tenant's rows.
  product_ids   uuid[] not null default '{}',
  updated_at    timestamptz not null default now(),

  constraint menu_template_slots_title_present check (btrim(title) <> ''),
  constraint menu_template_slots_mode_known check (mode in ('Best Match', 'Side by Side')),
  constraint menu_template_slots_category_known check (category is null or category in (
    'Mechanical Protection', 'Maintenance', 'Tire and Wheel', 'Theft', 'Battery', 'Appearance', 'Other'
  ))
);

create unique index if not exists menu_template_slots_position_key
  on fni.menu_template_slots (template_id, position);

alter table fni.menu_templates enable row level security;
alter table fni.menu_template_slots enable row level security;
grant select, insert, update, delete on fni.menu_templates, fni.menu_template_slots to service_role;
revoke all on fni.menu_templates, fni.menu_template_slots from anon, authenticated;

comment on table fni.menu_templates is
  'Which products a deal is offered. The most specific active template whose '
  'conditions all match wins; then the higher priority; then the most recently updated.';
comment on table fni.menu_template_slots is
  'One decision on a menu. Best Match shows the first eligible product that got '
  'an offer; Side by Side shows every one that did. A slot with none is hidden.';

-- The template matched for a session at rating time.
alter table fni.sessions add column if not exists menu_template_id uuid references fni.menu_templates(id);

-- ── The seed: today's menu ────────────────────────────────────────────────

insert into fni.menu_templates (tenant_id, name, description, priority, updated_by)
select t.id, 'All deals',
       'Every deal that no more specific template matches. Reproduces the menu as it was before templates.',
       0, 'Migration 0023'
from public.tenants t
where t.crm_sync = 'zoho'
on conflict (tenant_id, lower(name)) do nothing;

insert into fni.menu_template_slots (template_id, position, title, category, mode, product_ids)
select mt.id, s.position, s.title, s.category, 'Side by Side',
       array(
         select c.id
         from unnest(s.codes) with ordinality as x(code, ord)
         join fni.product_catalog c
           on c.product_code = x.code and c.tenant_id = mt.tenant_id and c.store_id is null
         join fni.providers p on p.id = c.provider_id and p.adapter = 'TecAssured'
         order by x.ord
       )
from fni.menu_templates mt
cross join (values
  (1, 'Maintenance',           'Maintenance',           array['66_7', '78_7', '72_7', '84_7']),
  (2, 'Mechanical Protection', 'Mechanical Protection', array['16_3', '86_3']),
  (3, 'Tire and Wheel',        'Tire and Wheel',        array['23_4']),
  (4, 'Theft',                 'Theft',                 array['24_5', '25_5']),
  (5, 'Battery',               'Battery',               array['755_6', '754_6'])
) as s(position, title, category, codes)
where mt.name = 'All deals' and mt.updated_by = 'Migration 0023'
on conflict (template_id, position) do nothing;
