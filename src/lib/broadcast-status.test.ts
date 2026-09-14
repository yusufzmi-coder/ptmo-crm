import { describe, expect, it } from "vitest";
import {
  broadcastStatusConfig,
  getBroadcastStatus,
  getRecipientStatus,
  recipientStatusConfig,
} from "./broadcast-status";

describe("getBroadcastStatus", () => {
  it("returns the matching config for known statuses", () => {
    expect(getBroadcastStatus("sending")).toBe(broadcastStatusConfig.sending);
    expect(getBroadcastStatus("sent")).toBe(broadcastStatusConfig.sent);
    expect(getBroadcastStatus("failed")).toBe(broadcastStatusConfig.failed);
  });

  it("flags `sending` as a live/pulsing state", () => {
    expect(getBroadcastStatus("sending").pulse).toBe(true);
    expect(getBroadcastStatus("sent").pulse).toBeFalsy();
  });

  it("falls back to draft on an unknown status string", () => {
    expect(getBroadcastStatus("not-a-real-status")).toBe(
      broadcastStatusConfig.draft,
    );
    expect(getBroadcastStatus("")).toBe(broadcastStatusConfig.draft);
  });

  it("each variant carries a fill, a text colour and a border", () => {
    // Fills are /10, or a flat neutral for the statuses that are not
    // colour-coded at all. Borders are /70 or the neutral border token.
    for (const v of Object.values(broadcastStatusConfig)) {
      expect(v.classes, "fill").toMatch(/bg-(muted|[a-z]+(-\d+)?\/10)/);
      expect(v.classes, "text").toMatch(/text-[a-z-]+(-\d+)?/);
      expect(v.classes, "border").toMatch(/border-(border|[a-z]+(-\d+)?\/70)/);
    }
  });

  it("no badge border is faint enough to fail the 3:1 non-text floor", () => {
    // The regression this guards: borders used to be /20, which QA
    // measured against the card behind them at 1.84–2.50 — every badge
    // failed. Anything below /70 is how that comes back.
    const faint = /border-[a-z]+(-\d+)?\/([1-6]?\d)\b/;
    for (const config of [broadcastStatusConfig, recipientStatusConfig]) {
      for (const [status, v] of Object.entries(config)) {
        expect(v.classes, `${status} border opacity`).not.toMatch(faint);
      }
    }
  });
});

describe("getRecipientStatus", () => {
  it("returns the matching config for known statuses", () => {
    expect(getRecipientStatus("delivered")).toBe(
      recipientStatusConfig.delivered,
    );
    expect(getRecipientStatus("read")).toBe(recipientStatusConfig.read);
  });

  it("falls back to pending on an unknown status string", () => {
    expect(getRecipientStatus("???")).toBe(recipientStatusConfig.pending);
  });
});
