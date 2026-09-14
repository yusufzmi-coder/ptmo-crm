import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  parse,
  TYPE,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser';

// messages.test.ts proves every key is PRESENT in every locale. It does not
// prove any of them can be FORMATTED. A message with an unbalanced brace or
// a placeholder the translator renamed still passes that test, then renders
// as its own keypath — "Inbox.conversationList.filterOpen" — in front of a
// user. With three locales that surface is three times what it was.
//
// The parser below is the one next-intl formats with internally, reached
// through its own dependency rather than declared here. If that ever stops
// resolving this file fails loudly at import, which is the failure mode we
// want; it cannot pass vacuously.

const MESSAGES_DIR = join(process.cwd(), 'messages');
const SOURCE_LOCALE = 'en';
const LOCALES = ['en', 'ko', 'ms'];

type Catalogue = Record<string, string>;

function load(locale: string): Catalogue {
  const raw = JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8'));
  const out: Catalogue = {};
  const walk = (node: unknown, path: string) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    if (typeof node === 'string') out[path] = node;
  };
  walk(raw, '');
  return out;
}

const catalogues = Object.fromEntries(LOCALES.map((l) => [l, load(l)])) as Record<
  string,
  Catalogue
>;

/**
 * What kind of value an argument needs, so we can supply a real one.
 *
 * `rendered` says whether the value reaches the screen. A plural or select
 * argument whose branches never print it — {count, plural, one {is} other
 * {are}} — is doing grammar, not carrying information, and a language that
 * does not make that distinction is right to drop it. One that prints `#`,
 * or appears as a plain {arg} as well, is information and must survive.
 */
type ArgKind = { rendered: boolean } & (
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'date' }
  | { kind: 'tag' }
  | { kind: 'select'; option: string }
);

/** Does any branch of this plural/select actually print its own value? */
function printsValue(nodes: MessageFormatElement[]): boolean {
  return nodes.some((node) => {
    if (node.type === TYPE.pound) return true;
    if (node.type === TYPE.tag) return printsValue(node.children);
    if (node.type === TYPE.plural || node.type === TYPE.select) {
      return Object.values(node.options).some((o) => printsValue(o.value));
    }
    return false;
  });
}

/**
 * Walk the AST and collect every argument with the type it actually needs.
 *
 * Guessing a fixed set of variable names instead of reading them off the
 * message is the trap here: a message wanting `names` or `errorCount` throws
 * because nothing was supplied, and the test reports a healthy string as
 * broken. A test that shouts about correct messages is worse than no test —
 * people learn to ignore it.
 */
function collectArgs(
  nodes: MessageFormatElement[],
  out = new Map<string, ArgKind>(),
): Map<string, ArgKind> {
  // An argument can appear twice — "{count} unread {count, plural, …}" — so
  // `rendered` is sticky: once anything prints it, it stays information.
  const mark = (name: string, spec: ArgKind) => {
    const prev = out.get(name);
    out.set(name, { ...spec, rendered: spec.rendered || (prev?.rendered ?? false) });
  };

  for (const node of nodes) {
    switch (node.type) {
      case TYPE.argument:
        mark(node.value, { kind: 'string', rendered: true });
        break;
      case TYPE.number:
        mark(node.value, { kind: 'number', rendered: true });
        break;
      case TYPE.date:
      case TYPE.time:
        mark(node.value, { kind: 'date', rendered: true });
        break;
      case TYPE.plural: {
        const branches = Object.values(node.options);
        mark(node.value, {
          kind: 'number',
          rendered: branches.some((o) => printsValue(o.value)),
        });
        for (const opt of branches) collectArgs(opt.value, out);
        break;
      }
      case TYPE.select: {
        // Must be a value the message actually branches on, or ICU falls
        // through to `other` — or throws when there is no `other`.
        const option = Object.keys(node.options).find((o) => o !== 'other');
        const branches = Object.values(node.options);
        mark(node.value, {
          kind: 'select',
          option: option ?? 'other',
          rendered: branches.some((o) => printsValue(o.value)),
        });
        for (const opt of branches) collectArgs(opt.value, out);
        break;
      }
      case TYPE.tag:
        mark(node.value, { kind: 'tag', rendered: true });
        collectArgs(node.children, out);
        break;
      default:
        break;
    }
  }
  return out;
}

function valuesFor(args: Map<string, ArgKind>, count: number) {
  const values: Record<string, unknown> = {};
  for (const [name, spec] of args) {
    switch (spec.kind) {
      case 'number':
        values[name] = count;
        break;
      case 'date':
        values[name] = new Date(0);
        break;
      case 'tag':
        values[name] = (chunks: unknown) => chunks;
        break;
      case 'select':
        values[name] = spec.option;
        break;
      default:
        values[name] = 'x';
    }
  }
  return values;
}

function parsed(text: string): MessageFormatElement[] | null {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/**
 * Rich-text tag names, read with a regex rather than from the AST on
 * purpose: a tag carrying attributes — <strong class="text-foreground"> —
 * makes the ICU parser throw INVALID_TAG, so the AST is unavailable for
 * exactly the strings that lean hardest on tags. A pattern matching only
 * bare <tag> would skip them silently and report a clean run.
 */
function tagNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)(\s[^>]*)?>/g)) out.add(m[1]!);
  return out;
}

const sourceKeys = Object.keys(catalogues[SOURCE_LOCALE]!);

/**
 * Keys whose source is deliberately NOT an ICU message — WhatsApp's literal
 * {{1}} placeholder syntax, and the raw-HTML setup steps. They are read with
 * t.raw() / t.rich(); icu-safety.test.ts is what holds that line. Claiming
 * them as ICU here would fail the source locale itself.
 */
const nonIcuKeys = sourceKeys.filter((k) => parsed(catalogues[SOURCE_LOCALE]![k]!) === null);

describe('ICU messages format in every locale', () => {
  it('covers the whole catalogue', () => {
    // Guard the guard. If the catalogue walk ever breaks, every test below
    // iterates an empty list and passes without checking anything.
    expect(sourceKeys.length).toBeGreaterThan(1000);
    for (const locale of LOCALES) {
      expect(Object.keys(catalogues[locale]!).length, `${locale}.json`).toBe(
        sourceKeys.length,
      );
    }
  });

  it('the non-ICU set is the same in every locale', () => {
    // If a translation quietly turns a raw-HTML string into something that
    // parses (or vice versa), the t.raw() call site silently changes meaning.
    expect(nonIcuKeys.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      const here = sourceKeys.filter((k) => parsed(catalogues[locale]![k]!) === null);
      expect(here.sort(), `${locale}.json disagrees with ${SOURCE_LOCALE} on which keys are ICU`)
        .toEqual([...nonIcuKeys].sort());
    }
  });

  it.each(LOCALES)('%s.json formats every ICU message', (locale) => {
    const failures: string[] = [];

    for (const key of sourceKeys) {
      if (nonIcuKeys.includes(key)) continue;

      const text = catalogues[locale]![key]!;
      const ast = parsed(text);
      if (ast === null) {
        failures.push(`${key} — does not parse (it parses in ${SOURCE_LOCALE})\n    ${text}`);
        continue;
      }

      const args = collectArgs(ast);
      // 0/1/2/5 reaches zero, one, few and other across the CLDR plural
      // rules any of these locales use, so every branch is exercised.
      for (const count of [0, 1, 2, 5]) {
        let code = '';
        const t = createTranslator({
          locale,
          messages: { [key]: text } as never,
          onError: (err) => {
            code = err.code;
          },
        });
        // Format through next-intl, not the formatter directly: this is the
        // path the app actually takes, so a failure here is a real one.
        t(key as never, valuesFor(args, count) as never);
        if (code === 'INVALID_MESSAGE') {
          failures.push(`${key} — ${code} at count=${count}\n    ${text}`);
          break;
        }
      }
    }

    expect(failures.sort(), `these render as their own keypath at runtime`).toEqual([]);
  });
});

describe('translations keep the information the source carries', () => {
  it.each(LOCALES.filter((l) => l !== SOURCE_LOCALE))(
    '%s.json uses the same placeholder names',
    (locale) => {
      const mismatches: string[] = [];

      for (const key of sourceKeys) {
        // Skipped for the non-ICU set: their braces are literal text, not
        // arguments, so there is nothing to compare.
        if (nonIcuKeys.includes(key)) continue;

        const source = parsed(catalogues[SOURCE_LOCALE]![key]!);
        const target = parsed(catalogues[locale]![key]!);
        if (!source || !target) continue; // reported by the format test

        // Only arguments the source actually prints. A grammar-only
        // selector is allowed to disappear: Korean has no is/are to choose
        // between, so collapsing that plural is the correct translation,
        // not a defect - and a test that called it one would be teaching
        // people to ignore it.
        const rendered = (m: Map<string, ArgKind>) =>
          [...m]
            .filter(([, v]) => v.rendered)
            .map(([name]) => name)
            .sort();

        const a = rendered(collectArgs(source));
        const b = rendered(collectArgs(target));
        if (a.join(' ') !== b.join(' ')) {
          // A dropped placeholder loses information silently — the sentence
          // still reads, it just no longer says which branch or how many.
          mismatches.push(`${key}\n    ${SOURCE_LOCALE}: {${a}}\n    ${locale}: {${b}}`);
        }
      }

      expect(mismatches.sort()).toEqual([]);
    },
  );

  it.each(LOCALES.filter((l) => l !== SOURCE_LOCALE))(
    '%s.json uses the same rich-text tags',
    (locale) => {
      const mismatches: string[] = [];

      for (const key of sourceKeys) {
        const a = [...tagNames(catalogues[SOURCE_LOCALE]![key]!)].sort();
        const b = [...tagNames(catalogues[locale]![key]!)].sort();
        if (a.join(' ') !== b.join(' ')) {
          // A renamed tag means the handler at the call site never fires:
          // t.rich() leaves the chunk unrendered.
          mismatches.push(`${key}\n    ${SOURCE_LOCALE}: <${a}>\n    ${locale}: <${b}>`);
        }
      }

      expect(mismatches.sort()).toEqual([]);
    },
  );

  it('the tag check actually sees attribute-carrying tags', () => {
    // Guard the guard. The setup-step strings carry <strong class="…">, and
    // a pattern matching only bare <tag> would find nothing in them and
    // report a clean run over the whole catalogue.
    const withAttrs = sourceKeys.filter((k) =>
      /<[A-Za-z][A-Za-z0-9]*\s[^>]*>/.test(catalogues[SOURCE_LOCALE]![k]!),
    );
    expect(withAttrs.length).toBeGreaterThan(0);
    for (const key of withAttrs) {
      expect(tagNames(catalogues[SOURCE_LOCALE]![key]!).size).toBeGreaterThan(0);
    }
  });
});
