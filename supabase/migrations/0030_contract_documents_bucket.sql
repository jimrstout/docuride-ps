-- 0030_contract_documents_bucket.sql
--
-- A provider's contract PDF often exists before DocuRide DC has made the
-- deal's WorkDrive folders, which only happens when the full sale documents
-- are generated. So every document is held in a private bucket, fni-contracts,
-- and moved into the Deal Jacket once the folders exist
-- (fni-documents-to-deal-jacket). See docs/multi-provider.md, section 13.
--
--   document_storage_path  Where the PDF is held: {session id}/{file name}.
--                          Kept after it moves; nothing is deleted.
--   document_name          The file name without its routing part, as in
--                          "TA01 MUI #13759 {buyer} {product} {contract}". The
--                          routing part needs the Signed Documents folder id,
--                          so the full name is built when the file moves. A
--                          voided document's name ends " VOID".
--   document_status        "Waiting for Deal Jacket", "Saved to Deal Jacket"
--                          or "Voided".
--
-- Additive only: three columns, one check, one bucket. Nothing is removed.

alter table fni.agreement_products add column if not exists document_storage_path text;
alter table fni.agreement_products add column if not exists document_name text;
alter table fni.agreement_products add column if not exists document_status text;

comment on column fni.agreement_products.document_storage_path is
  'Where the contract PDF is held in the private fni-contracts bucket: {session id}/{file name}. Kept after it moves to the Deal Jacket.';
comment on column fni.agreement_products.document_name is
  'The document''s file name without its routing part; the full WorkDrive name is built when it moves. Ends " VOID" once voided.';
comment on column fni.agreement_products.document_status is
  'Waiting for Deal Jacket, Saved to Deal Jacket, or Voided.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agreement_products_document_status_known'
      and conrelid = 'fni.agreement_products'::regclass
  ) then
    alter table fni.agreement_products add constraint agreement_products_document_status_known
      check (document_status is null or document_status in ('Waiting for Deal Jacket', 'Saved to Deal Jacket', 'Voided'));
  end if;
end;
$$;

-- The private bucket the PDFs are held in. Only the Edge Functions, with the
-- service role, read and write it; staff see a PDF through a short-lived link.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fni-contracts', 'fni-contracts', false, 26214400, array['application/pdf'])
on conflict (id) do nothing;
