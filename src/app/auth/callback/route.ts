import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// The OAuth / email-link landing point. Supabase redirects the browser
// back here with a one-time `code`, which has to be exchanged for a
// session server-side so the auth cookies are written by the same
// origin that will later read them.
//
// This route did not exist before Google sign-in was added, which means
// `forgot-password/page.tsx:32` — which already sends users to
// `/auth/callback?next=/reset-password` — has been landing on a 404
// since it was written. Adding it here fixes the password-reset flow as
// a side effect. (`/reset-password` itself is still missing, so that
// flow lands on a 404 one step later; out of scope here, but it needs a
// page before reset links work end to end.)
//
// Not gated by middleware: `src/middleware.ts` protects a fixed list of
// app paths and `/api/whatsapp/*`, neither of which matches `/auth/*`.
// That is correct — the caller is by definition not yet authenticated.

/** Fallback when `next` is absent or refused. */
const DEFAULT_NEXT = '/dashboard'

/**
 * Only ever redirect to a path on this origin.
 *
 * `next` arrives in the query string, so it is attacker-controllable: a
 * crafted link like `/auth/callback?next=https://evil.example` would
 * otherwise hand a freshly authenticated user straight to another site,
 * with the referrer leaking where they came from. Accept a single
 * leading slash and nothing that could re-target the host —
 * `//evil.example` is protocol-relative and `/\evil.example` is treated
 * as a host by some browsers, so both are refused.
 */
export function safeNext(raw: string | null): string {
  if (!raw) return DEFAULT_NEXT
  if (!raw.startsWith('/')) return DEFAULT_NEXT
  if (raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_NEXT
  return raw
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const next = safeNext(url.searchParams.get('next'))

  // Supabase reports a refused or cancelled sign-in on the query string
  // rather than by omitting `code`. Surface it on the login page instead
  // of silently bouncing to a login form that looks like nothing
  // happened.
  const oauthError =
    url.searchParams.get('error_description') ?? url.searchParams.get('error')
  if (oauthError) {
    const back = new URL('/login', url.origin)
    back.searchParams.set('error', oauthError)
    return NextResponse.redirect(back)
  }

  if (!code) {
    const back = new URL('/login', url.origin)
    back.searchParams.set('error', 'missing_code')
    return NextResponse.redirect(back)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    const back = new URL('/login', url.origin)
    back.searchParams.set('error', error.message)
    return NextResponse.redirect(back)
  }

  // `url.origin` rather than a configured site URL: behind a proxy the
  // request URL is what the browser actually reached, so the redirect
  // stays on the host that just received the auth cookies.
  return NextResponse.redirect(new URL(next, url.origin))
}
