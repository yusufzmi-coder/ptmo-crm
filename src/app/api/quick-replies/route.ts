import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { configDisplayName, resolveConfig } from '@/lib/whatsapp/resolve-config'
import {
  decorateQuickReplyForBranch,
  isMissingBranchColumn,
} from '@/lib/inbox/quick-reply-branch'

// Quick replies — reusable snippets (plain text or a saved interactive
// message) shared across the account. GET lists; POST creates. Mirrors
// the automations route: RLS-scoped read via the user client, service-
// role write after an explicit role check.

/**
 * List quick replies.
 *
 * Without `?conversationId=` this is the raw account list — what the
 * settings screen manages. With one, it is the list for THAT THREAD,
 * and three branch rules apply (migration 043):
 *
 *   1. snippets pinned to another branch are hidden;
 *   2. `{{cawangan}}` is expanded to this thread's branch, so one
 *      snippet can serve all sixteen centres;
 *   3. snippets that hardcode a different centre's name are flagged.
 *
 * All three run here rather than in the picker so the branch comes from
 * `conversations.whatsapp_config_id` — the same source the send path
 * uses — rather than from whatever the client believes it is showing.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const conversationId =
      new URL(request.url).searchParams.get('conversationId') ?? null

    // Which branch is this thread? `resolveConfig` is the one place that
    // answers that, and it refuses to guess — an unresolvable thread
    // leaves `branchName` null, and every tokenised snippet is then
    // returned unusable instead of expanded into something wrong.
    let branchConfigId: string | null = null
    let branchName: string | null = null
    if (conversationId) {
      const resolved = await resolveConfig(supabase, accountId, {
        conversationId,
        columns: 'id, label, phone_number_id',
      })
      if (resolved.ok) {
        branchConfigId = resolved.config.id
        branchName = configDisplayName(resolved.config)
      }
    }

    // RLS (quick_replies_select) scopes to the caller's account.
    const baseQuery = () =>
      supabase
        .from('quick_replies')
        .select('*')
        .order('created_at', { ascending: false })

    let query = baseQuery()

    // Hide other branches' pinned snippets. Only once we know which
    // branch we are in: on an unresolved thread, showing the
    // account-wide ones and blocking the rest beats showing nothing.
    if (conversationId) {
      query = branchConfigId
        ? query.or(
            `whatsapp_config_id.is.null,whatsapp_config_id.eq.${branchConfigId}`,
          )
        : query.is('whatsapp_config_id', null)
    }

    let { data, error } = await query

    // 043 has never been applied to any database, so on production that
    // filter names a column that does not exist and the whole list 500s
    // — for every thread, which is where the picker always opens from.
    // Without the column there are no pinned snippets to hide, so the
    // unfiltered list IS the correct answer rather than a degraded one.
    //
    // Token expansion is untouched: `{{cawangan}}` resolves through
    // `conversations.whatsapp_config_id`, which came with 040 and is
    // live. Only pinning is missing.
    let branchPinning: 'ok' | 'unavailable' = 'ok'
    if (error && conversationId && isMissingBranchColumn(error)) {
      branchPinning = 'unavailable'
      ;({ data, error } = await baseQuery())
    }

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const rows = data ?? []
    if (!conversationId) {
      return NextResponse.json({ quick_replies: rows })
    }

    // Every branch name on the account — the vocabulary the mention scan
    // searches for. Left empty on a single-number account, where there
    // is no other centre to name by mistake.
    const { data: configRows } = await supabase
      .from('whatsapp_config')
      .select('id, label, phone_number_id')
      .eq('account_id', accountId)
    const allBranchNames = (configRows ?? []).map((c) =>
      configDisplayName(c as { label: string | null; phone_number_id: string }),
    )
    const multiBranch = allBranchNames.length > 1

    return NextResponse.json({
      quick_replies: rows.map((row) =>
        decorateQuickReplyForBranch(
          row,
          branchName,
          multiBranch ? allBranchNames : [],
        ),
      ),
      branch: branchName,
      branch_resolved: branchConfigId !== null,
      branch_pinning: branchPinning,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const kind = body.kind === 'interactive' ? 'interactive' : 'text'
  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 })
  }

  let content_text: string | null = null
  let interactive_payload: unknown = null

  if (kind === 'interactive') {
    const result = validateInteractivePayload(body.interactive_payload)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }
    interactive_payload = body.interactive_payload
  } else {
    const text = typeof body.content_text === 'string' ? body.content_text : ''
    if (!text.trim()) {
      return NextResponse.json(
        { error: 'content_text is required for text quick replies' },
        { status: 400 },
      )
    }
    content_text = text
  }

  // Optional branch pin (migration 043). Checked against the caller's
  // own account first: the insert below goes through the service role,
  // which bypasses RLS, so the tenancy check the user client would have
  // done for free has to be done by hand here.
  let whatsapp_config_id: string | null = null
  if (body.whatsapp_config_id != null) {
    if (typeof body.whatsapp_config_id !== 'string') {
      return NextResponse.json(
        { error: 'whatsapp_config_id must be a string' },
        { status: 400 },
      )
    }
    const resolved = await resolveConfig(ctx.supabase, ctx.accountId, {
      configId: body.whatsapp_config_id,
      columns: 'id, label, phone_number_id',
    })
    if (!resolved.ok) {
      return NextResponse.json(
        { error: 'That WhatsApp number does not belong to this account.' },
        { status: 400 },
      )
    }
    whatsapp_config_id = resolved.config.id
  }

  // The column is carried only when something is pinned to a branch.
  // Sending `whatsapp_config_id: null` reads as harmless and is not: a
  // database without 043 rejects the key itself, null or otherwise, so
  // including it unconditionally made EVERY quick reply creation fail
  // rather than only the branch-pinned ones.
  const { data, error } = await supabaseAdmin()
    .from('quick_replies')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      title,
      kind,
      content_text,
      interactive_payload,
      ...(whatsapp_config_id === null ? {} : { whatsapp_config_id }),
    })
    .select()
    .single()

  if (error) {
    // Pinning was asked for and this database cannot store it. Say that,
    // rather than dropping the pin and returning 201 — a snippet silently
    // account-wide is the failure that sends a parent to the wrong centre.
    if (isMissingBranchColumn(error)) {
      return NextResponse.json(
        {
          error:
            'Branch pinning is not available on this database (migration 043 has not been applied). Create the quick reply without a branch, or apply 043.',
        },
        { status: 503 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ quick_reply: data }, { status: 201 })
}
