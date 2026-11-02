-- 0051_rate_form_codes.sql
--
-- The provider's coded values, as its form last stated them.
--
-- The provider's form defines a code for each choice in three fields:
-- new.used (N New, U Used), finance.type (N None, F Loan, B Balloon,
-- L Lease) and fuel.type (G Gasoline, E Electric, D Diesel). PS sent the
-- labels, and the provider ignored them: probes on deal 15063 (fni.rate_probes,
-- 2026-11-02) returned New programs only with new.used "N", and GAP only with
-- finance.type "F".
--
-- The form comes back inside every quote, and is not served anywhere else.
-- So each rating keeps the coded fields the form stated, per store account and
-- vehicle type, and the next rating reads them to code its request:
--
--   store_rate_properties.form_codes     {"new.used": [{"key": "N", "value": "New"}, ...], ...}
--                                        Null until a quote for this vehicle
--                                        type has been seen; the provider's
--                                        documented codes are used until then.
--   store_rate_properties.form_codes_at  when that quote came back.
--
-- Additive only: two nullable columns. No existing value changes, nothing
-- dropped.

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
       and c.relname = 'store_rate_properties'
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on fni.store_rate_properties. Nothing was changed.';
  end if;
end $$;

alter table fni.store_rate_properties add column if not exists form_codes jsonb;
alter table fni.store_rate_properties add column if not exists form_codes_at timestamptz;

comment on column fni.store_rate_properties.form_codes is
  'The coded fields the provider''s form last stated for this account and vehicle type: {"new.used": [{"key": "N", "value": "New"}, ...]}. Null: none seen yet.';
comment on column fni.store_rate_properties.form_codes_at is
  'When the quote carrying form_codes came back.';

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261102150000',
  '0051_rate_form_codes',
  array['The provider''s coded values as its form last stated them: store_rate_properties.form_codes, form_codes_at. See supabase/migrations/0051_rate_form_codes.sql.'],
  'claude'
);

commit;
