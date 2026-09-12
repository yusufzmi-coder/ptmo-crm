import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  metaFetchableLink,
  OutboundLinkError,
  OUTBOUND_SIGNED_URL_TTL_SECONDS,
} from './outbound-link';

const ACCOUNT = '11111111-1111-1111-1111-111111111111';
const POINTER = `/api/media/chat-media/account-${ACCOUNT}/1736-foto.jpg`;

/**
 * Minimal stand-in for the storage surface. Records what was asked for so
 * the bucket, path and TTL can be asserted — getting any of those wrong
 * produces a link Meta cannot read, which is the failure this module
 * exists to prevent.
 */
function fakeDb(
  result: { signedUrl?: string; error?: { message: string } } = {
    signedUrl: 'https://x.supabase.co/storage/v1/object/sign/chat-media/a?token=abc',
  }
) {
  const calls: { bucket: string; path: string; ttl: number }[] = [];
  const db = {
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl(path: string, ttl: number) {
            calls.push({ bucket, path, ttl });
            return Promise.resolve({
              data: result.signedUrl ? { signedUrl: result.signedUrl } : null,
              error: result.error ?? null,
            });
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe('metaFetchableLink', () => {
  it('signs one of our pointers, with the right bucket and path', async () => {
    const { db, calls } = fakeDb();

    const link = await metaFetchableLink(db, POINTER);

    expect(calls).toHaveLength(1);
    expect(calls[0].bucket).toBe('chat-media');
    expect(calls[0].path).toBe(`account-${ACCOUNT}/1736-foto.jpg`);
    expect(calls[0].ttl).toBe(OUTBOUND_SIGNED_URL_TTL_SECONDS);
    expect(link).toContain('/object/sign/');
  });

  it('leaves an external https URL untouched and signs nothing', async () => {
    // The public API documents media_url as any https URL, so a caller's
    // own CDN link has to survive unmodified.
    const { db, calls } = fakeDb();
    const external = 'https://cdn.example.com/brochure.pdf';

    expect(await metaFetchableLink(db, external)).toBe(external);
    expect(calls).toHaveLength(0);
  });

  it('leaves a legacy absolute public URL untouched', async () => {
    // Rows written before 047 hold one of these. We cannot sign it (we do
    // not know the object path from the URL shape we parse), and rewriting
    // it would be a guess.
    const { db, calls } = fakeDb();
    const legacy =
      'https://x.supabase.co/storage/v1/object/public/chat-media/account-1/a.jpg';

    expect(await metaFetchableLink(db, legacy)).toBe(legacy);
    expect(calls).toHaveLength(0);
  });

  it('throws rather than handing Meta an unreadable link', async () => {
    // Meta would accept the message, fail the fetch on its own side, and
    // the agent would see a sent bubble the parent never received. Failing
    // the send is the better outcome.
    const { db } = fakeDb({ error: { message: 'Object not found' } });

    await expect(metaFetchableLink(db, POINTER)).rejects.toThrow(OutboundLinkError);
    await expect(metaFetchableLink(db, POINTER)).rejects.toThrow(/Object not found/);
  });

  it('throws when signing succeeds but returns nothing usable', async () => {
    const { db } = fakeDb({});
    await expect(metaFetchableLink(db, POINTER)).rejects.toThrow(
      /no signed URL returned/
    );
  });

  it('keeps the signed-URL lifetime short enough to be a real bound', async () => {
    // The URL grants unauthenticated read of one object to a third party
    // for its whole life, so this is a security parameter, not a tuning
    // knob: long enough for Meta's fetch, not open-ended.
    expect(OUTBOUND_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(60 * 60);
    expect(OUTBOUND_SIGNED_URL_TTL_SECONDS).toBeGreaterThanOrEqual(60);
  });

  it('signs each bucket it is given', async () => {
    const { db, calls } = fakeDb();
    await metaFetchableLink(db, `/api/media/flow-media/account-${ACCOUNT}/v.mp4`);
    expect(calls[0].bucket).toBe('flow-media');
  });

  it('does not reach for storage at all on a non-pointer', async () => {
    // Guards against a future refactor that signs unconditionally and
    // quietly breaks every public-API caller.
    const spy = vi.fn();
    const db = { storage: { from: spy } } as unknown as SupabaseClient;
    await metaFetchableLink(db, 'https://cdn.example.com/x.jpg');
    expect(spy).not.toHaveBeenCalled();
  });
});
