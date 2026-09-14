import { describe, it, expect } from 'vitest';
import {
  branchBlocker,
  buildBranchAutomation,
  buildWaLink,
  findBranchAutomation,
  isValidCode,
  normalizeQuality,
  suggestCode,
  tagsWith,
} from './branch-link';

describe('suggestCode', () => {
  it('turns a branch name into a keyword', () => {
    expect(suggestCode('Batu Caves')).toBe('batucaves');
    expect(suggestCode('Rawang')).toBe('rawang');
  });

  it('strips accents rather than escaping them', () => {
    // A code that only matches when the parent's keyboard produces the same
    // accent is a code that silently fails for half the people who type it.
    expect(suggestCode('Ipoh Tímur')).toBe('ipohtimur');
  });

  it('drops punctuation and keeps digits', () => {
    expect(suggestCode('Seksyen 13, Shah Alam')).toBe('seksyen13shahalam');
    expect(suggestCode('PJ — Old Town')).toBe('pjoldtown');
  });

  it('returns empty for a name with nothing usable', () => {
    expect(suggestCode('— —')).toBe('');
    expect(suggestCode('')).toBe('');
  });
});

describe('isValidCode', () => {
  it('accepts what suggestCode produces', () => {
    for (const name of ['Batu Caves', 'Rawang', 'Seksyen 13']) {
      expect(isValidCode(suggestCode(name))).toBe(true);
    }
  });

  it('rejects anything that would not survive a URL round trip', () => {
    expect(isValidCode('')).toBe(false);
    expect(isValidCode('batu caves')).toBe(false);
    expect(isValidCode('Batu')).toBe(false); // uppercase
    expect(isValidCode('batu-caves')).toBe(false);
  });
});

describe('buildWaLink', () => {
  it('strips Meta formatting down to digits', () => {
    // display_phone_number arrives formatted for humans.
    expect(buildWaLink('+60 12-345 6789', 'rawang')).toBe(
      'https://wa.me/60123456789?text=rawang',
    );
  });

  it('handles an already-bare number', () => {
    expect(buildWaLink('60123456789', 'batucaves')).toBe(
      'https://wa.me/60123456789?text=batucaves',
    );
  });
});

describe('normalizeQuality', () => {
  it('recognises the three ratings Meta reports', () => {
    expect(normalizeQuality('GREEN')).toBe('GREEN');
    expect(normalizeQuality('yellow')).toBe('YELLOW');
    expect(normalizeQuality('Red')).toBe('RED');
  });

  it('treats anything else as unknown rather than guessing', () => {
    expect(normalizeQuality(null)).toBe('UNKNOWN');
    expect(normalizeQuality(undefined)).toBe('UNKNOWN');
    expect(normalizeQuality('')).toBe('UNKNOWN');
    expect(normalizeQuality('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('buildBranchAutomation', () => {
  it('matches on whole word, never substring', () => {
    // 'contains' is a raw substring test, so a short branch code fires
    // inside unrelated words. Branch codes are short by design.
    const a = buildBranchAutomation('Rawang', 'rawang', 'tag-1');
    expect(a.trigger_config.match_type).toBe('word');
    expect(a.trigger_config.case_sensitive).toBe(false);
    expect(a.trigger_config.keywords).toEqual(['rawang']);
  });

  it('carries exactly one add_tag step pointing at the tag', () => {
    const a = buildBranchAutomation('Batu Caves', 'batucaves', 'tag-9');
    expect(a.steps).toHaveLength(1);
    expect(a.steps[0]!.step_type).toBe('add_tag');
    expect(a.steps[0]!.step_config).toEqual({ tag_id: 'tag-9' });
  });
});

describe('findBranchAutomation — idempotency', () => {
  const existing = [
    { id: 'a1', trigger_type: 'keyword_match' as const, trigger_config: { keywords: ['rawang'] } },
    { id: 'a2', trigger_type: 'new_message_received' as const, trigger_config: {} },
  ];

  it('finds the automation already wired to this code', () => {
    expect(findBranchAutomation(existing, 'rawang')).toEqual({ id: 'a1' });
  });

  it('is case-insensitive, because the keyword match is', () => {
    expect(findBranchAutomation(existing, 'RAWANG')).toEqual({ id: 'a1' });
  });

  it('returns null for a code nothing matches yet', () => {
    expect(findBranchAutomation(existing, 'batucaves')).toBeNull();
  });

  it('ignores automations triggered by something other than a keyword', () => {
    const other = [
      { id: 'b1', trigger_type: 'tag_added' as const, trigger_config: { keywords: ['rawang'] } },
    ];
    expect(findBranchAutomation(other, 'rawang')).toBeNull();
  });

  it('survives a malformed trigger_config rather than throwing', () => {
    // A hand-edited automation should not break the setup button.
    const messy = [
      { id: 'c1', trigger_type: 'keyword_match' as const, trigger_config: null as never },
      { id: 'c2', trigger_type: 'keyword_match' as const, trigger_config: { keywords: 'rawang' } as never },
      { id: 'c3', trigger_type: 'keyword_match' as const, trigger_config: { keywords: [1, null] } as never },
    ];
    expect(findBranchAutomation(messy, 'rawang')).toBeNull();
  });

  it('a second press finds what the first press created', () => {
    // The actual failure this guards: sixteen branches, pressed by a human
    // who may double-tap.
    const created = buildBranchAutomation('Rawang', 'rawang', 'tag-1');
    const after = [{ id: 'new', trigger_type: created.trigger_type, trigger_config: created.trigger_config }];
    expect(findBranchAutomation(after, 'rawang')).toEqual({ id: 'new' });
  });
});

describe('tagsWith', () => {
  it('spots the add_tag step for a given tag', () => {
    expect(tagsWith([{ step_type: 'add_tag', step_config: { tag_id: 't1' } }], 't1')).toBe(true);
    expect(tagsWith([{ step_type: 'add_tag', step_config: { tag_id: 't2' } }], 't1')).toBe(false);
    expect(tagsWith([{ step_type: 'send_message', step_config: { tag_id: 't1' } }], 't1')).toBe(false);
  });
});

describe('branchBlocker', () => {
  it('names what is missing, in the order it must be fixed', () => {
    expect(branchBlocker(null, '+60123456789')).toBe('no-code');
    expect(branchBlocker('', '+60123456789')).toBe('no-code');
    expect(branchBlocker('Bad Code', '+60123456789')).toBe('no-code');
    expect(branchBlocker('rawang', null)).toBe('no-number');
    expect(branchBlocker('rawang', '+60123456789')).toBeNull();
  });

  it('reports the missing code first when both are missing', () => {
    // The admin can fix the code themselves; the number needs Settings.
    expect(branchBlocker(null, null)).toBe('no-code');
  });
});
