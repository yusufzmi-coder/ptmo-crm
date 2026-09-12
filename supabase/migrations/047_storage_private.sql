-- ============================================================
-- 047_storage_private — close the three world-readable buckets
--
-- Why
-- ---
-- All three storage buckets were created `public = TRUE` and given an
-- unconditional read policy:
--
--   avatars      008_profile_avatars_storage.sql:15-19, policy :33-35
--   flow-media   016_flow_media.sql:57-61,              policy :88-90
--   chat-media   023_chat_media.sql:38-42,              policy :84-86
--
-- Each policy is `USING (bucket_id = '<name>')` — true for everyone,
-- including `anon`. Writes are correctly scoped by the path's first
-- segment (020:80-89, 023:89-98), so the asymmetry is deliberate-looking
-- but only half-considered: any unauthenticated caller can list and
-- fetch every account's files.
--
-- 039_inbound_media_mirror.sql:22-29 turned that from a latent problem
-- into an active one. It mirrors EVERY inbound customer attachment into
-- `chat-media`, and `mirror_inbound_media` defaults to TRUE, so every
-- photo, document and voice note a parent sends — across all centres and
-- all zones — lands in a bucket the open internet can read.
--
-- Under the zone model (044) this is cross-ZONE: zone B's attachments are
-- readable not merely by zone A's staff but by nobody-in-particular.
--
-- What this does
-- --------------
--   1. Flips all three buckets to `public = FALSE`, which is what stops
--      Supabase serving them from the unauthenticated
--      /object/public/<bucket>/<path> route.
--   2. Replaces each unconditional SELECT policy with one scoped the
--      same way the bucket's own write policy already is.
--
-- On the predicate shape
-- ----------------------
-- The read policies deliberately reuse the write policies' exact form —
--
--   EXISTS (SELECT 1 FROM public.profiles p
--            WHERE p.user_id = auth.uid()
--              AND ('account-' || p.account_id::text) = (storage.foldername(name))[1])
--
-- rather than parsing the uuid out of the path and calling
-- `is_account_member()`. Two reasons:
--
--   * No cast. `substring(path from 9)::uuid` would raise on any object
--     whose first segment is not `account-<uuid>` — including the legacy
--     pre-020 avatars/flow-media paths — and a raising policy does not
--     return "no rows", it fails the whole query.
--   * It already means "my ACTIVE account". After 044 a user's
--     `profiles.account_id` is the zone they are currently in, so this
--     predicate inherits zone isolation for free and stays fail-closed:
--     an HQ user who may enter four zones still reads only the files of
--     the one they are active in. Using `is_account_member_any()` here
--     would silently widen that, which is the mistake 044's header warns
--     against.
--
-- The legacy `auth.uid()::text = (storage.foldername(name))[1]` branch
-- from 020:87 is carried into the read policies too, so objects written
-- under the pre-020 convention stay readable by the person who uploaded
-- them rather than becoming permanently unreachable.
--
-- Avatars are pathed `<user_id>/<file>` (008:38-40), not
-- `account-<id>/...`, so they get their own predicate: your own avatar,
-- plus the avatars of people whose active account is the same as yours —
-- which is what the member list and inbox assignee chips need.
--
-- Application impact — read this before deploying
-- -----------------------------------------------
-- `getPublicUrl()` keeps returning a URL string after this migration, but
-- that URL now 400s. Three call sites produce one:
--   src/lib/storage/upload-media.ts:130
--   src/lib/whatsapp/mirror-inbound-media.ts:231
--   src/components/settings/profile-form.tsx:136
-- and `messages.media_url` PERSISTS what the first two returned
-- (webhook/route.ts:714), so historical rows hold URLs that stop
-- resolving. The companion application change stores the storage PATH and
-- serves it through an authenticated route that signs on demand —
-- mirroring the proxy shape the codebase already uses for un-mirrored
-- inbound media (`/api/whatsapp/media/<id>`).
--
-- Outbound media is the one case that genuinely needs an unauthenticated
-- URL: `sendMediaMessage` (meta-api.ts:286-300) passes `{ link }` and
-- Meta fetches it itself. That is served by a short-lived
-- `createSignedUrl()` generated at send time, not by a public bucket.
--
-- Deploy this migration and its application change together. Alone, this
-- file breaks media rendering; alone, the application change is pointless.
--
-- Idempotent — safe to re-run.
--
-- Rollback
-- --------
--   UPDATE storage.buckets SET public = TRUE
--     WHERE id IN ('avatars','flow-media','chat-media');
--   -- then restore the three `USING (bucket_id = '...')` policies from
--   -- 008:33-35, 016:88-90 and 023:84-86.
-- (This re-opens every zone's attachments to the internet.)
-- ============================================================

-- ============================================================
-- 1. The buckets are no longer public
--
-- This flag, not the policy, is what gates Supabase's
-- /object/public/... route. Both have to change: the flag stops the
-- unauthenticated route, the policy below stops a cross-account read
-- through the authenticated one.
-- ============================================================
UPDATE storage.buckets
SET public = FALSE
WHERE id IN ('avatars', 'flow-media', 'chat-media');

-- ============================================================
-- 2. chat-media — account-scoped reads
-- ============================================================
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read chat media" ON storage.objects;
CREATE POLICY "Members can read chat media"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'chat-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      -- Legacy pre-020 paths stay readable by their uploader.
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- 3. flow-media — account-scoped reads
-- ============================================================
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read flow media" ON storage.objects;
CREATE POLICY "Members can read flow media"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- 4. avatars — your own, plus your teammates'
--
-- Pathed `<user_id>/<file>`, so the predicate is about whose avatar it
-- is rather than which account folder it sits in. The second branch
-- compares the owner's active account to the caller's: teammates in the
-- zone you are currently in, nobody else.
-- ============================================================
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read avatars" ON storage.objects;
CREATE POLICY "Members can read avatars"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'avatars'
    AND (
      auth.uid()::text = (storage.foldername(name))[1]
      OR EXISTS (
        SELECT 1
        FROM public.profiles owner
        JOIN public.profiles me ON me.user_id = auth.uid()
        WHERE owner.user_id::text = (storage.foldername(name))[1]
          AND owner.account_id = me.account_id
      )
    )
  );

-- ============================================================
-- 5. Assert the outcome
--
-- `UPDATE` reports success on zero rows, and a misspelled policy name in
-- a DROP is a silent no-op, so the end state is asserted rather than
-- assumed — the same reason supabase/ci/verify-schema.sql exists.
-- ============================================================
DO $$
DECLARE
  v_public_cnt INT;
  v_bucket     TEXT;
  v_policy     TEXT;
BEGIN
  -- No bucket anywhere in the project may be public. Deliberately
  -- broader than the three named above: a fourth public bucket added
  -- later is the same leak by another name.
  SELECT count(*) INTO v_public_cnt FROM storage.buckets WHERE public;
  IF v_public_cnt > 0 THEN
    RAISE EXCEPTION
      '% storage bucket(s) are still public — unauthenticated callers can read every account''s files',
      v_public_cnt;
  END IF;

  -- The three unconditional read policies must be gone.
  FOREACH v_policy IN ARRAY ARRAY[
    'Avatars are publicly readable',
    'Flow media is publicly readable',
    'Chat media is publicly readable'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = v_policy
    ) THEN
      RAISE EXCEPTION 'the unconditional read policy "%" still exists', v_policy;
    END IF;
  END LOOP;

  -- And each bucket must have exactly one scoped read policy in its place.
  FOREACH v_policy IN ARRAY ARRAY[
    'Members can read chat media',
    'Members can read flow media',
    'Members can read avatars'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = v_policy
    ) THEN
      RAISE EXCEPTION 'the scoped read policy "%" was not created', v_policy;
    END IF;
  END LOOP;

  -- A scoped policy that forgot its auth.uid() term would read as
  -- "everyone" again. Cheap shape check against the catalogue.
  FOR v_bucket, v_policy IN
    SELECT 'chat-media', 'Members can read chat media'
    UNION ALL SELECT 'flow-media', 'Members can read flow media'
    UNION ALL SELECT 'avatars',    'Members can read avatars'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname = v_policy
        AND qual LIKE '%auth.uid()%'
    ) THEN
      RAISE EXCEPTION
        'read policy "%" for bucket % does not reference auth.uid() — it may be readable by anon',
        v_policy, v_bucket;
    END IF;
  END LOOP;

  RAISE NOTICE '047: avatars, flow-media and chat-media are private with account-scoped reads';
END
$$;
