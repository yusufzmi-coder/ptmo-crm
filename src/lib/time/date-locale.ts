import { ko } from "date-fns/locale/ko";
import { ms } from "date-fns/locale/ms";
import type { Locale } from "date-fns";

/**
 * Map the app locale onto a date-fns locale.
 *
 * Only reach for this where date-fns itself produces words — today that
 * is `formatDuration`. It is NOT a general fix for date rendering: see
 * `docs/working-notes/date-fns-locale-inventory.md`. Passing a locale to
 * `format(d, "MMM d, yyyy")` localises the month token and leaves the
 * English word order and comma in place, and for Malay it changes nothing
 * at all, because Malay month names are the English ones.
 *
 * Duration units are the opposite case and the reason this file exists:
 * "1 jam 1 minit" really is different from "1 hour 1 minute".
 *
 * Imported statically on purpose. Each locale is under a kilobyte
 * (`ms.js` 736 bytes, `ko.js` 869), so the async boundary a dynamic
 * import would force on synchronous components costs more than the bytes
 * it saves. The ~108K per-locale figure in `du` is the unbundled folder,
 * not what ships.
 *
 * `undefined` means date-fns's own default, which is en-US — the same
 * thing every call site got before locales were threaded through, so an
 * unknown locale degrades to exactly today's behaviour.
 */
const LOCALES: Record<string, Locale> = { ms, ko };

export function dateFnsLocale(locale?: string): Locale | undefined {
  if (!locale) return undefined;
  // Accept "ms-MY" as well as "ms": the app locale is a bare tag today,
  // but `useLocale()` would hand through a regional one unchanged.
  return LOCALES[locale] ?? LOCALES[locale.split("-")[0]];
}
