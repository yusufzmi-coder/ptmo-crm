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

/**
 * How long a tab must go without any sign of its human before it reports
 * 'away'.
 *
 * One clock, not two. The previous rule had a second trigger — a hidden
 * tab reported 'away' immediately — and that turned out to be the
 * sharper edge of the two. An agent alt-tabbing to a spreadsheet for
 * thirty seconds dropped straight out of 'online', which took their eye
 * icon off the thread they were in the middle of answering. Switching
 * away for half a minute is not the same as leaving, and the guard
 * cannot tell the difference from the status alone.
 *
 * So both cases now measure the same thing: how long since this tab last
 * saw its human. Input events say so, and so does the tab becoming
 * visible again. Fifteen minutes is deliberately generous — it has to
 * cover stepping out to the toilet, fetching a drink, or turning to talk
 * to someone at the next desk, because during all of those the agent is
 * still the person handling that parent. Past it they have genuinely
 * left the work, and the thread should look free to a colleague.
 */
export const AWAY_AFTER_MS = 15 * 60_000;

/**
 * What this tab should report right now, given when it last saw its
 * human. Pure so the threshold is testable without a DOM — the caller
 * (PresenceHeartbeat) owns the event listeners that keep `lastActiveAt`
 * current.
 */
export function deriveReportedStatus(
  lastActiveAt: number,
  now: number,
): StoredPresence {
  return now - lastActiveAt > AWAY_AFTER_MS ? "away" : "online";
}

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
 * Collapse one member's per-tab rows (migration 045) into the single row
 * that should represent them.
 *
 * Since 045 a member has one row per open dashboard tab, and those rows
 * disagree on purpose: the inbox tab reports 'online' on thread X while
 * a backgrounded /dashboard tab in the same browser reports 'away' on
 * nothing. Anything asking "is this person here?" wants the most present
 * of those, not an arbitrary one — picking arbitrarily is precisely the
 * bug 045 fixes, just moved from the database into the client.
 *
 * Order: 'online' beats 'away', and within a tier the freshest heartbeat
 * wins. An unparseable timestamp sorts oldest rather than throwing — a
 * malformed row must not decide who is present.
 */
export function pickUserRow(
  rows: Iterable<PresenceRow>,
): PresenceRow | undefined {
  let best: PresenceRow | undefined;
  let bestRank = -1;
  let bestSeen = -Infinity;

  for (const row of rows) {
    const rank = row.status === "online" ? 1 : 0;
    const seen = new Date(row.last_seen_at).getTime();
    const seenSafe = Number.isNaN(seen) ? -Infinity : seen;

    if (rank > bestRank || (rank === bestRank && seenSafe > bestSeen)) {
      best = row;
      bestRank = rank;
      bestSeen = seenSafe;
    }
  }

  return best;
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
 * Only members deriving to "online" count, and since AWAY_AFTER_MS
 * became a single generous clock that is the right line to draw: a tab
 * reporting 'online' has seen its human within the last fifteen minutes,
 * which covers stepping out briefly. "away" now means a quarter of an
 * hour with no sign of anyone — someone who left a thread open, not
 * someone about to type, and warning about them would train the team to
 * ignore the warning. "offline" is a stale heartbeat, i.e. a crashed or
 * closed tab, whose pointer must never linger.
 *
 * Returns user ids sorted, so the rendered list doesn't reshuffle on
 * every re-derive tick.
 *
 * Deduplicated by user since migration 045: one member can now supply
 * several rows — one per open tab — and two of an agent's own tabs both
 * pointing at this thread is one person to warn about, not two. Without
 * the Set the banner would read "Amal, Amal are also in this chat".
 */
export function coViewers(
  rows: Iterable<CoViewerRow>,
  conversationId: string | null | undefined,
  selfUserId: string | null | undefined,
  now: number,
): string[] {
  if (!conversationId) return [];
  const out = new Set<string>();
  for (const row of rows) {
    if (!row.user_id || row.user_id === selfUserId) continue;
    if (row.viewing_conversation_id !== conversationId) continue;
    if (derivePresence(row.status, row.last_seen_at, now) !== "online") continue;
    out.add(row.user_id);
  }
  return [...out].sort();
}
