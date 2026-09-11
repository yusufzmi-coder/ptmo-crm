-- ============================================================
-- 040_multi_number_per_account
--
-- Let one account connect MANY WhatsApp numbers.
--
-- Why
-- ---
-- Minda Optima runs 16 branches, each with its own WhatsApp number,
-- and wants all of them landing in one shared inbox with one central
-- admin covering the hours branch staff cannot. The schema up to 039
-- cannot express that: migration 017 put `UNIQUE(account_id)` on
-- whatsapp_config, so an account holds exactly one number.
--
-- This migration lifts that limit and, in the same stroke, gives every
-- conversation a branch. For this business the WhatsApp number IS the
-- branch, so `whatsapp_config.label` is the branch name and
-- `conversations.whatsapp_config_id` is the branch a thread belongs
-- to. Per-branch reporting on the Ops board falls out of it for free.
--
-- What stays
-- ----------
--   UNIQUE(phone_number_id) — a number still belongs to exactly one
--   account. Two tenants must never share an inbound stream, and the
--   webhook relies on this to resolve tenancy from Meta's payload.
--
-- Blast radius (read before running)
-- ----------------------------------
-- Roughly a dozen code paths currently do
--   .from('whatsapp_config').eq('account_id', …).single()
-- Those THROW the moment a second row exists. That is deliberate on
-- our side: a loud failure is far better than silently sending a
-- parent's reply from the wrong branch's number. Ship the code that
-- resolves a config explicitly BEFORE connecting number two.
--
-- Reversible: yes, while only one number is connected — see the
-- rollback block at the bottom. Once a second number is connected the
-- unique constraint can no longer be restored without deleting rows.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ---- 1. one account may now hold many numbers ----------------
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- ---- 2. name the number ---------------------------------------
-- Staff pick from this in the inbox and the composer, so it should
-- read the way they speak: "Batu Caves", "Rawang", "Gombak".
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS label TEXT;

COMMENT ON COLUMN whatsapp_config.label IS
  'Human name for this number — the branch it belongs to. Shown in the '
  'inbox, the composer''s "reply as" picker, and per-branch reports. '
  'NULL on rows created before migration 040; the UI falls back to the '
  'phone_number_id until an admin names it.';

-- ---- 3. one number is the fallback ----------------------------
-- Outbound work that is not tied to a thread (a broadcast with no
-- branch chosen, a template sync) needs a defensible default rather
-- than "whichever row came back first".
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN whatsapp_config.is_primary IS
  'The account''s default number. Used only where no conversation or '
  'explicit choice supplies one. Exactly one row per account may be '
  'true (enforced by idx_whatsapp_config_one_primary).';

-- Existing single-number accounts become their own primary, so nothing
-- that relies on a default changes behaviour on the day this runs.
WITH first_per_account AS (
  SELECT DISTINCT ON (account_id) id, account_id
    FROM whatsapp_config
   ORDER BY account_id, created_at, id
)
UPDATE whatsapp_config c
   SET is_primary = TRUE
  FROM first_per_account f
 WHERE c.id = f.id
   AND NOT EXISTS (
     SELECT 1
       FROM whatsapp_config o
      WHERE o.account_id = c.account_id
        AND o.is_primary
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_primary
  ON whatsapp_config (account_id)
  WHERE is_primary;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_account_label
  ON whatsapp_config (account_id, label);

-- ---- 4. a conversation knows which number it arrived on --------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
    REFERENCES whatsapp_config(id) ON DELETE SET NULL;

COMMENT ON COLUMN conversations.whatsapp_config_id IS
  'The number this thread arrived on — for Minda Optima, the branch. '
  'Set by the inbound webhook from Meta''s phone_number_id. Nullable: '
  'threads that predate migration 040 are backfilled below where the '
  'account had exactly one number, and ON DELETE SET NULL keeps '
  'history readable if a number is later disconnected. Replies must '
  'go out on this number — never on the account default — or a parent '
  'hears from a branch they never messaged.';

-- Backfill only where it is unambiguous: an account with exactly one
-- number. Accounts that somehow already hold several are left NULL
-- rather than guessed at.
WITH sole_account AS (
  SELECT account_id
    FROM whatsapp_config
   GROUP BY account_id
  HAVING COUNT(*) = 1
),
sole_config AS (
  SELECT c.account_id, c.id
    FROM whatsapp_config c
    JOIN sole_account s ON s.account_id = c.account_id
)
UPDATE conversations conv
   SET whatsapp_config_id = sole_config.id
  FROM sole_config
 WHERE conv.whatsapp_config_id IS NULL
   AND conv.account_id = sole_config.account_id;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON conversations (whatsapp_config_id);

-- ---- 5. RLS ---------------------------------------------------
-- No change needed. Migration 017 already scopes whatsapp_config by
-- is_account_member(account_id) for select and admin+ for writes, and
-- conversations carry their own account policies. Adding rows and a
-- column does not widen either.

-- ============================================================
-- ROLLBACK (only while a single number is connected)
-- ============================================================
--   ALTER TABLE conversations DROP COLUMN IF EXISTS whatsapp_config_id;
--   DROP INDEX IF EXISTS idx_whatsapp_config_one_primary;
--   DROP INDEX IF EXISTS idx_whatsapp_config_account_label;
--   ALTER TABLE whatsapp_config DROP COLUMN IF EXISTS is_primary;
--   ALTER TABLE whatsapp_config DROP COLUMN IF EXISTS label;
--   ALTER TABLE whatsapp_config
--     ADD CONSTRAINT whatsapp_config_account_id_key UNIQUE (account_id);
