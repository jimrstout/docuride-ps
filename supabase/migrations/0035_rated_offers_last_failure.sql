-- 0035_rated_offers_last_failure.sql
--
-- A failed re-rate keeps the last good offers.
--
-- A rating attempt used to overwrite the provider's row whatever came back,
-- so a timeout on a re-rate threw away a quote the customer may already have
-- chosen from, and the deal could no longer be submitted. Now a failure keeps
-- a Rated row and is written beside it, as a warning staff see on Verify and
-- in Admin > Sessions. The next answer from the provider clears it.
--
-- error_detail stays what it was: the reason on a Failed row, and only there
-- (rated_offers_error_detail_check). Additive only.

alter table fni.rated_offers add column if not exists last_failure_detail text;
alter table fni.rated_offers add column if not exists last_failure_at timestamptz;

comment on column fni.rated_offers.last_failure_detail is
  'Why the last re-rate failed, on a row whose earlier offers were kept. Cleared by the next answer from the provider.';
comment on column fni.rated_offers.last_failure_at is
  'When the last re-rate failed, on a row whose earlier offers were kept.';
