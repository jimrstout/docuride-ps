-- 0015 — one session per deal, one live contract per product.
--
-- Three duplicate paths, all of which the schema allowed:
--
--   Two sessions for one deal.  fni-session-start reused an existing session
--   only when its status was not terminal, so a deal whose session had reached
--   Finalized, Written Back or Cancelled got a second session and a second
--   planner link. Nothing in the database prevented it either: zoho_deal_id
--   carried a plain index, and two simultaneous clicks could both find nothing
--   and both insert.
--
--   Two live contracts for one product.  agreement_products had no unique key
--   beyond its own id and no notion of a contract being voided, so "never two
--   live contracts for the same product" could not be stated, let alone
--   enforced.
--
--   Two submits at once.  The only thing standing between a double-click and a
--   second real contract was that a successful submit moves the session to
--   Agreement Created, which the status gate rejects. That check happens before
--   any write, so two concurrent requests both passed it; and a submit that
--   threw after TecAssured had already created contracts left the session
--   submittable with nothing recorded.

begin;

-- ── One session per deal ────────────────────────────────────────────────
-- Not partial. A deal has one planning session for its whole life, including
-- after it is finalized: a second link to the same deal is the thing we are
-- preventing, and "it is finished" is not a reason to make another one.
--
-- NULL is still allowed many times over, because a unique index does not
-- constrain nulls, and a synthetic test session has no CRM deal behind it.
create unique index if not exists sessions_one_per_zoho_deal
  on fni.sessions (zoho_deal_id)
  where zoho_deal_id is not null;

-- ── A contract can be voided ────────────────────────────────────────────
--
--   Live                   Real paperwork exists at the provider.
--   Voided                 Staff cancelled it there. It no longer counts, and
--                          the product may be submitted again.
--   Submit Status Unknown  We asked TecAssured to create it and never learned
--                          whether it did. Blocks resubmission until a person
--                          checks, because the one thing worse than no contract
--                          is two.
alter table fni.agreement_products
  add column if not exists status text not null default 'Live';

alter table fni.agreement_products
  drop constraint if exists agreement_products_status_check;

alter table fni.agreement_products
  add constraint agreement_products_status_check
  check (status in ('Live', 'Voided', 'Submit Status Unknown'));

alter table fni.agreement_products add column if not exists voided_at timestamptz;
alter table fni.agreement_products add column if not exists voided_by text;

alter table fni.agreement_products
  drop constraint if exists agreement_products_voided_together_check;

-- Voided means somebody voided it, and we know who and when. A status with no
-- name against it is not an audit trail.
alter table fni.agreement_products
  add constraint agreement_products_voided_together_check
  check (
    (status = 'Voided'
       and voided_at is not null
       and voided_by is not null
       and btrim(voided_by) <> '')
    or status <> 'Voided'
  );

-- The rule Jim asked for, in the one place that cannot be bypassed.
--
-- Unknown counts as occupying the slot on purpose: we may well have a real
-- contract for that product, and the whole point of the state is to stop a
-- second one being created while nobody knows.
create unique index if not exists agreement_products_one_live_per_product
  on fni.agreement_products (agreement_id, provider_product_id)
  where status in ('Live', 'Submit Status Unknown');

comment on column fni.agreement_products.status is
  'Live, Voided, or Submit Status Unknown. A unique index allows only one '
  'non-Voided row per product per agreement, so there can never be two live '
  'contracts for the same product on the same deal.';

-- ── The submit lock ─────────────────────────────────────────────────────
--
-- Held on the session, because a submit is a whole-session operation: it prunes
-- one quote and posts it. Acquired with a conditional UPDATE, which is atomic in
-- Postgres, so of two concurrent requests exactly one gets the row back.
--
--   Idle                   Nothing in flight.
--   In Progress            A submit is running. Nobody else may start one.
--   Submit Status Unknown  A submit reached the provider and we never learned
--                          the outcome. Blocks submission until staff clear it.
--                          Deliberately NOT auto-released on a timer: releasing
--                          it would be guessing that no contract was created,
--                          which is the guess that produces duplicates.
alter table fni.sessions
  add column if not exists submit_state text not null default 'Idle';

alter table fni.sessions
  drop constraint if exists sessions_submit_state_check;

alter table fni.sessions
  add constraint sessions_submit_state_check
  check (submit_state in ('Idle', 'In Progress', 'Submit Status Unknown'));

alter table fni.sessions add column if not exists submit_started_at timestamptz;

-- Which request holds it, so a request can tell its own lock from somebody
-- else's and release only what it took.
alter table fni.sessions add column if not exists submit_token uuid;

-- Why it is stuck, for staff. Null while Idle.
alter table fni.sessions add column if not exists submit_detail text;

comment on column fni.sessions.submit_state is
  'Idle, In Progress, or Submit Status Unknown. A conditional UPDATE from Idle '
  'is what makes a double-click, a retry and a second browser tab produce one '
  'submit. Submit Status Unknown is never released automatically.';

commit;
