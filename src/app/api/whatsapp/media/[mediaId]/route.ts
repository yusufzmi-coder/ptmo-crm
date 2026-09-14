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

/**
 * Meta media ids are numeric strings. `mediaId` is interpolated into the
 * Graph URL by `getMediaUrl` and used as a PostgREST filter value below,
 * so pin its shape here rather than letting either of those be the first
 * thing to see whatever the URL carried. The ownership lookup would
 * already 404 an id like `../../me/accounts`, which makes this the second
 * lock on the same door — cheap, and it keeps that ordering from becoming
 * load-bearing.
 */
const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    // `viewer` is the floor: this is reading an attachment in a thread the
    // caller can already open.
    const ctx = await requireRole('viewer')

    const { mediaId } = await params
    if (!mediaId || !MEDIA_ID_PATTERN.test(mediaId)) {
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

    // Say the zone rule once in the application too.
    //
    // The RLS above is what actually refuses another zone, and this repeats
    // it — on purpose. `docs/zones.md` is explicit that the whole model
    // rests on one condition inside `is_account_member`, that ~119 policies
    // lean on it, and that widening it turns no test red. If that ever
    // happens, this route answers 404 instead of handing over the bytes,
    // and the test below fails loudly rather than the breach being silent.
    const { data: conversation, error: conversationError } = await ctx.supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (conversationError) {
      console.error('[whatsapp media] conversation lookup failed:', conversationError)
      return NextResponse.json({ error: 'Failed to fetch media' }, { status: 500 })
    }
    if (!conversation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // The thread's own number, so the token that fetches the bytes is the
    // one that received them.
    //
    // No `allowPrimary`. It would only ever fire for a thread carrying no
    // number on an account holding several, and in that case there is no
    // evidence for which centre the media belongs to — `resolveConfig`
    // already falls back to the account's only number when there is only
    // one, so pre-040 single-number accounts are untouched either way. The
    // primary is a guess, and this route exists to stop guessing: a named
    // error tells staff to set the thread's number, where a silent guess
    // teaches everyone that the primary's token is the one that fetches
    // everything.
    const resolvedConfig = await resolveConfig(ctx.supabase, ctx.accountId, {
      conversationId,
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
        // `private` already keeps this out of shared caches. `no-store` on
        // top of it is about the disk copy: a browser cache holding one
        // zone's attachments for a day outlives a zone switch, and this is
        // a shared-device deployment. Nothing is lost by it — the inbox
        // memoises the blob in `src/lib/media/blob-cache.ts`, and
        // `next.config.ts` forces `no-store` on `/api/*` anyway, so the
        // 24h here was never reaching a real cache to begin with.
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    // Maps UnauthorizedError / ForbiddenError from requireRole to 401/403
    // and logs anything else as a 500 — same shape as every other route
    // that uses the auth helper.
    return toErrorResponse(error)
  }
}
