import type { IssueCategory, IssueSeverity } from "@/types";

/**
 * The runtime lists behind `IssueCategory` and `IssueSeverity`, and the
 * map from an API error code to its catalogue key.
 *
 * Why this module exists at all: `labels.test.ts` shipped first and held
 * all three of these as file-local constants. A test file cannot be
 * imported by production code, so the API route declared its own copy of
 * the category list and the inbox dialog declared its own copy of the
 * error map — which is precisely the duplication the test was written to
 * prevent. The test was guarding a contract that nothing else could read.
 *
 * Everything here is exported so there is one copy and the test has a
 * module to test.
 */

/**
 * Exhaustive by construction. This is a `Record` keyed on the union and
 * not an array, and the difference is the whole point: TypeScript accepts
 * an array that is missing members, so a tenth category added to the type
 * would leave every array-shaped list silently short. A `Record` will not
 * compile until the new member is present here.
 *
 * That failure mode is not hypothetical — it is the one where the type
 * and the UI agree, and the API rejects the value with `invalid_category`
 * at the moment a member of staff tries to file it.
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
 * API error code to `Issues.errors.*` catalogue key.
 *
 * Codes are snake_case and keys are camelCase, so the two lists cannot be
 * compared directly and the mapping has to be written down somewhere. It
 * belongs here rather than inside whichever component happens to render
 * an error, which is where it would otherwise live — differently, three
 * times.
 *
 * Several codes collapse onto one message on purpose: a caller does not
 * need to know whether the write failed on insert or on update, only that
 * it did not save.
 */
export const ERROR_CODE_TO_KEY: Readonly<Record<string, string>> = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  profile_not_linked: "profileNotLinked",
  not_found: "notFound",
  invalid_transition: "invalidTransition",
  summary_required: "summaryRequired",
  invalid_category: "invalidCategory",
  invalid_severity: "invalidSeverity",
  invalid_body: "invalidBody",
  nothing_to_update: "nothingToUpdate",
  insert_failed: "saveFailed",
  update_failed: "saveFailed",
};

/**
 * `saveFailed` is the right default for an unrecognised code: the agent
 * needs to know the case did not save, and inventing a more specific
 * message for a code we do not know would be a guess shown as a fact.
 */
export function errorKeyFor(code: string | undefined): string {
  return (code && ERROR_CODE_TO_KEY[code]) || "saveFailed";
}
