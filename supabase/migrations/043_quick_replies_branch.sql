-- ============================================================
-- 043_quick_replies_branch
--
-- Give a quick reply a branch, so a snippet written for one centre
-- cannot be sent from another.
--
-- Why
-- ---
-- Migration 040 made the outbound NUMBER branch-correct: a reply leaves
-- on the number the parent actually wrote to, and 042 stopped two
-- branches sharing one thread. Neither touches what the message SAYS.
--
-- Quick replies are account-scoped (035) with no branch column, so the
-- picker offers every snippet in every thread. An agent answering a
-- Rawang parent can pick
--
--     "Terima kasih! Sila datang ke cawangan Batu Caves sebelum 6 petang."
--
-- and nothing in the product objects. The number is right; the words are
-- wrong. This is the worse half of the pair: the number is a subtle cue
-- most parents never examine, while the body text is the thing they
-- actually read and act on. A parent driving to the wrong centre is a
-- support call and a lost evening.
--
-- What this does
-- --------------
--   1. `whatsapp_config_id` on quick_replies — NULL means "every
--      branch", which is what all 16 existing rows become. A non-NULL
--      value pins the snippet to one branch, and the API hides it
--      everywhere else.
--   2. ON DELETE CASCADE, not SET NULL. A pinned snippet names one
--      centre's address and hours; if that number is disconnected,
--      silently promoting it to "every branch" would put a dead
--      centre's details in front of fifteen other centres' parents.
--      Deleting it is the safe read of the admin's intent.
--
-- What this deliberately does NOT do
-- ----------------------------------
-- Pinning is the fallback, not the main event. The main event is the
-- `{{cawangan}}` token (see src/lib/inbox/branch-token.ts), which lets
-- ONE snippet serve all sixteen branches by resolving the branch name
-- from the thread at insert time. Pinning exists for the residue that
-- genuinely differs per centre — an address, a teacher's name, a
-- branch-specific promotion.
--
-- Prefer the token. Sixteen pinned copies of one snippet is sixteen
-- things to edit when the wording changes, and fifteen chances to
-- forget one.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
    REFERENCES whatsapp_config(id) ON DELETE CASCADE;

COMMENT ON COLUMN quick_replies.whatsapp_config_id IS
  'Branch this snippet belongs to. NULL = available in every branch, '
  'which is the default and the right answer for anything using the '
  '{{cawangan}} token. Non-NULL pins it to one branch and the picker '
  'hides it in every other thread. CASCADE on delete: a snippet naming '
  'a disconnected centre must not silently become account-wide.';

-- Partial index: the lookup is always "this branch OR account-wide",
-- and the account-wide half is already served by
-- idx_quick_replies_account from 035. Only the pinned rows need their
-- own index, and in a 16-branch account they are the minority.
CREATE INDEX IF NOT EXISTS idx_quick_replies_config
  ON quick_replies (whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;

-- ---- RLS -------------------------------------------------------
-- No change needed. 035's policies scope every operation by
-- is_account_member(account_id), and whatsapp_config rows belong to the
-- same account (040), so a member can only ever pin to a branch they
-- can already see. Adding a column does not widen any policy.
--
-- Note the asymmetry this leaves, deliberately: branch *scoping* of
-- snippets is a UI affordance, not an authorization boundary. A member
-- who can read the account can still read a pinned snippet through the
-- API. That matches the rest of the product today — conversations
-- themselves are account-scoped, not branch-scoped — and tightening it
-- here alone would imply an isolation the inbox does not yet provide.

-- ============================================================
-- ROLLBACK
-- ============================================================
--   DROP INDEX IF EXISTS idx_quick_replies_config;
--   ALTER TABLE quick_replies DROP COLUMN IF EXISTS whatsapp_config_id;
