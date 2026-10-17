-- 0027_oem_contracts.sql
--
-- OEM contracts, recorded by staff (multi-provider Part 7).
--
-- A Price Sheet provider has no API, so DocuRide never submits or voids its
-- contracts anywhere. Staff write the contract on the OEM's own system, then
-- record it here: who recorded it, when, the contract number, and the signed
-- document, which goes to the private oem-contracts bucket.
--
-- A recorded contract is an fni.agreement_products row like any other, so the
-- one-live-contract-per-product rule and the Verify list keep working. Its
-- status is 'Live' and recorded_by is set; screens call it "Recorded". Voiding
-- one changes the row only, with a reason, and calls no provider.
--
-- Additive only: four columns, one check, one bucket. Nothing is removed.

alter table fni.agreement_products add column if not exists recorded_by text;
alter table fni.agreement_products add column if not exists recorded_at timestamptz;
alter table fni.agreement_products add column if not exists void_reason text;
alter table fni.agreement_products add column if not exists document_path text;

comment on column fni.agreement_products.recorded_by is
  'Set when staff recorded an OEM contract by hand. NULL for a contract DocuRide submitted through a provider API.';
comment on column fni.agreement_products.document_path is
  'The signed contract in the private oem-contracts bucket, for a recorded contract.';
comment on column fni.agreement_products.void_reason is
  'Why staff voided a recorded contract, in their words.';

-- A recorded contract says who recorded it and when.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agreement_products_recorded_complete'
      and conrelid = 'fni.agreement_products'::regclass
  ) then
    alter table fni.agreement_products add constraint agreement_products_recorded_complete check (
      recorded_by is null
      or (btrim(recorded_by) <> '' and recorded_at is not null)
    );
  end if;
end;
$$;

-- The private bucket the signed contracts live in. Only the Edge Functions,
-- with the service role, read and write it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'oem-contracts', 'oem-contracts', false, 26214400,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do nothing;
