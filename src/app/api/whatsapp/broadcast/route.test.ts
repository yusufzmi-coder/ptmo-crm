import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// The broadcast fan-out route. This endpoint writes nothing to the
// database — it resolves which number to send from, loads the template,
// and calls Meta — so the assertions here are about the two things that
// have actually gone wrong in production: which number a campaign goes
// out on (migration 040/048), and whether the caller is told which one
// it was, so the broadcast row can freeze it for a later resume.
//
// `resolveConfig` is deliberately NOT mocked: the number-choosing rule
// is the thing under test.
// ---------------------------------------------------------------------------

/** The account's connected numbers for the current scenario. */
let configRows: Array<Record<string, unknown>> = []

const CFG_ONE = {
  id: 'cfg-1',
  account_id: 'acct-1',
  phone_number_id: 'PNID-1',
  access_token: 'enc-token',
  status: 'connected',
  label: 'Batu Caves',
  is_primary: true,
}

const CFG_TWO = {
  id: 'cfg-2',
  account_id: 'acct-1',
  phone_number_id: 'PNID-2',
  access_token: 'enc-token-2',
  status: 'connected',
  label: 'Setapak',
  is_primary: false,
}

// Chainable Supabase mock. Only `whatsapp_config` matters here; the
// builder records the filters so a by-id lookup can be honoured the way
// PostgREST would.
function makeSupabaseMock() {
  function builder(table: string) {
    const filters: Record<string, unknown> = {}

    const rowsFor = () => {
      if (table !== 'whatsapp_config') return []
      let rows = configRows
      if (filters.id !== undefined) rows = rows.filter((r) => r.id === filters.id)
      if (filters.account_id !== undefined) {
        rows = rows.filter((r) => r.account_id === filters.account_id)
      }
      return rows
    }

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'is', 'in', 'order', 'limit', 'insert', 'update']) {
      b[m] = vi.fn(chain)
    }
    b.eq = vi.fn((col: string, val: unknown) => {
      filters[col] = val
      return b
    })
    // `.maybeSingle()` is the by-id lookup; a bare await is the
    // `.limit(2)` listing that decides "exactly one, or ambiguous".
    b.maybeSingle = vi.fn(() =>
      Promise.resolve({ data: rowsFor()[0] ?? null, error: null }),
    )
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: rowsFor(), error: null })
    return b
  }

  return { from: vi.fn((table: string) => builder(table)) }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account',
    )
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      supabase: supabaseMock,
      accountId: 'acct-1',
      userId: 'user-1',
    })),
  }
})

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ success: true })),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { broadcast: { limit: 100, windowMs: 60_000 } },
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((token: string) => `plain:${token}`),
}))

vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: vi.fn(async () => ({
    row: null,
    language: 'en_US',
    malformed: false,
  })),
}))

const { sendTemplateMessage } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTemplateMessage }))

import { POST } from './route'

function post(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients: [{ phone: '+60123456789', params: ['Aisyah'] }],
        template_name: 'term_reminder',
        template_language: 'en_US',
        ...body,
      }),
    }),
  )
}

describe('POST /api/whatsapp/broadcast — which number it sent from', () => {
  beforeEach(() => {
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
    configRows = [CFG_ONE]
  })

  it('reports the number it resolved, so the caller can freeze it', async () => {
    // The broadcast row needs this to be resumable days later
    // (migration 048). Without it a resume has nothing to read back.
    const res = await post({})
    const payload = await res.json()

    expect(res.status).toBe(200)
    expect(payload.whatsapp_config_id).toBe('cfg-1')
  })

  it('reports the branch the caller named, not the account default', async () => {
    configRows = [CFG_ONE, CFG_TWO]

    const res = await post({ whatsapp_config_id: 'cfg-2' })
    const payload = await res.json()

    expect(payload.whatsapp_config_id).toBe('cfg-2')
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'PNID-2' }),
    )
  })

  it('refuses to guess when several numbers are connected', async () => {
    // A broadcast reaches hundreds of parents at once, so a guessed
    // number is the most expensive mistake here. No `allowPrimary`.
    configRows = [CFG_ONE, CFG_TWO]

    const res = await post({})
    const payload = await res.json()

    expect(res.status).toBe(400)
    expect(payload.whatsapp_config_id).toBeUndefined()
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it("rejects a number that is not this account's", async () => {
    configRows = [CFG_ONE]

    const res = await post({ whatsapp_config_id: 'cfg-someone-else' })

    expect(res.status).toBe(400)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
})
