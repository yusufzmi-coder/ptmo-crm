import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Which WhatsApp number do we act as?
 *
 * Until migration 040 an account held exactly one number, so every
 * call site could get away with
 *   .from('whatsapp_config').eq('account_id', …).single()
 * An account can now hold many — one per branch — and that query
 * throws the moment a second row exists. This module is the one place
 * that answers "which config?", so the rule is written down once
 * instead of drifting across a dozen files.
 *
 * The rule, in priority order:
 *
 *   1. The conversation's own number. A parent messaged a specific
 *      branch; the reply goes back out on that branch's number. This
 *      is not a preference — replying from a different number shows
 *      the parent a branch they never contacted, and breaks the thread
 *      on their phone.
 *   2. An explicitly chosen number (a broadcast where the sender picked
 *      a branch, an admin acting on one number's settings).
 *   3. The account's primary. Only for work with no thread and no
 *      choice — a template sync, a health probe.
 *
 * Nothing here falls back to "the first row we happened to get". A
 * silent wrong-number send is worse than a visible error, so when the
 * rule cannot pick, {@link resolveConfig} returns a reason instead.
 */

/** Columns every caller needs. Callers wanting more pass their own. */
export const CONFIG_COLUMNS =
  'id, account_id, phone_number_id, waba_id, access_token, status, label, is_primary, centre_id';

export interface WhatsAppConfigRow {
  id: string;
  account_id: string;
  phone_number_id: string;
  waba_id: string | null;
  access_token: string;
  status: 'connected' | 'disconnected';
  label: string | null;
  is_primary: boolean;
  /**
   * The centre this number serves (migration 049). NULL until an admin
   * sets it in Settings → WhatsApp. Nothing routes on it — the branch a
   * thread belongs to is still `conversations.whatsapp_config_id` — but
   * the pilot needs to be readable off the number itself, and per-centre
   * reporting has nowhere else to start.
   *
   * Optional, not required: callers that pass their own narrower
   * `columns` (the quick-reply picker asks for three) never see it,
   * and a required field would make those rows fail to type.
   */
  centre_id?: string | null;
  [key: string]: unknown;
}

export type ResolveFailure =
  /** The account has no numbers connected at all. */
  | 'not_configured'
  /** A conversation predates 040, or its number was disconnected. */
  | 'conversation_has_no_number'
  /** Asked for a specific config that isn't this account's. */
  | 'not_found'
  /** Several numbers, none marked primary — an admin must choose. */
  | 'ambiguous';

export type ResolveResult =
  | { ok: true; config: WhatsAppConfigRow }
  | { ok: false; reason: ResolveFailure };

export interface ResolveOptions {
  /** Reply on the number this thread arrived on. Strongest signal. */
  conversationId?: string;
  /** An explicitly chosen whatsapp_config.id. */
  configId?: string;
  /**
   * Allow falling back to the account primary when neither of the
   * above is given. Leave false for anything that sends to a parent —
   * only thread-less work (template sync, probes) should default.
   */
  allowPrimary?: boolean;
  /** Columns to select. Defaults to {@link CONFIG_COLUMNS}. */
  columns?: string;
}

export async function resolveConfig(
  db: SupabaseClient,
  accountId: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const columns = opts.columns ?? CONFIG_COLUMNS;

  // 1. Explicit choice wins over inference, but must belong to us.
  if (opts.configId) {
    const { data, error } = await db
      .from('whatsapp_config')
      .select(columns)
      .eq('id', opts.configId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw error;
    return data
      ? { ok: true, config: data as unknown as WhatsAppConfigRow }
      : { ok: false, reason: 'not_found' };
  }

  // 2. The conversation's own number.
  if (opts.conversationId) {
    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('whatsapp_config_id')
      .eq('id', opts.conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (convErr) throw convErr;

    const configId = (conv as { whatsapp_config_id?: string | null } | null)
      ?.whatsapp_config_id;

    if (configId) {
      const { data, error } = await db
        .from('whatsapp_config')
        .select(columns)
        .eq('id', configId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (error) throw error;
      if (data) return { ok: true, config: data as unknown as WhatsAppConfigRow };
    }

    // The thread has no number of its own. Only safe to guess when the
    // account has exactly one — which is every account until a second
    // branch is connected, so pre-040 threads keep working untouched.
    const single = await onlyConfig(db, accountId, columns);
    if (single.ok) return single;
    return {
      ok: false,
      reason:
        single.reason === 'not_configured'
          ? 'not_configured'
          : 'conversation_has_no_number',
    };
  }

  // 3. No thread, no choice.
  const single = await onlyConfig(db, accountId, columns);
  if (single.ok) return single;
  if (single.reason === 'not_configured') return single;

  if (opts.allowPrimary) {
    const { data, error } = await db
      .from('whatsapp_config')
      .select(columns)
      .eq('account_id', accountId)
      .eq('is_primary', true)
      .maybeSingle();
    if (error) throw error;
    if (data) return { ok: true, config: data as unknown as WhatsAppConfigRow };
  }
  return { ok: false, reason: 'ambiguous' };
}

/** The account's config when it has exactly one; never a guess. */
async function onlyConfig(
  db: SupabaseClient,
  accountId: string,
  columns: string,
): Promise<ResolveResult> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select(columns)
    .eq('account_id', accountId)
    .limit(2);
  if (error) throw error;
  const rows = (data ?? []) as unknown as WhatsAppConfigRow[];
  if (rows.length === 0) return { ok: false, reason: 'not_configured' };
  if (rows.length === 1) return { ok: true, config: rows[0] };
  return { ok: false, reason: 'ambiguous' };
}

/** Message for a failure, for API responses and the UI. */
export function resolveFailureMessage(reason: ResolveFailure): string {
  switch (reason) {
    case 'not_configured':
      return 'WhatsApp not configured. Connect a number in Settings first.';
    case 'conversation_has_no_number':
      return 'This conversation is not linked to a WhatsApp number, so we cannot tell which branch should reply. Open it in the inbox and set the number.';
    case 'not_found':
      return 'That WhatsApp number does not belong to this account.';
    case 'ambiguous':
      return 'This account has several WhatsApp numbers and none is set as the default. Choose a number, or mark one as primary in Settings.';
  }
}

/** What staff see: the branch name, falling back to the raw number. */
export function configDisplayName(
  config: Pick<WhatsAppConfigRow, 'label' | 'phone_number_id'>,
): string {
  return config.label?.trim() || config.phone_number_id;
}
