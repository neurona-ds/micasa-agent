-- ============================================================================
-- Enable Row Level Security (RLS) on every table in the public schema.
--
-- WHY: the bot previously connected with the PUBLISHABLE (anon) key while RLS
-- was disabled, which left customer PII, chat history and bank details readable
-- AND writable by anyone holding that public key.
--
-- With RLS enabled and NO policies defined, the anon/publishable key is denied
-- all access, while the service_role key (now used by the bot) BYPASSES RLS and
-- keeps working normally.
--
-- ⚠️ RUN THIS ONLY AFTER the bot is deployed with SUPABASE_SECRET_KEY (service
-- role). Otherwise the live bot loses database access until it is.
--
-- Safe to run multiple times (idempotent).
-- ============================================================================

do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security;', r.tablename);
    raise notice 'RLS enabled on public.%', r.tablename;
  end loop;
end $$;

-- Verify — every row should show rowsecurity = true:
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;
