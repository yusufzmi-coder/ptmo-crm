import { describe, expect, it } from "vitest";

import { realtimeTopic } from "./channel";

const ZONE_A = "11111111-1111-1111-1111-111111111111";
const ZONE_B = "22222222-2222-2222-2222-222222222222";

describe("realtimeTopic", () => {
  it("scopes the topic to the account", () => {
    expect(realtimeTopic("inbox-realtime", ZONE_A)).toBe(
      `inbox-realtime:${ZONE_A}`,
    );
  });

  it("gives two zones two different topics", () => {
    // The whole point of the fix: the subscription is keyed on this
    // string, so it MUST change when the active zone changes or the
    // channel is never rebuilt.
    expect(realtimeTopic("inbox-realtime", ZONE_A)).not.toBe(
      realtimeTopic("inbox-realtime", ZONE_B),
    );
  });

  it("keeps separate bases apart within one zone", () => {
    expect(realtimeTopic("inbox-realtime", ZONE_A)).not.toBe(
      realtimeTopic("total-unread-realtime", ZONE_A),
    );
  });

  it("returns null when there is no active zone", () => {
    // Never subscribe unscoped — an unscoped topic is the bug.
    expect(realtimeTopic("inbox-realtime", null)).toBeNull();
    expect(realtimeTopic("inbox-realtime", undefined)).toBeNull();
    expect(realtimeTopic("inbox-realtime", "")).toBeNull();
    expect(realtimeTopic("inbox-realtime", "   ")).toBeNull();
  });
});
