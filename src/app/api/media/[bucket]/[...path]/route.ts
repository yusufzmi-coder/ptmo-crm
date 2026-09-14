import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  isProxyableBucket,
  pathBelongsToAccount,
} from '@/lib/media/proxy-url'

// Serves objects out of the private storage buckets (migration 047).
//
// Before 047 the three buckets were public and the app stored absolute
// `getPublicUrl()` links, so rendering an attachment needed no auth at
// all — which is exactly why anyone on the internet could read every
// zone's files. Now the stored value is a pointer at this route, and the
// bytes are reached through a signed URL minted per request.
//
// Authorization happens twice, deliberately:
//
//   1. Here, by comparing the path's account folder to the caller's own
//      account. This is the check that produces a clean 403 and keeps
//      the rule legible next to the URL shape it enforces.
//   2. Again in Postgres: `createSignedUrl` is issued with the caller's
//      RLS client, so 047's `Members can read ...` policy has to pass as
//      well. Under the zone model (044) `profiles.account_id` is the
//      caller's ACTIVE zone, so an HQ user who may enter four zones
//      still only signs files from the one they are in.
//
// A service-role client would have been simpler and wrong: it bypasses
// RLS, leaving check 1 as the only thing between a URL and another
// zone's attachments.

/**
 * Signed-URL lifetime.
 *
 * Short because the URL is handed straight to the browser as a redirect
 * and used immediately; it only has to outlive the redirect itself. It is
 * NOT the window Meta needs — outbound media is signed separately at send
 * time with a longer TTL, because Meta fetches the link on its own
 * schedule.
 */
const SIGNED_URL_TTL_SECONDS = 60

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bucket: string; path: string[] }> }
) {
  try {
    // `viewer` is the floor: reading an attachment in a thread you can
    // already see is a read. The account check below is what scopes it.
    const ctx = await requireRole('viewer')

    const { bucket, path } = await params

    if (!isProxyableBucket(bucket)) {
      return NextResponse.json({ error: 'Unknown media bucket' }, { status: 404 })
    }

    // Next has already percent-decoded each dynamic segment.
    const objectPath = path.join('/')

    // `avatars` is pathed `<user_id>/<file>`, not `account-<id>/...`, so
    // the account-folder rule does not apply to it. Its RLS policy (047)
    // is the authority there: your own avatar, or a teammate's in your
    // active zone. Everything else must sit under the caller's account
    // folder, and the traversal check inside `pathBelongsToAccount` is
    // what stops `account-<mine>/../account-<theirs>/x`.
    if (bucket !== 'avatars' && !pathBelongsToAccount(objectPath, ctx.accountId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { data, error } = await ctx.supabase.storage
      .from(bucket)
      .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS)

    if (error || !data?.signedUrl) {
      // RLS refusal and genuinely-missing object are indistinguishable
      // here, and that is the right answer to give the caller: a 403
      // would confirm the file exists in some other zone.
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // 307 rather than 302 so the method is preserved, and no-store so a
    // shared cache never holds a URL that outlives its signature.
    return NextResponse.redirect(data.signedUrl, {
      status: 307,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
