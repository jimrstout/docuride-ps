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
--   fni.sessions            the three folder IDs, one set per deal.
--   fni.agreement_products  which folder each contract was filed into, and a
--                           claim taken just before filing, so two callers
--                           (the sync and a Get document) cannot file the same
--                           contract at once. The filing itself is already
--                           recorded here: workdrive_file_id,
--                           workdrive_file_name, workdrive_saved_at and
--                           document_status.
--   fni.record_deal_folders writes a deal's folder IDs and says what happened
--                           to the Deal Jacket folder ID, and whether the
--                           folders filing needs (Deal Jacket and Signed
--                           Documents, which is part of each file name) became
--                           complete with this write. Under a row lock, so the
--                           webhook and the five-minute sweeper cannot both see
--                           them arrive. zoho-sync files when they became
--                           complete, whichever of the two came last.
--
-- The rules record_deal_folders applies:
--   A blank from the CRM never clears a stored folder ID. For the Deal Jacket
--   folder ID that is logged as a session event.
--   A Deal Jacket folder ID that changes to a different value keeps the stored
--   one, is logged as a session event, and nothing is refiled.
--   No session for the deal: nothing is written and no row is returned.
--
-- Session events never carry a folder ID. Additive only: no existing row
-- changes, and public.deals and the dc schema are not touched.

alter table fni.sessions add column if not exists deal_jacket_folder_id text;
alter table fni.sessions add column if not exists supporting_documents_folder_id text;
alter table fni.sessions add column if not exists signed_documents_folder_id text;

comment on column fni.sessions.deal_jacket_folder_id is
  'The deal''s WorkDrive Deal Jacket folder, from the CRM record''s Deal_Jacket_Folder_ID via zoho-sync. Never cleared by a blank from the CRM; a later different value is logged, not applied.';
comment on column fni.sessions.supporting_documents_folder_id is
  'The deal''s WorkDrive Supporting Documents folder, from Supporting_Documents_Folder_ID via zoho-sync. Never cleared by a blank from the CRM.';
comment on column fni.sessions.signed_documents_folder_id is
  'The deal''s WorkDrive Signed Documents folder, from Signed_Documents_Folder_ID via zoho-sync. Part of each contract''s file name in the Deal Jacket. Never cleared by a blank from the CRM.';

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
returns table (session_id uuid, deal_jacket_outcome text, folders_became_ready boolean)
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
  outcome text;
begin
  if nullif(pg_catalog.btrim(p_zoho_deal_id), '') is null then
    return;
  end if;

  -- One session per CRM deal (sessions_one_per_zoho_deal). Locked, so a
  -- second sync of the same deal waits and then sees the stored value.
  select ss.id, ss.deal_jacket_folder_id, ss.signed_documents_folder_id
    into s
    from fni.sessions ss
   where ss.zoho_deal_id = pg_catalog.btrim(p_zoho_deal_id)
   for update;
  if not found then
    return;
  end if;

  outcome :=
    case
      when s.deal_jacket_folder_id is null and incoming_jacket is not null then 'Set'
      when s.deal_jacket_folder_id is not null and incoming_jacket is null then 'Blank from CRM'
      when s.deal_jacket_folder_id is not null and incoming_jacket <> s.deal_jacket_folder_id then 'Changed'
      else 'Unchanged'
    end;

  -- A blank never clears a stored ID, and a changed Deal Jacket ID is not
  -- applied: the stored one stays.
  update fni.sessions ss
     set deal_jacket_folder_id = coalesce(ss.deal_jacket_folder_id, incoming_jacket),
         supporting_documents_folder_id = coalesce(incoming_supporting, ss.supporting_documents_folder_id),
         signed_documents_folder_id = coalesce(incoming_signed, ss.signed_documents_folder_id)
   where ss.id = s.id
  returning ss.deal_jacket_folder_id, ss.signed_documents_folder_id
       into after_jacket, after_signed;

  if outcome = 'Blank from CRM' then
    insert into fni.session_events (session_id, event, detail, created_by)
    values (s.id, 'Deal Jacket folder cleared in the CRM. The folder already recorded was kept.',
            pg_catalog.jsonb_build_object('outcome', outcome), 'zoho-sync');
  elsif outcome = 'Changed' then
    insert into fni.session_events (session_id, event, detail, created_by)
    values (s.id, 'Deal Jacket folder changed in the CRM. The folder already recorded was kept and no contract was refiled.',
            pg_catalog.jsonb_build_object('outcome', outcome), 'zoho-sync');
  end if;

  session_id := s.id;
  deal_jacket_outcome := outcome;
  folders_became_ready :=
    not (s.deal_jacket_folder_id is not null and s.signed_documents_folder_id is not null)
    and after_jacket is not null and after_signed is not null;
  return next;
end
$$;

revoke all on function fni.record_deal_folders(text, text, text, text) from public, anon, authenticated;
grant execute on function fni.record_deal_folders(text, text, text, text) to service_role;
