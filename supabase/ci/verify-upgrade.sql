-- ============================================================
-- verify-upgrade — did 042-050 handle the rows that were already there?
--
-- Run by the "upgrade path" job in .github/workflows/migrations.yml,
-- after 042-050 are applied on top of seed-legacy-state.sql.
--
-- verify-schema.sql asserts that objects EXIST. This file asserts what
-- happened to DATA, which is the half a blank-database replay can never
-- reach. Every assertion below corresponds to a specific way one of the
-- four backfilling migrations could quietly do the wrong thing.
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
  -- 050 — legacy attachment links, and only those, are rewritten
  -- ==========================================================
  SELECT media_url INTO v_url
    FROM messages WHERE id = '99999999-0000-0000-0000-000000000001';
  IF v_url <> '/api/media/chat-media/account-bbbbbbbb-0000-0000-0000-000000000001/1736-foto.jpg' THEN
    RAISE EXCEPTION '050: the legacy image URL was not rewritten correctly (got %)', v_url;
  END IF;

  -- Percent-encoding must survive byte for byte: the proxy route decodes
  -- each segment, so a double-encoded or decoded path resolves to the
  -- wrong object — or to none.
  SELECT media_url INTO v_url
    FROM messages WHERE id = '99999999-0000-0000-0000-000000000002';
  IF v_url <> '/api/media/chat-media/account-bbbbbbbb-0000-0000-0000-000000000001/surat%20ibu%20bapa.pdf' THEN
    RAISE EXCEPTION '050: the encoded filename did not round-trip (got %)', v_url;
  END IF;

  SELECT media_url INTO v_url
    FROM messages WHERE id = '99999999-0000-0000-0000-000000000003';
  IF v_url <> '/api/whatsapp/media/wamid-abc' THEN
    RAISE EXCEPTION '050: the inbound proxy pointer was modified (got %)', v_url;
  END IF;

  -- The one that matters for "do not expose arbitrary external URLs":
  -- an operator's own link is not ours to rewrite, and it must not be
  -- turned into something the media proxy would try to serve.
  SELECT media_url INTO v_url
    FROM messages WHERE id = '99999999-0000-0000-0000-000000000004';
  IF v_url <> 'https://cdn.example.com/brosur.png' THEN
    RAISE EXCEPTION '050: an external URL was rewritten (got %)', v_url;
  END IF;

  SELECT count(*) INTO v_count
    FROM messages
   WHERE media_url LIKE '%/storage/v1/object/public/chat-media/%'
      OR media_url LIKE '%/storage/v1/object/public/flow-media/%'
      OR media_url LIKE '%/storage/v1/object/public/avatars/%';
  IF v_count > 0 THEN
    RAISE EXCEPTION '050: % message(s) still hold a dead public-bucket URL', v_count;
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

  RAISE NOTICE 'upgrade path: 042-050 applied cleanly over production-shaped data';
END
$$;
