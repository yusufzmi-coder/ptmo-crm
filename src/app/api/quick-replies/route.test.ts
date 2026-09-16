import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `quick_replies.whatsapp_config_id` is created only by migration 043,
 * and no database has ever run 043. The route reads and writes it
 * anyway, so on production the thread list 500s and creating a snippet
 * 500s from any screen.
 *
 * The fix keeps the branch feature and falls back when the column turns
 * out to be absent, so these tests are about the FALLBACK, not about
 * whether the column is named: naming it is correct on a database that
 * has 043. What must hold is that its absence degrades to the right
 * answer, that its absence is not confused with an unrelated schema
 * error, and that a pin the database cannot store is refused loudly
 * rather than dropped.
 *
 * Harness shape (the builder and the call log) is adapted from the one
 * written on `board/f2-qr-fence` by the Fasa 2 session; the assertions
 * are this fix's own.
 */

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  supabaseAdmin: vi.fn(),
  resolveConfig: vi.fn(),
  validateInteractivePayload: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

vi.mock('@/lib/whatsapp/resolve-config', () => ({
  resolveConfig: mocks.resolveConfig,
  configDisplayName: (c: { label: string | null; phone_number_id: string }) =>
    c.label ?? c.phone_number_id,
}));

vi.mock('@/lib/whatsapp/interactive', () => ({
  validateInteractivePayload: mocks.validateInteractivePayload,
}));

// Only the decoration is stubbed. `isMissingBranchColumn` is the thing
// under test and stays real — mocking it would leave these tests
// asserting against a detector that does not exist in production.
vi.mock('@/lib/inbox/quick-reply-branch', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/inbox/quick-reply-branch')>();
  return {
    ...actual,
    decorateQuickReplyForBranch: (row: unknown) => row,
  };
});

import { GET, POST } from './route';

type Call = { method: string; args: unknown[] };
type Result = { data: unknown; error: unknown };

const MISSING_COLUMN = {
  code: '42703',
  message: 'column quick_replies.whatsapp_config_id does not exist',
};

const quickReplyRows = [
  { id: 'qr-1', title: 'Yuran', kind: 'text', content_text: 'RM120 sebulan' },
  { id: 'qr-2', title: 'Jadual', kind: 'text', content_text: 'Sabtu 9 pagi' },
];

/**
 * A PostgREST-shaped builder that records every method call and resolves
 * to `result` when awaited. Recording everything rather than stubbing
 * the two methods we expect is deliberate: a filter added back by a
 * future edit shows up here without the test being updated.
 */
function builder(result: Result, log: Call[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'order', 'eq', 'or', 'is', 'insert', 'single']) {
    chain[method] = (...args: unknown[]) => {
      log.push({ method, args });
      return chain;
    };
  }
  chain.then = (resolve: (v: Result) => unknown) =>
    Promise.resolve(result).then(resolve);
  return chain;
}

let calls: Record<string, Call[][]>;

/**
 * `results` is consumed one entry per `.from(table)`, so a test can make
 * the first read fail and the retry succeed. The last entry repeats.
 */
function userClient(results: Partial<Record<string, Result[]>> = {}) {
  calls = { quick_replies: [], whatsapp_config: [] };
  const used: Record<string, number> = {};
  return {
    from: (table: string) => {
      calls[table] ??= [];
      const log: Call[] = [];
      calls[table].push(log);
      const seq = results[table] ?? [
        table === 'quick_replies'
          ? { data: quickReplyRows, error: null }
          : {
              data: [{ id: 'cfg-1', label: 'Rawang', phone_number_id: '111' }],
              error: null,
            },
      ];
      const i = Math.min(used[table] ?? 0, seq.length - 1);
      used[table] = (used[table] ?? 0) + 1;
      return builder(seq[i], log);
    },
  };
}

/** Flattened arguments of the nth query against a table. */
function argsFor(table: string, n: number): string {
  return (calls[table]?.[n] ?? []).map((c) => JSON.stringify(c.args)).join(' ');
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.validateInteractivePayload.mockReturnValue({ ok: true });
});

function get(url: string) {
  return GET(new Request(url));
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/quick-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

describe('GET on a database without 043', () => {
  it('drops the branch filter and still returns the snippets', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: userClient({
        quick_replies: [
          { data: null, error: MISSING_COLUMN },
          { data: quickReplyRows, error: null },
        ],
      }),
      accountId: 'account-1',
    });
    mocks.resolveConfig.mockResolvedValue({
      ok: true,
      config: { id: 'cfg-1', label: 'Rawang', phone_number_id: '111' },
    });

    const response = await get(
      'http://localhost/api/quick-replies?conversationId=conv-1'
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.quick_replies).toEqual(quickReplyRows);
    // The caller is told which of the two situations it is in.
    expect(body.branch_pinning).toBe('unavailable');
    // Branch resolution is unaffected — it reads
    // conversations.whatsapp_config_id, which came with 040 and is live.
    expect(body.branch).toBe('Rawang');

    // Two reads: the filtered one that failed, then the retry. The retry
    // must carry no filter on the absent column.
    expect(calls.quick_replies).toHaveLength(2);
    expect(argsFor('quick_replies', 0)).toContain('whatsapp_config_id');
    expect(argsFor('quick_replies', 1)).not.toContain('whatsapp_config_id');
  });

  it('says pinning is fine when the column is there', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: userClient(),
      accountId: 'account-1',
    });
    mocks.resolveConfig.mockResolvedValue({
      ok: true,
      config: { id: 'cfg-1', label: 'Rawang', phone_number_id: '111' },
    });

    const response = await get(
      'http://localhost/api/quick-replies?conversationId=conv-1'
    );

    const body = await response.json();
    expect(body.branch_pinning).toBe('ok');
    expect(calls.quick_replies).toHaveLength(1);
  });

  it('still 500s when a DIFFERENT column is missing', async () => {
    // The fallback returns a successful-looking list. Letting it fire on
    // any 42703 would hide the next defect of exactly this class behind
    // a 200, which is how this one survived as long as it did.
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: userClient({
        quick_replies: [
          {
            data: null,
            error: {
              code: '42703',
              message: 'column quick_replies.title does not exist',
            },
          },
        ],
      }),
      accountId: 'account-1',
    });
    mocks.resolveConfig.mockResolvedValue({
      ok: true,
      config: { id: 'cfg-1', label: 'Rawang', phone_number_id: '111' },
    });

    const response = await get(
      'http://localhost/api/quick-replies?conversationId=conv-1'
    );

    expect(response.status).toBe(500);
    expect(calls.quick_replies).toHaveLength(1);
  });
});

describe('POST on a database without 043', () => {
  function adminClient(result: Result) {
    const log: Call[] = [];
    const client = { from: () => builder(result, log) };
    mocks.supabaseAdmin.mockReturnValue(client);
    return log;
  }

  beforeEach(() => {
    mocks.requireRole.mockResolvedValue({
      supabase: userClient(),
      accountId: 'account-1',
      userId: 'user-1',
      role: 'agent',
    });
  });

  it('omits the column entirely when nothing is pinned', async () => {
    // This is the whole unconditional failure: sending the key with a
    // null value reads as harmless, and PostgREST rejects the key itself.
    const log = adminClient({ data: { id: 'qr-9' }, error: null });

    const response = await post({ title: 'Yuran', content_text: 'RM120' });

    expect(response.status).toBe(201);
    const insert = log.find((c) => c.method === 'insert');
    expect(insert).toBeDefined();
    expect(insert!.args[0]).not.toHaveProperty('whatsapp_config_id');
    expect(insert!.args[0]).toMatchObject({
      account_id: 'account-1',
      title: 'Yuran',
    });
  });

  it('carries the column when a branch IS pinned', async () => {
    const log = adminClient({ data: { id: 'qr-9' }, error: null });
    mocks.resolveConfig.mockResolvedValue({
      ok: true,
      config: { id: 'cfg-1', label: 'Rawang', phone_number_id: '111' },
    });

    await post({
      title: 'Yuran',
      content_text: 'RM120',
      whatsapp_config_id: 'cfg-1',
    });

    const insert = log.find((c) => c.method === 'insert');
    expect(insert!.args[0]).toMatchObject({ whatsapp_config_id: 'cfg-1' });
  });

  it('refuses a pin the database cannot store, rather than dropping it', async () => {
    // 201 with the pin silently gone is the failure that sends a parent
    // to the wrong centre. 503 with a reason is the honest answer.
    adminClient({ data: null, error: MISSING_COLUMN });
    mocks.resolveConfig.mockResolvedValue({
      ok: true,
      config: { id: 'cfg-1', label: 'Rawang', phone_number_id: '111' },
    });

    const response = await post({
      title: 'Yuran',
      content_text: 'RM120',
      whatsapp_config_id: 'cfg-1',
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('043'),
    });
  });

  it('still 500s on an ordinary insert failure', async () => {
    adminClient({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    });

    const response = await post({ title: 'Yuran', content_text: 'RM120' });

    expect(response.status).toBe(500);
  });
});
