import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveConfig, resolveFailureMessage } from '@/lib/whatsapp/resolve-config'

/**
 * Proxy for inbound WhatsApp media that was never mirrored into
 * `chat-media` (see migration 039). Meta only hands the bytes to a
 * request carrying an access token, so the browser cannot fetch them
 * itself — this route fetches them on the caller's behalf.
 *
 * Which makes it an authorization boundary, not a convenience. A Meta
 * media id is a short opaque number and nothing about it identifies an
 * account, so "authenticated" is not nearly enough: without the lookup
 * below, any signed-in user could walk another zone's attachments by
 * guessing ids.
 *
 * The check is a lookup rather than a claim in the URL, because the
 * pointer shape `/api/whatsapp/media/<mediaId>` is PERSISTED in
 * `messages.media_url` by the webhook and read back verbatim by the
 * inbox — there is no room to pass a conversation id alongside it. So
 * we go the other way: find the message that carries this pointer,
 * using the caller's RLS-scoped client. `messages` has no `account_id`
 * of its own; its policy is an EXISTS on `conversations`, which runs
 * through `is_account_member` and therefore through the ACTIVE ZONE
 * rule (`docs/zones.md`). A row belonging to another zone is simply
 * not returned, and the conversation re-check below says so again in
 * the application, where it is visible to a reader.
 *
 * The conversation that lookup yields is then what picks the number.
 * Downloading uses a WABA-level token, so in practice several of an
 * account's numbers would work — but "in practice" is how the wrong
 * number gets baked in. The thread knows which centre it belongs to;
 * ask it, and never fall back to the account primary.
 */

/**
 * Meta media ids are numeric strings. Keep the value that reaches a
 * PostgREST `eq()` free of its filter metacharacters (`,` `.` `%` `(`)
 * rather than trusting the client to send something sane.
 */
const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const ctx = await requireRole('viewer')

    const { mediaId } = await params

    if (!mediaId || !MEDIA_ID_PATTERN.test(mediaId)) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    // The pointer exactly as the webhook persisted it.
    const pointer = `/api/whatsapp/media/${mediaId}`

    // `limit(1)` rather than `maybeSingle()`: one attachment forwarded
    // into two threads is two rows with the same pointer, and that is a
    // legitimate state, not a 500.
    const { data: messages, error: messageError } = await ctx.supabase
      .from('messages')
      .select('id, conversation_id')
      .eq('media_url', pointer)
      .limit(1)
    if (messageError) throw messageError

    const conversationId = (
      messages as { conversation_id?: string | null }[] | null
    )?.[0]?.conversation_id

    if (!conversationId) {
      return notFound()
    }

    // Second gate, deliberately explicit. RLS has already excluded other
    // zones; this states the rule in code so a future RLS change cannot
    // widen the route silently.
    const { data: conversation, error: conversationError } = await ctx.supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (conversationError) throw conversationError

    if (!conversation) {
      return notFound()
    }

    // The thread's own number. No `allowPrimary` — see the note above.
    const resolvedConfig = await resolveConfig(ctx.supabase, ctx.accountId, {
      conversationId: (conversation as { id: string }).id,
      columns: '*',
    })
    if (!resolvedConfig.ok) {
      return NextResponse.json(
        { error: resolveFailureMessage(resolvedConfig.reason) },
        { status: 400 }
      )
    }
    const config = resolvedConfig.config

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        // These bytes are authorized per caller and per zone, so they
        // must never land in a shared cache. `next.config.ts` already
        // forces `no-store` on `/api/*`; saying it here too means the
        // route stays correct if that rule ever moves. The inbox
        // memoises the blob in `src/lib/media/blob-cache.ts`, so the
        // repeat views this used to cache for cost nothing anyway.
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    // `toErrorResponse` maps the auth errors to 401/403 and logs
    // anything else before collapsing it to a 500, so a Meta outage or
    // a PostgREST error still reaches the server log with its details
    // while the caller gets nothing back about our internals.
    return toErrorResponse(error)
  }
}

/**
 * One response for "no such media" and "not yours". Telling the two
 * apart would turn the route into an oracle for which ids exist in
 * other zones.
 */
function notFound() {
  return NextResponse.json({ error: 'Media not found' }, { status: 404 })
}
