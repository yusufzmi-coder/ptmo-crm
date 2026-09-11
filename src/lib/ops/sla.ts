/**
 * Response SLA — the shared clock behind the "awaiting reply" board and
 * the First Response Time report.
 *
 * The rule the numbers encode
 * ---------------------------
 * A parent's message starts a clock. The clock runs only during the
 * hours the inbox is actually covered, and it stops the moment an agent
 * replies — not when the conversation is closed. A message that lands
 * at 3pm on a day covered until 1:30pm is not "4 hours late"; it is
 * waiting, and its clock resumes when coverage next opens.
 *
 * Two standards, because the team works two kinds of shift
 * ------------------------------------------------------
 * The morning office shift (8:30am–1:30pm) is desk time. That is where
 * "admin Minda Optima balas laju" gets earned, so it carries the sharp
 * standard: 5 minutes is the delight line, 15 the breach.
 *
 * The evening and weekend shifts are class time. Staff are in front of
 * children, and a phone answered in 5 minutes there means a lesson
 * interrupted. Holding class hours to the office standard would either
 * paint the board red every night or quietly teach staff to prioritise
 * WhatsApp over the child in front of them. Neither is the goal. So
 * class shifts carry a looser standard: 15 minutes target, 30 breach.
 *
 * Each shift is tagged with its tier in DEFAULT_COVERAGE; the
 * thresholds live in SLA_THRESHOLDS. A wait is judged by the tier of
 * the shift in which its clock first started running — a message that
 * lands during office hours is an office-standard message even if it
 * ends up answered in the evening. That is the simplest rule to explain
 * to a staff member looking at the board, and the one least open to
 * gaming.
 *
 * Within each tier the two lines do two different jobs:
 *
 *   TARGET  the delight line. Answer inside this and the parent feels
 *           attended to. This is the headline number the team chases
 *           and reports — "% answered within target" — not a
 *           disciplinary threshold.
 *   BREACH  the accountability line. Past this the parent has been left
 *           waiting during covered hours and someone owns it.
 *
 * The gap between them is deliberate: it gives the board a real amber
 * state, so "we could be faster" and "we let someone down" never look
 * the same. The board also sorts by longest wait, so a busy day is a
 * ranked worklist rather than an undifferentiated wall of red.
 *
 * Everything here is pure: no Supabase, no React, no clock of its own
 * (callers pass `now`). That keeps it testable and keeps the same
 * numbers behind the live board and the historical report.
 */

/**
 * The kind of shift a covered window belongs to. Decides which
 * thresholds a wait is judged against.
 *
 *   office  desk hours — the sharp standard
 *   class   teaching sessions — staff are with children, looser standard
 */
export type SlaTier = "office" | "class";

export interface SlaThresholds {
  /** Minutes of covered time inside which a reply still delights. */
  targetMinutes: number;
  /** Minutes of covered time at which a wait becomes a breach. */
  breachMinutes: number;
}

/** Per-tier lines. Change the numbers here; nothing else needs to move. */
export const SLA_THRESHOLDS: Record<SlaTier, SlaThresholds> = {
  office: { targetMinutes: 5, breachMinutes: 15 },
  class: { targetMinutes: 15, breachMinutes: 30 },
};

/** Office-tier lines, kept as named constants for call sites and copy. */
export const SLA_TARGET_MINUTES = SLA_THRESHOLDS.office.targetMinutes;
export const SLA_BREACH_MINUTES = SLA_THRESHOLDS.office.breachMinutes;
/** Alias for the board's amber state — same line as the target. */
export const SLA_WARNING_MINUTES = SLA_TARGET_MINUTES;

/** Where the operation is, and therefore what "9am" means. */
export const OPS_TIME_ZONE = "Asia/Kuala_Lumpur";

export type SlaState = "ok" | "warning" | "breached";

/** One covered window on one weekday, in local wall-clock minutes. */
export interface CoverageWindow {
  /** 0 = Sunday … 6 = Saturday, matching `Date.getDay()`. */
  weekday: number;
  /** Inclusive start, minutes from midnight. 8:30am = 510. */
  startMinute: number;
  /** Exclusive end, minutes from midnight. 5:30pm = 1050. */
  endMinute: number;
  /** Which standard applies while this window is open. */
  tier: SlaTier;
}

const HOUR = 60;

/** Build a window from wall-clock hours — easier to read than minutes. */
function win(
  weekday: number,
  from: string,
  to: string,
  tier: SlaTier,
): CoverageWindow {
  const parse = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * HOUR + (m || 0);
  };
  return { weekday, startMinute: parse(from), endMinute: parse(to), tier };
}

/**
 * Default coverage: the operations team's real working shifts.
 *
 * Monday to Thursday the day is split — 8:30am to 1:30pm at the office,
 * then everyone goes home and rests, then back on duty 7:30pm to 10pm.
 * Friday is an off day. The weekend runs a shorter single shift.
 *
 * The afternoon break (1:30–7:30pm) is genuinely off duty, so the clock
 * stops there. A parent who messages at 2pm is not "five hours late" at
 * 7:30pm — their wait starts counting the moment the evening shift
 * opens. Same for Friday: nobody is on the floor, nothing accrues.
 *
 * This is honest rather than flattering. A message arriving Thursday
 * night after 10pm sits frozen until Saturday, and the board will show
 * exactly that. Those frozen stretches are the coverage gap the central
 * desk exists to close — when a central admin goes live, add their
 * shift as a row here and the SLA starts counting through the gap
 * automatically. Nothing else in the codebase changes.
 */
export const DEFAULT_COVERAGE: CoverageWindow[] = [
  // Mon–Thu: split shift — office morning (sharp standard), break,
  // evening class session (class standard).
  win(1, "08:30", "13:30", "office"),
  win(1, "19:30", "22:00", "class"),
  win(2, "08:30", "13:30", "office"),
  win(2, "19:30", "22:00", "class"),
  win(3, "08:30", "13:30", "office"),
  win(3, "19:30", "22:00", "class"),
  win(4, "08:30", "13:30", "office"),
  win(4, "19:30", "22:00", "class"),
  // Friday: off day — no shift, no clock.
  // Sat/Sun: weekend teaching sessions — class standard.
  win(6, "09:00", "12:30", "class"),
  win(0, "09:00", "12:30", "class"),
];

/**
 * The weekday and minute-of-day a timestamp falls on, read in the
 * operation's own time zone rather than the server's. A container in
 * UTC and a laptop in Kuala Lumpur must agree on whether 8:45am was
 * inside coverage, so the zone is pinned rather than inherited.
 */
export function localParts(
  at: Date,
  timeZone: string = OPS_TIME_ZONE,
): { weekday: number; minuteOfDay: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(at).map((p) => [p.type, p.value]),
  );
  const days: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  // Intl renders midnight as "24" in some ICU builds — normalise to 0.
  const hour = Number(parts.hour) % 24;
  return {
    weekday: days[parts.weekday as string] ?? 0,
    minuteOfDay: hour * HOUR + Number(parts.minute),
  };
}

/** The covered window this instant falls in, or null when off duty. */
export function coverageAt(
  at: Date,
  coverage: CoverageWindow[] = DEFAULT_COVERAGE,
  timeZone: string = OPS_TIME_ZONE,
): CoverageWindow | null {
  const { weekday, minuteOfDay } = localParts(at, timeZone);
  return (
    coverage.find(
      (w) =>
        w.weekday === weekday &&
        minuteOfDay >= w.startMinute &&
        minuteOfDay < w.endMinute,
    ) ?? null
  );
}

/** Is this instant inside a covered window? */
export function isWithinCoverage(
  at: Date,
  coverage: CoverageWindow[] = DEFAULT_COVERAGE,
  timeZone: string = OPS_TIME_ZONE,
): boolean {
  return coverageAt(at, coverage, timeZone) !== null;
}

/**
 * Minutes of *covered* time between two instants — the waiting time a
 * parent actually experienced against a desk that was open.
 *
 * Walks minute by minute, which is plenty fast for the ranges this app
 * asks about (a conversation waiting a week is 10,080 steps) and is far
 * easier to reason about — and to trust — than interval arithmetic
 * across window edges, midnight and daylight boundaries.
 *
 * Returns 0 when `to` is at or before `from`, so a reply that beat the
 * inbound message (clock skew, imported rows) can never produce a
 * negative SLA.
 */
export interface WaitMeasure {
  /** Covered minutes the parent actually waited. */
  minutes: number;
  /**
   * Tier of the shift in which the clock first started running, or
   * null when no covered minute has elapsed yet (message arrived off
   * duty and the desk has not reopened).
   */
  tier: SlaTier | null;
}

export function measureWait(
  from: Date,
  to: Date,
  coverage: CoverageWindow[] = DEFAULT_COVERAGE,
  timeZone: string = OPS_TIME_ZONE,
): WaitMeasure {
  const start = from.getTime();
  const end = to.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { minutes: 0, tier: null };
  }

  const MINUTE_MS = 60_000;
  // Cap the walk at 60 days. Anything older is already so far past any
  // threshold that the exact figure carries no operational meaning, and
  // the cap keeps a bad timestamp from spinning the page.
  const CAP_MINUTES = 60 * 24 * 60;

  let covered = 0;
  let tier: SlaTier | null = null;
  let steps = 0;
  for (let t = start; t < end && steps < CAP_MINUTES; t += MINUTE_MS, steps++) {
    const window = coverageAt(new Date(t), coverage, timeZone);
    if (!window) continue;
    covered++;
    if (tier === null) tier = window.tier;
  }
  return { minutes: covered, tier };
}

/** Covered minutes only — see {@link measureWait} for the tier too. */
export function coveredMinutesBetween(
  from: Date,
  to: Date,
  coverage: CoverageWindow[] = DEFAULT_COVERAGE,
  timeZone: string = OPS_TIME_ZONE,
): number {
  return measureWait(from, to, coverage, timeZone).minutes;
}

/**
 * Classify a wait against its tier's lines. `waitedMinutes` is covered
 * time from {@link measureWait}; `tier` is the shift the clock started
 * in. A null tier (no covered minute yet) is judged by the office lines
 * — with zero minutes it is "ok" either way, so this only matters as a
 * conservative default for callers that pass minutes from elsewhere.
 *
 *   "ok"       answered inside the tier's target
 *   "warning"  past the target, before the breach
 *   "breached" left waiting during covered hours
 */
export function slaState(
  waitedMinutes: number,
  tier: SlaTier | null = "office",
): SlaState {
  const lines = SLA_THRESHOLDS[tier ?? "office"];
  if (waitedMinutes >= lines.breachMinutes) return "breached";
  if (waitedMinutes >= lines.targetMinutes) return "warning";
  return "ok";
}

/** "just now" / "12m" / "3h 05m" / "2d 4h" — compact enough for a table cell. */
export function formatWait(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  const rem = m % 60;
  if (hours < 24) return `${hours}h ${String(rem).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
