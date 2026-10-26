-- 0034_catalog_program_names.sql
--
-- TecAssured's own name for each product version, kept on the catalog so
-- staff can tell twins apart in Admin and on Verify. Our "Priority
-- Maintenance, Bronze" is three TecAssured programs (UTV, On-Road, Off-Road
-- MC), and only the right one can be contracted for a vehicle. Customers never
-- see it.
--
-- It is the product's label in a rated offer up to " - ", where TecAssured's
-- product line begins. Filled here from the rated offers already held, and
-- kept current by every rating (_shared/rate-session.ts). Additive only.

alter table fni.product_catalog add column if not exists provider_program_name text;

comment on column fni.product_catalog.provider_program_name is
  'TecAssured''s own program name for this product version, as in USED BRONZE ON-ROAD NON-EU. Shown to staff only.';

update fni.product_catalog c
set provider_program_name = x.program
from (
  select distinct on (s.tenant_id, o.provider_id, p->>'unique')
         s.tenant_id, o.provider_id, p->>'unique' as code,
         nullif(btrim(split_part(coalesce(p->>'label', p->>'desc'), ' - ', 1)), '') as program
  from fni.rated_offers o
  join fni.sessions s on s.id = o.session_id
  cross join lateral jsonb_array_elements(
    coalesce(o.response_payload->'quote'->'vehicles', o.response_payload->'vehicles', '[]'::jsonb)
  ) v
  cross join lateral jsonb_array_elements(coalesce(v->'products', '[]'::jsonb)) p
  where o.state = 'Rated'
  order by s.tenant_id, o.provider_id, p->>'unique', o.rated_at desc
) x
where c.tenant_id = x.tenant_id
  and c.provider_id = x.provider_id
  and c.product_code = x.code
  and x.program is not null
  and c.provider_program_name is distinct from x.program;
