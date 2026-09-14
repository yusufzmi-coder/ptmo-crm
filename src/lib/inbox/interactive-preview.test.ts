import { describe, it, expect } from "vitest";
import {
  interactivePreview,
  interactivePreviewLabelKey,
} from "./interactive-preview";
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive";
import type {
  InteractiveButtonsPayload,
  InteractiveListPayload,
} from "@/types";

const buttons: InteractiveButtonsPayload = {
  kind: "buttons",
  body: "Choose an option",
  buttons: [
    { id: "yes", title: "Yes" },
    { id: "no", title: "No" },
  ],
};

const list: InteractiveListPayload = {
  kind: "list",
  body: "Pick a centre",
  button_label: "View centres",
  sections: [{ title: "Centres", rows: [{ id: "a", title: "Ampang" }] }],
};

describe("interactivePreview", () => {
  it("returns the trimmed body when there is one", () => {
    expect(interactivePreview({ ...buttons, body: "  Hi  " })).toEqual({
      kind: "text",
      text: "Hi",
    });
  });

  it("reports an empty buttons payload as a placeholder, not text", () => {
    expect(interactivePreview({ ...buttons, body: "   " })).toEqual({
      kind: "empty",
      label: "buttons",
    });
  });

  it("reports an empty list payload as a placeholder, not text", () => {
    expect(interactivePreview({ ...list, body: "" })).toEqual({
      kind: "empty",
      label: "list",
    });
  });

  it("treats a missing body the same as a blank one", () => {
    const noBody = { ...buttons };
    delete (noBody as Partial<InteractiveButtonsPayload>).body;
    expect(interactivePreview(noBody).kind).toBe("empty");
  });

  it("does not mistake a body that literally reads '[buttons]' for a placeholder", () => {
    // The reason this maps the payload rather than string-matching the
    // sentinel that interactivePayloadPreviewText returns.
    expect(interactivePreview({ ...buttons, body: "[buttons]" })).toEqual({
      kind: "text",
      text: "[buttons]",
    });
  });
});

describe("stays in step with interactivePayloadPreviewText", () => {
  // These two must agree on WHEN a payload has usable text, or the UI
  // and the stored last_message_text would disagree about the same
  // payload. Pinned here so changing one without the other fails.
  const cases = [
    { ...buttons, body: "Choose an option" },
    { ...buttons, body: "   " },
    { ...list, body: "Pick a centre" },
    { ...list, body: "" },
  ];

  it("agrees on the text whenever a body is present", () => {
    for (const payload of cases) {
      const preview = interactivePreview(payload);
      if (preview.kind === "text") {
        expect(interactivePayloadPreviewText(payload)).toBe(preview.text);
      }
    }
  });

  it("flags exactly the payloads the other one falls back on", () => {
    for (const payload of cases) {
      const isSentinel = ["[buttons]", "[list]"].includes(
        interactivePayloadPreviewText(payload),
      );
      expect(interactivePreview(payload).kind === "empty").toBe(isSentinel);
    }
  });
});

describe("interactivePreviewLabelKey", () => {
  it("gives each placeholder its own key", () => {
    expect(interactivePreviewLabelKey("buttons")).toBe("emptyButtons");
    expect(interactivePreviewLabelKey("list")).toBe("emptyList");
  });
});
