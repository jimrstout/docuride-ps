-- 0009_fni_shared_login_per_store_dealer_code.sql
--
-- TecAssured confirmed how the Shop API handles a dealer group: ONE login
-- covers all of Riders Advantage, and each store is identified by its own
-- Dealer ID sent as `dealerCode` on every request.
--
-- The build assumed the opposite -- a separate username and password per store,
-- with fni.provider_credentials carrying one row per store. That shape cannot
-- express "nine stores, one login": it would mean nine copies of the same
-- password, nine sessions against an API that is happy with one, and nine rows
-- to edit at go-live instead of one.
--
-- So the two facts are separated into the two tables that own them:
--
--   provider_credentials    WHO we log in as        (one row per account)
--   store_provider_accounts WHICH dealer we are     (one row per store)
--
-- Nothing in the public schema is touched. Nothing outside fni is touched.
--
-- ── On the empty table ──────────────────────────────────────────────────
-- provider_credentials has zero rows: real credentials never arrived, and the
-- placeholder rows the build anticipated were never written. So there is no
-- data migration here and none is needed. The per-store columns are dropped
-- outright rather than backfilled, which is only safe BECAUSE the table is
-- empty -- verified before this migration was written, and the drops below
-- would be a data-loss step on any database where that is not true.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. provider_credentials becomes one row per provider ACCOUNT
-- ─────────────────────────────────────────────────────────────────────────

-- The account belongs to the dealer group, not to one of its rooftops.
alter table fni.provider_credentials
  add column if not exists tenant_id uuid references public.tenants(id);

-- Test or Live. Going live is then one row: point environment at Live and
-- api_base_url at the production host. Human-readable on purpose -- this value
-- is read by a person deciding whether it is safe to submit a real contract.
alter table fni.provider_credentials
  add column if not exists environment text not null default 'Test';

alter table fni.provider_credentials
  drop constraint if exists chk_provider_credentials_environment;
alter table fni.provider_credentials
  add constraint chk_provider_credentials_environment
  check (environment in ('Test', 'Live'));

comment on column fni.provider_credentials.environment is
  'Test | Live. Going live is one row: this column and api_base_url.';

-- Retiring an account should not mean deleting it -- the sessions it rated
-- still point at it, and which login submitted a contract is part of the
-- record.
alter table fni.provider_credentials
  add column if not exists active boolean not null default true;

-- api_base_url already exists and already defaults to the production host.
-- The default is dropped: an account with no explicit base URL silently
-- pointing at production is exactly the accident this restructure should make
-- impossible, and the QA host is not a special case of it.
alter table fni.provider_credentials
  alter column api_base_url drop default;

comment on column fni.provider_credentials.api_base_url is
  'Full REST base, e.g. https://ratessys-qa.com/rs/ or https://ratessys.com/rs/. '
  'No default: the environment must be stated, never assumed.';

-- password_encrypted is the column the TecAssured client reads and hands
-- straight to PBKDF2, so whatever is stored here is the password as typed.
-- The name promises an encryption that has never existed. It is kept as-is
-- because changing it means changing every reader in the same breath as a
-- structural migration, and the two should not travel together -- but the
-- promise is false and the comment now says so rather than leaving the next
-- reader to infer safety from a column name.
comment on column fni.provider_credentials.password_encrypted is
  'PLAINTEXT despite the name. _shared/tecassured.ts passes this value directly '
  'to PBKDF2 as the password. Protected by fni being service_role-only, not by '
  'encryption at rest. Renaming it, or actually encrypting it, is its own change.';

-- The cached API session belongs to the login, which is the point of the whole
-- restructure: nine stores on one account share one session.
comment on column fni.provider_credentials.session_id_cached is
  'One session per ACCOUNT, shared by every store mapped to it. Expires 25 '
  'minutes after issue against TecAssured''s 30.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. store_provider_accounts: which Dealer ID each store is
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists fni.store_provider_accounts (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.stores(id),
  credential_id  uuid not null references fni.provider_credentials(id),

  -- Denormalized from the credential so that "one active mapping per store per
  -- provider" can be a unique index rather than a trigger. The composite
  -- foreign key below makes the copy unforgeable: it can only ever hold the
  -- provider its own credential holds.
  provider       text not null,

  -- The store's Dealer ID, sent as dealerCode on every request. Text, not a
  -- number: TecAssured's own test ID is "3-306".
  dealer_code    text not null,

  active         boolean not null default true,

  -- Vehicle types are per DEALER, not per login: two stores on the same
  -- account can legitimately offer different types, so the cache lives here.
  vehicle_types_cache     jsonb,
  vehicle_types_cached_at timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table fni.store_provider_accounts is
  'Maps a store to the provider account it logs in with, and to the Dealer ID '
  'that identifies it on that account. One login, many stores, one Dealer ID each.';

comment on column fni.store_provider_accounts.dealer_code is
  'The store''s Dealer ID, sent as dealerCode. Text: TecAssured IDs look like "3-306".';

comment on column fni.store_provider_accounts.provider is
  'Copy of the credential''s provider, held only so the one-active-mapping-per-'
  'store-per-provider index can exist. Kept honest by the composite FK.';

-- What makes the denormalized provider safe.
alter table fni.provider_credentials
  drop constraint if exists provider_credentials_id_provider_key;
alter table fni.provider_credentials
  add constraint provider_credentials_id_provider_key unique (id, provider);

alter table fni.store_provider_accounts
  drop constraint if exists store_provider_accounts_credential_provider_fkey;
alter table fni.store_provider_accounts
  add constraint store_provider_accounts_credential_provider_fkey
  foreign key (credential_id, provider)
  references fni.provider_credentials (id, provider);

-- One active mapping per store per provider. Inactive rows are unconstrained,
-- so a store can keep its Test mapping on record after moving to Live.
create unique index if not exists store_provider_accounts_one_active
  on fni.store_provider_accounts (store_id, provider)
  where active;

create index if not exists store_provider_accounts_credential
  on fni.store_provider_accounts (credential_id)
  where active;

-- One active account per tenant per provider per environment. This is the
-- "ONE login covers all of Riders Advantage" rule, written down.
create unique index if not exists provider_credentials_one_active
  on fni.provider_credentials (tenant_id, provider, environment)
  where active;

-- fni is service_role only, and nothing here changes that. anon and
-- authenticated get nothing, deliberately: this table names the dealer codes
-- that identify us to a third party.
alter table fni.store_provider_accounts enable row level security;
revoke all on fni.store_provider_accounts from anon, authenticated;
grant all on fni.store_provider_accounts to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Drop the per-store columns from provider_credentials
-- ─────────────────────────────────────────────────────────────────────────
--
-- Safe only because the table is empty (see the header). The unique constraint
-- goes first: it is defined on store_id.

alter table fni.provider_credentials
  drop constraint if exists provider_credentials_store_id_provider_key;

-- This policy is defined on store_id, so the column cannot go while it stands.
--
-- It was inert and always has been: fni grants SELECT to service_role and to
-- nobody else, and a policy without a grant behind it permits nothing. What it
-- described, though, was alarming -- "authenticated may read the credential row
-- for their own store" reads on a table whose password_encrypted column holds
-- the password in clear. Had a grant to authenticated ever been added for any
-- reason, that policy is what would have decided who could read it.
--
-- It is dropped rather than rewritten against the new shape. There is no
-- per-store credential left to scope it to, the login is now shared by the
-- whole group so "own store" no longer narrows anything, and store_provider_
-- accounts deliberately ships with no authenticated policy at all. Grants are
-- untouched: service_role only, exactly as before.
drop policy if exists "Authenticated read own store credentials"
  on fni.provider_credentials;

alter table fni.provider_credentials drop column if exists store_id;
alter table fni.provider_credentials drop column if exists dealer_code;

-- The per-store vehicle types cache moved to store_provider_accounts.
alter table fni.provider_credentials drop column if exists vehicle_types_cache;
alter table fni.provider_credentials drop column if exists vehicle_types_cached_at;

-- tenant_id could only become NOT NULL once store_id was gone, since the two
-- describe the same thing at different grains.
alter table fni.provider_credentials
  alter column tenant_id set not null;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Sessions record which Dealer ID acted
-- ─────────────────────────────────────────────────────────────────────────
--
-- The session snapshot is the record of what happened. Under one login the
-- credential no longer answers "which dealer rated this" -- the dealer code
-- does, and a mapping edited later must not be able to rewrite history.

alter table fni.sessions
  add column if not exists dealer_code_used text;

comment on column fni.sessions.dealer_code_used is
  'The Dealer ID that rated and submitted this session, captured at rating. '
  'Deliberately a copy, not a join: re-pointing a store at a new Dealer ID '
  'must not change what an existing contract says it was submitted under.';

-- A synthetic session against the shared QA account, carrying invented buyer
-- data. Nothing about it may ever reach Zoho or a customer.
alter table fni.sessions
  add column if not exists is_test boolean not null default false;

comment on column fni.sessions.is_test is
  'Synthetic session for provider testing. Buyer data is fabricated and the '
  'row has no deal_id. Zoho write-back must refuse to run for these.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Health checks can tell a bad login from a bad Dealer ID
-- ─────────────────────────────────────────────────────────────────────────
--
-- Previously every check was per-store and a failure said only "failed". Under
-- one shared login the two failures have completely different remedies: a bad
-- password is one row and affects every store, a bad Dealer ID is one mapping
-- and affects one store. The log has to say which.

alter table fni.api_health_checks
  add column if not exists check_scope text not null default 'Dealer Code';

alter table fni.api_health_checks
  drop constraint if exists chk_api_health_checks_scope;
alter table fni.api_health_checks
  add constraint chk_api_health_checks_scope
  check (check_scope in ('Login', 'Dealer Code'));

comment on column fni.api_health_checks.check_scope is
  'Login = the shared account authenticated (one row per credential). '
  'Dealer Code = getVehicleTypes for one store under that account.';

alter table fni.api_health_checks
  add column if not exists dealer_code text;

-- A Login-scoped check is about the account, not any one store.
alter table fni.api_health_checks
  alter column store_id drop not null;
