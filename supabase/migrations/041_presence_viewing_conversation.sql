-- ============================================================
-- 041_presence_viewing_conversation
--
-- Show who else has a conversation open.
--
-- Why
-- ---
-- The inbox is about to be shared: two or three people at HQ covering
-- sixteen branches while branch staff are away. Sorted newest-first,
-- they all see the same unanswered thread, all open it, and all reply.
-- The parent gets three answers to one question, from what looks to
-- them like one person.
--
-- Nothing in the product currently says "someone else is in here".
-- Migration 024 gave every member an account-level presence heartbeat
-- (online / away, with offline derived from staleness). This extends
-- that same row with WHICH conversation the tab is looking at, so the
-- thread can warn before anyone types rather than after they send.
--
-- Design
-- ------
-- One extra column on the existing heartbeat row — no new table, no
-- new write path, no extra round trip. The client already beats every
-- ~30s; it now reports the open thread in the same call.
--
-- ON DELETE SET NULL so deleting a conversation cannot block on a
-- presence row, and a stale pointer resolves to "viewing nothing".
--
-- Staleness is still the source of truth for "is this person here":
-- a closed tab stops beating and the viewer derives offline exactly as
-- before. A viewer whose heartbeat has gone stale is not shown, so a
-- crashed tab does not leave a ghost sitting in a thread forever.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE member_presence
  ADD COLUMN IF NOT EXISTS viewing_conversation_id UUID
    REFERENCES conversations(id) ON DELETE SET NULL;

COMMENT ON COLUMN member_presence.viewing_conversation_id IS
  'The conversation this member currently has open, or NULL. Reported '
  'by the client heartbeat and only trusted after the RPC confirms the '
  'conversation belongs to the caller''s own account. Read together '
  'with last_seen_at: a stale row is offline and its pointer ignored.';

-- Finding "who else is in this thread" is the only query shape, and it
-- is asked every time a thread is opened.
CREATE INDEX IF NOT EXISTS idx_member_presence_viewing
  ON member_presence (viewing_conversation_id)
  WHERE viewing_conversation_id IS NOT NULL;

-- ---- heartbeat RPC, now carrying the open thread ---------------
--
-- NOTE: this is a new SIGNATURE, so CREATE OR REPLACE does not replace
-- 024's touch_presence(TEXT) — it creates an overload alongside it. The
-- old one is dropped below, otherwise two functions could answer the
-- same PostgREST call and which one runs would depend on the exact keys
-- a client happens to send.
--
-- The new argument is optional and defaults to NULL, so a client that
-- has not yet been taught to send one keeps working unchanged: the
-- single-key call resolves to this function through the default.
--
-- The conversation is verified against the caller's own account before
-- it is stored. A client could otherwise claim to be viewing another
-- tenant's thread, and that claim would surface in their UI.
CREATE OR REPLACE FUNCTION public.touch_presence(
  p_status TEXT DEFAULT 'online',
  p_viewing_conversation_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_viewing    UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'No account for caller' USING ERRCODE = '22023';
  END IF;

  -- Only store a pointer to a conversation in the caller's own
  -- account. An id from anywhere else is dropped silently rather than
  -- raised: a heartbeat must never fail loudly over a stale tab.
  IF p_viewing_conversation_id IS NOT NULL THEN
    SELECT id INTO v_viewing
    FROM conversations
    WHERE id = p_viewing_conversation_id
      AND account_id = v_account_id;
  END IF;

  INSERT INTO member_presence (
    user_id, account_id, status, last_seen_at, viewing_conversation_id
  )
  VALUES (auth.uid(), v_account_id, p_status, now(), v_viewing)
  ON CONFLICT (user_id) DO UPDATE
    SET status                  = excluded.status,
        account_id              = excluded.account_id,
        last_seen_at            = excluded.last_seen_at,
        viewing_conversation_id = excluded.viewing_conversation_id;
END;
$$;

ALTER FUNCTION public.touch_presence(TEXT, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.touch_presence(TEXT, UUID)
  TO authenticated;

-- Retire 024's single-argument version so only one function can answer
-- a heartbeat. Dropped AFTER the new one exists and is granted, so no
-- request window is left without a callable touch_presence.
DROP FUNCTION IF EXISTS public.touch_presence(TEXT);

-- ============================================================
-- ROLLBACK
-- ============================================================
--   DROP FUNCTION IF EXISTS public.touch_presence(TEXT, UUID);
--   DROP INDEX IF EXISTS idx_member_presence_viewing;
--   ALTER TABLE member_presence DROP COLUMN IF EXISTS viewing_conversation_id;
--   -- then re-run 024's touch_presence(TEXT) definition
