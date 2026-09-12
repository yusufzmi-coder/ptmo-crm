import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * The only `/api/whatsapp/**` paths callable without a session.
 *
 * Meta drives this endpoint itself: GET answers the hub subscription
 * challenge against a stored `verify_token`, and POST carries the inbound
 * payload signed with `x-hub-signature-256`. The route authenticates both
 * on its own, so the session gate below must let them through.
 *
 * This used to be `!pathname.includes('/webhook')`, which matched the
 * substring anywhere in the path — so any route that merely happened to
 * have a `webhook` segment (`/api/whatsapp/templates/webhook`, say) fell
 * out of the gate on spelling alone. An allowlist of full paths cannot
 * widen by accident: a new public endpoint has to be named here.
 */
const PUBLIC_WHATSAPP_PATHS = new Set(['/api/whatsapp/webhook'])

/** Exact-path membership, tolerating one trailing slash. */
function isPublicWhatsAppPath(pathname: string): boolean {
  // Depending on `trailingSlash` and how Meta stored the callback URL, the
  // same endpoint can arrive with or without the trailing slash. Normalise
  // it rather than listing both spellings.
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname
  return PUBLIC_WHATSAPP_PATHS.has(normalized)
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated.
  // This must list every top-level segment under the (dashboard) route
  // group. It has drifted twice now — /ops was missing until it was
  // noticed, and /flows, /agents and /notifications shipped without ever
  // being added, so an unauthenticated visit rendered a broken shell
  // instead of the login page. Nothing links the group to this array, so
  // when you add a page under (dashboard), add its segment here too.
  const protectedPaths = [
    '/agents',
    '/automations',
    '/broadcasts',
    '/contacts',
    '/dashboard',
    '/flows',
    '/inbox',
    '/notifications',
    '/ops',
    '/pipelines',
    '/settings',
  ]
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth, minus the explicit public allowlist above.
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !isPublicWhatsAppPath(request.nextUrl.pathname)) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
