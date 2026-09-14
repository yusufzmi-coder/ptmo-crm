import { getRequestConfig } from 'next-intl/server';

/**
 * Locales that ship with a dictionary in `messages/`.
 *
 * Kept explicit rather than inferred from the filesystem: this runs on
 * every request, and a wrong answer here is invisible — see below.
 */
export const AVAILABLE = new Set(['en', 'ko', 'ms']);

const SOURCE_LOCALE = 'en';

/**
 * Resolve the app locale from the environment.
 *
 * Trimmed, deliberately. `.env.local` shipped with `NEXT_PUBLIC_APP_LOCALE=en `
 * — a trailing space — and nobody noticed for four days, because `"en "`
 * failed the dictionary import and the catch below quietly served English
 * anyway. English was expected, so the bug had no symptom.
 *
 * The day that value becomes `ms `, the same silence turns into a real
 * failure: the import fails, English is served, and the activation looks
 * like it simply did not happen. No error, no warning, 1737 translated
 * keys sitting unused while someone hunts for a bug in the catalogue.
 *
 * So: trim it, check it against the dictionaries that actually exist, and
 * say something out loud when it does not match.
 */
export function resolveLocale(): string {
  const raw = process.env.NEXT_PUBLIC_APP_LOCALE;
  const locale = raw?.trim();

  if (!locale) return SOURCE_LOCALE;
  if (AVAILABLE.has(locale)) return locale;

  // Loud on purpose. The previous version of this file fell back without
  // a word, which is what let a trailing space hide.
  console.warn(
    `[i18n] NEXT_PUBLIC_APP_LOCALE is ${JSON.stringify(raw)}, which is not ` +
      `one of ${[...AVAILABLE].join(', ')}. Serving ${SOURCE_LOCALE}.`,
  );
  return SOURCE_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = resolveLocale();

  // No try/catch: resolveLocale has already established that a dictionary
  // exists for this locale. A throw here would mean AVAILABLE has drifted
  // from the files on disk, and that should fail loudly rather than serve
  // the wrong language in silence.
  const messages = (await import(`../../messages/${locale}.json`)).default;

  return { locale, messages };
});
