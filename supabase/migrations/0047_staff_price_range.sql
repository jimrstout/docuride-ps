-- 0047_staff_price_range.sql
--
-- The staff price range as an explicit manager setting (docs/multi-provider.md
-- section 29). Additive only: three nullable or defaulted columns. No existing
-- value changes, nothing dropped.
--
--   pricing_rules.band_reviewed_at, band_reviewed_by
--                     when a manager last saved this band in Administration >
--                     Pricing, and who. Null: the band still has the values
--                     it was set up with, never deliberately chosen, and
--                     Administration > Pricing says so until a manager saves
--                     it. The values themselves are not touched here.
--   session_menu_prices.below_band
--                     a deal price below the staff minimum markup, allowed by
--                     a manager with a reason (approved_by, reason), as above
--                     the band already is. Never below dealer cost.

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
       and c.relname in ('pricing_rules', 'session_menu_prices')
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on an fni table this migration changes. Nothing was changed.';
  end if;
end $$;

alter table fni.pricing_rules add column if not exists band_reviewed_at timestamptz;
alter table fni.pricing_rules add column if not exists band_reviewed_by text;

comment on column fni.pricing_rules.band_reviewed_at is
  'When a manager last saved this band in Administration > Pricing. Null: still the setup values, never reviewed.';
comment on column fni.pricing_rules.band_reviewed_by is
  'The manager who last saved this band.';

alter table fni.session_menu_prices add column if not exists below_band boolean not null default false;

comment on column fni.session_menu_prices.below_band is
  'Priced below the staff minimum markup, allowed by a manager (approved_by) with a reason. Never below dealer cost.';

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261101120000',
  '0047_staff_price_range',
  array['The staff price range as a manager setting: pricing_rules.band_reviewed_at, band_reviewed_by; session_menu_prices.below_band. See supabase/migrations/0047_staff_price_range.sql.'],
  'claude'
);

commit;
