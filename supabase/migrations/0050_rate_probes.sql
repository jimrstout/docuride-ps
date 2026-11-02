-- 0050_rate_probes.sql
--
-- Rating probes: a deal rated on the provider's QA server with one or two
-- request values changed, kept apart from the deal's own rating.
--
-- Why: the provider's form defines coded values (new.used N=New, U=Used;
-- finance.type N=None, F=Loan, B=Balloon, L=Lease) and PS sends the labels.
-- No stored rating has ever returned a New program or GAP. A probe answers
-- whether the codes change that, without touching the deal.
--
-- A probe is requested by inserting a row here; the same SQL statement posts
-- its id and one-time token to the fni-rate-probe Edge Function through
-- pg_net. The function runs a row only while it is Requested, recent, and the
-- token matches, and spends the token as it starts. Nothing outside the
-- database can start one: no CRM, customer or public path.
--
-- The function writes only this table. It never writes fni.sessions,
-- fni.rated_offers or fni.selected_products.
--
--   session_id        the deal probed. No foreign key, so this migration takes
--                     no lock on fni.sessions.
--   label             "A", "B": the probe's name in the report.
--   overrides         the request values changed, by provider property name:
--                     {"new.used": "N", "finance.type": "F"}. Only new.used and
--                     finance.type are accepted.
--   token             one-time, made by the database, cleared when the probe
--                     starts.
--   status            Requested, Running, Done or Failed.
--   request_payload,
--   response_payload  what was sent to the provider and what came back.
--   error_detail      why a probe failed, in plain English.
--
-- Additive only: one new table. Nothing existing changes, nothing dropped.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ── Lock check ──────────────────────────────────────────────────────────
-- The table is new. What it could collide with is other schema work in fni
-- under way: any exclusive lock another session holds on an fni table.
do $$
begin
  if exists (
    select 1
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'fni'
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on an fni table. Nothing was changed.';
  end if;
end $$;

create table if not exists fni.rate_probes (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null,
  label            text not null,
  overrides        jsonb not null,
  token            uuid default gen_random_uuid(),
  status           text not null default 'Requested'
                   check (status in ('Requested', 'Running', 'Done', 'Failed')),
  requested_by     text not null,
  requested_at     timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  environment      text,
  request_payload  jsonb,
  response_payload jsonb,
  error_detail     text
);

create index if not exists rate_probes_session on fni.rate_probes (session_id, requested_at desc);

alter table fni.rate_probes enable row level security;

comment on table fni.rate_probes is
  'Rating probes on the provider QA server, kept apart from the deal''s own rating. Written only by fni-rate-probe. See supabase/migrations/0050_rate_probes.sql.';

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261102140000',
  '0050_rate_probes',
  array['Rating probes kept apart from the deal''s rating: fni.rate_probes. See supabase/migrations/0050_rate_probes.sql.'],
  'claude'
);

commit;
