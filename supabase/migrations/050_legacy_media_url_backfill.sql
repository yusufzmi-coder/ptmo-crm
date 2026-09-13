-- ============================================================
-- 050_legacy_media_url_backfill
--
-- Rewrite pre-047 attachment links so they still resolve.
--
-- Why
-- ---
-- Migration 047 flips `chat-media`, `flow-media` and `avatars` to
-- private. It says so in its own header: `getPublicUrl()` keeps
-- returning a string, but that string now 400s.
--
-- What 047 does not say is that the strings were PERSISTED.
-- `messages.media_url` holds whatever the uploader returned at the time
-- (webhook/route.ts:714), so every attachment sent or mirrored before
-- this release is stored as
--
--   https://<project>.supabase.co/storage/v1/object/public/chat-media/
--     account-<uuid>/<file>
--
-- The moment 047 commits, every one of those rows points at a URL the
-- storage API refuses. The bytes are still there and still correct —
-- only the pointer is dead. Nothing in 047 repairs them, and the reader
-- added alongside it (`parseMediaProxyPath`) deliberately returns null
-- for a value that is not one of the new pointers, so the application
-- renders "unavailable" rather than a broken image.
--
-- That is a silent, permanent loss of visible history: a parent's ID
-- photo, a receipt, a medical letter, all still in the bucket and none
-- of them openable. It is not acceptable for a release whose whole
-- purpose is to make the data safer.
--
-- What this does
-- --------------
-- Rewrites the stored value from the dead public URL to the pointer the
-- proxy route serves:
--
--   https://<host>/storage/v1/object/public/chat-media/account-x/a.jpg
--   ->  /api/media/chat-media/account-x/a.jpg
--
-- Nothing is deleted, no object moves, and no new access is granted:
-- `/api/media/...` is the authenticated route from 047, which checks the
-- caller's account and then signs through their own RLS client. A row
-- rewritten here is readable by exactly the people 047 intended and
-- nobody else.
--
-- Why the substring is safe
-- -------------------------
-- The stored URL is already percent-encoded segment by segment, because
-- that is what `getPublicUrl()` produces. `mediaProxyPath()` produces the
-- same encoding. So taking everything after `/object/public/` and giving
-- it the `/api/media/` prefix yields a byte-identical pointer to the one
-- the application would write today — a filename with a space or a `#`
-- round-trips unchanged. No decoding happens here, deliberately: this
-- migration moves a prefix, it does not reinterpret a path.
--
-- Scope
-- -----
-- Only the three proxyable buckets, and only rows that actually carry the
-- public-object shape. Deliberately NOT touched:
--
--   * `/api/whatsapp/media/<id>` — the inbound proxy, unaffected by 047.
--   * `/api/media/...`           — already a pointer.
--   * any other absolute URL     — `POST /api/v1/messages` lets a caller
--     supply their own `media_url`, and a template header can hold a
--     plain link. Those are the operator's URLs, they never lived in our
--     buckets, and rewriting them would break the feature.
--
-- Belt and braces
-- ---------------
-- `src/lib/media/proxy-url.ts:resolveStoredMediaUrl()` performs the same
-- mapping at render time. This migration is not load-bearing on its own:
-- a row inserted by an old build during the deploy window, or one
-- restored from a backup taken before the release, still renders. The
-- migration exists so the stored data is correct rather than merely
-- displayable, and so a future reader does not have to know the history.
--
-- Ordering
-- --------
-- After 047, and it does not matter how long after. Running it before
-- 047 would be harmless but pointless. It is separated from 047 rather
-- than folded into it because 047 is a security fix that should be
-- reviewable on its own terms, and because this one writes to a large
-- table and may want to run in its own window.
--
-- Idempotent — safe to re-run. Once rewritten a row no longer matches
-- the WHERE clause.
--
-- Rollback
-- --------
-- There is no automatic reverse: the original host is not recoverable
-- from the rewritten value. If 047 is ever rolled back, the pointers
-- still work — the proxy route serves a public bucket perfectly well —
-- so a rollback of 047 does not require a rollback of this.
-- ============================================================

DO $$
DECLARE
  v_marker   TEXT := '/storage/v1/object/public/';
  v_rewritten INT;
  v_remaining INT;
BEGIN
  -- One statement per bucket rather than a regex over all three: the
  -- bucket name has to be part of the match so that a URL for some other
  -- bucket (a future one, or another project's) is left alone.
  WITH rewritten AS (
    UPDATE messages m
       SET media_url =
             '/api/media/' ||
             substring(m.media_url FROM position(v_marker IN m.media_url) + length(v_marker))
     WHERE m.media_url IS NOT NULL
       AND position(v_marker IN m.media_url) > 0
       AND (
            substring(m.media_url FROM position(v_marker IN m.media_url) + length(v_marker))
              LIKE 'chat-media/%'
         OR substring(m.media_url FROM position(v_marker IN m.media_url) + length(v_marker))
              LIKE 'flow-media/%'
         OR substring(m.media_url FROM position(v_marker IN m.media_url) + length(v_marker))
              LIKE 'avatars/%'
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_rewritten FROM rewritten;

  -- Assert the outcome rather than trusting it: a typo in the marker
  -- would update nothing and report success.
  SELECT count(*) INTO v_remaining
    FROM messages m
   WHERE m.media_url IS NOT NULL
     AND position(v_marker IN m.media_url) > 0
     AND (
          substring(m.media_url FROM position(v_marker IN m.media_url) + length(v_marker))
            LIKE 'chat-media/%'
       OR substring(m.media_url FROM position(v_marker IN m.media_url) + length(v_marker))
            LIKE 'flow-media/%'
       OR substring(m.media_url FROM position(v_marker IN m.media_url) + length(v_marker))
            LIKE 'avatars/%'
     );

  IF v_remaining > 0 THEN
    RAISE EXCEPTION
      '050: % message(s) still hold a public-bucket URL after the rewrite', v_remaining;
  END IF;

  RAISE NOTICE '050: rewrote % legacy media_url row(s) onto the media proxy', v_rewritten;
END
$$;

COMMENT ON COLUMN messages.media_url IS
  'Where the attachment lives. One of: /api/media/<bucket>/<path> (a '
  'stored object, served by the authenticated proxy from 047), '
  '/api/whatsapp/media/<id> (un-mirrored inbound, fetched from Meta on '
  'demand), or an absolute URL supplied by an API caller. Absolute '
  'public-bucket URLs were rewritten to the first form by migration 050.';
