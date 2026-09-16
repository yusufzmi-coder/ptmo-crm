import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CALL_DIRECTIONS,
  CALL_ERROR_KEYS,
  CALL_OUTCOMES,
  callErrorKey,
  formatDuration,
  needsFollowUp,
  parseDurationMinutes,
} from './labels';

/**
 * The catalogue must cover every identifier the code can produce.
 *
 * `src/i18n/messages.test.ts` checks the three locale files agree with
 * EACH OTHER. It cannot check they agree with the CODE — add a sixth
 * outcome and all three stay in perfect parity while the UI renders the
 * raw identifier `tak_angkat` onto a screen. Same guard the issue
 * labels carry, for the same hole.
 */

const LOCALES = ['en', 'ko', 'ms'] as const;

function catalogue(locale: string) {
  const raw = readFileSync(
    join(process.cwd(), 'messages', `${locale}.json`),
    'utf8',
  );
  return JSON.parse(raw).Calls as Record<string, Record<string, string>>;
}

/** Every error code the calls route can put in a JSON body. */
function routeErrorCodes(): string[] {
  const src = readFileSync(
    join(process.cwd(), 'src', 'app', 'api', 'calls', 'route.ts'),
    'utf8',
  );
  const codes = new Set<string>();
  for (const m of src.matchAll(/error:\s*'([a-z_]+)'/g)) codes.add(m[1]);
  // The `?? 'insert_failed'` fallback, which the pattern above misses.
  for (const m of src.matchAll(/\?\?\s*'([a-z_]+)'/g)) codes.add(m[1]);
  return [...codes];
}

describe.each(LOCALES)('%s catalogue covers the code', (locale) => {
  const calls = catalogue(locale);

  it('labels every direction', () => {
    expect(Object.keys(calls.direction).sort()).toEqual(
      [...CALL_DIRECTIONS].sort(),
    );
  });

  it('labels every outcome', () => {
    expect(Object.keys(calls.outcome).sort()).toEqual([...CALL_OUTCOMES].sort());
  });

  it('has a message for every error code the route returns', () => {
    // Deliberately checks the MAP, not callErrorKey(): the helper falls
    // back to saveFailed, which would swallow the exact case this test
    // exists to catch — a new route code nobody mapped.
    const missing = routeErrorCodes().filter(
      (code) =>
        !(code in CALL_ERROR_KEYS) ||
        !(CALL_ERROR_KEYS[code as keyof typeof CALL_ERROR_KEYS] in calls.errors),
    );
    expect(missing, 'route error codes with no catalogue entry').toEqual([]);
  });

  it('maps no error code to a key that does not exist', () => {
    const dangling = Object.values(CALL_ERROR_KEYS).filter(
      (key) => !(key in calls.errors),
    );
    expect(dangling).toEqual([]);
  });

  it('has no blank label', () => {
    for (const [block, entries] of Object.entries(calls)) {
      for (const [key, value] of Object.entries(entries)) {
        expect(value.trim(), `Calls.${block}.${key} is empty`).not.toBe('');
      }
    }
  });
});

describe('the shared blocks stay shared', () => {
  it('declares direction and outcome labels exactly once', () => {
    // Two screens render these — the list and the log dialog. A second
    // copy under either drifts, and the two name the same call
    // differently side by side.
    const calls = catalogue('en');
    const identifiers = [...CALL_DIRECTIONS, ...CALL_OUTCOMES];
    for (const block of ['list', 'log'] as const) {
      for (const id of identifiers) {
        expect(
          Object.keys(calls[block]),
          `Calls.${block} re-declares "${id}"`,
        ).not.toContain(id);
      }
    }
  });
});

describe('callErrorKey', () => {
  it('falls back rather than rendering a raw code', () => {
    expect(callErrorKey('something_nobody_mapped')).toBe('saveFailed');
    expect(callErrorKey(undefined)).toBe('saveFailed');
    expect(callErrorKey('summary_required')).toBe('summaryRequired');
  });
});

describe('needsFollowUp', () => {
  it('flags the outcomes that leave the parent waiting', () => {
    expect(needsFollowUp('tidak_dijawab')).toBe(true);
    expect(needsFollowUp('tinggal_mesej')).toBe(true);
    expect(needsFollowUp('call_balik')).toBe(true);
  });

  it('does not flag the ones that are finished', () => {
    // A wrong number needs the CONTACT fixed, not another call to the
    // same dead line — prompting for a callback time there would train
    // staff to dismiss the prompt.
    expect(needsFollowUp('dijawab')).toBe(false);
    expect(needsFollowUp('nombor_salah')).toBe(false);
  });
});

describe('parseDurationMinutes', () => {
  it('reads minutes and stores seconds', () => {
    expect(parseDurationMinutes('5')).toBe(300);
    expect(parseDurationMinutes(' 1.5 ')).toBe(90);
  });

  it('treats an empty box as no recorded duration', () => {
    expect(parseDurationMinutes('')).toBeNull();
    expect(parseDurationMinutes('   ')).toBeNull();
  });

  it('separates "nothing typed" from "typed nonsense"', () => {
    // undefined, not null: storing NULL for "abc" would throw away the
    // fact that the user typed something, and they would never learn
    // the field was ignored.
    expect(parseDurationMinutes('abc')).toBeUndefined();
    expect(parseDurationMinutes('-3')).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it('reads back the way people say it', () => {
    expect(formatDuration(40)).toBe('40s');
    expect(formatDuration(95)).toBe('1m 35s');
    expect(formatDuration(300)).toBe('5m');
  });

  it('has nothing to show for a call nobody timed', () => {
    expect(formatDuration(null)).toBeNull();
  });
});
