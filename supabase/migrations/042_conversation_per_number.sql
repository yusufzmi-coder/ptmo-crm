-- ============================================================
-- 042_conversation_per_number
--
-- One thread per (account, contact, NUMBER) — not per (account, contact).
--
-- Why
-- ---
-- Migration 036 added UNIQUE(account_id, contact_id) to conversations:
-- one contact, one thread, for the whole account. That was correct while
-- an account held exactly one WhatsApp number.
--
-- Migration 040 then let an account hold many numbers — for Minda Optima
-- one per branch — and gave each conversation a `whatsapp_config_id` so a
-- reply leaves on the number the parent actually wrote to. The two
-- constraints contradict each other, and 036 wins:
--
--   Mon  a parent messages Rawang        -> thread created, stamped Rawang
--   Thu  the same parent messages Batu Caves
--          -> UNIQUE(account_id, contact_id) forces the inbound message
--             into the SAME thread, which is still stamped Rawang
--          -> staff reply, resolve-config returns Rawang, and the answer
--             to a Batu Caves question goes out on the Rawang number
--
-- The parent hears from a branch they never contacted, on a number that
-- has no history of their question. That is exactly the failure 040 was
-- written to prevent, reintroduced one migration earlier. With sixteen
-- branches in one valley and parents who have more than one child, it is
-- not an edge case.
--
-- What this does
-- --------------
--   1. redefines merge_duplicate_conversations() to group by the number
--      as well, so it can never again collapse two branches into one;
--   2. replaces the unique index with one that includes the number.
--
-- On NULLs
-- --------
-- `whatsapp_config_id` is nullable by design: threads that predate 040
-- carry none, and 040's ON DELETE SET NULL clears it when a number is
-- disconnected. A plain UNIQUE(a, b, c) would treat every NULL as
-- distinct and let unbranded duplicates pile up again — the precise bug
-- 036 existed to stop. Postgres 15's NULLS NOT DISTINCT would fix that,
-- but this repo's migrations are replayed by the Supabase CLI against
-- whatever Postgres it ships, so the index folds NULL to a sentinel UUID
-- instead. Same guarantee, no version floor: at most one unbranded
-- thread per (account, contact), and it is the one the webhook adopts on
-- the next inbound message.
--
-- Data
-- ----
-- No thread is split and none is merged. Every account that holds one
-- number had its conversations backfilled by 040, so the new grouping is
-- identical to the old one for existing data — this migration changes
-- what is possible from here, not what is already stored.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ---- 1. the merge helper learns about branches -----------------
-- Same body as 036 apart from the grouping key and one added column on
-- the survivor update. Redefined rather than dropped so the 036 grant
-- and ownership carry over untouched.
CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group    RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_all      UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id,
           contact_id,
           COALESCE(whatsapp_config_id, '00000000-0000-0000-0000-000000000000'::uuid) AS number_key,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids,
           COALESCE(SUM(unread_count), 0)                AS total_unread
    FROM conversations
    GROUP BY account_id,
             contact_id,
             COALESCE(whatsapp_config_id, '00000000-0000-0000-0000-000000000000'::uuid)
    HAVING count(*) > 1
  LOOP
    v_all      := v_group.ids;
    v_survivor := v_all[1];
    v_losers   := v_all[2:array_length(v_all, 1)];

    -- Re-point every conversation-scoped child from the losers onto the
    -- survivor, exactly as 036 did. All rows in this group share one
    -- number, so nothing crosses a branch boundary.
    UPDATE messages          SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE message_reactions SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE deals             SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE flow_runs         SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE notifications     SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE ai_usage_log      SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);

    UPDATE conversations c
    SET unread_count      = v_group.total_unread,
        last_message_text = lm.content_text,
        last_message_at   = lm.created_at,
        updated_at        = NOW()
    FROM (
      SELECT content_text, created_at
      FROM messages
      WHERE conversation_id = v_survivor
      ORDER BY created_at DESC
      LIMIT 1
    ) lm
    WHERE c.id = v_survivor;

    UPDATE conversations
    SET unread_count = v_group.total_unread,
        updated_at   = NOW()
    WHERE id = v_survivor
      AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = v_survivor);

    -- A group can mix a branded row with... nothing else, by definition
    -- of the grouping key. But a group keyed on the sentinel is a set of
    -- unbranded rows, and the survivor stays unbranded — the webhook
    -- stamps it on the next inbound. Nothing to carry over here.

    DELETE FROM conversations WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_duplicate_conversations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC;

-- ---- 2. swap the constraint -----------------------------------
-- Drop first: while 036's index stands, a second branch cannot open its
-- own thread with the same contact, which is the whole point of this
-- migration.
DROP INDEX IF EXISTS idx_conversations_account_contact;

-- Collapse anything that duplicates under the NEW key. On existing data
-- this finds nothing (040 gave every thread in a single-number account
-- the same number), but it must run before the index is built or the
-- CREATE fails on a database that was mid-flight.
SELECT public.merge_duplicate_conversations();

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_number
  ON conversations (
    account_id,
    contact_id,
    COALESCE(whatsapp_config_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

COMMENT ON INDEX idx_conversations_account_contact_number IS
  'One thread per (account, contact, number). Replaces 036''s '
  'idx_conversations_account_contact, which predated multi-number '
  'accounts and forced two branches to share one thread. NULL '
  'whatsapp_config_id folds to a sentinel so pre-040 threads still '
  'get exactly one row, not unlimited duplicates.';

-- ============================================================
-- ROLLBACK (only while a single number is connected — with several,
-- restoring 036's index would require deleting every thread but one
-- per contact)
-- ============================================================
--   DROP INDEX IF EXISTS idx_conversations_account_contact_number;
--   CREATE UNIQUE INDEX idx_conversations_account_contact
--     ON conversations (account_id, contact_id);
--   -- and restore the 036 body of merge_duplicate_conversations()
