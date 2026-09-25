-- 0010_fni_session_vehicle_properties.sql
--
-- TecAssured refuses to rate a UTV without its engine displacement.
--
--   POST /rate  ->  {"error":" Missing displacement."}
--
-- Confirmed against the QA server on 2026-09-25 with a real 2027 Polaris
-- Ranger Crew XP 1000 VIN, Dealer ID 3-306. Everything else in the request was
-- accepted: the login, the dealer code, the VIN, the price, the dates. The rate
-- simply cannot be produced without a property the session snapshot has no
-- room for.
--
-- ── Why a jsonb column and not a displacement column ────────────────────
-- Displacement is the first one found, not the only one. TecAssured exposes
-- /rate/requiredproperties precisely because the required set varies by vehicle
-- type and by dealer -- a boat needs hull length, a snowmobile needs something
-- else again. A column per property would mean a migration every time a new
-- vehicle type is sold, and eight null columns on every row that is not that
-- type.
--
-- The rate request already has the right shape for this: a `properties` array
-- of {name, value}. This column is where those pairs are kept, and
-- fni-rate-vehicle merges them into that array.
--
-- Zoho does not carry these values today. Until it does, they are set by the
-- F&I user through the rating overrides, which is the same path every other
-- correction already takes.

alter table fni.sessions
  add column if not exists vehicle_properties jsonb;

comment on column fni.sessions.vehicle_properties is
  'Provider-required vehicle properties as a flat object, e.g. {"displacement":"999"}. '
  'Merged into the TecAssured rate request''s properties array. Varies by vehicle '
  'type and dealer -- see /rate/requiredproperties -- which is why it is jsonb '
  'and not a column per property.';
