-- ============================================================
-- null_role_backfill_test — the lockout 044 must not cause
--
-- Run by `supabase test db` (pgTAP), in both jobs of
-- .github/workflows/migrations.yml.
--
-- Why this file exists
-- --------------------
-- `profiles.account_role` has been nullable with no default since
-- 017:122. 044's backfill originally read
--
--   WHERE p.account_id IS NOT NULL AND p.account_role IS NOT NULL
--
-- and skipped anything with a NULL role. After 044, membership is what
-- `is_account_member()` answers from, so a profile with no membership
-- row is refused by all ~119 RLS policies at once — every table, no
-- error, just empty screens. Nothing in the schema would say why.
--
-- The migration now grants those profiles the VIEWER role instead, and
-- asserts before it commits that no profile with an account is left
-- without a membership. This file proves the three properties that
-- makes correct, against the real shipped function rather than a copy
-- of its logic:
--
--   1. the lockout is real  — no membership means no access, so the
--      hardening is fixing something that actually bites;
--   2. viewer restores read — the fallback is sufficient to use the app;
--   3. viewer is the floor  — it does NOT confer agent or admin, so a
--      migration can never quietly promote anyone.
--
-- Kept separate from zone_isolation_test.sql so each file fails for one
-- reason.
-- ============================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

-- ---- seed ----------------------------------------------------
-- `handle_new_user` (044) provisions an account, a profile as its owner
-- and the matching membership row, so this gives us a real zone with a
-- real owner to attach a second person to.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('aaaa1111-1111-1111-1111-111111111111', 'pemilik@ptmo.my', '{"full_name":"Pemilik"}'),
  ('aaaa2222-2222-2222-2222-222222222222', 'tiadaperanan@ptmo.my', '{"full_name":"Tiada Peranan"}');

CREATE TEMPORARY TABLE zone AS
SELECT (SELECT account_id FROM profiles
         WHERE user_id = 'aaaa1111-1111-1111-1111-111111111111') AS id;
GRANT SELECT ON zone TO authenticated;

-- One parent in the zone, so "can this person read anything" has
-- something to be true or false about.
INSERT INTO contacts (account_id, user_id, name, phone)
SELECT id, 'aaaa1111-1111-1111-1111-111111111111', 'Ibu Ujian', '+60119999001' FROM zone;

-- Now build the shape production may hold: a profile pointed at
-- somebody else's zone, with NO role and NO membership. This is exactly
-- what an unhardened 044 backfill would leave behind.
UPDATE profiles
   SET account_id   = (SELECT id FROM zone),
       account_role = NULL
 WHERE user_id = 'aaaa2222-2222-2222-2222-222222222222';

DELETE FROM account_members
 WHERE user_id = 'aaaa2222-2222-2222-2222-222222222222';

-- ============================================================
-- 1. The lockout is real
-- ============================================================
SELECT is(
  (SELECT account_role_rank(NULL::account_role_enum)),
  NULL,
  'account_role_rank(NULL) is NULL, which is why a NULL role fails every comparison'
);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"aaaa2222-2222-2222-2222-222222222222"}';

SELECT ok(
  NOT is_account_member((SELECT id FROM zone)),
  'a profile with an account but no membership row is refused by is_account_member'
);

SELECT is(
  (SELECT count(*) FROM contacts)::int,
  0,
  'and therefore reads nothing at all — every RLS policy closes at once'
);

RESET ROLE;

-- ============================================================
-- 2. The viewer fallback restores read access
--
-- Exactly what the hardened backfill in 044 writes.
-- ============================================================
INSERT INTO account_members (user_id, account_id, role)
SELECT 'aaaa2222-2222-2222-2222-222222222222', id, 'viewer' FROM zone;

UPDATE profiles SET account_role = 'viewer'
 WHERE user_id = 'aaaa2222-2222-2222-2222-222222222222';

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"aaaa2222-2222-2222-2222-222222222222"}';

SELECT ok(
  is_account_member((SELECT id FROM zone)),
  'with a viewer membership the same user is a member again'
);

SELECT is(
  (SELECT count(*) FROM contacts)::int,
  1,
  'and can read the zone they belong to'
);

-- ============================================================
-- 3. Viewer is the floor, not a promotion
-- ============================================================
SELECT ok(
  NOT is_account_member((SELECT id FROM zone), 'agent'),
  'the fallback does not confer agent'
);

SELECT ok(
  NOT is_account_member((SELECT id FROM zone), 'admin'),
  'the fallback does not confer admin'
);

SELECT ok(
  NOT is_account_member((SELECT id FROM zone), 'owner'),
  'the fallback does not confer owner'
);

RESET ROLE;

-- ============================================================
-- 4. The invariant 044 asserts before it commits
-- ============================================================
SELECT is(
  (SELECT count(*)::int
     FROM profiles p
    WHERE p.account_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM account_members m
         WHERE m.user_id = p.user_id AND m.account_id = p.account_id
      )),
  0,
  'no profile with an account is left without a membership row'
);

SELECT * FROM finish();
ROLLBACK;
