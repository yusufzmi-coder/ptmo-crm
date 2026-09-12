import { describe, it, expect } from "vitest";
import {
  isOptimistic,
  optimisticId,
  reconcileIncomingMessage,
} from "./optimistic";
import type { Message } from "@/types";

function msg(over: Partial<Message> & Pick<Message, "id">): Message {
  return {
    conversation_id: "conv-1",
    sender_type: "agent",
    content_type: "text",
    status: "sent",
    created_at: "2026-09-12T00:00:00.000Z",
    ...over,
  };
}

describe("optimisticId", () => {
  it("is unique within the same millisecond", () => {
    const ids = new Set(Array.from({ length: 200 }, () => optimisticId(1000)));
    expect(ids.size).toBe(200);
  });

  it("is recognised as optimistic", () => {
    expect(isOptimistic(optimisticId())).toBe(true);
    expect(isOptimistic("8f1c-uuid")).toBe(false);
  });
});

describe("reconcileIncomingMessage", () => {
  it("ignores a row it already holds", () => {
    const prev = [msg({ id: "real-1" })];
    expect(reconcileIncomingMessage(prev, msg({ id: "real-1" }))).toBe(prev);
  });

  it("replaces the agent's own optimistic bubble", () => {
    const prev = [
      msg({ id: "temp-1", content_text: "Salam cikgu", status: "sending" }),
    ];
    const out = reconcileIncomingMessage(
      prev,
      msg({ id: "real-1", content_text: "Salam cikgu" }),
    );
    expect(out.map((m) => m.id)).toEqual(["real-1"]);
  });

  it("keeps an in-flight bubble when the PARENT replies", () => {
    // The regression this module exists for: an unfiltered realtime
    // channel delivers the customer's message while our own send is
    // still in the air.
    const prev = [
      msg({ id: "temp-1", content_text: "Kelas petang ada", status: "sending" }),
    ];
    const out = reconcileIncomingMessage(
      prev,
      msg({ id: "real-in", sender_type: "customer", content_text: "Terima kasih" }),
    );
    expect(out.map((m) => m.id)).toEqual(["temp-1", "real-in"]);
  });

  it("keeps an in-flight bubble when a SECOND AGENT replies", () => {
    const prev = [
      msg({ id: "temp-1", content_text: "Yuran RM150", status: "sending" }),
    ];
    const out = reconcileIncomingMessage(
      prev,
      msg({ id: "real-b", content_text: "Yuran RM180 ya" }),
    );
    expect(out.map((m) => m.id)).toEqual(["temp-1", "real-b"]);
  });

  it("never retires a failed bubble", () => {
    // A failed send is the only surviving copy of what the agent typed —
    // the composer was cleared on submit.
    const prev = [msg({ id: "temp-1", content_text: "Ujian", status: "failed" })];
    const out = reconcileIncomingMessage(
      prev,
      msg({ id: "real-1", content_text: "Ujian" }),
    );
    expect(out.map((m) => m.id)).toEqual(["temp-1", "real-1"]);
  });

  it("retires one bubble per row, oldest first", () => {
    const prev = [
      msg({ id: "temp-1", content_text: "ok", status: "sending" }),
      msg({ id: "temp-2", content_text: "ok", status: "sending" }),
    ];
    const first = reconcileIncomingMessage(
      prev,
      msg({ id: "real-1", content_text: "ok" }),
    );
    expect(first.map((m) => m.id)).toEqual(["temp-2", "real-1"]);

    const second = reconcileIncomingMessage(
      first,
      msg({ id: "real-2", content_text: "ok" }),
    );
    expect(second.map((m) => m.id)).toEqual(["real-1", "real-2"]);
  });

  it("does not match across content types", () => {
    const prev = [
      msg({
        id: "temp-1",
        content_type: "image",
        content_text: "Jadual",
        status: "sending",
      }),
    ];
    const out = reconcileIncomingMessage(
      prev,
      msg({ id: "real-1", content_type: "text", content_text: "Jadual" }),
    );
    expect(out.map((m) => m.id)).toEqual(["temp-1", "real-1"]);
  });

  it("treats a missing caption and an empty one as the same text", () => {
    const prev = [
      msg({ id: "temp-1", content_type: "audio", status: "sending" }),
    ];
    const out = reconcileIncomingMessage(
      prev,
      msg({ id: "real-1", content_type: "audio", content_text: "" }),
    );
    expect(out.map((m) => m.id)).toEqual(["real-1"]);
  });
});
