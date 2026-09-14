import { describe, expect, it } from 'vitest';
import {
  configDisplayName,
  resolveConfig,
  resolveFailureMessage,
  type WhatsAppConfigRow,
} from './resolve-config';

// Minimal PostgREST-shaped stub: records the filters a call applied and
// returns whatever the fixture says that table holds.
type Row = Record<string, unknown>;

function stubDb(tables: { whatsapp_config: Row[]; conversations?: Row[] }) {
  const make = (rows: Row[]) => {
    const filters: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    const apply = () =>
      rows.filter((r) =>
        Object.entries(filters).every(([k, v]) => r[k] === v),
      );
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return q;
    };
    q.limit = (n: number) =>
      Promise.resolve({ data: apply().slice(0, n), error: null });
    q.maybeSingle = () => {
      const hit = apply();
      return Promise.resolve({ data: hit[0] ?? null, error: null });
    };
    return q;
  };
  return {
    from: (table: string) =>
      make(
        table === 'whatsapp_config'
          ? tables.whatsapp_config
          : (tables.conversations ?? []),
      ),
  } as never;
}

const cfg = (over: Partial<WhatsAppConfigRow> = {}): Row => ({
  id: 'cfg-bc',
  account_id: 'acc-1',
  phone_number_id: '60100000001',
  waba_id: 'waba-1',
  access_token: 'enc',
  status: 'connected',
  label: 'Batu Caves',
  is_primary: true,
  ...over,
});

const rawang = cfg({
  id: 'cfg-rw',
  phone_number_id: '60100000002',
  label: 'Rawang',
  is_primary: false,
});

describe('resolveConfig — a reply leaves on the number it arrived on', () => {
  it("uses the conversation's own number even when another is primary", async () => {
    const db = stubDb({
      whatsapp_config: [cfg(), rawang],
      conversations: [
        { id: 'conv-1', account_id: 'acc-1', whatsapp_config_id: 'cfg-rw' },
      ],
    });
    const r = await resolveConfig(db, 'acc-1', { conversationId: 'conv-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.label).toBe('Rawang');
  });

  it('falls back to the only number when a pre-040 thread has none', async () => {
    const db = stubDb({
      whatsapp_config: [cfg()],
      conversations: [
        { id: 'conv-1', account_id: 'acc-1', whatsapp_config_id: null },
      ],
    });
    const r = await resolveConfig(db, 'acc-1', { conversationId: 'conv-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.id).toBe('cfg-bc');
  });

  it('refuses to guess when a thread has no number and several exist', async () => {
    const db = stubDb({
      whatsapp_config: [cfg(), rawang],
      conversations: [
        { id: 'conv-1', account_id: 'acc-1', whatsapp_config_id: null },
      ],
    });
    const r = await resolveConfig(db, 'acc-1', { conversationId: 'conv-1' });
    expect(r).toEqual({ ok: false, reason: 'conversation_has_no_number' });
  });

  it('reports not_configured rather than a thread problem when nothing is connected', async () => {
    const db = stubDb({
      whatsapp_config: [],
      conversations: [
        { id: 'conv-1', account_id: 'acc-1', whatsapp_config_id: null },
      ],
    });
    const r = await resolveConfig(db, 'acc-1', { conversationId: 'conv-1' });
    expect(r).toEqual({ ok: false, reason: 'not_configured' });
  });
});

describe('resolveConfig — explicit choice', () => {
  it('honours an explicit configId over the conversation', async () => {
    const db = stubDb({
      whatsapp_config: [cfg(), rawang],
      conversations: [
        { id: 'conv-1', account_id: 'acc-1', whatsapp_config_id: 'cfg-bc' },
      ],
    });
    const r = await resolveConfig(db, 'acc-1', {
      conversationId: 'conv-1',
      configId: 'cfg-rw',
    });
    expect(r.ok && r.config.id).toBe('cfg-rw');
  });

  it("rejects another account's number", async () => {
    const db = stubDb({ whatsapp_config: [cfg({ account_id: 'acc-2' })] });
    const r = await resolveConfig(db, 'acc-1', { configId: 'cfg-bc' });
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('resolveConfig — no thread, no choice', () => {
  it('returns the only number without needing allowPrimary', async () => {
    const db = stubDb({ whatsapp_config: [cfg({ is_primary: false })] });
    const r = await resolveConfig(db, 'acc-1');
    expect(r.ok && r.config.id).toBe('cfg-bc');
  });

  it('is ambiguous with several numbers unless primary is allowed', async () => {
    const db = stubDb({ whatsapp_config: [cfg(), rawang] });
    expect(await resolveConfig(db, 'acc-1')).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
    const withPrimary = await resolveConfig(db, 'acc-1', {
      allowPrimary: true,
    });
    expect(withPrimary.ok && withPrimary.config.label).toBe('Batu Caves');
  });

  it('stays ambiguous when several exist and none is primary', async () => {
    const db = stubDb({
      whatsapp_config: [cfg({ is_primary: false }), rawang],
    });
    const r = await resolveConfig(db, 'acc-1', { allowPrimary: true });
    expect(r).toEqual({ ok: false, reason: 'ambiguous' });
  });
});

describe('display helpers', () => {
  it('shows the branch name, falling back to the raw number', () => {
    expect(configDisplayName({ label: 'Gombak', phone_number_id: '601' })).toBe(
      'Gombak',
    );
    expect(configDisplayName({ label: '  ', phone_number_id: '601' })).toBe('601');
    expect(configDisplayName({ label: null, phone_number_id: '601' })).toBe('601');
  });

  it('has a message for every failure reason', () => {
    for (const reason of [
      'not_configured',
      'conversation_has_no_number',
      'not_found',
      'ambiguous',
    ] as const) {
      expect(resolveFailureMessage(reason).length).toBeGreaterThan(10);
    }
  });
});
