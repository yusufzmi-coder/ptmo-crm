"use client";

import { useCallback, useEffect, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  coViewers,
  derivePresence,
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

type PresenceMap = Map<string, PresenceRow>;

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

  // Presence rows keyed by user_id, held in immutable state — each
  // update replaces the Map so React renders and the derived getters
  // recompute. No ref/version dance needed.
  const [rows, setRows] = useState<PresenceMap>(() => new Map());

  // `now` ticks so derivePresence re-evaluates staleness over time.
  const [now, setNow] = useState(() => Date.now());

  const active = enabled && !!accountId;

  useEffect(() => {
    if (!active || !accountId) return;

    const supabase = createClient();
    let cancelled = false;

    const applyRow = (row: {
      user_id: string;
      status: StoredPresence;
      last_seen_at: string;
      viewing_conversation_id?: string | null;
    }) => {
      setRows((prev) => {
        const next = new Map(prev);
        next.set(row.user_id, {
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
            const old = payload.old as { user_id?: string };
            if (!old.user_id) return;
            setRows((prev) => {
              if (!prev.has(old.user_id!)) return prev;
              const next = new Map(prev);
              next.delete(old.user_id!);
              return next;
            });
            return;
          }
          applyRow(
            payload.new as {
              user_id: string;
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
      .select("user_id, status, last_seen_at, viewing_conversation_id")
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
            const incoming: PresenceRow = {
              status: r.status as StoredPresence,
              last_seen_at: r.last_seen_at as string,
              viewing_conversation_id:
                (r.viewing_conversation_id as string | null) ?? null,
            };
            const existing = next.get(userId);
            // A live event that arrived first must win over a staler
            // snapshot row.
            if (
              !existing ||
              new Date(incoming.last_seen_at) >= new Date(existing.last_seen_at)
            ) {
              next.set(userId, incoming);
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

  const getRow = useCallback(
    (userId: string): PresenceRow | undefined => rows.get(userId),
    [rows],
  );

  const getPresence = useCallback(
    (userId: string): PresenceStatus => {
      const row = rows.get(userId);
      return derivePresence(row?.status, row?.last_seen_at, now);
    },
    [rows, now],
  );

  const selfId = user?.id ?? null;

  const getCoViewers = useCallback(
    (conversationId: string | null | undefined): string[] => {
      if (!conversationId) return [];
      const candidates: CoViewerRow[] = [];
      for (const [userId, row] of rows) {
        candidates.push({ user_id: userId, ...row });
      }
      return coViewers(candidates, conversationId, selfId, now);
    },
    [rows, now, selfId],
  );

  return { getPresence, getRow, getCoViewers, now };
}
