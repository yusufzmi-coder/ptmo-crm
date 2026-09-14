-- ============================================================
-- 048_broadcast_number
--
-- Remember which number a broadcast went out on.
--
-- Why
-- ---
-- Migration 040 let one account hold many WhatsApp numbers — for Minda
-- Optima, one per branch — and taught every outbound path to resolve a
-- number explicitly rather than guess. Broadcasts were given the
-- strictest rule of all: `resolveConfig` is called with neither a
-- conversation nor `allowPrimary`, because a campaign reaches hundreds
-- of parents at once and a guessed branch is the most expensive mistake
-- this codebase can make.
--
-- The caller now names the branch when the campaign is created. But the
-- choice was never persisted, and a broadcast outlives the request that
-- created it:
--
--   Mon  HQ sends a Batu Caves campaign to 400 parents
--        -> 60 recipients fail (rate limit, expired token, bad number)
--   Tue  someone opens the broadcast and presses Resume
--        -> planBroadcastResume has a broadcast id and nothing else
--        -> resolveConfig has no conversation, no configId, no primary
--        -> 'ambiguous' -> 400, and the 60 can never be retried
--
-- So on a multi-number account Resume is dead, and the recipients it
-- exists to rescue stay unsent. Worse, the obvious "fix" — letting
-- resume fall back to the account primary — would mail the second half
-- of a Batu Caves campaign from the Rawang number, which is the exact
-- failure 040 was written to prevent.
--
-- The number has to be remembered, not re-derived.
--
-- What this does
-- --------------
--   1. `broadcasts.whatsapp_config_id` — the number the campaign was
--      created on. Resume reads it and sends on the same one.
--   2. Backfills it where the answer is unambiguous (accounts holding
--      exactly one number), the same conservative rule 040 applied to
--      conversations.
--   3. Widens `create_broadcast_with_recipients` to persist it, so the
--      parent row and its recipients still land in one transaction.
--
-- What stays
-- ----------
--   Nullable, ON DELETE SET NULL. A campaign whose branch is later
--   disconnected stays readable as history; it simply cannot be
--   resumed, which is correct — there is no number left to send from.
--
-- Blast radius (read before running)
-- ----------------------------------
-- The RPC is DROPped and recreated with an extra parameter, so the
-- 8-argument call from a running old build stops resolving the moment
-- this lands. Deploy the code that passes `p_whatsapp_config_id`
-- together with this migration, not after it. A brief PostgREST schema
-- cache lag after the drop is normal.
--
-- Reversible: yes — see the rollback block at the bottom. Nothing is
-- deleted; a rollback only loses the remembered number.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ---- 1. the number a campaign belongs to ---------------------
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
    REFERENCES whatsapp_config(id) ON DELETE SET NULL;

COMMENT ON COLUMN broadcasts.whatsapp_config_id IS
  'The number this campaign was sent from — for Minda Optima, the '
  'branch. Read by the resume path so a retry leaves on the same '
  'number the first pass used, never on the account default. NULL on '
  'rows created before migration 048 where the account already held '
  'several numbers; those cannot be resumed and must be re-created.';

-- Backfill only where it is unambiguous: an account with exactly one
-- number. Accounts already holding several are left NULL rather than
-- guessed at — the same rule migration 040 applied to conversations,
-- and for the same reason.
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
UPDATE broadcasts b
   SET whatsapp_config_id = sole_config.id
  FROM sole_config
 WHERE b.whatsapp_config_id IS NULL
   AND b.account_id = sole_config.account_id;

-- Per-branch campaign reporting reads this; so does any future
-- "which branches have sent this week" view.
CREATE INDEX IF NOT EXISTS idx_broadcasts_whatsapp_config
  ON broadcasts (whatsapp_config_id);

-- ============================================================
-- 2. create_broadcast_with_recipients — carry the number through
--
-- Dropped rather than CREATE OR REPLACE'd, for the same reason 038
-- dropped the 7-argument form: adding a parameter makes a new
-- overload, and a DEFAULT on it would leave the 8-argument call
-- ambiguous between the two.
-- ============================================================
DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]
);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id         UUID,
  p_user_id            UUID,
  p_name               TEXT,
  p_template_name      TEXT,
  p_template_language  TEXT,
  p_total_recipients   INTEGER,
  p_contact_ids        UUID[],
  p_template_params    JSONB[],
  p_whatsapp_config_id UUID
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  -- SECURITY DEFINER bypasses RLS, so the number must be proven to
  -- belong to the calling account here. Without this check a caller
  -- could name another tenant's number and have their campaign
  -- attributed to it.
  IF p_whatsapp_config_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM whatsapp_config w
        WHERE w.id = p_whatsapp_config_id
          AND w.account_id = p_account_id
     )
  THEN
    RAISE EXCEPTION 'whatsapp_config % does not belong to account %',
      p_whatsapp_config_id, p_account_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients, whatsapp_config_id
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients,
    p_whatsapp_config_id
  )
  RETURNING id INTO v_broadcast_id;

  -- Two-array unnest pairs each contact with its params positionally.
  -- A shorter params array pads with NULL, which the resume path reads
  -- as "no params" — the same as a pre-038 row.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    RETURNING id, contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID) TO service_role;

-- ---- 3. RLS ---------------------------------------------------
-- No change needed. Migration 017 already scopes `broadcasts` by
-- is_account_member(account_id); adding a column does not widen it,
-- and the tenancy check above covers the SECURITY DEFINER path.

-- ============================================================
-- ROLLBACK
-- ============================================================
--   DROP INDEX IF EXISTS idx_broadcasts_whatsapp_config;
--   ALTER TABLE broadcasts DROP COLUMN IF EXISTS whatsapp_config_id;
--   DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
--     UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
--   );
--   -- then re-run migration 038's function body + grants to restore
--   -- the 8-argument form.
