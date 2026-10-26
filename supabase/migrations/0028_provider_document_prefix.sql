-- 0028_provider_document_prefix.sql
--
-- A short code per provider that starts the name of every document it sends
-- to a deal's WorkDrive Deal Jacket: "TA01 MUI #13759 ...". Unique per tenant,
-- edited in Admin > Providers. A provider with no prefix cannot send documents
-- to WorkDrive; fni-contract-documents says so in plain English.
--
-- Riders Advantage (TecAssured) is "TA". The OEM providers are left blank for
-- now. Additive only: one column, one check, one index. Nothing is removed.

alter table fni.providers add column if not exists document_prefix text;

comment on column fni.providers.document_prefix is
  'Starts the WorkDrive name of every document from this provider, as in TA01. Two to six capital letters or digits, unique per tenant. Blank means its documents cannot be sent to WorkDrive yet.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'providers_document_prefix_shape'
      and conrelid = 'fni.providers'::regclass
  ) then
    alter table fni.providers add constraint providers_document_prefix_shape
      check (document_prefix is null or document_prefix ~ '^[A-Z0-9]{2,6}$');
  end if;
end;
$$;

create unique index if not exists providers_tenant_document_prefix_key
  on fni.providers (tenant_id, document_prefix)
  where document_prefix is not null;

update fni.providers
set document_prefix = 'TA'
where adapter = 'TecAssured' and name = 'Riders Advantage' and document_prefix is null;
