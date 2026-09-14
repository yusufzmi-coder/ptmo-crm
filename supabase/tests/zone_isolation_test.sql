-- ============================================================
-- zone_isolation_test — does the database actually keep zones apart?
--
-- Run by `supabase test db` (pgTAP), wired into
-- .github/workflows/migrations.yml after the migration replay.
--
-- Why this file exists
-- -------------------
-- Migration 044 made one account per zone and kept `is_account_member()`
-- meaning "my ACTIVE zone", so that all ~119 RLS policies could stay
-- untouched and fail-closed. Its own header explains why that matters:
-- large parts of this application query their tables with NO account_id
-- filter at all — roughly 41 client-side mutations, every file in
-- src/lib/ops/, and src/lib/dashboard/queries.ts. Those queries are
-- correct ONLY because RLS narrows them to one account.
--
-- Which means the zone boundary is not enforced by application code that
-- a reviewer can read. It is enforced by one SQL function, and if that
-- function is ever widened, nothing fails, no test goes red, and zone A
-- staff simply begin seeing zone B's parents.
--
-- Before this file there was no test of that property anywhere in the
-- repo. `supabase/ci/verify-schema.sql` asserts that objects EXIST; it
-- cannot assert that a policy WORKS. So these tests query real tables as
-- real authenticated personas and count rows.
--
-- How impersonation works here
-- ----------------------------
-- `SET LOCAL ROLE authenticated` plus `SET LOCAL request.jwt.claims`
-- is what PostgREST does per request, and `auth.uid()` reads the `sub`
-- out of those claims. So a `SELECT` issued between those two settings
-- and a `RESET ROLE` is subject to exactly the policies a real browser
-- request would be. Seeding happens as the superuser first, because
-- `authenticated` is — correctly — unable to write another zone's rows.
--
-- TWO WORLDS, ONE FILE
-- --------------------
-- The "upgrade path" CI job parks 044, so this file must run against a
-- database where `account_members` does not exist. It used to fail there
-- with `relation "account_members" does not exist` and a bad plan.
--
-- Skipping the whole suite in that job was the cheap answer, and it was
-- the wrong one: the job that builds a PRODUCTION-SHAPED database would
-- then be the one job not testing zone isolation, and production runs
-- the pre-044 path TODAY.
--
-- So the file branches. What it asserts is `is_account_member()`, and
-- BOTH implementations answer the same question for a single-zone user:
--
--   017  the target IS my profile's account, and my profile's role is
--        high enough
--   044  I hold an account_members row for the target, AND the target is
--        my ACTIVE zone, and that row's role is high enough
--
-- For someone who belongs to one zone those are the same predicate by
-- two routes, which is why 20 of the 25 assertions below are written
-- once and run in both worlds. The 5 that cannot are the ones about
-- belonging to a SECOND zone — `is_account_member_any()` and
-- `set_active_account()` — because pre-044 there is nowhere to record a
-- second membership. Those are `skip`ped, not deleted, so the plan stays
-- 25 and the run says out loud what it did not check.
--
-- If the two implementations ever DISAGREE on the shared 20, that is a
-- far bigger finding than a red build.
-- ============================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

-- psql's \if, not a SQL CASE: PostgreSQL resolves function names when it
-- parses a statement, so a CASE branch naming set_active_account() still
-- fails with "function does not exist" on a database without 044, even
-- when that branch is never taken. \if never sends the line at all.
SELECT (to_regclass('public.account_members') IS NOT NULL) AS has_044 \gset

SELECT plan(25);

-- ============================================================
-- Seed: two zones, three people
--
-- Inserting into auth.users fires `handle_new_user` (017, rewritten by
-- 044), which provisions an account, a profile as its owner, and the
-- matching account_members row. So each person's personal account IS a
-- zone, which is the shape 044 describes for PTMO.
-- ============================================================
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('11111111-1111-1111-1111-111111111111', 'staf.a@ptmo.my', '{"full_name":"Staf Zon A"}'),
  ('22222222-2222-2222-2222-222222222222', 'staf.b@ptmo.my', '{"full_name":"Staf Zon B"}'),
  ('33333333-3333-3333-3333-333333333333', 'hq@ptmo.my',     '{"full_name":"Orang HQ"}');

-- Name the two zones for readability in the assertions below.
CREATE TEMPORARY TABLE zone AS
SELECT
  (SELECT account_id FROM profiles WHERE user_id = '11111111-1111-1111-1111-111111111111') AS a,
  (SELECT account_id FROM profiles WHERE user_id = '22222222-2222-2222-2222-222222222222') AS b;

-- The assertions below read this while impersonating, so the test roles
-- need it. It holds two account ids and no tenant data — it is test
-- scaffolding, not a table under test.
GRANT SELECT ON zone TO authenticated, anon;

-- HQ enters zone A. How that is recorded is the one thing that differs
-- between the two worlds; what it must MEAN is identical, and every
-- assertion below is written against the meaning.
\if :has_044
-- Post-044: a durable membership in BOTH zones. The grant does NOT widen
-- what they can read at any one moment — that is the property under test.
INSERT INTO account_members (user_id, account_id, role)
SELECT '33333333-3333-3333-3333-333333333333', a, 'agent' FROM zone
ON CONFLICT DO NOTHING;
INSERT INTO account_members (user_id, account_id, role)
SELECT '33333333-3333-3333-3333-333333333333', b, 'agent' FROM zone
ON CONFLICT DO NOTHING;
\endif

-- HQ is currently looking at zone A.
--
-- Pre-044 this line is the WHOLE of HQ's access: a profile holds one
-- account_id and that is all belonging means, so there is no second
-- membership to grant above. It also sets the role, which matters as
-- much as the account — `handle_new_user` made HQ the owner of their own
-- account, and 017's is_account_member() reads profiles.account_role, so
-- an unchanged role would let HQ pass the admin check further down and
-- turn a real assertion green for the wrong reason.
UPDATE profiles SET account_id = (SELECT a FROM zone), account_role = 'agent'
WHERE user_id = '33333333-3333-3333-3333-333333333333';

-- One parent, one thread, one message and one deal in each zone.
INSERT INTO contacts (account_id, user_id, name, phone)
SELECT a, '11111111-1111-1111-1111-111111111111', 'Ibu Zon A', '+60110000001' FROM zone;
INSERT INTO contacts (account_id, user_id, name, phone)
SELECT b, '22222222-2222-2222-2222-222222222222', 'Ibu Zon B', '+60110000002' FROM zone;

-- Scoped to this file's two zones, deliberately.
--
-- The upgrade CI job runs pgTAP against a database that
-- seed-legacy-state.sql has already populated, so an unscoped
-- `FROM contacts` sweeps up that fixture's parent too — which already
-- has a conversation, and the INSERT dies on
-- idx_conversations_account_contact. The suite was written against an
-- empty database and only ever ran against one.
INSERT INTO conversations (account_id, user_id, contact_id)
SELECT c.account_id, c.user_id, c.id FROM contacts c
 WHERE c.account_id IN (SELECT a FROM zone UNION SELECT b FROM zone);

INSERT INTO messages (conversation_id, sender_type, content_type, content_text)
SELECT v.id, 'customer', 'text', 'pesanan ' || v.account_id FROM conversations v
 WHERE v.account_id IN (SELECT a FROM zone UNION SELECT b FROM zone);

-- `deals` needs a pipeline and a stage, and `pipelines` is itself
-- account-scoped — so seeding one per zone exercises a second settings
-- table on the way to the deal.
INSERT INTO pipelines (account_id, user_id, name)
SELECT c.account_id, c.user_id, 'Kemasukan' FROM contacts c;

INSERT INTO pipeline_stages (pipeline_id, name, position)
SELECT p.id, 'Baharu', 1 FROM pipelines p;

INSERT INTO deals (account_id, user_id, contact_id, pipeline_id, stage_id, title, value)
SELECT c.account_id, c.user_id, c.id, p.id, s.id, 'Pendaftaran', 100
FROM contacts c
JOIN pipelines p ON p.account_id = c.account_id
JOIN pipeline_stages s ON s.pipeline_id = p.id
WHERE c.account_id IN (SELECT a FROM zone UNION SELECT b FROM zone);

-- ============================================================
-- 1. Zone staff see their own zone and nothing else
-- ============================================================
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is((SELECT count(*) FROM contacts)::int, 1,
  'zone A staff see exactly one contact');
SELECT is((SELECT string_agg(name, ', ' ORDER BY name) FROM contacts), 'Ibu Zon A',
  'and it is zone A''s parent, not zone B''s');
SELECT is((SELECT count(*) FROM conversations)::int, 1,
  'zone A staff see exactly one conversation');
SELECT is((SELECT count(*) FROM messages)::int, 1,
  'messages inherit the boundary through their conversation');
SELECT is((SELECT count(*) FROM deals)::int, 1,
  'zone A staff see exactly one deal');

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT is((SELECT string_agg(name, ', ' ORDER BY name) FROM contacts), 'Ibu Zon B',
  'zone B staff see only zone B''s parent');
SELECT is((SELECT count(*) FROM messages)::int, 1,
  'zone B staff see only their own zone''s messages');

RESET ROLE;

-- ============================================================
-- 2. THE CORE PROPERTY
--
-- HQ is active in zone A. Post-044 they are ALSO a member of zone B, and
-- that membership must not widen what they can read at this moment; this
-- is the single assertion 044's entire design rests on, and the one that
-- would break silently if the ACTIVE ZONE line in `is_account_member()`
-- were ever removed.
--
-- Pre-044 there is no second membership, so the same assertions test the
-- narrower claim: being in zone A shows zone A and nothing else. Weaker,
-- and still the property that keeps one branch out of another branch's
-- parent conversations. The messages below are worded to be true in both
-- worlds rather than describing a membership that may not exist.
-- ============================================================
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT is((SELECT count(*) FROM contacts)::int, 1,
  'HQ sees exactly ONE zone''s contacts');
SELECT is((SELECT string_agg(name, ', ' ORDER BY name) FROM contacts), 'Ibu Zon A',
  'and it is the zone they are active in');
SELECT is((SELECT count(*) FROM conversations)::int, 1,
  'HQ sees one zone''s conversations');
SELECT is((SELECT count(*) FROM messages)::int, 1,
  'HQ sees one zone''s messages');
SELECT is((SELECT count(*) FROM deals)::int, 1,
  'HQ sees one zone''s deals');

-- Post-044 the two helpers must disagree, and that disagreement IS the
-- design: one answers "may I read this now", the other "may I go there".
SELECT ok((SELECT is_account_member((SELECT a FROM zone))),
  'is_account_member() is true for the active zone');
SELECT ok(NOT (SELECT is_account_member((SELECT b FROM zone))),
  'is_account_member() is FALSE for the zone HQ is not active in');
\if :has_044
SELECT ok((SELECT is_account_member_any((SELECT b FROM zone))),
  'is_account_member_any() is true for that same zone — switcher only');
\else
-- The helper is created by 044. Pre-044 there is no "zone I belong to
-- but am not in", so there is nothing for it to be true ABOUT.
SELECT skip('is_account_member_any() does not exist before 044', 1);
\endif

-- Role tiering still applies within the active zone.
SELECT ok(NOT (SELECT is_account_member((SELECT a FROM zone), 'admin')),
  'an HQ agent does not pass an admin check');

RESET ROLE;

-- ============================================================
-- 3. Switching zones moves the window, it does not widen it
-- ============================================================
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';

\if :has_044
SELECT lives_ok(
  format('SELECT set_active_account(%L)', (SELECT b FROM zone)),
  'HQ may switch to a zone they are a member of');

SELECT is((SELECT string_agg(name, ', ' ORDER BY name) FROM contacts), 'Ibu Zon B',
  'after switching, HQ sees zone B');
SELECT is((SELECT count(*) FROM contacts)::int, 1,
  'and still only one zone at a time');

RESET ROLE;

-- A zone staffer may not switch into a zone they were never granted.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT throws_ok(
  format('SELECT set_active_account(%L)', (SELECT b FROM zone)),
  '42501',
  NULL,
  'zone A staff cannot switch into zone B');
\else
-- set_active_account() is created by 044 and switching is meaningless
-- without a second membership to switch INTO. Skipped, not deleted: the
-- plan stays 25, and the run reports what it did not check instead of
-- quietly checking less.
--
-- This is the real gap in the upgrade job, and it is narrow on purpose —
-- the zone BOUNDARY is still tested there by the 20 assertions around
-- this block. What goes untested pre-044 is only the ability to move
-- between zones, which pre-044 production does not have.
SELECT skip('set_active_account() does not exist before 044', 3);

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT skip('set_active_account() does not exist before 044', 1);
\endif

-- Nor write into it, even though they can name it.
SELECT throws_ok(
  format('INSERT INTO contacts (account_id, user_id, name, phone) VALUES (%L, %L, ''Selundup'', ''+60119999999'')',
         (SELECT b FROM zone), '11111111-1111-1111-1111-111111111111'),
  '42501',
  NULL,
  'zone A staff cannot insert a contact into zone B');

RESET ROLE;

-- ============================================================
-- 4. Anonymous callers see nothing at all
-- ============================================================
-- Clearing the claims is load-bearing, not tidiness. `SET LOCAL` holds
-- for the rest of the transaction, so without this the anon block would
-- still carry the previous persona's `sub`, `auth.uid()` would still
-- resolve to a real user, and these two tests would pass rows through
-- and report a leak that does not exist.
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '';

SELECT is((SELECT count(*) FROM contacts)::int, 0,
  'anon sees no contacts');
SELECT is((SELECT count(*) FROM messages)::int, 0,
  'anon sees no messages');

RESET ROLE;

-- ============================================================
-- 5. Migration 046 / 047 — the hardening stays hardened
--
-- These duplicate assertions that live inside 046 and 047 themselves.
-- That is deliberate: those run once, at apply time, whereas this file
-- runs on every pull request, so a later migration that re-grants one of
-- them is caught here.
-- ============================================================
SELECT ok(
  NOT has_function_privilege('public', 'public._bcast_bump(uuid, text, int)'::regprocedure, 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.record_webhook_failure(uuid, int)'::regprocedure, 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.recompute_broadcast_counts(uuid)'::regprocedure, 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.claim_ai_reply_slot(uuid, integer)'::regprocedure, 'EXECUTE'),
  '046: no counter-mutating SECURITY DEFINER function is callable by PUBLIC');

SELECT ok(
  NOT has_column_privilege('authenticated', 'public.profiles', 'account_role', 'UPDATE')
  AND NOT has_column_privilege('authenticated', 'public.profiles', 'account_id', 'UPDATE'),
  '046: authenticated cannot write a profiles privilege column');

-- The matching storage assertion ("no bucket is world-readable") lives
-- with migration 047, not here: it can only pass once 047 has landed, and
-- a test that fails for a whole release is a test people learn to ignore.

SELECT * FROM finish();

ROLLBACK;
