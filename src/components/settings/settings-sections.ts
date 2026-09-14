import {
  Building2,
  Coins,
  FileText,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  Shield,
  Tags,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'centres',
  'templates',
  'quick-replies',
  'fields',
  'deals',
  'members',
  'api',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
/**
 * Rail metadata. Deliberately carries no label: the displayed name comes
 * from the catalogue (`Settings.sections.<id>`), which is what
 * settings-rail renders. A `label` here would look like the source of
 * truth while changing nothing on screen.
 */
export interface SectionMeta {
  id: SettingsSection;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', icon: User, group: 'account' },
  security: { id: 'security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', icon: Palette, group: 'account' },
  whatsapp: { id: 'whatsapp', icon: PlugZap, group: 'workspace' },
  centres: { id: 'centres', icon: Building2, group: 'workspace' },
  templates: { id: 'templates', icon: FileText, group: 'workspace' },
  'quick-replies': { id: 'quick-replies', icon: Zap, group: 'workspace' },
  fields: { id: 'fields', icon: Tags, group: 'workspace' },
  deals: { id: 'deals', icon: Coins, group: 'workspace' },
  members: { id: 'members', icon: UsersRound, group: 'workspace' },
  api: { id: 'api', icon: KeyRound, group: 'workspace' },
};

/**
 * Rail groups, in render order. `showHeading` is what this always actually
 * was: the previous `label: string | null` was read only as a truthiness
 * check, and its text ("Account", "Workspace") never reached the screen —
 * the heading comes from `Settings.groups.<group>`.
 */
export const RAIL_GROUPS: { showHeading: boolean; group: SectionMeta['group'] }[] = [
  { showHeading: false, group: 'top' },
  { showHeading: true, group: 'account' },
  { showHeading: true, group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
