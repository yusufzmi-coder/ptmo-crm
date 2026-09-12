-- ============================================================
-- 046_security_definer_hardening — lock down four callable-by-anyone
-- SECURITY DEFINER functions, and the two privilege columns on profiles
--
-- Why
-- ---
-- Postgres grants EXECUTE on new functions to PUBLIC by default. A
-- SECURITY DEFINER function therefore ships, unless explicitly revoked,
-- as "anyone may call this, and it runs as the owner" — which for an
-- owner of `postgres` means it runs past every RLS policy in the schema.
--
-- This repo already knows that. Migrations 007, 012, 018, 019, 022, 025,
-- 030, 036, 037, 038 and 042 all REVOKE before they GRANT, and 007 spells
-- out the reason: "Explicitly lock anon / authenticated out so an
-- authenticated user can't juice someone else's counter via RPC."
--
-- Four functions missed that step. They are reachable right now by any
-- `authenticated` or `anon` JWT through PostgREST, they run as postgres,
-- and none of them checks the caller against the row it mutates:
--
--   record_webhook_failure(uuid, int)     028:91-103
--     UPDATE webhook_endpoints ... WHERE id = endpoint_id, and disables
--     the endpoint once failure_count >= max_failures. Both arguments
--     come from the caller, so `max_failures => 1` disables another
--     zone's webhook endpoint in a single call.
--
--   _bcast_bump(uuid, text, int)          005:36-44
--     EXECUTE format('UPDATE broadcasts SET %I = GREATEST(0, %I + $1)
--     ... WHERE id = $2', col, col). The column IDENTIFIER and the row
--     id are both caller-chosen.
--
--   recompute_broadcast_counts(uuid)      005:107-129 (orig. 003:41-63)
--     UPDATE broadcasts by arbitrary id.
--
--   claim_ai_reply_slot(uuid, int)        029:118-131, granted in 031
--     Burns another conversation's AI auto-reply budget. 031's own header
--     says it is "never exposing a counter-mutating function to end
--     users" — which was the intent, but the REVOKE that would have made
--     it true was never written, so the default PUBLIC grant stands.
--
-- Under the zone model (044: one account per zone, `is_account_member()`
-- fail-closed on the ACTIVE zone) these are not merely cross-tenant —
-- they are cross-ZONE, reachable by any zone's staff against any other
-- zone's rows, with RLS bypassed entirely.
--
-- All four are called only under the service-role client, from the
-- inbound webhook path, verified at:
--   record_webhook_failure  <- src/lib/webhooks/deliver.ts:151, whose db
--                              is supabaseAdmin() at every
--                              dispatchWebhookEvent call site
--                              (webhook/route.ts:444, :626, :898)
--   claim_ai_reply_slot     <- src/lib/ai/auto-reply.ts:166, db =
--                              supabaseAdmin() (auto-reply.ts:48)
--   _bcast_bump             <- no application caller; invoked only by
--   recompute_broadcast_counts  broadcast_recipient_aggregate_trigger()
-- so `GRANT ... TO service_role` alone is sufficient and breaks nothing.
--
-- Trigger-invoked functions keep working after the revoke: Postgres
-- checks EXECUTE on a trigger function at CREATE TRIGGER time, not at
-- fire time, and `_bcast_bump` is additionally called from inside a
-- SECURITY DEFINER parent owned by postgres, where current_user is
-- already postgres.
--
-- What this does NOT do, deliberately
-- -----------------------------------
-- It does not add an `is_account_member()` guard inside _bcast_bump or
-- recompute_broadcast_counts as defence in depth. That would BREAK them:
-- both run from the aggregate trigger under the service role, where
-- auth.uid() is NULL, so is_account_member() returns false and broadcast
-- counters would silently stop updating. The revoke is the whole fix —
-- nothing may call them but the service role, which is trusted by
-- definition.
--
-- profiles privilege columns
-- --------------------------
-- Separately: `profiles.account_id` and `profiles.account_role` decide
-- which zone you are in and what you may do there. The only thing
-- stopping a viewer from writing them today is the trigger added in 034,
-- which is SECURITY INVOKER and gates on the string comparison
-- `current_user = 'authenticated'` (034:66) — a deny-list one entry long.
-- 034's own header flags this. `profiles_update`'s RLS (017:614-616)
-- scopes rows, not columns, and unlike `notifications` (027:50-51) there
-- is no column-level REVOKE.
--
-- So revoke UPDATE and grant back only the two columns the application
-- actually writes: src/components/settings/profile-form.tsx:144 updates
-- exactly `full_name` and `avatar_url`, and it is the only
-- authenticated-client write to profiles in the codebase. `beta_features`
-- (011) and `email` are read-only to clients — email changes go through
-- Supabase Auth (profile-form.tsx:158-163), not a profiles UPDATE.
--
-- This does not obstruct 044's set_active_account(), which rewrites
-- profiles.account_id: it is SECURITY DEFINER owned by postgres, so its
-- body runs with current_user = postgres, and column privileges are
-- tested against that, not against the calling role. postgres owns the
-- table. Same escape hatch 018/019 already rely on. The two layers use
-- different mechanisms — 034's trigger is a runtime check in PL/pgSQL,
-- this is a catalog-level refusal before any trigger runs — so keep both.
--
-- Idempotent — REVOKE and GRANT are no-ops when already in effect.
--
-- Rollback
-- --------
--   GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, int) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public._bcast_bump(uuid, text, int) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, int) TO PUBLIC;
--   GRANT UPDATE ON public.profiles TO authenticated;
-- (Rolling back is re-opening a cross-zone write surface. Don't.)
-- ============================================================

-- ============================================================
-- 1. record_webhook_failure
-- ============================================================
REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, int) FROM anon;
REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, int) TO service_role;

-- ============================================================
-- 2. _bcast_bump
--
-- The dynamic `format(... %I ...)` makes this the worst of the four: the
-- caller picks the column to mutate, not just the row.
-- ============================================================
REVOKE ALL ON FUNCTION public._bcast_bump(uuid, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._bcast_bump(uuid, text, int) FROM anon;
REVOKE ALL ON FUNCTION public._bcast_bump(uuid, text, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._bcast_bump(uuid, text, int) TO service_role;

-- ============================================================
-- 3. recompute_broadcast_counts
--
-- 003 created it and 005 replaced the body with the same signature
-- (bid UUID), so there is exactly one to revoke. The DO block below
-- asserts that, rather than trusting it.
-- ============================================================
REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) TO service_role;

-- ============================================================
-- 4. claim_ai_reply_slot
--
-- 031 already granted this to service_role; the missing half was the
-- revoke. Keep the grant (re-stating it is harmless and keeps this file
-- self-contained if 031 is ever reverted).
-- ============================================================
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;

-- ============================================================
-- 5. profiles: no client-side writes to the privilege columns
--
-- Revoke the table-wide UPDATE first, then grant back the two columns
-- the profile form needs. Order matters: a column grant does not
-- override a table-wide one.
-- ============================================================
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (full_name, avatar_url) ON public.profiles TO authenticated;

-- ============================================================
-- 6. Assert the outcome
--
-- Every statement above is a no-op if the function signature does not
-- exist — REVOKE on a missing function raises, but a TYPO'd signature
-- that happens to match an overload would not. More importantly the
-- grants themselves are invisible to `db reset`'s "no errors" check, so
-- assert the end state the way 042 and supabase/ci/verify-schema.sql do.
-- ============================================================
DO $$
DECLARE
  v_fn   TEXT;
  v_oid  OID;
  v_cnt  INT;
BEGIN
  -- 3's premise: exactly one recompute_broadcast_counts, not two overloads.
  SELECT count(*) INTO v_cnt
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'recompute_broadcast_counts';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION
      'expected exactly 1 recompute_broadcast_counts, found % — an un-revoked overload may remain', v_cnt;
  END IF;

  -- None of the four may be executable by PUBLIC, anon or authenticated.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.record_webhook_failure(uuid, int)',
    'public._bcast_bump(uuid, text, int)',
    'public.recompute_broadcast_counts(uuid)',
    'public.claim_ai_reply_slot(uuid, integer)'
  ]
  LOOP
    v_oid := v_fn::regprocedure::oid;

    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is still EXECUTE-able by PUBLIC', v_fn;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is still EXECUTE-able by anon', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is still EXECUTE-able by authenticated', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is NOT EXECUTE-able by service_role — the webhook path would break', v_fn;
    END IF;
  END LOOP;

  -- profiles: privilege columns closed, display columns open.
  IF has_column_privilege('authenticated', 'public.profiles', 'account_id', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can still UPDATE profiles.account_id';
  END IF;
  IF has_column_privilege('authenticated', 'public.profiles', 'account_role', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can still UPDATE profiles.account_role';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated cannot UPDATE profiles.full_name — the profile form would break';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated cannot UPDATE profiles.avatar_url — the profile form would break';
  END IF;

  RAISE NOTICE '046: four SECURITY DEFINER functions locked to service_role; profiles privilege columns revoked';
END
$$;
