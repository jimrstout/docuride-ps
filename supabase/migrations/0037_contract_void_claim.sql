-- 0037_contract_void_claim.sql
--
-- One void at a time per contract.
--
-- Two Voids for the same contract a moment apart (a double click, two tabs)
-- both read it as Live and both called TecAssured. fni-contract-void now
-- claims the row first with a conditional UPDATE on this column, so of two
-- requests exactly one reaches TecAssured; the other is told plainly. The
-- claim is cleared when the void ends, whatever the outcome, and a claim
-- older than three minutes is taken to be abandoned (_shared/void-claim.ts).
--
-- Additive only. Every existing row starts unclaimed.

alter table fni.agreement_products add column if not exists void_started_at timestamptz;

comment on column fni.agreement_products.void_started_at is
  'When a void of this contract began, while it is under way. Cleared when the void ends. Stops a second void reaching TecAssured.';
