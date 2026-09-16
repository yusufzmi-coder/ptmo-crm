import { describe, expect, it } from 'vitest';
import { isMissingColumn, isMissingFunction,
  isMissingTable } from './schema-drift';

describe('isMissingColumn', () => {
  it.each(['42703', 'PGRST204'])('recognises both codes (%s)', (code) => {
    expect(
      isMissingColumn(
        { code, message: 'column broadcasts.whatsapp_config_id does not exist' },
        'whatsapp_config_id',
      ),
    ).toBe(true);
  });

  it('refuses to match a different missing column', () => {
    // The whole point of the name check. A fallback triggered by any
    // 42703 would return a successful-looking response for a real bug.
    expect(
      isMissingColumn(
        { code: '42703', message: 'column broadcasts.template_name does not exist' },
        'whatsapp_config_id',
      ),
    ).toBe(false);
  });

  it('is not fooled by an ordinary failure', () => {
    expect(
      isMissingColumn({ code: '08006', message: 'connection failure' }, 'x'),
    ).toBe(false);
  });

  it('survives a missing code or message', () => {
    expect(isMissingColumn(null, 'x')).toBe(false);
    expect(isMissingColumn(undefined, 'x')).toBe(false);
    expect(isMissingColumn({ code: '42703' }, 'x')).toBe(false);
    expect(isMissingColumn({ message: 'x' }, 'x')).toBe(false);
  });
});

describe('isMissingFunction', () => {
  it.each(['PGRST202', '42883'])('recognises both codes (%s)', (code) => {
    expect(isMissingFunction({ code, message: 'Could not find the function' })).toBe(
      true,
    );
  });

  it('covers the signature mismatch, not just a missing name', () => {
    // PostgREST resolves RPCs by named arguments. A call carrying one
    // argument too many matches nothing and returns PGRST202 even though
    // a function of that name exists under an older signature. That is
    // exactly what an un-applied 048 does to create_broadcast_with_recipients.
    expect(
      isMissingFunction({
        code: 'PGRST202',
        message:
          'Could not find the function public.create_broadcast_with_recipients(p_account_id, ..., p_whatsapp_config_id) in the schema cache',
      }),
    ).toBe(true);
  });

  it('is not fooled by an ordinary failure', () => {
    expect(isMissingFunction({ code: '08006' })).toBe(false);
    expect(isMissingFunction(null)).toBe(false);
  });
});

describe('isMissingTable', () => {
  it.each(['42P01', 'PGRST205'])('recognises both codes (%s)', (code) => {
    expect(
      isMissingTable(
        { code, message: 'relation "call_logs" does not exist' },
        'call_logs',
      ),
    ).toBe(true);
  });

  it('requires the table name, so an unrelated 42P01 still surfaces', () => {
    // The whole point of naming it: a fallback that swallowed any 42P01
    // would hand back an empty list for a typo'd table, which reads as
    // "no rows yet" for as long as nobody checks.
    expect(
      isMissingTable(
        { code: '42P01', message: 'relation "widgets" does not exist' },
        'call_logs',
      ),
    ).toBe(false);
  });

  it('is not fooled by an ordinary failure', () => {
    expect(isMissingTable({ code: '08006' }, 'call_logs')).toBe(false);
    expect(isMissingTable(null, 'call_logs')).toBe(false);
    expect(isMissingTable({ code: '42P01' }, 'call_logs')).toBe(false);
  });
});
