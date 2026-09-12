import type { SupabaseClient } from '@supabase/supabase-js'

import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { parseMediaProxyPath } from '@/lib/media/proxy-url'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with an IMAGE header — a plain public
 * URL is not accepted at creation time. This helper turns the template's
 * `header_media_url` (whether the user uploaded a file or pasted a link)
 * into a handle and writes it onto the payload, so both the upload path
 * and the legacy URL path actually succeed.
 *
 * No-op unless the header is an image that has a URL but no handle yet.
 * Image-only for now (the #230 scope); video/document handles can follow
 * the same shape.
 */

// Meta's image-header sample limits.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png']

export async function ensureImageHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
  // Needed only when `header_media_url` is one of our own storage
  // pointers. Optional so the pasted-public-link path — and the tests
  // covering it — need no client at all.
  db?: SupabaseClient,
): Promise<void> {
  if (payload.header_type !== 'image') return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const appId = process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      'Image-header templates need META_APP_ID set (used for Meta’s Resumable Upload). Add it to your environment, or remove the image header.',
    )
  }

  // Our own upload (migration 047 made the buckets private, so the
  // template form now stores `/api/media/<bucket>/<path>`). Read the bytes
  // straight out of storage rather than over HTTP: a relative pointer is
  // not fetchable at all, and the authenticated route answers with a 307
  // to a signed URL, which the `redirect: 'manual'` below deliberately
  // refuses to follow. Going direct also takes our own files off the
  // SSRF-guarded path entirely — there is no URL to guard.
  const pointer = parseMediaProxyPath(payload.header_media_url)
  if (pointer) {
    if (!db) {
      throw new Error(
        'Could not read the uploaded header image: no storage client was provided.',
      )
    }
    const { data, error } = await db.storage
      .from(pointer.bucket)
      .download(pointer.objectPath)
    if (error || !data) {
      throw new Error(
        `Could not read the uploaded header image: ${error?.message ?? 'not found'}`,
      )
    }
    await attachHandle({
      payload,
      appId,
      accessToken,
      bytes: new Uint8Array(await data.arrayBuffer()),
      contentType: (data.type || '').split(';')[0].trim().toLowerCase(),
    })
    return
  }

  // SSRF guard: `header_media_url` is caller-supplied (any authenticated
  // member can submit a template) and the fetch below happens server-side,
  // so refuse any destination that resolves to a private / loopback /
  // link-local / reserved address. Same guard, same message as the two
  // other outbound-fetch call sites (see lib/webhooks/ssrf.ts) — matching
  // the unreachable-host message keeps the failure from being an oracle.
  if (!(await isDeliverableUrl(payload.header_media_url))) {
    throw new Error('Could not fetch the header image URL. Make sure it is publicly reachable.')
  }

  // Fetch the sample image bytes (works for our uploaded chat-media URL
  // and for a manually-pasted public link).
  let res: Response
  try {
    res = await fetch(payload.header_media_url, {
      // Do NOT follow redirects — a public URL could 3xx-bounce to an
      // internal address, defeating the guard above. Bound the request so
      // a hung host can't tie up the template-submit handler.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('Could not fetch the header image URL. Make sure it is publicly reachable.')
  }
  if (!res.ok) {
    throw new Error(`Header image URL returned ${res.status}. It must be publicly reachable.`)
  }

  await attachHandle({
    payload,
    appId,
    accessToken,
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: (res.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase(),
  })
}

/**
 * Validate the sample against Meta's image-header limits, upload it, and
 * write the resulting handle onto the payload.
 *
 * Shared by both byte sources — a storage download and an HTTP fetch — so
 * the size and type rules cannot drift between "the user uploaded a file"
 * and "the user pasted a link".
 */
async function attachHandle(args: {
  payload: TemplatePayload
  appId: string
  accessToken: string
  bytes: Uint8Array
  contentType: string
}): Promise<void> {
  const { payload, appId, accessToken, bytes, contentType } = args

  if (contentType && !ALLOWED_IMAGE_TYPES.includes(contentType)) {
    throw new Error(`Header image must be JPEG or PNG (got ${contentType}).`)
  }
  if (bytes.byteLength === 0) {
    throw new Error('Header image is empty.')
  }
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw new Error(
      `Header image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — Meta's limit is 5 MB.`,
    )
  }

  const mimeType = ALLOWED_IMAGE_TYPES.includes(contentType) ? contentType : 'image/jpeg'
  const fileName = mimeType === 'image/png' ? 'header.png' : 'header.jpg'

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}
