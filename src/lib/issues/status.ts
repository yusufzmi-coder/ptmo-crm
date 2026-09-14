import type { IssueStatus } from "@/types";

/**
 * Which status moves an issue may make.
 *
 * The point of the Issues tab is that a parent's complaint cannot go
 * missing because nobody tagged it. That is a claim about the TRAIL, not
 * about the final state, and it is what shapes this table:
 *
 *  - There is no jump from `new` to `resolved`. Closing something nobody
 *    ever acknowledged leaves no record that a human read it, which is
 *    the exact failure the tab exists to prevent. Someone must own it
 *    first, even if owning it and fixing it happen a minute apart.
 *  - `resolved` is not terminal. A parent who says "this is not fixed"
 *    reopens it, and the reopen is itself a recorded move rather than a
 *    new issue that loses the history.
 *  - `waiting` and `investigating` cross both ways. Waiting on a parent
 *    who then replies is the common case, and forcing that back through
 *    `acknowledged` would add a step that says nothing.
 *
 * `reopened` deliberately does NOT lead back to `acknowledged`: the
 * issue was already acknowledged once, and re-acknowledging it would
 * record a fact that is not true a second time.
 */
const TRANSITIONS: Readonly<Record<IssueStatus, readonly IssueStatus[]>> = {
  new: ["acknowledged"],
  acknowledged: ["investigating", "waiting", "resolution_proposed"],
  investigating: ["waiting", "resolution_proposed"],
  waiting: ["investigating", "resolution_proposed"],
  resolution_proposed: ["resolved", "investigating"],
  resolved: ["reopened"],
  reopened: ["investigating", "waiting", "resolution_proposed"],
};

/** Every status, in the order a healthy issue tends to move through. */
export const ISSUE_STATUSES = Object.keys(TRANSITIONS) as readonly IssueStatus[];

/** The status an issue starts in. */
export const INITIAL_ISSUE_STATUS: IssueStatus = "new";

/**
 * Where an issue may go from here. Empty for no status today, but do not
 * rely on that: `resolved` looked terminal until reopen existed.
 */
export function allowedTransitions(from: IssueStatus): readonly IssueStatus[] {
  return TRANSITIONS[from] ?? [];
}

/**
 * Is this move legal?
 *
 * A move to the status it already has is NOT a transition. The caller
 * should treat an unchanged status as "nothing happened" and write no
 * event, rather than filling the trail with rows that record no movement.
 */
export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  if (from === to) return false;
  return allowedTransitions(from).includes(to);
}

/**
 * True once an issue has been closed out — used to decide whether
 * `resolved_at` should carry a timestamp.
 *
 * Kept as a function rather than a comparison at each call site because
 * getting it wrong in one place silently corrupts every time-to-close
 * figure derived from the column.
 */
export function isResolvedStatus(status: IssueStatus): boolean {
  return status === "resolved";
}
