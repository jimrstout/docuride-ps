-- 0013 — tell "not offered" apart from "something went wrong".
--
-- A customer on deal 14132 was shown "Ownership plans aren't offered on this
-- type of machine." That was false. The unit is a Can-Am Defender, body type
-- SxS, correctly mapped to UTV, and TecAssured was never asked. The planner had
-- no way to say so: fni.rated_offers only ever held a SUCCESSFUL quote, so its
-- absence had to stand for every outcome at once -- never asked, asked and
-- failed, asked and genuinely offered nothing.
--
-- Three of those are not the customer's business and one of them is. So the row
-- becomes the record of the last rate ATTEMPT rather than only of a good quote,
-- and it carries which outcome it was.
--
--   Rated        A quote came back with at least one product.
--   Not Offered  TecAssured answered a valid request with zero products. This
--                is the ONLY state that may say "not offered" to a customer.
--   Failed       We asked and it did not work: a provider error, a timeout, an
--                empty response, a vehicle type we cannot map, a property we
--                cannot supply. Staff see the reason; the customer sees a
--                neutral message.
--
-- "Pending" is deliberately NOT a value here. No row at all means no attempt
-- has been made yet, and inventing a row to say "nothing has happened" would
-- make the absence of a row mean nothing at all.

begin;

alter table fni.rated_offers
  add column if not exists state text not null default 'Rated';

alter table fni.rated_offers
  add column if not exists error_detail text;

-- Both payloads become nullable: a failed attempt may have no response at all
-- (a timeout), and one that never reached the provider has no request either.
alter table fni.rated_offers alter column response_payload drop not null;
alter table fni.rated_offers alter column request_payload  drop not null;

-- Existing rows predate the column and every one of them is a real quote.
update fni.rated_offers
   set state = case when product_count > 0 then 'Rated' else 'Not Offered' end
 where state = 'Rated';

alter table fni.rated_offers
  drop constraint if exists rated_offers_state_check;

alter table fni.rated_offers
  add constraint rated_offers_state_check
  check (state in ('Rated', 'Not Offered', 'Failed'));

-- A reason is required exactly when there is a failure to explain, and
-- forbidden otherwise, so "Failed" can never be recorded without saying why.
alter table fni.rated_offers
  drop constraint if exists rated_offers_error_detail_check;

alter table fni.rated_offers
  add constraint rated_offers_error_detail_check
  check (
    (state = 'Failed' and error_detail is not null and btrim(error_detail) <> '')
    or (state <> 'Failed' and error_detail is null)
  );

comment on column fni.rated_offers.state is
  'Outcome of the last rate attempt: Rated, Not Offered, or Failed. Only '
  '"Not Offered" may be reported to a customer as plans not being available; '
  '"Failed" is a fault on our side or the provider''s and gets neutral copy.';

comment on column fni.rated_offers.error_detail is
  'Why a Failed attempt failed, for staff. Never shown to a customer.';

-- Grants unchanged on purpose: service_role only, nothing to anon or
-- authenticated. Adding columns does not change who can read the table.

commit;
