-- 0005_zoho_sync_sweeper
--
-- Schedules the Zoho mirror sweeper inside Postgres.
--
-- ARCHITECTURE.md: "No Vercel crons for business logic. Scheduling is pg_cron
-- inside Postgres invoking Edge Functions via pg_net." This replaces the
-- one-minute Vercel cron that used to hit /api/sync/process.
--
-- The webhook drains inline, so this sweep is the safety net rather than the
-- main path: it picks up rows a webhook enqueued but could not finish, and
-- rows whose Zoho read failed and are owed a retry. Five minutes is also a
-- deliberate step down from the old one-minute cadence — each cold isolate
-- refreshes its own Zoho access token, and at one-minute the token endpoint
-- started answering "Access Denied".
--
-- The shared secret is NOT in this file. It lives in Supabase Vault under
-- 'zoho_sweeper_secret' and is read at run time, so the migration is safe to
-- commit. Create it once per environment with:
--
--   select vault.create_secret('<ZOHO_WEBHOOK_SECRET>', 'zoho_sweeper_secret', '...');
--
-- It must equal the ZOHO_WEBHOOK_SECRET Edge Function secret, or every sweep
-- gets a 401.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: re-running the migration re-points the job rather than failing
-- or leaving a duplicate behind.
select cron.unschedule('zoho-sync-sweeper')
 where exists (select 1 from cron.job where jobname = 'zoho-sync-sweeper');

select cron.schedule(
  'zoho-sync-sweeper',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := 'https://fovccigwlcmmzfubpfny.supabase.co/functions/v1/zoho-sync?mode=drain',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Header rather than ?secret= so the value stays out of request logs.
      'x-webhook-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'zoho_sweeper_secret')
    ),
    body := '{}'::jsonb,
    -- The drain budgets 50s of work. pg_net is fire-and-forget: if it gives up
    -- waiting, the function still runs to completion, we just lose the
    -- response row in net._http_response.
    timeout_milliseconds := 60000
  );
  $job$
);
