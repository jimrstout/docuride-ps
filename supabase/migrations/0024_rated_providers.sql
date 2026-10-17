-- 0024_rated_providers.sql
--
-- The providers a session's latest rating covered. Multi-provider Part 4.
--
-- Rating now asks every provider the deal's menu template needs and records one
-- fni.rated_offers row each. A later rating can need different providers (the
-- deal's make was corrected, so another template matches), and the earlier
-- provider's row stays as a record. The menu, the save and Verify read only the
-- rows of the providers named here, so an old row can neither add products to
-- the menu nor hold it back as out of date.
--
-- Empty means the session has not been rated since this column arrived; every
-- row is then read, which is how it worked with one provider. Existing
-- sessions are backfilled with the providers they have rows for.

alter table fni.sessions add column if not exists rated_provider_ids uuid[] not null default '{}';

update fni.sessions s
set rated_provider_ids = r.ids
from (
  select session_id, array_agg(provider_id order by provider_id) as ids
  from fni.rated_offers
  group by session_id
) r
where r.session_id = s.id and s.rated_provider_ids = '{}';

comment on column fni.sessions.rated_provider_ids is
  'The providers the latest rating covered. Only their fni.rated_offers rows make the menu.';
