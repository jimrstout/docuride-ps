-- 0018_financial_down_payment_and_cap.sql
--
-- Two figures for the Financial section of Verify. Neither is a TecAssured
-- rating input.
--
-- agreed_down_payment: the cash down agreed on the deal, from the Zoho field
-- Sold_1_Down_Payment. Written at session creation, on reopen, and by Refresh
-- from CRM, all through _shared/crm-fields.ts. Not TILA_Down_Payment, which on
-- the deals that carry it is this plus any positive trade-in equity.
--
-- max_amount_financed: the most the finance company's approval allows. The CRM
-- does not carry it, so it is typed on Verify. Null means no maximum was given.
-- Who entered it, and when, is recorded in staff_edits under the same key. It is
-- never compared by the verification gate, so changing it does not reset a
-- verification or mark rates out of date.
--
-- Additive and nullable. Existing sessions read as "not known yet" until their
-- next reopen or Refresh fills the down payment.

alter table fni.sessions add column if not exists agreed_down_payment numeric;
alter table fni.sessions add column if not exists max_amount_financed numeric;

comment on column fni.sessions.agreed_down_payment is
  'Down payment agreed on the deal, from Zoho Sold_1_Down_Payment. Read only on '
  'Verify. Not a rating input.';

comment on column fni.sessions.max_amount_financed is
  'Maximum amount financed from the finance company approval, typed on Verify. '
  'Null means no maximum. Not a rating input.';
