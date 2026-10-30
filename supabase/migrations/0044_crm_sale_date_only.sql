-- 0044_crm_sale_date_only.sql
--
-- The CRM sale date is the only sale date (docs/multi-provider.md section 24).
-- The DocuRide record's Sale_Date is changed in the CRM only. PS keeps the
-- last value it read in fni.sessions.sale_date, to notice changes, and never
-- edits it. Everything else follows from it, in the store's time zone.
--
--   1. The session is open through 23:59:59 on its sale date at the store.
--      The expiry trigger now fires on insert and whenever sale_date changes;
--      a session with no sale date lasts to the end of the store's today, as
--      before. Every session's expiry is set again from its sale date here.
--   2. Staff sale dates are retired. Each staff_edits.sale_date is removed,
--      and the session event "Staff sale date retired: the CRM sale date is
--      used" (System) keeps what it said and what the CRM said.
--   3. planned_sale_date is no longer read or written. The column stays, with
--      its values, unused: dropping it needs Jim's say-so.
--   4. agreement_products.contract_sale_date: the sale date a contract was
--      sent with, recorded at submit. PS did not record it before, so existing
--      live contracts take the day they were submitted at the store, the only
--      day Submit allowed since migration 0038.
--   5. fni.record_crm_sale_date: one place that records a Sale_Date read from
--      the CRM (zoho-sync, Details, rating, submit). It writes only if the
--      copy still holds the value the caller read, adds the event "Sale date
--      changed in the CRM from <old> to <new>" (System), and, when the caller
--      found that the month rule calls for it (_shared/sale-date.ts,
--      saleDateMoveNeedsRerate), marks the rated offers out of date and sends a
--      verified deal back to Needs Verification. A New unit's in-service date
--      follows its sale date.
--
-- Deal 14957 is left out of every data change here (2 and 4, and the expiry
-- in 1), as in migration 0039. Nothing is dropped: Renew for Today's
-- functions (fni.renew_session, fni.session_renew_targets) and
-- fni.session_expiry_day stay, unused.

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
       and c.relname in ('sessions', 'agreement_products', 'rated_offers', 'session_events')
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on an fni table this migration changes. Nothing was changed.';
  end if;
end $$;

-- ── 1. Open through the sale date ───────────────────────────────────────

create or replace function fni.session_sale_day_end(p_store uuid, p_sale date)
returns timestamptz
language sql stable
set search_path = ''
as $$
  select fni.store_day_end(p_store, coalesce(p_sale, fni.store_today(p_store)))
$$;

revoke all on function fni.session_sale_day_end(uuid, date) from public, anon, authenticated;
grant execute on function fni.session_sale_day_end(uuid, date) to service_role;

create or replace function fni.sessions_set_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.expires_at := fni.session_sale_day_end(new.store_id, new.sale_date);
  return new;
end
$$;

create or replace trigger sessions_set_expiry
  before insert or update of sale_date, store_id on fni.sessions
  for each row execute function fni.sessions_set_expiry();

update fni.sessions s
   set expires_at = fni.session_sale_day_end(s.store_id, s.sale_date)
 where coalesce(s.deal_number, '') <> '14957'
   and s.expires_at is distinct from fni.session_sale_day_end(s.store_id, s.sale_date);

comment on column fni.sessions.sale_date is
  'The last Sale_Date PS read from the CRM DocuRide record. Written only from a CRM read (fni.record_crm_sale_date, session start and refresh). Never edited in PS.';
comment on column fni.sessions.expires_at is
  'Open through 23:59:59 on sale_date at the store (fni.sessions_set_expiry), or the end of the store''s today with no sale date.';
comment on column fni.sessions.planned_sale_date is
  'Retired by migration 0044: no longer read or written. The CRM sale date is the only sale date.';

-- ── 2. Staff sale dates retired ─────────────────────────────────────────

insert into fni.session_events (session_id, event, detail, created_by)
select s.id,
       'Staff sale date retired: the CRM sale date is used',
       jsonb_build_object(
         'staff_value', s.staff_edits -> 'sale_date' ->> 'value',
         'crm_value', s.sale_date,
         'edited_by', s.staff_edits -> 'sale_date' ->> 'edited_by'
       ),
       'System'
  from fni.sessions s
 where s.staff_edits ? 'sale_date'
   and coalesce(s.deal_number, '') <> '14957';

update fni.sessions s
   set staff_edits = s.staff_edits - 'sale_date'
 where s.staff_edits ? 'sale_date'
   and coalesce(s.deal_number, '') <> '14957';

-- ── 4. The date a contract was sent with ────────────────────────────────

alter table fni.agreement_products add column if not exists contract_sale_date date;

comment on column fni.agreement_products.contract_sale_date is
  'The sale date this contract was sent to the provider with, recorded by fni-contract-submit. Contracts before migration 0044 took the day they were submitted at the store.';

update fni.agreement_products ap
   set contract_sale_date = (ap.created_at at time zone fni.store_time_zone(s.store_id))::date
  from fni.agreements a
  join fni.sessions s on s.id = a.session_id
 where a.id = ap.agreement_id
   and ap.contract_sale_date is null
   and ap.status in ('Live', 'Submit Status Unknown')
   and coalesce(s.deal_number, '') <> '14957';

-- ── 5. Recording a Sale_Date read from the CRM ─────────────────────────

create or replace function fni.record_crm_sale_date(
  p_session uuid,
  p_expected date,
  p_new date,
  p_rerate boolean
)
returns table (outcome text, old_sale_date date, new_sale_date date)
language plpgsql
set search_path = ''
as $$
declare
  s fni.sessions%rowtype;
  fmt constant text := 'FMDD Mon YYYY';
begin
  select * into s from fni.sessions where id = p_session for update;
  if not found then
    return query select 'No session'::text, null::date, null::date;
    return;
  end if;
  if s.sale_date is not distinct from p_new then
    return query select 'Unchanged'::text, s.sale_date, p_new;
    return;
  end if;
  -- Someone recorded another value since the caller read it: theirs stands,
  -- and the caller reads again next time.
  if s.sale_date is distinct from p_expected then
    return query select 'Changed meanwhile'::text, s.sale_date, p_new;
    return;
  end if;

  update fni.sessions
     set sale_date = p_new,
         -- A New unit's in-service date is its sale date, and moves with it.
         in_service_date = case
           when lower(trim(coalesce(s.condition, ''))) = 'new'
                and (s.in_service_date is null or s.in_service_date is not distinct from s.sale_date)
             then p_new
           else s.in_service_date
         end,
         verification_state = case when p_rerate and s.verification_state = 'Verified' then 'Needs Verification' else s.verification_state end,
         verified_at = case when p_rerate and s.verification_state = 'Verified' then null else s.verified_at end,
         verified_by = case when p_rerate and s.verification_state = 'Verified' then null else s.verified_by end,
         verified_snapshot = case when p_rerate and s.verification_state = 'Verified' then null else s.verified_snapshot end
   where id = p_session;

  if p_rerate then
    update fni.rated_offers set out_of_date = true where session_id = p_session;
  end if;

  insert into fni.session_events (session_id, event, detail, created_by)
  values (
    p_session,
    'Sale date changed in the CRM from ' || coalesce(to_char(s.sale_date, fmt), 'none') ||
      ' to ' || coalesce(to_char(p_new, fmt), 'none'),
    jsonb_build_object('from', s.sale_date, 'to', p_new, 'rerate_needed', p_rerate),
    'System'
  );

  return query select 'Changed'::text, s.sale_date, p_new;
end
$$;

revoke all on function fni.record_crm_sale_date(uuid, date, date, boolean) from public, anon, authenticated;
grant execute on function fni.record_crm_sale_date(uuid, date, date, boolean) to service_role;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261030200000',
  '0044_crm_sale_date_only',
  array['The CRM sale date is the only sale date: expiry from sale_date, staff sale dates retired, agreement_products.contract_sale_date, fni.record_crm_sale_date. See supabase/migrations/0044_crm_sale_date_only.sql.'],
  'claude'
);

commit;
