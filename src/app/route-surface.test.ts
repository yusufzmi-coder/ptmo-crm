import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every page under (dashboard) must appear in the sidebar and the header
 * title map, derived from the route tree rather than restated by hand.
 *
 * middleware.test.ts already does this for `protectedPaths`, and it
 * exists because that array drifted twice: /ops was missing until
 * someone noticed, then /flows, /agents and /notifications shipped
 * unguarded. Two more hand-kept lists have the same shape and the same
 * failure — a page added without touching them is reachable but
 * unreachable-by-nav, and the header falls back to "Dashboard".
 *
 * Reading either list tells you nothing, because the defect is the page
 * that ISN'T named in it. So this asserts against the filesystem.
 *
 * WHY THERE IS NO EXCEPTION LIST
 *
 * Today the relationship is exactly 1:1 — eleven segments, eleven nav
 * entries, eleven title entries. Nothing is deliberately hidden, so
 * nothing needs excusing, and a fourth hand-kept list of exemptions
 * would move the drift rather than stop it.
 *
 * If a page is ever meant to be reachable without nav, this test fails
 * and that is the right moment to ask whether it should be. Add an
 * exception only with the reason written next to it.
 *
 * The lists are read with the TypeScript AST rather than imported:
 * sidebar.tsx pulls in useAuth, which constructs a Supabase client at
 * module load and needs env this suite does not have.
 */

const APP_DIR = import.meta.dirname;
const DASHBOARD = join(APP_DIR, "(dashboard)");

/** Top-level segments under the (dashboard) route group. */
const segments = readdirSync(DASHBOARD, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  // Route groups `(x)`, private folders `_x` and dynamic segments `[x]`
  // are not top-level paths of their own.
  .filter((entry) => !/^[([_]/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

/**
 * Every string literal in a file that looks like an app path. Catches
 * `href: "/inbox"` and `"/ops/unanswered": "ops"` alike without either
 * list having to expose its shape, and ignores paths inside comments,
 * which a text search would not.
 */
function appPathsIn(relativePath: string): string[] {
  const file = join(APP_DIR, "..", relativePath);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) && /^\/[a-z][a-z0-9-]*(\/|$)/.test(node.text)) {
      found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found];
}

/** Which segment a path belongs to: "/ops/unanswered" → "ops". */
const segmentOf = (path: string) => path.split("/")[1];

describe("every (dashboard) page is reachable and titled", () => {
  it("finds the route group (guards against a silently empty glob)", () => {
    // Without this, a renamed (dashboard) directory would leave
    // `segments` empty and every assertion below would vacuously pass —
    // the same failure mode the contrast harness hit when Tailwind
    // generated no class and the measurement read 17.76.
    expect(segments.length).toBeGreaterThanOrEqual(11);
    expect(segments).toContain("dashboard");
  });

  it("the sidebar links to all of them", () => {
    const linked = new Set(
      appPathsIn("components/layout/sidebar.tsx").map(segmentOf),
    );
    const missing = segments.filter((s) => !linked.has(s));
    expect(missing, "segments with no sidebar entry").toEqual([]);
  });

  it("the header can title all of them", () => {
    const titled = new Set(
      appPathsIn("components/layout/header.tsx").map(segmentOf),
    );
    const missing = segments.filter((s) => !titled.has(s));
    expect(missing, "segments with no header title").toEqual([]);
  });
});

/**
 * The extractor, checked against known input.
 *
 * An empty `missing` list means either full coverage or a parser that
 * found nothing, and the assertion alone cannot tell them apart. Every
 * calibration skipped this week produced a confident wrong answer, so
 * the calibration lives in the suite.
 */
describe("the path extractor actually extracts", () => {
  it("reads real paths out of the sidebar", () => {
    const paths = appPathsIn("components/layout/sidebar.tsx");
    expect(paths).toContain("/inbox");
    expect(paths).toContain("/settings");
    expect(paths.length).toBeGreaterThanOrEqual(11);
  });

  it("reads the header's deeper paths, not just top-level ones", () => {
    // /ops is titled by its child route, so a segment-only matcher would
    // report ops as untitled and be wrong.
    expect(appPathsIn("components/layout/header.tsx")).toContain(
      "/ops/unanswered",
    );
  });

  it("maps a deep path back to its segment", () => {
    expect(segmentOf("/ops/unanswered")).toBe("ops");
    expect(segmentOf("/inbox")).toBe("inbox");
  });
});
