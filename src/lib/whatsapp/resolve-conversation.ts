// ============================================================
// Resolve (or create) the conversation for a phone number.
//
// The dashboard composer always has a `conversation_id` in hand. The
// public API doesn't — an external automation knows a *phone number*,
// not an internal UUID. This helper bridges that: given an E.164
// phone, it finds-or-creates the contact and its conversation so the
// shared `sendMessageToConversation` core can run unchanged.
//
// It deliberately reuses the exact find-or-create logic the inbound
// webhook uses (the `findExistingContact` dedupe helper, the
// one-conversation-per-(account, contact) convention, the
// account_id-tenancy / user_id-audit split) so a contact created via
// the API is indistinguishable from one created by an inbound message.
//
// Audit user: created rows need a NOT NULL `user_id`. As with the
// webhook (where there's no logged-in human either), we attribute
// them to the WhatsApp config owner — a stable account-level default.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import {
  resolveConfig,
  resolveFailureMessage,
} from '@/lib/whatsapp/resolve-config';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  /** True if this call created the contact (vs matched an existing one). */
  contactCreated: boolean;
  /** The number the thread belongs to — see the note on branches below. */
  configId: string;
}

/**
 * Find or create the contact + conversation for `phone` within
 * `accountId`. Throws `SendMessageError` (shared with the send core,
 * so the route maps one error family) on a bad phone, a missing
 * WhatsApp config, or a DB failure.
 *
 * Which branch does an API-initiated thread belong to?
 * ---------------------------------------------------
 * This path is outbound-first: the parent has never written, so there is
 * no thread whose number we must honour. The caller may name one with
 * `configId`; otherwise we fall back to the account primary, which is
 * the same rule `resolveConfig` applies to every other thread-less job.
 *
 * The resolved number is then STAMPED on the conversation. That matters
 * more than the choice itself: without it the thread is left unbranded,
 * and the send core — which refuses to guess a number for anything that
 * talks to a parent — rejects this send and every later reply in the
 * same thread.
 */
export async function resolveConversationByPhone(
  db: SupabaseClient,
  accountId: string,
  phone: string,
  name?: string | null,
  configId?: string | null
): Promise<ResolvedConversation> {
  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) {
    throw new SendMessageError(
      'bad_request',
      "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  // Resolve the number BEFORE creating anything. Two reasons: the send
  // would fail without one anyway, and a conversation created without a
  // number is permanently unsendable (see the note above), so an
  // unresolvable number must leave no rows behind.
  const resolvedConfig = await resolveConfig(db, accountId, {
    configId: configId ?? undefined,
    allowPrimary: true,
    columns: 'id',
  });
  if (!resolvedConfig.ok) {
    throw new SendMessageError(
      resolvedConfig.reason === 'not_configured'
        ? 'whatsapp_not_configured'
        : 'whatsapp_number_unresolved',
      resolveFailureMessage(resolvedConfig.reason),
      400
    );
  }
  const resolvedConfigId = resolvedConfig.config.id;

  // Audit user for created rows = the single account-wide default used
  // by every public-API write (see resolveAuditUserId), so a contact
  // created here is attributed identically to one created via
  // POST /api/v1/contacts. resolveAuditUserId throws ContactError only
  // if the owner can't be resolved — remap it to the send error family
  // the callers already handle.
  let ownerUserId: string;
  try {
    ownerUserId = await resolveAuditUserId(db, accountId);
  } catch (err) {
    if (err instanceof ContactError) {
      throw new SendMessageError('db_error', err.message, err.status);
    }
    throw err;
  }

  // ---- contact -------------------------------------------------
  let contactId: string;
  let contactCreated = false;

  const existing = await findExistingContact(db, accountId, sanitized);
  if (existing) {
    contactId = existing.id;
    if (name && name !== existing.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }
  } else {
    const { data: created, error: createErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        phone: sanitized,
        name: name || sanitized,
      })
      .select('id')
      .single();

    if (createErr || !created) {
      // Lost a race against a concurrent inbound/API create — the
      // unique index (migration 022) rejected the duplicate. Re-resolve.
      if (isUniqueViolation(createErr)) {
        const raced = await findExistingContact(db, accountId, sanitized);
        if (raced) {
          contactId = raced.id;
        } else {
          throw new SendMessageError(
            'db_error',
            'Failed to create contact',
            500
          );
        }
      } else {
        console.error(
          '[resolve-conversation] contact create error:',
          createErr
        );
        throw new SendMessageError('db_error', 'Failed to create contact', 500);
      }
    } else {
      contactId = created.id;
      contactCreated = true;
    }
  }

  // ---- conversation -------------------------------------------
  // One conversation per (account, contact, number) — same convention as
  // the webhook, since migration 042. Order oldest-first and take one row
  // rather than `.maybeSingle()`, which errors on ≥2 rows: if duplicates
  // predate the unique index, we resolve to the canonical survivor
  // instead of falling through and creating yet another (issue #363).
  const conversationId = await findOrCreateConversationRow(
    db,
    accountId,
    contactId,
    ownerUserId,
    resolvedConfigId
  );

  return {
    conversationId,
    contactId,
    contactCreated,
    configId: resolvedConfigId,
  };
}

/**
 * Find (oldest-first) or create the single conversation for
 * `(accountId, contactId, configId)`. Handles the unique-index race the
 * same way the inbound webhook does: on a 23505 from a concurrent
 * create, re-resolve the winning row rather than failing the send.
 */
async function findOrCreateConversationRow(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  ownerUserId: string,
  configId: string
): Promise<string> {
  const { data: existing, error: findErr } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('whatsapp_config_id', configId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findErr) {
    console.error('[resolve-conversation] conversation lookup error:', findErr);
    throw new SendMessageError('db_error', 'Failed to resolve conversation', 500);
  }

  if (existing && existing.length > 0) {
    return existing[0].id;
  }

  // No thread on this number. Adopt an unbranded one if the contact has
  // it — a thread created before migration 040, or by an older build of
  // this very function, which would otherwise sit unsendable forever
  // while a second thread accumulated the history beside it. Mirrors the
  // inbound webhook; `.is(null)` on the UPDATE keeps two concurrent
  // callers on different numbers from both claiming it.
  const { data: orphan, error: orphanErr } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .is('whatsapp_config_id', null)
    .order('created_at', { ascending: true })
    .limit(1);

  if (orphanErr) {
    console.error('[resolve-conversation] orphan lookup error:', orphanErr);
    throw new SendMessageError('db_error', 'Failed to resolve conversation', 500);
  }

  if (orphan && orphan.length > 0) {
    const { data: adopted } = await db
      .from('conversations')
      .update({ whatsapp_config_id: configId })
      .eq('id', orphan[0].id)
      .is('whatsapp_config_id', null)
      .select('id');
    if (adopted && adopted.length > 0) {
      return adopted[0].id;
    }
    // Lost the claim — fall through and open this number's own thread.
  }

  const { data: newConv, error: convErr } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      whatsapp_config_id: configId,
    })
    .select('id')
    .single();

  if (convErr || !newConv) {
    if (isUniqueViolation(convErr)) {
      const { data: raced } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('whatsapp_config_id', configId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return raced[0].id;
      }
    }
    console.error('[resolve-conversation] conversation create error:', convErr);
    throw new SendMessageError('db_error', 'Failed to create conversation', 500);
  }

  return newConv.id;
}
