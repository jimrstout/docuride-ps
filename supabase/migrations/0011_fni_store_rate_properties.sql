-- 0011_fni_store_rate_properties.sql
--
-- Replaces the vehicle-types cache with a cache of what each dealer actually
-- needs in order to rate.
--
-- ── Why the old cache went ──────────────────────────────────────────────
-- It cached /rate/vehicletypes, and that endpoint does not exist. Probed on
-- 2026-09-25 against the QA server under every spelling and both methods: a
-- Tomcat 404 every time, while the other five endpoints answer. See
-- supabase/functions/_shared/TECASSURED_SHOP_API.md.
--
-- What does exist, and is far more useful, is /rate/requiredproperties. Given a
-- dealer and a vehicle type it returns the exact property names that dealer
-- needs -- and they are dotted and lowercase (engine.ccs, finance.amount,
-- sale.date, postal.code), not the camelCase fields the build was sending. The
-- rate request is built from that list, so the list is what is worth caching.
--
-- ── Why a table and not two columns ─────────────────────────────────────
-- The old cache was one jsonb column on the store mapping, because "the types
-- this dealer sells" is one answer per store. The required properties are one
-- answer per store PER VEHICLE TYPE, and they genuinely differ: UTV requires
-- inservice.date and MCYC does not; PWAC, BOAT and RV require no engine.ccs and
-- SNOW does. A column cannot hold a per-vtype answer without becoming a map
-- that nothing can index or constrain.
--
-- It also gives the "Unavailable" case somewhere to live. A vtype that returns
-- nothing is a real state -- the dealer does not sell it -- and it is worth
-- recording as such rather than as an absent row indistinguishable from one
-- never asked for.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The cache
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists fni.store_rate_properties (
  id                        uuid primary key default gen_random_uuid(),

  -- The mapping, not the store: the answer depends on the Dealer ID we asked
  -- as, so it belongs to the store's identity on an account and must go when
  -- that mapping does.
  store_provider_account_id uuid not null
                              references fni.store_provider_accounts(id) on delete cascade,

  -- TecAssured vehicle type code: UTV, MCYC, ATV, BIKE, PWAC, BOAT, SNOW.
  vtype                     text not null,

  -- Cached | Unavailable. Human-readable, and the second value is load-bearing:
  -- it means the dealer answered and had nothing for this type, which is not
  -- the same as never having been asked.
  status                    text not null default 'Cached',

  -- The whole response, kept so a later question about type or description can
  -- be answered without another round trip.
  properties                jsonb,

  -- Just the names, in the order and casing the server gave them. This is the
  -- part the rate builder reads, and the casing matters: `warranty` is
  -- lowercase for MCYC and ATV and capitalised as `Warranty` for UTV, BIKE and
  -- AUTO. That is TecAssured's inconsistency, observed directly, and storing
  -- their spelling is what stops us having to encode the exceptions.
  property_names            text[] not null default '{}',

  cached_at                 timestamptz,
  error_message             text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

alter table fni.store_rate_properties
  drop constraint if exists chk_store_rate_properties_status;
alter table fni.store_rate_properties
  add constraint chk_store_rate_properties_status
  check (status in ('Cached', 'Unavailable'));

comment on table fni.store_rate_properties is
  'Per store, per vehicle type: the property names /rate/requiredproperties says '
  'that dealer needs in order to rate. The rate request is built from this.';

comment on column fni.store_rate_properties.property_names is
  'Property names in the server''s own spelling. Casing is deliberate: TecAssured '
  'returns `warranty` for MCYC and ATV and `Warranty` for UTV, BIKE and AUTO.';

comment on column fni.store_rate_properties.status is
  'Cached = the dealer answered with properties. Unavailable = the dealer '
  'answered with none, so this vehicle type is not rateable there.';

create unique index if not exists store_rate_properties_account_vtype
  on fni.store_rate_properties (store_provider_account_id, vtype);

-- fni is service_role only and nothing here changes that.
alter table fni.store_rate_properties enable row level security;
revoke all on fni.store_rate_properties from anon, authenticated;
grant all on fni.store_rate_properties to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The old cache goes
-- ─────────────────────────────────────────────────────────────────────────
--
-- Both columns were added by 0009 and never held a row: the endpoint that
-- would have filled them does not exist, so there is nothing to migrate.

alter table fni.store_provider_accounts drop column if exists vehicle_types_cache;
alter table fni.store_provider_accounts drop column if exists vehicle_types_cached_at;
