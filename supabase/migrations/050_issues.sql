-- ============================================================
-- 050_issues — the Isu & Tindakan tab, at the database layer
--
-- An issue is a complaint or a problem raised about a parent, a centre,
-- or a thread, tracked from "someone said something" to "we did
-- something about it". Until now the only record of that was the
-- conversation itself, which is not a record: it has no owner, no due
-- date, and no state.
--
-- Two tables. `issues` holds the current state; `issue_events` holds how
-- it got there. They are separate because the second is an audit trail,
-- and an audit trail that shares a row with the thing it audits can be
-- rewritten by the same UPDATE.
--
-- WHAT THIS MIGRATION MAY NOT TOUCH
-- ---------------------------------
-- 042, 043, 044 and 048 are parked: in the repo, not in production, and
-- NOT in the CI baseline. So nothing here may reference
--
--   account_members                   (044)
--   broadcasts.whatsapp_config_id     (048)
--   quick_replies.whatsapp_config_id  (043)
--
-- This matters more than it looks. The clean CI job replays EVERY
-- migration including the parked ones, so a dependency on any of them
-- passes CI and then breaks production, where they do not exist. The
-- upgrade job is the one that would catch it.
--
-- `is_account_member()` below is therefore 017's version — the one
-- running in production — which reads `profiles.account_id` and
-- `profiles.account_role`. Not 044's rewrite.
-- ============================================================

-- ============================================================
-- issues
-- ============================================================
CREATE TABLE IF NOT EXISTS issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- Every link out of an issue is SET NULL, never CASCADE. An issue
  -- outlives the things it points at: closing a branch or deleting a
  -- parent record must not erase the complaint or how it was handled.
  -- That is the whole reason to keep this separately from the thread.
  centre_id UUID REFERENCES centres(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,

  -- Malay values, deliberately. These are chosen by branch staff in a
  -- Malay interface and read back by HQ in reports; a translation layer
  -- between the picker and the row would only add a place to drift.
  category TEXT NOT NULL CHECK (category IN (
    'progress','keselamatan','staf','servis','yuran',
    'jadual','pendaftaran','fasiliti','lain')),
  severity TEXT NOT NULL DEFAULT 'biasa'
    CHECK (severity IN ('biasa','penting','kritikal')),

  -- Status is English because it is a state machine the code branches
  -- on, not a label a person picks. The UI translates it.
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new','acknowledged','investigating','waiting',
    'resolution_proposed','resolved','reopened')),

  -- profiles(user_id) carries UNIQUE(user_id) from 001:22, so it is a
  -- valid FK target. Checked rather than assumed: a foreign key onto a
  -- non-unique column fails at apply time, inside the release
  -- transaction, taking everything else with it.
  assigned_to UUID REFERENCES profiles(user_id) ON DELETE SET NULL,
  opened_by UUID REFERENCES profiles(user_id) ON DELETE SET NULL,

  summary TEXT NOT NULL,
  resolution TEXT,

  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The three queries the tab actually makes: the open list for a zone,
-- the same list narrowed to one branch, and "does this thread already
-- have an issue" when the composer offers to raise one.
CREATE INDEX IF NOT EXISTS idx_issues_account_status ON issues(account_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_account_centre ON issues(account_id, centre_id);
CREATE INDEX IF NOT EXISTS idx_issues_conversation ON issues(conversation_id);
CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to);

ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS issues_select ON issues;
DROP POLICY IF EXISTS issues_insert ON issues;
DROP POLICY IF EXISTS issues_update ON issues;
DROP POLICY IF EXISTS issues_delete ON issues;

-- Data-class policies, copied line for line from 049's centres block.
--
-- No `TO <role>` clause: zero of the 169 CREATE POLICY statements in
-- this repo use one, because the role requirement is carried by
-- is_account_member()'s second argument instead. A second pattern for
-- the same job is how one of them ends up wrong.
--
-- Raising an issue is agent work — branch staff do it from the thread.
-- Deleting one is admin work, because a deleted complaint leaves no
-- trace that it existed.
CREATE POLICY issues_select ON issues FOR SELECT USING (is_account_member(account_id));
CREATE POLICY issues_insert ON issues FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY issues_update ON issues FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY issues_delete ON issues FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON issues;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON issues
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- issue_events — how the issue got to where it is
-- ============================================================
CREATE TABLE IF NOT EXISTS issue_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE here, unlike everything above: an event about a deleted
  -- issue has nothing left to describe.
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,

  -- Denormalised so the RLS policy is a function call on a local column
  -- rather than a join back to issues. A policy that joins runs for
  -- every candidate row of every query against this table.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  actor_user_id UUID REFERENCES profiles(user_id) ON DELETE SET NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id, created_at);

ALTER TABLE issue_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS issue_events_select ON issue_events;
DROP POLICY IF EXISTS issue_events_insert ON issue_events;
DROP POLICY IF EXISTS issue_events_delete ON issue_events;

-- No UPDATE policy, and its absence is the point: RLS denies what it
-- does not permit, so there is no statement that can edit an event. An
-- audit trail that can be edited is not an audit trail. Correcting a
-- mistake means appending another event, which is what a trail is for.
--
-- DELETE stays admin-only for the same reason it exists on issues:
-- account deletion needs a route, and nothing else should have one.
CREATE POLICY issue_events_select ON issue_events FOR SELECT USING (is_account_member(account_id));
CREATE POLICY issue_events_insert ON issue_events FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY issue_events_delete ON issue_events FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- centres.code — the unique index that was only ever in JavaScript
-- ============================================================
-- `code` is the keyword a parent sends to reach a branch. Uniqueness is
-- enforced today in centres-panel.tsx:259, by searching a list already
-- loaded into the browser — so two people saving at once, or any write
-- that does not go through that screen, can produce a duplicate.
--
-- A duplicate means one keyword matches two branches, and a parent's
-- message tags THE WRONG BRANCH. That is the failure the WhatsApp
-- keyword routing depends on not happening.
--
-- `lower(code)` because the panel lowercases before saving and compares
-- lowercased; rows written before that, or by anything else, may not be.
--
-- `code <> ''` as well as NOT NULL, and this is not defensive noise:
-- isValidCode() rejects the empty string, so the UI cannot produce one —
-- but the COLUMN allows it and older rows or API writes may hold it.
-- Two branches with no keyword would then collide on a constraint meant
-- to be about keywords. Empty and NULL both mean "no code" and both sit
-- outside the index.
--
-- THIS CAN FAIL LOUDLY, BY DESIGN. If duplicates already exist the index
-- cannot be created and the whole apply transaction rolls back. Run the
-- check query in APPLY-050.sql FIRST.
CREATE UNIQUE INDEX IF NOT EXISTS idx_centres_account_code
  ON centres(account_id, lower(code))
  WHERE code IS NOT NULL AND code <> '';
