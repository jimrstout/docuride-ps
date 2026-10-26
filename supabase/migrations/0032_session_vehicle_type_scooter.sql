-- 0032_session_vehicle_type_scooter.sql
--
-- Adds Scooter to the vehicle types a session may hold. TecAssured's own
-- vehicle types (API guide 6.3) include SCO, Scooter, and staff can choose it
-- on Verify. A check constraint cannot be widened in place, so the one from
-- 0031 is replaced with the same list plus Scooter. No data changes.

alter table fni.sessions drop constraint if exists sessions_vehicle_type_known;
alter table fni.sessions add constraint sessions_vehicle_type_known check (
  vehicle_type is null or vehicle_type in (
    'ATV', 'UTV', 'On-Road Motorcycle', 'Off-Road Motorcycle', 'Scooter',
    'Personal Watercraft', 'Snowmobile', 'Other'
  )
);
