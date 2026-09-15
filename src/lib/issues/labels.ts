import type { IssueCategory, IssueSeverity } from "@/types";

/**
 * The runtime lists behind the `IssueCategory` and `IssueSeverity`
 * unions, and the map from a route's error code to a catalogue key.
 *
 * WHY THESE ARE HERE AND NOT WHERE THEY WERE
 *
 * The API route declared its own local `CATEGORIES` array and the error
 * map lived in a test file. Neither could be imported by the code that
 * needed them, so both were about to be copied — and a copy of a list
 * like this does not announce itself when it falls behind. It simply
 * stops offering one option, or renders a keypath for one error.
 *
 * WHY A RECORD AND NOT AN ARRAY
 *
 * `readonly IssueCategory[]` accepts a list that is MISSING a member.
 * Add a tenth category to the union and an array-typed list keeps
 * compiling while the API silently rejects the new value and the picker
 * silently stops offering it.
 *
 * A `Record<IssueCategory, true>` cannot be missing a member: leaving one
 * out is a compile error naming the property. So the exhaustiveness is
 * enforced by the type checker on every build rather than by a test that
 * someone has to remember to write.
 */

const CATEGORY_MEMBERS: Record<IssueCategory, true> = {
  progress: true,
  keselamatan: true,
  staf: true,
  servis: true,
  yuran: true,
  jadual: true,
  pendaftaran: true,
  fasiliti: true,
  lain: true,
};

const SEVERITY_MEMBERS: Record<IssueSeverity, true> = {
  biasa: true,
  penting: true,
  kritikal: true,
};

/**
 * Every category, in the order the CHECK constraint lists them.
 *
 * THE WRITE ORDER OF THE RECORD ABOVE IS THE DISPLAY ORDER. `Object.keys`
 * returns string keys in insertion order — guaranteed by the language for
 * keys that are not integer-like, and none of these are — so reordering
 * the Record silently reorders every picker that maps over this.
 *
 * That is a real coupling rather than a hypothetical one: the create
 * dialog checked this order matched its own before importing, precisely
 * because a picker that rearranges itself between releases looks broken
 * to whoever uses it daily. Sort at the call site if a screen wants a
 * different order; do not reorder here.
 */
export const ISSUE_CATEGORIES = Object.keys(
  CATEGORY_MEMBERS,
) as readonly IssueCategory[];

export const ISSUE_SEVERITIES = Object.keys(
  SEVERITY_MEMBERS,
) as readonly IssueSeverity[];

export function isIssueCategory(value: unknown): value is IssueCategory {
  return typeof value === "string" && value in CATEGORY_MEMBERS;
}

export function isIssueSeverity(value: unknown): value is IssueSeverity {
  return typeof value === "string" && value in SEVERITY_MEMBERS;
}

/**
 * Route error code → catalogue key under `Issues.errors`.
 *
 * The routes return snake_case codes and the catalogue uses camelCase
 * keys, so the two lists cannot be lined up by name. Without this in one
 * importable place the mapping ends up written separately inside every
 * component that handles a failure — which is where it was heading, and
 * those copies disagree the moment a code is added.
 *
 * `insert_failed` and `update_failed` deliberately collapse onto one
 * message: a person does not need to know which statement failed, only
 * that nothing was saved.
 */
export const ISSUE_ERROR_KEYS = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  profile_not_linked: "profileNotLinked",
  not_found: "notFound",
  invalid_transition: "invalidTransition",
  summary_required: "summaryRequired",
  resolution_required: "resolutionRequired",
  invalid_category: "invalidCategory",
  invalid_severity: "invalidSeverity",
  invalid_body: "invalidBody",
  nothing_to_update: "nothingToUpdate",
  insert_failed: "saveFailed",
  update_failed: "saveFailed",
} as const satisfies Record<string, string>;

export type IssueErrorCode = keyof typeof ISSUE_ERROR_KEYS;

/**
 * The catalogue key for an error code, falling back to `saveFailed` for
 * anything unrecognised.
 *
 * The fallback is deliberate but narrow: a code this map has not heard of
 * is a code somebody added to a route without coming here, and telling
 * the user "that did not save" is closer to true than rendering the raw
 * code at them. It is not a licence to skip adding the key — the test
 * beside this file fails on any route code that is missing.
 */
export function issueErrorKey(code: string | undefined | null): string {
  if (!code) return "saveFailed";
  return (ISSUE_ERROR_KEYS as Record<string, string>)[code] ?? "saveFailed";
}
