-- ============================================================
-- release-preflight-accounts — run BEFORE the release
--
-- CORRECTED 14 Sep 2026. This file was written for migration 044, and
-- 044 IS NOT IN THIS RELEASE. The set that ships is 045, 046, 047.
--
-- READ SECTIONS 1, 2, 9 AND 10. Sections 3-8 govern 044, 042 and 048,
-- all of which are parked; they are kept because they will matter if
-- those migrations are ever revived, and each now says so in its own
-- header. Nothing in 3-8 can block this release.
--
-- READ ONLY. Every statement in this file is a SELECT. It creates
-- nothing, changes nothing, and can be run against production at any
-- time, including during business hours.
--
-- What it is for, now
-- -------------------
-- 046 REVOKEs four SECURITY DEFINER functions by EXACT SIGNATURE and
-- narrows UPDATE on profiles to two columns.
--
-- Section 9 is the one that can stop this release. A REVOKE naming a
-- signature nothing has raises and aborts — Postgres protects us there.
-- What it does not protect against is an EXTRA overload sharing the
-- name: the REVOKE names one signature, succeeds, and the other stays
-- callable by anon. CI now asserts the end state as well; this section
-- tells you before you apply.
--
-- Run this, read sections 1, 2, 9 and 10, and only then proceed.
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


-- === 1. Is this database actually at 041 + 049? =============
-- If any of these disagree, STOP: the baseline is not what the release
-- plan assumes and every risk assessment is void.
--
-- NOTE the 049 row. An earlier version of this file expected 049 to be
-- ABSENT. That was wrong: 049 was applied to production by hand, the
-- ledger recorded it incorrectly, and a read-only probe settled it on
-- 14 Sep. Production sits at 041 PLUS 049. If the centres row comes
-- back false here, something has removed a live table — stop and ask.
SELECT
  to_regclass('public.account_members')            IS NULL  AS "044 not applied (expect t)",
  to_regclass('public.centres')                IS NOT NULL  AS "049 IS applied (expect t)",
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
-- NOT IN THIS RELEASE: 044 only — PARKED. Also note profiles.account_role has been NOT NULL
-- since 017:275, so this section cannot return rows on any database
-- where 017 succeeded. It is kept for the record, not as a gate.
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
-- NOT IN THIS RELEASE: 044 only — PARKED.
-- The mirror case. These are ignored by the backfill and unaffected by
-- 044, because there is no account to be a member of. Listed so the
-- number is not a surprise later.
SELECT count(*) AS "profiles with a role but no account"
FROM profiles WHERE account_id IS NULL AND account_role IS NOT NULL;


-- === 5. Owners per account ==================================
-- NOT IN THIS RELEASE: 044 only — PARKED.
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
-- NOT IN THIS RELEASE: 044 only — PARKED.
-- A dry run of 044's INSERT, as a count. This is the number of rows
-- account_members should hold immediately after the migration.
SELECT
  count(*)                                              AS "rows to insert",
  count(*) FILTER (WHERE p.account_role IS NULL)        AS "of which take the viewer fallback"
FROM profiles p
WHERE p.account_id IS NOT NULL;


-- === 7. Duplicate conversations under 042 new key ===========
-- NOT IN THIS RELEASE: 042 only — PARKED.
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
-- NOT IN THIS RELEASE: 048 only — PARKED.
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
-- IN THIS RELEASE, and the one section here that can stop it.
--
-- 046 REVOKEs by exact signature. A signature that matches NOTHING does
-- not slip through — Postgres raises and the migration aborts, and 046
-- line 169 says so. The danger is the opposite shape: an EXTRA overload
-- sharing the name. The REVOKE names one signature, succeeds, reports
-- success, and the overload stays callable by anon with the definer's
-- privileges.
--
-- An earlier version of this comment had that backwards. See PR #38:
-- `REVOKE ... claim_ai_reply_slot(uuid, text)` errors, while adding
-- `claim_ai_reply_slot(uuid)` leaves it open with every assertion in
-- 046 still passing.
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
-- IN THIS RELEASE. 046 narrows UPDATE on profiles to two columns.
-- 046 revokes table-wide UPDATE from `authenticated` and grants back
-- only full_name and avatar_url. Recorded here so the before-state is
-- on file if anything is later blamed on the change.
SELECT
  has_column_privilege('authenticated', 'public.profiles', 'account_id',   'UPDATE') AS "can write account_id",
  has_column_privilege('authenticated', 'public.profiles', 'account_role', 'UPDATE') AS "can write account_role",
  has_column_privilege('authenticated', 'public.profiles', 'full_name',    'UPDATE') AS "can write full_name",
  has_column_privilege('authenticated', 'public.profiles', 'avatar_url',   'UPDATE') AS "can write avatar_url";


-- === preflight (accounts) complete — nothing was modified ===
