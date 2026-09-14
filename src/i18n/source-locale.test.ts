import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the one i18n defect the other two checks cannot see: a value in
 * the SOURCE locale that is not in the source language.
 *
 * Three keys in en.json held "Belum Dibalas" — Malay — and the live
 * domain served it to every English visitor for eight rounds of i18n
 * work. Neither existing guard could have caught it:
 *
 *   messages.test.ts counts KEYS. Both locales had the key, so parity
 *   was satisfied and the value was never read.
 *
 *   tools/find-untranslated.mjs looks for English OUTSIDE the catalogue.
 *   This is the opposite shape — English MISSING from inside it.
 *
 * Two detectors, both correct, both blind to the same class.
 *
 * ---------------------------------------------------------------------
 * WHAT WAS CONSIDERED AND REJECTED
 *
 * Three cheaper checks were measured against the real catalogue first.
 * All three were rejected on false-positive rate, and the numbers are
 * recorded here so nobody re-proposes them:
 *
 *   "en value contains a non-ASCII character" — 30 hits, every one
 *   legitimate: → in "View all →", ✨ in the AI hint, ® in WhatsApp®,
 *   · as a separator, and em-dashes throughout. Typography is not a
 *   foreign language.
 *
 *   "en value equals the ms value" — 66 hits. Most are words English
 *   and Malay share: Dashboard, Inbox, Admin, Video, Status, Beta.
 *
 *   "...and is more than one word" — narrows it to 12, but 8 of those
 *   are still legitimate: JSON examples in placeholders, Meta's API
 *   terms ("WhatsApp Business Account ID"), the product name in
 *   Sidebar.title, and a deliberately Malay example name.
 *
 * A test with a growing exception list is a test people learn to add
 * exceptions to rather than fix. Both checks below sit at zero on the
 * current catalogue, so any failure means something.
 */

const MESSAGES_DIR = join(process.cwd(), 'messages');

/**
 * Malay function words. Deliberately NOT nouns — Malay borrows English
 * nouns freely ("email", "status", "video"), so a shared noun says
 * nothing. Function words are not borrowed, which is what makes them a
 * reliable signal that a whole phrase is Malay.
 */
const MALAY_FUNCTION_WORDS = new Set([
  'adalah', 'akan', 'anda', 'atau', 'belum', 'bila', 'boleh', 'dalam',
  'dapat', 'daripada', 'dengan', 'gagal', 'hanya', 'ialah', 'ini', 'itu',
  'jangan', 'jika', 'juga', 'kami', 'kepada', 'kerana', 'kita', 'lagi',
  'masih', 'mereka', 'nama', 'oleh', 'pada', 'perlu', 'ralat', 'saya',
  'sedang', 'semua', 'setiap', 'sila', 'sudah', 'telah', 'tetapi',
  'tiada', 'tidak', 'untuk', 'yang',
]);

/**
 * Writing systems that cannot appear in English prose. Scoped to script
 * blocks — Hangul, CJK, Arabic, Cyrillic, Devanagari, Thai — rather than
 * "non-ASCII", which is what made the rejected check above useless.
 */
const FOREIGN_SCRIPT =
  /[ᄀ-ᇿ぀-ヿ㐀-䶿一-鿿가-힯؀-ۿЀ-ӿऀ-ॿ฀-๿]/;

function flatten(locale: string): Map<string, string> {
  const raw = readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8');
  const out = new Map<string, string>();
  const walk = (node: unknown, path: string) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    if (typeof node === 'string') out.set(path, node);
  };
  walk(JSON.parse(raw), '');
  return out;
}

function malayWordsIn(value: string): string[] {
  const words = new Set(value.toLowerCase().match(/[a-z]+/g) ?? []);
  return [...words].filter((w) => MALAY_FUNCTION_WORDS.has(w)).sort();
}

describe('en.json is written in English', () => {
  const source = flatten('en');

  it('holds no Malay function words', () => {
    const offenders = [...source]
      .map(([key, value]) => [key, value, malayWordsIn(value)] as const)
      .filter(([, , found]) => found.length > 0)
      .map(([key, value, found]) => `${key} = ${JSON.stringify(value)} — ${found.join(', ')}`);

    expect(offenders, 'en.json values that read as Malay').toEqual([]);
  });

  it('holds no text in a non-Latin writing system', () => {
    const offenders = [...source]
      .filter(([, value]) => FOREIGN_SCRIPT.test(value))
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);

    expect(offenders, 'en.json values in a foreign script').toEqual([]);
  });
});

/**
 * The detectors themselves, checked against known input.
 *
 * An empty offender list means either a clean catalogue or a broken
 * matcher, and nothing in the result distinguishes the two. Every
 * calibration this week that was skipped produced a confident wrong
 * answer, so the calibration lives in the suite rather than in a
 * comment telling someone to go and do it.
 */
describe('the detectors actually detect', () => {
  it('flags the Malay strings this test was written for', () => {
    expect(malayWordsIn('Belum Dibalas')).toEqual(['belum']);
    expect(malayWordsIn('Tiada perbualan dijumpai')).toEqual(['tiada']);
    expect(malayWordsIn('Sila cuba lagi')).toEqual(['lagi', 'sila']);
  });

  it('leaves real English prose from the catalogue alone', () => {
    for (const phrase of [
      'No customer messages',
      'Failed to send template',
      "Read-only — your role can't send messages",
      'Pending Deletion',
      'WhatsApp Business Account ID',
      'name / email / company',
    ]) {
      expect(malayWordsIn(phrase), phrase).toEqual([]);
    }
  });

  it('flags a foreign script, using a real value from ko.json', () => {
    const korean = [...flatten('ko').values()].find((v) => FOREIGN_SCRIPT.test(v));
    expect(korean, 'ko.json should contain Hangul').toBeDefined();
    expect(FOREIGN_SCRIPT.test(korean as string)).toBe(true);
  });

  it('does not mistake English typography for a foreign script', () => {
    // The rejected "non-ASCII" check failed on every one of these.
    for (const phrase of ['View all →', 'WhatsApp® is not connected', 'Preview · first 5', 'a — b']) {
      expect(FOREIGN_SCRIPT.test(phrase), phrase).toBe(false);
    }
  });
});
