-- 0041_deal_jacket_folders.sql
--
-- File contracts to the Deal Jacket when zoho-sync sees the deal's folder IDs.
--
-- The CRM Flow "Generate Contract Documents" writes Deal_Jacket_Folder_ID,
-- Supporting_Documents_Folder_ID and Signed_Documents_Folder_ID to the
-- DocuRide record, which fires zoho-sync. zoho-sync now keeps them on the
-- deal's session and, once the Deal Jacket and Signed Documents folder IDs
-- are both known, files the session's waiting contracts there.
--
--   fni.sessions            the three folder IDs, one set per deal, and the
--                           last Deal Jacket and Signed Documents folder IDs
--                           the CRM sent, so a warning is logged once per new
--                           situation rather than on every sync.
--   fni.agreement_products  which folder each contract was filed into, and a
--                           claim taken just before filing, so two callers
--                           (the sync and a Get document) cannot file the same
--                           contract at once. The filing itself is already
--                           recorded here: workdrive_file_id,
--                           workdrive_file_name, workdrive_saved_at and
--                           document_status.
--   fni.record_deal_folders writes a deal's folder IDs under a row lock, so
--                           the webhook and the five-minute sweeper cannot
--                           both see them arrive. It says what happened to the
--                           Deal Jacket and Signed Documents folder IDs, and
--                           whether the two folders filing needs became
--                           complete with this write. zoho-sync files when
--                           they did, whichever of the two came last.
--
-- The rules record_deal_folders applies, to the Deal Jacket and the Signed
-- Documents folder ID alike (Signed Documents is part of every filed
-- contract's file name, so it must not move under filed contracts):
--   The first value the CRM sends is stored.
--   A blank from the CRM never clears a stored ID.
--   A different value from the CRM is not applied: the stored ID stays and
--   nothing is refiled.
--   A blank or a different value is logged as a session event, signed
--   System, once: only when it differs from the last value the CRM sent.
--   zoho-sync runs on every edit of the deal, and the same warning must not
--   repeat on each one.
-- The Supporting Documents folder ID is not used by PS: it takes each new
-- value the CRM sends, and a blank never clears it.
-- No session for the deal: nothing is written and no row is returned.
--
-- Session events never carry a folder ID. Additive only: no existing row
-- changes, and public.deals and the dc schema are not touched.

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
       and c.relname in ('sessions', 'agreement_products', 'session_events')
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on fni.sessions, fni.agreement_products or fni.session_events. Nothing was changed.';
  end if;
end $$;

-- ── The deal's folders, on its session ──────────────────────────────────

alter table fni.sessions add column if not exists deal_jacket_folder_id text;
alter table fni.sessions add column if not exists supporting_documents_folder_id text;
alter table fni.sessions add column if not exists signed_documents_folder_id text;
alter table fni.sessions add column if not exists crm_deal_jacket_folder_id text;
alter table fni.sessions add column if not exists crm_signed_documents_folder_id text;

comment on column fni.sessions.deal_jacket_folder_id is
  'The deal''s WorkDrive Deal Jacket folder, the first one the CRM sent (Deal_Jacket_Folder_ID, via zoho-sync). Never cleared by a blank; a later different value is logged, not applied.';
comment on column fni.sessions.supporting_documents_folder_id is
  'The deal''s WorkDrive Supporting Documents folder, from Supporting_Documents_Folder_ID via zoho-sync. Not used by PS. Never cleared by a blank.';
comment on column fni.sessions.signed_documents_folder_id is
  'The deal''s WorkDrive Signed Documents folder, the first one the CRM sent (Signed_Documents_Folder_ID, via zoho-sync). Part of each filed contract''s file name. Never cleared by a blank; a later different value is logged, not applied.';
comment on column fni.sessions.crm_deal_jacket_folder_id is
  'The last Deal_Jacket_Folder_ID the CRM sent, null for a blank. Only so a blank or a different value is logged once, not on every sync.';
comment on column fni.sessions.crm_signed_documents_folder_id is
  'The last Signed_Documents_Folder_ID the CRM sent, null for a blank. Only so a blank or a different value is logged once, not on every sync.';

-- ── Each contract's filing ──────────────────────────────────────────────

alter table fni.agreement_products add column if not exists deal_jacket_folder_id text;
alter table fni.agreement_products add column if not exists filing_started_at timestamptz;

comment on column fni.agreement_products.deal_jacket_folder_id is
  'The Deal Jacket folder this contract''s document was filed into. Set with workdrive_file_id.';
comment on column fni.agreement_products.filing_started_at is
  'When a filing of this contract to the Deal Jacket began, while it is under way. Cleared when it ends. Stops a second filing of the same contract; a claim older than a few minutes is taken to be abandoned.';

-- ── A deal's folder IDs, from the CRM ───────────────────────────────────

create or replace function fni.record_deal_folders(
  p_zoho_deal_id text,
  p_deal_jacket text,
  p_supporting text,
  p_signed text
)
returns table (
  session_id uuid,
  deal_jacket_outcome text,
  signed_documents_outcome text,
  folders_became_ready boolean
)
language plpgsql
set search_path = ''
as $$
declare
  s record;
  after_jacket text;
  after_signed text;
  incoming_jacket text := nullif(pg_catalog.btrim(p_deal_jacket), '');
  incoming_supporting text := nullif(pg_catalog.btrim(p_supporting), '');
  incoming_signed text := nullif(pg_catalog.btrim(p_signed), '');
  jacket_outcome text;
  signed_outcome text;
begin
  if nullif(pg_catalog.btrim(p_zoho_deal_id), '') is null then
    return;
  end if;

  -- One session per CRM deal (sessions_one_per_zoho_deal). Locked, so a
  -- second sync of the same deal waits and then sees the stored values.
  select ss.id,
         ss.deal_jacket_folder_id, ss.signed_documents_folder_id,
         ss.crm_deal_jacket_folder_id, ss.crm_signed_documents_folder_id
    into s
    from fni.sessions ss
   where ss.zoho_deal_id = pg_catalog.btrim(p_zoho_deal_id)
   for update;
  if not found then
    return;
  end if;

  jacket_outcome :=
    case
      when s.deal_jacket_folder_id is null and incoming_jacket is not null then 'Set'
      when s.deal_jacket_folder_id is not null and incoming_jacket is null then 'Blank from CRM'
      when s.deal_jacket_folder_id is not null and incoming_jacket <> s.deal_jacket_folder_id then 'Changed'
      else 'Unchanged'
    end;
  signed_outcome :=
    case
      when s.signed_documents_folder_id is null and incoming_signed is not null then 'Set'
      when s.signed_documents_folder_id is not null and incoming_signed is null then 'Blank from CRM'
      when s.signed_documents_folder_id is not null and incoming_signed <> s.signed_documents_folder_id then 'Changed'
      else 'Unchanged'
    end;

  -- The first value is kept: a blank never clears it, and a different value
  -- is not applied. The last values the CRM sent are always recorded.
  update fni.sessions ss
     set deal_jacket_folder_id = coalesce(ss.deal_jacket_folder_id, incoming_jacket),
         signed_documents_folder_id = coalesce(ss.signed_documents_folder_id, incoming_signed),
         supporting_documents_folder_id = coalesce(incoming_supporting, ss.supporting_documents_folder_id),
         crm_deal_jacket_folder_id = incoming_jacket,
         crm_signed_documents_folder_id = incoming_signed
   where ss.id = s.id
  returning ss.deal_jacket_folder_id, ss.signed_documents_folder_id
       into after_jacket, after_signed;

  -- Logged once per new situation: only when the CRM sent something other
  -- than it sent last time.
  if jacket_outcome in ('Blank from CRM', 'Changed')
     and incoming_jacket is distinct from s.crm_deal_jacket_folder_id then
    insert into fni.session_events (session_id, event, detail, created_by)
    values (
      s.id,
      case jacket_outcome
        when 'Blank from CRM' then 'Deal Jacket folder cleared in the CRM. The folder already recorded was kept.'
        else 'Deal Jacket folder changed in the CRM. The folder already recorded was kept and no contract was refiled.'
      end,
      pg_catalog.jsonb_build_object('folder', 'Deal Jacket', 'outcome', jacket_outcome),
      'System'
    );
  end if;
  if signed_outcome in ('Blank from CRM', 'Changed')
     and incoming_signed is distinct from s.crm_signed_documents_folder_id then
    insert into fni.session_events (session_id, event, detail, created_by)
    values (
      s.id,
      case signed_outcome
        when 'Blank from CRM' then 'Signed Documents folder cleared in the CRM. The folder already recorded was kept.'
        else 'Signed Documents folder changed in the CRM. The folder already recorded was kept and no contract was refiled.'
      end,
      pg_catalog.jsonb_build_object('folder', 'Signed Documents', 'outcome', signed_outcome),
      'System'
    );
  end if;

  session_id := s.id;
  deal_jacket_outcome := jacket_outcome;
  signed_documents_outcome := signed_outcome;
  folders_became_ready :=
    not (s.deal_jacket_folder_id is not null and s.signed_documents_folder_id is not null)
    and after_jacket is not null and after_signed is not null;
  return next;
end
$$;

revoke all on function fni.record_deal_folders(text, text, text, text) from public, anon, authenticated;
grant execute on function fni.record_deal_folders(text, text, text, text) to service_role;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261029120000',
  '0041_deal_jacket_folders',
  array['Deal Jacket folder IDs on fni.sessions (and the last ones the CRM sent), the filing folder and claim on fni.agreement_products, and fni.record_deal_folders. See supabase/migrations/0041_deal_jacket_folders.sql.'],
  'claude'
);

commit;
