-- 0043_dx1_check.sql
--
-- The F&I check against DX1 (fni-dx1-check, docs/multi-provider.md section 23):
-- the latest result on the deal's session, and when it was checked, so Details
-- can show it. Additive only: two nullable columns, no existing row changes,
-- nothing dropped.
--
--   dx1_check       { "status": "Nothing to check" | "Match" | "Problems",
--                     "blocking": [ "<line>", ... ], "warnings": [ "<line>", ... ] }
--                   as the CRM's Generate gate last received it
--   dx1_checked_at  when that result was worked out
--
-- PS never writes a CRM field in this work: DX1 stays the source of truth for
-- F&I money, and this only records what PS found when it compared.

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
       and c.relname = 'sessions'
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on fni.sessions. Nothing was changed.';
  end if;
end $$;

alter table fni.sessions add column if not exists dx1_check jsonb;
alter table fni.sessions add column if not exists dx1_checked_at timestamptz;

comment on column fni.sessions.dx1_check is
  'The latest F&I check against DX1: {status, blocking, warnings}, status Nothing to check, Match or Problems. Written by fni-dx1-check.';
comment on column fni.sessions.dx1_checked_at is
  'When the latest F&I check against DX1 was worked out.';

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261030180000',
  '0043_dx1_check',
  array['F&I check against DX1: fni.sessions.dx1_check and dx1_checked_at. See supabase/migrations/0043_dx1_check.sql.'],
  'claude'
);

commit;
