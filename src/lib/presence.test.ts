import { describe, expect, it } from "vitest";

import {
  OFFLINE_AFTER_MS,
  type CoViewerRow,
  coViewers,
  derivePresence,
  formatLastSeen,
  presenceLabel,
  summarize,
} from "./presence";

// Fixed reference clock so every case is deterministic.
const NOW = new Date("2026-06-22T12:00:00.000Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("derivePresence", () => {
  it("returns the stored status for a fresh heartbeat", () => {
    expect(derivePresence("online", ago(1_000), NOW)).toBe("online");
    expect(derivePresence("away", ago(1_000), NOW)).toBe("away");
  });

  it("reads as offline when the heartbeat is stale", () => {
    expect(derivePresence("online", ago(OFFLINE_AFTER_MS + 1_000), NOW)).toBe(
      "offline",
    );
    // Stored 'away' goes stale to offline too (tab was closed while idle).
    expect(derivePresence("away", ago(OFFLINE_AFTER_MS + 1_000), NOW)).toBe(
      "offline",
    );
  });

  it("treats a missing row or timestamp as offline", () => {
    expect(derivePresence(undefined, null, NOW)).toBe("offline");
    expect(derivePresence("online", null, NOW)).toBe("offline");
    expect(derivePresence("online", "not-a-date", NOW)).toBe("offline");
  });

  it("stays online exactly at the threshold and flips just past it", () => {
    expect(derivePresence("online", ago(OFFLINE_AFTER_MS), NOW)).toBe("online");
    expect(derivePresence("online", ago(OFFLINE_AFTER_MS + 1), NOW)).toBe(
      "offline",
    );
  });
});

describe("formatLastSeen", () => {
  it("describes recent activity coarsely", () => {
    expect(formatLastSeen(ago(10_000), NOW)).toBe("just now");
    expect(formatLastSeen(ago(60_000), NOW)).toBe("1 minute ago");
    expect(formatLastSeen(ago(5 * 60_000), NOW)).toBe("5 minutes ago");
  });

  it("rolls up into hours and days", () => {
    expect(formatLastSeen(ago(60 * 60_000), NOW)).toBe("1 hour ago");
    expect(formatLastSeen(ago(2 * 60 * 60_000), NOW)).toBe("2 hours ago");
    expect(formatLastSeen(ago(24 * 60 * 60_000), NOW)).toBe("1 day ago");
    expect(formatLastSeen(ago(3 * 24 * 60 * 60_000), NOW)).toBe("3 days ago");
  });

  it("falls back gracefully on missing/invalid input", () => {
    expect(formatLastSeen(null, NOW)).toBe("a while ago");
    expect(formatLastSeen("nonsense", NOW)).toBe("a while ago");
  });
});

describe("presenceLabel", () => {
  it("labels each state for the tooltip", () => {
    expect(presenceLabel("online", ago(1_000), NOW)).toBe(
      "Online — active now",
    );
    expect(presenceLabel("away", ago(1_000), NOW)).toBe("Away — idle");
    expect(presenceLabel("offline", ago(2 * 60 * 60_000), NOW)).toBe(
      "Offline — last seen 2 hours ago",
    );
  });
});

describe("summarize", () => {
  it("counts each status", () => {
    expect(
      summarize(["online", "online", "online", "away", "offline"]),
    ).toEqual({ online: 3, away: 1, offline: 1 });
  });

  it("returns zeroes for an empty roster", () => {
    expect(summarize([])).toEqual({ online: 0, away: 0, offline: 0 });
  });
});

// ---- coViewers -------------------------------------------------
// The double-reply guard: who ELSE has this thread open right now.

const CONV = "11111111-1111-1111-1111-111111111111";
const OTHER_CONV = "22222222-2222-2222-2222-222222222222";
const ME = "me-user-id";

const viewer = (
  user_id: string,
  overrides: Partial<CoViewerRow> = {},
): CoViewerRow => ({
  user_id,
  status: "online",
  last_seen_at: ago(5_000),
  viewing_conversation_id: CONV,
  ...overrides,
});

describe("coViewers", () => {
  it("lists other members viewing the same conversation", () => {
    expect(
      coViewers([viewer("amal"), viewer("faizam")], CONV, ME, NOW),
    ).toEqual(["amal", "faizam"]);
  });

  it("never includes the caller", () => {
    expect(coViewers([viewer(ME), viewer("amal")], CONV, ME, NOW)).toEqual([
      "amal",
    ]);
  });

  it("ignores members viewing a different conversation", () => {
    expect(
      coViewers(
        [viewer("amal", { viewing_conversation_id: OTHER_CONV })],
        CONV,
        ME,
        NOW,
      ),
    ).toEqual([]);
  });

  it("ignores members viewing nothing", () => {
    expect(
      coViewers(
        [
          viewer("amal", { viewing_conversation_id: null }),
          viewer("mus", { viewing_conversation_id: undefined }),
        ],
        CONV,
        ME,
        NOW,
      ),
    ).toEqual([]);
  });

  it("drops a stale heartbeat so a crashed tab leaves no ghost", () => {
    expect(
      coViewers(
        [viewer("amal", { last_seen_at: ago(OFFLINE_AFTER_MS + 1_000) })],
        CONV,
        ME,
        NOW,
      ),
    ).toEqual([]);
  });

  it("drops an away member — a left-open tab is not about to type", () => {
    expect(coViewers([viewer("amal", { status: "away" })], CONV, ME, NOW)).toEqual(
      [],
    );
  });

  it("returns nothing when no conversation is selected", () => {
    expect(coViewers([viewer("amal")], null, ME, NOW)).toEqual([]);
    expect(coViewers([viewer("amal")], undefined, ME, NOW)).toEqual([]);
  });

  it("sorts so the rendered list does not reshuffle on each tick", () => {
    expect(
      coViewers([viewer("zara"), viewer("amal"), viewer("mus")], CONV, ME, NOW),
    ).toEqual(["amal", "mus", "zara"]);
  });

  it("still works when the caller is unknown", () => {
    expect(coViewers([viewer("amal")], CONV, null, NOW)).toEqual(["amal"]);
  });
});
