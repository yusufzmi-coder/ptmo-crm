import {
  collectStrings,
  expandBranchTokens,
  expandBranchTokensDeep,
  findForeignBranchMentions,
  hasBranchToken,
} from '@/lib/inbox/branch-token';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';

/**
 * Turn a stored quick reply into the one THIS thread's branch should
 * see (migration 043).
 *
 * Kept out of the route handler so it can be tested without a database
 * or a request: the interesting cases here are all string-and-branch
 * cases, and they are the ones that decide whether a parent is told to
 * drive to the wrong centre.
 *
 * Three outcomes:
 *   - usable, text expanded, no warning — the common case;
 *   - usable but flagged, because the text hardcodes another centre;
 *   - blocked, because the snippet needs a branch and there isn't one,
 *     or expanding it broke Meta's interactive limits.
 */

export interface StoredQuickReply {
  content_text?: string | null;
  interactive_payload?: unknown;
  [key: string]: unknown;
}

export interface BranchedQuickReplyRow extends StoredQuickReply {
  branch_unresolved: boolean;
  branch_expand_error?: string;
  foreign_branches: string[];
}

export function decorateQuickReplyForBranch(
  row: StoredQuickReply,
  branchName: string | null,
  allBranchNames: readonly string[],
): BranchedQuickReplyRow {
  const contentText =
    typeof row.content_text === 'string' ? row.content_text : null;
  const payload = row.interactive_payload ?? null;

  const tokenised =
    hasBranchToken(contentText) ||
    collectStrings(payload).some((s) => hasBranchToken(s));

  // A token with no branch behind it would expand to a blank where the
  // centre's name belongs, or — worse — be sent with the braces intact.
  // Hand it back unusable and let the picker say why.
  if (tokenised && !branchName) {
    return { ...row, branch_unresolved: true, foreign_branches: [] };
  }

  let content_text = contentText;
  let interactive_payload = payload;

  if (tokenised && branchName) {
    if (contentText) content_text = expandBranchTokens(contentText, branchName);
    if (payload) {
      const expanded = expandBranchTokensDeep(payload, branchName);
      // Expansion lengthens text and Meta caps a button title at 20
      // characters, so a fourteen-character branch name can push a
      // valid snippet over. Refuse here rather than let Meta reject the
      // send after the agent has already clicked.
      const check = validateInteractivePayload(expanded);
      if (!check.ok) {
        return {
          ...row,
          branch_unresolved: true,
          branch_expand_error: check.error,
          foreign_branches: [],
        };
      }
      interactive_payload = expanded;
    }
  }

  // Scanned on the ORIGINAL text: a snippet that used the token is
  // correct by construction, and the expanded copy would name this
  // thread's own branch, which is never a foreign mention anyway.
  const haystack = [contentText ?? '', ...collectStrings(payload)].join('\n');

  return {
    ...row,
    content_text,
    interactive_payload,
    branch_unresolved: false,
    foreign_branches: findForeignBranchMentions(
      haystack,
      branchName,
      allBranchNames,
    ),
  };
}

/**
 * Postgres reports an unknown column as `42703`; PostgREST answers from
 * its schema cache instead and reports `PGRST204`. Both mean the same
 * thing here: `quick_replies.whatsapp_config_id` is not on this
 * database, because migration 043 has never been applied to it.
 *
 * Same shape as the `my_accounts()` gate in `src/lib/auth/zones.ts`
 * (`583d501`) — a build shipped ahead of its migration is a deployment
 * state, not a fault. The difference is that this one is worse when
 * unhandled: the zone call only logged, while this one 500s the request.
 */
const COLUMN_NOT_FOUND = new Set(['42703', 'PGRST204']);

/** Whether a Supabase error means the 043 branch column is absent. */
export function isMissingBranchColumn(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error?.code) return false;
  if (!COLUMN_NOT_FOUND.has(error.code)) return false;
  // Only claim it is the branch column when the message names it —
  // `42703` on any other column is a real bug and must keep 500ing.
  return (error.message ?? '').includes('whatsapp_config_id');
}
