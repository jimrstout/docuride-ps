-- 0026_store_account_provider_check.sql
--
-- A store account's login is checked against its provider again.
--
-- Before 0021 a foreign key on (credential_id, provider) made sure a store's
-- TecAssured account used a TecAssured login. 0021 replaced the provider text
-- with provider_id and that key went with it. This restores the check, aware of
-- the two kinds of provider, before any screen lets staff create or edit store
-- accounts (multi-provider Part 6):
--
--   Connected     needs a login and a Dealer ID, and the login must be for the
--                 provider's adapter (a TecAssured login for Riders Advantage).
--   Price Sheet   has no API, so its account takes no login.
--
-- Checked on every insert and update. The rows already there are checked first,
-- and the migration stops rather than install a check they would fail.

create or replace function fni.store_account_matches_provider()
returns trigger
language plpgsql
set search_path = fni, pg_temp
as $$
declare
  p_name text;
  p_kind text;
  p_adapter text;
  login_for text;
begin
  select name, kind, adapter into p_name, p_kind, p_adapter
  from fni.providers where id = new.provider_id;

  if p_kind = 'Connected' then
    if new.credential_id is null or coalesce(btrim(new.dealer_code), '') = '' then
      raise exception '% is rated through its API, so its store account needs a login and a Dealer ID.', p_name;
    end if;
    select provider into login_for from fni.provider_credentials where id = new.credential_id;
    if login_for is distinct from p_adapter then
      raise exception 'That login is for %, not for %.', coalesce(login_for, 'no provider'), p_name;
    end if;
  elsif new.credential_id is not null then
    raise exception '% has no API, so its store account takes no login.', p_name;
  end if;

  return new;
end;
$$;

-- The rows already there must pass before the check goes in.
do $$
declare
  bad integer;
begin
  select count(*) into bad
  from fni.store_provider_accounts a
  join fni.providers p on p.id = a.provider_id
  left join fni.provider_credentials c on c.id = a.credential_id
  where (p.kind = 'Connected' and (a.credential_id is null
          or coalesce(btrim(a.dealer_code), '') = ''
          or c.provider is distinct from p.adapter))
     or (p.kind = 'Price Sheet' and a.credential_id is not null);
  if bad > 0 then
    raise exception '% store accounts would fail the provider check. Fix them first.', bad;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'store_account_matches_provider'
      and tgrelid = 'fni.store_provider_accounts'::regclass
  ) then
    create trigger store_account_matches_provider
      before insert or update on fni.store_provider_accounts
      for each row execute function fni.store_account_matches_provider();
  end if;
end;
$$;

comment on function fni.store_account_matches_provider() is
  'A Connected provider''s store account needs a login for its adapter and a Dealer ID; '
  'a Price Sheet provider''s takes no login.';
