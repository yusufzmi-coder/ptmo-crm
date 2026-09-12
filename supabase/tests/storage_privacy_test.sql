-- ============================================================
-- storage_privacy_test — are the buckets actually private?
--
-- Ships with migration 047. Kept separate from zone_isolation_test.sql so
-- each file fails for one reason, and so this one could not go red for a
-- whole release while waiting for 047 to land.
--
-- What went wrong, and why a behavioural test is the only honest check
-- -------------------------------------------------------------------
-- All three buckets were created `public = TRUE` with a read policy of
-- `USING (bucket_id = '<name>')` — true for everyone, `anon` included
-- (008:33-35, 016:88-90, 023:84-86). Writes were correctly scoped by the
-- path's first segment, which made the asymmetry look considered rather
-- than overlooked.
--
-- 039 then turned a latent hole into an active one: it mirrors EVERY
-- inbound customer attachment into `chat-media`, defaulting to TRUE. So
-- every photo, document and voice note a parent sends — across all
-- centres and, under 044, all zones — was readable by the open internet.
--
-- Asserting the policy EXISTS would not have caught that: the old policy
-- existed too. What matters is who can read a row, so that is what this
-- file measures.
-- ============================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

-- ============================================================
-- Seed: two zones, one parent attachment in each
-- ============================================================
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'staf.a@ptmo.my', '{"full_name":"Staf Zon A"}'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'staf.b@ptmo.my', '{"full_name":"Staf Zon B"}');

CREATE TEMPORARY TABLE zone AS
SELECT
  (SELECT account_id FROM profiles WHERE user_id = 'aaaaaaaa-0000-0000-0000-00000000000a') AS a,
  (SELECT account_id FROM profiles WHERE user_id = 'bbbbbbbb-0000-0000-0000-00000000000b') AS b;
GRANT SELECT ON zone TO authenticated, anon;

-- Mirrored inbound attachments, at the path 039 writes them to.
INSERT INTO storage.objects (bucket_id, name)
SELECT 'chat-media', 'account-' || a || '/inbound/surat-zon-a.pdf' FROM zone;
INSERT INTO storage.objects (bucket_id, name)
SELECT 'chat-media', 'account-' || b || '/inbound/surat-zon-b.pdf' FROM zone;

-- ============================================================
-- 1. Structure — the flag and the policies
--
-- Both have to change. `public` is what gates Supabase's unauthenticated
-- /object/public/... route; the policy is what gates the authenticated
-- one. Fixing either alone leaves a way in.
-- ============================================================
SELECT is((SELECT count(*) FROM storage.buckets WHERE public)::int, 0,
  'no storage bucket is public');

SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname IN (
        'Avatars are publicly readable',
        'Flow media is publicly readable',
        'Chat media is publicly readable')),
  0,
  'the three unconditional read policies are gone');

SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname IN (
        'Members can read chat media',
        'Members can read flow media',
        'Members can read avatars')),
  3,
  'each bucket has a scoped read policy in its place');

SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname IN (
        'Members can read chat media',
        'Members can read flow media',
        'Members can read avatars')
      AND qual LIKE '%auth.uid()%'),
  3,
  'every scoped read policy actually references auth.uid()');

-- ============================================================
-- 2. Behaviour — who can read a parent's attachment
--
-- This is the assertion the original policy would have failed.
-- ============================================================
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '';

SELECT is((SELECT count(*) FROM storage.objects WHERE bucket_id = 'chat-media')::int, 0,
  'anon can read NO parent attachment');

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a"}';

SELECT is((SELECT count(*) FROM storage.objects WHERE bucket_id = 'chat-media')::int, 1,
  'zone A staff read exactly one attachment');
SELECT is(
  (SELECT string_agg(split_part(name, '/', 3), ', ' ORDER BY name)
     FROM storage.objects WHERE bucket_id = 'chat-media'),
  'surat-zon-a.pdf',
  'and it is their own zone''s, not zone B''s');

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-00000000000b"}';

SELECT is(
  (SELECT string_agg(split_part(name, '/', 3), ', ' ORDER BY name)
     FROM storage.objects WHERE bucket_id = 'chat-media'),
  'surat-zon-b.pdf',
  'zone B staff read only their own zone''s attachment');

RESET ROLE;

-- ============================================================
-- 3. Writes stay scoped
--
-- 047 only rewrote the READ policies. Assert the write side it left alone
-- is still there, so a future edit cannot quietly drop it while the read
-- tests above keep passing.
-- ============================================================
SELECT isnt_empty(
  $$SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname = 'Members can upload chat media'$$,
  'the account-scoped upload policy survives');

SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd = 'SELECT'
      AND qual NOT LIKE '%auth.uid()%'),
  0,
  'no SELECT policy on storage.objects is unconditional');

SELECT * FROM finish();

ROLLBACK;
