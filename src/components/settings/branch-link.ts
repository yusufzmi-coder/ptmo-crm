import type { Automation, AutomationStep } from '@/types';

/**
 * Turning sixteen branch handsets into one CRM number.
 *
 * Once every parent writes to the same number, WhatsApp tells us nothing
 * about which branch they meant — only their phone number. The way back is
 * the link: each branch shares its own wa.me link into its existing parent
 * group, and the first message arrives carrying that branch's keyword. The
 * parent types nothing and picks nothing, so there is nothing for them to
 * get wrong.
 *
 * This module is the pure half of that: deriving the keyword, building the
 * link, and deciding whether a branch is already wired up. The panel owns
 * the network calls.
 */

/**
 * Suggest a link keyword from a branch name: "Batu Caves" → "batucaves".
 *
 * Lowercase letters and digits only. The keyword travels as the `text=`
 * parameter and is matched against an incoming message, so anything that
 * survives URL-encoding differently on one platform than another — spaces,
 * punctuation, accents — is stripped rather than escaped.
 *
 * Only a suggestion: the admin can overwrite it, because they are the one
 * who has to read it back off a printed banner.
 */
export function suggestCode(name: string): string {
  return name
    .normalize('NFD')
    // Strip combining marks so "Ipoh Tímur" yields "ipohtimur", not a code
    // that only matches when the parent's keyboard produces the same accent.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** A code is usable if it survives normalisation unchanged and is non-empty. */
export function isValidCode(code: string): boolean {
  return code.length > 0 && /^[a-z0-9]+$/.test(code);
}

/**
 * Build the link a branch shares with its parents.
 *
 * `display_phone_number` comes back from Meta formatted for humans
 * ("+60 12-345 6789"); wa.me wants digits only.
 */
export function buildWaLink(displayPhoneNumber: string, code: string): string {
  const digits = displayPhoneNumber.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(code)}`;
}

/** Quality ratings Meta reports. Anything else is treated as unknown. */
export type QualityRating = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

export function normalizeQuality(value: string | null | undefined): QualityRating {
  const v = (value ?? '').toUpperCase();
  return v === 'GREEN' || v === 'YELLOW' || v === 'RED' ? v : 'UNKNOWN';
}

/**
 * The automation that labels an inbound message with its branch.
 *
 * `match_type: 'word'` is not a preference. 'contains' is a raw substring
 * test, so a short keyword fires inside unrelated words — the comment on
 * KeywordTriggerConfig gives "k" firing inside "thanks". Branch codes are
 * short by design, because someone reads them off a banner.
 */
export function buildBranchAutomation(centreName: string, code: string, tagId: string) {
  return {
    name: `${centreName} — ${code}`,
    trigger_type: 'keyword_match' as const,
    trigger_config: {
      keywords: [code],
      match_type: 'word' as const,
      case_sensitive: false,
    },
    steps: [
      {
        step_type: 'add_tag' as const,
        step_order: 0,
        step_config: { tag_id: tagId },
      },
    ],
  };
}

/**
 * Is this branch already wired up?
 *
 * Keyed on the keyword rather than the automation name, because the name is
 * cosmetic and an admin may well rename it, while the keyword IS the wiring
 * — two automations matching the same keyword is the actual duplicate.
 *
 * Sixteen branches means this button gets pressed sixteen times by someone
 * who may double-tap, so the check has to hold under a repeat press, not
 * merely look like it does.
 */
export function findBranchAutomation(
  automations: Pick<Automation, 'id' | 'trigger_type' | 'trigger_config'>[],
  code: string,
): { id: string } | null {
  const wanted = code.toLowerCase();
  for (const a of automations) {
    if (a.trigger_type !== 'keyword_match') continue;
    const cfg = a.trigger_config as { keywords?: unknown } | null;
    const keywords = Array.isArray(cfg?.keywords) ? cfg.keywords : [];
    if (keywords.some((k) => typeof k === 'string' && k.toLowerCase() === wanted)) {
      return { id: a.id };
    }
  }
  return null;
}

/** Does this automation's first add_tag step already point at `tagId`? */
export function tagsWith(steps: Pick<AutomationStep, 'step_type' | 'step_config'>[], tagId: string): boolean {
  return steps.some(
    (s) =>
      s.step_type === 'add_tag' &&
      (s.step_config as { tag_id?: unknown } | null)?.tag_id === tagId,
  );
}

/**
 * What a branch row needs before it can be set up, in the order the admin
 * has to fix them. Returning the reason rather than hiding the row is the
 * point: an empty space tells nobody what to do next.
 */
export type BranchBlocker = 'no-code' | 'no-number' | null;

export function branchBlocker(code: string | null, displayPhoneNumber: string | null): BranchBlocker {
  if (!code || !isValidCode(code)) return 'no-code';
  if (!displayPhoneNumber) return 'no-number';
  return null;
}
