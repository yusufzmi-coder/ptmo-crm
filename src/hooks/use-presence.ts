"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  coViewers,
  derivePresence,
  pickUserRow,
  type CoViewerRow,
  type PresenceRow,
  type PresenceStatus,
  type StoredPresence,
} from "@/lib/presence";

// How often the viewer re-derives presence locally. The online→offline
// transition fires NO database event (it's just the clock passing the
// staleness threshold), so without this tick a member who closes their
// tab would appear online forever. ~15s keeps "offline" responsive
// without busy-spinning.
const RE_DERIVE_MS = 15_000;

// Distinguishes the realtime topic of one mounted hook from another's.
// See the comment at its use site.
let nextInstanceId = 0;

// Keyed by user_id + tab_id since migration 045 — a member has one row
// per open dashboard tab, so user_id alone is no longer unique. The
// separator is a NUL byte, which cannot occur in a UUID or in the tab
// ids we mint, so no pair of (user, tab) can collide with another.
type PresenceMap = Map<string, CoViewerRow>;

const rowKey = (userId: string, tabId: string | null | undefined) =>
  `${userId}\u0000${tabId ?? ""}`;

interface UsePresenceResult {
  /** Derived status for one member (defaults to offline if unseen). */
  getPresence: (userId: string) => PresenceStatus;
  /** Raw row for tooltips ("last seen …"). */
  getRow: (userId: string) => PresenceRow | undefined;
  /**
   * Other members who currently have this conversation open — the
   * double-reply guard (migration 041). Excludes the caller, and counts
   * only members deriving to "online"; see `coViewers`.
   */
  getCoViewers: (conversationId: string | null | undefined) => string[];
  /**
   * The clock value the hook is currently deriving against. Pass this
   * to `presenceLabel` / `formatLastSeen` so labels stay in lockstep
   * with the dots (both advance on the same ~15s re-derive tick).
   */
  now: number;
}

/**
 * Live presence for every member of the caller's account. Reads the
 * `member_presence` table (RLS-scoped to the account), subscribes to
 * Realtime changes, and re-derives "offline" on a local timer.
 *
 * Account comes from useAuth; pass `enabled: false` to opt a consumer
 * out (e.g. while a parent sheet is closed).
 */
export function usePresence(enabled = true): UsePresenceResult {
  const { accountId, user } = useAuth();

  // Realtime topics are per-socket: two channels joining the SAME topic
  // on one connection is a duplicate join, and the second one never
  // delivers. The inbox now mounts this hook twice on one page (the
  // conversation list and the open thread), so each instance gets its
  // own topic. The topic is only a routing name — the postgres_changes
  // filter below is what decides which rows arrive.
  //
  // A module counter rather than `useId()`: React 19 renders ids as
  // `«r0»`, and feeding non-ASCII from React's private id format into a
  // realtime topic name ties a wire-level identifier to an internal
  // React detail. This hook is client-only (no SSR hydration to match),
  // so a plain counter is both sufficient and stable across re-renders.
  const [instanceId] = useState(() => String(nextInstanceId++));

  // Presence rows held in immutable state — each update replaces the
  // Map so React renders and the derived getters recompute. No
  // ref/version dance needed.
  const [rows, setRows] = useState<PresenceMap>(() => new Map());

  // `now` ticks so derivePresence re-evaluates staleness over time.
  const [now, setNow] = useState(() => Date.now());

  const active = enabled && !!accountId;

  useEffect(() => {
    if (!active || !accountId) return;

    const supabase = createClient();
    let cancelled = false;

    // Drop everything from the previous account before the new one's
    // rows land. RLS stops the DATABASE from serving another zone's
    // presence (member_presence_select gates on is_account_member, which
    // means the caller's ACTIVE zone), but it cannot reach into a Map
    // this client already holds. Without this, switching zone leaves the
    // old zone's colleagues rendered — dots, "last seen", and eye icons
    // — until a snapshot happens to overwrite each one, and rows for
    // members absent from the new zone would never be overwritten at
    // all. Requested by the multi-zone work; correct regardless of it,
    // since the same staleness applies to any account change.
    setRows(new Map());

    const applyRow = (row: {
      user_id: string;
      tab_id?: string | null;
      status: StoredPresence;
      last_seen_at: string;
      viewing_conversation_id?: string | null;
    }) => {
      setRows((prev) => {
        const next = new Map(prev);
        next.set(rowKey(row.user_id, row.tab_id), {
          user_id: row.user_id,
          status: row.status,
          last_seen_at: row.last_seen_at,
          viewing_conversation_id: row.viewing_conversation_id ?? null,
        });
        return next;
      });
    };

    // Subscribe FIRST, then snapshot. The snapshot MERGES into whatever
    // Realtime has already delivered (keeping the newer last_seen_at)
    // rather than replacing the map — so an event that lands while the
    // fetch is in flight isn't clobbered by a staler snapshot row.
    const channel: RealtimeChannel = supabase
      .channel(`presence:${accountId}:${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "member_presence",
          filter: `account_id=eq.${accountId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            // A DELETE payload carries only the replica identity, i.e.
            // the primary key — since 045 that is (user_id, tab_id).
            //
            // In practice these rarely arrive at all: the `filter` below
            // is on account_id, which a DELETE payload does not include,
            // so the server cannot match it. That is survivable rather
            // than a leak — the only DELETEs are the pruner reclaiming
            // rows that went stale hours ago, and a stale row already
            // derives to "offline" and is ignored by `coViewers`. It
            // lingers in this Map until the next snapshot drops it.
            const old = payload.old as {
              user_id?: string;
              tab_id?: string | null;
            };
            if (!old.user_id) return;
            const key = rowKey(old.user_id, old.tab_id);
            setRows((prev) => {
              if (!prev.has(key)) return prev;
              const next = new Map(prev);
              next.delete(key);
              return next;
            });
            return;
          }
          applyRow(
            payload.new as {
              user_id: string;
              tab_id?: string | null;
              status: StoredPresence;
              last_seen_at: string;
              viewing_conversation_id?: string | null;
            },
          );
        },
      )
      .subscribe();

    supabase
      .from("member_presence")
      .select("user_id, tab_id, status, last_seen_at, viewing_conversation_id")
      .eq("account_id", accountId)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[usePresence] initial fetch error:", error.message);
          return;
        }
        setRows((prev) => {
          const next = new Map(prev);
          for (const r of data ?? []) {
            const userId = r.user_id as string;
            const key = rowKey(userId, r.tab_id as string | null);
            const incoming: CoViewerRow = {
              user_id: userId,
              status: r.status as StoredPresence,
              last_seen_at: r.last_seen_at as string,
              viewing_conversation_id:
                (r.viewing_conversation_id as string | null) ?? null,
            };
            const existing = next.get(key);
            // A live event that arrived first must win over a staler
            // snapshot row.
            if (
              !existing ||
              new Date(incoming.last_seen_at) >= new Date(existing.last_seen_at)
            ) {
              next.set(key, incoming);
            }
          }
          return next;
        });
      });

    const tick = setInterval(() => setNow(Date.now()), RE_DERIVE_MS);

    return () => {
      cancelled = true;
      clearInterval(tick);
      supabase.removeChannel(channel);
    };
  }, [active, accountId, instanceId]);

  // One representative row per member, collapsed from their per-tab
  // rows (045). Memoised because the conversation list asks about every
  // visible thread on every render and on every ~15s re-derive tick —
  // rebuilding this per question would make the list O(threads × rows).
  const byUser = useMemo(() => {
    const grouped = new Map<string, CoViewerRow[]>();
    for (const row of rows.values()) {
      const existing = grouped.get(row.user_id);
      if (existing) existing.push(row);
      else grouped.set(row.user_id, [row]);
    }
    const picked = new Map<string, PresenceRow>();
    for (const [userId, userRows] of grouped) {
      const best = pickUserRow(userRows);
      if (best) picked.set(userId, best);
    }
    return picked;
  }, [rows]);

  const getRow = useCallback(
    (userId: string): PresenceRow | undefined => byUser.get(userId),
    [byUser],
  );

  const getPresence = useCallback(
    (userId: string): PresenceStatus => {
      const row = byUser.get(userId);
      return derivePresence(row?.status, row?.last_seen_at, now);
    },
    [byUser, now],
  );

  const selfId = user?.id ?? null;

  // Deliberately reads the per-TAB rows, not `byUser`: a member counts
  // as a co-viewer if ANY of their tabs has this thread open, and
  // collapsing to one row first would lose the tab that is actually in
  // here whenever another of their tabs happened to be more online.
  // `coViewers` dedupes by user, so two of someone's tabs on the same
  // thread still name them once.
  const candidates = useMemo(() => [...rows.values()], [rows]);

  const getCoViewers = useCallback(
    (conversationId: string | null | undefined): string[] =>
      coViewers(candidates, conversationId, selfId, now),
    [candidates, now, selfId],
  );

  return { getPresence, getRow, getCoViewers, now };
}
