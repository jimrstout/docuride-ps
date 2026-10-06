-- 0020_pricing_rules_updated_by.sql
--
-- Who last changed a pricing rule.
--
-- The admin area's Pricing page edits fni.pricing_rules, and a change there
-- moves what customers are shown right away. So every save records the signed-in
-- operator's email here, and the page shows "Last changed by X on date" on each
-- rule. Written only by fni-admin-settings. Rules saved before this column
-- existed have no name on them, and the page says so rather than guessing.

alter table fni.pricing_rules add column if not exists updated_by text;

comment on column fni.pricing_rules.updated_by is
  'Email of the operator who last saved this rule through the admin area. '
  'Null for rules saved before 0020.';
