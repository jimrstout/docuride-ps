-- 0029_contract_documents_workdrive.sql
--
-- A provider's contract document, saved to the deal's WorkDrive Deal Jacket,
-- and exactly what the provider said about it.
--
--   document_position     The contract's place on the deal (1, 2...), in
--                         submit order, kept once given. It is the "01" in
--                         "TA01 MUI #13759 ...".
--   workdrive_file_id,    The file saved to the Deal Jacket, its name, and
--   workdrive_file_name,  when it was saved. A voided contract's file keeps
--   workdrive_saved_at    its id and gets " VOID" in its name.
--   provider_signatures   The provider's signature data for the document,
--                         exactly as returned: every field, nothing converted.
--   provider_document     Everything else the provider returned with the
--                         document except the PDF itself, also as returned.
--   page_count,           The PDF's pages, and each page's size in points:
--   page_sizes            [{ "page": 1, "width": 612, "height": 792, "rotation": 0 }].
--
-- Additive only: columns, one index. Nothing is removed.

alter table fni.agreement_products add column if not exists document_position integer;
alter table fni.agreement_products add column if not exists workdrive_file_id text;
alter table fni.agreement_products add column if not exists workdrive_file_name text;
alter table fni.agreement_products add column if not exists workdrive_saved_at timestamptz;
alter table fni.agreement_products add column if not exists provider_signatures jsonb;
alter table fni.agreement_products add column if not exists provider_document jsonb;
alter table fni.agreement_products add column if not exists page_count integer;
alter table fni.agreement_products add column if not exists page_sizes jsonb;

comment on column fni.agreement_products.document_position is
  'The contract''s place on the deal, from 1, in submit order. Kept once given. The 01 in TA01.';
comment on column fni.agreement_products.provider_signatures is
  'The provider''s signature data for this document, exactly as returned.';
comment on column fni.agreement_products.provider_document is
  'Everything the provider returned with the document except the PDF itself, exactly as returned.';
comment on column fni.agreement_products.page_sizes is
  'Each page''s size in points: [{page, width, height, rotation}].';

-- One place per contract on a deal.
create unique index if not exists agreement_products_document_position_key
  on fni.agreement_products (agreement_id, document_position)
  where document_position is not null;
