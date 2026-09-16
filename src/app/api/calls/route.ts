import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/calls/admin-client'
import { isCallDirection, isCallOutcome } from '@/lib/calls/labels'
import { isMissingTable } from '@/lib/db/schema-drift'

/**
 * GET  /api/calls — list logged calls.
 * POST /api/calls — log one.
 *
 * Reads go through the cookie client so RLS scopes them to the caller's
 * account; writes go through the service-role client, which bypasses
 * RLS and therefore makes the role check and the account_id resolution
 * below load-bearing rather than belt-and-braces. Same division as
 * /api/issues, which these rows sit alongside.
 *
 * Responses carry error CODES, not sentences. The UI owns the wording —
 * see `Calls.errors` in messages/*.json, and the map in
 * src/lib/calls/labels.ts.
 *
 * NOT the WhatsApp Calling API. Nothing here talks to Meta; a call is
 * something a human did with a phone and then typed up.
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
  const contactId = url.searchParams.get('contact_id')
  const conversationId = url.searchParams.get('conversation_id')
  const issueId = url.searchParams.get('issue_id')
  const centreId = url.searchParams.get('centre_id')
  const outcome = url.searchParams.get('outcome')
  const followUp = url.searchParams.get('follow_up')

  let query = supabase
    .from('call_logs')
    // Ordered by when the call HAPPENED, not when it was typed up.
    // Staff log at the end of a shift, so created_at would sort the
    // day's calls into the order somebody got round to them.
    .select('*')
    .order('called_at', { ascending: false })

  if (contactId) query = query.eq('contact_id', contactId)
  if (conversationId) query = query.eq('conversation_id', conversationId)
  if (issueId) query = query.eq('issue_id', issueId)
  if (centreId) query = query.eq('centre_id', centreId)
  if (outcome) query = query.eq('outcome', outcome)
  // `?follow_up=due` is the one view with an index behind it
  // (idx_call_logs_follow_up, partial on NOT NULL): the calls somebody
  // promised to make back.
  if (followUp === 'due') query = query.not('follow_up_at', 'is', null)

  const { data, error } = await query

  // `call_logs` arrives with 051, and the apply is a human step in the
  // SQL editor while the deploy is a merge. If the code lands first,
  // every visit to /calls 500s — the same drift that broke quick
  // replies and broadcast creation, from the other direction: a new
  // migration rather than a parked one.
  //
  // An empty list plus `call_logging: 'unavailable'` lets the page say
  // what is wrong. A raw 500 tells whoever opens it that the feature is
  // broken, which sends them looking in the wrong place entirely.
  if (error && isMissingTable(error, 'call_logs')) {
    return NextResponse.json({ calls: [], call_logging: 'unavailable' })
  }
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ calls: data ?? [], call_logging: 'ok' })
}

export async function POST(request: Request) {
  // Logging a call is a write, and the insert below goes through the
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

  // `call_logs.account_id` is NOT NULL and the admin client bypasses
  // RLS, so the column default cannot fill it in — resolve it here or
  // the insert trips the not-null constraint.
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
        direction?: string
        outcome?: string
        called_at?: string | null
        duration_seconds?: number | null
        follow_up_at?: string | null
        contact_id?: string | null
        conversation_id?: string | null
        centre_id?: string | null
        whatsapp_config_id?: string | null
        issue_id?: string | null
      }
    | null
  if (!body) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const summary = body.summary?.trim()
  if (!summary) {
    // The only field carrying the actual handover. A logged call with
    // no summary tells the next shift exactly as much as no log at all,
    // which is why the column is NOT NULL and this is a 422.
    return NextResponse.json({ error: 'summary_required' }, { status: 422 })
  }
  // Guards, not array lookups — see src/lib/calls/labels.ts for why the
  // lists behind them are Records keyed on the union.
  if (!isCallDirection(body.direction)) {
    return NextResponse.json({ error: 'invalid_direction' }, { status: 422 })
  }
  if (!isCallOutcome(body.outcome)) {
    return NextResponse.json({ error: 'invalid_outcome' }, { status: 422 })
  }

  // Duration is optional, but a duration that is present and nonsense
  // is rejected rather than stored as NULL: NULL means "nobody recorded
  // it", and quietly turning a typo into that erases the difference.
  // The CHECK on the column says the same thing; this says it in time
  // to name the field.
  const duration = body.duration_seconds
  if (duration != null) {
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
      return NextResponse.json({ error: 'invalid_duration' }, { status: 422 })
    }
  }

  // `called_at` defaults to now — a call logged the moment it ends —
  // but staff typing up a shift set it, so an unparseable value is a
  // rejection rather than a silent fall back to now. A call filed under
  // the wrong day is worse than one that refused to save.
  let calledAt = new Date().toISOString()
  if (body.called_at) {
    const parsed = new Date(body.called_at)
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: 'invalid_called_at' }, { status: 422 })
    }
    calledAt = parsed.toISOString()
  }

  let followUpAt: string | null = null
  if (body.follow_up_at) {
    const parsed = new Date(body.follow_up_at)
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: 'invalid_called_at' }, { status: 422 })
    }
    followUpAt = parsed.toISOString()
  }

  const { data: call, error } = await supabaseAdmin()
    .from('call_logs')
    .insert({
      account_id: accountId,
      contact_id: body.contact_id ?? null,
      conversation_id: body.conversation_id ?? null,
      centre_id: body.centre_id ?? null,
      whatsapp_config_id: body.whatsapp_config_id ?? null,
      issue_id: body.issue_id ?? null,
      direction: body.direction,
      outcome: body.outcome,
      called_at: calledAt,
      duration_seconds: duration ?? null,
      summary,
      follow_up_at: followUpAt,
      logged_by: userId,
    })
    .select('*')
    .single()

  if (error && isMissingTable(error, 'call_logs')) {
    // 503, not a 201 with nothing behind it. A staff member who types
    // up a call and is told it saved, when no table took it, loses the
    // handover AND the knowledge that they lost it.
    return NextResponse.json({ error: 'table_missing' }, { status: 503 })
  }

  if (error || !call) {
    return NextResponse.json(
      { error: error?.message ?? 'insert_failed' },
      { status: 500 },
    )
  }

  return NextResponse.json({ call }, { status: 201 })
}
