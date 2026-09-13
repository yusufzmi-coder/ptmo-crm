import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The authorization surface of the media proxy (migration 047).
 *
 * Before 047 these bytes were served by a public bucket with no check at
 * all, so this route IS the access control for every stored attachment.
 * The four cases below are the ones that matter:
 *
 *   1. a legacy pre-047 URL, rewritten, still reaches its object
 *   2. a pointer written by the current code reaches its object
 *   3. a caller with no session is refused
 *   4. a caller from another account is refused, and cannot tell the
 *      difference between "not yours" and "does not exist"
 */

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createSignedUrl: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Unauthorized' }, { status: 401 })
  ),
}));

import { GET } from './route';
import { mediaProxyPath, resolveStoredMediaUrl } from '@/lib/media/proxy-url';

const ACCOUNT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const SIGNED = 'https://demo.supabase.co/storage/v1/object/sign/chat-media/x?token=abc';

function contextFor(accountId: string) {
  return {
    accountId,
    userId: 'user-1',
    role: 'agent',
    account: { id: accountId, name: 'Zon Ujian' },
    supabase: {
      storage: {
        from: (bucket: string) => ({
          createSignedUrl: (path: string, ttl: number) =>
            mocks.createSignedUrl(bucket, path, ttl),
        }),
      },
    },
  };
}

/** Split a stored pointer into the dynamic segments Next would hand us. */
function paramsFor(pointer: string) {
  const rest = pointer.replace('/api/media/', '');
  const [bucket, ...path] = rest.split('/');
  return {
    // Next percent-decodes each dynamic segment before the handler sees it.
    params: Promise.resolve({ bucket, path: path.map(decodeURIComponent) }),
  };
}

function request(pointer: string) {
  return new Request(`http://localhost${pointer}`);
}

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.createSignedUrl.mockReset();
  mocks.requireRole.mockResolvedValue(contextFor(ACCOUNT));
  mocks.createSignedUrl.mockResolvedValue({
    data: { signedUrl: SIGNED },
    error: null,
  });
});

describe('GET /api/media/[bucket]/[...path]', () => {
  it('serves an object behind a pointer written by the current code', async () => {
    const pointer = mediaProxyPath('chat-media', `account-${ACCOUNT}/1736-foto.jpg`);

    const res = await GET(request(pointer), paramsFor(pointer));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(SIGNED);
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(
      'chat-media',
      `account-${ACCOUNT}/1736-foto.jpg`,
      60
    );
  });

  it('serves an object behind a rewritten pre-047 URL', async () => {
    // The exact path a legacy row takes: an absolute public URL stored
    // before 047, mapped by resolveStoredMediaUrl, then requested.
    const legacy = `https://demo.supabase.co/storage/v1/object/public/chat-media/account-${ACCOUNT}/surat%20ibu%20bapa.pdf`;
    const pointer = resolveStoredMediaUrl(legacy)!;

    const res = await GET(request(pointer), paramsFor(pointer));

    expect(res.status).toBe(307);
    // The signed object must be the original file, space and all — a
    // path that stayed encoded here would sign an object that does not
    // exist and the attachment would still be unreadable.
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(
      'chat-media',
      `account-${ACCOUNT}/surat ibu bapa.pdf`,
      60
    );
  });

  it('refuses a caller with no session', async () => {
    mocks.requireRole.mockRejectedValue(new Error('not signed in'));
    const pointer = mediaProxyPath('chat-media', `account-${ACCOUNT}/1736-foto.jpg`);

    const res = await GET(request(pointer), paramsFor(pointer));

    expect(res.status).toBe(401);
    // Nothing may be signed for a caller we could not identify.
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a caller from another account, without confirming the file exists', async () => {
    const pointer = mediaProxyPath('chat-media', `account-${OTHER}/rahsia.pdf`);

    const res = await GET(request(pointer), paramsFor(pointer));

    // 404, not 403: a 403 would confirm that the object exists in some
    // other zone, which is itself a leak.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a traversal out of the caller account folder', async () => {
    const pointer = mediaProxyPath(
      'chat-media',
      `account-${ACCOUNT}/../account-${OTHER}/rahsia.pdf`
    );

    const res = await GET(request(pointer), paramsFor(pointer));

    expect(res.status).toBe(404);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a bucket the proxy does not serve', async () => {
    const res = await GET(
      request('/api/media/backups/dump.sql'),
      { params: Promise.resolve({ bucket: 'backups', path: ['dump.sql'] }) }
    );

    expect(res.status).toBe(404);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('reports an RLS refusal as a plain 404', async () => {
    // Belt and braces: even when the folder check passes, Postgres has
    // the final say, and its refusal must not be distinguishable from a
    // missing object.
    mocks.createSignedUrl.mockResolvedValue({
      data: null,
      error: { message: 'new row violates row-level security policy' },
    });
    const pointer = mediaProxyPath('chat-media', `account-${ACCOUNT}/1736-foto.jpg`);

    const res = await GET(request(pointer), paramsFor(pointer));

    expect(res.status).toBe(404);
  });
});
