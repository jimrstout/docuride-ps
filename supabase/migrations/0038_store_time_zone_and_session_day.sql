-- 0038_store_time_zone_and_session_day.sql
--
-- A session lasts until the end of the store's day, not for 24 hours.
--
-- A plan link used to expire 24 hours after it was made, and +24h added 24
-- hours each press, so two presses stacked (deal 13437 gained 48 hours). A
-- deal is sold on a day, in a store, so:
--
--   public.stores.time_zone        each store's own zone, set in
--                                  Administration > Stores. New York until set.
--   fni.sessions.planned_sale_date the day the deal is planned to be sold, for
--                                  preparing it the night before. Never sent
--                                  to a provider: the sale date is the deal's.
--
--   A new session expires at 23:59:59 on the store's today, or on the planned
--   sale date when that is later. Renew for Today (fni.renew_session) sets the
--   same moment again, so pressing it twice cannot stack.
--
-- Additive only. Existing sessions keep the expiry they have.

alter table public.stores add column if not exists time_zone text not null default 'America/New_York';

comment on column public.stores.time_zone is
  'The store''s IANA time zone (America/Chicago). Decides when its day ends: session expiry and the sale-date check at submit. Set in Administration > Stores; dc-dealer-sync does not write it.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stores_time_zone_named') then
    alter table public.stores add constraint stores_time_zone_named
      check (time_zone ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$');
  end if;
end $$;

alter table fni.sessions add column if not exists planned_sale_date date;

comment on column fni.sessions.planned_sale_date is
  'The day this deal is planned to be sold, set on Details to prepare it the night before. The session lasts to the end of that day. Never sent to a provider; at submit it must equal the sale date.';

-- ── The store's day ─────────────────────────────────────────────────────

create or replace function fni.store_time_zone(p_store uuid)
returns text
language sql stable
set search_path = ''
as $$
  select coalesce((select s.time_zone from public.stores s where s.id = p_store), 'America/New_York')
$$;

create or replace function fni.store_today(p_store uuid)
returns date
language sql stable
set search_path = ''
as $$
  select (pg_catalog.now() at time zone fni.store_time_zone(p_store))::date
$$;

-- 23:59:59 on that day, in the store's zone.
create or replace function fni.store_day_end(p_store uuid, p_day date)
returns timestamptz
language sql stable
set search_path = ''
as $$
  select ((p_day + 1)::timestamp at time zone fni.store_time_zone(p_store)) - interval '1 second'
$$;

-- The day a session lasts to: the planned sale date when it is still ahead,
-- otherwise the store's today.
create or replace function fni.session_expiry_day(p_store uuid, p_planned date)
returns date
language sql stable
set search_path = ''
as $$
  select greatest(coalesce(p_planned, fni.store_today(p_store)), fni.store_today(p_store))
$$;

-- ── Every new session ends with its store's day ─────────────────────────

create or replace function fni.sessions_set_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.expires_at := fni.store_day_end(new.store_id, fni.session_expiry_day(new.store_id, new.planned_sale_date));
  return new;
end
$$;

create or replace trigger sessions_set_expiry
  before insert on fni.sessions
  for each row execute function fni.sessions_set_expiry();

-- ── Renew for Today ─────────────────────────────────────────────────────
-- Sets the expiry to the end of the session's day. Never adds: a second press
-- writes the same moment.

create or replace function fni.renew_session(p_session uuid)
returns timestamptz
language sql volatile
set search_path = ''
as $$
  update fni.sessions s
     set expires_at = fni.store_day_end(s.store_id, fni.session_expiry_day(s.store_id, s.planned_sale_date))
   where s.id = p_session
  returning s.expires_at
$$;

-- What Renew for Today would set, for the session list: it is offered only
-- when that is later than the expiry the session has.
create or replace function fni.session_renew_targets(p_ids uuid[])
returns table (session_id uuid, renew_to timestamptz, store_today date, time_zone text)
language sql stable
set search_path = ''
as $$
  select s.id,
         fni.store_day_end(s.store_id, fni.session_expiry_day(s.store_id, s.planned_sale_date)),
         fni.store_today(s.store_id),
         fni.store_time_zone(s.store_id)
    from fni.sessions s
   where s.id = any(p_ids)
$$;

revoke all on function fni.store_time_zone(uuid) from public, anon, authenticated;
revoke all on function fni.store_today(uuid) from public, anon, authenticated;
revoke all on function fni.store_day_end(uuid, date) from public, anon, authenticated;
revoke all on function fni.session_expiry_day(uuid, date) from public, anon, authenticated;
revoke all on function fni.sessions_set_expiry() from public, anon, authenticated;
revoke all on function fni.renew_session(uuid) from public, anon, authenticated;
revoke all on function fni.session_renew_targets(uuid[]) from public, anon, authenticated;
grant execute on function fni.store_time_zone(uuid) to service_role;
grant execute on function fni.store_today(uuid) to service_role;
grant execute on function fni.store_day_end(uuid, date) to service_role;
grant execute on function fni.session_expiry_day(uuid, date) to service_role;
grant execute on function fni.renew_session(uuid) to service_role;
grant execute on function fni.session_renew_targets(uuid[]) to service_role;
