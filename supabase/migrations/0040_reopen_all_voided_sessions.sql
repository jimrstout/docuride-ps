-- 0040_reopen_all_voided_sessions.sql
--
-- One-time data change: reopen sessions left Finalized after every contract
-- on them was voided. Data only; no schema change.
--
-- From now on the void that leaves a session with no live contract reopens
-- it (_shared/session-reopen.ts). This applies the same rule, once, to the
-- sessions voided before that existed: status Finalized, submit idle, at
-- least one contract, and none Live or Submit Status Unknown. The voids
-- never change fni.agreements.status, so the contracts themselves decide, by
-- the rule the contract panels lock on.
--
-- Checked on 28 Oct 2026, deal 14957 excluded and never read:
--
--   15029  reopened. Its only contract, VLBT3440876-42153, is Voided.
--   13759  left Finalized. Its four contracts are all Live.
--
-- Only the status changes: selected products, rated offers, verification,
-- dates and prices are untouched. Each guard must still hold when this runs.

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
       and c.relname in ('sessions', 'agreements', 'agreement_products', 'session_events')
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on fni.sessions, fni.agreements, fni.agreement_products or fni.session_events. Nothing was changed.';
  end if;
end $$;

-- ── Reopen, with every guard re-checked ────────────────────────────────
with reopened as (
  update fni.sessions s
     set status = 'Products Selected'
   where s.id = 'e6b500c0-1b6a-4024-b6f0-97eff0d1d2e7'
     and s.deal_number = '15029'
     and s.deal_number is distinct from '14957'
     and s.status = 'Finalized'
     and s.submit_state = 'Idle'
     and s.updated_at = timestamptz '2026-10-28 16:08:38.569396+00'
     and exists (
       select 1 from fni.agreement_products ap join fni.agreements a on a.id = ap.agreement_id
        where a.session_id = s.id
     )
     and not exists (
       select 1 from fni.agreement_products ap join fni.agreements a on a.id = ap.agreement_id
        where a.session_id = s.id
          and ap.status in ('Live', 'Submit Status Unknown')
     )
  returning s.id
)
insert into fni.session_events (session_id, event, detail, created_by)
select r.id,
       'Session reopened: all contracts voided',
       jsonb_build_object('from', 'Finalized', 'to', 'Products Selected', 'migration', '0040_reopen_all_voided_sessions'),
       'System'
  from reopened r;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261028180000',
  '0040_reopen_all_voided_sessions',
  array['One-time data change: session for deal 15029 reopened to Products Selected (its only contract is voided). See supabase/migrations/0040_reopen_all_voided_sessions.sql.'],
  'claude'
);

commit;
