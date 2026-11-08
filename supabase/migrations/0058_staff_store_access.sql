-- 0058_staff_store_access.sql
--
-- Who sees which stores in the DocuRide PS admin area, kept in fni (PS's own
-- schema), never in public.profiles.
--
--   fni.staff_roles         each PS user's role, in words: "Administrator"
--                           sees every store and manages staff; "Staff" sees
--                           only the stores granted below. A user with no row
--                           has no PS role.
--   fni.staff_store_access  one row per store a user may see. A Staff user
--                           with none sees an empty Sessions list.
--
-- Enforced by the Edge Function that lists sessions (fni-admin-sessions): the
-- browser is never sent a session from a store the user cannot see. Details
-- and the customer presentation are unchanged by this.
--
-- Seed: Jim (jim.stout@docuride.com) is Administrator. Additive only: two new
-- tables, nothing changed in any existing one, nothing dropped. public.stores
-- and auth.users are only read and referenced.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ── Lock check ──────────────────────────────────────────────────────────
-- The foreign keys take a brief SHARE ROW EXCLUSIVE lock on auth.users and
-- public.stores, so a conflicting lock on either stops the migration too.
do $$
begin
  if exists (
    select 1
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
     where l.pid <> pg_backend_pid()
       and l.mode in ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and (n.nspname = 'fni'
            or (n.nspname = 'public' and c.relname = 'stores')
            or (n.nspname = 'auth' and c.relname = 'users'))
  ) then
    raise exception 'A conflicting lock is held on an fni table, public.stores or auth.users. Nothing was changed.';
  end if;
end $$;

create table if not exists fni.staff_roles (
  user_id    uuid primary key references auth.users(id) on delete no action,
  role       text not null
    constraint staff_roles_role_check check (role in ('Administrator', 'Staff')),
  granted_by text not null,
  granted_at timestamptz not null default now()
);

create table if not exists fni.staff_store_access (
  user_id    uuid not null references auth.users(id) on delete no action,
  store_id   uuid not null references public.stores(id) on delete no action,
  granted_by text not null,
  granted_at timestamptz not null default now(),
  primary key (user_id, store_id)
);

comment on table fni.staff_roles is
  'Each DocuRide PS user''s role: Administrator (every store, manages staff) or Staff (only the stores in fni.staff_store_access). Edited on Administration > Staff.';
comment on table fni.staff_store_access is
  'The stores a Staff user may see in the DocuRide PS admin area. Enforced by fni-admin-sessions. Edited on Administration > Staff.';

alter table fni.staff_roles enable row level security;
alter table fni.staff_store_access enable row level security;
revoke all on fni.staff_roles from anon, authenticated;
revoke all on fni.staff_store_access from anon, authenticated;

-- ── Seed: Jim is Administrator ──────────────────────────────────────────
do $$
declare
  jim uuid := (select id from auth.users where lower(email) = 'jim.stout@docuride.com');
begin
  if jim is null then
    raise exception 'No sign-in account for jim.stout@docuride.com. Nothing was changed.';
  end if;
  insert into fni.staff_roles (user_id, role, granted_by)
  values (jim, 'Administrator', 'claude')
  on conflict (user_id) do nothing;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261108222500',
  '0058_staff_store_access',
  array['Who sees which stores in the PS admin area: fni.staff_roles (Administrator or Staff) and fni.staff_store_access (user, store), Jim seeded as Administrator. See supabase/migrations/0058_staff_store_access.sql.'],
  'claude'
);

commit;
