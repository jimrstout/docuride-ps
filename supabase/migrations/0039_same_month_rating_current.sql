-- 0039_same_month_rating_current.sql
--
-- One-time data change: bring existing out-of-date offers into line with the
-- same-month rule (PR 53, _shared/sale-date.ts). Data only; no schema change.
--
-- PR 53 stopped a sale date moved within its calendar month from marking a
-- rating out of date, but left existing sessions alone. Jim now wants them in
-- line. For every out-of-date offer the stored rate request was compared with
-- the request the session would send now (scripts/same-month-rating-check.mjs,
-- ratedRequestDiff), holding the provider's own choices at the stored ones.
-- An offer is marked current again only when the sale date is the only input
-- that differs (a New unit's in-service date moving with it counts as part of
-- the move), both dates are in the same month and year, and no Published
-- price sheet starts or ends between them. Run on 28 Oct 2026, deal 14957
-- excluded and never read:
--
--   15029  marked current. Rated on a sale date of 26 Oct 2026; the sale date
--          is now 28 Oct 2026 (staff edit from Renew for Today). Nothing else
--          differs, and its in-service date is unchanged.
--   13437  left out of date. Its sale date has not moved (6 Sep 2026). The one
--          difference is the inservice.date property, which rate requests
--          have carried since this offer was rated and its request did not.
--
-- Verification status is not touched. The offer's prices are not touched.
-- Each guard below must still hold when this runs, so a session that changed
-- after the check is left as it is.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ── Lock check ──────────────────────────────────────────────────────────
-- Nothing else may hold a table-level lock on these tables that would make
-- this wait. Row locks are covered by lock_timeout.
do $$
begin
  if exists (
    select 1
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'fni'
       and c.relname in ('rated_offers', 'sessions', 'session_events')
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on fni.rated_offers, fni.sessions or fni.session_events. Nothing was changed.';
  end if;
end $$;

-- ── The one offer that qualifies, with every guard re-checked ──────────
with kept as (
  update fni.rated_offers r
     set out_of_date = false
    from fni.sessions s, fni.providers p
   where r.session_id = 'e6b500c0-1b6a-4024-b6f0-97eff0d1d2e7'
     and s.id = r.session_id
     and p.id = r.provider_id
     and s.deal_number = '15029'
     and s.deal_number is distinct from '14957'
     and p.adapter = 'TecAssured'
     and r.state = 'Rated'
     and r.out_of_date
     and r.request_payload->>'saleDate' = '2026-10-26'
     and s.sale_date = date '2026-10-26'
     and s.staff_edits->'sale_date'->>'value' = '2026-10-28'
     and s.in_service_date = date '2026-10-26'
     and s.updated_at = timestamptz '2026-10-28 16:08:38.569396+00'
     and not exists (
       select 1
         from fni.price_sheets ps
        where ps.tenant_id = s.tenant_id
          and ps.status = 'Published'
          and (
            (ps.effective_from > date '2026-10-26' and ps.effective_from <= date '2026-10-28')
            or (ps.effective_to is not null and ps.effective_to + 1 > date '2026-10-26' and ps.effective_to + 1 <= date '2026-10-28')
          )
     )
  returning r.session_id
)
insert into fni.session_events (session_id, event, detail, created_by)
select distinct k.session_id,
       'Rating kept current: sale date moved within the same month (26 Oct 2026 to 28 Oct 2026)',
       jsonb_build_object('from', '2026-10-26', 'to', '2026-10-28', 'migration', '0039_same_month_rating_current'),
       'System'
  from kept k;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261028170000',
  '0039_same_month_rating_current',
  array['One-time data change: rated offer for deal 15029 marked current (sale date moved within October). See supabase/migrations/0039_same_month_rating_current.sql.'],
  'claude'
);

commit;
