// ============================================================
// Zones — the data layer behind the HQ zone switcher.
//
// A zone IS an account (docs/zones.md). Two questions, two homes:
//
//   which zones may I enter?   account_members, read via my_accounts()
//   which am I looking at?     profiles.account_id, written via
//                              set_active_account()
//
// Both are SECURITY DEFINER RPCs from migration 044, and both are the
// ONLY sanctioned way to answer those questions from the client. In
// particular nothing here selects from `account_members` directly: the
// zone model is fail-closed, `is_account_member()` narrows every other
// query to the ACTIVE zone, and a client-side read that saw more than
// one zone at a time would be the first crack in that.
//
// This module is deliberately free of React so the rules below can be
// tested without a DOM. The hook (`use-zones`) and the header component
// are thin wrappers over it.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isAccountRole, type AccountRole } from "./roles";

/** One zone the signed-in user may enter. */
export interface Zone {
  id: string;
  name: string;
  /** The caller's role IN THAT ZONE — it can differ per zone. */
  role: AccountRole | null;
  /** True for the zone `profiles.account_id` currently points at. */
  isActive: boolean;
}

/** Row shape `my_accounts()` returns. */
interface MyAccountsRow {
  account_id: string;
  name: string | null;
  role: string | null;
  is_active: boolean | null;
}

/**
 * Postgres raises 42501 (insufficient_privilege) for both "you are not a
 * member" and "no session". 044 deliberately uses the same message for a
 * zone that does not exist and one the caller is not in, so a probe
 * cannot enumerate zone ids — we keep that indistinguishable here too.
 */
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * PostgREST's code for "no function matches that name in the schema
 * cache". Postgres itself reports `42883` for an undefined function; the
 * REST layer answers 404 with this instead, so both are treated as the
 * same thing: 044 has not been applied here.
 */
const FUNCTION_NOT_FOUND = new Set(["PGRST202", "42883"]);

/** Whether an RPC error means the function itself is absent. */
function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code !== undefined && FUNCTION_NOT_FOUND.has(error.code);
}

export type ZoneFailure =
  /** The caller may not enter that zone (or it does not exist). */
  | "not_member"
  /**
   * The zone feature is not provisioned on this database: `my_accounts()`
   * does not exist because migration 044 has not been applied.
   *
   * This is a deployment state, not a fault. It is kept separate from
   * `failed` so the UI can stay quiet about it — a build that ships ahead
   * of its migration would otherwise log an error on every page load and
   * bury the errors that do matter.
   */
  | "unavailable"
  /** Anything else: network, RLS surprise. */
  | "failed";

export type ZonesResult =
  | { ok: true; zones: Zone[] }
  | { ok: false; reason: ZoneFailure };

export type SwitchResult =
  | { ok: true; zone: Zone }
  | { ok: false; reason: ZoneFailure };

/**
 * Normalise a `my_accounts()` row set.
 *
 * A row with no id is dropped rather than rendered as a nameless entry
 * that cannot be switched to. A row whose role is not one we know keeps
 * its place in the list with a null role — the user can still enter the
 * zone, and every UI gate treats a null role as least-privileged.
 */
export function parseZones(rows: unknown): Zone[] {
  if (!Array.isArray(rows)) return [];
  const out: Zone[] = [];
  for (const raw of rows as MyAccountsRow[]) {
    const id = raw?.account_id;
    if (typeof id !== "string" || !id) continue;
    out.push({
      id,
      // `accounts.name` is NOT NULL, but a zone that somehow has none is
      // better shown by id than as an empty button.
      name: raw.name?.trim() || id,
      role: isAccountRole(raw.role) ? raw.role : null,
      isActive: raw.is_active === true,
    });
  }
  return out;
}

/**
 * Does this user get a switcher at all?
 *
 * One zone is the normal staff case and gets a plain label — a dropdown
 * whose only entry is the thing already selected reads as a control that
 * does nothing, and invites a click that cannot help.
 */
export function shouldShowSwitcher(zones: Zone[]): boolean {
  return zones.length > 1;
}

/** The zone currently active, when the list knows which one that is. */
export function activeZone(zones: Zone[]): Zone | null {
  return zones.find((z) => z.isActive) ?? null;
}

/**
 * What the header shows as the current zone.
 *
 * `my_accounts()` is the better source because it carries `is_active`
 * straight from `profiles.account_id`, but it lands a moment after the
 * profile does. `fallbackName` (the account name `useAuth` already has)
 * covers that gap so the header never flashes an empty zone.
 */
export function currentZoneName(
  zones: Zone[],
  fallbackName: string | null | undefined,
): string | null {
  return activeZone(zones)?.name ?? fallbackName?.trim() ?? null;
}

/** Read the zones this user may enter. */
export async function fetchZones(db: SupabaseClient): Promise<ZonesResult> {
  const { data, error } = await db.rpc("my_accounts");
  if (error) {
    // A missing function is not a failure to report — it means this
    // database has no zone feature yet. Say so quietly; the switcher
    // already hides itself when there is nothing to switch between.
    if (isMissingFunction(error)) return { ok: false, reason: "unavailable" };
    console.error("[zones] my_accounts failed:", error.message);
    return { ok: false, reason: "failed" };
  }
  return { ok: true, zones: parseZones(data) };
}

/**
 * Move the caller into `zoneId`.
 *
 * On success the caller's `profiles.account_id` now points elsewhere,
 * which is what every RLS policy reads — so from the next query onward
 * the database serves a different zone's rows. Everything the client
 * already holds is stale at that instant, which is the switcher's real
 * job to deal with; see `use-zones`.
 *
 * On failure nothing moved. The caller stays exactly where they were,
 * and that is the guarantee the UI leans on to keep the user in place.
 */
export async function switchActiveZone(
  db: SupabaseClient,
  zoneId: string,
): Promise<SwitchResult> {
  const { data, error } = await db.rpc("set_active_account", {
    p_account_id: zoneId,
  });

  if (error) {
    const denied = error.code === INSUFFICIENT_PRIVILEGE;
    if (!denied) console.error("[zones] set_active_account failed:", error.message);
    return { ok: false, reason: denied ? "not_member" : "failed" };
  }

  // The RPC returns the destination so the client needs no second round
  // trip. A success with no row back means the account row was not
  // readable — treat it as a failure rather than reporting a switch we
  // cannot describe.
  const row = Array.isArray(data) ? (data[0] as MyAccountsRow | undefined) : undefined;
  if (!row?.account_id) {
    console.error("[zones] set_active_account returned no zone");
    return { ok: false, reason: "failed" };
  }

  return {
    ok: true,
    zone: {
      id: row.account_id,
      name: row.name?.trim() || row.account_id,
      role: isAccountRole(row.role) ? row.role : null,
      isActive: true,
    },
  };
}
