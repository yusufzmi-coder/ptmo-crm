/**
 * Realtime topic names, scoped to the active zone.
 *
 * A Supabase Realtime topic is only a routing name — it does not filter
 * rows, RLS does. But the topic is what the subscription is keyed on, so
 * a topic that ignores the account never changes when the user switches
 * zone, and the channel is never torn down and rebuilt. That was the
 * inbox bug: a static `"inbox-realtime"` outlived the switch, and the
 * previous zone's conversations stayed on screen because nothing told
 * the page to start over.
 *
 * See `docs/zones.md` ("Realtime subscriptions must be torn down and
 * rebuilt on a zone change, and cached state cleared").
 */

/**
 * Topic for an account-scoped channel, or `null` when there is no active
 * zone to scope it to.
 *
 * Returning `null` rather than a bare `base` is the point: callers treat
 * it as "do not subscribe yet". Falling back to an unscoped topic would
 * reintroduce exactly the channel that survives a zone switch, and would
 * do it silently — during the moment before the profile resolves, which
 * is the easiest state to forget about.
 */
export function realtimeTopic(
  base: string,
  accountId: string | null | undefined,
): string | null {
  if (!accountId || !accountId.trim()) return null;
  return `${base}:${accountId}`;
}
