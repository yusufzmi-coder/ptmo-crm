#!/usr/bin/env node
/**
 * Find user-visible strings that never reach the message catalogue.
 *
 *   node tools/find-untranslated.mjs src/components/settings/*.tsx
 *   node tools/find-untranslated.mjs src/app/\(dashboard\)/*\/page.tsx
 *
 * THE TOOL DOES NOT EXPAND GLOBS — THE SHELL DOES. It reads argv and
 * opens each argument as a file. That single fact explains both ways the
 * command fails, and they fail in opposite directions:
 *
 *   QUOTING A GLOB BREAKS IT. "src/components/ops/**\/*.tsx" reaches the
 *   tool literally, it tries to open a file by that name, and it dies
 *   with ENOENT. Leave globs unquoted so the shell expands them.
 *
 *   LEAVING PARENTHESES BARE BREAKS IT. src/app/(dashboard)/… is a
 *   grouping expression in zsh, so the shell rejects the line before the
 *   tool runs at all ("no matches found"). Escape them — \( \) — or, for
 *   a single literal path containing no glob, quote the whole path.
 *
 *   The two rules collide on one case: a glob inside a parenthesised
 *   directory. Escape the parentheses and leave the star bare:
 *
 *       node tools/find-untranslated.mjs src/app/\(dashboard\)/*\/page.tsx
 *
 *   This matters more than it looks. Every dashboard page in this repo
 *   sits under a parenthesised route group, so the obvious command for
 *   the largest tree is precisely the one that fails.
 *
 * Neither failure can report a tree falsely clean: a quoted glob crashes,
 * and an unexpanded pattern never reaches the tool. If the shell expands
 * to nothing, the zero-result guidance prints instead of a quiet
 * "Total: 0". This bug class is loud, not dangerous.
 *
 * WHY THIS EXISTS — a text search is not good enough here.
 *
 * A hand audit of src/components/settings (at a800140^) counted 26 real
 * untranslated strings, and exactly ONE was JSX text. The other 25 were
 * toast arguments, window.confirm messages, aria-labels, titles and
 * placeholders. Grepping for prose between angle brackets would have
 * called that tree clean.
 *
 * That 26 is a human count of strings worth fixing, not this tool's hit
 * count. Do not calibrate against 26/1 — see DO NOT CALIBRATE ON THE
 * TOTAL below.
 *
 * So this walks the TypeScript AST instead and looks at every string the
 * program can produce, wherever it sits.
 *
 * ---------------------------------------------------------------------
 * HOW TO USE IT — calibrate before you trust a clean result
 *
 * A detector that over-filters reports an empty list. So does a tree that
 * is genuinely clean. NOTHING IN THE OUTPUT DISTINGUISHES THE TWO.
 *
 * That asymmetry matters: a false "dirty" report wastes an hour, and a
 * false "clean" report closes the question for good, because nobody
 * re-checks a tree that was declared finished.
 *
 * So before you believe an empty result, run the detector against a tree
 * you already know is dirty and confirm it finds the right KIND of string
 * there — a toast, an aria-label, a title. Only then does silence on your
 * own tree mean anything.
 *
 * THE BENCHMARK IS A COMMIT, NOT A DIRECTORY.
 *
 * Use src/components/settings as it stood at a800140^ — the commit before
 * the settings i18n pass landed. Do NOT calibrate against that directory
 * at HEAD: it has since been cleaned (a800140, 36c418e), so a correct
 * detector now finds almost nothing there and you would conclude your
 * filters were broken. A benchmark that points at a moving branch has an
 * expiry date nobody writes down.
 *
 *   git archive a800140^ src/components/settings | tar -x -C /tmp/bench
 *   node tools/find-untranslated.mjs /tmp/bench/src/components/settings/*.tsx
 *
 * PASS/FAIL — these exact hits must appear. Verified against a800140^:
 *
 *   [toast]            "Failed to create invitation"
 *   [toast]            "Could not reach the server. Try again?"
 *   [dialog]           "This will delete the current WhatsApp config …"
 *   [attr:title]       "Edit"   and   "Delete"
 *   [attr:placeholder] "sk-... (OpenAI)"
 *
 * Four classes — toast, window.confirm, title, placeholder — and not one
 * of them is JSX text. If your filters silenced any class, they are too
 * aggressive; loosen them before auditing anything else.
 *
 * DO NOT CALIBRATE ON THE TOTAL. Two detectors that both find every real
 * string will still report very different totals, because the count is
 * dominated by how much harmless noise each one lets through. Runs
 * against this same archive have returned 26 (a hand audit), 29 and 113;
 * none was broken. Check the SHAPE — the per-arm counts below — and the
 * named hits above. A total is not a result.
 *
 * The 113 is this script, measured on the commit that added this line.
 * Re-measure rather than trusting it: the figure moved from 134 to 113
 * when the assigned-string arm landed and the filters were retuned, and
 * the docstring kept quoting the old number for a while. The per-arm
 * shape below survived that change untouched, which is the whole reason
 * the shape is the thing to compare.
 *
 * This detector reports 113 hits at a800140^, split:
 *
 *   toast            29     the arm that matters most
 *   attr:placeholder  5
 *   assigned-string   4
 *   jsx-text          3
 *   attr:title        3
 *   attr:aria-label   2
 *
 * If `toast` collapses, the filters are too aggressive. If `jsx-text`
 * reaches zero, the JSX arm is broken. Counting only the total would
 * hide either failure behind the noise.
 *
 * ---------------------------------------------------------------------
 * WHAT IT STILL CANNOT SEE
 *
 * A literal assigned to a variable and interpolated into a translator or
 * toast a line later. The call site holds no literal at all:
 *
 *   const reason = err instanceof Error ? err.message : "network error";
 *   toast.error(t("sendFailed", { reason }));
 *
 * Six of these hid in an inbox tree that this detector had just reported
 * on, and they were found by reading the code, not by scanning. The
 * `assigned-string` arm below catches the common shape — a prose string
 * in a ternary or `||` fallback assigned to a local — but a value routed
 * through a function or a second variable still escapes it.
 *
 * Treat an empty result as "no literal at the call site", never as "no
 * English reaches the user".
 *
 * ---------------------------------------------------------------------
 * WHAT IS FILTERED OUT, AND WHY EACH FILTER EXISTS
 *
 * Every one of these was added because it produced noise that buried the
 * real hits, not because the string is uninteresting in principle.
 *
 *   inside t(…) / t.rich(…) / useTranslations(…)
 *       Already translated. Covers the local aliases this repo uses
 *       (tStatus, tMode, tSummary, tRoles, …) — extend ALIASES if you
 *       introduce another.
 *   import / export specifiers
 *       Module paths, not copy.
 *   cn() / clsx() / cva() / twMerge()
 *       Tailwind class lists. Long, English-looking, never rendered.
 *   console.*
 *       Developer logs. Not user-visible, deliberately left in English.
 *   Supabase query builders (.select .eq .from .order .channel …)
 *       Column and table names.
 *   router.push / replace / prefetch, and template literals starting
 *   with / ? or #
 *       Routes.
 *   JSX attributes that are never copy (className, id, href, type, role,
 *   viewBox, d, …) — see SKIP_ATTRS.
 *   Object properties that carry styling or identifiers: rule, badge,
 *   cls, color, swatch, icon, path, and anything ending in `Key`.
 *       A `labelKey` is a catalogue key, not a label.
 *   Values that cannot be prose: slugs, CONSTANTS, urls, emails, hex and
 *   oklch colours, pure punctuation/number strings — see isTechnical().
 *
 * WHAT IT CANNOT SEE
 *
 *   A string assigned to a variable and interpolated somewhere else. The
 *   scan looks at literals where they are written, so `const msg = "network
 *   error"` used three functions away is reported at the assignment if it
 *   looks like prose — and missed entirely if the assignment is built up
 *   conditionally. Six of those were found by hand, not by this tool. An
 *   empty result means no literal at the call site, never that no English
 *   reaches the user.
 *
 * WHAT IT DELIBERATELY STILL REPORTS
 *
 *   Strings stored or compared rather than shown — seed values, default
 *   node config, identifiers slugified into keys. These look like copy
 *   and are NOT safe to translate: a value that is persisted or compared
 *   must not vary with the reader's locale. The detector cannot tell the
 *   difference, so it shows them and you decide.
 *
 * Output is one line per hit: line number, a kind tag saying where the
 * string sits (jsx-text / attr:title / toast / dialog / prop:label / …),
 * and the value. The kind tag is the useful part — it tells you whether
 * a human ever reads it.
 */

import ts from "typescript";
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error(
    "usage: node tools/find-untranslated.mjs <file.tsx> [more files…]",
  );
  process.exit(2);
}

/** Local names this repo gives a next-intl translator. */
const ALIASES =
  /^(t|tt|tStatus|tMode|tRoles|tSummary|tEdit|tTagline|tQuote|useTranslations)\b/;

/** JSX attributes that are never user-visible copy. */
const SKIP_ATTRS = new Set([
  "className", "class", "style", "key", "id", "href", "src", "type", "name",
  "value", "htmlFor", "role", "data-testid", "width", "height", "viewBox",
  "fill", "stroke", "d", "side", "variant", "size", "align", "autoComplete",
  "inputMode", "method", "target", "rel",
]);

/** Values that cannot be prose in any language. */
function isTechnical(s) {
  const v = s.trim();
  if (!v) return true;
  if (!/[A-Za-z]/.test(v)) return true;
  if (v.length < 2) return true;
  if (/^[a-z0-9_.:/-]+$/.test(v)) return true;      // slug, key, path
  if (/^[A-Z0-9_]+$/.test(v)) return true;          // CONSTANT
  if (/^(https?:)?\/\//.test(v)) return true;
  if (/^[\w.-]+@[\w.-]+$/.test(v)) return true;
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true;
  if (/^(oklch|rgb|hsl|var)\(/.test(v)) return true;
  if (/^[\d\s.,%+()-]+$/.test(v)) return true;
  // A Tailwind class list. Tested on EVERY token carrying a utility
  // marker (- : [ /), not merely on being lowercase: "network error" is
  // two lowercase words and an earlier version of this filter swallowed
  // it, which is the exact failure the assigned-string arm exists to
  // prevent. A filter that hides a real hit is worse than one that lets
  // a class list through.
  if (
    /\s/.test(v) &&
    v.split(/\s+/).every((t) => /^[a-z0-9]+[-:[\]/][\S]*$/.test(t))
  ) {
    return true;
  }
  return false;
}

function analyse(file) {
  const src = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const lineOf = (n) =>
    src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
  const hits = [];

  const insideTranslator = (n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p)) {
        const e = p.expression.getText(src);
        if (ALIASES.test(e) || /\.rich$/.test(e)) return true;
      }
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
    }
    return false;
  };

  const suppressed = (n) => {
    if (n.text === "use client" || n.text === "use server") return true;
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p)) {
        const e = p.expression.getText(src);
        if (/^(cn|clsx|cva|twMerge)$/.test(e)) return true;
        if (/^console\./.test(e)) return true;
        if (/\.(select|eq|neq|in|order|from|rpc|is|gte|lte|channel|on)$/.test(e))
          return true;
        if (/^(push|replace|prefetch)$/.test(e) || /router\.(push|replace)$/.test(e))
          return true;
      }
      if (ts.isPropertyAssignment(p)) {
        const k = p.name.getText(src);
        if (/^(rule|badge|cls|className|color|swatch|icon|href|path)$/.test(k))
          return true;
        if (/Key$/.test(k)) return true;
      }
      if (ts.isTemplateExpression(p) && /^[/?#]/.test(p.head.text)) return true;
    }
    return false;
  };

  const attrName = (n) => {
    const p = n.parent;
    if (ts.isJsxAttribute(p)) return p.name.getText(src);
    if (ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent))
      return p.parent.name.getText(src);
    return null;
  };

  /** Where the string sits — the tag that says whether a human reads it. */
  const kindOf = (n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p)) {
        const e = p.expression.getText(src);
        if (/^toast\./.test(e)) return "toast";
        if (/^(window\.)?(confirm|alert|prompt)$/.test(e)) return "dialog";
        if (/Error$/.test(e)) return "error";
      }
      if (ts.isPropertyAssignment(p)) return `prop:${p.name.getText(src)}`;
    }
    return "string";
  };

  const visit = (n) => {
    if (ts.isJsxText(n)) {
      const v = n.text.replace(/\s+/g, " ").trim();
      if (v && !isTechnical(v)) hits.push([lineOf(n), "jsx-text", v]);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (!insideTranslator(n) && !isTechnical(n.text) && !suppressed(n)) {
        const a = attrName(n);
        if (!(a && SKIP_ATTRS.has(a))) {
          hits.push([lineOf(n), a ? `attr:${a}` : kindOf(n), n.text]);
        }
      }
    } else if (ts.isTemplateExpression(n)) {
      const head = n.head.text.replace(/\s+/g, " ").trim();
      if (
        head &&
        !isTechnical(head) &&
        !insideTranslator(n) &&
        !/^[/?#]/.test(head)
      ) {
        hits.push([lineOf(n), "template", head + "${…}"]);
      }
    }
    // assigned-string: a prose literal handed to a local that a
    // translator or toast reads a line later. The call site holds no
    // literal, so every arm above walks past it — this is the shape that
    // hid six "network error" strings in an already-audited tree.
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const lits = [];
      const collect = (e) => {
        if (!e) return;
        if (ts.isStringLiteral(e)) lits.push(e);
        else if (ts.isConditionalExpression(e)) { collect(e.whenTrue); collect(e.whenFalse); }
        else if (ts.isBinaryExpression(e) &&
                 (e.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                  e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
          collect(e.left); collect(e.right);
        }
      };
      collect(n.initializer);
      for (const lit of lits) {
        const text = lit.text.trim();
        if (text && !isTechnical(text) && !insideTranslator(lit) && /\s/.test(text)) {
          hits.push([lineOf(lit), "assigned-string", text]);
        }
      }
    }

    ts.forEachChild(n, visit);
  };
  visit(src);
  return hits;
}

let total = 0;
for (const file of files) {
  const hits = analyse(file);
  total += hits.length;
  if (hits.length === 0) {
    console.log(`\n#### ${file} — no hits`);
    continue;
  }
  console.log(`\n#### ${file}  (${hits.length})`);
  for (const [line, kind, value] of hits) {
    console.log(
      `  ${String(line).padStart(4)}  [${kind}] ${JSON.stringify(value.slice(0, 120))}`,
    );
  }
}
console.log(`\nTotal: ${total} across ${files.length} file(s).`);
if (total === 0) {
  console.log(
    [
      "Empty result — read this before reporting the tree clean.",
      "",
      "  1. Empty means NO LITERAL AT THE CALL SITE. It does not mean no",
      "     English reaches the user. A string assigned to a variable and",
      "     interpolated later is invisible to this scan — six 'network",
      "     error' messages hid that way and were found by hand.",
      "",
      "  2. Calibrate before you believe this. An over-filtered detector",
      "     prints exactly what you are reading now.",
      "",
      "       git archive a800140^ src/components/settings | tar -x -C /tmp/bench",
      "       node tools/find-untranslated.mjs /tmp/bench/src/components/settings/*.tsx",
      "",
      "     It must surface all four classes: a toast, a window.confirm, a",
      "     title=, and a placeholder=. See the header for the exact strings.",
    ].join("\n"),
  );
}
