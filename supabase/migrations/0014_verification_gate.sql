-- 0014 — nothing gets rated until a person has checked the inputs.
--
-- Deal 14132 rated on nothing at all, because nothing asked. The fix for that
-- made the planner ask on its own, which surfaced the next problem: the request
-- it would send is assembled from a deal nobody has looked at, and two of the
-- seventeen fields TecAssured wants for a UTV have no source in the CRM.
--
-- A rate is a price a customer is shown. Assembling one from unverified inputs
-- and a default is how somebody ends up buying a contract priced for a machine
-- they do not own. So a session now carries a verification state, and the
-- customer planner will not rate until it says Verified.
--
--   Needs Verification  Nobody has checked the inputs. The customer sees the
--                       neutral "still getting your options ready" screen.
--   Verified            A named person checked every field TecAssured asks for
--                       and pressed Verify. What they saw is in the snapshot.
--
-- Human-readable values, matching every other constrained column in this schema.

begin;

alter table fni.sessions
  add column if not exists verification_state text not null default 'Needs Verification';

alter table fni.sessions
  drop constraint if exists sessions_verification_state_check;

alter table fni.sessions
  add constraint sessions_verification_state_check
  check (verification_state in ('Needs Verification', 'Verified'));

alter table fni.sessions add column if not exists verified_at timestamptz;

-- The person, by the email they signed into the console with. Not a foreign key
-- to an admin user: the answer to "who verified this" must survive that account
-- being deleted, exactly as dealer_code_used survives a remapped store.
alter table fni.sessions add column if not exists verified_by text;

-- Every value and its source, as the verifier saw them. This is the compliance
-- record: it is what makes "the rate was built from bad data" a question with an
-- answer. Never updated in place -- a re-verification replaces it wholesale.
alter table fni.sessions add column if not exists verified_snapshot jsonb;

alter table fni.sessions
  drop constraint if exists sessions_verified_together_check;

-- Verified means all three are present. A state with no verifier and no time is
-- not a verification, and storing one would make the column a decoration.
alter table fni.sessions
  add constraint sessions_verified_together_check
  check (
    (verification_state = 'Verified'
       and verified_at is not null
       and verified_by is not null
       and btrim(verified_by) <> ''
       and verified_snapshot is not null)
    or verification_state <> 'Verified'
  );

-- ── The VIN decode ──────────────────────────────────────────────────────
-- TecAssured's /decode/ps is the only source for engine size, and it also
-- returns fuel type and its own opinion of the vehicle type. Cached on the
-- session because a VIN's engine size does not change and the call costs a
-- provider round trip.
alter table fni.sessions add column if not exists vin_decode jsonb;
alter table fni.sessions add column if not exists vin_decode_at timestamptz;

comment on column fni.sessions.vin_decode is
  'Verbatim /decode/ps response: year, make, model, displacement, vtype, '
  'fuelType. The only source for engine.ccs. Carries no warranty information.';

-- ── Rates that are no longer about this deal ────────────────────────────
-- A refresh that changes a rating input does not delete the quote: it stops it
-- being the answer to the current question. Marked rather than removed, so the
-- superseded prices stay auditable.
alter table fni.rated_offers
  add column if not exists out_of_date boolean not null default false;

comment on column fni.rated_offers.out_of_date is
  'True when a rating input changed after this quote was produced. The planner '
  'treats an out-of-date quote as no quote; the row is kept for the record.';

commit;
