/**
 * Shared shape for stored-media URLs.
 *
 * Migration 047 made `chat-media`, `flow-media` and `avatars` private, so
 * a stored `getPublicUrl()` string no longer resolves. What gets stored
 * instead is a pointer through an authenticated route, which checks the
 * caller's account before handing back a short-lived signed URL.
 *
 * The writer (`mirrorInboundMedia`, the composer upload) and the reader
 * (`/api/media/[bucket]/[...path]`) both go through here so the two can
 * never drift apart.
 *
 * This mirrors the pointer convention the webhook already used for
 * un-mirrored inbound media (`/api/whatsapp/media/<mediaId>`): a relative
 * path that means "ask the server for this", not a URL to a file server.
 */

/** The private buckets reachable through the media proxy. */
export const PROXYABLE_BUCKETS = [
  'chat-media',
  'flow-media',
  'avatars',
] as const;

export type ProxyableBucket = (typeof PROXYABLE_BUCKETS)[number];

export function isProxyableBucket(value: string): value is ProxyableBucket {
  return (PROXYABLE_BUCKETS as readonly string[]).includes(value);
}

const PREFIX = '/api/media/';

/**
 * Build the stored pointer for an object.
 *
 * Each path segment is percent-encoded individually so a filename with a
 * space or a `#` survives the round trip, while the `/` separators stay
 * literal — `encodeURIComponent` on the whole path would escape those too
 * and break the dynamic-segment match.
 */
export function mediaProxyPath(bucket: ProxyableBucket, objectPath: string): string {
  const encoded = objectPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join('/');
  return `${PREFIX}${bucket}/${encoded}`;
}

/**
 * Inverse of `mediaProxyPath`, for anything that needs to get back to the
 * storage coordinates — re-signing, deletion, tests.
 *
 * Returns null for a string that is not one of our pointers, including a
 * legacy absolute `getPublicUrl()` value left in an old row, so callers
 * can tell "this is a proxy pointer" from "this is something else"
 * without a second check.
 */
export function parseMediaProxyPath(
  value: string | null | undefined
): { bucket: ProxyableBucket; objectPath: string } | null {
  if (!value || !value.startsWith(PREFIX)) return null;

  const rest = value.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;

  const bucket = rest.slice(0, slash);
  if (!isProxyableBucket(bucket)) return null;

  const objectPath = rest
    .slice(slash + 1)
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent)
    .join('/');
  if (!objectPath) return null;

  return { bucket, objectPath };
}

/**
 * The account folder an object path must sit under.
 *
 * Both the storage RLS policies (020, 023, 047) and the proxy route's own
 * check compare against this exact string, so it is defined once.
 */
export function accountFolder(accountId: string): string {
  return `account-${accountId}`;
}

/**
 * Whether `objectPath` belongs to `accountId`.
 *
 * This is the proxy route's authorization test. It is a prefix match on
 * the FIRST segment only, matching the storage policies — and it refuses
 * any traversal segment, because the path reaches the route from the URL
 * and `account-<mine>/../account-<theirs>/x` would otherwise pass a naive
 * `startsWith`.
 */
export function pathBelongsToAccount(objectPath: string, accountId: string): boolean {
  const segments = objectPath.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return false;
  if (segments.some((s) => s === '.' || s === '..')) return false;
  return segments[0] === accountFolder(accountId);
}
