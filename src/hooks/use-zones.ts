"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  fetchZones,
  switchActiveZone,
  type Zone,
  type ZoneFailure,
} from "@/lib/auth/zones";

interface UseZonesValue {
  /** Zones this user may enter. Empty until `my_accounts()` answers. */
  zones: Zone[];
  /** True until the first load settles, success or failure. */
  loading: boolean;
  /** Id of the zone being switched to, or null when idle. */
  switchingTo: string | null;
  /** Why the last switch failed. Cleared when another is attempted. */
  error: ZoneFailure | null;
  /** Move to a zone. Resolves to true only when the move happened. */
  switchTo: (zoneId: string) => Promise<boolean>;
}

/**
 * The zone switcher's state.
 *
 * The switch itself is one RPC, but what makes it safe is what happens
 * after it: `refreshProfile()` repoints `useAuth().accountId`, and the
 * app is already built to treat that value as the thing everything
 * account-scoped hangs off —
 *
 *   - the inbox page mounts its inner tree with `key={accountId}`, so a
 *     new zone gets a new component instance: conversations, messages,
 *     the open thread and the unread badges all start empty rather than
 *     being cleared one state setter at a time;
 *   - `realtimeTopic(base, accountId)` changes, so every channel is torn
 *     down and rebuilt against the new zone (`src/lib/realtime/channel.ts`);
 *   - `usePresence` empties its row map when `accountId` changes.
 *
 * So this hook does not hunt down stale state itself. It moves the one
 * value the rest of the app watches, and lets those mechanisms fire.
 * `router.refresh()` then re-renders server components on top.
 *
 * A full page reload would also work and would be cruder: it would throw
 * away scroll position, any open composer draft, and the websocket, to
 * solve a problem the key already solves.
 */
export function useZones(): UseZonesValue {
  const { user, accountId, refreshProfile } = useAuth();
  const router = useRouter();

  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [error, setError] = useState<ZoneFailure | null>(null);

  // The click guard. Held in a ref as well as state because two clicks
  // in the same tick both read the pre-render state value — the ref is
  // what actually makes the second one a no-op.
  const switchingRef = useRef(false);

  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) {
      setZones([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      const result = await fetchZones(createClient());
      if (cancelled) return;
      // A failed load leaves `zones` empty, which renders as the plain
      // label rather than a broken dropdown. The header is chrome: it
      // should degrade to "your zone is X", never to an error.
      setZones(result.ok ? result.zones : []);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `accountId` is a dependency on purpose: a switch made in another
    // tab moves this user's active zone too, and the `is_active` flag
    // in the list has to follow it.
  }, [userId, accountId]);

  const switchTo = useCallback(
    async (zoneId: string): Promise<boolean> => {
      if (switchingRef.current) return false;
      if (!zoneId || zoneId === accountId) return false;

      switchingRef.current = true;
      setSwitchingTo(zoneId);
      setError(null);

      try {
        const result = await switchActiveZone(createClient(), zoneId);

        if (!result.ok) {
          // Nothing moved server-side, so nothing moves here either.
          setError(result.reason);
          return false;
        }

        // Reflect the move locally first so the menu is already correct
        // when the tree re-renders.
        setZones((prev) =>
          prev.map((z) => ({ ...z, isActive: z.id === result.zone.id })),
        );

        // The load-bearing line: this is what repoints `accountId` and,
        // through it, remounts and re-subscribes everything zone-scoped.
        await refreshProfile();

        // Server components (and anything they fetched) are stale too.
        router.refresh();

        return true;
      } finally {
        switchingRef.current = false;
        setSwitchingTo(null);
      }
    },
    [accountId, refreshProfile, router],
  );

  return { zones, loading, switchingTo, error, switchTo };
}

/** Re-exported so the header need not import from two places. */
export type { Zone };
export { currentZoneName, shouldShowSwitcher } from "@/lib/auth/zones";
