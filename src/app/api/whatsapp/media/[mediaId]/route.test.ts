import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// The authorization on this route IS the route. Before the fix it checked
// only that the caller had an account, then handed any `mediaId` from the
// URL to Meta using the account's PRIMARY token — so any authenticated
// user, `viewer` included, could pull any centre's attachment by guessing
// an id, and with the wrong centre's credential.
//
// These tests pin the two things that stopped that: a message in the
// caller's own account must reference the media id, and the token must come
// from that message's conversation.
//
// The second group pins the hardening on top of that: the id is checked
// before it is used, the zone rule is stated in the handler as well as in
// RLS, and a thread with no number is an error rather than a guess.
// ---------------------------------------------------------------------------

// Per-test scenario.
let signedIn = true
let callerRole = 'viewer'
// Rows `messages` returns for the media_url lookup. Empty models "no
// message in MY account references this id" — which is what RLS produces
// for another zone's media, since `messages_select` joins through
// conversations to the caller's account.
let messageRows: Array<Record<string, unknown>> = []
// The conversation row, as the database holds it. The stub applies the
// handler's filters to it, so giving it another zone's `account_id` models
// exactly what an RLS gap would produce: the message is visible, the
// conversation is not the caller's.
let conversationRow: Record<string, unknown> | null = null
// Every number the account holds. More than one is what makes a numberless
// thread ambiguous rather than obvious.
let configRows: Array<Record<string, unknown>> = []

const mediaUrlCalls: Array<{ mediaId: string; accessToken: string }> = []
const configSelects: Array<Record<string, unknown>> = []
const tablesQueried: string[] = []

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(async (args: { mediaId: string; accessToken: string }) => {
    mediaUrlCalls.push(args)
    return { url: 'https://lookaside.meta/x', mimeType: 'image/jpeg', fileSize: 10 }
  }),
  downloadMedia: vi.fn(async () => ({
    buffer: Buffer.from([1, 2, 3]),
    contentType: 'image/jpeg',
  })),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeSupabaseMock(),
}))

function makeSupabaseMock() {
  function builder(table: string) {
    const filters: Record<string, unknown> = {}

    // Rows the table holds, before the call's own filters are applied.
    const held = (): Array<Record<string, unknown>> => {
      switch (table) {
        case 'profiles':
          return [{ user_id: 'user-1', account_id: 'acct-1', account_role: callerRole }]
        case 'accounts':
          return [{ id: 'acct-1', name: 'PTMO' }]
        case 'messages':
          return messageRows
        case 'conversations':
          return conversationRow ? [conversationRow] : []
        case 'whatsapp_config':
          return configRows
        default:
          return []
      }
    }

    // Honouring the filters is the point: `.eq('account_id', …)` has to be
    // able to MISS, or the handler's own zone check cannot be tested.
    const matching = () =>
      held().filter((row) =>
        Object.entries(filters).every(([col, val]) => row[col] === val)
      )

    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val
        if (table === 'whatsapp_config') configSelects.push({ ...filters })
        return api
      },
      order: () => api,
      limit: (n: number) => Promise.resolve({ data: matching().slice(0, n), error: null }),
      maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: matching(), error: null }),
    }

    return api
  }

  return {
    auth: {
      getUser: async () =>
        signedIn
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: { message: 'no session' } },
    },
    from: (table: string) => {
      tablesQueried.push(table)
      return builder(table)
    },
  }
}

const rawang = {
  id: 'cfg-rawang',
  account_id: 'acct-1',
  phone_number_id: 'pn-rawang',
  access_token: 'tok-rawang',
  is_primary: false,
}

const batuCaves = {
  id: 'cfg-batu-caves',
  account_id: 'acct-1',
  phone_number_id: 'pn-batu-caves',
  access_token: 'tok-batu-caves',
  is_primary: true,
}

const MEDIA_ID = '1234567890123456'

async function call(mediaId = MEDIA_ID) {
  const { GET } = await import('./route')
  return GET(new Request('http://localhost/api/whatsapp/media/' + mediaId), {
    params: Promise.resolve({ mediaId }),
  })
}

beforeEach(() => {
  vi.resetModules()
  signedIn = true
  callerRole = 'viewer'
  messageRows = [
    { conversation_id: 'conv-1', media_url: `/api/whatsapp/media/${MEDIA_ID}` },
  ]
  conversationRow = {
    id: 'conv-1',
    account_id: 'acct-1',
    whatsapp_config_id: 'cfg-rawang',
  }
  configRows = [rawang, batuCaves]
  mediaUrlCalls.length = 0
  configSelects.length = 0
  tablesQueried.length = 0
})

describe('GET /api/whatsapp/media/[mediaId]', () => {
  it('refuses an unauthenticated caller', async () => {
    signedIn = false
    const res = await call()
    expect(res.status).toBe(401)
    expect(mediaUrlCalls).toHaveLength(0)
  })

  it('404s when no message in the caller\'s account references the id', async () => {
    // This is the IDOR case. RLS returns no row for another zone's media,
    // so the handler must stop here — and must not reach Meta, because
    // reaching Meta at all is what leaked the bytes.
    messageRows = []
    const res = await call('9999999999')
    expect(res.status).toBe(404)
    expect(mediaUrlCalls).toHaveLength(0)
  })

  it('does not leak existence through the status code', async () => {
    // 403 would confirm the media exists somewhere in the project.
    messageRows = []
    const res = await call()
    expect(res.status).not.toBe(403)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('serves the bytes when the caller\'s account owns the message', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("uses the thread's own centre token, not the primary's", async () => {
    await call()
    expect(mediaUrlCalls).toHaveLength(1)
    // Resolved through the conversation, so the credential that fetches the
    // bytes is the one that received them. Batu Caves is this account's
    // primary and must not be what pays for a Rawang thread's attachment.
    expect(mediaUrlCalls[0].accessToken).toBe('plain:tok-rawang')
    expect(
      configSelects.some((f) => f.id === 'cfg-rawang' && f.account_id === 'acct-1')
    ).toBe(true)
  })

  it('marks the response private so a shared cache cannot serve it on', async () => {
    const res = await call()
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Cache-Control')).not.toContain('public')
    // And no disk copy either: these bytes outliving a zone switch on a
    // shared device is the case `private` alone does not cover.
    expect(res.headers.get('Cache-Control')).not.toContain('max-age=86400')
  })

  it('allows a viewer — reading an attachment is a read', async () => {
    callerRole = 'viewer'
    expect((await call()).status).toBe(200)
  })
})

describe('GET /api/whatsapp/media/[mediaId] — hardening', () => {
  it('404s when the message is visible but its conversation is another zone\'s', async () => {
    // Models an RLS gap rather than today's behaviour: the message row
    // comes back, but the conversation belongs to Zone B. The handler's
    // own `account_id` check is the thing under test, and it is what keeps
    // a future widening of `is_account_member` from being silent.
    conversationRow = {
      id: 'conv-1',
      account_id: 'acct-2',
      whatsapp_config_id: 'cfg-rawang',
    }

    const res = await call()

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
    expect(mediaUrlCalls).toHaveLength(0)
  })

  it('rejects a media id that is not one, before any lookup', async () => {
    const res = await call('../../me/accounts')

    expect(res.status).toBe(400)
    // Nothing reached Meta, and nothing reached the database either — the
    // id never becomes part of a Graph URL or a PostgREST filter.
    expect(mediaUrlCalls).toHaveLength(0)
    expect(tablesQueried).not.toContain('messages')
  })

  it('still serves a pre-040 thread when the account has one number', async () => {
    // No `allowPrimary` needed for this: `resolveConfig` already falls back
    // to the account's only number, so single-number accounts are untouched
    // by dropping it.
    conversationRow = { id: 'conv-1', account_id: 'acct-1', whatsapp_config_id: null }
    configRows = [rawang]

    const res = await call()

    expect(res.status).toBe(200)
    expect(mediaUrlCalls[0].accessToken).toBe('plain:tok-rawang')
  })

  it('refuses to guess when a numberless thread sits on a multi-number account', async () => {
    // The case `allowPrimary: true` used to swallow. Ownership is already
    // proven here, so this is not a security hole either way — it is about
    // not teaching the system that the primary's token fetches everything.
    conversationRow = { id: 'conv-1', account_id: 'acct-1', whatsapp_config_id: null }
    configRows = [rawang, batuCaves]

    const res = await call()

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error:
        'This conversation is not linked to a WhatsApp number, so we cannot tell which branch should reply. Open it in the inbox and set the number.',
    })
    expect(mediaUrlCalls).toHaveLength(0)
  })
})
