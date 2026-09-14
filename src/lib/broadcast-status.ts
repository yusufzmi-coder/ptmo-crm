/**
 * Shared status badge config for broadcasts + recipients.
 *
 * Previously `statusConfig` was defined inline in both
 * /broadcasts/page.tsx and /broadcasts/[id]/page.tsx with slight
 * drift risk. One source of truth now.
 *
 * Badge shape: bg-<token>/10 + text-<token> + border-<token>/70.
 *
 * The tokens carry their own light/dark values, so a status no longer
 * needs a hand-picked shade per mode. Borders are /70 rather than the
 * /20 they used to be: QA measured the old translucency against the
 * card behind it and every badge failed the 3:1 non-text contrast
 * floor (1.84–2.50). Text is the bare token — no shade suffix — so it
 * follows the mode.
 *
 * Neutral statuses keep muted-foreground for the same reason as
 * before: a solid slate would be too faint on white.
 */

import type { BroadcastStatus, RecipientStatus } from "@/types";

export interface StatusDisplay {
  label: string;
  classes: string;
  /**
   * Set true for statuses that should pulse in the UI to convey
   * "live / in-flight" — currently only `sending`.
   */
  pulse?: boolean;
}

export const broadcastStatusConfig: Record<BroadcastStatus, StatusDisplay> = {
  draft: {
    label: "draft",
    classes: "bg-muted text-muted-foreground border-border",
  },
  scheduled: {
    label: "scheduled",
    classes: "bg-info/10 text-info border-info/70",
  },
  sending: {
    label: "sending",
    classes: "bg-warning/10 text-warning border-warning/70",
    pulse: true,
  },
  sent: {
    label: "sent",
    classes: "bg-primary/10 text-primary border-primary/70",
  },
  failed: {
    label: "failed",
    classes: "bg-destructive/10 text-destructive border-destructive/70",
  },
};

export const recipientStatusConfig: Record<RecipientStatus, StatusDisplay> = {
  pending: {
    label: "pending",
    classes: "bg-muted text-muted-foreground border-border",
  },
  sent: {
    label: "sent",
    classes: "bg-info/10 text-info border-info/70",
  },
  delivered: {
    label: "delivered",
    classes: "bg-primary/10 text-primary border-primary/70",
  },
  read: {
    label: "read",
    classes: "bg-primary/10 text-primary border-primary/70",
  },
  replied: {
    label: "replied",
    classes: "bg-purple-500/10 text-purple-400 border-purple-500/70",
  },
  failed: {
    label: "failed",
    classes: "bg-destructive/10 text-destructive border-destructive/70",
  },
};

/**
 * Tolerant lookup — callers often have a generic string status
 * coming from Supabase. Falls back to the "draft" / "pending"
 * entry so the UI never crashes on an unknown value.
 */
export function getBroadcastStatus(status: string): StatusDisplay {
  return (
    broadcastStatusConfig[status as BroadcastStatus] ??
    broadcastStatusConfig.draft
  );
}

export function getRecipientStatus(status: string): StatusDisplay {
  return (
    recipientStatusConfig[status as RecipientStatus] ??
    recipientStatusConfig.pending
  );
}
