-- ============================================================
-- seed-legacy-state — a database that looks like production at 041
--
-- Run by the "upgrade path" job in .github/workflows/migrations.yml,
-- BETWEEN the replay of 001-041 and the application of 042 onward.
--
-- Why this file exists
-- --------------------
-- The other CI job replays every migration against an EMPTY database.
-- That proves the DDL is valid. It cannot prove the migrations are safe,
-- because the dangerous half of 042-049 is not DDL at all — it is three
-- statements that read existing rows:
--
--   042  runs merge_duplicate_conversations(), which DELETEs
--   044  backfills one account_members row per profile
--   048  backfills broadcasts.whatsapp_config_id
--
-- Against nothing, all three are no-ops that pass. The bug they can carry
-- only appears when there are rows to get wrong. So this file creates
-- the rows — in particular the two shapes that production is known or
-- suspected to hold and that a blank database never will:
--
--   * a profile with an account but a NULL account_role (locked out of
--     everything by an unhardened 044);
--   * messages carrying absolute public-bucket URLs, which 047 turns
--     into dead links and which NO migration in this release repairs —
--     `resolveStoredMediaUrl()` does it at render time instead. The
--     rows are seeded so verify-upgrade.sql can prove the database
--     leaves them exactly as they were.
--
-- Everything here is fixture data with fixed UUIDs so that
-- verify-upgrade.sql can assert against it by name. It is never run
-- against a real database — the preflight files in supabase/preflight/
-- are the read-only equivalent for that.
-- ============================================================

-- ---- identities ---------------------------------------------
-- auth.users is owned by Supabase; inserting directly is what the
-- pgTAP suites already do, and it is the only way to get a foreign key
-- target for profiles without booting GoTrue.
INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@example.test', NOW(), NOW()),
  ('aaaaaaaa-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'agent@example.test', NOW(), NOW()),
  -- THE CASE THIS FILE EXISTS FOR: a real member whose role was never set.
  ('aaaaaaaa-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'noroleuser@example.test', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO accounts (id, name, owner_user_id)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'Zon Lembah Klang',
        'aaaaaaaa-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO profiles (id, user_id, full_name, email, account_id, account_role)
VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Pemilik HQ', 'owner@example.test',
   'bbbbbbbb-0000-0000-0000-000000000001', 'owner'),
  ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002',
   'Kakitangan Cawangan', 'agent@example.test',
   'bbbbbbbb-0000-0000-0000-000000000001', 'agent'),
  -- account_id set, account_role deliberately absent. 017 made the
  -- column nullable with no default, so this row is legal today.
  ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000003',
   'Tiada Peranan', 'noroleuser@example.test',
   'bbbbbbbb-0000-0000-0000-000000000001', NULL)
ON CONFLICT (id) DO NOTHING;

-- ---- one connected number (the production shape today) -------
INSERT INTO whatsapp_config (id, user_id, account_id, phone_number_id, access_token, status)
VALUES ('dddddddd-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001',
        '100000000000001', 'test-token', 'connected')
ON CONFLICT (id) DO NOTHING;

-- ---- a parent, a thread, and attachments ---------------------
INSERT INTO contacts (id, user_id, account_id, phone, name)
VALUES ('eeeeeeee-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001',
        '+60123456789', 'Ibu Bapa Ujian')
ON CONFLICT (id) DO NOTHING;

INSERT INTO conversations (id, user_id, account_id, contact_id, whatsapp_config_id)
VALUES ('ffffffff-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001',
        'eeeeeeee-0000-0000-0000-000000000001',
        'dddddddd-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- Four attachment shapes. NONE of them may be modified by 042-049:
-- there is no media backfill in this release. The first two are the
-- legacy rows that depend on render-time compatibility; the last two
-- are shapes that must never be touched by anything.
INSERT INTO messages (id, conversation_id, sender_type, content_type, media_url, content_text)
VALUES
  -- 1. legacy public chat-media URL, plain filename
  ('99999999-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000001',
   'customer', 'image',
   'https://demo.supabase.co/storage/v1/object/public/chat-media/account-bbbbbbbb-0000-0000-0000-000000000001/1736-foto.jpg',
   'gambar lama'),
  -- 2. legacy public chat-media URL with a percent-encoded filename
  ('99999999-0000-0000-0000-000000000002', 'ffffffff-0000-0000-0000-000000000001',
   'customer', 'document',
   'https://demo.supabase.co/storage/v1/object/public/chat-media/account-bbbbbbbb-0000-0000-0000-000000000001/surat%20ibu%20bapa.pdf',
   'surat lama'),
  -- 3. the inbound proxy — predates 047 and must NOT be touched
  ('99999999-0000-0000-0000-000000000003', 'ffffffff-0000-0000-0000-000000000001',
   'customer', 'audio', '/api/whatsapp/media/wamid-abc', 'nota suara'),
  -- 4. an operator-supplied external URL via POST /api/v1/messages —
  --    never lived in our buckets, must NOT be touched
  ('99999999-0000-0000-0000-000000000004', 'ffffffff-0000-0000-0000-000000000001',
   'agent', 'image', 'https://cdn.example.com/brosur.png', 'brosur luaran')
ON CONFLICT (id) DO NOTHING;

-- ---- a broadcast with no remembered number -------------------
-- 048 must backfill this one, because the account holds exactly one
-- number and the answer is therefore unambiguous.
INSERT INTO broadcasts (id, user_id, account_id, name, template_name, status, total_recipients)
VALUES ('88888888-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001',
        'Kempen lama', 'peringatan_yuran', 'sent', 2)
ON CONFLICT (id) DO NOTHING;

-- ---- presence from the one-row-per-user era ------------------
-- 045 must fold this onto the synthetic 'legacy' tab rather than
-- failing on the primary-key swap.
INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001', 'online', NOW())
ON CONFLICT DO NOTHING;
