import { describe, expect, it } from "vitest";
import {
  DEFAULT_COVERAGE,
  SLA_BREACH_MINUTES,
  SLA_TARGET_MINUTES,
  SLA_THRESHOLDS,
  coverageAt,
  coveredMinutesBetween,
  formatWait,
  isWithinCoverage,
  localParts,
  measureWait,
  slaState,
} from "./sla";

// All fixtures are UTC instants; Malaysia is UTC+8 with no DST, so
// 02:00Z is 10:00 in Kuala Lumpur.
const utc = (iso: string) => new Date(iso);

describe("localParts", () => {
  it("reads the weekday and time in Malaysian local time, not UTC", () => {
    // Mon 2026-09-07 02:00Z === Mon 10:00 MYT
    expect(localParts(utc("2026-09-07T02:00:00Z"))).toEqual({
      weekday: 1,
      minuteOfDay: 10 * 60,
    });
  });

  it("rolls into the next local day when UTC is still on the previous one", () => {
    // Sun 2026-09-06 17:00Z === Mon 01:00 MYT
    expect(localParts(utc("2026-09-06T17:00:00Z"))).toEqual({
      weekday: 1,
      minuteOfDay: 60,
    });
  });
});

describe("isWithinCoverage", () => {
  it("is open mid-morning on a weekday", () => {
    expect(isWithinCoverage(utc("2026-09-07T02:00:00Z"))).toBe(true); // Mon 10:00
  });

  it("is open during the weekday evening shift", () => {
    expect(isWithinCoverage(utc("2026-09-07T13:00:00Z"))).toBe(true); // Mon 21:00
  });

  it("is closed during the afternoon break — staff are off duty", () => {
    expect(isWithinCoverage(utc("2026-09-07T07:00:00Z"))).toBe(false); // Mon 15:00
    expect(isWithinCoverage(utc("2026-09-07T11:00:00Z"))).toBe(false); // Mon 19:00
  });

  it("is closed on Friday — off day", () => {
    expect(isWithinCoverage(utc("2026-09-11T03:00:00Z"))).toBe(false); // Fri 11:00
    expect(isWithinCoverage(utc("2026-09-11T13:00:00Z"))).toBe(false); // Fri 21:00
  });

  it("is open on the weekend morning shift only", () => {
    expect(isWithinCoverage(utc("2026-09-05T02:00:00Z"))).toBe(true); // Sat 10:00
    expect(isWithinCoverage(utc("2026-09-06T02:00:00Z"))).toBe(true); // Sun 10:00
    expect(isWithinCoverage(utc("2026-09-05T06:00:00Z"))).toBe(false); // Sat 14:00
  });

  it("closes the morning shift at 1:30pm sharp (end minute is exclusive)", () => {
    expect(isWithinCoverage(utc("2026-09-07T05:30:00Z"))).toBe(false); // Mon 13:30
    expect(isWithinCoverage(utc("2026-09-07T05:29:00Z"))).toBe(true); // Mon 13:29
  });

  it("opens at 8:30am sharp", () => {
    expect(isWithinCoverage(utc("2026-09-07T00:29:00Z"))).toBe(false); // Mon 08:29
    expect(isWithinCoverage(utc("2026-09-07T00:30:00Z"))).toBe(true); // Mon 08:30
  });
});

describe("coveredMinutesBetween", () => {
  it("counts plain minutes inside one open window", () => {
    // Mon 10:00 -> 10:25 MYT
    expect(
      coveredMinutesBetween(
        utc("2026-09-07T02:00:00Z"),
        utc("2026-09-07T02:25:00Z"),
      ),
    ).toBe(25);
  });

  it("does not run the clock during the afternoon break", () => {
    // Mon 14:00 -> 16:00 MYT, entirely inside the 1:30–7:30pm break
    expect(
      coveredMinutesBetween(
        utc("2026-09-07T06:00:00Z"),
        utc("2026-09-07T08:00:00Z"),
      ),
    ).toBe(0);
  });

  it("does not run the clock late at night after the evening shift", () => {
    // Mon 22:30 -> Tue 07:00 MYT, after 10pm and before 8:30am
    expect(
      coveredMinutesBetween(
        utc("2026-09-07T14:30:00Z"),
        utc("2026-09-07T23:00:00Z"),
      ),
    ).toBe(0);
  });

  it("pauses overnight and resumes when the office reopens", () => {
    // Mon 21:50 MYT (10 min left in the evening shift) -> Tue 08:40 MYT
    // (10 min into the office shift) = 20. Nothing accrues 10pm–8:30am.
    expect(
      coveredMinutesBetween(
        utc("2026-09-07T13:50:00Z"),
        utc("2026-09-08T00:40:00Z"),
      ),
    ).toBe(20);
  });

  it("counts both halves of a split-shift day", () => {
    // Mon 13:00 MYT -> Tue 08:40 MYT:
    //   30 (13:00–13:30) + 150 (19:30–22:00) + 10 (08:30–08:40) = 190
    expect(
      coveredMinutesBetween(
        utc("2026-09-07T05:00:00Z"),
        utc("2026-09-08T00:40:00Z"),
      ),
    ).toBe(190);
  });

  it("pauses through the afternoon break and resumes in the evening", () => {
    // Mon 13:20 MYT (10 min left) -> Mon 19:35 MYT (5 min in) = 15
    expect(
      coveredMinutesBetween(
        utc("2026-09-07T05:20:00Z"),
        utc("2026-09-07T11:35:00Z"),
      ),
    ).toBe(15);
  });

  it("freezes across the Friday off day", () => {
    // Thu 22:00 MYT (shift just ended) -> Sat 09:10 MYT = 10 covered
    // minutes. Friday contributes nothing.
    expect(
      coveredMinutesBetween(
        utc("2026-09-10T14:00:00Z"),
        utc("2026-09-12T01:10:00Z"),
      ),
    ).toBe(10);
  });

  it("returns 0 when the reply precedes the message", () => {
    expect(
      coveredMinutesBetween(
        utc("2026-09-07T02:25:00Z"),
        utc("2026-09-07T02:00:00Z"),
      ),
    ).toBe(0);
  });

  it("honours a custom coverage roster", () => {
    const alwaysOpen = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      startMinute: 0,
      endMinute: 24 * 60,
      tier: "office" as const,
    }));
    expect(
      coveredMinutesBetween(
        utc("2026-09-07T10:00:00Z"),
        utc("2026-09-07T12:00:00Z"),
        alwaysOpen,
      ),
    ).toBe(120);
  });

  it("never returns a negative or non-finite result for junk input", () => {
    expect(
      coveredMinutesBetween(new Date("nonsense"), utc("2026-09-07T02:00:00Z")),
    ).toBe(0);
  });
});

describe("slaState — office tier (default)", () => {
  it("is ok while the reply is still fast enough to impress", () => {
    expect(slaState(0)).toBe("ok");
    expect(slaState(SLA_TARGET_MINUTES - 1)).toBe("ok");
  });

  it("warns once past the 5-minute target but before the breach", () => {
    expect(slaState(SLA_TARGET_MINUTES)).toBe("warning");
    expect(slaState(SLA_BREACH_MINUTES - 1)).toBe("warning");
  });

  it("breaches at 15 minutes of covered waiting", () => {
    expect(slaState(SLA_BREACH_MINUTES)).toBe("breached");
    expect(slaState(240)).toBe("breached");
  });

  it("treats a null tier as office — the conservative default", () => {
    expect(slaState(SLA_TARGET_MINUTES, null)).toBe("warning");
  });
});

describe("slaState — class tier", () => {
  const { targetMinutes, breachMinutes } = SLA_THRESHOLDS.class;

  it("is looser than the office standard on both lines", () => {
    expect(targetMinutes).toBeGreaterThan(SLA_THRESHOLDS.office.targetMinutes);
    expect(breachMinutes).toBeGreaterThan(SLA_THRESHOLDS.office.breachMinutes);
  });

  it("stays ok where the office tier would already be breached", () => {
    // 10 minutes: breached-adjacent for office, comfortably ok in class.
    expect(slaState(10, "office")).toBe("warning");
    expect(slaState(10, "class")).toBe("ok");
  });

  it("warns from the class target and breaches at the class line", () => {
    expect(slaState(targetMinutes - 1, "class")).toBe("ok");
    expect(slaState(targetMinutes, "class")).toBe("warning");
    expect(slaState(breachMinutes - 1, "class")).toBe("warning");
    expect(slaState(breachMinutes, "class")).toBe("breached");
  });

  it("keeps target strictly below breach in every tier so amber exists", () => {
    for (const lines of Object.values(SLA_THRESHOLDS)) {
      expect(lines.targetMinutes).toBeLessThan(lines.breachMinutes);
    }
  });
});

describe("coverageAt / measureWait — which tier a wait belongs to", () => {
  it("tags office mornings and class evenings", () => {
    expect(coverageAt(utc("2026-09-07T02:00:00Z"))?.tier).toBe("office"); // Mon 10:00
    expect(coverageAt(utc("2026-09-07T13:00:00Z"))?.tier).toBe("class"); // Mon 21:00
    expect(coverageAt(utc("2026-09-05T02:00:00Z"))?.tier).toBe("class"); // Sat 10:00
    expect(coverageAt(utc("2026-09-07T07:00:00Z"))).toBeNull(); // Mon 15:00 break
  });

  it("judges a wait by the shift its clock started in", () => {
    // Message Mon 09:00 (office) -> reply 09:09: office tier, 9 min = warning
    const office = measureWait(
      utc("2026-09-07T01:00:00Z"),
      utc("2026-09-07T01:09:00Z"),
    );
    expect(office).toEqual({ minutes: 9, tier: "office" });
    expect(slaState(office.minutes, office.tier)).toBe("warning");

    // Message Mon 20:00 (class) -> reply 20:09: class tier, 9 min = ok
    const cls = measureWait(
      utc("2026-09-07T12:00:00Z"),
      utc("2026-09-07T12:09:00Z"),
    );
    expect(cls).toEqual({ minutes: 9, tier: "class" });
    expect(slaState(cls.minutes, cls.tier)).toBe("ok");
  });

  it("uses the tier where the clock STARTED, even if answered in another shift", () => {
    // Mon 13:27 office (3 min) -> answered Mon 19:34 class (4 min) = 7 min,
    // office tier because that is where the wait began → warning.
    const m = measureWait(
      utc("2026-09-07T05:27:00Z"),
      utc("2026-09-07T11:34:00Z"),
    );
    expect(m).toEqual({ minutes: 7, tier: "office" });
    expect(slaState(m.minutes, m.tier)).toBe("warning");
  });

  it("gives a message that lands in the break the tier of the next shift", () => {
    // Mon 15:00 (off duty) -> reply Mon 19:40: clock starts 19:30 = class
    const m = measureWait(
      utc("2026-09-07T07:00:00Z"),
      utc("2026-09-07T11:40:00Z"),
    );
    expect(m).toEqual({ minutes: 10, tier: "class" });
    expect(slaState(m.minutes, m.tier)).toBe("ok");
  });

  it("has no tier while the desk has not reopened", () => {
    // Mon 15:00 -> Mon 16:00, still in the break
    expect(
      measureWait(utc("2026-09-07T07:00:00Z"), utc("2026-09-07T08:00:00Z")),
    ).toEqual({ minutes: 0, tier: null });
  });
});

describe("formatWait", () => {
  it("renders the ranges a queue actually shows", () => {
    expect(formatWait(0)).toBe("just now");
    expect(formatWait(12)).toBe("12m");
    expect(formatWait(185)).toBe("3h 05m");
    expect(formatWait(60 * 52)).toBe("2d 4h");
  });
});

describe("DEFAULT_COVERAGE", () => {
  it("covers every day except Friday", () => {
    const days = [...new Set(DEFAULT_COVERAGE.map((w) => w.weekday))].sort();
    expect(days).toEqual([0, 1, 2, 3, 4, 6]);
    expect(days).not.toContain(5);
  });

  it("gives Monday to Thursday two shifts and the weekend one", () => {
    const count = (d: number) =>
      DEFAULT_COVERAGE.filter((w) => w.weekday === d).length;
    for (const d of [1, 2, 3, 4]) expect(count(d)).toBe(2);
    for (const d of [0, 6]) expect(count(d)).toBe(1);
  });

  it("marks only the weekday morning as office; everything else is class", () => {
    for (const w of DEFAULT_COVERAGE) {
      const isWeekdayMorning =
        w.weekday >= 1 && w.weekday <= 4 && w.startMinute === 8 * 60 + 30;
      expect(w.tier).toBe(isWeekdayMorning ? "office" : "class");
    }
  });

  it("never ends before it starts", () => {
    for (const w of DEFAULT_COVERAGE) {
      expect(w.endMinute).toBeGreaterThan(w.startMinute);
    }
  });
});
