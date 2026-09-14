/**
 * Shared display config for message_templates.status.
 *
 * The DB stores Meta's raw enum (DRAFT / APPROVED / PENDING / REJECTED /
 * PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION) — the UI maps it to
 * a human label + badge classes here so the template manager, inbox
 * picker, and broadcast picker stay aligned.
 *
 * Badge shape matches broadcast-status.ts: bg-<token>/10 +
 * text-<token> + border-<token>/70, with a flat neutral for the
 * statuses that are not colour-coded. The /70 border is not a taste
 * call — QA measured the old faint borders against the card behind
 * them and every badge failed the 3:1 non-text floor.
 *
 * PAUSED and DISABLED deliberately keep their own hues rather than
 * collapsing onto warning/destructive. Eight Meta statuses mapped onto
 * four tokens would give four pairs the same badge, and PAUSED vs
 * PENDING (both "not live, not rejected") is exactly the distinction a
 * template manager scans for.
 */

import type { MessageTemplateStatus } from '@/types';

export interface TemplateStatusDisplay {
  label: string;
  classes: string;
}

export const templateStatusConfig: Record<
  MessageTemplateStatus,
  TemplateStatusDisplay
> = {
  DRAFT: {
    label: 'Draft',
    classes: 'bg-muted text-muted-foreground border-border',
  },
  PENDING: {
    label: 'Pending',
    classes: 'bg-warning/10 text-warning border-warning/70',
  },
  APPROVED: {
    label: 'Approved',
    classes: 'bg-primary/10 text-primary border-primary/70',
  },
  REJECTED: {
    label: 'Rejected',
    classes: 'bg-destructive/10 text-destructive border-destructive/70',
  },
  PAUSED: {
    label: 'Paused',
    classes: 'bg-orange-500/10 text-orange-400 border-orange-500/70',
  },
  DISABLED: {
    label: 'Disabled',
    classes: 'bg-red-900/10 text-red-500 border-red-900/70',
  },
  IN_APPEAL: {
    label: 'In Appeal',
    classes: 'bg-info/10 text-info border-info/70',
  },
  PENDING_DELETION: {
    label: 'Pending Deletion',
    classes: 'bg-muted text-muted-foreground border-border',
  },
};
