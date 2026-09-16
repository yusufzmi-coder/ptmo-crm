import {
  collectStrings,
  expandBranchTokens,
  expandBranchTokensDeep,
  findForeignBranchMentions,
  hasBranchToken,
} from '@/lib/inbox/branch-token';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import { isMissingColumn } from '@/lib/db/schema-drift';

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
 * Whether a Supabase error means the 043 branch column is absent.
 *
 * Thin wrapper over the shared detector so callers in this module read
 * in terms of the branch feature rather than a column name. The codes
 * and the reason they matter live in `@/lib/db/schema-drift`.
 */
export function isMissingBranchColumn(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  return isMissingColumn(error, 'whatsapp_config_id');
}
