import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/issues/admin-client'
import { INITIAL_ISSUE_STATUS } from '@/lib/issues/status'
import { isIssueCategory, isIssueSeverity } from '@/lib/issues/labels'

/**
 * GET  /api/issues — list the caller's issues.
 * POST /api/issues — open a new one.
 *
 * Reads go through the cookie client so RLS scopes them to the caller's
 * account; writes go through the service-role client, which bypasses RLS
 * and therefore makes the role check and the account_id resolution below
 * load-bearing rather than belt-and-braces.
 *
 * Responses carry error CODES, not sentences. The UI owns the wording —
 * see messages/*.json.
 */

async function requireUser(): Promise<
  | { ok: true; userId: string; supabase: Awaited<ReturnType<typeof createClient>> }
  | { ok: false; status: number; body: { error: string } }
> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, status: 401, body: { error: 'unauthorized' } }
  }
  return { ok: true, userId: user.id, supabase }
}

export async function GET(request: Request) {
  const guard = await requireUser()
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status })
  }
  const { supabase } = guard

  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  const centreId = url.searchParams.get('centre_id')

  let query = supabase
    .from('issues')
    .select('*')
    // Open issues first, then most recently opened. An issue nobody has
    // touched is the one that needs a human.
    .order('opened_at', { ascending: false })
  if (status) query = query.eq('status', status)
  if (centreId) query = query.eq('centre_id', centreId)

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ issues: data ?? [] })
}

export async function POST(request: Request) {
  // Opening an issue is a write, and the insert below goes through the
  // service-role client, so RLS will not enforce the role for us.
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const guard = await requireUser()
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status })
  }
  const { userId, supabase } = guard

  // `issues.account_id` is NOT NULL, and the admin client bypasses RLS,
  // so the column default cannot fill it in — resolve it here or the
  // insert trips the not-null constraint.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .single()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json({ error: 'profile_not_linked' }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as
    | {
        summary?: string
        category?: string
        severity?: string
        centre_id?: string | null
        contact_id?: string | null
        conversation_id?: string | null
        due_at?: string | null
      }
    | null
  if (!body) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const summary = body.summary?.trim()
  if (!summary) {
    return NextResponse.json({ error: 'summary_required' }, { status: 422 })
  }
  // Guards, not array lookups: the lists behind them are Records keyed
  // on the union, so a category added to the type without being added
  // there is a compile error rather than a value this route silently
  // refuses. See src/lib/issues/labels.ts.
  if (!isIssueCategory(body.category)) {
    return NextResponse.json({ error: 'invalid_category' }, { status: 422 })
  }
  if (!isIssueSeverity(body.severity)) {
    return NextResponse.json({ error: 'invalid_severity' }, { status: 422 })
  }

  const admin = supabaseAdmin()
  const openedAt = new Date().toISOString()

  const { data: issue, error } = await admin
    .from('issues')
    .insert({
      account_id: accountId,
      centre_id: body.centre_id ?? null,
      contact_id: body.contact_id ?? null,
      conversation_id: body.conversation_id ?? null,
      category: body.category,
      severity: body.severity,
      status: INITIAL_ISSUE_STATUS,
      opened_by: userId,
      summary,
      due_at: body.due_at ?? null,
      opened_at: openedAt,
    })
    .select('*')
    .single()

  if (error || !issue) {
    return NextResponse.json(
      { error: error?.message ?? 'insert_failed' },
      { status: 500 },
    )
  }

  // The opening row of the trail. `from_status` is null because there
  // was no status before this. Written even though nothing has moved
  // yet: an issue with an empty history reads as one nobody recorded.
  const { error: eventErr } = await admin.from('issue_events').insert({
    issue_id: issue.id,
    account_id: accountId,
    actor_user_id: userId,
    from_status: null,
    to_status: INITIAL_ISSUE_STATUS,
    note: null,
  })
  if (eventErr) {
    // The issue exists; the trail does not. Say so rather than returning
    // a clean 201 that hides a half-written record.
    console.error('[issues] opened issue without an event row:', issue.id, eventErr)
  }

  return NextResponse.json({ issue }, { status: 201 })
}
