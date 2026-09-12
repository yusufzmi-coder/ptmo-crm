import type { Message } from "@/types";

/**
 * Prefix every optimistic (not-yet-persisted) bubble carries as its id.
 * Real rows carry a UUID from the database.
 */
export const OPTIMISTIC_ID_PREFIX = "temp-";

/**
 * Whether an id belongs to an optimistic placeholder rather than a DB
 * row. Takes the id itself, not the row, so the reaction path — which
 * only has a message id in hand — can ask the same question.
 */
export function isOptimistic(id: string): boolean {
  return id.startsWith(OPTIMISTIC_ID_PREFIX);
}

/**
 * Mint an id for an optimistic bubble.
 *
 * `Date.now()` alone collides when two sends land in the same
 * millisecond — two bubbles sharing an id makes `onUpdateMessage` patch
 * both and React reuse one key for two rows. The random suffix removes
 * that; `crypto.randomUUID` is available in every browser this app
 * supports and in Node 19+, with a cheap fallback for anything older
 * (jsdom-less test runners, embedded webviews).
 */
export function optimisticId(now = Date.now()): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
  return `${OPTIMISTIC_ID_PREFIX}${now}-${rand}`;
}

/**
 * Merge a realtime message INSERT into the open thread's message list.
 *
 * Why this is not a one-liner
 * ---------------------------
 * The old code dropped EVERY `temp-` bubble on any incoming INSERT:
 *
 *     const withoutOptimistic = prev.filter((m) => !m.id.startsWith("temp-"));
 *
 * The realtime channel is unfiltered (see use-realtime.ts), so "any
 * INSERT" includes the parent's own inbound message, the AI auto-reply,
 * and — in the shared inbox this product exists for — a second agent
 * replying to the same thread. Each of those wiped the first agent's
 * in-flight bubble, and a bubble already marked `failed` went with it.
 * The composer is cleared the moment send is pressed, so that bubble was
 * the only remaining copy of what the agent had typed: the text was
 * unrecoverable.
 *
 * The rule here
 * -------------
 * An incoming row may retire at most ONE optimistic bubble, and only one
 * it plausibly IS:
 *
 *   - the row must be outbound (`sender_type === 'agent'`); a customer
 *     or bot message never corresponds to something this agent typed
 *   - the bubble must not be `failed` — a failed send is a record the
 *     agent still needs, never a placeholder awaiting its real row
 *   - content type and text must match
 *
 * Matching on content rather than an id is a deliberate limitation:
 * `sendMessageToConversation` writes `sender_type: 'agent'` without a
 * `sender_id` (src/lib/whatsapp/send-message.ts), so nothing on the row
 * says WHICH agent sent it. Two agents sending the identical string into
 * one thread can therefore retire each other's placeholder — but both
 * messages still end up rendered exactly once, which is the property
 * that matters. Giving the send path a client nonce would make this
 * exact; it needs a schema column, so it is deliberately left out here.
 *
 * The oldest match wins, so two queued sends of the same text resolve in
 * the order they were made.
 */
export function reconcileIncomingMessage(
  prev: Message[],
  incoming: Message,
): Message[] {
  // Realtime can redeliver; never render a row twice.
  if (prev.some((m) => m.id === incoming.id)) return prev;

  if (incoming.sender_type !== "agent") return [...prev, incoming];

  const matchIndex = prev.findIndex(
    (m) =>
      isOptimistic(m.id) &&
      m.status !== "failed" &&
      m.content_type === incoming.content_type &&
      (m.content_text ?? "") === (incoming.content_text ?? ""),
  );

  if (matchIndex === -1) return [...prev, incoming];

  const next = prev.slice();
  next.splice(matchIndex, 1);
  return [...next, incoming];
}
