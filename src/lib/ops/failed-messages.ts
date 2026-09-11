import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContentType, SenderType } from "@/types";
import { previewText } from "./unanswered";

/**
 * Failed Message Alert.
 *
 * A message with `status = 'failed'` is one Meta told us it could not
 * deliver — the webhook writes that status straight onto the row (see
 * src/app/api/whatsapp/webhook/route.ts, the `statuses` branch). From
 * the staff member's seat it looks sent: they typed it, hit enter, it
 * appeared in the thread. The parent never got it. That gap is the
 * silent killer this alert exists for.
 *
 * Only OUR outbound messages can fail this way (agent or bot). Inbound
 * rows never carry a failed status.
 */

export interface FailedContact {
  id: string;
  name: string | null;
  phone: string;
}

export interface FailedMessageRow {
  id: string;
  conversation_id: string;
  sender_type: SenderType;
  content_type: ContentType;
  content_text: string | null;
  created_at: string;
  conversation: { id: string; contact: FailedContact | null } | null;
}

export interface FailedMessage {
  messageId: string;
  conversationId: string;
  contactName: string | null;
  contactPhone: string | null;
  preview: string;
  senderType: SenderType;
  failedAt: string;
}

/** How far back the alert looks. Older failures belong in a report. */
export const FAILED_LOOKBACK_DAYS = 7;

/** Pure: shape rows for the alert, newest first. */
export function deriveFailedMessages(rows: FailedMessageRow[]): FailedMessage[] {
  return rows
    .filter((r) => r.sender_type !== "customer")
    .map((r) => {
      const contact = r.conversation?.contact ?? null;
      return {
        messageId: r.id,
        conversationId: r.conversation_id,
        contactName: contact?.name?.trim() || null,
        contactPhone: contact?.phone ?? null,
        preview: previewText(r),
        senderType: r.sender_type,
        failedAt: r.created_at,
      };
    })
    .sort((a, b) => b.failedAt.localeCompare(a.failedAt));
}

/**
 * Client-side, RLS-scoped — same pattern as the board. Embeds the
 * conversation → contact so the alert can name who did not get the
 * message.
 */
export async function loadFailedMessages(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<FailedMessage[]> {
  const since = new Date(now.getTime() - FAILED_LOOKBACK_DAYS * 86_400_000);
  const { data, error } = await db
    .from("messages")
    .select(
      "id, conversation_id, sender_type, content_type, content_text, created_at, conversation:conversations(id, contact:contacts(id, name, phone))",
    )
    .eq("status", "failed")
    .in("sender_type", ["agent", "bot"])
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;

  // PostgREST types a to-one embed as an array in some client versions;
  // unwrap defensively so the shape is stable for the pure layer.
  const one = <T,>(v: unknown): T | null =>
    (Array.isArray(v) ? (v[0] ?? null) : (v ?? null)) as T | null;

  const rows: FailedMessageRow[] = (data ?? []).map((r) => {
    const raw = r as Omit<FailedMessageRow, "conversation"> & {
      conversation?: unknown;
    };
    const conv = one<{ id: string; contact?: unknown }>(raw.conversation);
    return {
      id: raw.id,
      conversation_id: raw.conversation_id,
      sender_type: raw.sender_type,
      content_type: raw.content_type,
      content_text: raw.content_text,
      created_at: raw.created_at,
      conversation: conv
        ? { id: conv.id, contact: one<FailedContact>(conv.contact) }
        : null,
    };
  });

  return deriveFailedMessages(rows);
}
