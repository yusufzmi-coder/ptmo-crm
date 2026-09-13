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

/**
 * The path Supabase serves a public bucket object from.
 *
 * Rows written before 047 hold an absolute URL built around this segment
 * by `getPublicUrl()`. After 047 that URL 400s, so the segment is how we
 * recognise one and recover the storage coordinates behind it.
 */
const LEGACY_PUBLIC_SEGMENT = '/storage/v1/object/public/';

/** Prefix of the inbound-media proxy, which predates 047 and still works. */
const INBOUND_PROXY_PREFIX = '/api/whatsapp/media/';

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
 * Recover storage coordinates from a pre-047 absolute public URL.
 *
 * Migration 047 makes the buckets private, and `messages.media_url` rows
 * written before it hold `<host>/storage/v1/object/public/<bucket>/<path>`.
 * Those strings stop resolving the moment the flag flips. This is the
 * compatibility half of the fix: it turns such a URL back into the
 * (bucket, path) pair the proxy can sign. Migration 050 rewrites the
 * stored rows; this keeps anything the backfill missed — a row inserted
 * by an old build mid-deploy, a restored backup — readable.
 *
 * Safety: the coordinates are only ever used to sign an object in OUR
 * storage. The URL itself is never fetched, redirected to, or echoed
 * back, so a hostile value cannot turn this into an open redirect or an
 * SSRF. Three gates keep it that way:
 *
 *   1. the path must have the exact public-object shape;
 *   2. the bucket must be one of `PROXYABLE_BUCKETS`;
 *   3. when `NEXT_PUBLIC_SUPABASE_URL` is configured, the host must match
 *      it — so a URL pointing at somebody else's Supabase project is not
 *      silently treated as one of ours.
 *
 * Returns null for anything else, including a relative path, a pointer,
 * or an unrelated external URL. Null means "not ours to serve", never
 * "serve it anyway".
 */
export function parseLegacyPublicUrl(
  value: string | null | undefined,
  expectedHost: string | null = defaultStorageHost()
): { bucket: ProxyableBucket; objectPath: string } | null {
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not absolute — a pointer or a bare path. Not our concern here.
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (expectedHost && url.host !== expectedHost) return null;

  const at = url.pathname.indexOf(LEGACY_PUBLIC_SEGMENT);
  if (at < 0) return null;

  const rest = url.pathname.slice(at + LEGACY_PUBLIC_SEGMENT.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;

  const bucket = decodeURIComponent(rest.slice(0, slash));
  if (!isProxyableBucket(bucket)) return null;

  // The stored URL is already percent-encoded segment by segment, which
  // is the same shape `mediaProxyPath` produces — so decoding here and
  // re-encoding there round-trips a filename with a space or a `#`.
  const objectPath = rest
    .slice(slash + 1)
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent)
    .join('/');
  if (!objectPath) return null;

  return { bucket, objectPath };
}

/** Host of the configured Supabase project, or null if it is not set. */
function defaultStorageHost(): string | null {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configured) return null;
  try {
    return new URL(configured).host;
  } catch {
    return null;
  }
}

/**
 * Turn a stored `media_url` into something the browser can actually load.
 *
 * Four kinds of value reach this function, and only one of them changes:
 *
 *   `/api/media/...`          already a pointer            — unchanged
 *   `/api/whatsapp/media/...` the inbound proxy (pre-dates 047) — unchanged
 *   a pre-047 public bucket URL                            — REWRITTEN
 *   anything else                                          — unchanged
 *
 * That last case is deliberate. `POST /api/v1/messages` lets an API
 * caller supply their own `media_url`, and a message template header can
 * hold a plain link. Those are the operator's own URLs and always were;
 * rewriting them would break the feature, and nulling them would hide
 * content. They are handed back exactly as stored and never routed
 * through the proxy, so this function cannot be used to make our server
 * fetch a third-party address.
 */
export function resolveStoredMediaUrl(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  if (value.startsWith(PREFIX)) return value;
  if (value.startsWith(INBOUND_PROXY_PREFIX)) return value;

  const legacy = parseLegacyPublicUrl(value);
  if (legacy) return mediaProxyPath(legacy.bucket, legacy.objectPath);

  return value;
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
