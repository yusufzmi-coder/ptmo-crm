import { describe, it, expect, vi, beforeEach } from 'vitest'

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    // Result the message upsert's .select() resolves to. A genuine insert
    // returns the row; a replayed delivery conflicts and returns [].
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    /** Row `lookupInternalIdByMetaId` resolves for a `context.id`. */
    replyContextParent: null as { id: string } | null,
    conversation: { id: 'conv-1', unread_count: 0, account_id: 'acc-1' },
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    afterCallbacks: [] as (() => Promise<void> | void)[],
    automationStarted: 0,
    automationCompleted: 0,
    /** whatsapp_config.mirror_inbound_media for the matched row (#466). */
    mirrorInboundMedia: true as boolean | undefined,
    /** Objects the inbound-media mirror pushed into chat-media. */
    storageUploads: [] as {
      bucket: string
      path: string
      options: { contentType?: string }
    }[],
    /** Error the next storage upload resolves with, if any. */
    storageUploadError: null as { message: string } | null,

    // ---- status-update path (f9bbaf0) --------------------------
    // Rows carry their owning account, and the stubs below apply the
    // account filter the code is supposed to send. A query that forgets
    // it therefore sees BOTH accounts' rows — which is exactly the bug,
    // so a lax caller fails the test instead of passing on a lax stub.
    statusMessages: [] as {
      id: string
      account_id: string
      conversation_id: string
    }[],
    statusRecipients: [] as {
      id: string
      status: string
      account_id: string
    }[],
    /** `{ status }` written to messages, and the ids it was applied to. */
    statusMessageUpdate: null as { row: Record<string, unknown>; ids: unknown } | null,
    /** `{ status, … }` written to broadcast_recipients, and the row id. */
    statusRecipientUpdate: null as { row: Record<string, unknown>; id: unknown } | null,
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [
                    {
                      id: 'cfg-1',
                      account_id: 'acc-1',
                      user_id: 'user-1',
                      access_token: 'enc',
                      mirror_inbound_media: h.state.mirrorInboundMedia,
                    },
                  ],
                  error: null,
                }),
            }),
          }
        case 'conversations': {
          // findOrCreateConversation runs up to four shapes since
          // migrations 040/042: the number-scoped lookup, the
          // `.is(null)` orphan lookup, the `.is(null)`-guarded adoption
          // UPDATE, and the insert. A flat chainable builder serves all
          // of them; `.is()` is what tells the orphan path apart.
          let nullFiltered = false
          let mode: 'select' | 'update' | 'insert' = 'select'
          const c: Record<string, unknown> = {
            select: () => c,
            eq: () => c,
            order: () => c,
            is: () => {
              nullFiltered = true
              return c
            },
            update: () => {
              mode = 'update'
              return c
            },
            insert: () => {
              mode = 'insert'
              return c
            },
            limit: () =>
              Promise.resolve({
                // No unbranded thread by default, so the orphan lookup
                // misses and the scoped lookup answers with the canned
                // conversation — the pre-040 behaviour these tests assume.
                data: nullFiltered ? [] : [h.state.conversation],
                error: null,
              }),
            single: () =>
              Promise.resolve({ data: h.state.conversation, error: null }),
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conversation, error: null }),
            // The adoption UPDATE ends on a bare-awaited `.select()`.
            then: (resolve: (v: unknown) => unknown) =>
              resolve({
                data: mode === 'update' ? [] : [h.state.conversation],
                error: null,
              }),
          }
          return c
        }
        case 'broadcast_recipients': {
          // Two readers now. flagBroadcastReplyIfAny ends on
          // .in().order().limit(); the status mirror ends on
          // .eq('broadcasts.account_id', …).limit(1). The embedded-FK
          // filter is applied here rather than ignored, so a caller
          // that drops it sees every account's rows.
          const filters: Record<string, unknown> = {}
          let sawIn = false
          const r: Record<string, unknown> = {
            select: () => r,
            eq: (col: string, val: unknown) => {
              filters[col] = val
              return r
            },
            in: () => {
              sawIn = true
              return r
            },
            order: () => r,
            update: (row: Record<string, unknown>) => {
              h.state.statusRecipientUpdate = { row, id: null }
              return r
            },
            limit: (n?: number) => {
              if (sawIn) return Promise.resolve({ data: [], error: null })
              const scope = filters['broadcasts.account_id']
              const rows = h.state.statusRecipients.filter(
                (row) => scope === undefined || row.account_id === scope,
              )
              return Promise.resolve({
                data: rows
                  .slice(0, n ?? rows.length)
                  .map(({ id, status }) => ({ id, status })),
                error: null,
              })
            },
            // The recipient UPDATE ends on a bare-awaited `.eq('id', …)`.
            then: (resolve: (v: unknown) => unknown) => {
              if (h.state.statusRecipientUpdate) {
                h.state.statusRecipientUpdate.id = filters['id']
              }
              return resolve({ data: null, error: null })
            },
          }
          return r
        }
        case 'messages': {
          // Four chains land here now, told apart by the select string
          // and the count option:
          //   head          -> priorCustomerMsgCount
          //   'id, conversations!inner(...)'              -> status mirror
          //   'conversation_id, conversations!inner(...)' -> webhook fan-out
          //   otherwise                                   -> reply-context parent
          const filters: Record<string, unknown> = {}
          let shape: 'count' | 'mirror' | 'fanout' | 'parent' = 'parent'

          const m: Record<string, unknown> = {
            select: (columns: string, options?: { head?: boolean }) => {
              if (options?.head) shape = 'count'
              else if (typeof columns === 'string' && columns.includes('conversations!inner')) {
                shape = columns.trimStart().startsWith('conversation_id')
                  ? 'fanout'
                  : 'mirror'
              }
              return m
            },
            eq: (col: string, val: unknown) => {
              filters[col] = val
              return m
            },
            limit: (n?: number) => {
              const r = rows()
              return Promise.resolve({
                data: r.data.slice(0, n ?? r.data.length),
                error: r.error,
              })
            },
            maybeSingle: () =>
              Promise.resolve({ data: h.state.replyContextParent, error: null }),
            update: (row: Record<string, unknown>) => {
              h.state.statusMessageUpdate = { row, ids: null }
              return m
            },
            in: (_col: string, ids: unknown) => {
              if (h.state.statusMessageUpdate) {
                h.state.statusMessageUpdate.ids = ids
              }
              return Promise.resolve({ data: null, error: null })
            },
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options })
              return {
                select: () =>
                  Promise.resolve({
                    data: h.state.messageUpsertResult,
                    error: null,
                  }),
              }
            },
            then: (resolve: (v: unknown) => unknown) => {
              if (shape === 'count') {
                return resolve({
                  count: h.state.priorCustomerMsgCount,
                  error: null,
                })
              }
              return resolve(rows())
            },
          }

          // Honour the embedded-FK account filter exactly as PostgREST
          // would. Omitting it is the leak these tests exist to catch.
          function rows() {
            const scope = filters['conversations.account_id']
            const matched = h.state.statusMessages.filter(
              (row) => scope === undefined || row.account_id === scope,
            )
            return {
              data: matched.map((row) =>
                shape === 'fanout'
                  ? { conversation_id: row.conversation_id }
                  : { id: row.id },
              ),
              error: null,
            }
          }

          return m
        }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
    // Service-role Storage, used by the inbound-media mirror (#466).
    storage: {
      from(bucket: string) {
        return {
          upload: (
            path: string,
            _body: unknown,
            options: { contentType?: string },
          ) => {
            h.state.storageUploads.push({ bucket, path, options })
            return Promise.resolve({ error: h.state.storageUploadError })
          },
          // No `getPublicUrl` stub: migration 047 made the bucket
          // private, so the mirror must not build a public URL. Leaving
          // it out means a reintroduced call fails loudly here instead of
          // persisting a link that 400s.
        }
      },
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: () => false,
  handleTemplateWebhookChange: vi.fn(),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))

import { POST } from './route'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

const mockGetMediaUrl = vi.mocked(getMediaUrl)
const mockDownloadMedia = vi.mocked(downloadMedia)

const TEXT_MESSAGE = {
  id: 'wamid.TEST1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello' },
}

function inboundRequest(message: Record<string, unknown> = TEXT_MESSAGE) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts: [{ wa_id: '15551230000', profile: { name: 'Ada' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  }
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request
}

async function runWebhook(message?: Record<string, unknown>) {
  const res = await POST(inboundRequest(message))
  // Drain the after() callback exactly as the runtime would.
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.priorCustomerMsgCount = 0
  h.state.replyContextParent = null
  h.state.conversation = { id: 'conv-1', unread_count: 0, account_id: 'acc-1' }
  h.state.upsertCalls = []
  h.state.rpcCalls = []
  h.state.afterCallbacks = []
  h.state.automationStarted = 0
  h.state.automationCompleted = 0
  h.state.mirrorInboundMedia = true
  h.state.storageUploads = []
  h.state.storageUploadError = null
  h.state.statusMessages = []
  h.state.statusRecipients = []
  h.state.statusMessageUpdate = null
  h.state.statusRecipientUpdate = null
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  })
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  })
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockImplementation(() => {
    h.state.automationStarted++
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        h.state.automationCompleted++
        resolve()
      }, 0)
    })
  })
})

describe('inbound webhook: idempotent insert (#367)', () => {
  it('a genuine first delivery persists once and fans out downstream', async () => {
    await runWebhook()

    // Inserted via upsert with the (conversation_id, message_id) conflict
    // target — not a bare insert.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].options).toMatchObject({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    })
    // Downstream side effects ran exactly once.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('a replayed delivery is a no-op: no unread bump, no fan-out', async () => {
    // Upsert hits the unique index and returns no row.
    h.state.messageUpsertResult = []

    await runWebhook()

    expect(h.state.upsertCalls).toHaveLength(1)
    // None of the downstream side effects fire on a replay.
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })
})

describe('inbound webhook: atomic unread bump (#369)', () => {
  it('increments unread through the DB-side RPC, not a read-modify-write', async () => {
    await runWebhook()

    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'bump_conversation_on_inbound',
      args: { p_conversation_id: 'conv-1' },
    })
  })
})

describe('inbound webhook: template quick-reply buttons (#478)', () => {
  // A customer tapping a QUICK_REPLY button on a broadcast template.
  // `context.id` points at the template message we sent — which the
  // broadcast path never wrote to `messages`, so the parent lookup
  // legitimately misses and the reply is stored unquoted.
  const templateButtonTap = {
    id: 'wamid.BTN1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'button',
    button: { text: 'Yes, interested', payload: 'YES_INTERESTED' },
    context: { id: 'wamid.BROADCAST1' },
  }

  it('stores the tap as an interactive reply, not an unsupported message', async () => {
    await runWebhook(templateButtonTap)

    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Yes, interested',
      interactive_reply_id: 'YES_INTERESTED',
      reply_to_message_id: null,
    })
  })

  it('routes the tap to flows and fires the interactive_reply trigger', async () => {
    await runWebhook(templateButtonTap)

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'YES_INTERESTED',
          reply_title: 'Yes, interested',
          meta_message_id: 'wamid.BTN1',
        },
      }),
    )
    const triggers = h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType,
    )
    expect(triggers).toContain('interactive_reply')
    // The AI auto-reply must stay out of it — a button tap is not a
    // free-text question.
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('falls back to the label when the template button carries no payload', async () => {
    await runWebhook({
      ...templateButtonTap,
      button: { text: 'Track my order' },
    })

    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Track my order',
      interactive_reply_id: 'Track my order',
    })
  })
})

describe('inbound webhook: inbound media is mirrored (#466)', () => {
  const IMAGE_MESSAGE = {
    id: 'wamid.IMG1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'image',
    image: { id: '1234567890123456', mime_type: 'image/jpeg', caption: 'hi' },
  }

  it('stores a durable bucket pointer instead of the expiring proxy path', async () => {
    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
    expect(h.state.storageUploads[0].bucket).toBe('chat-media')
    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
    )
    expect(h.state.upsertCalls[0].row).toMatchObject({
      // Our own copy, reached through the authenticated media route. Not
      // a public URL: 047 made `chat-media` private, and this column is
      // persisted, so a public URL would be a stored link that 400s for
      // every attachment ever received.
      media_url:
        '/api/media/chat-media/account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
      // Meta's MIME type used to be discarded outright (`void mediaType`).
      media_type: 'image/jpeg',
    })
    // Still not the Meta proxy — that is the expiring path this mirror
    // exists to replace, and the fallback test below covers when it IS
    // used.
    expect(h.state.upsertCalls[0].row.media_url).not.toContain(
      '/api/whatsapp/media/',
    )
  })

  it('falls back to the proxy URL when the upload is refused', async () => {
    h.state.storageUploadError = { message: 'mime type not supported' }

    await runWebhook(IMAGE_MESSAGE)

    // The message still lands, and it still lands with a usable URL —
    // the mirror failing must never cost us the message.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      media_type: 'image/jpeg',
    })
  })

  it('falls back to the proxy URL when the download from Meta throws', async () => {
    mockDownloadMedia.mockRejectedValueOnce(new Error('Media download failed: 404'))

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
    })
  })

  it('skips media larger than the bucket accepts, without downloading it', async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/big',
      mimeType: 'application/pdf',
      fileSize: 40 * 1024 * 1024,
    })

    await runWebhook({
      id: 'wamid.DOC1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '999',
        mime_type: 'application/pdf',
        filename: 'huge.pdf',
      },
    })

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/999',
      media_type: 'application/pdf',
    })
  })

  it("names the object after a document's own filename", async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/doc',
      mimeType: 'application/pdf',
      fileSize: 4096,
    })
    mockDownloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(4096),
      contentType: 'application/pdf',
    })

    await runWebhook({
      id: 'wamid.DOC2',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '1234567890123456',
        mime_type: 'application/pdf',
        filename: 'invoice.pdf',
        caption: 'have a look',
      },
    })

    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-invoice.pdf',
    )
  })

  it('does not mirror when the account has opted out', async () => {
    h.state.mirrorInboundMedia = false

    await runWebhook(IMAGE_MESSAGE)

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      // Still recorded — the MIME type costs nothing and makes the
      // download name right even for proxied media.
      media_type: 'image/jpeg',
    })
  })

  it('mirrors when the column is absent, e.g. a row read before migration 039', async () => {
    h.state.mirrorInboundMedia = undefined

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
  })

  it('leaves text messages alone', async () => {
    await runWebhook()

    expect(mockGetMediaUrl).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({ media_type: null })
  })
})

describe('inbound webhook: after() awaits automations (#368)', () => {
  it('every triggered automation settles before the after() callback resolves', async () => {
    await runWebhook()

    // first_inbound_message + new_message_received + keyword_match.
    expect(h.state.automationStarted).toBe(3)
    // If the dispatches were fire-and-forget, completed would still be 0
    // here — the callback would have resolved before the timers fired.
    expect(h.state.automationCompleted).toBe(3)
  })
})

// ============================================================
// Status updates carry an account (f9bbaf0).
//
// `messages.message_id` is deliberately NOT unique — Meta reuses wamids
// across numbers (migration 009) — and `messages` carries no account_id
// of its own. So a status handler that matches on the wamid alone
// touches 0..N rows spanning any number of accounts. With sixteen
// branches under one roof and a shared inbox, collisions are ordinary,
// not exotic.
//
// The stubs above apply the account filter the code is supposed to
// send. A query that forgets it sees BOTH accounts' rows, so these
// tests fail on the bug rather than passing on a lax double.
// ============================================================

function statusRequest(
  status: Record<string, unknown>,
  metadata: Record<string, unknown> | null = { phone_number_id: 'pn-1' },
) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'statuses',
            value: {
              ...(metadata ? { metadata } : {}),
              statuses: [status],
            },
          },
        ],
      },
    ],
  }
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request
}

const DELIVERED = {
  id: 'wamid.SHARED',
  status: 'delivered',
  timestamp: '1700000000',
  recipient_id: '15551230000',
}

async function runStatus(
  status: Record<string, unknown> = DELIVERED,
  metadata?: Record<string, unknown> | null,
) {
  const res = await POST(statusRequest(status, metadata))
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

describe('inbound webhook: status updates are scoped to their account', () => {
  it('updates only the row belonging to the number the event arrived on', async () => {
    // The same wamid exists in two accounts. Only ours may move.
    h.state.statusMessages = [
      { id: 'msg-ours', account_id: 'acc-1', conversation_id: 'conv-1' },
      { id: 'msg-theirs', account_id: 'acc-2', conversation_id: 'conv-9' },
    ]

    await runStatus()

    expect(h.state.statusMessageUpdate?.row).toMatchObject({
      status: 'delivered',
    })
    // Not "contains ours" — exactly ours. A write that also carries
    // msg-theirs has already corrupted another tenant's inbox.
    expect(h.state.statusMessageUpdate?.ids).toEqual(['msg-ours'])
  })

  it('updates the right broadcast recipient when a wamid collides', async () => {
    // The pre-fix code used `.maybeSingle()` here, which ERRORS on >= 2
    // rows. A collision therefore skipped the update in silence and
    // left the parent broadcast's delivered/read counts wrong, with
    // nothing in the logs to say why.
    h.state.statusMessages = [
      { id: 'msg-ours', account_id: 'acc-1', conversation_id: 'conv-1' },
    ]
    // Foreign row FIRST on purpose: `.limit(1)` takes the first match,
    // so an unscoped query would pick rec-theirs and this test bites.
    h.state.statusRecipients = [
      { id: 'rec-theirs', status: 'sent', account_id: 'acc-2' },
      { id: 'rec-ours', status: 'sent', account_id: 'acc-1' },
    ]

    await runStatus()

    expect(h.state.statusRecipientUpdate?.id).toBe('rec-ours')
    expect(h.state.statusRecipientUpdate?.row).toMatchObject({
      status: 'delivered',
    })
  })

  it('drops a status payload that carries no phone_number_id', async () => {
    // Without metadata there is no number, so no account — and a
    // handler that proceeds anyway is writing without tenancy at all.
    h.state.statusMessages = [
      { id: 'msg-ours', account_id: 'acc-1', conversation_id: 'conv-1' },
    ]
    h.state.statusRecipients = [
      { id: 'rec-ours', status: 'sent', account_id: 'acc-1' },
    ]

    await runStatus(DELIVERED, null)

    expect(h.state.statusMessageUpdate).toBeNull()
    expect(h.state.statusRecipientUpdate).toBeNull()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it("fans out once, to the event's own account, when a wamid collides", async () => {
    // The worst of the four. This path does not mis-write a row — it
    // hands a status event to webhook SUBSCRIBERS, so a collision
    // delivers one account's data OUT to a third party's endpoint.
    // Foreign row first, for the same reason as above.
    h.state.statusMessages = [
      { id: 'msg-theirs', account_id: 'acc-2', conversation_id: 'conv-theirs' },
      { id: 'msg-ours', account_id: 'acc-1', conversation_id: 'conv-ours' },
    ]

    await runStatus()

    // Exactly once: dispatching twice with one correct call still leaks
    // the other.
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    const [, accountId, event, payload] = h.dispatchWebhookEvent.mock
      .calls[0] as unknown as [unknown, string, string, Record<string, unknown>]
    expect(accountId).toBe('acc-1')
    expect(event).toBe('message.status_updated')
    expect(payload.conversation_id).toBe('conv-ours')
  })
})
