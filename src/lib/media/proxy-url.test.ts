import { describe, expect, it } from 'vitest';

import {
  accountFolder,
  isProxyableBucket,
  mediaProxyPath,
  parseLegacyPublicUrl,
  parseMediaProxyPath,
  pathBelongsToAccount,
  resolveStoredMediaUrl,
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

// ============================================================
// Legacy compatibility (migrations 047 + 050)
//
// Before 047 the buckets were public and `messages.media_url` stored an
// absolute `getPublicUrl()` string. Those rows still exist. These tests
// pin the contract that keeps them readable — and, just as importantly,
// the contract that stops the same code path being used to point the
// media proxy at somebody else's server.
// ============================================================

const LEGACY_HOST = 'demo.supabase.co';
const LEGACY = `https://${LEGACY_HOST}/storage/v1/object/public/chat-media/account-${ACCOUNT}/1736-foto.jpg`;

describe('parseLegacyPublicUrl', () => {
  it('recovers bucket and path from a pre-047 public URL', () => {
    expect(parseLegacyPublicUrl(LEGACY, LEGACY_HOST)).toEqual({
      bucket: 'chat-media',
      objectPath: `account-${ACCOUNT}/1736-foto.jpg`,
    });
  });

  it('decodes a percent-encoded filename', () => {
    const url = `https://${LEGACY_HOST}/storage/v1/object/public/chat-media/account-${ACCOUNT}/surat%20ibu%20bapa%20%233.pdf`;
    expect(parseLegacyPublicUrl(url, LEGACY_HOST)?.objectPath).toBe(
      `account-${ACCOUNT}/surat ibu bapa #3.pdf`
    );
  });

  it('accepts every proxyable bucket and nothing else', () => {
    for (const bucket of ['chat-media', 'flow-media', 'avatars']) {
      const url = `https://${LEGACY_HOST}/storage/v1/object/public/${bucket}/a/b.png`;
      expect(parseLegacyPublicUrl(url, LEGACY_HOST)?.bucket).toBe(bucket);
    }
    // A bucket the proxy does not serve must not be resolvable through it.
    expect(
      parseLegacyPublicUrl(
        `https://${LEGACY_HOST}/storage/v1/object/public/backups/dump.sql`,
        LEGACY_HOST
      )
    ).toBeNull();
  });

  it('refuses a URL pointing at a different host', () => {
    // The whole point: a value in the database must not be able to name
    // an arbitrary origin and have us treat it as our own storage.
    const foreign = `https://evil.example.com/storage/v1/object/public/chat-media/account-${ACCOUNT}/x.jpg`;
    expect(parseLegacyPublicUrl(foreign, LEGACY_HOST)).toBeNull();
  });

  it('refuses anything that is not an http(s) URL', () => {
    for (const value of [
      null,
      undefined,
      '',
      '/api/media/chat-media/a/b.jpg',
      'account-x/y.jpg',
      `javascript:alert(1)//storage/v1/object/public/chat-media/a/b`,
      `file:///storage/v1/object/public/chat-media/a/b`,
    ]) {
      expect(parseLegacyPublicUrl(value as string | null, LEGACY_HOST)).toBeNull();
    }
  });

  it('refuses a public URL with no object path after the bucket', () => {
    expect(
      parseLegacyPublicUrl(
        `https://${LEGACY_HOST}/storage/v1/object/public/chat-media/`,
        LEGACY_HOST
      )
    ).toBeNull();
  });
});

describe('resolveStoredMediaUrl', () => {
  it('rewrites a legacy public URL onto the proxy', () => {
    expect(resolveStoredMediaUrl(LEGACY)).toBe(
      `/api/media/chat-media/account-${ACCOUNT}/1736-foto.jpg`
    );
  });

  it('round-trips: the rewritten value parses back to the same object', () => {
    const rewritten = resolveStoredMediaUrl(LEGACY)!;
    expect(parseMediaProxyPath(rewritten)).toEqual({
      bucket: 'chat-media',
      objectPath: `account-${ACCOUNT}/1736-foto.jpg`,
    });
  });

  it('leaves a new proxy pointer untouched', () => {
    const pointer = mediaProxyPath('chat-media', `account-${ACCOUNT}/new.jpg`);
    expect(resolveStoredMediaUrl(pointer)).toBe(pointer);
  });

  it('leaves the inbound proxy pointer untouched', () => {
    // Un-mirrored inbound media predates 047 and is unaffected by it.
    expect(resolveStoredMediaUrl('/api/whatsapp/media/wamid-abc')).toBe(
      '/api/whatsapp/media/wamid-abc'
    );
  });

  it('hands back an operator-supplied external URL unchanged', () => {
    // POST /api/v1/messages lets a caller supply their own media_url.
    // It never lived in our buckets, so it is neither rewritten nor
    // routed through the proxy — it is simply not ours to touch.
    const external = 'https://cdn.example.com/brosur.png';
    expect(resolveStoredMediaUrl(external)).toBe(external);
  });

  it('returns null for an absent attachment', () => {
    expect(resolveStoredMediaUrl(null)).toBeNull();
    expect(resolveStoredMediaUrl(undefined)).toBeNull();
    expect(resolveStoredMediaUrl('')).toBeNull();
  });

  it('does not smuggle a traversal through the rewrite', () => {
    // `..` survives into the pointer, and `pathBelongsToAccount` is what
    // refuses it at the route. Assert both halves so neither can be
    // dropped without a test going red.
    const nasty = `https://${LEGACY_HOST}/storage/v1/object/public/chat-media/account-${ACCOUNT}/../account-${OTHER}/x.jpg`;
    const rewritten = resolveStoredMediaUrl(nasty)!;
    const parsed = parseMediaProxyPath(rewritten)!;
    expect(pathBelongsToAccount(parsed.objectPath, ACCOUNT)).toBe(false);
  });
});
