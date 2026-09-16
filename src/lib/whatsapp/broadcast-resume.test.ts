import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BroadcastError } from './broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
  RESUME_MAX_PER_REQUEST,
} from './broadcast-resume';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

// ============================================================
// Claim / release — the mutex that stops a double-send.
// ============================================================

interface ClaimCall {
  update: Record<string, unknown>;
  filters: Record<string, unknown>;
  or?: string;
}

function claimDb(returnedRows: unknown[], calls: ClaimCall[]): SupabaseClient {
  return {
    from() {
      const call: ClaimCall = { update: {}, filters: {} };
      const b: Record<string, unknown> = {
        update: (row: Record<string, unknown>) => {
          call.update = row;
          calls.push(call);
          return b;
        },
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        or: (expr: string) => {
          call.or = expr;
          return b;
        },
        select: async () => ({ data: returnedRows, error: null }),
        then: (resolve: (r: { error: null }) => unknown) =>
          resolve({ error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('claimBroadcastDelivery', () => {
  it('claims when the conditional UPDATE matched a row', async () => {
    const calls: ClaimCall[] = [];
    const ok = await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );

    expect(ok).toBe(true);
    expect(calls[0].filters).toEqual({ id: 'bc-1', account_id: 'acct-1' });
    expect(calls[0].update.delivery_locked_at).toBe(
      '2026-08-11T12:00:00.000Z',
    );
  });

  it('refuses when another pass already holds the lock', async () => {
    // The UPDATE's WHERE didn't match — someone else got there first.
    const ok = await claimBroadcastDelivery(
      claimDb([], []),
      'acct-1',
      'bc-1',
    );
    expect(ok).toBe(false);
  });

  it('treats a lock older than the staleness window as abandoned', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );
    // 30 minutes before "now" — a pass whose process died is recoverable
    // without touching the database by hand.
    expect(calls[0].or).toBe(
      'delivery_locked_at.is.null,delivery_locked_at.lt.2026-08-11T11:30:00.000Z',
    );
  });

  it('is scoped to the account, so another tenant cannot claim it', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(claimDb([], calls), 'acct-9', 'bc-1');
    expect(calls[0].filters.account_id).toBe('acct-9');
  });
});

describe('releaseBroadcastDelivery', () => {
  it('clears the lock', async () => {
    const calls: ClaimCall[] = [];
    await releaseBroadcastDelivery(claimDb([], calls), 'bc-1');
    expect(calls[0].update).toEqual({ delivery_locked_at: null });
    expect(calls[0].filters).toEqual({ id: 'bc-1' });
  });
});

// ============================================================
// Planning — which recipients a pass picks up, and with what params.
// ============================================================

interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: Record<string, unknown>[];
  config?: Record<string, unknown> | null;
  templates?: Record<string, unknown>[];
}

interface PlanWrites {
  statusFilter?: unknown;
  failedIds?: unknown;
  failedUpdate?: Record<string, unknown>;
}

function planDb(fx: PlanFixture, writes: PlanWrites = {}): SupabaseClient {
  return {
    from(table: string) {
      // The id resolveConfig names when the broadcast carries a frozen
      // number. Answering regardless of it would let a caller reaching
      // for the WRONG branch pass silently.
      let askedForId: string | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (table === 'whatsapp_config' && col === 'id') {
            askedForId = val as string;
          }
          return b;
        },
        order: () => b,
        in: (col: string, vals: unknown) => {
          if (col === 'status') writes.statusFilter = vals;
          if (col === 'id') writes.failedIds = vals;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          writes.failedUpdate = row;
          return b;
        },
        // Since migration 040 resolveConfig lists the account's numbers
        // with `.limit(2)` rather than assuming a single row. A resume
        // supplies no configId and refuses the account primary, so an
        // empty list here is what "cannot resolve a number" looks like.
        limit: async () => ({
          data: table === 'whatsapp_config' && fx.config ? [fx.config] : [],
          error: null,
        }),
        maybeSingle: async () => {
          // resolveConfig looks a named number up by id (migration 048
          // freezes one on the broadcast), so this can no longer answer
          // with the broadcast row for every table.
          if (table === 'whatsapp_config') {
            const row = fx.config ?? null;
            const matches =
              row && (askedForId === null || row.id === askedForId);
            return { data: matches ? row : null, error: null };
          }
          return {
            data: fx.broadcast === undefined ? null : fx.broadcast,
            error: null,
          };
        },
        single: async () => ({
          data: fx.config === undefined ? null : fx.config,
          error: null,
        }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (table === 'broadcast_recipients') {
            return resolve({ data: fx.recipients ?? [], error: null });
          }
          if (table === 'message_templates') {
            return resolve({ data: fx.templates ?? [], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const BROADCAST = {
  id: 'bc-1',
  template_name: 'order_update',
  template_language: 'en_US',
};

const CONFIG = { id: 'cfg-1', phone_number_id: 'pn-1', access_token: 'tok' };

function recipient(
  id: string,
  phone: string | null,
  params: unknown = ['A123'],
) {
  return {
    id,
    template_params: params,
    contact: phone ? { phone } : null,
  };
}

// ============================================================
// Which number a resume sends on (migration 048). A campaign outlives
// the request that created it, so the branch is read off the broadcast
// rather than re-derived — re-deriving it days later would mail the
// leftovers of one branch's campaign from another branch's number.
// ============================================================

describe('planBroadcastResume — the frozen number', () => {
  it('sends on the number the first pass used, not the account default', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, whatsapp_config_id: 'cfg-batu-caves' },
        // Only the named row answers the by-id lookup; a second number
        // exists on the account but must never be reached for.
        config: { id: 'cfg-batu-caves', phone_number_id: 'pn-batu-caves', access_token: 'tok' },
        recipients: [recipient('r1', '+14155550123')],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(plan.phoneNumberId).toBe('pn-batu-caves');
  });

  it('refuses when the branch it was sent from is no longer connected', async () => {
    // The by-id lookup misses — resolveConfig returns not_found, and a
    // silent switch to another branch would be worse than refusing.
    await expect(
      planBroadcastResume(
        planDb({
          broadcast: { ...BROADCAST, whatsapp_config_id: 'cfg-gone' },
          config: null,
          recipients: [recipient('r1', '+14155550123')],
        }),
        'acct-1',
        'bc-1',
        'pending',
      ),
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('still resolves a pre-048 broadcast that carries no number', async () => {
    // Rows created before the column existed. With a single number
    // connected this resolves to it, so old campaigns stay resumable.
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: BROADCAST,
        config: CONFIG,
        recipients: [recipient('r1', '+14155550123')],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(plan.phoneNumberId).toBe('pn-1');
  });
});

describe('planBroadcastResume', () => {
  it('plans the outstanding recipients with their frozen params', async () => {
    const writes: PlanWrites = {};
    const { plan, remaining, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567', ['A123', 'Friday']),
            recipient('r2', '+15559876543', ['B456', 'Monday']),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(writes.statusFilter).toEqual(['pending']);
    // Phones are stored sanitized (no leading '+'), same as the shape
    // createBroadcast plans — deliverBroadcast feeds them to
    // phoneVariants from here.
    expect(plan.planned).toEqual([
      {
        recipientRowId: 'r1',
        phone: '15551234567',
        params: ['A123', 'Friday'],
      },
      {
        recipientRowId: 'r2',
        phone: '15559876543',
        params: ['B456', 'Monday'],
      },
    ]);
    expect(plan.accessToken).toBe('decrypted:tok');
    expect(remaining).toBe(0);
    expect(unsendable).toBe(0);
  });

  it('scopes to failed rows when retrying, and to both for "all"', async () => {
    const failedWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+15551234567')],
        },
        failedWrites,
      ),
      'acct-1',
      'bc-1',
      'failed',
    );
    expect(failedWrites.statusFilter).toEqual(['failed']);

    const allWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+15551234567')],
        },
        allWrites,
      ),
      'acct-1',
      'bc-1',
      'all',
    );
    expect(allWrites.statusFilter).toEqual(['pending', 'failed']);
  });

  it('treats a missing or malformed params column as no params', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: BROADCAST,
        config: CONFIG,
        recipients: [
          // Rows created before migration 038 carry NULL.
          recipient('r1', '+15551234567', null),
          recipient('r2', '+15559876543', 'not-an-array'),
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned.map((p) => p.params)).toEqual([[], []]);
  });

  it('fails unsendable rows up front so they stop blocking the status', async () => {
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567'),
            recipient('r2', null),
            recipient('r3', 'nonsense'),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    // Left 'pending', these would keep the broadcast in 'sending'
    // forever — the exact symptom being fixed.
    expect(unsendable).toBe(2);
    expect(writes.failedIds).toEqual(['r2', 'r3']);
    expect(writes.failedUpdate?.status).toBe('failed');
    expect(plan.planned).toHaveLength(1);
  });

  it('caps one pass and reports the leftover', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')),
    );
    const { plan, remaining } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, config: CONFIG, recipients: many }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    // Surfaced to the caller rather than silently dropped.
    expect(remaining).toBe(25);
  });

  it('404s a broadcast that is not on this account', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: null }),
        'acct-1',
        'bc-1',
        'pending',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when there is nothing outstanding', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: BROADCAST, config: CONFIG, recipients: [] }),
        'acct-1',
        'bc-1',
        'failed',
      ),
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('resolves the template row for header + button components', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, template_language: 'en_US' },
        config: CONFIG,
        recipients: [recipient('r1', '+15551234567')],
        templates: [
          {
            id: 'tpl-1',
            user_id: 'u-1',
            name: 'order_update',
            // Synced from Meta as bare 'en' — the resolver bridges it.
            language: 'en',
            body_text: 'Your order {{1}} ships on {{2}}',
          },
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.templateRow?.language).toBe('en');
  });
});

// ============================================================
// Resuming on a database that never ran 048.
// ============================================================

describe('planBroadcastResume without migration 048', () => {
  // `broadcasts.whatsapp_config_id` is created by 048 and no database has
  // run it. Selecting the column fails the whole query, and the handler
  // turns that into "Broadcast not found" — a 404 for a campaign sitting
  // right there in the list.

  const MISSING_COLUMN = {
    code: '42703',
    message: 'column broadcasts.whatsapp_config_id does not exist',
  };

  /**
   * Stubs only as far as this test needs: the broadcasts row, then an
   * empty recipient set so planning stops right after the load.
   * `selects` records the column list of every broadcasts read.
   */
  function resumeDb(selects: string[], firstError: unknown) {
    let broadcastReads = 0;
    return {
      from(table: string) {
        if (table === 'broadcasts') {
          let cols = '';
          const b: Record<string, unknown> = {
            select: (c: string) => {
              cols = c;
              selects.push(c);
              return b;
            },
            eq: () => b,
            maybeSingle: async () => {
              broadcastReads += 1;
              if (broadcastReads === 1 && firstError) {
                return { data: null, error: firstError };
              }
              return {
                data: {
                  id: 'bc-1',
                  template_name: 'promo',
                  template_language: 'en',
                  ...(cols.includes('whatsapp_config_id')
                    ? { whatsapp_config_id: null }
                    : {}),
                },
                error: null,
              };
            },
          };
          return b;
        }
        const r: Record<string, unknown> = {
          select: () => r,
          eq: () => r,
          in: () => r,
          order: async () => ({ data: [], error: null }),
        };
        return r;
      },
    } as unknown as SupabaseClient;
  }

  it('drops the column and finds the broadcast instead of 404ing', async () => {
    const selects: string[] = [];

    // The stub leaves no recipients, so planning gets as far as
    // `nothing_to_resume`. That is the assertion: reaching it at all
    // means the broadcast was FOUND. Before the retry this same call
    // died earlier, as `not_found`, on a campaign that exists.
    await expect(
      planBroadcastResume(
        resumeDb(selects, MISSING_COLUMN),
        'acct-1',
        'bc-1',
        'pending'
      )
    ).rejects.toMatchObject({ code: 'nothing_to_resume' });

    expect(selects).toHaveLength(2);
    expect(selects[0]).toContain('whatsapp_config_id');
    expect(selects[1]).not.toContain('whatsapp_config_id');
  });

  it('still 404s when the broadcast genuinely is not there', async () => {
    const selects: string[] = [];
    await expect(
      planBroadcastResume(
        {
          from: () => {
            const b: Record<string, unknown> = {
              select: (c: string) => {
                selects.push(c);
                return b;
              },
              eq: () => b,
              maybeSingle: async () => ({ data: null, error: null }),
            };
            return b;
          },
        } as unknown as SupabaseClient,
        'acct-1',
        'bc-1',
        'pending'
      )
    ).rejects.toBeInstanceOf(BroadcastError);

    // One read, no retry: a missing row is not a missing column.
    expect(selects).toHaveLength(1);
  });
});
