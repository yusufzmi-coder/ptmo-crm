import { describe, expect, it } from "vitest";
import {
  deriveResponseSamples,
  startOfOpsDay,
  summariseResponseTime,
  type ResponseSampleInput,
} from "./response-time";

// Monday 2026-09-07; 01:00Z = 09:00 MYT (office shift).
const m = (
  conversation_id: string,
  sender_type: ResponseSampleInput["sender_type"],
  created_at: string,
): ResponseSampleInput => ({ conversation_id, sender_type, created_at });

describe("deriveResponseSamples", () => {
  it("pairs a customer message with the next reply", () => {
    const s = deriveResponseSamples([
      m("a", "customer", "2026-09-07T01:00:00Z"),
      m("a", "agent", "2026-09-07T01:03:00Z"),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      conversationId: "a",
      waitedMinutes: 3,
      tier: "office",
      state: "ok",
    });
  });

  it("measures from the FIRST inbound in a run, one sample per run", () => {
    const s = deriveResponseSamples([
      m("a", "customer", "2026-09-07T01:00:00Z"),
      m("a", "customer", "2026-09-07T01:04:00Z"),
      m("a", "customer", "2026-09-07T01:08:00Z"),
      m("a", "agent", "2026-09-07T01:10:00Z"),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].customerAt).toBe("2026-09-07T01:00:00Z");
    expect(s[0].waitedMinutes).toBe(10);
    expect(s[0].state).toBe("warning");
  });

  it("counts a bot reply as a reply", () => {
    const s = deriveResponseSamples([
      m("a", "customer", "2026-09-07T01:00:00Z"),
      m("a", "bot", "2026-09-07T01:00:30Z"),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].state).toBe("ok");
  });

  it("produces no sample for a thread still waiting", () => {
    expect(
      deriveResponseSamples([m("a", "customer", "2026-09-07T01:00:00Z")]),
    ).toHaveLength(0);
  });

  it("ignores outbound messages with nothing pending (we wrote first)", () => {
    expect(
      deriveResponseSamples([
        m("a", "agent", "2026-09-07T01:00:00Z"),
        m("a", "agent", "2026-09-07T01:05:00Z"),
      ]),
    ).toHaveLength(0);
  });

  it("yields multiple samples across back-and-forth", () => {
    const s = deriveResponseSamples([
      m("a", "customer", "2026-09-07T01:00:00Z"),
      m("a", "agent", "2026-09-07T01:02:00Z"),
      m("a", "customer", "2026-09-07T01:20:00Z"),
      m("a", "agent", "2026-09-07T01:40:00Z"),
    ]);
    expect(s.map((x) => x.waitedMinutes)).toEqual([2, 20]);
    expect(s.map((x) => x.state)).toEqual(["ok", "breached"]);
  });

  it("judges an evening reply by the class standard", () => {
    const s = deriveResponseSamples([
      m("a", "customer", "2026-09-07T12:00:00Z"), // Mon 20:00 MYT
      m("a", "agent", "2026-09-07T12:10:00Z"),
    ]);
    expect(s[0]).toMatchObject({ waitedMinutes: 10, tier: "class", state: "ok" });
  });

  it("does not run the clock through the afternoon break", () => {
    const s = deriveResponseSamples([
      m("a", "customer", "2026-09-07T07:00:00Z"), // Mon 15:00 MYT
      m("a", "agent", "2026-09-07T11:33:00Z"), // Mon 19:33 MYT
    ]);
    expect(s[0]).toMatchObject({ waitedMinutes: 3, tier: "class", state: "ok" });
  });

  it("handles unsorted input", () => {
    const s = deriveResponseSamples([
      m("a", "agent", "2026-09-07T01:03:00Z"),
      m("a", "customer", "2026-09-07T01:00:00Z"),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].waitedMinutes).toBe(3);
  });
});

describe("summariseResponseTime", () => {
  const samples = deriveResponseSamples([
    m("a", "customer", "2026-09-07T01:00:00Z"),
    m("a", "agent", "2026-09-07T01:02:00Z"), // 2  ok
    m("b", "customer", "2026-09-07T01:00:00Z"),
    m("b", "agent", "2026-09-07T01:08:00Z"), // 8  warning
    m("c", "customer", "2026-09-07T01:00:00Z"),
    m("c", "agent", "2026-09-07T01:30:00Z"), // 30 breached
    m("d", "customer", "2026-09-07T01:00:00Z"),
    m("d", "agent", "2026-09-07T01:04:00Z"), // 4  ok
  ]);

  it("counts every state and the within-target share", () => {
    const s = summariseResponseTime(samples);
    expect(s).toMatchObject({
      answered: 4,
      withinTarget: 2,
      pastTarget: 1,
      late: 1,
      withinTargetPct: 50,
      worstMinutes: 30,
    });
  });

  it("takes the median of an even set as the mean of the middle pair", () => {
    // sorted: 2, 4, 8, 30 → (4 + 8) / 2 = 6
    expect(summariseResponseTime(samples).medianMinutes).toBe(6);
  });

  it("takes the middle value of an odd set", () => {
    expect(summariseResponseTime(samples.slice(0, 3)).medianMinutes).toBe(8);
  });

  it("returns nulls, not NaN or 0%, when there is nothing to measure", () => {
    expect(summariseResponseTime([])).toEqual({
      answered: 0,
      withinTarget: 0,
      pastTarget: 0,
      late: 0,
      withinTargetPct: null,
      medianMinutes: null,
      worstMinutes: null,
    });
  });

  it("filters by when the REPLY landed, not when the customer wrote", () => {
    const cutoff = new Date("2026-09-07T01:05:00Z");
    const s = summariseResponseTime(samples, cutoff);
    // replies at 01:02 and 01:04 are before the cutoff; 01:08 and 01:30 after
    expect(s.answered).toBe(2);
    expect(s.withinTarget).toBe(0);
  });
});

describe("startOfOpsDay", () => {
  it("is local midnight in Kuala Lumpur, expressed in UTC", () => {
    // Mon 2026-09-07 10:00 MYT → Mon 00:00 MYT = Sun 16:00Z
    expect(startOfOpsDay(new Date("2026-09-07T02:00:00Z")).toISOString()).toBe(
      "2026-09-06T16:00:00.000Z",
    );
  });

  it("does not roll the day over at UTC midnight", () => {
    // Sun 2026-09-06 23:30Z is already Mon 07:30 MYT
    expect(startOfOpsDay(new Date("2026-09-06T23:30:00Z")).toISOString()).toBe(
      "2026-09-06T16:00:00.000Z",
    );
  });
});
