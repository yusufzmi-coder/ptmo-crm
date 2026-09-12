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
