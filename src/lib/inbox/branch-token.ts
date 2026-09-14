/**
 * Branch-aware snippet text.
 *
 * Migrations 040 and 042 made the outbound NUMBER branch-correct. They
 * say nothing about the words. A quick reply is account-wide, so the
 * picker offers "Sila datang ke cawangan Batu Caves" to an agent
 * answering a Rawang parent, and the product raises nothing. The number
 * is a subtle cue; the body text is what the parent reads and acts on.
 *
 * Two mechanisms here, in order of how much they help:
 *
 *   1. {@link expandBranchTokens} — `{{cawangan}}` resolves to the
 *      thread's branch at insert time. ONE snippet serves all sixteen
 *      centres and naming the wrong one becomes impossible rather than
 *      merely discouraged. This is the mechanism to reach for.
 *
 *   2. {@link findForeignBranchMentions} — a backstop for the snippets
 *      that hardcode a centre anyway. It cannot prevent anything; it
 *      only lets the picker say "this names Batu Caves and you are in
 *      Rawang" before the agent clicks.
 *
 * Both are pure string work so they can be tested without a database,
 * and both run on the server so the branch comes from
 * `conversations.whatsapp_config_id` rather than from client state.
 */

/**
 * Token spellings we accept, as alternatives inside one group.
 *
 * Malay first because that is what staff write, with the English alias
 * kept so snippets copied from upstream docs still work. Matching is
 * case-insensitive and tolerant of inner padding, so `{{ Cawangan }}`
 * behaves like `{{cawangan}}` — an agent typing a token by hand should
 * not have to match whitespace exactly to avoid sending literal braces
 * to a parent.
 */
const BRANCH_TOKEN_RE = /\{\{\s*(?:cawangan|branch)\s*\}\}/gi;

/** True when `text` contains at least one branch token. */
export function hasBranchToken(text: string | null | undefined): boolean {
  if (!text) return false;
  // `lastIndex` is shared state on a /g regex — reset before reuse or
  // consecutive calls alternate between true and false.
  BRANCH_TOKEN_RE.lastIndex = 0;
  return BRANCH_TOKEN_RE.test(text);
}

/**
 * Replace every branch token in `text` with `branchName`.
 *
 * Callers must not pass an empty `branchName`: a snippet whose token
 * cannot be resolved has to be blocked, not silently emptied. Sending
 * "Sila datang ke cawangan  sebelum 6 petang" is a worse outcome than
 * refusing to offer the snippet, and sending the literal `{{cawangan}}`
 * is worse still. The API checks resolvability first and marks such
 * snippets unusable; this function throws if that check was skipped.
 */
export function expandBranchTokens(text: string, branchName: string): string {
  if (!branchName.trim()) {
    throw new Error(
      'expandBranchTokens: refusing to expand with an empty branch name',
    );
  }
  BRANCH_TOKEN_RE.lastIndex = 0;
  return text.replace(BRANCH_TOKEN_RE, branchName);
}

/**
 * {@link expandBranchTokens} over every string in a JSON value.
 *
 * Interactive snippets keep their text in a nested structure (body,
 * header, footer, button titles, list section rows), and a token is
 * just as useful in a button that reads "Ke {{cawangan}}" as in a
 * sentence. Walking the whole value rather than naming each field keeps
 * this working if the payload shape grows.
 *
 * Expanding CAN break a payload — Meta caps a button title at 20
 * characters and "Kota Damansara" is fourteen of them — so the caller
 * must re-validate the result and refuse the snippet if it no longer
 * fits, rather than letting the send fail at Meta with a stack trace.
 */
export function expandBranchTokensDeep<T>(value: T, branchName: string): T {
  if (typeof value === 'string') {
    return expandBranchTokens(value, branchName) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandBranchTokensDeep(v, branchName)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandBranchTokensDeep(v, branchName);
    }
    return out as unknown as T;
  }
  return value;
}

/** Every string in a JSON value, flattened — for token/mention scans. */
export function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, into);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, into);
    }
  }
  return into;
}

/** Escape a label for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shortest label we will search for. Two-character labels ("K1", "PJ")
 * collide with ordinary words and abbreviations often enough that the
 * warning would cry wolf, and a warning nobody believes is worse than
 * no warning — agents learn to dismiss it and stop reading the real
 * ones.
 */
const MIN_MATCHABLE_LABEL = 3;

/**
 * Branch names, other than the current one, that `text` mentions.
 *
 * Used by the quick-reply picker to flag a snippet that hardcodes a
 * different centre. Returns the labels as the admin spelled them, in
 * the order given, de-duplicated.
 *
 * Matching is case-insensitive and bounded by non-letters rather than
 * `\b`, because branch names here are multi-word Malaysian place names
 * ("Batu Caves", "Kota Damansara") and `\b` around a phrase behaves
 * differently than around a single token. Digits count as part of a
 * label so "Rawang 2" is not matched by a search for "Rawang".
 */
export function findForeignBranchMentions(
  text: string | null | undefined,
  currentBranchName: string | null,
  allBranchNames: readonly string[],
): string[] {
  if (!text) return [];

  const current = currentBranchName?.trim().toLowerCase() ?? null;
  const found: string[] = [];
  const seen = new Set<string>();

  for (const raw of allBranchNames) {
    const label = raw.trim();
    if (label.length < MIN_MATCHABLE_LABEL) continue;

    const lower = label.toLowerCase();
    if (seen.has(lower)) continue;

    // The thread's own branch is not a foreign mention.
    if (current !== null && lower === current) continue;

    // A label that is a substring of the current branch ("Rawang" while
    // we are in "Rawang 2") would match on the current branch's own
    // name. Flagging that reads as a bug to the agent, so skip it and
    // accept the miss: the reverse case, a longer label containing the
    // current one, is still caught.
    if (current !== null && current.includes(lower)) continue;

    // (?<![\p{L}\p{N}]) / (?![\p{L}\p{N}]) — the label must not be
    // glued to another word or number on either side.
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(label)}(?![\\p{L}\\p{N}])`,
      'iu',
    );
    if (re.test(text)) {
      found.push(label);
      seen.add(lower);
    }
  }

  return found;
}
