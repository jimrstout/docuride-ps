-- 0036_session_events.sql
--
-- A plain record of notable things done to a session, one row each.
--
-- First used by the co-buyer field probe (_shared/cobuyer-probe.ts), which
-- writes "Co-buyer field probe sent" with the batch and the marker table
-- before the test submit goes out, so there is a record of exactly what was
-- sent even if TecAssured never answers. Markers only: no names, no CRM data.
--
-- Written by Edge Functions with the service role only. Additive only.

create table if not exists fni.session_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references fni.sessions(id) on delete cascade,
  event text not null check (btrim(event) <> ''),
  detail jsonb,
  created_at timestamptz not null default now(),
  created_by text
);

create index if not exists session_events_session_idx on fni.session_events (session_id, created_at);

comment on table fni.session_events is
  'Notable things done to a session, in plain English, one row each. Written by Edge Functions only.';

alter table fni.session_events enable row level security;
grant select, insert on fni.session_events to service_role;
