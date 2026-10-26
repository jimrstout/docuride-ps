-- 0033_vehicle_type_menu_templates.sql
--
-- A menu for each kind of vehicle TecAssured prices differently.
--
-- TecAssured offers each Riders Advantage product in vehicle-specific
-- versions and enforces the match when the contract goes in: an On-Road
-- product on an off-road bike, or the reverse, is refused. So each vehicle
-- type gets its own template, matched on Verify's vehicle type (migration
-- 0031), and "All deals" stays as the fallback for everything else.
--
--   ATV and UTV          the UTV products, plus Premium Care ATV/UTV
--                        (2060_141) and its Service Drive version (2064_141)
--   On-Road Motorcycle   maintenance 62_7, 77_7, 71_7, 83_7; Tire and Wheel
--                        22_4; Care 14_3 and 88_3; Premium 2058_141 and
--                        2066_141; Battery and Theft
--   Off-Road Motorcycle  maintenance 1619_7, 1616_7, 1618_7, 1617_7; Tire and
--                        Wheel 23_4; Battery and Theft. TecAssured offered no
--                        off-road motorcycle Care on our test deals, so there
--                        is no Mechanical Protection slot.
--
-- Slot titles, order and mode mirror "All deals" (every slot Side by Side, in
-- Bronze, Silver, Gold, Platinum order). A product with no customer wording
-- stays hidden by the planner until staff write it. Additive only.

insert into fni.menu_templates (tenant_id, name, description, vehicle_types, priority, updated_by)
select t.id, v.name, v.description, v.vehicle_types, 10, 'Migration 0033'
from public.tenants t
cross join (values
  ('ATV and UTV',
   'ATVs and side-by-sides: the UTV/ATV versions of each product.',
   array['ATV', 'UTV']),
  ('On-Road Motorcycle',
   'Street motorcycles: the On-Road versions of each product.',
   array['On-Road Motorcycle']),
  ('Off-Road Motorcycle',
   'Off-road motorcycles: the Off-Road MC versions of each product.',
   array['Off-Road Motorcycle'])
) as v(name, description, vehicle_types)
where t.crm_sync = 'zoho'
on conflict (tenant_id, lower(name)) do nothing;

insert into fni.menu_template_slots (template_id, position, title, category, mode, product_ids)
select mt.id, s.position, s.title, s.category, 'Side by Side',
       array(
         select c.id
         from unnest(s.codes) with ordinality as x(code, ord)
         join fni.product_catalog c
           on c.product_code = x.code and c.tenant_id = mt.tenant_id and c.store_id is null
         join fni.providers p on p.id = c.provider_id and p.adapter = 'TecAssured'
         order by x.ord
       )
from fni.menu_templates mt
join (values
  ('ATV and UTV', 1, 'Maintenance',           'Maintenance',           array['66_7', '78_7', '72_7', '84_7']),
  ('ATV and UTV', 2, 'Mechanical Protection', 'Mechanical Protection', array['16_3', '86_3', '2060_141', '2064_141']),
  ('ATV and UTV', 3, 'Tire and Wheel',        'Tire and Wheel',        array['23_4']),
  ('ATV and UTV', 4, 'Theft',                 'Theft',                 array['24_5', '25_5']),
  ('ATV and UTV', 5, 'Battery',               'Battery',               array['755_6', '754_6']),

  ('On-Road Motorcycle', 1, 'Maintenance',           'Maintenance',           array['62_7', '77_7', '71_7', '83_7']),
  ('On-Road Motorcycle', 2, 'Mechanical Protection', 'Mechanical Protection', array['14_3', '88_3', '2058_141', '2066_141']),
  ('On-Road Motorcycle', 3, 'Tire and Wheel',        'Tire and Wheel',        array['22_4']),
  ('On-Road Motorcycle', 4, 'Theft',                 'Theft',                 array['24_5', '25_5']),
  ('On-Road Motorcycle', 5, 'Battery',               'Battery',               array['755_6', '754_6']),

  ('Off-Road Motorcycle', 1, 'Maintenance',    'Maintenance',    array['1619_7', '1616_7', '1618_7', '1617_7']),
  ('Off-Road Motorcycle', 2, 'Tire and Wheel', 'Tire and Wheel', array['23_4']),
  ('Off-Road Motorcycle', 3, 'Theft',          'Theft',          array['24_5', '25_5']),
  ('Off-Road Motorcycle', 4, 'Battery',        'Battery',        array['755_6', '754_6'])
) as s(template_name, position, title, category, codes)
  on s.template_name = mt.name
where mt.updated_by = 'Migration 0033'
on conflict (template_id, position) do nothing;
