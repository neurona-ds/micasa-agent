-- ============================================================================
-- Almuerzo cycle auto-advance — owned by Supabase pg_cron (NOT the bot).
-- ============================================================================
-- Why: the bot used to advance the cycle on every inbound message inside
-- getCurrentCycle(). That write-on-read path was non-atomic; on 2026-05-23 a
-- burst of concurrent test messages (fake phones 593000000081-84,
-- 593888888801-03) each triggered an advance and raced, advancing the cycle 8
-- times in 2 minutes and corrupting the rotation by +3 (mod 5).
--
-- Fix: getCurrentCycle() is now a PURE READ. The weekly advance lives here, in a single
-- scheduled executor that runs exactly once per week (Friday 23:45 Ecuador, AFTER service
-- closes, so the weekend already holds next week's cycle) — immune to message volume and
-- races by construction.
--
-- Run this ONCE in the Supabase SQL editor (Dashboard > SQL Editor).
-- ============================================================================

-- 1. Enable pg_cron (also enable-able via Dashboard > Database > Extensions).
create extension if not exists pg_cron;

-- 2. Atomic advance function: C1→C2→…→C5→C1, updates date + appends audit log.
create or replace function advance_almuerzo_cycle()
returns void
language plpgsql
security definer
as $$
declare
  cur    int;
  cnt    int;
  nxt    int;
  monday text;
  logval jsonb;
begin
  select coalesce(value::int, 1) into cur from config where key = 'current_cycle';
  select coalesce(value::int, 5) into cnt from config where key = 'almuerzo_cycle_count';
  if cur is null then cur := 1; end if;
  if cnt is null then cnt := 5; end if;

  nxt := (cur % cnt) + 1;

  -- Monday of the week this cycle will SERVE, in Ecuador time (America/Guayaquil = UTC-5,
  -- no DST). The job runs Friday 23:45 Ecuador for the UPCOMING week, so add 3 days (Fri→Mon)
  -- before truncating. date_trunc('week', ...) is ISO (Monday-based).
  monday := to_char(
    (date_trunc('week', (now() at time zone 'America/Guayaquil') + interval '3 days'))::date,
    'YYYY-MM-DD'
  );

  update config set value = nxt::text  where key = 'current_cycle';
  update config set value = monday     where key = 'cycle_last_updated';

  -- Append to the audit log (JSON array stored as text in config.value).
  select coalesce(value::jsonb, '[]'::jsonb) into logval
    from config where key = 'almuerzo_cycle_log';

  logval := logval || jsonb_build_object(
    'advanced_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'from_cycle',  cur,
    'to_cycle',    nxt,
    'week_of',     monday,
    'source',      'pg_cron'
  );

  update config set value = logval::text where key = 'almuerzo_cycle_log';
end;
$$;

-- 3. Schedule: every Friday at 23:45 Ecuador time (America/Guayaquil = UTC-5, no DST)
--    = Saturday 04:45 UTC. Cron string '45 4 * * 6' = minute 45, hour 04, any day-of-month,
--    any month, day-of-week 6 (Saturday) — all in UTC.
--    WHY Friday night: it advances AFTER Friday service closes (15:30 Ecuador), so the entire
--    weekend the DB already holds NEXT week's cycle. Weekend menu queries are then correct
--    straight from the DB, with NO cycle+1 adjustment in the app.
--    TIMEZONE — IMPORTANT: pg_cron interprets the cron string in the DATABASE server timezone.
--    Supabase runs the DB in UTC. Verify with:  show timezone;   -- expect 'UTC'
--    This is also confirmed empirically by the audit log (the prior '5 5 * * 1' job fired at
--    exactly 05:05:00Z). Keep the DB in UTC; if its timezone is ever changed, this trigger
--    time shifts. (The date math above is Ecuador-aware via America/Guayaquil regardless.)
--    If a job with this name already exists, unschedule it first (safe to run).
select cron.unschedule('advance-almuerzo-cycle')
  where exists (select 1 from cron.job where jobname = 'advance-almuerzo-cycle');

select cron.schedule(
  'advance-almuerzo-cycle',
  '45 4 * * 6',
  $$select advance_almuerzo_cycle();$$
);

-- ----------------------------------------------------------------------------
-- Verify / inspect:
--   select * from cron.job where jobname = 'advance-almuerzo-cycle';
--   select * from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'advance-almuerzo-cycle')
--     order by start_time desc limit 5;
--
-- Test the advance manually (this WILL advance the cycle — only run to test):
--   select advance_almuerzo_cycle();
--
-- Remove the schedule entirely:
--   select cron.unschedule('advance-almuerzo-cycle');
-- ----------------------------------------------------------------------------
