import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/issues/admin-client'
import { canTransition, isResolvedStatus } from '@/lib/issues/status'
import { isIssueSeverity } from '@/lib/issues/labels'
import type { IssueStatus } from '@/types'

/**
 * GET   /api/issues/[id] — read one issue with its trail.
 * PATCH /api/issues/[id] — move it, reassign it, or record a resolution.
 *
 * The read goes through the cookie client, so RLS scopes it: an issue in
 * another account comes back as no row, which this returns as 404 rather
 * than 403. Telling a caller that an id exists but is not theirs is
 * itself a disclosure.
 *
 * Responses carry error CODES, not sentences — the UI owns the wording.
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

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  const guard = await requireUser()
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status })
  }
  const { supabase } = guard

  const { data: issue, error } = await supabase
    .from('issues')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!issue) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const { data: events } = await supabase
    .from('issue_events')
    .select('*')
    .eq('issue_id', id)
    .order('created_at', { ascending: true })

  return NextResponse.json({ issue, events: events ?? [] })
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

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

  // Read through the cookie client FIRST. This is what scopes the write
  // to the caller's account: the admin client below would happily update
  // any row in the table, so the 404 here is the tenant check.
  const { data: current, error: readErr } = await supabase
    .from('issues')
    .select('id, account_id, status')
    .eq('id', id)
    .maybeSingle()
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 })
  }
  if (!current) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as
    | {
        status?: string
        assigned_to?: string | null
        severity?: string
        resolution?: string | null
        due_at?: string | null
        /** Free-text note attached to the event this change writes. */
        note?: string | null
      }
    | null
  if (!body) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const from = current.status as IssueStatus
  const patch: Record<string, unknown> = {}
  let to: IssueStatus | null = null

  if (body.status !== undefined) {
    const next = body.status as IssueStatus
    // An unchanged status is not an error and not a transition — accept
    // the request and write no event. See canTransition.
    if (next !== from) {
      if (!canTransition(from, next)) {
        // 422, not 500: the request was understood and refused. A 500
        // would send whoever wrote the UI looking for a server fault.
        return NextResponse.json(
          { error: 'invalid_transition', from, to: next },
          { status: 422 },
        )
      }
      to = next
      patch.status = next
      // resolved_at tracks the CURRENT state, not the first time it was
      // ever resolved. Clearing it on the way out is the half everyone
      // forgets, and a stale value silently corrupts every
      // time-to-resolution figure computed from the column.
      patch.resolved_at = isResolvedStatus(next) ? new Date().toISOString() : null
    }
  }

  if (body.assigned_to !== undefined) patch.assigned_to = body.assigned_to
  if (body.due_at !== undefined) patch.due_at = body.due_at
  if (body.resolution !== undefined) patch.resolution = body.resolution
  if (body.severity !== undefined) {
    if (!isIssueSeverity(body.severity)) {
      return NextResponse.json({ error: 'invalid_severity' }, { status: 422 })
    }
    patch.severity = body.severity
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing_to_update' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  const { data: issue, error: updateErr } = await admin
    .from('issues')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()
  if (updateErr || !issue) {
    return NextResponse.json(
      { error: updateErr?.message ?? 'update_failed' },
      { status: 500 },
    )
  }

  // The trail is written for movement only. A reassignment or a due-date
  // edit is not a status change and does not belong in a table whose
  // columns are from_status/to_status.
  if (to) {
    const { error: eventErr } = await admin.from('issue_events').insert({
      issue_id: id,
      account_id: current.account_id,
      actor_user_id: userId,
      from_status: from,
      to_status: to,
      note: body.note ?? null,
    })
    if (eventErr) {
      // The issue moved; the record of it moving did not. Loud, because
      // a trail with a hole in it is worse than one that is obviously
      // empty — it looks complete.
      console.error('[issues] status changed without an event row:', id, eventErr)
    }
  }

  return NextResponse.json({ issue })
}
