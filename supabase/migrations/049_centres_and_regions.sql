-- ============================================================
-- 049_centres_and_regions
--
-- Make a centre a thing, instead of a side-effect of a phone number.
--
-- Why
-- ---
-- Until now this codebase had no notion of a centre. There is no
-- `centres` table -- check the other 36. What looked like one was
-- `whatsapp_config.label`, a text field on a WhatsApp number row, and
-- docs/zones.md says it plainly: "A centre is a `whatsapp_config` row
-- within it -- one WhatsApp number each."
--
-- That held while every branch answered on its own number. The number
-- a message arrived on WAS the branch: resolved by Meta, free, and
-- impossible for staff to forget or mistype.
--
-- Minda Optima has now decided the CRM answers on ONE number. The 16
-- branch handsets stay exactly as they are, outside the API, because
-- Cloud API cannot carry group chats and coexistence is closed to a
-- direct business. So the signal that used to identify a centre is
-- gone: every parent arrives on the same number, and nothing in this
-- schema can say which centre they belong to.
--
-- Centre has to become data the app owns, not a property of a phone
-- line it happens to rent.
--
-- What this does
-- --------------
--   1. `regions`  -- a business grouping of centres. NOT a tenancy
--      boundary; see the naming note below.
--   2. `centres`  -- name, region, address, the branch's own phone,
--      operating hours, active flag.
--   3. `contacts.centre_id` -- which centre this parent belongs to.
--      This is the column that survives the number model changing.
--   4. `whatsapp_config.centre_id` -- OPTIONAL link from a number to a
--      centre. Null under the one-number model. If per-branch numbers
--      are ever connected, this is the bridge: inbound can set
--      `contacts.centre_id` from the number again, automatically.
--
-- The point of 3 and 4 together is that the model stays correct
-- whether the account holds one number, four, or sixteen. Only the
-- SOURCE of centre_id changes -- a bot question, or the number itself.
-- Nothing downstream has to be rewritten when that changes.
--
-- Naming: "region", not "zone"
-- ----------------------------
-- "Zone" is already taken here, and it means something dangerous.
-- docs/zones.md defines a zone as a Supabase ACCOUNT: a hard tenancy
-- wall enforced by ~119 RLS policies through is_account_member(),
-- fail-closed by design.
--
-- What the business calls a "zon" is not that. It is a label over
-- centres so HQ can group them on one page. Giving it the same word
-- invites someone to mistake a grouping for a security boundary,
-- which is the most expensive mistake available in this codebase. So
-- the table is `regions` and the UI says "Zon".
--
-- Nothing here touches account-level zones, migration 044, or any
-- existing policy.
--
-- Access
-- ------
-- Centres and regions are settings-class, like `tags`: everyone in
-- the account reads them, only an admin changes them. Assigning a
-- PARENT to a centre is data-class and rides on the existing
-- `contacts` policies (agent), which this migration does not alter.
-- ============================================================

-- ---- regions ------------------------------------------------

CREATE TABLE IF NOT EXISTS regions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness. "Zon Utara" and "zon utara" are the
-- same zone to a human, and two of them on a page is a support call.
CREATE UNIQUE INDEX IF NOT EXISTS idx_regions_account_name
  ON regions(account_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_regions_account ON regions(account_id);

ALTER TABLE regions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS regions_select ON regions;
DROP POLICY IF EXISTS regions_insert ON regions;
DROP POLICY IF EXISTS regions_update ON regions;
DROP POLICY IF EXISTS regions_delete ON regions;
CREATE POLICY regions_select ON regions FOR SELECT USING (is_account_member(account_id));
CREATE POLICY regions_insert ON regions FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY regions_update ON regions FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY regions_delete ON regions FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON regions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON regions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- centres ------------------------------------------------

CREATE TABLE IF NOT EXISTS centres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- A centre may sit outside any region (a new branch not yet placed).
  -- Deleting a region must not delete its centres.
  region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  code TEXT,
  address TEXT,
  -- The branch's OWN phone/WhatsApp. Not a Cloud API number -- this is
  -- the handset staff still answer on, kept here so HQ can escalate to
  -- the branch and so a parent can be given the local number.
  phone TEXT,
  operating_hours TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_centres_account_name
  ON centres(account_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_centres_account ON centres(account_id);
CREATE INDEX IF NOT EXISTS idx_centres_region ON centres(region_id);

ALTER TABLE centres ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS centres_select ON centres;
DROP POLICY IF EXISTS centres_insert ON centres;
DROP POLICY IF EXISTS centres_update ON centres;
DROP POLICY IF EXISTS centres_delete ON centres;
CREATE POLICY centres_select ON centres FOR SELECT USING (is_account_member(account_id));
CREATE POLICY centres_insert ON centres FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY centres_update ON centres FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY centres_delete ON centres FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON centres;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON centres
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- the two links ------------------------------------------

-- Which centre this parent belongs to. ON DELETE SET NULL: closing a
-- centre must never delete a parent record.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS centre_id UUID REFERENCES centres(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_centre ON contacts(centre_id);

-- Optional: which centre a WhatsApp number answers for. Null under the
-- one-number model. This is the bridge back to automatic routing if
-- per-branch numbers are ever connected -- it does NOT replace
-- contacts.centre_id, it feeds it.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS centre_id UUID REFERENCES centres(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_centre ON whatsapp_config(centre_id);

COMMENT ON TABLE regions IS
  'Business grouping of centres ("Zon" in the UI). NOT a tenancy boundary -- account-level zones are a different concept, see docs/zones.md.';
COMMENT ON TABLE centres IS
  'A Minda Optima branch. Owned as data, not derived from a WhatsApp number.';
COMMENT ON COLUMN contacts.centre_id IS
  'Which centre this parent belongs to. Survives changes to the WhatsApp number model.';
COMMENT ON COLUMN whatsapp_config.centre_id IS
  'Optional: the centre this number answers for. Null under the one-number model.';

-- Rollback, if ever needed:
--   ALTER TABLE whatsapp_config DROP COLUMN IF EXISTS centre_id;
--   ALTER TABLE contacts DROP COLUMN IF EXISTS centre_id;
--   DROP TABLE IF EXISTS centres;
--   DROP TABLE IF EXISTS regions;
