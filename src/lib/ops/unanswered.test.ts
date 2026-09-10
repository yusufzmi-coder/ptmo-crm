import { describe, expect, it } from "vitest";
import {
  deriveUnanswered,
  previewText,
  sortByUrgency,
  type BoardConversation,
  type BoardMessage,
  type UnansweredItem,
} from "./unanswered";

// Monday 2026-09-07. Malaysia is UTC+8, so 01:00Z is 09:00 local —
// inside the office shift, where the sharp (5/15) standard applies.
const NOW = new Date("2026-09-07T02:00:00Z"); // Mon 10:00 MYT

const conv = (
  id: string,
  extra: Partial<BoardConversation> = {},
): BoardConversation => ({
  id,
  status: "open",
  assigned_agent_id: null,
  contact: { id: `contact-${id}`, name: `Parent ${id}`, phone: "60123456789" },
  ...extra,
});

const msg = (
  conversation_id: string,
  sender_type: BoardMessage["sender_type"],
  created_at: string,
  content_text: string | null = "hi",
  content_type: BoardMessage["content_type"] = "text",
): BoardMessage => ({
  conversation_id,
  sender_type,
  content_type,
  content_text,
  created_at,
});

describe("deriveUnanswered — what counts as unanswered", () => {
  it("lists a conversation whose latest message is from the customer", () => {
    const items = deriveUnanswered(
      [conv("a")],
      [msg("a", "customer", "2026-09-07T01:50:00Z", "Boleh tanya yuran?")],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0].conversationId).toBe("a");
    expect(items[0].preview).toBe("Boleh tanya yuran?");
  });

  it("drops a conversation once an agent has replied after the customer", () => {
    const items = deriveUnanswered(
      [conv("a")],
      [
        msg("a", "customer", "2026-09-07T01:00:00Z"),
        msg("a", "agent", "2026-09-07T01:02:00Z"),
      ],
      NOW,
    );
    expect(items).toHaveLength(0);
  });

  it("treats a bot reply as a reply — the parent is not left hanging", () => {
    const items = deriveUnanswered(
      [conv("a")],
      [
        msg("a", "customer", "2026-09-07T01:00:00Z"),
        msg("a", "bot", "2026-09-07T01:00:30Z"),
      ],
      NOW,
    );
    expect(items).toHaveLength(0);
  });

  it("puts a thread back on the board when the customer writes again after a reply", () => {
    const items = deriveUnanswered(
      [conv("a")],
      [
        msg("a", "customer", "2026-09-07T01:00:00Z"),
        msg("a", "agent", "2026-09-07T01:02:00Z"),
        msg("a", "customer", "2026-09-07T01:40:00Z", "Terima kasih, satu lagi soalan"),
      ],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0].waitingSince).toBe("2026-09-07T01:40:00Z");
    expect(items[0].preview).toBe("Terima kasih, satu lagi soalan");
  });

  it("measures the wait from the FIRST unanswered inbound, previews the latest", () => {
    const items = deriveUnanswered(
      [conv("a")],
      [
        msg("a", "agent", "2026-09-07T00:40:00Z"),
        msg("a", "customer", "2026-09-07T01:00:00Z", "Hello?"),
        msg("a", "customer", "2026-09-07T01:30:00Z", "Anyone there?"),
        msg("a", "customer", "2026-09-07T01:55:00Z", "??"),
      ],
      NOW,
    );
    expect(items[0].waitingSince).toBe("2026-09-07T01:00:00Z");
    expect(items[0].waitedMinutes).toBe(60); // 09:00 -> 10:00 MYT, all office
    expect(items[0].preview).toBe("??");
    expect(items[0].state).toBe("breached");
  });

  it("does not care what order the messages arrive in", () => {
    const shuffled = [
      msg("a", "customer", "2026-09-07T01:55:00Z", "last"),
      msg("a", "agent", "2026-09-07T00:40:00Z"),
      msg("a", "customer", "2026-09-07T01:00:00Z", "first"),
    ];
    const items = deriveUnanswered([conv("a")], shuffled, NOW);
    expect(items[0].waitingSince).toBe("2026-09-07T01:00:00Z");
    expect(items[0].preview).toBe("last");
  });

  it("excludes closed conversations even if their last message is inbound", () => {
    const items = deriveUnanswered(
      [conv("a", { status: "closed" })],
      [msg("a", "customer", "2026-09-07T01:50:00Z")],
      NOW,
    );
    expect(items).toHaveLength(0);
  });

  it("keeps pending conversations — pending is an inbox label, not 'waiting on customer'", () => {
    const items = deriveUnanswered(
      [conv("a", { status: "pending" })],
      [msg("a", "customer", "2026-09-07T01:50:00Z")],
      NOW,
    );
    expect(items).toHaveLength(1);
  });

  it("ignores conversations with no messages in the window", () => {
    expect(deriveUnanswered([conv("a")], [], NOW)).toHaveLength(0);
  });

  it("carries contact, phone and assignee through for the row", () => {
    const items = deriveUnanswered(
      [
        conv("a", {
          assigned_agent_id: "agent-1",
          contact: { id: "c", name: "  Puan Aini ", phone: "60111222333" },
        }),
      ],
      [msg("a", "customer", "2026-09-07T01:58:00Z")],
      NOW,
    );
    expect(items[0]).toMatchObject({
      contactName: "Puan Aini",
      contactPhone: "60111222333",
      assignedAgentId: "agent-1",
    });
  });

  it("falls back to null name when the contact has none, so the UI can show the phone", () => {
    const items = deriveUnanswered(
      [conv("a", { contact: { id: "c", name: "", phone: "60111222333" } })],
      [msg("a", "customer", "2026-09-07T01:58:00Z")],
      NOW,
    );
    expect(items[0].contactName).toBeNull();
    expect(items[0].contactPhone).toBe("60111222333");
  });
});

describe("deriveUnanswered — SLA state rendered on the board", () => {
  it("is ok inside the office target", () => {
    const items = deriveUnanswered(
      [conv("a")],
      [msg("a", "customer", "2026-09-07T01:57:00Z")], // 3 min ago
      NOW,
    );
    expect(items[0]).toMatchObject({ waitedMinutes: 3, tier: "office", state: "ok" });
  });

  it("is warning between office target and breach", () => {
    const items = deriveUnanswered(
      [conv("a")],
      [msg("a", "customer", "2026-09-07T01:52:00Z")], // 8 min ago
      NOW,
    );
    expect(items[0]).toMatchObject({ waitedMinutes: 8, tier: "office", state: "warning" });
  });

  it("is breached past the office line", () => {
    const items = deriveUnanswered(
      [conv("a")],
      [msg("a", "customer", "2026-09-07T01:40:00Z")], // 20 min ago
      NOW,
    );
    expect(items[0]).toMatchObject({ waitedMinutes: 20, tier: "office", state: "breached" });
  });

  it("judges an evening message by the class standard", () => {
    const eveningNow = new Date("2026-09-07T12:20:00Z"); // Mon 20:20 MYT
    const items = deriveUnanswered(
      [conv("a")],
      [msg("a", "customer", "2026-09-07T12:10:00Z")], // 20:10, 10 min ago
      eveningNow,
    );
    // 10 minutes would be warning in the office; in class it is still ok.
    expect(items[0]).toMatchObject({ waitedMinutes: 10, tier: "class", state: "ok" });
  });

  it("shows zero wait, no tier, ok for a message that landed off duty", () => {
    const breakNow = new Date("2026-09-07T08:00:00Z"); // Mon 16:00 MYT
    const items = deriveUnanswered(
      [conv("a")],
      [msg("a", "customer", "2026-09-07T07:00:00Z")], // 15:00, in the break
      breakNow,
    );
    expect(items[0]).toMatchObject({ waitedMinutes: 0, tier: null, state: "ok" });
  });
});

describe("sortByUrgency", () => {
  const item = (
    id: string,
    state: UnansweredItem["state"],
    waitedMinutes: number,
    waitingSince = "2026-09-07T01:00:00Z",
  ): UnansweredItem => ({
    conversationId: id,
    contactName: id,
    contactPhone: null,
    assignedAgentId: null,
    preview: "",
    waitingSince,
    waitedMinutes,
    tier: "office",
    state,
  });

  it("orders red, then amber, then green", () => {
    const out = sortByUrgency([
      item("green", "ok", 2),
      item("red", "breached", 20),
      item("amber", "warning", 7),
    ]);
    expect(out.map((i) => i.conversationId)).toEqual(["red", "amber", "green"]);
  });

  it("puts the longest wait first inside a group", () => {
    const out = sortByUrgency([
      item("r20", "breached", 20),
      item("r90", "breached", 90),
      item("r45", "breached", 45),
    ]);
    expect(out.map((i) => i.conversationId)).toEqual(["r90", "r45", "r20"]);
  });

  it("breaks a tie on covered minutes by who wrote first", () => {
    // Both arrived during the break, so both have 0 covered minutes;
    // the earlier message still goes first.
    const out = sortByUrgency([
      item("later", "ok", 0, "2026-09-07T07:30:00Z"),
      item("earlier", "ok", 0, "2026-09-07T07:05:00Z"),
    ]);
    expect(out.map((i) => i.conversationId)).toEqual(["earlier", "later"]);
  });

  it("does not mutate the input", () => {
    const input = [item("b", "ok", 1), item("a", "breached", 30)];
    const copy = [...input];
    sortByUrgency(input);
    expect(input).toEqual(copy);
  });

  it("is what deriveUnanswered returns", () => {
    const items = deriveUnanswered(
      [conv("green"), conv("red"), conv("amber")],
      [
        msg("green", "customer", "2026-09-07T01:58:00Z"),
        msg("red", "customer", "2026-09-07T01:30:00Z"),
        msg("amber", "customer", "2026-09-07T01:52:00Z"),
      ],
      NOW,
    );
    expect(items.map((i) => i.conversationId)).toEqual(["red", "amber", "green"]);
  });
});

describe("previewText", () => {
  it("uses the text when there is any", () => {
    expect(previewText(msg("a", "customer", "x", "  Salam  "))).toBe("Salam");
  });

  it("stands in for media so the row is never blank", () => {
    expect(previewText(msg("a", "customer", "x", null, "image"))).toBe("[Image]");
    expect(previewText(msg("a", "customer", "x", "", "audio"))).toBe("[Voice note]");
  });
});
