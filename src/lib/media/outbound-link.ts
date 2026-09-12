import type { SupabaseClient } from '@supabase/supabase-js';

import { parseMediaProxyPath } from './proxy-url';

/**
 * Turn a stored media value into a URL Meta can fetch by itself.
 *
 * `sendMediaMessage` (src/lib/whatsapp/meta-api.ts) passes `{ link }` and
 * nothing else — Meta downloads the bytes from that URL on its own
 * schedule, unauthenticated. That is the one place in the app where an
 * outside party genuinely needs to read our storage, and it is why
 * migration 047 could not simply make the buckets private and stop.
 *
 * So the two needs are split:
 *
 *   what we PERSIST  -> `/api/media/<bucket>/<path>`, a pointer our own
 *                       authenticated route resolves, durable for as long
 *                       as the object exists
 *   what META GETS   -> a short-lived signed URL minted here, at send time
 *
 * Anything that is not one of our pointers passes through untouched. The
 * public API documents `media_url` as any https URL
 * (src/app/api/v1/messages/route.ts:18), and a caller's own CDN link must
 * keep working.
 */

/**
 * How long Meta has to collect the bytes.
 *
 * Meta fetches within seconds of the send in practice, so an hour is
 * generous rather than tight — but it is deliberately not longer: the URL
 * is handed to a third party and grants unauthenticated read of one
 * object for exactly as long as it lives.
 */
export const OUTBOUND_SIGNED_URL_TTL_SECONDS = 60 * 60;

export class OutboundLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundLinkError';
  }
}

export async function metaFetchableLink(
  db: SupabaseClient,
  mediaUrl: string
): Promise<string> {
  const pointer = parseMediaProxyPath(mediaUrl);

  // Not ours — an external URL supplied through the public API, or a
  // legacy absolute public URL from a row written before 047. Either way
  // we have nothing to sign and no business rewriting it.
  if (!pointer) return mediaUrl;

  const { data, error } = await db.storage
    .from(pointer.bucket)
    .createSignedUrl(pointer.objectPath, OUTBOUND_SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    // Fail the send rather than handing Meta a link it cannot read. Meta
    // would accept the message, fail the fetch on its own side, and the
    // agent would see a sent bubble the parent never received — the worst
    // of the available outcomes.
    throw new OutboundLinkError(
      `Could not prepare ${pointer.objectPath} for sending: ${
        error?.message ?? 'no signed URL returned'
      }`
    );
  }

  return data.signedUrl;
}
