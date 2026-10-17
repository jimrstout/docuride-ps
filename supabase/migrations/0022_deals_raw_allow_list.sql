-- 0022_deals_raw_allow_list.sql
--
-- public.deals.raw keeps only an allow list of CRM fields.
--
-- raw was the whole Zoho DocuRide record minus ten named fields. Every one of
-- the 296 deals still held the buyer's and co-buyer's employer, proof of income
-- and credit application, readable by anyone who can sign in. zoho-sync now
-- writes raw from RAW_FIELDS in _shared/dealmap.ts, and this trims the rows
-- already there to the same list.
--
-- Nothing in this repository, the database or the DocuRide DC functions reads
-- a field out of raw, so the list is minimal: the record's id and when Zoho
-- last changed it. The money stays, uncut, in the tila and financials columns.
--
-- The deals_touch trigger is switched off for the trim only, so each deal keeps
-- the updated_at of its last real change rather than all reading as today.

alter table public.deals disable trigger deals_touch;

update public.deals d
set raw = coalesce(
  (select jsonb_object_agg(e.key, e.value)
   from jsonb_each(d.raw) e
   where e.key in ('id', 'Modified_Time')),
  '{}'::jsonb
)
where d.raw is not null
  and exists (select 1 from jsonb_object_keys(d.raw) k where k not in ('id', 'Modified_Time'));

alter table public.deals enable trigger deals_touch;

comment on column public.deals.raw is
  'Only the CRM fields named in RAW_FIELDS (supabase/functions/_shared/dealmap.ts): '
  'the record id and Modified_Time. Never the whole record.';
