-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- Multi-number per account (040) — a branch is a whatsapp_config row,
  -- so the label/is_primary columns and the conversation pointer are
  -- what make branch attribution possible at all.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
      AND column_name = 'is_primary'
  ) THEN
    RAISE EXCEPTION 'whatsapp_config.is_primary is missing — migration 040 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'whatsapp_config_id'
  ) THEN
    RAISE EXCEPTION 'conversations.whatsapp_config_id is missing — migration 040 did not apply';
  END IF;

  -- Co-viewer presence (041).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'member_presence'
      AND column_name = 'viewing_conversation_id'
  ) THEN
    RAISE EXCEPTION 'member_presence.viewing_conversation_id is missing — migration 041 did not apply';
  END IF;

  -- Multi-zone membership (044).
  IF to_regclass('public.account_members') IS NULL THEN
    RAISE EXCEPTION 'public.account_members is missing — migration 044 did not apply';
  END IF;

  -- The backfill is the whole reason 044 is safe to land on a live
  -- database: without it every existing user loses access the moment
  -- is_account_member starts reading memberships.
  IF EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.account_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM account_members m
        WHERE m.user_id = p.user_id AND m.account_id = p.account_id
      )
  ) THEN
    RAISE EXCEPTION 'a profile has no matching account_members row — the 044 backfill did not run';
  END IF;

  -- Dropping this index is what lets one person own several zones.
  -- Re-creating it (an upstream merge, a re-run of 017) would break
  -- multi-zone ownership quietly, so assert it is gone.
  IF to_regclass('public.idx_accounts_one_per_owner') IS NOT NULL THEN
    RAISE EXCEPTION 'idx_accounts_one_per_owner still exists — one-account-per-owner would block multi-zone ownership';
  END IF;

  -- The zone switcher and the cross-zone helper. Checked by name AND
  -- arity: a signature change would leave the old function in place
  -- and the new call sites failing at runtime.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'set_active_account'
      AND pg_get_function_identity_arguments(p.oid) = 'p_account_id uuid'
  ) THEN
    RAISE EXCEPTION 'set_active_account(uuid) is missing — migration 044 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_account_member_any'
  ) THEN
    RAISE EXCEPTION 'is_account_member_any is missing — migration 044 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'my_accounts'
  ) THEN
    RAISE EXCEPTION 'my_accounts is missing — migration 044 did not apply';
  END IF;

  -- SECURITY DEFINER hardening (046).
  --
  -- ORDERING: these two assertions only hold once 046 has landed.
  -- They must not be committed ahead of it, or CI goes red on a
  -- correct tree. 046 asserts the same thing at apply time; this
  -- catches a REGRESSION on every later PR, which is the part that
  -- actually decays over time.
  --
  -- These four are SECURITY DEFINER and mutate counters. Postgres
  -- grants EXECUTE to PUBLIC by default, so before 046 any JWT could
  -- call them with postgres privileges and no tenant check at all.
  --
  -- Checked BY NAME, not by signature, and that is the point.
  --
  -- 046 revokes an exact signature: `claim_ai_reply_slot(uuid, integer)`.
  -- A REVOKE naming a signature nothing owns does not pass quietly —
  -- Postgres raises 42883 — so a typo cannot slip through. What CAN slip
  -- through is a second function sharing the name with a different
  -- argument list: the REVOKE hits the one it names, the overload keeps
  -- Postgres's default grant to PUBLIC, and the migration reports
  -- success because from its point of view it did exactly what it said.
  --
  -- 046 guards that for recompute_broadcast_counts alone. The other
  -- three have no such guard, and neither has anything after 046 — an
  -- overload added by a later migration would re-open the hole with
  -- every assertion in 046 still passing, because 046 only ever runs
  -- once. Hence a standing check here, over every function carrying one
  -- of these names.
  IF (
    SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_bcast_bump', 'record_webhook_failure',
                         'recompute_broadcast_counts', 'claim_ai_reply_slot')
  ) <> 4 THEN
    RAISE EXCEPTION
      'expected exactly 4 SECURITY DEFINER counter functions, found %: % — an overload is un-revoked, or one was dropped',
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('_bcast_bump', 'record_webhook_failure',
                            'recompute_broadcast_counts', 'claim_ai_reply_slot')),
      (SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('_bcast_bump', 'record_webhook_failure',
                            'recompute_broadcast_counts', 'claim_ai_reply_slot'));
  END IF;

  -- anon and authenticated are named separately from PUBLIC on purpose.
  -- A direct GRANT to anon does not show up in the PUBLIC check, so the
  -- older single-role assertion here would have passed while anon could
  -- still call them.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_bcast_bump', 'record_webhook_failure',
                         'recompute_broadcast_counts', 'claim_ai_reply_slot')
       AND (has_function_privilege('public', p.oid, 'EXECUTE')
         OR has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION
      'a SECURITY DEFINER counter function is EXECUTE-able by PUBLIC, anon or authenticated (migration 046 regressed): %',
      (SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('_bcast_bump', 'record_webhook_failure',
                            'recompute_broadcast_counts', 'claim_ai_reply_slot')
          AND (has_function_privilege('public', p.oid, 'EXECUTE')
            OR has_function_privilege('anon', p.oid, 'EXECUTE')
            OR has_function_privilege('authenticated', p.oid, 'EXECUTE')));
  END IF;

  -- The positive half. An assertion that only proves absence passes just
  -- as happily when the migration never applied at all — the 027 lesson.
  -- If service_role loses EXECUTE the webhook and broadcast paths break
  -- in production while every check above stays green.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_bcast_bump', 'record_webhook_failure',
                         'recompute_broadcast_counts', 'claim_ai_reply_slot')
       AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      'a SECURITY DEFINER counter function is NOT EXECUTE-able by service_role — the webhook path would break: %',
      (SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('_bcast_bump', 'record_webhook_failure',
                            'recompute_broadcast_counts', 'claim_ai_reply_slot')
          AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE'));
  END IF;

  -- Column-level backstop for the 034 trigger. Belt and braces: the
  -- trigger checks at run time, this closes it at the catalog level.
  -- set_active_account (044) is unaffected — it is SECURITY DEFINER
  -- owned by postgres, so it runs as the table owner.
  IF has_column_privilege('authenticated', 'public.profiles', 'account_role', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'account_id', 'UPDATE')
  THEN
    RAISE EXCEPTION 'authenticated can UPDATE a profiles privilege column (migration 046 regressed)';
  END IF;

  -- profiles.account_role is NOT NULL, and has been since 017 — not 044.
  --
  --   017:122  ADD COLUMN account_role account_role_enum   (nullable)
  --   017:275  ALTER COLUMN account_role SET NOT NULL      (same file)
  --
  -- This assertion exists because null_role_backfill_test.sql was parked:
  -- it seeded a NULL role to test 044's backfill, and that row cannot be
  -- written. Parking it without this would have dropped the coverage
  -- along with the wrong premise.
  --
  -- It bites on the way the state could actually come back — a
  -- DROP NOT NULL in some later migration — which is what that test was
  -- reaching for and could not express.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name = 'account_role' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'profiles.account_role is nullable — 017:275 was undone, and a profile with no role is locked out of every RLS policy at once';
  END IF;

  -- 027:50-51 narrows notifications the same way 046 narrows profiles,
  -- and had no check here — so a blanket grant would have re-opened it
  -- silently while the profiles check above caught its twin. Added after
  -- exactly that happened while writing grant-platform-privileges.sql.
  IF has_column_privilege('authenticated', 'public.notifications', 'user_id', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.notifications', 'account_id', 'UPDATE')
  THEN
    RAISE EXCEPTION 'authenticated can UPDATE a notifications column beyond read_at (migration 027 regressed)';
  END IF;

  -- And the positive half: read_at must still be writable, or the
  -- mark-as-read path is broken and no assertion above would say so.
  IF NOT has_column_privilege('authenticated', 'public.notifications', 'read_at', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated cannot UPDATE notifications.read_at (migration 027 did not apply)';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
