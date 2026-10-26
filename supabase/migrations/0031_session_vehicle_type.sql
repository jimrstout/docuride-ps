-- 0031_session_vehicle_type.sql
--
-- The vehicle type, as staff see and choose it on Verify.
--
-- TecAssured offers each Riders Advantage product in vehicle-specific versions
-- (On-Road, Off-Road MC, UTV/ATV) and enforces the match when the contract goes
-- in, not when it is quoted. A street bike was shown the Off-Road Tire and
-- Wheel and TecAssured refused the contract. So the vehicle type becomes a
-- choice on Verify, stored exactly as shown:
--
--   ATV, UTV, On-Road Motorcycle, Off-Road Motorcycle, Personal Watercraft,
--   Snowmobile, Other
--
--   vehicle_type         The choice. Menu templates match on it.
--   vehicle_type_source  One plain line saying where it came from, as Verify
--                        shows it: "Picked from the CRM body type ...".
--
-- vehicle_type_code stays: it is the TecAssured code the choice stands for
-- (UTV, MCYC, BIKE ...), derived from it, and what rating sends.
--
-- Existing sessions are converted from their stored code, and the line says
-- so: UTV to UTV, ATV to ATV, MCYC to On-Road Motorcycle, BIKE to Off-Road
-- Motorcycle, PWAC to Personal Watercraft, SNOW to Snowmobile. Their code is
-- left as it is. Additive only: two columns, one check. Nothing is removed.

alter table fni.sessions add column if not exists vehicle_type text;
alter table fni.sessions add column if not exists vehicle_type_source text;

comment on column fni.sessions.vehicle_type is
  'The vehicle type as chosen on Verify: ATV, UTV, On-Road Motorcycle, Off-Road Motorcycle, Personal Watercraft, Snowmobile or Other. vehicle_type_code is the TecAssured code it stands for.';
comment on column fni.sessions.vehicle_type_source is
  'Where the vehicle type came from, in one plain line, as Verify shows it.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sessions_vehicle_type_known'
      and conrelid = 'fni.sessions'::regclass
  ) then
    alter table fni.sessions add constraint sessions_vehicle_type_known check (
      vehicle_type is null or vehicle_type in (
        'ATV', 'UTV', 'On-Road Motorcycle', 'Off-Road Motorcycle',
        'Personal Watercraft', 'Snowmobile', 'Other'
      )
    );
  end if;
end;
$$;

-- The conversion, recorded on each session it touches.
update fni.sessions
set vehicle_type = case upper(vehicle_type_code)
      when 'UTV'  then 'UTV'
      when 'ATV'  then 'ATV'
      when 'MCYC' then 'On-Road Motorcycle'
      when 'BIKE' then 'Off-Road Motorcycle'
      when 'PWAC' then 'Personal Watercraft'
      when 'SNOW' then 'Snowmobile'
      else 'Other'
    end,
    vehicle_type_source =
      'Converted on 26 Oct 2026 from the stored code ' || vehicle_type_code ||
      '. Change it if that is wrong.'
where vehicle_type is null and vehicle_type_code is not null;
