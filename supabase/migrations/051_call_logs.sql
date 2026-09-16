-- ============================================================
-- 051_call_logs — the phone calls the CRM cannot see
--
-- Parents phone the branch. They always have. When a parent asks about
-- fees on WhatsApp and the branch calls them back to settle it, the
-- thread stops mid-sentence and the answer lives in someone's head —
-- so HQ covering the evening shift reads a conversation that appears
-- abandoned, and calls the same parent again.
--
-- This table is the missing half of that thread. One row per call:
-- who, when, which way it went, what came of it, and what happens
-- next. Manual entry — staff log the call they just made.
--
-- NOT the WhatsApp Calling API. That is a separate pilot and it comes
-- after the chat pilot is stable; the board has said so since 14 Sep.
-- Nothing here assumes a call arrived through Meta, and a future
-- Calling integration can fill the same row rather than need another.
--
-- WHAT THIS MIGRATION MAY NOT TOUCH
-- ---------------------------------
-- 042, 043, 044 and 048 are parked: in the repo, not in production, and
-- NOT in the CI baseline. So nothing here may reference
--
--   account_members                   (044)
--   broadcasts.whatsapp_config_id     (048)
--   quick_replies.whatsapp_config_id  (043)
--
-- The clean CI job replays EVERY migration including the parked ones,
-- so a dependency on any of them passes CI and then breaks production,
-- where they do not exist. Verify this file by applying it on a
-- baseline with those four REMOVED — that is the only direction in
-- which the breakage is visible.
--
-- `is_account_member()` below is therefore 017's version — the one
-- running in production, reading `profiles.account_id` and
-- `profiles.account_role`. Not 044's rewrite.
--
-- Depends on: accounts (001), contacts (001), conversations (001),
-- profiles (001), whatsapp_config (017/040), centres (049), issues (050).
-- Every one of those is live.
--
-- Idempotent — safe to re-run. Reversible — see the block at the bottom.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- Every link out of a call is SET NULL, never CASCADE — the same rule
  -- 050 sets for issues, for the same reason. A call is a record of
  -- something that happened. Closing a branch or deleting a parent
  -- record must not erase the fact that someone rang them.
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  centre_id UUID REFERENCES centres(id) ON DELETE SET NULL,

  -- Which of the account's numbers this call belongs to. 040 made
  -- whatsapp_config one row per branch, so this is how a call joins the
  -- same per-branch reporting as a thread. NULL when the call went out
  -- on a handset that is not a connected number — which, during the
  -- pilot, is most of them.
  whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,

  -- The issue this call was part of, if any. A complaint is usually
  -- resolved by phone, and an issue whose resolution is "we called
  -- them" with no record of the call is not a resolution.
  issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,

  -- Malay values, following 050: these are picked by branch staff in a
  -- Malay interface and read back by HQ in reports. A translation layer
  -- between the picker and the row would only add a place to drift.
  --
  -- `direction` is not a state machine — nothing branches on it beyond
  -- an icon — so it stays in the language of the people choosing it.
  direction TEXT NOT NULL CHECK (direction IN ('masuk', 'keluar')),

  -- What came of it. Deliberately short: a list staff scan in one
  -- glance beats a taxonomy nobody picks from honestly.
  --   dijawab        — spoke to them
  --   tidak_dijawab  — rang out
  --   tinggal_mesej  — voicemail, or a message with whoever answered
  --   call_balik     — they asked to be called back (set follow_up_at)
  --   nombor_salah   — wrong or dead number (fix the contact)
  outcome TEXT NOT NULL CHECK (outcome IN (
    'dijawab', 'tidak_dijawab', 'tinggal_mesej', 'call_balik', 'nombor_salah')),

  -- When the call happened, which is NOT when the row was written.
  -- Staff log calls at the end of a shift, so `created_at` would sort
  -- the day's calls into the order they were typed up.
  called_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Optional and unvalidated beyond non-negative. Nobody times a call
  -- with a stopwatch; a required duration would be filled with zeroes
  -- and the column would then mean nothing.
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),

  -- What was said. The only field that carries the actual handover, so
  -- it is NOT NULL — a logged call with no summary tells the next shift
  -- exactly as much as no log at all.
  summary TEXT NOT NULL,

  -- Set when someone has to ring back. The inbox reads this; it is why
  -- there is a partial index on it below.
  follow_up_at TIMESTAMPTZ,

  -- profiles(user_id) carries UNIQUE(user_id) from 001:22, so it is a
  -- valid FK target. Checked rather than assumed: a foreign key onto a
  -- non-unique column fails at apply time, inside the release
  -- transaction, taking everything else with it.
  logged_by UUID REFERENCES profiles(user_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE call_logs IS
  'Manually logged phone calls with parents. Not the WhatsApp Calling '
  'API — that is a later pilot, and it can write these same rows.';

-- The four queries the feature actually makes: the call list newest
-- first, this parent's call history, this thread's calls, and the
-- follow-ups that are due.
CREATE INDEX IF NOT EXISTS idx_call_logs_account_called
  ON call_logs(account_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_contact ON call_logs(contact_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_conversation ON call_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_issue ON call_logs(issue_id);

-- Partial: the overwhelming majority of calls need no follow-up, and
-- indexing their NULLs would be paying for rows this query never reads.
CREATE INDEX IF NOT EXISTS idx_call_logs_follow_up
  ON call_logs(account_id, follow_up_at)
  WHERE follow_up_at IS NOT NULL;

ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS call_logs_select ON call_logs;
DROP POLICY IF EXISTS call_logs_insert ON call_logs;
DROP POLICY IF EXISTS call_logs_update ON call_logs;
DROP POLICY IF EXISTS call_logs_delete ON call_logs;

-- Data-class policies, copied line for line from 050's issues block.
--
-- No `TO <role>` clause: zero of the CREATE POLICY statements in this
-- repo use one, because the role requirement is carried by
-- is_account_member()'s second argument instead. A second pattern for
-- the same job is how one of them ends up wrong.
--
-- Logging a call is agent work — it is branch staff who make them.
-- Deleting one is admin work, because a deleted call leaves no trace
-- that the conversation ever left the thread.
CREATE POLICY call_logs_select ON call_logs FOR SELECT USING (is_account_member(account_id));
CREATE POLICY call_logs_insert ON call_logs FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY call_logs_update ON call_logs FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY call_logs_delete ON call_logs FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON call_logs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON call_logs
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Rollback
-- ============================================================
-- Safe while the feature is unreleased: nothing else references
-- call_logs, so dropping it takes only the calls logged so far — which
-- is data staff typed by hand, so export before you run this.
--
--   DROP TABLE IF EXISTS call_logs;
-- ============================================================
