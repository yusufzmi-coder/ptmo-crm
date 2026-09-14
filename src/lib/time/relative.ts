/**
 * One relative-time phrase for the whole app.
 *
 * Before this there were three ways to say "3 hours ago": `date-fns`
 * `formatDistanceToNow` in the inbox and in notifications, a local
 * `relativeTime()` on the dashboard reading `Dashboard.activityFeed.time*`,
 * and a local `relativeSince()` on the ops board reading
 * `Ops.unanswered.sent*Ago`. They disagreed about the buckets, about how
 * far back they would go, and about the words.
 *
 * WHAT IS SHARED AND WHAT IS NOT
 *
 * The arithmetic is shared, because those parts have to agree: the same
 * instant must fall in the same bucket and round the same way wherever it
 * is shown.
 *
 * The wording is not, and deliberately so:
 *
 *   `terse` — "3h ago". For dense lists where the timestamp is a hint
 *   beside something else.
 *   `full` — "3 hours ago". For places where the age is the point.
 *
 * A VERB IS NOT THIS FUNCTION'S JOB. The ops board says "sent 3 hours
 * ago" because there it matters what happened at that moment, and the
 * inbox says "3 hours ago" because there it does not. That is a different
 * fact, not a different translation of the same one, so the caller wraps
 * the phrase in its own key:
 *
 *     t("sentAt", { time: relativeTime(iso, tRel, { locale }) })
 *
 * Wrapping at the call site rather than passing a verb in here also lets
 * the translator place the verb. Malay puts it first ("dihantar 3 jam
 * lalu"), Korean puts it last ("3시간 전에 발송"), and a `verb + phrase`
 * concatenation inside this function could only ever do one of those.
 *
 * PAST THIRTY DAYS the phrase stops being useful and this returns an
 * absolute date instead, formatted for the caller's locale. The ops board
 * had no such cutoff and would say "sent 400 days ago"; it now does not.
 */

export type RelativeStyle = "terse" | "full";

/** The shape `useTranslations("RelativeTime")` returns. */
type Translator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CUTOFF = 30 * DAY;

export function relativeTime(
  at: string | number | Date,
  t: Translator,
  {
    style = "full",
    locale,
    now = Date.now(),
  }: {
    style?: RelativeStyle;
    /**
     * BCP-47 tag used only for the absolute date past the cutoff. Get it
     * from next-intl's `useLocale()` so it tracks the app locale rather
     * than the browser's.
     */
    locale?: string;
    /** Injectable for tests and for boards that tick off a shared clock. */
    now?: number | Date;
  } = {},
): string {
  const then = new Date(at).getTime();
  if (Number.isNaN(then)) return "";

  const nowMs = now instanceof Date ? now.getTime() : now;
  // Clamp: a clock skew of a few seconds must not render "in 3 seconds".
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));

  if (seconds >= CUTOFF) {
    return new Date(then).toLocaleDateString(locale);
  }
  if (seconds < MINUTE) {
    return style === "terse"
      ? t("terse.seconds", { count: Math.max(1, seconds) })
      : t("full.justNow");
  }
  if (seconds < HOUR) {
    return t(`${style}.minutes`, { count: Math.floor(seconds / MINUTE) });
  }
  if (seconds < DAY) {
    return t(`${style}.hours`, { count: Math.floor(seconds / HOUR) });
  }
  return t(`${style}.days`, { count: Math.floor(seconds / DAY) });
}
