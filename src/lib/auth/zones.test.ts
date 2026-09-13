import { describe, expect, it, vi } from 'vitest';

import {
  activeZone,
  currentZoneName,
  fetchZones,
  parseZones,
  shouldShowSwitcher,
  switchActiveZone,
  type Zone,
} from './zones';

// A Supabase stub that records the RPC it was asked for. Only `.rpc()`
// is exercised here — reading `account_members` directly is exactly what
// this module must never do, so there is no table stub to reach for.
function stubDb(handler: (fn: string, args?: unknown) => { data: unknown; error: unknown }) {
  const calls: Array<{ fn: string; args?: unknown }> = [];
  const db = {
    rpc: vi.fn(async (fn: string, args?: unknown) => {
      calls.push({ fn, args });
      return handler(fn, args);
    }),
  };
  return { db: db as never, calls };
}

const row = (over: Record<string, unknown> = {}) => ({
  account_id: 'zone-a',
  name: 'Zone A',
  role: 'admin',
  is_active: true,
  ...over,
});

describe('parseZones', () => {
  it('keeps the order my_accounts() returned', () => {
    const zones = parseZones([
      row({ account_id: 'zone-a', name: 'Ampang', is_active: false }),
      row({ account_id: 'zone-b', name: 'Batu Caves', is_active: true }),
    ]);
    expect(zones.map((z) => z.name)).toEqual(['Ampang', 'Batu Caves']);
    expect(zones[1].isActive).toBe(true);
  });

  it('drops a row with no account id rather than rendering a dead entry', () => {
    expect(parseZones([row({ account_id: null }), row()])).toHaveLength(1);
  });

  it('keeps a zone whose role it does not recognise, as least-privileged', () => {
    // The user can still enter it; every UI gate treats a null role as
    // the lowest, so this fails closed rather than hiding the zone.
    const [zone] = parseZones([row({ role: 'superuser' })]);
    expect(zone.role).toBeNull();
  });

  it('falls back to the id when a zone somehow has no name', () => {
    expect(parseZones([row({ name: '  ' })])[0].name).toBe('zone-a');
  });

  it('treats a non-array answer as no zones', () => {
    expect(parseZones(null)).toEqual([]);
    expect(parseZones({ account_id: 'zone-a' })).toEqual([]);
  });
});

describe('shouldShowSwitcher', () => {
  const zone = (id: string): Zone => ({ id, name: id, role: 'agent', isActive: false });

  it('gives ordinary staff no switcher', () => {
    // One zone is the normal case: a menu with a single entry, already
    // selected, is a control that cannot do anything.
    expect(shouldShowSwitcher([zone('zone-a')])).toBe(false);
    expect(shouldShowSwitcher([])).toBe(false);
  });

  it('gives HQ a switcher once a second zone exists', () => {
    expect(shouldShowSwitcher([zone('zone-a'), zone('zone-b')])).toBe(true);
  });
});

describe('currentZoneName', () => {
  it('names the active zone', () => {
    const zones = parseZones([
      row({ account_id: 'zone-a', name: 'Ampang', is_active: false }),
      row({ account_id: 'zone-b', name: 'Batu Caves', is_active: true }),
    ]);
    expect(activeZone(zones)?.id).toBe('zone-b');
    expect(currentZoneName(zones, 'stale')).toBe('Batu Caves');
  });

  it('falls back to the account name while my_accounts() is in flight', () => {
    // The header must not flash an empty zone on the way in.
    expect(currentZoneName([], 'Ampang')).toBe('Ampang');
    expect(currentZoneName([], null)).toBeNull();
  });
});

describe('fetchZones', () => {
  it('reads the zone list through my_accounts(), not the table', async () => {
    const { db, calls } = stubDb(() => ({ data: [row()], error: null }));

    const result = await fetchZones(db);

    expect(result).toEqual({ ok: true, zones: parseZones([row()]) });
    expect(calls).toEqual([{ fn: 'my_accounts', args: undefined }]);
  });

  it('reports a failure instead of pretending the user has no zones', async () => {
    const { db } = stubDb(() => ({ data: null, error: { message: 'boom' } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(fetchZones(db)).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});

describe('switchActiveZone', () => {
  it('calls set_active_account and returns the destination', async () => {
    const { db, calls } = stubDb(() => ({
      data: [{ account_id: 'zone-b', name: 'Batu Caves', role: 'agent' }],
      error: null,
    }));

    const result = await switchActiveZone(db, 'zone-b');

    expect(calls).toEqual([
      { fn: 'set_active_account', args: { p_account_id: 'zone-b' } },
    ]);
    expect(result).toEqual({
      ok: true,
      zone: { id: 'zone-b', name: 'Batu Caves', role: 'agent', isActive: true },
    });
  });

  it('reports a zone the caller may not enter without saying whether it exists', async () => {
    // 044 raises the same 42501 for "not a member" and "no such zone", so
    // a probe cannot enumerate zone ids. Nothing here may widen that.
    const { db } = stubDb(() => ({
      data: null,
      error: { code: '42501', message: 'You are not a member of that zone' },
    }));

    const result = await switchActiveZone(db, 'zone-x');

    expect(result).toEqual({ ok: false, reason: 'not_member' });
  });

  it('separates a denial from a broken call', async () => {
    const { db } = stubDb(() => ({
      data: null,
      error: { code: '08006', message: 'connection failure' },
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(switchActiveZone(db, 'zone-b')).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it('refuses to report a switch it cannot describe', async () => {
    // The RPC succeeded but handed back no row. Calling that a success
    // would move the UI into a zone we cannot name.
    const { db } = stubDb(() => ({ data: [], error: null }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(switchActiveZone(db, 'zone-b')).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
  });
});
