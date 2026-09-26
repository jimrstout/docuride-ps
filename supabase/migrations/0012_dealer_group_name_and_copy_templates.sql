-- 0012_dealer_group_name_and_copy_templates.sql
--
-- Two things the planner needs before it can say a true sentence about a
-- disappearing deductible, and neither of them belongs in code.
--
-- ─── 1. The dealer group's customer-facing name ──────────────────────────
--
-- There was no field for it, so the name was written into a React component:
-- AppShell.tsx carried "All Seasons / Powersports & Equipment" in the footer of
-- every customer-facing screen. public.tenants.name exists but is
-- administrative -- "All Seasons Powersports / Applied Group", with a slash in
-- it -- and is what admin screens display, so it is not the same fact and
-- cannot be reused without breaking one of the two readers.
--
-- ─── 2. Copy that is editable without a deploy ───────────────────────────
--
-- The disappearing deductible sentence names the dealer group and states an
-- amount. Both vary, the amount comes from the rate rather than the sentence,
-- and another dealer group's terms may be narrower -- the selling store only,
-- for instance. So it is a template with placeholders, stored per tenant, with
-- a platform default underneath it.
--
-- The override shape is the one fni.product_catalog already uses for stores: a
-- row with a null scope is the general one, and a specific row wins.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. tenants.dealer_group_display_name
-- ─────────────────────────────────────────────────────────────────────────

alter table public.tenants
  add column if not exists dealer_group_display_name text;

comment on column public.tenants.dealer_group_display_name is
  'The dealer group''s name as a customer should read it, e.g. "ASP Group". '
  'Distinct from tenants.name, which is administrative and may carry internal '
  'punctuation. Customer-facing screens and copy templates read this one. Null '
  'means no name has been set, and any sentence that needs it is omitted '
  'rather than rendered with a gap.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. fni.copy_templates
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists fni.copy_templates (
  id          uuid primary key default gen_random_uuid(),
  -- Null is the platform default. A tenant row overrides it for that tenant.
  tenant_id   uuid references public.tenants(id) on delete cascade,
  template_key text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table fni.copy_templates is
  'Customer-facing sentences that vary by dealer group, kept out of code so they '
  'can be corrected without a deploy. A row with tenant_id null is the platform '
  'default; a tenant row wins over it.';

comment on column fni.copy_templates.body is
  'The sentence, with {placeholder} names filled at render time. Placeholders '
  'that resolve to nothing cause the whole line to be omitted, because a '
  'sentence with a hole in it is worse than no sentence.';

-- One template per key per scope, and the null-tenant default is a single row.
create unique index if not exists copy_templates_tenant_key
  on fni.copy_templates (tenant_id, template_key)
  where tenant_id is not null;

create unique index if not exists copy_templates_default_key
  on fni.copy_templates (template_key)
  where tenant_id is null;

-- fni is service_role only and nothing here changes that.
alter table fni.copy_templates enable row level security;
revoke all on fni.copy_templates from anon, authenticated;
grant all on fni.copy_templates to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The platform default for the disappearing deductible
-- ─────────────────────────────────────────────────────────────────────────
--
-- Riders' rule for this group: the deductible drops to zero when the repair is
-- done at any of the group's stores. The amount is a placeholder rather than a
-- number so the sentence stays true if the rate changes; a dealer group whose
-- terms are narrower replaces the whole sentence with its own row.
--
-- Plain English, and no em dashes: this is read by a buyer, not by us.

insert into fni.copy_templates (tenant_id, template_key, body)
values (
  null,
  'deductible.disappearing',
  'Your {deductible_amount} deductible drops to $0 as long as the repair is done at any {dealer_group_name} store.'
)
on conflict do nothing;
