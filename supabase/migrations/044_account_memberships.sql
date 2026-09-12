-- ============================================================
-- 044_account_memberships — HQ multi-zone access
--
-- Why
-- ---
-- PTMO is splitting into zones (A, B, C, D), one account each.
-- Zone staff must see only their own zone. A handful of HQ people
-- must be able to move between zones and answer any of them.
--
-- Today that is impossible: a user's account lives in a single
-- column, `profiles.account_id`, and `accounts` carries a
-- UNIQUE(owner_user_id) index, so one login belongs to exactly one
-- account forever.
--
-- Design
-- ------
-- The single column is doing two jobs at once. Split them:
--
--   WHICH ZONES MAY I ENTER   -> account_members (new, durable)
--   WHICH ZONE AM I IN NOW    -> profiles.account_id (reused)
--
-- `is_account_member()` keeps meaning "my ACTIVE zone". Its body
-- now reads the role from account_members, but the condition
-- `p.account_id = target_account_id` stays. That single decision is
-- what makes this migration safe:
--
--   * All 119 RLS policies across the schema call this one function.
--     None of them change. None of them need review.
--   * RLS stays FAIL-CLOSED. An HQ user who is a member of four
--     zones but active in Zone A cannot read Zone B, at the database
--     level, no matter what the application asks for.
--
-- That last property is load-bearing. The app has ~41 client-side
-- Supabase mutations and the entire ops board that carry no
-- account_id filter at all and lean on RLS alone for tenancy. Had we
-- widened RLS to "any zone I belong to" and re-narrowed in the
-- application, every one of those sites would leak across zones on
-- the first missed filter. Widening is not recoverable by review;
-- staying fail-closed needs no review.
--
-- Cross-zone reads (the HQ roll-up dashboard) are therefore NOT
-- served by these policies. They go through purpose-built
-- SECURITY DEFINER RPCs that return aggregates only — a narrow,
-- auditable surface rather than a blanket relaxation. See 045.
--
-- Switching zones is one RPC that rewrites profiles.account_id.
-- It is allowed to do so because `enforce_profile_privilege_columns`
-- (034) only blocks the write when `current_user = 'authenticated'`;
-- a SECURITY DEFINER function owned by postgres runs as postgres.
-- This is the same escape hatch the 018/019 RPCs already use.
--
-- Ownership
-- ---------
-- UNIQUE(owner_user_id) is dropped. One person owning all four zones
-- is the intended operating model, and recovery depends on it: if a
-- zone lead loses access, the owner is the only one who can restore
-- it. This is a deliberate divergence from upstream wacrm — expect a
-- conflict here when merging upstream, and keep this reasoning.
--
-- Idempotent — safe to re-run.
--
-- Rollback
-- --------
--   DROP FUNCTION IF EXISTS my_accounts();
--   DROP FUNCTION IF EXISTS set_active_account(UUID);
--   DROP FUNCTION IF EXISTS is_account_member_any(UUID, account_role_enum);
--   -- restore the 017 body of is_account_member() (reads
--   -- profiles.account_role directly), then:
--   DROP TABLE IF EXISTS account_members;
--   CREATE UNIQUE INDEX idx_accounts_one_per_owner ON accounts(owner_user_id);
--   -- 018/019 bodies must be restored from their own migrations.
-- Note: rolling back after any user has joined a second zone will
-- strip that access. profiles.account_id keeps whichever zone they
-- were last active in.
-- ============================================================

-- ============================================================
-- 1. ROLE RANK HELPER
--
-- 017 inlines this CASE expression in is_account_member, and
-- src/lib/auth/roles.ts mirrors it in TypeScript. Now that three
-- functions need it, give it a name so the ordinal is defined once.
-- IMMUTABLE: the mapping is a constant, so it is safe in indexes
-- and inlines into policy plans.
-- ============================================================
CREATE OR REPLACE FUNCTION public.account_role_rank(r account_role_enum)
RETURNS INT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE r
           WHEN 'owner'  THEN 4
           WHEN 'admin'  THEN 3
           WHEN 'agent'  THEN 2
           WHEN 'viewer' THEN 1
         END;
$$;

ALTER FUNCTION public.account_role_rank(account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.account_role_rank(account_role_enum)
  TO authenticated, service_role;

-- ============================================================
-- 2. MEMBERSHIP TABLE
--
-- The durable "may enter" list. One row per (user, zone).
-- Composite PK rather than a surrogate id: the pair IS the
-- identity, and it gives the uniqueness constraint for free.
-- ============================================================
CREATE TABLE IF NOT EXISTS account_members (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id)   ON DELETE CASCADE,
  role       account_role_enum NOT NULL DEFAULT 'agent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, account_id)
);

COMMENT ON TABLE account_members IS
  'Which zones a user may enter, and their role in each. The durable '
  'grant. Distinct from profiles.account_id, which is the single zone '
  'the user is looking at right now.';

-- The PK already covers (user_id, …), which serves the zone
-- switcher's "list my zones". This index serves the other
-- direction: the member list for one zone.
CREATE INDEX IF NOT EXISTS idx_account_members_account
  ON account_members (account_id, role);

ALTER TABLE account_members ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. BACKFILL
--
-- Every existing profile becomes its own membership row, so the
-- pre-migration world is valid the moment this lands. Nobody's
-- access changes: each user is a member of exactly the one account
-- they were already in, with the role they already had.
-- ============================================================
INSERT INTO account_members (user_id, account_id, role)
SELECT p.user_id, p.account_id, p.account_role
FROM profiles p
WHERE p.account_id IS NOT NULL
  AND p.account_role IS NOT NULL
ON CONFLICT (user_id, account_id) DO NOTHING;

-- ============================================================
-- 4. DROP THE ONE-ACCOUNT-PER-OWNER CONSTRAINT
--
-- This index is the schema-level assertion that a person cannot own
-- two accounts. Removing it is the whole point. Note that the
-- accounts.owner_user_id column stays — it is still the fast "who
-- owns this zone" lookup and transfer_account_ownership still
-- maintains it.
-- ============================================================
DROP INDEX IF EXISTS idx_accounts_one_per_owner;

-- Non-unique replacement: "which zones does this person own" is
-- still asked (recovery, the owner badge), it just is not unique.
CREATE INDEX IF NOT EXISTS idx_accounts_owner
  ON accounts (owner_user_id);

-- ============================================================
-- 5. THE MEMBERSHIP HELPER, REDEFINED
--
-- Same signature as 017, so every existing policy keeps working
-- untouched. Two changes to the body:
--
--   * the role now comes from account_members, not profiles
--   * the active-zone condition (p.account_id = target) REMAINS
--
-- Keeping that condition is what holds RLS fail-closed. Do not
-- "fix" it to allow any membership — that would silently open every
-- unfiltered query in the application to every zone at once.
-- ============================================================
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- STOP. Before you change the line marked ACTIVE ZONE below.
  --
  -- It looks redundant: we already joined account_members, so why
  -- also require that the target IS the user's current account?
  -- Because that line is the only thing standing between this
  -- application and a total cross-zone data leak.
  --
  -- Roughly 119 RLS policies call this function, and large parts of
  -- the app query their tables with NO account_id filter at all --
  -- ~41 client-side mutations, all of src/lib/ops/, and
  -- src/lib/dashboard/queries.ts. They are correct today only
  -- because this function narrows them to one account.
  --
  -- Drop the ACTIVE ZONE line and every one of those silently starts
  -- returning rows from every zone the user belongs to. Nothing
  -- fails. No test goes red. Zone A staff simply begin seeing Zone B
  -- parents.
  --
  -- If you need "is this user a member of that zone, whichever zone
  -- they are looking at now", that function already exists and is
  -- called is_account_member_any(). Use it. Never in a CREATE POLICY.
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    JOIN account_members m
      ON m.user_id = p.user_id
     AND m.account_id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id   -- ACTIVE ZONE -- see above
      AND account_role_rank(m.role) >= account_role_rank(min_role)
  );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum)
  TO authenticated, service_role;

-- ============================================================
-- 6. THE CROSS-ZONE HELPER
--
-- "Am I a member of this zone, regardless of which one I am looking
-- at?" Needed by exactly two things: the zone switcher (may I move
-- here?) and the HQ roll-up RPCs (may I count this zone?).
--
-- DO NOT use this in a table policy. Every table policy must stay on
-- is_account_member() so that unfiltered application queries cannot
-- reach across zones. If you find yourself reaching for this inside
-- a CREATE POLICY, the design has been misread.
-- ============================================================
CREATE OR REPLACE FUNCTION is_account_member_any(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM account_members m
    WHERE m.user_id = auth.uid()
      AND m.account_id = target_account_id
      AND account_role_rank(m.role) >= account_role_rank(min_role)
  );
$$;

ALTER FUNCTION is_account_member_any(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member_any(UUID, account_role_enum)
  TO authenticated, service_role;

-- ============================================================
-- 7. RLS ON account_members
--
-- Reads: your own rows from every zone (the switcher needs the full
-- list while you are active in only one), plus the full roster of
-- whichever zone you are currently in.
--
-- Writes: none from the client. Membership changes go through the
-- 018/019 RPCs, mirroring how account_role was already protected.
-- No recursion risk: is_account_member is SECURITY DEFINER and so
-- reads account_members with RLS bypassed.
-- ============================================================
DROP POLICY IF EXISTS account_members_select ON account_members;
CREATE POLICY account_members_select ON account_members FOR SELECT
  USING (
    user_id = auth.uid()
    OR is_account_member(account_id)
  );

-- ============================================================
-- 8. SWITCH ACTIVE ZONE
--
-- Validates membership, then repoints profiles.account_id and
-- refreshes the cached profiles.account_role to match the role held
-- in the destination zone.
--
-- account_role on profiles is now a cache of account_members.role
-- for the active zone. It is kept because getCurrentAccount(),
-- use-auth and touch_presence all read it; keeping it in sync here
-- means none of them change.
--
-- Returns the destination so the client can update without a
-- second round trip.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_active_account(
  p_account_id UUID
) RETURNS TABLE (account_id UUID, name TEXT, role account_role_enum)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_role
  FROM account_members m
  WHERE m.user_id = auth.uid()
    AND m.account_id = p_account_id;

  IF v_role IS NULL THEN
    -- Deliberately the same message whether the zone does not exist
    -- or the caller simply is not in it: a probe must not be able to
    -- enumerate zone ids.
    RAISE EXCEPTION 'You are not a member of that zone'
      USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
  SET account_id = p_account_id,
      account_role = v_role
  WHERE user_id = auth.uid();

  RETURN QUERY
  SELECT a.id, a.name, v_role
  FROM accounts a
  WHERE a.id = p_account_id;
END;
$$;

ALTER FUNCTION public.set_active_account(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_active_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_active_account(UUID) TO authenticated;

-- ============================================================
-- 9. LIST MY ZONES
--
-- Feeds the header switcher. Ordered by name so the list does not
-- reshuffle between loads.
-- ============================================================
CREATE OR REPLACE FUNCTION public.my_accounts()
RETURNS TABLE (
  account_id UUID,
  name TEXT,
  role account_role_enum,
  is_active BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id,
         a.name,
         m.role,
         (a.id = p.account_id) AS is_active
  FROM account_members m
  JOIN accounts a ON a.id = m.account_id
  JOIN profiles p ON p.user_id = m.user_id
  WHERE m.user_id = auth.uid()
  ORDER BY a.name;
$$;

ALTER FUNCTION public.my_accounts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.my_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_accounts() TO authenticated;

-- ============================================================
-- 10. SIGNUP TRIGGER — also record the membership
--
-- Same shape as 017's version, plus the account_members row. A new
-- user still gets exactly one zone, owned by them; they simply now
-- have an explicit membership row to go with it.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  INSERT INTO public.account_members (user_id, account_id, role)
  VALUES (NEW.id, v_account_id, 'owner')
  ON CONFLICT (user_id, account_id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- ============================================================
-- 11. MEMBER RPCs — write memberships, not profile columns
--
-- These three keep their 018 contracts exactly (same signatures,
-- same SQLSTATEs, same messages) so no API route or UI changes.
-- What moves is the storage: account_members is now the source of
-- truth, and profiles.account_role is updated only as the cache for
-- whichever zone the target is currently sitting in.
-- ============================================================

-- ------------------------------------------------------------
-- set_member_role — admin+ changes a member's role in the zone the
-- CALLER is active in. Scoping to the caller's active zone (rather
-- than the target's) is what stops an HQ admin from reaching into a
-- zone they are not currently in.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, m.role
  INTO v_caller_account_id, v_caller_role
  FROM profiles p
  LEFT JOIN account_members m
    ON m.user_id = p.user_id AND m.account_id = p.account_id
  WHERE p.user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role'
      USING ERRCODE = '22023';
  END IF;

  SELECT m.role INTO v_target_role
  FROM account_members m
  WHERE m.user_id = p_user_id
    AND m.account_id = v_caller_account_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  UPDATE account_members
  SET role = p_new_role
  WHERE user_id = p_user_id
    AND account_id = v_caller_account_id;

  -- Refresh the cached copy only if the target is currently sitting
  -- in this zone; if they are active elsewhere, their cache belongs
  -- to that other zone and must not be touched.
  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id
    AND account_id = v_caller_account_id;
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

-- ------------------------------------------------------------
-- remove_account_member — revoke one zone, not the user's whole
-- existence. Now that a person can hold several zones, removal
-- deletes just this membership.
--
-- If that was the zone they were sitting in, they must land
-- somewhere: another zone they still hold, or failing that a fresh
-- personal account, which is 018's original behaviour.
--
-- Returns the account the target ended up in, preserving 018's
-- return contract.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
  v_target_active UUID;
  v_target_name TEXT;
  v_target_email TEXT;
  v_landing_id UUID;
  v_landing_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, m.role
  INTO v_caller_account_id, v_caller_role
  FROM profiles p
  LEFT JOIN account_members m
    ON m.user_id = p.user_id AND m.account_id = p.account_id
  WHERE p.user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT m.role INTO v_target_role
  FROM account_members m
  WHERE m.user_id = p_user_id
    AND m.account_id = v_caller_account_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, p.full_name, p.email
  INTO v_target_active, v_target_name, v_target_email
  FROM profiles p
  WHERE p.user_id = p_user_id;

  DELETE FROM account_members
  WHERE user_id = p_user_id
    AND account_id = v_caller_account_id;

  -- Still parked elsewhere? Nothing further to do.
  IF v_target_active IS DISTINCT FROM v_caller_account_id THEN
    RETURN v_target_active;
  END IF;

  -- They were sitting in the zone we just revoked. Prefer any zone
  -- they still hold; oldest first, so they land somewhere familiar.
  SELECT m.account_id, m.role
  INTO v_landing_id, v_landing_role
  FROM account_members m
  WHERE m.user_id = p_user_id
  ORDER BY m.created_at
  LIMIT 1;

  IF v_landing_id IS NULL THEN
    -- No zones left. Mirror handle_new_user: give them an empty
    -- personal account so their login keeps working.
    INSERT INTO accounts (name, owner_user_id)
    VALUES (
      COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
      p_user_id
    )
    RETURNING id INTO v_landing_id;

    v_landing_role := 'owner';

    INSERT INTO account_members (user_id, account_id, role)
    VALUES (p_user_id, v_landing_id, 'owner')
    ON CONFLICT (user_id, account_id) DO NOTHING;
  END IF;

  UPDATE profiles
  SET account_id = v_landing_id,
      account_role = v_landing_role
  WHERE user_id = p_user_id;

  RETURN v_landing_id;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

-- ------------------------------------------------------------
-- transfer_account_ownership — unchanged contract; writes
-- memberships and keeps the profile caches of both parties in sync,
-- but only where each is actually sitting.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_new_owner_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, m.role
  INTO v_caller_account_id, v_caller_role
  FROM profiles p
  LEFT JOIN account_members m
    ON m.user_id = p.user_id AND m.account_id = p.account_id
  WHERE p.user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner'
      USING ERRCODE = '22023';
  END IF;

  SELECT m.role INTO v_target_role
  FROM account_members m
  WHERE m.user_id = p_new_owner_user_id
    AND m.account_id = v_caller_account_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Demote first so a zero-owner state is never visible; both
  -- writes share this function's transaction.
  UPDATE account_members SET role = 'admin'
  WHERE user_id = auth.uid() AND account_id = v_caller_account_id;

  UPDATE account_members SET role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;

  UPDATE profiles SET account_role = 'admin'
  WHERE user_id = auth.uid() AND account_id = v_caller_account_id;

  UPDATE profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;

  UPDATE accounts SET owner_user_id = p_new_owner_user_id
  WHERE id = v_caller_account_id;
END;
$$;

ALTER FUNCTION public.transfer_account_ownership(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) TO authenticated;

-- ============================================================
-- 12. REDEEM INVITATION — grant a zone instead of moving between them
--
-- 019 had to MOVE the profile, because holding two accounts was
-- impossible. All those guards ("you are already in a shared
-- account", "your account already contains data") existed to stop a
-- user silently orphaning one account by joining another. With
-- memberships, joining is additive and none of that can happen.
--
-- This is also how HQ gets its zones: invite the HQ user into each
-- zone as 'agent' and they accumulate memberships.
--
-- One behaviour is preserved deliberately. A brand-new signup
-- arrives holding an empty personal account they did not ask for.
-- If that is all they have, joining a real zone should still clean
-- it up, or every new teammate ends up staring at a pointless
-- two-entry zone switcher. So: tidy it away when it is theirs,
-- empty, and their only one — otherwise leave every zone alone.
--
-- Still returns the joined account_id.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_membership_count INT;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM account_members
    WHERE user_id = v_caller_id AND account_id = v_inv.account_id
  ) THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Grant the zone and make it the one they are looking at, so the
  -- invite link lands them where they expect.
  INSERT INTO account_members (user_id, account_id, role)
  VALUES (v_caller_id, v_inv.account_id, v_inv.role)
  ON CONFLICT (user_id, account_id) DO NOTHING;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Housekeeping: drop the throwaway personal account, but only when
  -- it is unambiguously throwaway.
  SELECT COUNT(*) INTO v_membership_count
  FROM account_members
  WHERE user_id = v_caller_id;

  IF v_membership_count = 2 AND v_old_account_owner = v_caller_id THEN
    SELECT EXISTS (
      SELECT 1 FROM contacts WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
      UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
      LIMIT 1
    ) INTO v_has_data;

    IF NOT v_has_data AND NOT EXISTS (
      SELECT 1 FROM account_members
      WHERE account_id = v_old_account_id
        AND user_id <> v_caller_id
    ) THEN
      -- Cascades the caller's membership row with it.
      DELETE FROM accounts WHERE id = v_old_account_id;
    END IF;
  END IF;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
