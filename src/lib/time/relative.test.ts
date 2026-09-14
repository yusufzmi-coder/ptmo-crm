import { describe, expect, it } from "vitest";

import { relativeTime } from "./relative";

// Echo the key and its values back, so a test asserts which bucket was
// chosen and what count was passed — the two things the helper decides.
// The wording itself lives in the catalogue and is not this file's job.
const t = (key: string, values?: Record<string, string | number>) =>
  values && "count" in values ? `${key}:${values.count}` : key;

const NOW = new Date("2026-09-14T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe("relativeTime buckets", () => {
  it("says just now under a minute in the full style", () => {
    expect(relativeTime(ago(0), t, { now: NOW })).toBe("full.justNow");
    expect(relativeTime(ago(59), t, { now: NOW })).toBe("full.justNow");
  });

  it("counts seconds under a minute in the terse style", () => {
    // The two styles differ here on purpose: a dense list shows "12s ago"
    // where a card says "just now".
    expect(relativeTime(ago(12), t, { now: NOW, style: "terse" })).toBe(
      "terse.seconds:12",
    );
  });

  it("never renders a zero count", () => {
    // A timestamp from this same second must not read "0s ago".
    expect(relativeTime(ago(0), t, { now: NOW, style: "terse" })).toBe(
      "terse.seconds:1",
    );
  });

  it("rounds down within a bucket rather than to the nearest", () => {
    // 119 minutes is one hour, not two: "2 hours ago" for something
    // 1h59m old overstates the wait on the ops board.
    expect(relativeTime(ago(119 * 60), t, { now: NOW })).toBe("full.hours:1");
    expect(relativeTime(ago(47 * 3600), t, { now: NOW })).toBe("full.days:1");
  });

  it("switches bucket exactly on the boundary", () => {
    expect(relativeTime(ago(60), t, { now: NOW })).toBe("full.minutes:1");
    expect(relativeTime(ago(3600), t, { now: NOW })).toBe("full.hours:1");
    expect(relativeTime(ago(86400), t, { now: NOW })).toBe("full.days:1");
  });

  it("uses the same buckets in both styles above a minute", () => {
    for (const seconds of [90, 7200, 3 * 86400]) {
      const full = relativeTime(ago(seconds), t, { now: NOW });
      const terse = relativeTime(ago(seconds), t, { now: NOW, style: "terse" });
      expect(full.split(".")[1]).toBe(terse.split(".")[1]);
      expect(full.split(":")[1]).toBe(terse.split(":")[1]);
    }
  });
});

describe("relativeTime edges", () => {
  it("falls back to an absolute date past thirty days", () => {
    // The ops board used to say "sent 400 days ago". It cannot now.
    const out = relativeTime(ago(400 * 86400), t, { now: NOW, locale: "en-GB" });
    expect(out).not.toContain("days");
    expect(out).toBe(new Date(ago(400 * 86400)).toLocaleDateString("en-GB"));
  });

  it("keeps day wording right up to the cutoff", () => {
    expect(relativeTime(ago(29 * 86400), t, { now: NOW })).toBe("full.days:29");
  });

  it("clamps a future timestamp instead of counting forward", () => {
    // Clock skew between the browser and Postgres must not produce
    // "in 3 seconds" on a board that only ever shows the past.
    const future = new Date(NOW.getTime() + 3000);
    expect(relativeTime(future, t, { now: NOW })).toBe("full.justNow");
  });

  it("returns an empty string for an unparseable date", () => {
    expect(relativeTime("not a date", t, { now: NOW })).toBe("");
  });

  it("accepts an ISO string, a Date and a timestamp alike", () => {
    const iso = ago(7200).toISOString();
    expect(relativeTime(iso, t, { now: NOW })).toBe("full.hours:2");
    expect(relativeTime(ago(7200), t, { now: NOW })).toBe("full.hours:2");
    expect(relativeTime(ago(7200).getTime(), t, { now: NOW })).toBe(
      "full.hours:2",
    );
  });
});
