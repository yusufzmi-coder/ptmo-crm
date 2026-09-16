import type { CallDirection, CallOutcome } from '@/types';

/**
 * The runtime lists behind the `CallDirection` and `CallOutcome` unions,
 * and the map from a route's error code to a catalogue key.
 *
 * Same shape as src/lib/issues/labels.ts, and for the reason written
 * there: a `Record<Union, true>` cannot be missing a member, so adding a
 * sixth outcome to the type without adding it here is a compile error
 * naming the property — rather than a value the API silently refuses and
 * the picker silently stops offering.
 *
 * THE WRITE ORDER BELOW IS THE DISPLAY ORDER. `Object.keys` returns
 * string keys in insertion order, so reordering the Record reorders
 * every picker that maps over these. Sort at the call site if a screen
 * wants a different order; do not reorder here.
 */

const DIRECTION_MEMBERS: Record<CallDirection, true> = {
  keluar: true,
  masuk: true,
};

const OUTCOME_MEMBERS: Record<CallOutcome, true> = {
  dijawab: true,
  tidak_dijawab: true,
  tinggal_mesej: true,
  call_balik: true,
  nombor_salah: true,
};

export const CALL_DIRECTIONS = Object.keys(
  DIRECTION_MEMBERS,
) as readonly CallDirection[];

export const CALL_OUTCOMES = Object.keys(
  OUTCOME_MEMBERS,
) as readonly CallOutcome[];

export function isCallDirection(value: unknown): value is CallDirection {
  return typeof value === 'string' && value in DIRECTION_MEMBERS;
}

export function isCallOutcome(value: unknown): value is CallOutcome {
  return typeof value === 'string' && value in OUTCOME_MEMBERS;
}

/**
 * Outcomes that mean the parent is still waiting on us.
 *
 * Not a cosmetic grouping: the dialog uses it to decide whether to
 * insist on a follow-up time. A call that rang out with no plan to try
 * again is the failure this whole table exists to stop — the thread
 * goes quiet and nobody can tell, six weeks later, whether anyone ever
 * called back.
 */
const UNFINISHED: Record<CallOutcome, boolean> = {
  dijawab: false,
  tidak_dijawab: true,
  tinggal_mesej: true,
  call_balik: true,
  nombor_salah: false,
};

export function needsFollowUp(outcome: CallOutcome): boolean {
  return UNFINISHED[outcome];
}

/**
 * Parse a duration typed as minutes into the seconds the column stores.
 *
 * Minutes because that is how people say it ("about five minutes"), and
 * seconds in the column because a duration that cannot express 90
 * seconds is a duration nobody trusts.
 *
 * Returns `null` for an empty box — a call with no recorded length —
 * and `undefined` for something that is not a usable number, which the
 * caller must treat as a validation failure rather than as "no value".
 * The two are deliberately different: silently storing NULL for "abc"
 * throws away the fact that the user typed something.
 */
export function parseDurationMinutes(
  raw: string,
): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const minutes = Number(trimmed);
  if (!Number.isFinite(minutes) || minutes < 0) return undefined;
  return Math.round(minutes * 60);
}

/** Seconds back to a short human duration: 95 → "1m 35s", 40 → "40s". */
export function formatDuration(seconds: number | null): string | null {
  if (seconds == null || seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Route error code → catalogue key under `Calls.errors`.
 *
 * The routes return snake_case codes and the catalogue uses camelCase
 * keys, so the two cannot be lined up by name. Kept here rather than
 * inside each component for the reason issues/labels.ts gives: separate
 * copies disagree the moment a code is added.
 */
export const CALL_ERROR_KEYS = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  profile_not_linked: 'profileNotLinked',
  invalid_body: 'invalidBody',
  summary_required: 'summaryRequired',
  invalid_direction: 'invalidDirection',
  invalid_outcome: 'invalidOutcome',
  invalid_duration: 'invalidDuration',
  invalid_called_at: 'invalidCalledAt',
  insert_failed: 'saveFailed',
} as const satisfies Record<string, string>;

export type CallErrorCode = keyof typeof CALL_ERROR_KEYS;

/**
 * The catalogue key for an error code, falling back to `saveFailed`.
 *
 * The fallback is narrow but deliberate: a code this map has not heard
 * of came from a route somebody changed without coming here, and "that
 * did not save" is closer to true than rendering the raw code. It is
 * not a licence to skip adding the key — the test beside this file
 * fails on any route code that is missing.
 */
export function callErrorKey(code: string | undefined | null): string {
  if (!code) return 'saveFailed';
  return (CALL_ERROR_KEYS as Record<string, string>)[code] ?? 'saveFailed';
}
