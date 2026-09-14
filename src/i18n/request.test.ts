import { afterEach, describe, expect, it, vi } from 'vitest';

import { AVAILABLE, resolveLocale } from './request';

/**
 * `getRequestConfig` cannot run outside a server component, so these test
 * the resolution directly. That is where the bug lived anyway: in the gap
 * between what the environment says and what actually gets served.
 */
const ORIGINAL = process.env.NEXT_PUBLIC_APP_LOCALE;

function withEnv(value: string | undefined) {
  if (value === undefined) delete process.env.NEXT_PUBLIC_APP_LOCALE;
  else process.env.NEXT_PUBLIC_APP_LOCALE = value;
}

afterEach(() => {
  withEnv(ORIGINAL);
  vi.restoreAllMocks();
});

describe('resolveLocale', () => {
  it('serves the locale it is given', () => {
    withEnv('ms');
    expect(resolveLocale()).toBe('ms');
  });

  it.each(['ms ', ' ms', '  ms  ', 'ms\n', '\tms'])(
    'trims surrounding whitespace: %j',
    (value) => {
      // .env.local shipped "en " for four days and nobody noticed, because
      // English was what everyone expected to see. The day that value
      // becomes "ms ", an untrimmed read serves English instead and the
      // activation looks like it never happened.
      withEnv(value);
      expect(resolveLocale()).toBe('ms');
    },
  );

  it('falls back to en when the variable is absent or blank', () => {
    withEnv(undefined);
    expect(resolveLocale()).toBe('en');
    withEnv('   ');
    expect(resolveLocale()).toBe('en');
  });

  it('says so out loud when the value names no dictionary', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv('jp');

    expect(resolveLocale()).toBe('en');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('quotes the raw value, so whitespace is visible in the warning', () => {
    // Without the quotes a trailing space is invisible in a log line —
    // which is precisely how this hid the first time.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv('e n');

    resolveLocale();

    expect(warn.mock.calls[0][0]).toContain('"e n"');
  });

  it('stays quiet for a locale it does serve', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv('ko');

    expect(resolveLocale()).toBe('ko');
    expect(warn).not.toHaveBeenCalled();
  });

  it('lists exactly the dictionaries that exist on disk', async () => {
    // AVAILABLE is hand-maintained, so it can drift from messages/.
    // If it does, request.ts will throw on import instead of silently
    // serving the wrong language — but catching the drift here is cheaper.
    const { readdirSync } = await import('node:fs');
    const onDisk = readdirSync('messages')
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();

    expect([...AVAILABLE].sort()).toEqual(onDisk);
  });
});
