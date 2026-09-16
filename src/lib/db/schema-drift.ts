/**
 * Detectors for one specific situation: the deployed code is ahead of
 * the database it is talking to.
 *
 * Four migrations — `042`, `043`, `044`, `048` — were parked by the
 * single-number decision and have never been applied to any database.
 * Code that reads what they create is still live on production, and
 * every instance of it fails the same way: a request that should work
 * returns 500, or an RPC that should exist answers 404.
 *
 * Three have been found so far, each by accident rather than by search:
 * `my_accounts()` (`583d501`), `quick_replies.whatsapp_config_id`, and
 * the broadcast pair. The reason they kept slipping through is that the
 * test suite stubs the Supabase client, so the schema under test is
 * whatever the test assumes — a green gate says nothing at all about a
 * column or function that is not there.
 *
 * These helpers exist so the next one is handled deliberately instead of
 * surfacing as a 500 in front of a parent.
 */

/**
 * Postgres reports an unknown column as `42703`. PostgREST answers from
 * its own schema cache and reports `PGRST204` instead. Both mean the
 * column is not on this database.
 */
const COLUMN_NOT_FOUND = new Set(['42703', 'PGRST204']);

/**
 * Postgres reports an undefined function as `42883`; PostgREST resolves
 * RPCs by matching NAMED arguments, so a call carrying one argument too
 * many matches nothing and comes back as `PGRST202`.
 *
 * That second case is the subtle one: the function exists, under an
 * older signature, and the call still fails.
 */
const FUNCTION_NOT_FOUND = new Set(['PGRST202', '42883']);

export interface DbError {
  code?: string;
  message?: string;
}

/**
 * Whether the error says `column` specifically is absent.
 *
 * The column name is required, and matched against the message, on
 * purpose: a fallback that also swallowed an unrelated `42703` would
 * hand back a successful-looking response for a real bug, which is how
 * this class of defect stayed hidden in the first place.
 */
export function isMissingColumn(
  error: DbError | null | undefined,
  column: string,
): boolean {
  if (!error?.code || !COLUMN_NOT_FOUND.has(error.code)) return false;
  return (error.message ?? '').includes(column);
}

/**
 * Whether the error says no function matched the call.
 *
 * No name check here, unlike `isMissingColumn`: PostgREST's `PGRST202`
 * message names the schema and the arguments rather than reliably
 * naming the function, and a caller is in a position to know which RPC
 * it just made.
 */
export function isMissingFunction(error: DbError | null | undefined): boolean {
  return Boolean(error?.code && FUNCTION_NOT_FOUND.has(error.code));
}

/**
 * Postgres reports an unknown relation as `42P01`. PostgREST answers
 * from its schema cache and reports `PGRST205`, whose message names the
 * table and often suggests a near match.
 */
const TABLE_NOT_FOUND = new Set(['42P01', 'PGRST205']);

/**
 * Whether the error says `table` specifically is absent.
 *
 * The other two detectors here cover code that ran AHEAD of a parked
 * migration. This one covers the same drift from the other direction: a
 * migration that is new rather than parked, deployed a moment later
 * than the code that reads it.
 *
 * `051_call_logs.sql` is the live case. It is not parked — it is meant
 * to be applied — but the apply is a human step in the Supabase SQL
 * editor and the deploy is a merge, and the evening that produced this
 * module is three separate proofs that "we will apply it first" is a
 * plan, not a guarantee.
 *
 * Name required, same as `isMissingColumn` and for the same reason: a
 * fallback that swallowed any `42P01` would return an empty list for a
 * typo'd table name, which reads as "no rows yet" forever.
 */
export function isMissingTable(
  error: DbError | null | undefined,
  table: string,
): boolean {
  if (!error?.code || !TABLE_NOT_FOUND.has(error.code)) return false;
  return (error.message ?? '').includes(table);
}
