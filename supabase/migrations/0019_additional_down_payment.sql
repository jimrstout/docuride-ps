-- 0019_additional_down_payment.sql
--
-- The additional down payment a completed plan needs because the plan goes past
-- the finance company's maximum amount financed (migration 0018).
--
-- Written only by fni-session-save, on a complete save, from the saved Included
-- selections priced on the server from the stored quote and the store's pricing
-- rules, through _shared/plan-prices.ts and the shared money arithmetic. No
-- figure sent by the browser is used. Zero when the plan is under the maximum or
-- there is none; null when it could not be worked out honestly (a cash deal, no
-- known principal, or a selection with no current price).

alter table fni.sessions add column if not exists additional_down_payment numeric;

comment on column fni.sessions.additional_down_payment is
  'Amount past the finance company maximum, paid at signing instead of financed. '
  'Computed server side by fni-session-save on a complete save. Null when it '
  'could not be worked out.';
