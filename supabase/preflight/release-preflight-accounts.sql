-- ============================================================
-- release-preflight-accounts — run BEFORE migration 044
--
-- READ ONLY. Every statement in this file is a SELECT. It creates
-- nothing, changes nothing, and can be run against production at any
-- time, including during business hours.
--
-- What it is for
-- --------------
-- 044 changes the body of is_account_member(), the one function behind
-- roughly 119 RLS policies. After it, a user's access comes from a row
-- in account_members. The backfill creates those rows — and its
-- correctness depends entirely on what profiles currently look like.
--
-- Run this, read the output, and only then decide whether to proceed.
-- Section 3 is the one that can stop the release.
--
-- How to run
-- ----------
-- Paste into the Supabase SQL Editor, or
--   psql "$DATABASE_URL" -f supabase/preflight/release-preflight-accounts.sql
--
-- There are no psql meta-commands in this file, so it is valid in either.
-- Note how the SQL Editor behaves with a multi-statement paste: it shows
-- the result of the LAST statement only. To read a specific section,
-- select just that section's SELECT and run the selection — the numbered
-- comments below mark where each one begins and ends.
-- ============================================================


-- === 1. Is this database actually at 041? ===================
-- If any of these disagree with expectations, STOP: the baseline is not
-- what the release plan assumes and every risk assessment is void.
SELECT
  to_regclass('public.account_members')            IS NULL  AS "044 not yet applied (expect t)",
  to_regclass('public.centres')                    IS NULL  AS "049 not yet applied (expect t)",
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_name = 'conversations'
             AND column_name = 'whatsapp_config_id')        AS "040 applied (expect t)",
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_name = 'member_presence'
             AND column_name = 'viewing_conversation_id')   AS "041 applied (expect t)",
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_name = 'broadcasts'
             AND column_name = 'whatsapp_config_id')        AS "048 not yet applied (expect f)";


-- === 2. Role distribution across all profiles ===============
-- The shape of the account. A NULL row here is not an error yet — see
-- section 3 for what it means.
SELECT
  COALESCE(p.account_role::text, '(NULL — no role set)') AS role,
  count(*)                                               AS profiles
FROM profiles p
WHERE p.account_id IS NOT NULL
GROUP BY 1
ORDER BY
  CASE p.account_role
    WHEN 'owner' THEN 1 WHEN 'admin' THEN 2
    WHEN 'agent' THEN 3 WHEN 'viewer' THEN 4 ELSE 5
  END;


-- === 3. BLOCKER CHECK: profiles with an account but no role =
-- These are the users 044 has to decide about.
--
-- The hardened backfill grants each of them the VIEWER role — the floor
-- of the hierarchy, read-only, never owner or admin. That is a
-- deliberate choice, and this is where you confirm it is the right one
-- for each person listed.
--
-- Note what the state means today: 017's helper returns NULL for a NULL
-- role, and NULL is not true, so these accounts are ALREADY unable to
-- read anything. Granting viewer restores them rather than preserving
-- them.
--
--   * If a row here is a real member who should be able to work, the
--     honest fix is to set their real role BEFORE the release, so 044
--     records what you meant instead of the fallback.
--   * If a row here is someone who should NOT see this account's data,
--     clear their profiles.account_id BEFORE the release. Leaving them
--     listed means they will be granted read access.
--
-- An empty result is the clean case: nothing to decide.
SELECT
  p.user_id,
  p.email,
  p.full_name,
  a.name        AS account,
  p.created_at
FROM profiles p
JOIN accounts a ON a.id = p.account_id
WHERE p.account_id IS NOT NULL
  AND p.account_role IS NULL
ORDER BY p.created_at;


-- === 4. Profiles with a role but no account =================
-- The mirror case. These are ignored by the backfill and unaffected by
-- 044, because there is no account to be a member of. Listed so the
-- number is not a surprise later.
SELECT count(*) AS "profiles with a role but no account"
FROM profiles WHERE account_id IS NULL AND account_role IS NOT NULL;


-- === 5. Owners per account ==================================
-- 044 drops UNIQUE(owner_user_id) so one person can own several zones.
-- An account with NO owner is the case to watch: recovery depends on
-- the owner, and nothing in the migration creates one.
SELECT
  a.id,
  a.name,
  a.owner_user_id,
  (SELECT count(*) FROM profiles p WHERE p.account_id = a.id)                       AS members,
  (SELECT count(*) FROM profiles p WHERE p.account_id = a.id
                                     AND p.account_role = 'owner')                  AS owners,
  (SELECT count(*) FROM profiles p WHERE p.account_id = a.id
                                     AND p.account_role IS NULL)                    AS "null roles"
FROM accounts a
ORDER BY a.created_at;


-- === 6. What the backfill will insert =======================
-- A dry run of 044's INSERT, as a count. This is the number of rows
-- account_members should hold immediately after the migration.
SELECT
  count(*)                                              AS "rows to insert",
  count(*) FILTER (WHERE p.account_role IS NULL)        AS "of which take the viewer fallback"
FROM profiles p
WHERE p.account_id IS NOT NULL;


-- === 7. Duplicate conversations under 042 new key ===========
-- 042 runs merge_duplicate_conversations(), which DELETEs. On a
-- single-number account this must find nothing. Any row here is a
-- thread that WILL be merged away — inspect it before proceeding.
SELECT
  c.account_id,
  c.contact_id,
  COALESCE(c.whatsapp_config_id, '00000000-0000-0000-0000-000000000000'::uuid) AS number_key,
  count(*) AS threads
FROM conversations c
GROUP BY 1, 2, 3
HAVING count(*) > 1
ORDER BY 4 DESC;


-- === 8. Broadcasts 048 can and cannot backfill ==============
-- An account holding exactly one number gets its broadcasts filled in.
-- An account already holding several is left NULL by design, and those
-- campaigns can never be resumed.
SELECT
  a.name AS account,
  (SELECT count(*) FROM whatsapp_config w WHERE w.account_id = a.id) AS numbers,
  (SELECT count(*) FROM broadcasts b     WHERE b.account_id = a.id)  AS broadcasts,
  CASE
    WHEN (SELECT count(*) FROM whatsapp_config w WHERE w.account_id = a.id) = 1
      THEN 'all backfilled'
    WHEN (SELECT count(*) FROM whatsapp_config w WHERE w.account_id = a.id) = 0
      THEN 'no number — nothing to backfill'
    ELSE 'left NULL — these broadcasts cannot be resumed'
  END AS "048 outcome"
FROM accounts a
ORDER BY a.name;


-- === 9. Duplicate function overloads 046 will refuse ========
-- 046 asserts there is exactly one recompute_broadcast_counts. Because
-- 040 and 041 were applied by hand, a stray overload from an ad-hoc SQL
-- session is possible, and it aborts the migration.
SELECT p.proname,
       count(*) AS overloads,
       string_agg(pg_get_function_identity_arguments(p.oid), ' | ') AS signatures
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'recompute_broadcast_counts', '_bcast_bump',
    'record_webhook_failure', 'claim_ai_reply_slot',
    'create_broadcast_with_recipients', 'touch_presence',
    'is_account_member'
  )
GROUP BY p.proname
ORDER BY p.proname;


-- === 10. Who can write profiles today =======================
-- 046 revokes table-wide UPDATE from `authenticated` and grants back
-- only full_name and avatar_url. Recorded here so the before-state is
-- on file if anything is later blamed on the change.
SELECT
  has_column_privilege('authenticated', 'public.profiles', 'account_id',   'UPDATE') AS "can write account_id",
  has_column_privilege('authenticated', 'public.profiles', 'account_role', 'UPDATE') AS "can write account_role",
  has_column_privilege('authenticated', 'public.profiles', 'full_name',    'UPDATE') AS "can write full_name",
  has_column_privilege('authenticated', 'public.profiles', 'avatar_url',   'UPDATE') AS "can write avatar_url";


-- === preflight (accounts) complete — nothing was modified ===
