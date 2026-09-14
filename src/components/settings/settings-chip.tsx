import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Small status / role pill used across the settings redesign
 * (Overview tiles, WhatsApp banner, the "Active" appearance markers).
 *
 * `ok` and `warn` report a state, so they ride the semantic status
 * tokens and adapt per mode. `owner` does not: it marks WHO someone is,
 * not how something is going, and role colour is an identity scale
 * shared with the members roster — tokenizing it would imply the owner
 * role is a warning.
 */
export type ChipVariant = 'owner' | 'admin' | 'ok' | 'warn' | 'muted';

const VARIANTS: Record<ChipVariant, string> = {
  owner: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  admin: 'border-primary-soft-2 bg-primary-soft text-primary-on-soft',
  ok: 'border-success/70 bg-success/10 text-success',
  warn: 'border-warning/70 bg-warning/10 text-warning',
  muted: 'border-border bg-muted text-muted-foreground',
};

export function SettingsChip({
  variant = 'muted',
  className,
  children,
}: {
  variant?: ChipVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5',
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A small live status dot (e.g. WhatsApp connected indicator). */
export function StatusDot({
  tone = 'ok',
  className,
}: {
  tone?: 'ok' | 'muted';
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        tone === 'ok' ? 'bg-success' : 'bg-muted-foreground',
        className,
      )}
    />
  );
}
