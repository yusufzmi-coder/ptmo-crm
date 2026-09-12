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
-- ============================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

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

-- HQ may enter both zones. This is the durable grant; it does NOT widen
-- what they can read at any one moment.
INSERT INTO account_members (user_id, account_id, role)
SELECT '33333333-3333-3333-3333-333333333333', a, 'agent' FROM zone
ON CONFLICT DO NOTHING;
INSERT INTO account_members (user_id, account_id, role)
SELECT '33333333-3333-3333-3333-333333333333', b, 'agent' FROM zone
ON CONFLICT DO NOTHING;

-- HQ is currently looking at zone A.
UPDATE profiles SET account_id = (SELECT a FROM zone), account_role = 'agent'
WHERE user_id = '33333333-3333-3333-3333-333333333333';

-- One parent, one thread, one message and one deal in each zone.
INSERT INTO contacts (account_id, user_id, name, phone)
SELECT a, '11111111-1111-1111-1111-111111111111', 'Ibu Zon A', '+60110000001' FROM zone;
INSERT INTO contacts (account_id, user_id, name, phone)
SELECT b, '22222222-2222-2222-2222-222222222222', 'Ibu Zon B', '+60110000002' FROM zone;

INSERT INTO conversations (account_id, user_id, contact_id)
SELECT c.account_id, c.user_id, c.id FROM contacts c;

INSERT INTO messages (conversation_id, sender_type, content_type, content_text)
SELECT v.id, 'customer', 'text', 'pesanan ' || v.account_id FROM conversations v;

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
JOIN pipeline_stages s ON s.pipeline_id = p.id;

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
-- HQ is a member of both zones but active in A. Membership must not
-- widen what they can read. This is the single assertion that 044's
-- entire design rests on, and the one that would break silently if the
-- ACTIVE ZONE line in `is_account_member()` were ever removed.
-- ============================================================
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT is((SELECT count(*) FROM contacts)::int, 1,
  'HQ, member of two zones, sees ONE zone''s contacts');
SELECT is((SELECT string_agg(name, ', ' ORDER BY name) FROM contacts), 'Ibu Zon A',
  'and it is the zone they are active in');
SELECT is((SELECT count(*) FROM conversations)::int, 1,
  'HQ sees one zone''s conversations');
SELECT is((SELECT count(*) FROM messages)::int, 1,
  'HQ sees one zone''s messages');
SELECT is((SELECT count(*) FROM deals)::int, 1,
  'HQ sees one zone''s deals');

-- The two helpers must disagree, and that disagreement is the design.
SELECT ok((SELECT is_account_member((SELECT a FROM zone))),
  'is_account_member() is true for the active zone');
SELECT ok(NOT (SELECT is_account_member((SELECT b FROM zone))),
  'is_account_member() is FALSE for a zone HQ belongs to but is not in');
SELECT ok((SELECT is_account_member_any((SELECT b FROM zone))),
  'is_account_member_any() is true for that same zone — switcher only');

-- Role tiering still applies within the active zone.
SELECT ok(NOT (SELECT is_account_member((SELECT a FROM zone), 'admin')),
  'an HQ agent does not pass an admin check');

RESET ROLE;

-- ============================================================
-- 3. Switching zones moves the window, it does not widen it
-- ============================================================
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333"}';

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
