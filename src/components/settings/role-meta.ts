import {
  Crown,
  Shield,
  UserCog,
  UserIcon,
  type LucideIcon,
} from 'lucide-react';

import type { AccountRole } from '@/lib/auth/roles';
import type { ChipVariant } from './settings-chip';

/**
 * Single source of truth for per-role chip metadata across settings
 * surfaces (the Overview identity chip and the Members roster/invite
 * chips). Previously duplicated in both files; hoisted here so a label,
 * icon, or colour change lands once.
 *
 * `variant` drives the token-based <SettingsChip>; `className` is the
 * inline Tailwind string the Members tab applies to its own spans.
 */
export const ROLE_META: Record<
  AccountRole,
  { icon: LucideIcon; label: string; variant: ChipVariant; className: string }
> = {
  owner: {
    icon: Crown,
    label: 'owner',
    variant: 'owner',
    // amber-300 alone measured 1.33:1 on a light card — the owner chip
    // was effectively invisible in the default mode. Identity hue kept (a
    // role is not a status, so it stays off the semantic tokens); only a
    // light-mode value is added, matching SettingsChip's own `owner`.
    //
    // The dark: half does not currently take effect. globals.css declares
    // `@custom-variant dark (&:is(.dark *))`, and nothing in the app ever
    // adds a `.dark` class — the mode lives on `html[data-mode]`. Verified
    // in the browser: flipping data-mode leaves this colour unchanged, and
    // only adding `.dark` by hand switches it. It is written the correct
    // way so it starts working the moment that variant is fixed; until
    // then dark mode gets amber-700, which is legible but not ideal.
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  admin: {
    icon: Shield,
    label: 'admin',
    variant: 'admin',
    className: 'border-primary/40 bg-primary/10 text-primary',
  },
  agent: {
    icon: UserCog,
    label: 'agent',
    variant: 'muted',
    className: 'border-border bg-muted text-muted-foreground',
  },
  viewer: {
    icon: UserIcon,
    label: 'viewer',
    variant: 'muted',
    // Outline-only so it stays quieter than the filled Agent chip in
    // both modes — bg-card would blend into a card surface in light mode.
    className: 'border-border bg-transparent text-muted-foreground',
  },
};
