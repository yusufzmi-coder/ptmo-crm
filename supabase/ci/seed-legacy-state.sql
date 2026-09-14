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
--   * a profile at the floor of the role hierarchy (`viewer`), so the
--     assertions about existing roles have something that is not an
--     owner or an agent to check against. This row previously carried a
--     NULL account_role; see the note beside it for why that was
--     impossible;
--   * messages carrying absolute public-bucket URLs, which 047 turns
--     into dead links and which NO migration in this release repairs —
--     `resolveStoredMediaUrl()` does it at render time instead.
--
--     NOTE: nothing asserts against these four rows any more. The only
--     block that read them was the 042 block in verify-upgrade.sql,
--     removed because it proved nothing. They are a cost with no
--     benefit until either an assertion comes back or they go. See
--     docs/open-findings.md, "Job \"upgrade path\" tidak pernah lulus".
--
-- HOW THIS FILE GETS ITS ACCOUNT
-- ------------------------------
-- It does not create one. `on_auth_user_created` -> `handle_new_user`
-- (017:...) already provisions an account and an `owner` profile for
-- every auth.users row, so an INSERT here would be the SECOND account
-- for the same owner and trips `idx_accounts_one_per_owner` —
-- `ON CONFLICT (id)` does not catch a clash on `owner_user_id`.
--
-- An earlier version of this file did exactly that, and took the
-- upgrade job down with it. zone_isolation_test.sql:45 had the shape
-- right all along: insert the users, then read what the trigger made.
-- That is what happens below, and everything downstream addresses the
-- account through `seed_zone` rather than a literal UUID.
--
-- Everything here is fixture data with fixed UUIDs so that
-- verify-upgrade.sql can assert against it by name. It is never run
-- against a real database — the preflight files in supabase/preflight/
-- are the read-only equivalent for that.
-- ============================================================

-- ---- identities ---------------------------------------------
-- auth.users is owned by Supabase; inserting directly is what the pgTAP
-- suites already do, and it is the only way to get a foreign key target
-- for profiles without booting GoTrue.
--
-- `full_name` goes in the metadata rather than into a later UPDATE,
-- because that is the channel the trigger reads — the same one a real
-- signup uses. Only the two facts the trigger cannot know, account and
-- role, are corrected afterwards.
INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@example.test',
   '{"full_name":"Pemilik HQ"}', NOW(), NOW()),
  ('aaaaaaaa-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'agent@example.test',
   '{"full_name":"Kakitangan Cawangan"}', NOW(), NOW()),
  -- The floor of the role hierarchy. This row carried a NULL
  -- account_role until a503493, on the belief that 017 left the column
  -- nullable; 017 adds it nullable at :122 and makes it NOT NULL at
  -- :275, in the same file. See verify-schema.sql for the invariant.
  ('aaaaaaaa-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'viewer@example.test',
   '{"full_name":"Peranan Paling Rendah"}', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- The zone under test: the account the trigger built for the owner.
-- Held in a temp table so the statements below read like the fixture
-- they are, instead of repeating the same subquery nine times. It lives
-- for this psql session only and is invisible to every later step.
CREATE TEMPORARY TABLE seed_zone AS
SELECT account_id AS id
  FROM profiles
 WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- A trigger that fails only RAISEs a WARNING (017: EXCEPTION WHEN
-- OTHERS), so a missing account would otherwise surface much later as a
-- confusing NOT NULL violation on some unrelated INSERT. Fail here.
DO $seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM seed_zone WHERE id IS NOT NULL) THEN
    RAISE EXCEPTION
      'handle_new_user did not provision an account for the owner — the '
      'trigger swallows its own errors, so check the WARNING above this line';
  END IF;
END $seed$;

-- Fold the other two into that zone. The trigger makes everyone the
-- owner of their own account, which is the shape 044 describes; this
-- seed needs the pre-044 shape instead — one zone, three members at
-- three privilege levels.
UPDATE profiles
   SET account_id = (SELECT id FROM seed_zone), account_role = 'agent'
 WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000002';

UPDATE profiles
   SET account_id = (SELECT id FROM seed_zone), account_role = 'viewer'
 WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000003';

-- Their now-empty personal accounts would leave `accounts` holding three
-- rows for a fixture that describes one zone, which makes any later
-- count assertion read wrong. Nothing references them once the profiles
-- have moved.
DELETE FROM accounts
 WHERE owner_user_id IN ('aaaaaaaa-0000-0000-0000-000000000002',
                         'aaaaaaaa-0000-0000-0000-000000000003');

-- ---- one connected number (the production shape today) -------
INSERT INTO whatsapp_config (id, user_id, account_id, phone_number_id, access_token, status)
VALUES ('dddddddd-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001',
        (SELECT id FROM seed_zone),
        '100000000000001', 'test-token', 'connected')
ON CONFLICT (id) DO NOTHING;

-- ---- a parent, a thread, and attachments ---------------------
INSERT INTO contacts (id, user_id, account_id, phone, name)
VALUES ('eeeeeeee-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001',
        (SELECT id FROM seed_zone),
        '+60123456789', 'Ibu Bapa Ujian')
ON CONFLICT (id) DO NOTHING;

INSERT INTO conversations (id, user_id, account_id, contact_id, whatsapp_config_id)
VALUES ('ffffffff-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001',
        (SELECT id FROM seed_zone),
        'eeeeeeee-0000-0000-0000-000000000001',
        'dddddddd-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- Four attachment shapes. NONE of them may be modified by 042-049:
-- there is no media backfill in this release. The first two are the
-- legacy rows that depend on render-time compatibility; the last two
-- are shapes that must never be touched by anything.
--
-- verify-upgrade.sql asserts these four are byte-identical afterwards.
-- That negative is the point of the rows: the backfill that would have
-- rewritten media_url was withdrawn because SQL cannot resolve the
-- storage host, and the mapping lives in resolveStoredMediaUrl() at
-- render time instead. "No migration touches this column" is the
-- assertion that protects that decision.
--
-- The `account-bbbbbbbb-...` inside the first two URLs is deliberately
-- NOT the account this seed builds. It is opaque legacy text: no
-- migration parses it, the assertion is byte equality, and computing it
-- from the live account on both sides would only prove the expression
-- matches itself.
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
        (SELECT id FROM seed_zone),
        'Kempen lama', 'peringatan_yuran', 'sent', 2)
ON CONFLICT (id) DO NOTHING;

-- ---- branches with keywords, the shape 050 constrains ---------
-- 050 adds a UNIQUE index on (account_id, lower(code)). On an empty
-- database that index is free; the only way it can fail is against rows
-- that already exist, which is what this job is for.
--
-- Distinct codes, because production is ASSUMED to have distinct codes —
-- and the assumption is exactly what APPLY-050.sql's first step makes
-- Boss check by hand. Seeding a duplicate here would assert that the
-- release breaks, which is not the claim.
INSERT INTO centres (id, account_id, name, code)
VALUES
  ('77777777-0000-0000-0000-000000000001', (SELECT id FROM seed_zone),
   'Batu Caves', 'batucaves'),
  -- Mixed case on purpose: the index is on lower(code), and a row
  -- written before centres-panel.tsx started lowercasing can look like
  -- this. If the index were on bare `code` this row would pass and a
  -- real collision would slip through.
  ('77777777-0000-0000-0000-000000000002', (SELECT id FROM seed_zone),
   'Rawang', 'Rawang')
ON CONFLICT (id) DO NOTHING;

-- ---- presence from the one-row-per-user era ------------------
-- 045 must fold this onto the synthetic 'legacy' tab rather than
-- failing on the primary-key swap.
INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
        (SELECT id FROM seed_zone), 'online', NOW())
ON CONFLICT DO NOTHING;
