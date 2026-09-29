-- 0017_vin_decode_attempt.sql
--
-- The Verify page now asks TecAssured to decode the VIN on its own, the first
-- time it opens for a session. These two columns are what stop it asking again
-- on every page load while TecAssured is down.
--
-- vin_decode_at (migration 0014) is written only on success, so on its own it
-- cannot tell "never tried" from "tried and failed". vin_decode_attempted_at is
-- written by fni-vin-decode BEFORE it calls TecAssured, so an attempt the page
-- gave up waiting on still counts as tried. vin_decode_error holds the reason
-- the last attempt failed, and is cleared by a successful decode.
--
-- The automatic decode runs only when both vin_decode_at and
-- vin_decode_attempted_at are null. The Decode the VIN button always runs, and
-- is recorded here the same way.
--
-- Additive and nullable. Existing rows read as "never tried", which is correct:
-- none of them was ever decoded automatically.

alter table fni.sessions add column if not exists vin_decode_attempted_at timestamptz;
alter table fni.sessions add column if not exists vin_decode_error text;

comment on column fni.sessions.vin_decode_attempted_at is
  'When fni-vin-decode last started a decode, successful or not. Set before '
  'TecAssured is called. The Verify page auto-decodes only while this and '
  'vin_decode_at are both null.';

comment on column fni.sessions.vin_decode_error is
  'Why the last VIN decode failed, in plain words. Null after a success.';
