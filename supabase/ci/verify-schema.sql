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
  IF has_function_privilege('public', 'public._bcast_bump(uuid, text, int)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('public', 'public.record_webhook_failure(uuid, int)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('public', 'public.recompute_broadcast_counts(uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('public', 'public.claim_ai_reply_slot(uuid, integer)'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'a SECURITY DEFINER counter function is EXECUTE-able by PUBLIC (migration 046 regressed)';
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
