-- 0059_ps_stores.sql
--
-- PS's own settings per store, in fni rather than on public.stores (the CRM's
-- store record, synced by DocuRide DC):
--
--   uses_ps    whether DocuRide PS is turned on for the store: a session can
--              start only for a store that uses PS, and only those stores are
--              offered on Sessions and Staff. Sessions already started stay
--              as they are. Set on Administration > Stores.
--   time_zone  the store's IANA time zone, which decides when its day ends:
--              session expiry (11:59 PM there) and the sale-day checks. Moved
--              here from public.stores.time_zone, which PS stops reading and
--              writing. That column is left exactly as it is.
--
-- Seed: one row per store. PS starts on for the four All Seasons Powersports
-- stores Jim named; every other store starts off. Each store's time zone is
-- copied from public.stores.time_zone.
--
-- fni.store_time_zone, which every store-day function goes through (session
-- expiry, renewal, the sale-day end), now reads fni.ps_stores. Replaced in
-- place, not dropped. Additive otherwise: one new table, nothing dropped,
-- public.stores only read and referenced.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ── Lock check ──────────────────────────────────────────────────────────
-- The foreign key takes a brief SHARE ROW EXCLUSIVE lock on public.stores.
do $$
begin
  if exists (
    select 1
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
     where l.pid <> pg_backend_pid()
       and l.mode in ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and (n.nspname = 'fni' or (n.nspname = 'public' and c.relname = 'stores'))
  ) then
    raise exception 'A conflicting lock is held on an fni table or on public.stores. Nothing was changed.';
  end if;
end $$;

create table if not exists fni.ps_stores (
  store_id   uuid primary key references public.stores(id) on delete no action,
  uses_ps    boolean not null default false,
  time_zone  text not null default 'America/New_York'
    constraint ps_stores_time_zone_named check (time_zone ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$'),
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table fni.ps_stores is
  'PS settings per store: whether DocuRide PS is turned on there, and its time zone. Edited on Administration > Stores.';
comment on column fni.ps_stores.uses_ps is
  'DocuRide PS is turned on for this store: sessions can start, and it is offered on Sessions and Staff. Existing sessions are unaffected.';
comment on column fni.ps_stores.time_zone is
  'The store''s IANA time zone (America/New_York). Decides when its day ends: session expiry at 11:59 PM there, and the sale-day checks.';

alter table fni.ps_stores enable row level security;
revoke all on fni.ps_stores from anon, authenticated;

-- ── Seed: every store, with its time zone; PS on for the four ───────────
insert into fni.ps_stores (store_id, uses_ps, time_zone, updated_by)
select s.id,
       s.zoho_store_location in (
         'All Seasons Powersports, Barboursville/Huntington',
         'All Seasons Powersports, Charleston',
         'All Seasons Powersports, New Martinsville',
         'All Seasons Powersports, Parkersburg'
       ),
       coalesce(s.time_zone, 'America/New_York'),
       'claude'
  from public.stores s
on conflict (store_id) do nothing;

do $$
declare
  missing int;
  turned_on int;
begin
  select count(*) into missing from public.stores s where not exists (select 1 from fni.ps_stores p where p.store_id = s.id);
  select count(*) into turned_on from fni.ps_stores where uses_ps;
  if missing > 0 then
    raise exception '% store(s) have no PS row. Nothing was changed.', missing;
  end if;
  if turned_on <> 4 then
    raise exception 'Expected 4 stores turned on, found %. Nothing was changed.', turned_on;
  end if;
end $$;

-- ── Every store-day function reads the time zone from here now ──────────
create or replace function fni.store_time_zone(p_store uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((select p.time_zone from fni.ps_stores p where p.store_id = p_store), 'America/New_York')
$$;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261108231000',
  '0059_ps_stores',
  array['PS settings per store in fni: fni.ps_stores (uses_ps, time_zone), seeded with PS on for four stores and each store''s time zone; fni.store_time_zone reads it. public.stores is not changed. See supabase/migrations/0059_ps_stores.sql.'],
  'claude'
);

commit;
