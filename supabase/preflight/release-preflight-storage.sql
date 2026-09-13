-- ============================================================
-- release-preflight-storage — run BEFORE migrations 047 and 050
--
-- READ ONLY. Every statement in this file is a SELECT. It creates
-- nothing, changes nothing, and can be run against production at any
-- time, including during business hours.
--
-- What it is for
-- --------------
-- 047 makes three storage buckets private and asserts, project-wide,
-- that NO bucket is left public. That assertion is deliberately broader
-- than the three buckets it fixes — and it is the most likely way this
-- release fails on production while passing in CI, because a bucket
-- created through the Supabase dashboard exists nowhere in this repo.
--
-- 050 then rewrites the attachment URLs that 047 breaks. Section 4
-- tells you how many rows that is, and section 5 shows you exactly what
-- the rewrite will produce, before it runs.
--
-- How to run: paste into the Supabase SQL editor, or
--   psql "$DATABASE_URL" -f supabase/preflight/release-preflight-storage.sql
-- ============================================================

\echo ''
\echo '=== 1. BLOCKER CHECK: every bucket and its visibility ======'
-- 047 aborts unless this table shows zero public buckets AFTERWARDS. It
-- flips exactly three of them. Any OTHER bucket with public = true is a
-- bucket 047 does not know about, and it will stop the migration dead.
--
-- If one appears here that is not avatars / flow-media / chat-media,
-- decide before the release: either make it private by hand (and
-- confirm nothing depended on the public URL), or delete it if it is
-- an experiment nobody uses. Do not widen 047's assertion — it is the
-- only thing standing between this project and another open bucket.
SELECT
  b.id                                   AS bucket,
  b.public,
  CASE
    WHEN b.id IN ('avatars', 'flow-media', 'chat-media') AND b.public
      THEN '047 will make this private'
    WHEN b.id IN ('avatars', 'flow-media', 'chat-media')
      THEN 'already private'
    WHEN b.public
      THEN 'UNEXPECTED PUBLIC BUCKET — 047 WILL ABORT'
    ELSE 'unknown to 047, but private — fine'
  END                                    AS "what 047 does",
  b.file_size_limit,
  b.created_at
FROM storage.buckets b
ORDER BY b.public DESC, b.id;

\echo ''
\echo '=== 2. Objects per bucket =================================='
-- Scale, so the size of the change is known rather than assumed.
SELECT
  o.bucket_id                            AS bucket,
  count(*)                               AS objects,
  pg_size_pretty(
    COALESCE(SUM((o.metadata->>'size')::bigint), 0)
  )                                      AS total_size,
  min(o.created_at)                      AS oldest,
  max(o.created_at)                      AS newest
FROM storage.objects o
GROUP BY o.bucket_id
ORDER BY count(*) DESC;

\echo ''
\echo '=== 3. Read policies on storage.objects today =============='
-- The three 047 replaces read `USING (bucket_id = ''<name>'')`, which is
-- true for everyone including anon. Recorded so the before-state is on
-- file, and so an unexpected fourth read policy is noticed now.
SELECT
  policyname,
  cmd,
  roles::text,
  qual
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename  = 'objects'
  AND cmd IN ('SELECT', 'ALL')
ORDER BY policyname;

\echo ''
\echo '=== 4. BLOCKER CHECK: attachments 047 would break =========='
-- Every row counted here holds an absolute public-bucket URL. The
-- instant 047 commits, all of them stop resolving: the bytes stay in
-- the bucket, the pointer goes dead, and the inbox renders
-- "unavailable".
--
-- Migration 050 rewrites them onto /api/media/..., and
-- resolveStoredMediaUrl() in the application does the same mapping at
-- render time as a safety net. If BOTH are in the release you are
-- shipping, this number is informational. If either is missing, this
-- number is how many attachments you are about to lose.
SELECT
  CASE
    WHEN media_url LIKE '%/storage/v1/object/public/chat-media/%' THEN 'chat-media'
    WHEN media_url LIKE '%/storage/v1/object/public/flow-media/%' THEN 'flow-media'
    WHEN media_url LIKE '%/storage/v1/object/public/avatars/%'    THEN 'avatars'
  END                                    AS bucket,
  count(*)                               AS "messages to rewrite",
  min(created_at)                        AS oldest,
  max(created_at)                        AS newest
FROM messages
WHERE media_url LIKE '%/storage/v1/object/public/chat-media/%'
   OR media_url LIKE '%/storage/v1/object/public/flow-media/%'
   OR media_url LIKE '%/storage/v1/object/public/avatars/%'
GROUP BY 1
ORDER BY 2 DESC;

\echo ''
\echo '=== 5. Dry run of the 050 rewrite (first 20 rows) =========='
-- Exactly the transformation 050 performs, as a SELECT. Read the
-- "after" column: it must start /api/media/<bucket>/ and keep the
-- percent-encoding of the original byte for byte. A decoded space or a
-- double-encoded %2520 here means the rewrite would point at an object
-- that does not exist.
SELECT
  id,
  media_url AS before,
  '/api/media/' ||
    substring(media_url FROM position('/storage/v1/object/public/' IN media_url)
                             + length('/storage/v1/object/public/')) AS after
FROM messages
WHERE media_url LIKE '%/storage/v1/object/public/chat-media/%'
   OR media_url LIKE '%/storage/v1/object/public/flow-media/%'
   OR media_url LIKE '%/storage/v1/object/public/avatars/%'
ORDER BY created_at DESC
LIMIT 20;

\echo ''
\echo '=== 6. The other media_url shapes, which 050 leaves alone =='
-- Sanity check on scope. `/api/whatsapp/media/` is the inbound proxy and
-- predates 047; "other absolute URL" is an operator-supplied link from
-- POST /api/v1/messages and was never in our buckets. Neither is touched
-- by 050, and neither is affected by 047.
SELECT
  CASE
    WHEN media_url IS NULL                                      THEN 'no attachment'
    WHEN media_url LIKE '/api/media/%'                          THEN 'already a proxy pointer'
    WHEN media_url LIKE '/api/whatsapp/media/%'                 THEN 'inbound proxy (untouched)'
    WHEN media_url LIKE '%/storage/v1/object/public/%'          THEN 'legacy public URL (to rewrite)'
    WHEN media_url LIKE 'http%'                                 THEN 'other absolute URL (untouched)'
    ELSE 'unrecognised — inspect'
  END                                    AS shape,
  count(*)                               AS messages
FROM messages
GROUP BY 1
ORDER BY 2 DESC;

\echo ''
\echo '=== 7. Public URLs stored outside messages.media_url ======='
-- 050 covers messages.media_url only, because that is where the mirror
-- writes. If either count below is non-zero those columns hold links
-- that will also die with 047, and they need their own decision — the
-- template header in particular is sent to Meta, not just rendered.
SELECT
  (SELECT count(*) FROM message_templates
    WHERE header_media_url LIKE '%/storage/v1/object/public/%')  AS "message_templates.header_media_url",
  (SELECT count(*) FROM messages
    WHERE content_text     LIKE '%/storage/v1/object/public/%')  AS "public URL pasted into message text";

\echo ''
\echo '=== 8. Objects whose path 047 policies cannot match ========'
-- The new read policies scope by the first path segment: either
-- `account-<uuid>` or, for the legacy branch, the uploader's user id.
-- An object whose first segment is neither is readable by nobody after
-- 047 — not a leak, but a file nobody can open again.
SELECT
  o.bucket_id                            AS bucket,
  (storage.foldername(o.name))[1]        AS first_segment,
  count(*)                               AS objects
FROM storage.objects o
WHERE o.bucket_id IN ('avatars', 'flow-media', 'chat-media')
  AND (storage.foldername(o.name))[1] NOT LIKE 'account-%'
  AND (storage.foldername(o.name))[1] !~ '^[0-9a-fA-F-]{36}$'
GROUP BY 1, 2
ORDER BY 3 DESC;

\echo ''
\echo '=== preflight (storage) complete — nothing was modified ===='
