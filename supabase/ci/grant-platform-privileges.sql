-- ============================================================
-- grant-platform-privileges — make the CI database match production
--
-- Run after the migrations and before `supabase test db`, in both jobs
-- of .github/workflows/migrations.yml.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- No migration in this repo grants table privileges to `anon` or
-- `authenticated`. Every GRANT under supabase/migrations is on a
-- FUNCTION, with two exceptions that grant a single COLUMN. The
-- application nevertheless reads and writes ~39 tables as those roles,
-- and does so successfully in production.
--
-- It works there because the hosted platform grants them, and it does
-- not work under the local CLI. The difference is measurable:
--
--   ALTER DEFAULT PRIVILEGES for schema `public`, set by `postgres`:
--     anon=Dxtm  authenticated=Dxtm  service_role=Dxtm
--
--   Dxtm is TRUNCATE, REFERENCES, TRIGGER, MAINTAIN. No SELECT, INSERT,
--   UPDATE or DELETE. The same default for schema `storage`, in the same
--   database, reads `arwdDxtm` — the full set — so this is specific to
--   `public`, not a general absence. It also survives `db reset`, which
--   restores it; setting it before the reset does not help.
--
-- Confirmed on both sides rather than assumed:
--
--   local (CLI 2.113.0)  role_table_grants for profiles and contacts
--                        lists only REFERENCES, TRIGGER, TRUNCATE.
--   production           SELECT through PostgREST returns HTTP 200 on
--                        profiles, contacts and centres — as
--                        `authenticated` with a token, and as `anon`
--                        without one.
--
-- The `anon` response in production is `200 []`, not 403. That is the
-- distinction this file protects: a GRANT decides whether a query may
-- run, RLS decides which rows come back. With no grant a request fails
-- before any policy is consulted — which is why zone_isolation_test
-- could not reach the policies it exists to test.
--
-- ORDER MATTERS, AND IT IS THE WHOLE DIFFICULTY
-- ---------------------------------------------
-- In production the platform grants first and the migrations narrow
-- afterwards. Here the grant can only happen after, because `db reset`
-- restores the restricted default. A blanket grant therefore UNDOES
-- every column-level narrowing the migrations performed.
--
-- Two migrations narrow a column, and both are re-applied below:
--
--   027:50-51  notifications — UPDATE reduced to (read_at)
--   046:162-163 profiles     — UPDATE reduced to (full_name, avatar_url)
--
-- This was not theoretical. A first version of this file granted
-- UPDATE across the board and verify-schema.sql caught it immediately:
-- "authenticated can UPDATE a profiles privilege column (migration 046
-- regressed)". 027 has no such check — see the note added to
-- verify-schema.sql — so it would have regressed silently.
--
-- WHAT THIS IS NOT
-- ----------------
-- It does not loosen an assertion. The tests still query real tables as
-- real personas through the real policies and count rows; this only
-- lets them reach the policies, which is where their assertions live.
-- If RLS is wrong they still go red.
--
-- Nor is it a migration. Production already holds these privileges, so
-- applying it there would be a no-op — and a migration handing out table
-- access should be read deliberately, not inherited from a CI helper.
-- ============================================================

-- One statement, wrapped in DO. The CLI runs these files through
-- `db query --file`, which sends the file as a single prepared
-- statement and rejects anything containing more than one command —
-- the same reason verify-schema.sql is shaped this way.
DO $$
DECLARE
  missing text;
BEGIN
  -- Schema access first: without USAGE a table grant is unreachable.
  EXECUTE 'GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role';

  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public '
          'TO anon, authenticated, service_role';

  -- An INSERT that cannot read its sequence fails on nextval, not on a
  -- policy, which would look like an RLS failure and is not one.
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public '
          'TO anon, authenticated, service_role';

  -- ---- restore what the migrations narrowed -------------------
  -- Copied from the migrations named above rather than invented here.
  -- If either migration changes its column list, this drifts — which is
  -- what the verification block at the end of this file, and the checks
  -- in verify-schema.sql, exist to catch.

  -- 027:50-51
  EXECUTE 'REVOKE UPDATE ON public.notifications FROM authenticated';
  EXECUTE 'GRANT UPDATE (read_at) ON public.notifications TO authenticated';

  -- 046:162-163
  EXECUTE 'REVOKE UPDATE ON public.profiles FROM authenticated';
  EXECUTE 'GRANT UPDATE (full_name, avatar_url) ON public.profiles TO authenticated';

  -- ---- prove it landed ----------------------------------------
  -- A silent no-op here sends the suite back to failing on permissions
  -- with no clue why, so fail loudly instead.
  -- By OID, not by name. The name form —
  --   has_table_privilege(role, format('public.%I', tablename), 'SELECT')
  -- over pg_tables — throws `relation "public.instances" does not exist`,
  -- because the planner is free to evaluate the function before the
  -- schemaname filter and so builds `public.instances` out of the
  -- auth.instances row. An OID needs no resolution and cannot misfire.
  SELECT string_agg(c.relname, ', ')
    INTO missing
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND NOT has_table_privilege('authenticated', c.oid, 'SELECT');

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'authenticated still lacks SELECT on: %', missing;
  END IF;

  -- And prove the narrowings survived this file, not just the migration.
  IF has_column_privilege('authenticated', 'public.profiles', 'account_role', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'account_id', 'UPDATE')
  THEN
    RAISE EXCEPTION 'this file re-opened a profiles privilege column (046 undone)';
  END IF;

  IF has_column_privilege('authenticated', 'public.notifications', 'user_id', 'UPDATE') THEN
    RAISE EXCEPTION 'this file re-opened notifications.user_id for UPDATE (027 undone)';
  END IF;

  RAISE NOTICE 'platform privileges granted; 027 and 046 narrowings intact';
END $$;
