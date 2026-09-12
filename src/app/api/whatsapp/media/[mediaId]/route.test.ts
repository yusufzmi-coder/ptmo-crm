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
// ---------------------------------------------------------------------------

// Per-test scenario.
let signedIn = true
let callerRole = 'viewer'
// Rows `messages` returns for the media_url lookup. Empty models "no
// message in MY account references this id" — which is what RLS produces
// for another zone's media, since `messages_select` joins through
// conversations to the caller's account.
let messageRows: Array<{ conversation_id: string }> = []
// What resolveConfig's conversation lookup sees.
let conversationConfigId: string | null = 'cfg-rawang'

const mediaUrlCalls: Array<{ mediaId: string; accessToken: string }> = []
const configSelects: Array<Record<string, unknown>> = []

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

    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val
        if (table === 'whatsapp_config') configSelects.push({ ...filters })
        return api
      },
      order: () => api,
      limit: () => terminal(),
      maybeSingle: () => terminal(),
      then: (resolve: (v: unknown) => unknown) => resolve(terminal()),
    }

    function terminal() {
      switch (table) {
        case 'profiles':
          return {
            data: { account_id: 'acct-1', account_role: callerRole },
            error: null,
          }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'PTMO' }, error: null }
        case 'messages':
          return { data: messageRows, error: null }
        case 'conversations':
          return {
            data: { id: 'conv-1', account_id: 'acct-1', whatsapp_config_id: conversationConfigId },
            error: null,
          }
        case 'whatsapp_config':
          return {
            data: {
              id: filters.id ?? 'cfg-rawang',
              account_id: 'acct-1',
              phone_number_id: 'pn-rawang',
              access_token: 'tok-rawang',
              is_primary: false,
            },
            error: null,
          }
        default:
          return { data: null, error: null }
      }
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
    from: (table: string) => builder(table),
  }
}

async function call(mediaId = '1234567890123456') {
  const { GET } = await import('./route')
  return GET(new Request('http://localhost/api/whatsapp/media/' + mediaId), {
    params: Promise.resolve({ mediaId }),
  })
}

beforeEach(() => {
  vi.resetModules()
  signedIn = true
  callerRole = 'viewer'
  messageRows = [{ conversation_id: 'conv-1' }]
  conversationConfigId = 'cfg-rawang'
  mediaUrlCalls.length = 0
  configSelects.length = 0
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
    // bytes is the one that received them.
    expect(mediaUrlCalls[0].accessToken).toBe('plain:tok-rawang')
    expect(
      configSelects.some((f) => f.id === 'cfg-rawang' && f.account_id === 'acct-1')
    ).toBe(true)
  })

  it('marks the response private so a shared cache cannot serve it on', async () => {
    const res = await call()
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400')
    expect(res.headers.get('Cache-Control')).not.toContain('public')
  })

  it('allows a viewer — reading an attachment is a read', async () => {
    callerRole = 'viewer'
    expect((await call()).status).toBe(200)
  })
})
