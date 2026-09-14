import type { Conversation } from "@/types";

/**
 * Ownership filter for the shared inbox.
 *
 * Sixteen branches answer into one list. Without this, the only way to
 * learn whether a thread is yours is to open it — and opening it is
 * exactly what two agents must not both do. `mine` / `unassigned` /
 * `others` are the three questions staff actually ask of the queue:
 * what am I on the hook for, what is nobody on the hook for, and what
 * should I leave alone.
 *
 * Kept separate from the status filter (`open` / `pending` / `closed`)
 * because they compose: "my open threads" is a different, and more
 * useful, question than either half alone.
 */
export type AssignmentFilter = "all" | "mine" | "unassigned" | "others";

export const ASSIGNMENT_FILTERS: readonly AssignmentFilter[] = [
  "all",
  "mine",
  "unassigned",
  "others",
] as const;

/** Translation key under `Inbox.conversationList` for each filter. */
const ASSIGNMENT_LABEL_KEY: Record<AssignmentFilter, string> = {
  all: "assignAnyone",
  mine: "assignMine",
  unassigned: "assignUnassigned",
  others: "assignOthers",
};

export function assignmentLabelKey(filter: AssignmentFilter): string {
  return ASSIGNMENT_LABEL_KEY[filter];
}

/**
 * Whether a conversation passes the ownership filter.
 *
 * `currentUserId` is null while auth is still resolving. In that window
 * we cannot tell "mine" from "someone else's", and guessing either way
 * would be worse than showing nothing: a false "mine" invites an agent
 * to answer a thread they do not own, and a false "others" hides one
 * they do. So both identity-relative filters match nothing until the
 * user is known. `all` and `unassigned` do not depend on identity and
 * keep working throughout.
 */
export function matchesAssignment(
  conversation: Pick<Conversation, "assigned_agent_id">,
  filter: AssignmentFilter,
  currentUserId: string | null,
): boolean {
  const assignee = conversation.assigned_agent_id ?? null;

  switch (filter) {
    case "all":
      return true;
    case "unassigned":
      return assignee === null;
    case "mine":
      return currentUserId !== null && assignee === currentUserId;
    case "others":
      return (
        assignee !== null && currentUserId !== null && assignee !== currentUserId
      );
  }
}

/**
 * How a row should label its assignee chip.
 *
 * `null` means the thread is unowned and the row shows no chip — an
 * absent chip is the quietest way to say "nobody", and the Unassigned
 * filter is there for anyone who wants to see only those.
 */
export function assigneeBadge(
  conversation: Pick<Conversation, "assigned_agent_id">,
  currentUserId: string | null,
  nameFor: (userId: string) => string | null,
): { initial: string; isMine: boolean; name: string | null } | null {
  const assignee = conversation.assigned_agent_id ?? null;
  if (!assignee) return null;

  const name = nameFor(assignee);
  return {
    // A name we have not loaded yet still gets a chip — the thread IS
    // owned, and that fact matters more than knowing by whom. "?" is
    // honest about the gap rather than blank-looking like "unowned".
    initial: name?.trim()?.charAt(0)?.toUpperCase() || "?",
    isMine: currentUserId !== null && assignee === currentUserId,
    name,
  };
}
