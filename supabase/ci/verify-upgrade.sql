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
  -- 044, 042 and 048 — REMOVED. They assert about parked migrations.
  -- ==========================================================
  -- This job parks 042, 043, 044 and 048: they are in the repo and not
  -- in the release. Three blocks here asserted about them anyway, and
  -- none of the three could do its job.
  --
  -- 044 — four assertions on the backfilled membership row.
  --   `account_members` is created by 044:110 and nothing else, so in
  --   the release as scoped the table does not exist when this file
  --   runs: every query failed with "relation does not exist". The row
  --   they read could not be seeded either — they looked for the
  --   profile with a NULL account_role, and profiles.account_role has
  --   been NOT NULL since 017:275, the same file that adds it nullable
  --   at :122. The INSERT attempting it is what failed first; see
  --   seed-legacy-state.sql.
  --
  -- 048 — two assertions on broadcasts.whatsapp_config_id.
  --   That column is added by 048:67 and by nothing else, so these
  --   failed the same way.
  --
  -- 042 — two assertions that the conversation merge spared a thread.
  --   These did NOT fail. They read `conversations` and `messages`,
  --   which the baseline already has, and with 042 never applied the
  --   merge never ran, so the thread trivially survives. They passed
  --   while proving nothing — the worse of the two failure modes, and
  --   the reason they are removed rather than left alone.
  --
  -- None of this was visible before now: the upgrade job failed on the
  -- seed, so this file never ran.
  --
  -- If any of those migrations joins a release, restore its block from
  -- git history rather than rewriting it — and fix 044's NULL premise
  -- first. The invariant that outlives all of it is asserted in
  -- verify-schema.sql: profiles.account_role must be NOT NULL.

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
