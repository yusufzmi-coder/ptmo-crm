import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ISSUE_STATUSES } from "./status";

/**
 * The catalogue must cover every identifier the code can produce.
 *
 * `src/i18n/messages.test.ts` checks that the three locale files agree
 * with each other. It cannot check that they agree with the CODE — add a
 * tenth category to the type and all three stay in perfect parity while
 * the UI renders the raw identifier `fasiliti_baharu` onto a screen.
 *
 * Same hole the colour-mode identifier fell through, so it gets the same
 * guard: the labels are checked against the source of truth, not against
 * each other.
 */

const LOCALES = ["en", "ko", "ms"] as const;

/**
 * Route error code → catalogue key.
 *
 * The routes return snake_case codes; the catalogue uses camelCase keys
 * chosen by the sessions building the UI. That means the two lists cannot
 * be compared directly, and a mapping written down here is better than a
 * mapping that exists only in whichever component happens to handle the
 * error — which is where it would otherwise live, differently, three
 * times.
 *
 * Several codes collapse onto one message on purpose: a caller does not
 * need to know whether the write failed on insert or update, only that it
 * did not save.
 */
const ERROR_CODE_TO_KEY: Record<string, string> = {
  unauthorized: "unauthorized",
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

function catalogue(locale: string) {
  const raw = readFileSync(
    join(process.cwd(), "messages", `${locale}.json`),
    "utf8",
  );
  return JSON.parse(raw).Issues as Record<string, Record<string, string>>;
}

/** Pull a string-literal union's members out of the type source — a union
 * has no runtime value to import. */
function unionMembers(typeName: string): string[] {
  const src = readFileSync(
    join(process.cwd(), "src", "types", "index.ts"),
    "utf8",
  );
  const block = new RegExp(`export type ${typeName} =([^;]*);`).exec(src);
  if (!block) throw new Error(`${typeName} not found in src/types/index.ts`);
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Every error code the issues routes can put in a JSON body. */
function routeErrorCodes(): string[] {
  const files = [
    join(process.cwd(), "src", "app", "api", "issues", "route.ts"),
    join(process.cwd(), "src", "app", "api", "issues", "[id]", "route.ts"),
  ];
  const codes = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/error:\s*'([a-z_]+)'/g)) codes.add(m[1]);
    // The `?? 'insert_failed'` fallbacks, which the pattern above misses.
    for (const m of src.matchAll(/\?\?\s*'([a-z_]+)'/g)) codes.add(m[1]);
  }
  return [...codes];
}

describe.each(LOCALES)("%s catalogue covers the code", (locale) => {
  const issues = catalogue(locale);

  it("labels every category", () => {
    expect(Object.keys(issues.category).sort()).toEqual(
      unionMembers("IssueCategory").sort(),
    );
  });

  it("labels every severity", () => {
    expect(Object.keys(issues.severity).sort()).toEqual(
      unionMembers("IssueSeverity").sort(),
    );
  });

  it("labels every status", () => {
    expect(Object.keys(issues.status).sort()).toEqual([...ISSUE_STATUSES].sort());
  });

  it("has a message for every error code the routes return", () => {
    const missing = routeErrorCodes().filter((code) => {
      const key = ERROR_CODE_TO_KEY[code];
      return !key || !(key in issues.errors);
    });
    expect(missing, "route error codes with no catalogue entry").toEqual([]);
  });

  it("maps no error code to a key that does not exist", () => {
    // The other direction: a renamed catalogue key leaves this map
    // pointing at nothing, and the UI would render a keypath.
    const dangling = Object.values(ERROR_CODE_TO_KEY).filter(
      (key) => !(key in issues.errors),
    );
    expect(dangling).toEqual([]);
  });

  it("has no blank label", () => {
    for (const [block, entries] of Object.entries(issues)) {
      for (const [key, value] of Object.entries(entries)) {
        expect(value.trim(), `Issues.${block}.${key} is empty`).not.toBe("");
      }
    }
  });
});

describe("the shared blocks stay shared", () => {
  it("declares status, category and severity labels exactly once", () => {
    // Three screens render these — the list, the detail page and the
    // create dialog in the inbox. A second copy under any of them will
    // drift, and two screens side by side will name the same state
    // differently. That is the failure Flows.status was consolidated to
    // prevent, and with three readers it is three times as easy to hit.
    const issues = catalogue("en");
    const identifiers = [
      ...ISSUE_STATUSES,
      ...unionMembers("IssueCategory"),
      ...unionMembers("IssueSeverity"),
    ];
    for (const block of ["list", "detail", "create"] as const) {
      for (const id of identifiers) {
        expect(
          Object.keys(issues[block]),
          `Issues.${block} re-declares "${id}"`,
        ).not.toContain(id);
      }
    }
  });

  it("keeps error text out of the create block", () => {
    // The inbox dialog asked for its own summaryRequired / notLinked /
    // failed. Those already exist under Issues.errors and are returned
    // by the same routes the dialog calls, so duplicating them here
    // would give one failure two wordings depending on which screen the
    // user happened to be on.
    const create = Object.keys(catalogue("en").create);
    for (const leaked of ["summaryRequired", "notLinked", "failed", "error"]) {
      expect(create, `Issues.create re-declares "${leaked}"`).not.toContain(
        leaked,
      );
    }
  });
});

describe("Malay is written, not copied", () => {
  it("differs from English almost everywhere", () => {
    // ms is the production locale. A catalogue that passes key parity
    // while holding English text is exactly what the parity test cannot
    // see — and what would be noticed first on screen.
    const en = catalogue("en");
    const ms = catalogue("ms");
    const identical: string[] = [];
    for (const [block, entries] of Object.entries(en)) {
      for (const [key, value] of Object.entries(entries)) {
        if (ms[block]?.[key] === value) identical.push(`${block}.${key}`);
      }
    }
    // A few legitimately match: "Status" is the same word in Malay, and
    // several category labels are the stored Malay identifier already.
    // Beyond that it is untranslated text hiding behind parity.
    expect(identical.length, `identical: ${identical.join(", ")}`).toBeLessThanOrEqual(12);
  });
});
