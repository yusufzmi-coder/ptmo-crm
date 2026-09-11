import { describe, expect, it } from "vitest";
import { deriveFailedMessages, type FailedMessageRow } from "./failed-messages";

const row = (over: Partial<FailedMessageRow> = {}): FailedMessageRow => ({
  id: "m1",
  conversation_id: "c1",
  sender_type: "agent",
  content_type: "text",
  content_text: "Salam, kelas esok pukul 9",
  created_at: "2026-09-07T01:00:00Z",
  conversation: {
    id: "c1",
    contact: { id: "k1", name: "Puan Aini", phone: "60111222333" },
  },
  ...over,
});

describe("deriveFailedMessages", () => {
  it("shapes an outbound failure with who did not receive it", () => {
    const out = deriveFailedMessages([row()]);
    expect(out).toEqual([
      {
        messageId: "m1",
        conversationId: "c1",
        contactName: "Puan Aini",
        contactPhone: "60111222333",
        preview: "Salam, kelas esok pukul 9",
        senderType: "agent",
        failedAt: "2026-09-07T01:00:00Z",
      },
    ]);
  });

  it("includes bot failures — a parent still never got the message", () => {
    const out = deriveFailedMessages([row({ sender_type: "bot" })]);
    expect(out).toHaveLength(1);
    expect(out[0].senderType).toBe("bot");
  });

  it("drops customer rows defensively (inbound can't 'fail')", () => {
    expect(deriveFailedMessages([row({ sender_type: "customer" })])).toHaveLength(0);
  });

  it("orders newest failure first", () => {
    const out = deriveFailedMessages([
      row({ id: "old", created_at: "2026-09-07T01:00:00Z" }),
      row({ id: "new", created_at: "2026-09-07T03:00:00Z" }),
    ]);
    expect(out.map((f) => f.messageId)).toEqual(["new", "old"]);
  });

  it("survives a missing conversation or contact", () => {
    const out = deriveFailedMessages([row({ conversation: null })]);
    expect(out[0]).toMatchObject({ contactName: null, contactPhone: null });
  });

  it("uses a media placeholder when there is no text", () => {
    const out = deriveFailedMessages([
      row({ content_type: "image", content_text: null }),
    ]);
    expect(out[0].preview).toBe("[Image]");
  });
});
