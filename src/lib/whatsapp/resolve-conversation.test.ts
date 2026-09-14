import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveConversationByPhone } from './resolve-conversation';
import { SendMessageError } from './send-message';

// ------------------------------------------------------------
// Chainable Supabase stub, scripted per table. Terminal methods
// (like/maybeSingle/single) resolve to configured data; the builder
// itself is thenable so an awaited `update().eq()` resolves cleanly.
// ------------------------------------------------------------
type ContactRow = { id: string; phone: string; name?: string | null };

interface Script {
  config?: { user_id: string } | null; // whatsapp_config.maybeSingle
  contactCandidates?: ContactRow[]; // contacts .like (same every call)
  /** Per-call `.like` results — overrides contactCandidates. Lets a
   *  test simulate "miss, then hit" for the unique-race path. */
  contactCandidatesByCall?: ContactRow[][];
  insertedContactId?: string; // contacts insert -> single
  insertContactError?: { code?: string } | null;
  /** Conversation lookup result (oldest-first `.order().limit(1)`).
   *  A single row or null; wrapped into a one-element array internally.
   *  This is the number-scoped lookup — `.eq('whatsapp_config_id', …)`. */
  existingConversation?: { id: string } | null; // conversations select.limit(1)
  /** Per-call conversation lookup results — overrides existingConversation.
   *  Lets a test simulate "miss, then hit" for the unique-race path. */
  existingConversationByCall?: (({ id: string } | null))[];
  /** The unbranded thread the adoption path looks for — the separate
   *  `.is('whatsapp_config_id', null)` lookup added with migration 040.
   *  Kept apart from existingConversation so the two lookups can be
   *  scripted independently. */
  orphanConversation?: { id: string } | null;
  /** Whether the `.is(null)`-guarded adoption UPDATE wins its claim.
   *  False simulates a concurrent caller adopting the row first. */
  adoptionWins?: boolean;
  insertedConversationId?: string; // conversations insert -> single
  insertConversationError?: { code?: string } | null;
}

function makeDb(script: Script): SupabaseClient {
  let table = '';
  let mode: 'select' | 'insert' | 'update' = 'select';
  let likeCalls = 0;
  let convLookupCalls = 0;
  // Set by `.is('whatsapp_config_id', null)`, which is what separates
  // the orphan-adoption lookup/update from the number-scoped ones.
  let nullFiltered = false;

  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: () => {
      mode = 'insert';
      return builder;
    },
    update: () => {
      mode = 'update';
      return builder;
    },
    eq: () => builder,
    order: () => builder,
    is: () => {
      nullFiltered = true;
      return builder;
    },
    limit: () => {
      // Two readers land here since migration 040: resolveConfig lists
      // the account's numbers with `.limit(2)` (one row = "the only
      // number"), and resolveAuditUserId takes `.limit(1)` for a
      // user_id. One row carrying both columns satisfies each.
      if (table === 'whatsapp_config' && mode === 'select') {
        return Promise.resolve({
          data: script.config ? [{ id: 'cfg-1', ...script.config }] : [],
          error: null,
        });
      }
      if (table === 'conversations' && mode === 'select') {
        // The `.is(null)` orphan lookup is scripted separately from the
        // number-scoped one; they are different questions.
        if (nullFiltered) {
          const orphan = script.orphanConversation ?? null;
          return Promise.resolve({
            data: orphan ? [orphan] : [],
            error: null,
          });
        }
        const row = script.existingConversationByCall
          ? (script.existingConversationByCall[convLookupCalls] ?? null)
          : (script.existingConversation ?? null);
        convLookupCalls++;
        return Promise.resolve({ data: row ? [row] : [], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    },
    like: () => {
      const data = script.contactCandidatesByCall
        ? (script.contactCandidatesByCall[likeCalls] ?? [])
        : (script.contactCandidates ?? []);
      likeCalls++;
      return Promise.resolve({ data, error: null });
    },
    maybeSingle: () => {
      // resolveConfig lands here when a caller names a number
      // explicitly (`.eq('id', …).eq('account_id', …).maybeSingle()`).
      // Carry the same `id` the `.limit()` path returns — the resolved
      // id is what gets stamped on the conversation, so a row without
      // one silently resolves to `undefined` rather than failing.
      if (table === 'whatsapp_config')
        return Promise.resolve({
          data: script.config ? { id: 'cfg-1', ...script.config } : null,
          error: null,
        });
      return Promise.resolve({ data: null, error: null });
    },
    single: () => {
      if (table === 'contacts' && mode === 'insert') {
        if (script.insertContactError)
          return Promise.resolve({
            data: null,
            error: script.insertContactError,
          });
        return Promise.resolve({
          data: { id: script.insertedContactId },
          error: null,
        });
      }
      if (table === 'conversations' && mode === 'insert') {
        if (script.insertConversationError)
          return Promise.resolve({
            data: null,
            error: script.insertConversationError,
          });
        return Promise.resolve({
          data: { id: script.insertedConversationId },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    // Thenable: `await db.from().update().eq()` lands here, and so does
    // the orphan-adoption `update().eq().is().select('id')`, which needs
    // to report whether it won the claim.
    then: (resolve: (v: { data: unknown; error: null }) => void) => {
      if (table === 'conversations' && mode === 'update' && nullFiltered) {
        const orphan = script.orphanConversation ?? null;
        const won = script.adoptionWins ?? true;
        return resolve({
          data: orphan && won ? [orphan] : [],
          error: null,
        });
      }
      return resolve({ data: null, error: null });
    },
  };

  return {
    from: (t: string) => {
      table = t;
      mode = 'select';
      nullFiltered = false;
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('resolveConversationByPhone', () => {
  it('rejects an invalid phone before any DB call', async () => {
    const db = {
      from() {
        throw new Error('should not query');
      },
    } as unknown as SupabaseClient;
    await expect(
      resolveConversationByPhone(db, 'acct', 'not-a-phone')
    ).rejects.toBeInstanceOf(SendMessageError);
  });

  it('fails with whatsapp_not_configured when no config owner exists', async () => {
    const db = makeDb({ config: null });
    await resolveConversationByPhone(db, 'acct', '+14155550123').catch(
      (e: SendMessageError) => {
        expect(e.code).toBe('whatsapp_not_configured');
        expect(e.status).toBe(400);
      }
    );
    await expect(
      resolveConversationByPhone(db, 'acct', '+14155550123')
    ).rejects.toBeInstanceOf(SendMessageError);
  });

  it('returns the existing contact + conversation without creating', async () => {
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: { id: 'cv1' },
    });
    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+1 (415) 555-0123'
    );
    expect(res).toEqual({
      conversationId: 'cv1',
      contactId: 'c1',
      contactCreated: false,
      // The thread's number comes back with it — callers send on this,
      // never on the account default (migration 040).
      configId: 'cfg-1',
    });
  });

  it('creates contact + conversation when none exist', async () => {
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [],
      insertedContactId: 'c2',
      existingConversation: null,
      insertedConversationId: 'cv2',
    });
    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+14155550199',
      'Jane'
    );
    expect(res).toEqual({
      conversationId: 'cv2',
      contactId: 'c2',
      contactCreated: true,
      configId: 'cfg-1',
    });
  });

  it('re-resolves an existing contact when the insert loses a unique race', async () => {
    // First lookup misses (→ we attempt an insert), the insert hits a
    // 23505 unique violation, and the post-race re-lookup now returns
    // the row a concurrent writer created.
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidatesByCall: [[], [{ id: 'c-raced', phone: '14155550123' }]],
      insertContactError: { code: '23505' },
      existingConversation: { id: 'cv-raced' },
    });
    const res = await resolveConversationByPhone(db, 'acct', '+14155550123');
    expect(res.contactId).toBe('c-raced');
    expect(res.contactCreated).toBe(false);
    expect(res.conversationId).toBe('cv-raced');
  });

  it('re-resolves the conversation when the insert loses a unique race', async () => {
    // Existing contact, conversation lookup misses first (→ attempt an
    // insert), the insert hits a 23505 from a concurrent create, and the
    // post-race re-lookup returns the winning conversation — no duplicate
    // conversation is created (issue #363).
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversationByCall: [null, { id: 'cv-raced' }],
      insertConversationError: { code: '23505' },
    });
    const res = await resolveConversationByPhone(db, 'acct', '+14155550123');
    expect(res).toEqual({
      conversationId: 'cv-raced',
      contactId: 'c1',
      contactCreated: false,
      configId: 'cfg-1',
    });
  });

  // ----------------------------------------------------------
  // One thread per (account, contact, NUMBER) — migration 042.
  //
  // These are the cases that made 042 necessary. Before it, a parent
  // who wrote to two branches had one thread for both, stamped with
  // whichever branch got there first, and every reply left on that
  // branch's number regardless of which one they had actually asked.
  // ----------------------------------------------------------

  it('opens a separate thread per number for the same contact', async () => {
    // The contact already has a thread, but the number-scoped lookup
    // misses — that thread belongs to another branch. A second branch
    // must get its OWN thread rather than writing into the first one.
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: null, // no thread on THIS number
      orphanConversation: null, // and nothing unbranded to adopt
      insertedConversationId: 'cv-branch-b',
    });

    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+14155550123',
      null,
      'cfg-1',
    );

    expect(res.conversationId).toBe('cv-branch-b');
    expect(res.configId).toBe('cfg-1');
    expect(res.contactCreated).toBe(false);
  });

  it('reuses the thread already on this number instead of opening a second', async () => {
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: { id: 'cv-same-branch' },
      // Would be a bug to touch: there is already a thread on this number.
      insertedConversationId: 'cv-should-not-be-created',
    });

    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+14155550123',
      null,
      'cfg-1',
    );

    expect(res.conversationId).toBe('cv-same-branch');
  });

  it('adopts an unbranded pre-040 thread rather than duplicating it', async () => {
    // A thread that predates migration 040 carries no number. Stamping
    // it keeps the parent's history in one place; opening a second
    // thread beside it would split the conversation they can see.
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: null,
      orphanConversation: { id: 'cv-legacy' },
      adoptionWins: true,
      insertedConversationId: 'cv-should-not-be-created',
    });

    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+14155550123',
      null,
      'cfg-1',
    );

    expect(res.conversationId).toBe('cv-legacy');
  });

  it('opens its own thread when it loses the race to adopt the unbranded one', async () => {
    // Two branches can reach the same orphan at once. The `.is(null)`
    // guard on the UPDATE means only one wins; the loser must NOT fall
    // through into a thread that now belongs to the other branch.
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: null,
      orphanConversation: { id: 'cv-legacy' },
      adoptionWins: false,
      insertedConversationId: 'cv-own',
    });

    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+14155550123',
      null,
      'cfg-1',
    );

    expect(res.conversationId).toBe('cv-own');
    expect(res.conversationId).not.toBe('cv-legacy');
  });

  it('refuses to create anything when the number cannot be resolved', async () => {
    // Several numbers, none named and none primary. A conversation
    // created here would be permanently unsendable, so the failure has
    // to happen before any row is written.
    const db = makeDb({
      config: null, // resolveConfig finds no usable number
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      insertedConversationId: 'cv-should-not-be-created',
    });

    await expect(
      resolveConversationByPhone(db, 'acct', '+14155550123'),
    ).rejects.toBeInstanceOf(SendMessageError);
  });
});
