import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The route's job is to refuse a call log that would be useless, and to
 * fill in the two things the client cannot be trusted with: the account
 * the row belongs to and who logged it.
 *
 * So the assertions are mostly about what does NOT reach the database.
 * A logged call with no summary, or filed under a day nobody meant, is
 * worse than a call nobody logged: it reads as a record.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  requireRole: vi.fn(),
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'forbidden' }, { status: 403 })
  ),
}));

vi.mock('@/lib/calls/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

import { GET, POST } from './route';

type Call = { method: string; args: unknown[] };

/**
 * A PostgREST-shaped builder that records every method it is asked for
 * and resolves to `result` when awaited. Recording all of them, rather
 * than stubbing the few we expect, means a filter added later shows up
 * here without the test being rewritten.
 */
function builder(result: { data: unknown; error: unknown }, log: Call[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'eq', 'not', 'insert', 'single']) {
    chain[m] = (...args: unknown[]) => {
      log.push({ method: m, args });
      return chain;
    };
  }
  chain.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
    Promise.resolve(result).then(resolve);
  return chain;
}

const ROW = {
  id: 'call-1',
  account_id: 'account-1',
  direction: 'keluar',
  outcome: 'dijawab',
  summary: 'Ibu tanya yuran Ogos.',
};

let calls: Record<string, Call[]>;
let adminLog: Call[];

/** The cookie client: profiles for the account lookup, call_logs for reads. */
function cookieClient(opts: {
  user?: { id: string } | null;
  accountId?: string | null;
  rows?: { data: unknown; error: unknown };
} = {}) {
  const { user = { id: 'user-1' }, accountId = 'account-1' } = opts;
  calls = { call_logs: [], profiles: [] };
  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      calls[table] ??= [];
      if (table === 'profiles') {
        return builder(
          { data: accountId ? { account_id: accountId } : null, error: null },
          calls.profiles
        );
      }
      return builder(opts.rows ?? { data: [ROW], error: null }, calls[table]);
    },
  };
}

function useCookieClient(opts: Parameters<typeof cookieClient>[0] = {}) {
  const client = cookieClient(opts);
  mocks.createClient.mockResolvedValue(client);
  return client;
}

function useAdmin(result: { data: unknown; error: unknown } = { data: ROW, error: null }) {
  adminLog = [];
  mocks.supabaseAdmin.mockReturnValue({ from: () => builder(result, adminLog) });
  return adminLog;
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

const VALID = {
  direction: 'keluar',
  outcome: 'dijawab',
  summary: 'Ibu tanya yuran Ogos; dijelaskan.',
};

/** The object handed to .insert(), or undefined if nothing was inserted. */
function inserted(): Record<string, unknown> | undefined {
  return adminLog.find((c) => c.method === 'insert')?.args[0] as
    | Record<string, unknown>
    | undefined;
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireRole.mockResolvedValue({ accountId: 'account-1', userId: 'user-1' });
  useAdmin();
});

describe('GET /api/calls', () => {
  it('refuses a signed-out caller before reading anything', async () => {
    useCookieClient({ user: null });
    const res = await GET(new Request('http://localhost/api/calls'));
    expect(res.status).toBe(401);
    expect(calls.call_logs).toHaveLength(0);
  });

  it('orders by when the call happened, not when it was typed up', async () => {
    useCookieClient();
    const res = await GET(new Request('http://localhost/api/calls'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      calls: [ROW],
      call_logging: 'ok',
    });
    // Staff log at the end of a shift, so created_at would sort the
    // day's calls into the order somebody got round to them.
    expect(calls.call_logs).toContainEqual({
      method: 'order',
      args: ['called_at', { ascending: false }],
    });
  });

  it('narrows to one thread when asked', async () => {
    useCookieClient();
    await GET(new Request('http://localhost/api/calls?conversation_id=conv-1'));
    expect(calls.call_logs).toContainEqual({
      method: 'eq',
      args: ['conversation_id', 'conv-1'],
    });
  });

  it('asks for the promised callbacks with the indexed filter', async () => {
    useCookieClient();
    await GET(new Request('http://localhost/api/calls?follow_up=due'));
    // idx_call_logs_follow_up is partial on NOT NULL — this is the
    // query it exists for.
    expect(calls.call_logs).toContainEqual({
      method: 'not',
      args: ['follow_up_at', 'is', null],
    });
  });

  it('degrades to an empty list when the table is not on this database', async () => {
    useCookieClient({
      rows: {
        data: null,
        error: { code: '42P01', message: 'relation "call_logs" does not exist' },
      },
    });
    const res = await GET(new Request('http://localhost/api/calls'));

    // 051 is applied by hand in the SQL editor while the deploy is a
    // merge. If the code lands first, a 500 tells whoever opens /calls
    // the feature is broken and sends them looking in the wrong place.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      calls: [],
      call_logging: 'unavailable',
    });
  });

  it('still 500s when a DIFFERENT relation is missing', async () => {
    useCookieClient({
      rows: {
        data: null,
        error: { code: '42P01', message: 'relation "widgets" does not exist' },
      },
    });
    const res = await GET(new Request('http://localhost/api/calls'));
    expect(res.status).toBe(500);
  });

  it('does not filter on follow-up for any other value', async () => {
    useCookieClient();
    await GET(new Request('http://localhost/api/calls?follow_up=no'));
    expect(calls.call_logs.map((c) => c.method)).not.toContain('not');
  });
});

describe('POST /api/calls', () => {
  it('logs a call, filling in the account and the person', async () => {
    useCookieClient();
    const res = await post(VALID);

    expect(res.status).toBe(201);
    // Both come from the session, never from the body: the insert runs
    // through the service role, which bypasses RLS.
    expect(inserted()).toMatchObject({
      account_id: 'account-1',
      logged_by: 'user-1',
      summary: 'Ibu tanya yuran Ogos; dijelaskan.',
    });
  });

  it('refuses a caller who is not an agent', async () => {
    mocks.requireRole.mockRejectedValue(new Error('nope'));
    useCookieClient();
    const res = await post(VALID);
    expect(res.status).toBe(403);
    expect(inserted()).toBeUndefined();
  });

  it('refuses a profile with no account rather than writing a stray row', async () => {
    useCookieClient({ accountId: null });
    const res = await post(VALID);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'profile_not_linked' });
    expect(inserted()).toBeUndefined();
  });

  it('refuses a call with no summary', async () => {
    useCookieClient();
    const res = await post({ ...VALID, summary: '   ' });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'summary_required' });
    expect(inserted()).toBeUndefined();
  });

  it.each([
    ['direction', { direction: 'sideways' }, 'invalid_direction'],
    ['outcome', { outcome: 'mengarut' }, 'invalid_outcome'],
  ])('refuses an unknown %s', async (_label, patch, code) => {
    useCookieClient();
    const res = await post({ ...VALID, ...patch });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: code });
    expect(inserted()).toBeUndefined();
  });

  // NaN and Infinity are deliberately absent: JSON.stringify turns both
  // into `null`, so neither can reach the route over the wire. The
  // `Number.isFinite` guard there is for callers that are not JSON, and
  // asserting it through fetch would only be testing JSON.
  it.each([-1, 'five', true])(
    'refuses a duration of %s rather than storing NULL',
    async (duration) => {
      useCookieClient();
      const res = await post({ ...VALID, duration_seconds: duration });
      // NULL means "nobody recorded it". Quietly turning a bad value
      // into that erases the difference, and the user never learns the
      // field was ignored.
      expect(res.status).toBe(422);
      expect(inserted()).toBeUndefined();
    }
  );

  it('accepts an absent duration as no recorded length', async () => {
    useCookieClient();
    const res = await post(VALID);
    expect(res.status).toBe(201);
    expect(inserted()).toMatchObject({ duration_seconds: null });
  });

  it('refuses an unreadable time instead of filing it under today', async () => {
    useCookieClient();
    const res = await post({ ...VALID, called_at: 'semalam petang' });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'invalid_called_at' });
    expect(inserted()).toBeUndefined();
  });

  it('defaults the time to now when none is given', async () => {
    useCookieClient();
    const before = Date.now();
    await post(VALID);
    const at = Date.parse(inserted()!.called_at as string);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('stores the links it was given and NULLs the ones it was not', async () => {
    useCookieClient();
    await post({ ...VALID, contact_id: 'contact-1', issue_id: 'issue-1' });
    expect(inserted()).toMatchObject({
      contact_id: 'contact-1',
      issue_id: 'issue-1',
      conversation_id: null,
      centre_id: null,
      whatsapp_config_id: null,
    });
  });

  it('refuses with 503 when the table is not on this database', async () => {
    useCookieClient();
    useAdmin({
      data: null,
      error: { code: '42P01', message: 'relation "call_logs" does not exist' },
    });
    const res = await post(VALID);
    // Not a 201 with nothing behind it: a staff member told their call
    // saved, when no table took it, loses the handover AND the
    // knowledge that they lost it.
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'table_missing' });
  });

  it('still 500s when a DIFFERENT relation is missing', async () => {
    useCookieClient();
    useAdmin({
      data: null,
      error: { code: '42P01', message: 'relation "widgets" does not exist' },
    });
    const res = await post(VALID);
    // The gate names the table on purpose. Swallowing any 42P01 would
    // turn a real bug into a tidy 503 nobody chases.
    expect(res.status).toBe(500);
  });

  it('reports a failed insert rather than a clean 201', async () => {
    useCookieClient();
    useAdmin({ data: null, error: { message: 'boom' } });
    const res = await post(VALID);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'boom' });
  });
});
