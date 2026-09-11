// ============================================================
// Presence helpers — pure, unit-testable, no I/O.
//
// Mirrors the `member_presence` table from migration
// 024_member_presence.sql. The DB stores only what the active
// client reports ('online' / 'away'); "offline" is never stored
// — it is derived here from staleness so a closed tab resolves to
// offline without an unload write.
//
// `now` is always passed in (epoch ms) rather than read from the
// clock, so derivation and formatting stay deterministic and
// testable. See presence.test.ts.
// ============================================================

/** How often the active client heartbeats its own presence row. */
export const HEARTBEAT_MS = 30_000;

/**
 * A member whose last heartbeat is older than this is treated as
 * offline regardless of its stored status. ~2.5 missed beats, so a
 * single dropped heartbeat doesn't flap a member offline.
 */
export const OFFLINE_AFTER_MS = 75_000;

/** No input / hidden tab for this long flips the client to 'away'. */
export const IDLE_AFTER_MS = 5 * 60_000;

/** What the active client reports (and what the DB stores). */
export type StoredPresence = "online" | "away";

/** What a viewer sees — adds the derived 'offline' state. */
export type PresenceStatus = "online" | "away" | "offline";

/** Raw presence row as read from the `member_presence` table. */
export interface PresenceRow {
  status: StoredPresence;
  last_seen_at: string;
  /**
   * The conversation this member currently has open, or null
   * (migration 041). Optional so callers that never select the column
   * keep type-checking unchanged.
   */
  viewing_conversation_id?: string | null;
}

/** A presence row together with the member it belongs to. */
export interface CoViewerRow extends PresenceRow {
  user_id: string;
}

/**
 * Derive the user-facing presence for a member. A missing row, or a
 * heartbeat staler than OFFLINE_AFTER_MS, reads as offline; otherwise
 * the member's last reported status (online / away) stands.
 */
export function derivePresence(
  stored: StoredPresence | undefined,
  lastSeenAt: string | null | undefined,
  now: number,
): PresenceStatus {
  if (!stored || !lastSeenAt) return "offline";
  const last = new Date(lastSeenAt).getTime();
  if (Number.isNaN(last)) return "offline";
  if (now - last > OFFLINE_AFTER_MS) return "offline";
  return stored;
}

/**
 * Relative "last seen" string for tooltips. Coarse on purpose — the
 * issue calls for relative time only, never a precise timestamp.
 *
 * Deliberately separate from `formatRelative` in
 * src/lib/automations/trigger-meta.ts: that one reads `Date.now()`
 * internally (not injectable) and emits terse chip wording ("2h ago"),
 * whereas presence needs an injected `now` — so the dots and labels
 * advance in lockstep and the unit tests stay deterministic — plus
 * full-sentence wording for the tooltip ("Offline — last seen …").
 */
export function formatLastSeen(
  lastSeenAt: string | null | undefined,
  now: number,
): string {
  if (!lastSeenAt) return "a while ago";
  const last = new Date(lastSeenAt).getTime();
  if (Number.isNaN(last)) return "a while ago";

  const diff = Math.max(0, now - last);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;

  const hours = Math.floor(mins / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/**
 * Tooltip / aria label for a presence dot, e.g.
 *   "Online — active now"
 *   "Away — idle"
 *   "Offline — last seen 2 hours ago"
 */
export function presenceLabel(
  status: PresenceStatus,
  lastSeenAt: string | null | undefined,
  now: number,
): string {
  switch (status) {
    case "online":
      return "Online — active now";
    case "away":
      return "Away — idle";
    case "offline":
      return `Offline — last seen ${formatLastSeen(lastSeenAt, now)}`;
  }
}

/** Roster header summary, e.g. for "3 online · 1 away · 1 offline". */
export function summarize(statuses: PresenceStatus[]): {
  online: number;
  away: number;
  offline: number;
} {
  const counts = { online: 0, away: 0, offline: 0 };
  for (const s of statuses) counts[s] += 1;
  return counts;
}

/**
 * Who ELSE currently has `conversationId` open — the guard against two
 * agents answering the same parent (migration 041).
 *
 * Deliberately strict: only members deriving to "online" count. "away"
 * means a hidden tab or five idle minutes, which is someone who left
 * the thread open, not someone about to type — warning about them would
 * train the team to ignore the warning. "offline" is a stale heartbeat,
 * i.e. a crashed or closed tab, whose pointer must never linger.
 *
 * Returns user ids sorted, so the rendered list doesn't reshuffle on
 * every re-derive tick.
 */
export function coViewers(
  rows: Iterable<CoViewerRow>,
  conversationId: string | null | undefined,
  selfUserId: string | null | undefined,
  now: number,
): string[] {
  if (!conversationId) return [];
  const out: string[] = [];
  for (const row of rows) {
    if (!row.user_id || row.user_id === selfUserId) continue;
    if (row.viewing_conversation_id !== conversationId) continue;
    if (derivePresence(row.status, row.last_seen_at, now) !== "online") continue;
    out.push(row.user_id);
  }
  return out.sort();
}
