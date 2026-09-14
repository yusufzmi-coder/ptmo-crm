import { describe, expect, it } from "vitest";

import { formatRunDuration } from "./duration";

const UNDER = "under-a-second";
const START = "2026-09-14T12:00:00.000Z";

/** `start` plus N milliseconds, as an ISO string. */
const after = (msAfter: number) =>
  new Date(new Date(START).getTime() + msAfter).toISOString();

describe("formatRunDuration — the span, not the distance from now", () => {
  it("measures end minus start, ignoring how long ago that was", () => {
    // The bug this replaced: a two-second run that finished long ago
    // reported the age of the run, not its length. START is in the past
    // relative to nothing in particular — the answer must not depend on
    // when the test runs.
    expect(formatRunDuration(START, after(2000), { underASecond: UNDER })).toBe(
      "2 seconds",
    );
  });

  it("crosses minute and hour boundaries", () => {
    expect(formatRunDuration(START, after(60_000), { underASecond: UNDER })).toBe(
      "1 minute",
    );
    expect(
      formatRunDuration(START, after(3_600_000), { underASecond: UNDER }),
    ).toBe("1 hour");
  });

  it("trims to the two largest units", () => {
    // 1h 1m 40s: the seconds are noise once hours are on screen.
    expect(
      formatRunDuration(START, after(3_700_000), { underASecond: UNDER }),
    ).toBe("1 hour 1 minute");
  });

  it("honours a different unit budget", () => {
    expect(
      formatRunDuration(START, after(3_700_000), {
        underASecond: UNDER,
        maxUnits: 3,
      }),
    ).toBe("1 hour 1 minute 40 seconds");
  });

  it("skips units that are zero rather than padding them", () => {
    // 1h 0m 40s must read "1 hour 40 seconds", not "1 hour 0 minutes".
    expect(
      formatRunDuration(START, after(3_640_000), { underASecond: UNDER }),
    ).toBe("1 hour 40 seconds");
  });
});

describe("formatRunDuration — the edges that render badly", () => {
  it("never returns an empty string for a sub-second run", () => {
    // date-fns formatDuration gives "" for a zero duration, which would
    // render "ran for " with a dangling label.
    expect(formatRunDuration(START, after(0), { underASecond: UNDER })).toBe(
      UNDER,
    );
    expect(formatRunDuration(START, after(200), { underASecond: UNDER })).toBe(
      UNDER,
    );
    expect(formatRunDuration(START, after(999), { underASecond: UNDER })).toBe(
      UNDER,
    );
  });

  it("clamps an end before the start instead of going negative", () => {
    // The two timestamps are written by different processes, so a small
    // inversion is possible. "ran for -2 seconds" is worse than "under a
    // second".
    expect(formatRunDuration(START, after(-2000), { underASecond: UNDER })).toBe(
      UNDER,
    );
  });

  it("returns null while the run is still going", () => {
    // Caller omits the line entirely — "ran for" makes no sense for
    // something that has not finished.
    expect(formatRunDuration(START, null, { underASecond: UNDER })).toBeNull();
    expect(
      formatRunDuration(START, undefined, { underASecond: UNDER }),
    ).toBeNull();
  });

  it("returns null for an unparseable timestamp", () => {
    expect(
      formatRunDuration("not a date", after(2000), { underASecond: UNDER }),
    ).toBeNull();
    expect(
      formatRunDuration(START, "not a date", { underASecond: UNDER }),
    ).toBeNull();
  });
});

describe("formatRunDuration — locale", () => {
  it("translates the unit words, unlike month names", () => {
    // This is the case where threading a date-fns locale actually earns
    // its keep: Malay month names are the English ones, but Malay
    // duration units are not.
    expect(
      formatRunDuration(START, after(90_000), {
        underASecond: UNDER,
        locale: "ms",
      }),
    ).toBe("1 minit 30 saat");
    expect(
      formatRunDuration(START, after(90_000), {
        underASecond: UNDER,
        locale: "ko",
      }),
    ).toBe("1분 30초");
  });

  it("accepts a regional tag and falls back to English for an unknown one", () => {
    expect(
      formatRunDuration(START, after(60_000), {
        underASecond: UNDER,
        locale: "ms-MY",
      }),
    ).toBe("1 minit");
    expect(
      formatRunDuration(START, after(60_000), {
        underASecond: UNDER,
        locale: "fr",
      }),
    ).toBe("1 minute");
  });
});
