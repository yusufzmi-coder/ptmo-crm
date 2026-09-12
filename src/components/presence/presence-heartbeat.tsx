"use client";

import { useEffect, useRef } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  deriveReportedStatus,
  HEARTBEAT_MS,
  type StoredPresence,
} from "@/lib/presence";
import {
  getFocusedConversation,
  subscribeFocusedConversation,
} from "@/lib/presence-focus";
import { getTabId } from "@/lib/presence-tab";

/**
 * PresenceHeartbeat — headless. Mount ONCE per signed-in dashboard tab
 * (in the dashboard shell, below the auth gate). Reports this tab's
 * presence to the `member_presence` table via the `touch_presence` RPC
 * roughly every HEARTBEAT_MS.
 *
 * The client only ever reports 'online' or 'away', off ONE clock: how
 * long since this tab last saw its human (input, or the tab becoming
 * visible again). Past AWAY_AFTER_MS it reports 'away'.
 * It keeps heartbeating while away (so the row stays fresh, i.e. not
 * offline). When the tab closes the beats simply stop and viewers derive
 * 'offline' from staleness — no unreliable unload write needed.
 */
export function PresenceHeartbeat() {
  const { accountId } = useAuth();

  // 0 = "never recorded"; set on mount so we don't read the clock during
  // render (impure). Until the effect runs the tab counts as active.
  const lastActivityRef = useRef<number>(0);

  useEffect(() => {
    // Hold off until the account is known. Beating during the brief
    // window on a fresh signup — authed but profile/account row not yet
    // created — would make touch_presence raise "No account for caller"
    // and log a spurious error. The effect re-runs once accountId lands.
    if (!accountId) return;

    const supabase = createClient();
    let cancelled = false;
    let lastBeatAt = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    lastActivityRef.current = Date.now();

    const markActive = () => {
      lastActivityRef.current = Date.now();
    };

    // A hidden tab used to report 'away' on the spot. That read as
    // "gone" for an agent who alt-tabbed to a spreadsheet for thirty
    // seconds, and took their eye icon off a thread they were in the
    // middle of answering. Being hidden now just means no activity is
    // observable, so the same clock runs — and returning to the tab
    // marks activity through `onReturn` below, which is what makes a
    // short switch away cost nothing.
    const currentStatus = (): StoredPresence =>
      deriveReportedStatus(lastActivityRef.current, Date.now());

    const beat = async () => {
      if (cancelled) return;
      // Coalesce bursts: a tab refocus fires visibilitychange AND focus
      // together, so two RPCs would otherwise land in the same frame.
      // Within 1s of the last beat the request is DEFERRED, not dropped:
      // a dropped beat may be the one carrying a just-opened thread, and
      // losing it would leave the co-viewer warning blind until the next
      // 30s tick — long enough for both agents to finish typing. The 30s
      // interval itself is never affected.
      const t = Date.now();
      if (t - lastBeatAt < 1_000) {
        if (trailing === null) {
          trailing = setTimeout(
            () => {
              trailing = null;
              void beat();
            },
            1_000 - (t - lastBeatAt),
          );
        }
        return;
      }
      lastBeatAt = t;
      const { error } = await supabase.rpc("touch_presence", {
        p_status: currentStatus(),
        // Which thread this tab has open (migration 041). Only a hint —
        // the RPC drops it unless the conversation is in the caller's
        // own account.
        p_viewing_conversation_id: getFocusedConversation(),
        // Which tab is reporting (migration 045). Before this, every
        // dashboard tab wrote the same row, so a backgrounded tab's
        // ('away', no thread) kept overwriting the inbox tab's
        // ('online', thread X) and the co-viewer guard went blind
        // roughly half the time.
        p_tab_id: getTabId(),
      });
      if (error && !cancelled) {
        // Non-fatal: presence is best-effort. Log once per failure so a
        // misconfigured RPC is visible without spamming.
        console.error("[PresenceHeartbeat] touch_presence failed:", error.message);
      }
    };

    // Activity listeners. `passive` so we never block scroll/input.
    const activityEvents: (keyof DocumentEventMap)[] = [
      "mousemove",
      "keydown",
      "pointerdown",
      "scroll",
    ];
    activityEvents.forEach((e) =>
      document.addEventListener(e, markActive, { passive: true }),
    );

    // Returning to the tab should beat immediately so a member flips
    // back to online without a 30s wait. The debounce in beat() absorbs
    // the visibilitychange + focus double-fire.
    const onReturn = () => {
      if (!document.hidden) markActive();
      void beat();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);

    // Opening or leaving a thread is reported at once rather than on
    // the next tick: the warning only earns its keep if it appears
    // before the second agent starts typing, and 30s is longer than it
    // takes to write a reply.
    const unsubscribeFocus = subscribeFocusedConversation(() => void beat());

    void beat();
    const interval = setInterval(() => void beat(), HEARTBEAT_MS);

    return () => {
      cancelled = true;
      unsubscribeFocus();
      if (trailing !== null) clearTimeout(trailing);
      clearInterval(interval);
      activityEvents.forEach((e) =>
        document.removeEventListener(e, markActive),
      );
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [accountId]);

  return null;
}
