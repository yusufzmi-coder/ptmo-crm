import { formatDuration, intervalToDuration } from "date-fns";

import { dateFnsLocale } from "./date-locale";

/**
 * How long something took — the span between two timestamps.
 *
 * Not to be confused with `relativeTime()` next door, which answers "how
 * long ago". The flow run list confused exactly those two: it rendered
 * `formatDistanceToNow(ended_at)` inside "ran for {duration}", so a run
 * that finished yesterday in two seconds reported "ran for 1 day". The
 * distinction is the whole point of this file existing separately.
 *
 * Returns `null` when there is nothing to say — no end yet, or an
 * unparseable timestamp — so the caller can omit the line rather than
 * print an empty one.
 */

/** Largest first. `formatDuration` keeps this order in its output. */
const UNITS = [
  "years",
  "months",
  "days",
  "hours",
  "minutes",
  "seconds",
] as const;

export function formatRunDuration(
  startedAt: string | number | Date,
  endedAt: string | number | Date | null | undefined,
  {
    locale,
    underASecond,
    maxUnits = 2,
  }: {
    /** App locale, e.g. from next-intl's `useLocale()`. */
    locale?: string;
    /**
     * What to say for a run too short to have a unit. Required, because
     * `formatDuration` returns an EMPTY STRING for a zero duration, which
     * would render "ran for " with nothing after it.
     */
    underASecond: string;
    /** Trim to the largest N non-zero units. "1 hour 1 minute", not
     * "1 hour 1 minute 40 seconds", which is more precision than a run
     * list can use. */
    maxUnits?: number;
  },
): string | null {
  if (endedAt === null || endedAt === undefined) return null;

  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  // Clamp rather than report a negative span. The two timestamps are
  // written by different processes, so a run can legitimately record an
  // end a few milliseconds before its start; "ran for -2 seconds" would
  // be a worse lie than "under a second".
  const elapsed = Math.max(0, end - start);
  if (elapsed < 1000) return underASecond;

  const duration = intervalToDuration({ start: 0, end: elapsed });
  const present = UNITS.filter((unit) => (duration[unit] ?? 0) > 0);
  const text = formatDuration(duration, {
    format: [...present.slice(0, maxUnits)],
    locale: dateFnsLocale(locale),
  });

  // Belt and braces: if date-fns ever returns nothing for a span we
  // believed was over a second, say the honest thing rather than render
  // a dangling label.
  return text || underASecond;
}
