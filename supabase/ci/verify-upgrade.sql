-- ============================================================
-- verify-upgrade — did 042-049 handle the rows that were already there?
--
-- Run by the "upgrade path" job in .github/workflows/migrations.yml,
-- after 042-049 are applied on top of seed-legacy-state.sql.
--
-- verify-schema.sql asserts that objects EXIST. This file asserts what
-- happened to DATA, which is the half a blank-database replay can never
-- reach. Every assertion below corresponds to a specific way one of the
-- three backfilling migrations could quietly do the wrong thing — plus,
-- for media, the opposite: proof that NOTHING in the release touched
-- `messages.media_url` at all.
-- ============================================================
DO $$
DECLARE
  v_role      account_role_enum;
  v_count     INT;
  v_url       TEXT;
  v_config    UUID;
  v_tab       TEXT;
BEGIN
  -- ==========================================================
  -- 044 — the NULL-role profile must not have been locked out
  -- ==========================================================
  SELECT m.role INTO v_role
    FROM account_members m
   WHERE m.user_id    = 'aaaaaaaa-0000-0000-0000-000000000003'
     AND m.account_id = 'bbbbbbbb-0000-0000-0000-000000000001';

  IF v_role IS NULL THEN
    RAISE EXCEPTION
      '044: the profile with a NULL account_role got no membership row — that user is locked out of every table';
  END IF;

  -- The fallback must be the FLOOR of the hierarchy. If this ever reads
  -- admin or owner, someone has been silently promoted by a migration,
  -- which is a far worse outcome than the lockout it was fixing.
  IF v_role <> 'viewer' THEN
    RAISE EXCEPTION
      '044: the NULL-role fallback granted %, not viewer — a migration must never promote anyone', v_role;
  END IF;

  -- The cache on profiles must agree with the grant.
  SELECT p.account_role INTO v_role
    FROM profiles p WHERE p.user_id = 'aaaaaaaa-0000-0000-0000-000000000003';
  IF v_role IS DISTINCT FROM 'viewer' THEN
    RAISE EXCEPTION
      '044: profiles.account_role is % for the NULL-role user; it must match the membership', v_role;
  END IF;

  -- Existing roles must survive untouched. COALESCE can only fire on a
  -- NULL, and this is the assertion that proves it did not do more.
  SELECT m.role INTO v_role
    FROM account_members m WHERE m.user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  IF v_role <> 'owner' THEN
    RAISE EXCEPTION '044: the owner was backfilled as %, not owner', v_role;
  END IF;

  SELECT m.role INTO v_role
    FROM account_members m WHERE m.user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
  IF v_role <> 'agent' THEN
    RAISE EXCEPTION '044: the agent was backfilled as %, not agent', v_role;
  END IF;

  -- And nobody with an account may be missing a row, seeded or not.
  SELECT count(*) INTO v_count
    FROM profiles p
   WHERE p.account_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM account_members m
        WHERE m.user_id = p.user_id AND m.account_id = p.account_id
     );
  IF v_count > 0 THEN
    RAISE EXCEPTION '044: % profile(s) still have no membership row', v_count;
  END IF;

  -- ==========================================================
  -- 042 — the merge must not have eaten a legitimate thread
  -- ==========================================================
  SELECT count(*) INTO v_count
    FROM conversations
   WHERE id = 'ffffffff-0000-0000-0000-000000000001';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      '042: the seeded conversation is gone — merge_duplicate_conversations() deleted a thread it should not have';
  END IF;

  SELECT count(*) INTO v_count
    FROM messages WHERE conversation_id = 'ffffffff-0000-0000-0000-000000000001';
  IF v_count <> 4 THEN
    RAISE EXCEPTION '042: expected 4 messages on the seeded thread, found %', v_count;
  END IF;

  -- ==========================================================
  -- 048 — the broadcast must remember the only number there was
  -- ==========================================================
  SELECT b.whatsapp_config_id INTO v_config
    FROM broadcasts b WHERE b.id = '88888888-0000-0000-0000-000000000001';
  IF v_config IS NULL THEN
    RAISE EXCEPTION
      '048: the pre-existing broadcast was not backfilled, so it can never be resumed';
  END IF;
  IF v_config <> 'dddddddd-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION '048: the broadcast was attributed to the wrong number (%)', v_config;
  END IF;

  -- ==========================================================
  -- Media — the release must leave messages.media_url ALONE
  --
  -- A backfill migration that rewrote these rows in place was written
  -- and withdrawn: in SQL there is no way to tell our storage host from
  -- any other *.supabase.co, so a row holding a URL from a different
  -- project would have been rewritten into a pointer at OUR bucket.
  -- The host check lives in `parseLegacyPublicUrl()` instead, and the
  -- mapping happens at render time.
  --
  -- So the assertion is inverted from what it was. Every one of these
  -- four rows must come through 042-049 byte for byte. If any of them
  -- changes, a migration has grown a media backfill without the host
  -- validation that made removing the last one necessary.
  -- ==========================================================
  SELECT media_url INTO v_url
    FROM messages WHERE id = '99999999-0000-0000-0000-000000000001';
  IF v_url <> 'https://demo.supabase.co/storage/v1/object/public/chat-media/account-bbbbbbbb-0000-0000-0000-000000000001/1736-foto.jpg' THEN
    RAISE EXCEPTION
      'media: the legacy image URL was modified by a migration (got %) — this release has no media backfill', v_url;
  END IF;

  SELECT media_url INTO v_url
    FROM messages WHERE id = '99999999-0000-0000-0000-000000000002';
  IF v_url <> 'https://demo.supabase.co/storage/v1/object/public/chat-media/account-bbbbbbbb-0000-0000-0000-000000000001/surat%20ibu%20bapa.pdf' THEN
    RAISE EXCEPTION
      'media: the encoded legacy URL was modified by a migration (got %)', v_url;
  END IF;

  SELECT media_url INTO v_url
    FROM messages WHERE id = '99999999-0000-0000-0000-000000000003';
  IF v_url <> '/api/whatsapp/media/wamid-abc' THEN
    RAISE EXCEPTION 'media: the inbound proxy pointer was modified (got %)', v_url;
  END IF;

  -- The one that matters most for "do not expose arbitrary external
  -- URLs": an operator's own link is not ours to rewrite, and nothing
  -- in the database may turn it into something the media proxy serves.
  SELECT media_url INTO v_url
    FROM messages WHERE id = '99999999-0000-0000-0000-000000000004';
  IF v_url <> 'https://cdn.example.com/brosur.png' THEN
    RAISE EXCEPTION 'media: an external URL was rewritten (got %)', v_url;
  END IF;

  -- And no row anywhere may have acquired a proxy pointer, because no
  -- migration in this release is allowed to write one.
  SELECT count(*) INTO v_count FROM messages WHERE media_url LIKE '/api/media/%';
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'media: % row(s) hold a proxy pointer — a migration wrote one, which this release forbids', v_count;
  END IF;

  -- ==========================================================
  -- 045 — the pre-existing presence row survived the key swap
  -- ==========================================================
  SELECT tab_id INTO v_tab
    FROM member_presence
   WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  IF v_tab IS DISTINCT FROM 'legacy' THEN
    RAISE EXCEPTION
      '045: the one-row-per-user presence row did not fold onto the legacy tab (got %)', v_tab;
  END IF;

  -- ==========================================================
  -- 047 — no bucket is public, on a database that had rows in it
  -- ==========================================================
  SELECT count(*) INTO v_count FROM storage.buckets WHERE public;
  IF v_count > 0 THEN
    RAISE EXCEPTION '047: % bucket(s) are still public after the upgrade', v_count;
  END IF;

  RAISE NOTICE 'upgrade path: 042-049 applied cleanly over production-shaped data';
END
$$;
