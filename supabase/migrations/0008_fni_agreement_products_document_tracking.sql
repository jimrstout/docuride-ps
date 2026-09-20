-- 0008_fni_agreement_products_document_tracking.sql
--
-- fni-contract-documents reads four columns off fni.agreement_products that do
-- not exist. Two of them have counterparts already on the table and are a
-- rename in the function: product_id is provider_product_id, product_unique is
-- rate_unique_id. The other two have no counterpart in any form, so they are
-- added here.
--
-- The function never worked, so there is nothing to regress. What there is to
-- avoid is finding out the first time it runs with live TecAssured
-- credentials, which is the worst possible moment.
--
-- This lands with the function, which moves into the repository in the same
-- commit -- it had only ever been deployed out of band.

alter table fni.agreement_products
  add column if not exists document_retrieved_at timestamptz;

comment on column fni.agreement_products.document_retrieved_at is
  'When the contract PDF was successfully fetched from the provider. NULL means it has not been retrieved yet, which is how fni-contract-documents tells a pending document from a finished one.';

alter table fni.agreement_products
  add column if not exists filename text;

comment on column fni.agreement_products.filename is
  'The PDF filename this contract is filed under, and the first field of its FNI_Signature_Map line. Stored rather than recomputed so the map and the document can never disagree about which file a signature belongs to.';
