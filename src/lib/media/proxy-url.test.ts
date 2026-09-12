import { describe, expect, it } from 'vitest';

import {
  accountFolder,
  isProxyableBucket,
  mediaProxyPath,
  parseMediaProxyPath,
  pathBelongsToAccount,
} from './proxy-url';

const ACCOUNT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

describe('mediaProxyPath / parseMediaProxyPath', () => {
  it('round-trips a plain path', () => {
    const stored = mediaProxyPath('chat-media', `account-${ACCOUNT}/inbound/abc.pdf`);
    expect(stored).toBe(`/api/media/chat-media/account-${ACCOUNT}/inbound/abc.pdf`);
    expect(parseMediaProxyPath(stored)).toEqual({
      bucket: 'chat-media',
      objectPath: `account-${ACCOUNT}/inbound/abc.pdf`,
    });
  });

  it('round-trips a filename with characters that need escaping', () => {
    const objectPath = `account-${ACCOUNT}/inbound/surat ibu bapa #3.pdf`;
    const stored = mediaProxyPath('chat-media', objectPath);
    // The separators stay literal; only the segments are encoded.
    expect(stored).toContain('/api/media/chat-media/');
    expect(stored).not.toContain(' ');
    expect(parseMediaProxyPath(stored)?.objectPath).toBe(objectPath);
  });

  it('returns null for a legacy absolute public URL', () => {
    // Rows written before 047 hold one of these; callers must be able to
    // tell it apart from a pointer rather than mis-parsing it.
    expect(
      parseMediaProxyPath('https://x.supabase.co/storage/v1/object/public/chat-media/a/b.pdf')
    ).toBeNull();
  });

  it('returns null for the older Meta proxy pointer', () => {
    expect(parseMediaProxyPath('/api/whatsapp/media/1234567890')).toBeNull();
  });

  it('returns null for an unknown bucket, a missing path, or nothing', () => {
    expect(parseMediaProxyPath('/api/media/secrets/a/b')).toBeNull();
    expect(parseMediaProxyPath('/api/media/chat-media/')).toBeNull();
    expect(parseMediaProxyPath('/api/media/chat-media')).toBeNull();
    expect(parseMediaProxyPath(null)).toBeNull();
    expect(parseMediaProxyPath(undefined)).toBeNull();
  });
});

describe('isProxyableBucket', () => {
  it('accepts the three private buckets and nothing else', () => {
    expect(isProxyableBucket('chat-media')).toBe(true);
    expect(isProxyableBucket('flow-media')).toBe(true);
    expect(isProxyableBucket('avatars')).toBe(true);
    expect(isProxyableBucket('storage')).toBe(false);
    expect(isProxyableBucket('')).toBe(false);
  });
});

describe('pathBelongsToAccount', () => {
  it('accepts a path under the account folder', () => {
    expect(pathBelongsToAccount(`account-${ACCOUNT}/inbound/a.pdf`, ACCOUNT)).toBe(true);
    expect(pathBelongsToAccount(`${accountFolder(ACCOUNT)}/a.pdf`, ACCOUNT)).toBe(true);
  });

  it("refuses another account's folder", () => {
    expect(pathBelongsToAccount(`account-${OTHER}/inbound/a.pdf`, ACCOUNT)).toBe(false);
  });

  it('refuses a traversal that would escape the account folder', () => {
    // The path arrives from the URL, so this is the case a naive
    // startsWith() would wave through.
    expect(
      pathBelongsToAccount(`account-${ACCOUNT}/../account-${OTHER}/a.pdf`, ACCOUNT)
    ).toBe(false);
    expect(pathBelongsToAccount(`account-${ACCOUNT}/./a.pdf`, ACCOUNT)).toBe(false);
  });

  it('refuses a prefix that merely starts with the account id', () => {
    // `account-<id>extra` must not pass as `account-<id>`.
    expect(pathBelongsToAccount(`account-${ACCOUNT}extra/a.pdf`, ACCOUNT)).toBe(false);
  });

  it('refuses a bare folder with no object', () => {
    expect(pathBelongsToAccount(`account-${ACCOUNT}`, ACCOUNT)).toBe(false);
  });
});
