import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveConfig, resolveFailureMessage } from '@/lib/whatsapp/resolve-config'

// Proxy for inbound media that was NOT mirrored into storage — the
// fallback the webhook falls back to when the mirror is off or refused
// the file (webhook/route.ts, `verifyAndBuildUrl`). The bytes still live
// on Meta's side, so this route re-fetches them with the branch's token.
//
// It used to take `mediaId` straight from the URL and hand it to Meta
// with the account's PRIMARY token, checking only that the caller had an
// account at all. Two problems, both fixed here:
//
//   1. No ownership check. Any authenticated user — `viewer` included,
//      since the route had no role gate either — could fetch any media id
//      the shared WABA token could reach, which in a 16-centre
//      single-WABA deployment is every centre's attachments.
//   2. `allowPrimary: true` meant centre B's media was downloaded with
//      centre A's token. Tokens are per-`whatsapp_config` row, so under
//      the zone model that is one zone's credential reaching for another
//      zone's file.

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    // `viewer` is the floor: this is reading an attachment in a thread the
    // caller can already open.
    const ctx = await requireRole('viewer')

    const { mediaId } = await params
    if (!mediaId) {
      return NextResponse.json({ error: 'Media ID is required' }, { status: 400 })
    }

    // Ownership check, and the authorization for this whole route.
    //
    // `messages.media_url` holds exactly this path for un-mirrored inbound
    // media, so the row is the proof that the caller's account received
    // this media id. The query runs on the caller's RLS client, and
    // `messages_select` (017:511-518) only exposes rows whose conversation
    // is in the caller's account — which under 044 means their ACTIVE
    // zone. So Postgres, not this handler, is what refuses another zone's
    // media, and the 404 below is just how that refusal is reported.
    //
    // Not `.maybeSingle()`: Meta ids repeat across numbers (migration
    // 009), so two rows can legitimately share one `media_url` and
    // maybeSingle would error instead of answering.
    const { data: rows, error: lookupError } = await ctx.supabase
      .from('messages')
      .select('conversation_id')
      .eq('media_url', `/api/whatsapp/media/${mediaId}`)
      .limit(1)

    if (lookupError) {
      console.error('[whatsapp media] message lookup failed:', lookupError)
      return NextResponse.json({ error: 'Failed to fetch media' }, { status: 500 })
    }

    const conversationId = rows?.[0]?.conversation_id as string | undefined
    if (!conversationId) {
      // Deliberately not 403: a 403 would confirm the media exists
      // somewhere else in the project.
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // The thread's own number, so the token that fetches the bytes is the
    // one that received them. `allowPrimary` stays on ONLY as the fallback
    // for threads that predate migration 040 and carry no number at all —
    // by this point ownership is already established, and a download
    // messages nobody.
    const resolvedConfig = await resolveConfig(ctx.supabase, ctx.accountId, {
      conversationId,
      allowPrimary: true,
      columns: '*',
    })
    if (!resolvedConfig.ok) {
      return NextResponse.json(
        { error: resolveFailureMessage(resolvedConfig.reason) },
        { status: 400 }
      )
    }

    const accessToken = decrypt(resolvedConfig.config.access_token)

    const mediaInfo = await getMediaUrl({ mediaId, accessToken })
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        // `private`, not `public`. This is one account's attachment behind
        // a per-caller authorization check; a shared cache holding it
        // under the URL alone could serve it to someone the check would
        // have refused.
        'Cache-Control': 'private, max-age=86400',
      },
    })
  } catch (error) {
    // Maps UnauthorizedError / ForbiddenError from requireRole to 401/403
    // and logs anything else as a 500 — same shape as every other route
    // that uses the auth helper.
    return toErrorResponse(error)
  }
}
