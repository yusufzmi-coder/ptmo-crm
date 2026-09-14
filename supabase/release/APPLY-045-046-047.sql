-- ============================================================
-- RELEASE FASA 1 — 045 + 046 + 047, satu tampalan
--
-- CARA GUNA
--   Supabase Dashboard → SQL Editor → New query → tampal SEMUA → Run.
--
-- Ia SATU TRANSAKSI. Ketiga-tiganya mendarat, atau tiada satu pun.
-- Tiada keadaan separuh, jadi tiada urutan untuk diingat dan tiada
-- langkah untuk terlepas.
--
-- KENAPA 047 BOLEH MASUK SEKALI DI SINI
--   Runbook berkata 045 → 046 → deploy kod → 047, kerana 047 memecahkan
--   setiap URL lampiran tersimpan dan hanya kod yang menampungnya.
--   Deploy itu SUDAH BERLAKU — crm.ptmostaff.com menjawab 200 dengan
--   build semasa, dan resolveStoredMediaUrl() ada di dalamnya. Prasyarat
--   dipenuhi, jadi urutan tiga langkah runtuh kepada satu.
--
-- DISEMAK SEBELUM DIGABUNG
--   Tiada CONCURRENTLY, VACUUM, ALTER SYSTEM atau ADD VALUE dalam
--   mana-mana ketiga-tiga fail — kesemuanya selamat dalam transaksi.
--
-- SELEPAS RUN
--   Query terakhir mencetak tiga baris semakan. Ketiga-tiganya mesti
--   't'. Kalau mana-mana 'f', beritahu dan JANGAN sambung nombor.
-- ============================================================

BEGIN;


-- ============================================================
-- 045_presence_per_tab.sql
-- ============================================================

-- ============================================================
-- 045_presence_per_tab
--
-- One presence row per TAB, not per person.
--
-- Why
-- ---
-- Migration 024 keyed `member_presence` on `user_id` alone: one row per
-- person, reused forever. Migration 041 then put the open conversation
-- on that same row so the inbox could warn "someone else is in here".
--
-- But PresenceHeartbeat mounts in the dashboard shell, so EVERY
-- dashboard tab beats into that one row — each writing its own status
-- and its own open thread, every ~30s. The ordinary two-tab shape:
--
--   Tab 1  Inbox, thread X open, focused  -> ('online', X)
--   Tab 2  /dashboard, backgrounded       -> ('away',   NULL)
--
-- They overwrite each other in turn. `coViewers()` requires 'online'
-- AND a matching thread pointer, so for roughly half of every minute the
-- agent reading thread X was invisible to their colleagues, and the
-- guard 041 exists for did nothing — with no error, no log, and nothing
-- visible in the UI to say it had stopped working. Two or three people
-- at HQ cover sixteen branches from this inbox; the failure mode is the
-- parent getting three answers to one question.
--
-- A tab is what has a conversation open, so a tab is what the row must
-- describe.
--
-- Design
-- ------
-- The key becomes (user_id, tab_id). NOT (user_id, tab_id, account_id):
-- one tab can switch zone without closing, and with account_id in the
-- key that leaves the old zone's row behind — complete with its stale
-- `viewing_conversation_id` — for the full OFFLINE_AFTER_MS window (75s)
-- before staleness hides it. Colleagues in the zone the agent just left
-- would keep seeing their eye icon on a thread they had walked away
-- from. That is the ghost 041's own header set out to avoid. Keyed on
-- (user_id, tab_id), the same upsert OVERWRITES the row, account_id and
-- all, and the ghost never exists.
--
-- Growth
-- ------
-- 024's single-row-per-user design never needed cleaning up: the row was
-- reused forever. Per-tab breaks that — tab ids come from sessionStorage,
-- so every new tab is a new id and a closed tab leaves its row behind
-- with nothing to reclaim it.
--
-- So the heartbeat prunes as it goes: each beat deletes that caller's
-- OWN rows that have been silent for a day, while always keeping their
-- most recent one. Bounded per-user work on a path that already runs, no
-- cron, no new endpoint, no scheduled job to forget about.
--
-- Keeping the newest row matters and is not an optimisation: the Team
-- roster reads `last_seen_at` off an offline member to render "Offline —
-- last seen 3 days ago". Prune that last row and the roster degrades to
-- "a while ago" for everyone who is not currently online.
--
-- Relationship to 041
-- -------------------
-- This migration does not assume 041 was applied. 041 was applied by
-- hand through the SQL editor rather than the CLI, so its state could
-- not be confirmed from the repo. The column guard below is
-- ADD COLUMN IF NOT EXISTS, and the function is rebuilt in full here, so
-- 045 converges to the same schema whether 041 ran or not.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ---- tab_id + the new key ----------------------------------
-- Backfilled to 'legacy' for rows written before this migration: they
-- came from the one-row-per-user era, so they collapse onto a single
-- synthetic tab per user, which is exactly what they described. The
-- first real beat from each tab replaces them.
ALTER TABLE member_presence
  ADD COLUMN IF NOT EXISTS tab_id TEXT NOT NULL DEFAULT 'legacy';

-- Carried over from 041 so this migration stands alone if 041 never ran.
ALTER TABLE member_presence
  ADD COLUMN IF NOT EXISTS viewing_conversation_id UUID
    REFERENCES conversations(id) ON DELETE SET NULL;

-- Swap the primary key. Guarded on the current key shape so a re-run is
-- a no-op rather than an error: pg_index.indnatts is the column count of
-- the PK index, 1 while it is still 024's (user_id).
DO $$
DECLARE
  v_pk_name TEXT;
  v_pk_cols INT;
BEGIN
  SELECT c.conname, i.indnatts
    INTO v_pk_name, v_pk_cols
  FROM pg_constraint c
  JOIN pg_index i ON i.indexrelid = c.conindid
  WHERE c.conrelid = 'member_presence'::regclass
    AND c.contype = 'p';

  IF v_pk_name IS NOT NULL AND v_pk_cols = 1 THEN
    EXECUTE format(
      'ALTER TABLE member_presence DROP CONSTRAINT %I', v_pk_name
    );
    ALTER TABLE member_presence
      ADD CONSTRAINT member_presence_pkey PRIMARY KEY (user_id, tab_id);
  END IF;
END $$;

-- 041's index, restated so this migration does not depend on it having
-- run. "Who else is in this thread" is still the only query shape.
CREATE INDEX IF NOT EXISTS idx_member_presence_viewing
  ON member_presence (viewing_conversation_id)
  WHERE viewing_conversation_id IS NOT NULL;

-- The pruner below deletes by (user_id, last_seen_at); the PK's leading
-- column already serves the lookup, but this keeps the ORDER BY that
-- picks the newest row off a sort.
CREATE INDEX IF NOT EXISTS idx_member_presence_user_last_seen
  ON member_presence (user_id, last_seen_at DESC);

-- ---- heartbeat RPC, now per tab ----------------------------
--
-- A THIRD signature. Same reasoning as 041's second one: the old
-- function must be dropped, or two functions can answer the same
-- PostgREST call and which one runs depends on the exact keys the client
-- happens to send.
--
-- p_tab_id defaults to NULL and falls back to 'legacy' so a client that
-- has not been redeployed yet keeps working through the default — it
-- simply behaves as it did before 045 (all its tabs sharing one row)
-- instead of erroring. That makes the deploy order free: migrate first,
-- ship the JS whenever.
CREATE OR REPLACE FUNCTION public.touch_presence(
  p_status TEXT DEFAULT 'online',
  p_viewing_conversation_id UUID DEFAULT NULL,
  p_tab_id TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_viewing    UUID;
  v_tab        TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  -- Bounded so a client cannot grow the key without limit, and blank or
  -- whitespace-only ids collapse to the same synthetic tab as a caller
  -- that sent nothing at all.
  v_tab := COALESCE(NULLIF(btrim(p_tab_id), ''), 'legacy');
  v_tab := left(v_tab, 64);

  SELECT account_id INTO v_account_id
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'No account for caller' USING ERRCODE = '22023';
  END IF;

  -- Only store a pointer to a conversation in the caller's own account.
  -- An id from anywhere else is dropped silently rather than raised: a
  -- heartbeat must never fail loudly over a stale tab.
  IF p_viewing_conversation_id IS NOT NULL THEN
    SELECT id INTO v_viewing
    FROM conversations
    WHERE id = p_viewing_conversation_id
      AND account_id = v_account_id;
  END IF;

  INSERT INTO member_presence (
    user_id, tab_id, account_id, status, last_seen_at,
    viewing_conversation_id
  )
  VALUES (
    auth.uid(), v_tab, v_account_id, p_status, now(), v_viewing
  )
  ON CONFLICT (user_id, tab_id) DO UPDATE
    SET status                  = excluded.status,
        account_id              = excluded.account_id,
        last_seen_at            = excluded.last_seen_at,
        viewing_conversation_id = excluded.viewing_conversation_id;

  -- Reclaim this caller's dead tabs. Scoped to the caller so the work is
  -- bounded and no beat can be made expensive by another account's
  -- volume. A day is far beyond OFFLINE_AFTER_MS (75s) — anything
  -- deleted here has been invisible in every UI for hours.
  --
  -- The newest row is always spared, even when it is itself older than a
  -- day, so the Team roster keeps a `last_seen_at` to render for a
  -- member who has been away for a week.
  DELETE FROM member_presence mp
  WHERE mp.user_id = auth.uid()
    AND mp.last_seen_at < now() - interval '1 day'
    AND mp.tab_id <> (
      SELECT m2.tab_id
      FROM member_presence m2
      WHERE m2.user_id = auth.uid()
      ORDER BY m2.last_seen_at DESC, m2.tab_id
      LIMIT 1
    );
END;
$$;

ALTER FUNCTION public.touch_presence(TEXT, UUID, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.touch_presence(TEXT, UUID, TEXT)
  TO authenticated;

-- Retire the older signatures so exactly one function can answer a
-- heartbeat. Dropped AFTER the new one exists and is granted, so no
-- request window is left without a callable touch_presence. The
-- single-argument form is 024's — normally already gone via 041, but
-- dropped defensively in case 041 never ran.
DROP FUNCTION IF EXISTS public.touch_presence(TEXT, UUID);
DROP FUNCTION IF EXISTS public.touch_presence(TEXT);

-- ============================================================
-- ROLLBACK
-- ============================================================
--   DROP FUNCTION IF EXISTS public.touch_presence(TEXT, UUID, TEXT);
--   DROP INDEX IF EXISTS idx_member_presence_user_last_seen;
--   -- collapse back to one row per user, keeping each member's newest
--   DELETE FROM member_presence mp
--   WHERE EXISTS (
--     SELECT 1 FROM member_presence m2
--     WHERE m2.user_id = mp.user_id
--       AND (m2.last_seen_at, m2.tab_id) > (mp.last_seen_at, mp.tab_id)
--   );
--   ALTER TABLE member_presence DROP CONSTRAINT member_presence_pkey;
--   ALTER TABLE member_presence ADD CONSTRAINT member_presence_pkey
--     PRIMARY KEY (user_id);
--   ALTER TABLE member_presence DROP COLUMN IF EXISTS tab_id;
--   -- then re-run 041's touch_presence(TEXT, UUID) definition

-- ============================================================
-- 046_security_definer_hardening.sql
-- ============================================================

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

-- ============================================================
-- 047_storage_private.sql
-- ============================================================

-- ============================================================
-- 047_storage_private — close the three world-readable buckets
--
-- Why
-- ---
-- All three storage buckets were created `public = TRUE` and given an
-- unconditional read policy:
--
--   avatars      008_profile_avatars_storage.sql:15-19, policy :33-35
--   flow-media   016_flow_media.sql:57-61,              policy :88-90
--   chat-media   023_chat_media.sql:38-42,              policy :84-86
--
-- Each policy is `USING (bucket_id = '<name>')` — true for everyone,
-- including `anon`. Writes are correctly scoped by the path's first
-- segment (020:80-89, 023:89-98), so the asymmetry is deliberate-looking
-- but only half-considered: any unauthenticated caller can list and
-- fetch every account's files.
--
-- 039_inbound_media_mirror.sql:22-29 turned that from a latent problem
-- into an active one. It mirrors EVERY inbound customer attachment into
-- `chat-media`, and `mirror_inbound_media` defaults to TRUE, so every
-- photo, document and voice note a parent sends — across all centres and
-- all zones — lands in a bucket the open internet can read.
--
-- Under the zone model (044) this is cross-ZONE: zone B's attachments are
-- readable not merely by zone A's staff but by nobody-in-particular.
--
-- What this does
-- --------------
--   1. Flips all three buckets to `public = FALSE`, which is what stops
--      Supabase serving them from the unauthenticated
--      /object/public/<bucket>/<path> route.
--   2. Replaces each unconditional SELECT policy with one scoped the
--      same way the bucket's own write policy already is.
--
-- On the predicate shape
-- ----------------------
-- The read policies deliberately reuse the write policies' exact form —
--
--   EXISTS (SELECT 1 FROM public.profiles p
--            WHERE p.user_id = auth.uid()
--              AND ('account-' || p.account_id::text) = (storage.foldername(name))[1])
--
-- rather than parsing the uuid out of the path and calling
-- `is_account_member()`. Two reasons:
--
--   * No cast. `substring(path from 9)::uuid` would raise on any object
--     whose first segment is not `account-<uuid>` — including the legacy
--     pre-020 avatars/flow-media paths — and a raising policy does not
--     return "no rows", it fails the whole query.
--   * It already means "my ACTIVE account". After 044 a user's
--     `profiles.account_id` is the zone they are currently in, so this
--     predicate inherits zone isolation for free and stays fail-closed:
--     an HQ user who may enter four zones still reads only the files of
--     the one they are active in. Using `is_account_member_any()` here
--     would silently widen that, which is the mistake 044's header warns
--     against.
--
-- The legacy `auth.uid()::text = (storage.foldername(name))[1]` branch
-- from 020:87 is carried into the read policies too, so objects written
-- under the pre-020 convention stay readable by the person who uploaded
-- them rather than becoming permanently unreachable.
--
-- Avatars are pathed `<user_id>/<file>` (008:38-40), not
-- `account-<id>/...`, so they get their own predicate: your own avatar,
-- plus the avatars of people whose active account is the same as yours —
-- which is what the member list and inbox assignee chips need.
--
-- Application impact — read this before deploying
-- -----------------------------------------------
-- `getPublicUrl()` keeps returning a URL string after this migration, but
-- that URL now 400s. Three call sites produce one:
--   src/lib/storage/upload-media.ts:130
--   src/lib/whatsapp/mirror-inbound-media.ts:231
--   src/components/settings/profile-form.tsx:136
-- and `messages.media_url` PERSISTS what the first two returned
-- (webhook/route.ts:714), so historical rows hold URLs that stop
-- resolving. The companion application change stores the storage PATH and
-- serves it through an authenticated route that signs on demand —
-- mirroring the proxy shape the codebase already uses for un-mirrored
-- inbound media (`/api/whatsapp/media/<id>`).
--
-- Outbound media is the one case that genuinely needs an unauthenticated
-- URL: `sendMediaMessage` (meta-api.ts:286-300) passes `{ link }` and
-- Meta fetches it itself. That is served by a short-lived
-- `createSignedUrl()` generated at send time, not by a public bucket.
--
-- Deploy this migration and its application change together. Alone, this
-- file breaks media rendering; alone, the application change is pointless.
--
-- Idempotent — safe to re-run.
--
-- Rollback
-- --------
--   UPDATE storage.buckets SET public = TRUE
--     WHERE id IN ('avatars','flow-media','chat-media');
--   -- then restore the three `USING (bucket_id = '...')` policies from
--   -- 008:33-35, 016:88-90 and 023:84-86.
-- (This re-opens every zone's attachments to the internet.)
-- ============================================================

-- ============================================================
-- 1. The buckets are no longer public
--
-- This flag, not the policy, is what gates Supabase's
-- /object/public/... route. Both have to change: the flag stops the
-- unauthenticated route, the policy below stops a cross-account read
-- through the authenticated one.
-- ============================================================
UPDATE storage.buckets
SET public = FALSE
WHERE id IN ('avatars', 'flow-media', 'chat-media');

-- ============================================================
-- 2. chat-media — account-scoped reads
-- ============================================================
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read chat media" ON storage.objects;
CREATE POLICY "Members can read chat media"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'chat-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      -- Legacy pre-020 paths stay readable by their uploader.
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- 3. flow-media — account-scoped reads
-- ============================================================
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read flow media" ON storage.objects;
CREATE POLICY "Members can read flow media"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- 4. avatars — your own, plus your teammates'
--
-- Pathed `<user_id>/<file>`, so the predicate is about whose avatar it
-- is rather than which account folder it sits in. The second branch
-- compares the owner's active account to the caller's: teammates in the
-- zone you are currently in, nobody else.
-- ============================================================
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read avatars" ON storage.objects;
CREATE POLICY "Members can read avatars"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'avatars'
    AND (
      auth.uid()::text = (storage.foldername(name))[1]
      OR EXISTS (
        SELECT 1
        FROM public.profiles owner
        JOIN public.profiles me ON me.user_id = auth.uid()
        WHERE owner.user_id::text = (storage.foldername(name))[1]
          AND owner.account_id = me.account_id
      )
    )
  );

-- ============================================================
-- 5. Assert the outcome
--
-- `UPDATE` reports success on zero rows, and a misspelled policy name in
-- a DROP is a silent no-op, so the end state is asserted rather than
-- assumed — the same reason supabase/ci/verify-schema.sql exists.
-- ============================================================
DO $$
DECLARE
  v_public_cnt INT;
  v_bucket     TEXT;
  v_policy     TEXT;
BEGIN
  -- No bucket anywhere in the project may be public. Deliberately
  -- broader than the three named above: a fourth public bucket added
  -- later is the same leak by another name.
  SELECT count(*) INTO v_public_cnt FROM storage.buckets WHERE public;
  IF v_public_cnt > 0 THEN
    RAISE EXCEPTION
      '% storage bucket(s) are still public — unauthenticated callers can read every account''s files',
      v_public_cnt;
  END IF;

  -- The three unconditional read policies must be gone.
  FOREACH v_policy IN ARRAY ARRAY[
    'Avatars are publicly readable',
    'Flow media is publicly readable',
    'Chat media is publicly readable'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = v_policy
    ) THEN
      RAISE EXCEPTION 'the unconditional read policy "%" still exists', v_policy;
    END IF;
  END LOOP;

  -- And each bucket must have exactly one scoped read policy in its place.
  FOREACH v_policy IN ARRAY ARRAY[
    'Members can read chat media',
    'Members can read flow media',
    'Members can read avatars'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = v_policy
    ) THEN
      RAISE EXCEPTION 'the scoped read policy "%" was not created', v_policy;
    END IF;
  END LOOP;

  -- A scoped policy that forgot its auth.uid() term would read as
  -- "everyone" again. Cheap shape check against the catalogue.
  FOR v_bucket, v_policy IN
    SELECT 'chat-media', 'Members can read chat media'
    UNION ALL SELECT 'flow-media', 'Members can read flow media'
    UNION ALL SELECT 'avatars',    'Members can read avatars'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname = v_policy
        AND qual LIKE '%auth.uid()%'
    ) THEN
      RAISE EXCEPTION
        'read policy "%" for bucket % does not reference auth.uid() — it may be readable by anon',
        v_policy, v_bucket;
    END IF;
  END LOOP;

  RAISE NOTICE '047: avatars, flow-media and chat-media are private with account-scoped reads';
END
$$;

COMMIT;


-- ============================================================
-- SEMAKAN — ketiga-tiganya mesti 't'
-- ============================================================
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_name = 'member_presence' AND column_name = 'tab_id')
    AS "045 — presence per tab",
  NOT has_function_privilege('anon',
        'public.claim_ai_reply_slot(uuid, integer)', 'EXECUTE')
    AS "046 — anon tidak boleh panggil fungsi definer",
  NOT EXISTS (SELECT 1 FROM storage.buckets
               WHERE id IN ('avatars','chat-media','flow-media') AND public)
    AS "047 — ketiga-tiga bucket peribadi";
