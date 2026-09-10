import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContentType, ConversationStatus, SenderType } from "@/types";
import {
  DEFAULT_COVERAGE,
  OPS_TIME_ZONE,
  measureWait,
  slaState,
  type CoverageWindow,
  type SlaState,
  type SlaTier,
} from "./sla";

/**
 * "Belum Dibalas" — the awaiting-reply board.
 *
 * What counts as unanswered
 * -------------------------
 * A conversation is on the board when its most recent message came
 * from the customer and nobody on our side has sent anything since.
 * "Our side" is any non-customer sender: a human agent OR the AI bot.
 * From the parent's seat an auto-reply is still a reply — they are no
 * longer staring at a blank screen — so the bot clears a thread here.
 * (Whether the bot's answer was *good* is a different board.)
 *
 * The wait is measured from the FIRST unanswered inbound message, not
 * the latest. A parent who sends "Hello?", then "Anyone there?", then
 * "??" has been waiting since "Hello?". Measuring from "??" would let
 * an impatient parent look freshly arrived. The preview, though, shows
 * their latest message, because that is what staff need to read.
 *
 * Closed conversations are excluded. `pending` is just an inbox filter
 * label in this schema — it does not mean "waiting on the customer" —
 * so pending threads stay on the board.
 *
 * Everything in `deriveUnanswered` and `sortByUrgency` is pure; the
 * Supabase call is confined to `loadUnanswered` so the logic can be
 * tested without a database.
 */

export interface BoardConversation {
  id: string;
  status: ConversationStatus;
  assigned_agent_id: string | null;
  contact: { id: string; name: string | null; phone: string } | null;
}

export interface BoardMessage {
  conversation_id: string;
  sender_type: SenderType;
  content_type: ContentType;
  content_text: string | null;
  created_at: string;
}

export interface UnansweredItem {
  conversationId: string;
  contactName: string | null;
  contactPhone: string | null;
  assignedAgentId: string | null;
  /** Latest inbound message, for staff to read at a glance. */
  preview: string;
  /** ISO timestamp of the first unanswered inbound message. */
  waitingSince: string;
  /** Covered minutes waited, per the SLA clock. */
  waitedMinutes: number;
  /** Which standard the wait is judged by. Null while off duty. */
  tier: SlaTier | null;
  state: SlaState;
}

/** Only these statuses can have a parent waiting on us. */
const ACTIVE_STATUSES: ReadonlySet<ConversationStatus> = new Set([
  "open",
  "pending",
]);

/** Short stand-ins for non-text messages so the preview is never blank. */
const CONTENT_PLACEHOLDER: Partial<Record<ContentType, string>> = {
  image: "[Image]",
  document: "[Document]",
  audio: "[Voice note]",
  video: "[Video]",
  location: "[Location]",
  template: "[Template]",
};

export function previewText(m: BoardMessage): string {
  const text = m.content_text?.trim();
  if (text) return text;
  return CONTENT_PLACEHOLDER[m.content_type] ?? `[${m.content_type}]`;
}

/**
 * Pure derivation. `messages` may arrive in any order; they are sorted
 * here. Conversations without any message, closed conversations, and
 * conversations whose latest message is from our side are dropped.
 */
export function deriveUnanswered(
  conversations: BoardConversation[],
  messages: BoardMessage[],
  now: Date,
  coverage: CoverageWindow[] = DEFAULT_COVERAGE,
  timeZone: string = OPS_TIME_ZONE,
): UnansweredItem[] {
  const byConversation = new Map<string, BoardMessage[]>();
  for (const m of messages) {
    const list = byConversation.get(m.conversation_id);
    if (list) list.push(m);
    else byConversation.set(m.conversation_id, [m]);
  }

  const items: UnansweredItem[] = [];

  for (const c of conversations) {
    if (!ACTIVE_STATUSES.has(c.status)) continue;
    const list = byConversation.get(c.id);
    if (!list || list.length === 0) continue;

    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const latest = list[list.length - 1];
    if (latest.sender_type !== "customer") continue;

    // Walk back from the end to the last outbound; everything after it
    // is the unanswered run, and its first message is when the wait
    // began.
    let firstUnanswered = latest;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].sender_type !== "customer") break;
      firstUnanswered = list[i];
    }

    const wait = measureWait(
      new Date(firstUnanswered.created_at),
      now,
      coverage,
      timeZone,
    );

    items.push({
      conversationId: c.id,
      contactName: c.contact?.name?.trim() || null,
      contactPhone: c.contact?.phone ?? null,
      assignedAgentId: c.assigned_agent_id ?? null,
      preview: previewText(latest),
      waitingSince: firstUnanswered.created_at,
      waitedMinutes: wait.minutes,
      tier: wait.tier,
      state: slaState(wait.minutes, wait.tier),
    });
  }

  return sortByUrgency(items);
}

const STATE_RANK: Record<SlaState, number> = {
  breached: 0,
  warning: 1,
  ok: 2,
};

/**
 * Red first, then amber, then green. Inside a group the longest covered
 * wait comes first; on a tie the earlier inbound message wins, so two
 * parents who both arrived during the break keep their real order.
 */
export function sortByUrgency(items: UnansweredItem[]): UnansweredItem[] {
  return [...items].sort((a, b) => {
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (rank !== 0) return rank;
    if (a.waitedMinutes !== b.waitedMinutes) {
      return b.waitedMinutes - a.waitedMinutes;
    }
    return a.waitingSince.localeCompare(b.waitingSince);
  });
}

// ------------------------------------------------------------
// Data access. Runs on the client with the user's own session, so RLS
// scopes both queries to the caller's account — same pattern as
// src/lib/dashboard/queries.ts. No service role, no RPC, no migration.
// ------------------------------------------------------------

/**
 * How far back to look. Matches the SLA walk cap: a thread silent for
 * two months is not a live queue item, it is a closed loop nobody
 * closed, and a different report should surface it.
 */
export const LOOKBACK_DAYS = 60;

/** PostgREST `in()` lists get long; batch conversation ids. */
const IN_BATCH = 200;

export async function loadUnanswered(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<UnansweredItem[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);

  const { data: convRows, error: convError } = await db
    .from("conversations")
    .select(
      "id, status, assigned_agent_id, last_message_at, contact:contacts(id, name, phone)",
    )
    .neq("status", "closed")
    .gte("last_message_at", since.toISOString())
    .order("last_message_at", { ascending: false });
  if (convError) throw convError;

  const conversations: BoardConversation[] = (convRows ?? []).map((r) => {
    // PostgREST types a to-one embed as an array in some client
    // versions; normalise defensively.
    const raw = (r as { contact?: unknown }).contact;
    const contact = Array.isArray(raw) ? (raw[0] ?? null) : raw;
    return {
      id: (r as { id: string }).id,
      status: (r as { status: ConversationStatus }).status,
      assigned_agent_id:
        (r as { assigned_agent_id: string | null }).assigned_agent_id ?? null,
      contact: (contact as BoardConversation["contact"]) ?? null,
    };
  });

  if (conversations.length === 0) return [];

  const messages: BoardMessage[] = [];
  for (let i = 0; i < conversations.length; i += IN_BATCH) {
    const ids = conversations.slice(i, i + IN_BATCH).map((c) => c.id);
    const { data, error } = await db
      .from("messages")
      .select("conversation_id, sender_type, content_type, content_text, created_at")
      .in("conversation_id", ids)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true });
    if (error) throw error;
    messages.push(...((data ?? []) as BoardMessage[]));
  }

  return deriveUnanswered(conversations, messages, now);
}
