import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 401 })
  ),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: mocks.getMediaUrl,
  downloadMedia: mocks.downloadMedia,
}));

// The real thing needs a key and gives back bytes; all these tests care
// about is WHICH stored token was handed to it.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (value: string) => `dec:${value}`,
}));

import { GET } from './route';

// ------------------------------------------------------------
// A PostgREST-shaped stub, same shape as the one in
// `src/lib/whatsapp/resolve-config.test.ts` with `messages` added.
//
// It holds only the rows the caller is allowed to see, which is exactly
// what RLS does to this route's client: a message in another zone is
// not a forbidden row, it is an absent one. The cross-zone cases below
// model that by leaving the row out.
// ------------------------------------------------------------
type Row = Record<string, unknown>;

interface Tables {
  messages?: Row[];
  conversations?: Row[];
  whatsapp_config?: Row[];
}

function stubDb(tables: Tables) {
  const make = (rows: Row[]) => {
    const filters: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    const apply = () =>
      rows.filter((r) =>
        Object.entries(filters).every(([k, v]) => r[k] === v)
      );
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return q;
    };
    q.limit = (n: number) =>
      Promise.resolve({ data: apply().slice(0, n), error: null });
    q.maybeSingle = () =>
      Promise.resolve({ data: apply()[0] ?? null, error: null });
    return q;
  };
  return {
    from: (table: string) => make(tables[table as keyof Tables] ?? []),
  } as never;
}

const MEDIA_ID = '1234567890123456';
const POINTER = `/api/whatsapp/media/${MEDIA_ID}`;

/** Zone A holds two centres; Batu Caves is the primary. */
const batuCaves = {
  id: 'cfg-bc',
  account_id: 'acc-a',
  phone_number_id: '60100000001',
  waba_id: 'waba-a',
  access_token: 'token-batu-caves',
  status: 'connected',
  label: 'Batu Caves',
  is_primary: true,
};

const rawang = {
  ...batuCaves,
  id: 'cfg-rw',
  phone_number_id: '60100000002',
  access_token: 'token-rawang',
  label: 'Rawang',
  is_primary: false,
};

/** The thread the attachment hangs off — on Rawang, not the primary. */
const conversation = {
  id: 'conv-1',
  account_id: 'acc-a',
  whatsapp_config_id: 'cfg-rw',
};

const message = { id: 'msg-1', conversation_id: 'conv-1', media_url: POINTER };

function context(db: unknown) {
  return {
    supabase: db,
    accountId: 'acc-a',
    userId: 'user-1',
    role: 'viewer',
    account: { id: 'acc-a', name: 'Zon A' },
  };
}

const request = () => new Request(`http://localhost${POINTER}`);
const params = (mediaId = MEDIA_ID) => ({
  params: Promise.resolve({ mediaId }),
});

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.getMediaUrl.mockReset();
  mocks.downloadMedia.mockReset();

  mocks.getMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fb/media-1',
    mimeType: 'image/jpeg',
    fileSize: 1024,
  });
  mocks.downloadMedia.mockResolvedValue({
    buffer: Buffer.from('jpeg-bytes'),
    contentType: 'image/jpeg',
  });
});

describe('GET /api/whatsapp/media/[mediaId] — you may only fetch your own zone', () => {
  it('404s when the media belongs to a conversation in another zone', async () => {
    // What the caller's RLS-scoped client sees of Zone B's attachment:
    // nothing. Zone B's numbers are not visible either.
    mocks.requireRole.mockResolvedValue(
      context(stubDb({ messages: [], conversations: [], whatsapp_config: [batuCaves, rawang] }))
    );

    const response = await GET(request(), params());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Media not found' });
    // The important half: no token was ever spent on it.
    expect(mocks.getMediaUrl).not.toHaveBeenCalled();
  });

  it('404s when the message is visible but its conversation is another zone’s', async () => {
    // Defence in depth: if an RLS change ever let the message row
    // through, the explicit account check still stops the download.
    mocks.requireRole.mockResolvedValue(
      context(
        stubDb({
          messages: [message],
          conversations: [{ ...conversation, account_id: 'acc-b' }],
          whatsapp_config: [batuCaves, rawang],
        })
      )
    );

    const response = await GET(request(), params());

    expect(response.status).toBe(404);
    expect(mocks.getMediaUrl).not.toHaveBeenCalled();
  });

  it('requires a session, and reports the auth failure as-is', async () => {
    mocks.requireRole.mockRejectedValue(new Error('no session'));

    const response = await GET(request(), params());

    expect(response.status).toBe(401);
    expect(mocks.getMediaUrl).not.toHaveBeenCalled();
  });

  it('asks for the lowest role rather than none at all', async () => {
    mocks.requireRole.mockResolvedValue(
      context(stubDb({ messages: [message], conversations: [conversation], whatsapp_config: [batuCaves, rawang] }))
    );

    await GET(request(), params());

    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
  });

  it('rejects a media id that is not one, before touching the database', async () => {
    const db = stubDb({ messages: [message] });
    const from = vi.spyOn(db as unknown as { from: () => unknown }, 'from');
    mocks.requireRole.mockResolvedValue(context(db));

    const response = await GET(request(), params('../../secret'));

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
});

describe('GET /api/whatsapp/media/[mediaId] — the thread picks the number', () => {
  it("uses the conversation's own centre, not the account primary", async () => {
    mocks.requireRole.mockResolvedValue(
      context(
        stubDb({
          messages: [message],
          conversations: [conversation],
          whatsapp_config: [batuCaves, rawang],
        })
      )
    );

    const response = await GET(request(), params());

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    // Rawang's token — Batu Caves is primary and must NOT be what pays
    // for this download. This is the regression test for `allowPrimary`.
    expect(mocks.getMediaUrl).toHaveBeenCalledWith({
      mediaId: MEDIA_ID,
      accessToken: 'dec:token-rawang',
    });
    expect(mocks.downloadMedia).toHaveBeenCalledWith({
      downloadUrl: 'https://lookaside.fb/media-1',
      accessToken: 'dec:token-rawang',
    });
  });

  it('never lets the bytes into a shared cache', async () => {
    mocks.requireRole.mockResolvedValue(
      context(
        stubDb({
          messages: [message],
          conversations: [conversation],
          whatsapp_config: [batuCaves, rawang],
        })
      )
    );

    const response = await GET(request(), params());

    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('still serves a pre-040 thread when the account has one number', async () => {
    mocks.requireRole.mockResolvedValue(
      context(
        stubDb({
          messages: [message],
          conversations: [{ ...conversation, whatsapp_config_id: null }],
          whatsapp_config: [batuCaves],
        })
      )
    );

    const response = await GET(request(), params());

    expect(response.status).toBe(200);
    expect(mocks.getMediaUrl).toHaveBeenCalledWith({
      mediaId: MEDIA_ID,
      accessToken: 'dec:token-batu-caves',
    });
  });

  it('refuses to guess when a numberless thread sits on a multi-number account', async () => {
    mocks.requireRole.mockResolvedValue(
      context(
        stubDb({
          messages: [message],
          conversations: [{ ...conversation, whatsapp_config_id: null }],
          whatsapp_config: [batuCaves, rawang],
        })
      )
    );

    const response = await GET(request(), params());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'This conversation is not linked to a WhatsApp number, so we cannot tell which branch should reply. Open it in the inbox and set the number.',
    });
    expect(mocks.getMediaUrl).not.toHaveBeenCalled();
  });
});
